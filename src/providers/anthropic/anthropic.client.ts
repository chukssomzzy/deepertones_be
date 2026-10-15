import { firstValueFrom } from 'rxjs'
import { type HttpResponse, HttpTransportError, requestJson$ } from '../../lib/http'
import { AiBudgetExceededError, type AiJob, type AiSpendLedger, type AiUsage } from './ai-spend.provider'
import {
  AnthropicConfigError,
  AnthropicRefusalError,
  AnthropicRequestError,
  AnthropicUnavailableError,
  type CallOptions,
  type ContentBlock,
  costMicros,
  estimateInputTokens,
  estimateMicros,
  type Message,
  type MessageRequest,
  priceOf,
  textOf,
} from './anthropic.provider'

const DEFAULT_API_URL = 'https://api.anthropic.com/v1/messages'
const DEFAULT_TIMEOUT_MS = 60000
const API_VERSION = '2023-06-01'
/** How many times a paused turn (server-side tools hit their iteration limit) is re-sent before giving up. */
const MAX_CONTINUATIONS = 3
/** Bad key, billing or permissions: our setup, not the input. */
const CONFIG_STATUSES = new Set([401, 402, 403])

export type AnthropicClientConfig = {
  apiKey: string
  /** The model each job runs on. A model with no price (see anthropic.provider.ts) is refused when its job runs. */
  models: Record<AiJob, string>
  /** Every request is reserved here before it is sent and settled or released after, so spend is counted and capped. */
  ledger: AiSpendLedger
  /** Give up on each request after this long; default 60000, as a web search turn is slow. */
  timeoutMs?: number
  apiUrl?: string
}

/** Calls the Claude Messages API. Takes raw requests; the product adapters own the prompts. */
export class AnthropicClient {
  constructor(private readonly config: AnthropicClientConfig) {}

  /**
   * One logical turn. A `pause_turn` reply (server tools such as web search ran long) is continued
   * by re-sending the paused content, and every block from every round is returned in order.
   */
  async createMessage(body: MessageRequest, { job }: CallOptions): Promise<Message> {
    const content: ContentBlock[] = []
    for (let continuation = 0; ; continuation++) {
      // Each round is its own request and its own reservation: the re-sent content makes the next one larger.
      const message = await this.send(
        content.length === 0 ? body : { ...body, messages: [...body.messages, { role: 'assistant', content }] },
        job,
      )
      content.push(...message.content)
      if (message.stop_reason !== 'pause_turn') return { ...message, content }
      if (continuation === MAX_CONTINUATIONS) {
        throw new AnthropicUnavailableError(`Claude was still paused after ${MAX_CONTINUATIONS} continuations`)
      }
    }
  }

  /** A reply constrained to `schema` (structured outputs), parsed. The caller owns the type; the API enforces the schema. */
  async structured<T>(body: MessageRequest, schema: Record<string, unknown>, { job }: CallOptions): Promise<T> {
    const message = await this.send({ ...body, output_config: { format: { type: 'json_schema', schema } } }, job)
    if (message.stop_reason === 'refusal') throw new AnthropicRefusalError('Claude refused to answer')
    // A cut-off answer is not valid JSON, and asking again with the same limit would be cut off again.
    if (message.stop_reason === 'max_tokens') throw new AnthropicRequestError('Claude ran out of max_tokens before finishing the answer')
    try {
      return JSON.parse(textOf(message)) as T
    } catch {
      throw new AnthropicRequestError('Claude returned text that is not valid JSON')
    }
  }

  /**
   * One request: reserve its worst case, send it, then settle with what the API reports. Only a clear "not processed"
   * (a 4xx or 529) is released; an outcome we cannot know (a transport failure, a 500 or 504, a 200 that is not a
   * message) is settled at the reserved worst case. A reply that was billed is settled before it is judged, so a
   * refusal or a cut-off answer still counts.
   */
  private async send(body: MessageRequest & { output_config?: unknown }, job: AiJob): Promise<Message> {
    const { apiKey, models, ledger, timeoutMs = DEFAULT_TIMEOUT_MS, apiUrl = DEFAULT_API_URL } = this.config
    // Empty until someone copies it into the environment; fail here (a bug to fix) rather than send a bad request.
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')
    const model = models[job]
    // A call we cannot price is a call we cannot cap, so it is not made.
    if (!priceOf(model)) throw new AnthropicConfigError(`No price is known for the model "${model}" configured for the ${job} job`)

    const payload = { ...body, model }
    const estimate = estimateMicros(model, {
      inputTokens: estimateInputTokens(payload),
      maxOutputTokens: payload.max_tokens,
      maxSearches: searchesIn(payload.tools),
    })
    // AiBudgetExceededError reaches the caller as it is. Any other failure means spend we cannot count, so the call
    // fails closed: nothing is sent, and the error says nothing about the ledger (it can name the database).
    let reservationId: string
    try {
      reservationId = await ledger.reserve({ job, model, estimateMicros: estimate })
    } catch (error) {
      if (error instanceof AiBudgetExceededError) throw error
      console.error({ outcome: 'ai-ledger-failed' })
      throw new AnthropicUnavailableError('Claude was not called because the spend ledger is unavailable')
    }

    let response: HttpResponse
    try {
      response = await firstValueFrom(
        requestJson$(apiUrl, {
          method: 'POST',
          timeoutMs,
          headers: { 'x-api-key': apiKey, 'anthropic-version': API_VERSION, 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }),
      )
    } catch (error) {
      // The request may have reached the API and been processed before the connection failed, so it is billed at the worst case.
      await this.settle(reservationId, { usage: NO_USAGE, costMicros: estimate })
      // Only the kind (HttpTimeoutError or HttpNetworkError), never the cause text.
      if (error instanceof HttpTransportError) throw new AnthropicUnavailableError(`Claude request failed before a response (${error.name})`)
      throw error
    }
    if (response.ok) {
      // Without a usage block the call cannot be measured, so it is counted at the most it could have cost.
      const usage = usageOf(response.body)
      await this.settle(reservationId, usage ? { usage, costMicros: costMicros(model, usage) } : { usage: NO_USAGE, costMicros: estimate })
      return asMessage(response.body)
    }

    // Only a response that says the request was not processed gives the money back: any 4xx (429 included) and 529
    // (overloaded). Any other error status (500, 504...) may have done the work, so it is billed at the worst case.
    if ((response.status >= 400 && response.status < 500) || response.status === 529) await this.release(reservationId)
    else await this.settle(reservationId, { usage: NO_USAGE, costMicros: estimate })
    const { type, requestId } = apiError(response.body)
    const described = `HTTP ${response.status}, type ${type ?? 'none'}, request_id ${requestId ?? 'none'}`
    if (response.status === 429 || response.status >= 500) throw new AnthropicUnavailableError(`Claude unavailable (${described})`)
    if (CONFIG_STATUSES.has(response.status)) throw new AnthropicConfigError(`Claude rejected our credentials or account (${described})`)
    throw new AnthropicRequestError(`Claude rejected the request (${described})`)
  }

  // Accounting must never decide the call's outcome, and the log carries no detail: a ledger error can name the database.
  private async settle(reservationId: string, entry: { usage: AiUsage; costMicros: number }): Promise<void> {
    try {
      await this.config.ledger.settle(reservationId, entry)
    } catch {
      console.error({ outcome: 'ai-ledger-failed' })
    }
  }

  private async release(reservationId: string): Promise<void> {
    try {
      await this.config.ledger.release(reservationId)
    } catch {
      console.error({ outcome: 'ai-ledger-failed' })
    }
  }
}

const NO_USAGE: AiUsage = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, webSearches: 0 }

/** Every search the request permits: the max_uses of its web_search tools. Other tools are not billed per use. */
const searchesIn = (tools: MessageRequest['tools']): number =>
  (tools ?? []).reduce((sum, tool) => {
    if (tool.name !== 'web_search') return sum
    // Without a limit the worst case is unbounded, so there would be nothing to reserve.
    if (typeof tool.max_uses !== 'number') throw new Error('A web_search tool must set max_uses')
    return sum + tool.max_uses
  }, 0)

const count = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0)

/** The API's usage block in our names, with a field the API left out read as zero. Undefined when there is no usage block. */
const usageOf = (body: unknown): AiUsage | undefined => {
  const usage = (body as { usage?: unknown } | null)?.usage
  if (typeof usage !== 'object' || usage === null) return undefined
  const u = usage as Record<string, unknown>
  return {
    inputTokens: count(u.input_tokens),
    outputTokens: count(u.output_tokens),
    cacheWriteTokens: count(u.cache_creation_input_tokens),
    cacheReadTokens: count(u.cache_read_input_tokens),
    webSearches: count((u.server_tool_use as { web_search_requests?: unknown } | null | undefined)?.web_search_requests),
  }
}

const asMessage = (body: unknown): Message => {
  const { content, stop_reason } = (body ?? {}) as { content?: unknown; stop_reason?: unknown }
  // Not a message at all (an HTML page from a proxy, say): the API did not really answer, so it is transient.
  if (!Array.isArray(content)) throw new AnthropicUnavailableError('Claude returned a reply that is not a message')
  return { ...(body as object), role: 'assistant', content: content as ContentBlock[], stop_reason: typeof stop_reason === 'string' ? stop_reason : null }
}

// The API's error.message is free text that can echo our prompt, so it is never read. The type and
// request id go into our error messages, so accept only identifier-shaped strings.
const TYPE_SHAPE = /^[a-z_]{1,64}$/
const REQUEST_ID_SHAPE = /^req_[A-Za-z0-9]{1,64}$/
const shaped = (value: unknown, shape: RegExp): string | undefined =>
  typeof value === 'string' && shape.test(value) ? value : undefined

const apiError = (body: unknown): { type: string | undefined; requestId: string | undefined } => {
  const { error, request_id } = (body ?? {}) as { error?: { type?: unknown } | null; request_id?: unknown }
  return { type: shaped(error?.type, TYPE_SHAPE), requestId: shaped(request_id, REQUEST_ID_SHAPE) }
}
