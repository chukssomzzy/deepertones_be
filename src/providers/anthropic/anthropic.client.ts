import Anthropic, { APIConnectionError, APIError, APIUserAbortError } from '@anthropic-ai/sdk'
import { z } from 'zod'
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

export type AnthropicClientConfig = {
  apiKey: string
  /** The model each job runs on. A model with no price (see anthropic.provider.ts) is refused when its job runs. */
  models: Record<AiJob, string>
  /** Every request is reserved here before it is sent and settled or released after, so spend is counted and capped. */
  ledger: AiSpendLedger
  /** Give up on each request after this long; default 60000, as a web search turn is slow. */
  timeoutMs?: number
  baseURL?: string
  /** A test seam: the fetch the SDK sends through. */
  fetch?: typeof fetch
}

/** Calls the Claude Messages API through the official SDK. Takes raw requests; the product adapters own the prompts. */
export class AnthropicClient {
  /** How many times a paused turn (server-side tools hit their iteration limit) is re-sent before giving up. */
  static readonly #MAX_CONTINUATIONS = 3
  /** Bad key, billing or permissions: our setup, not the input. */
  static readonly #CONFIG_STATUSES = new Set([401, 402, 403])
  // The API's error.message is free text that can echo our prompt, so it is never read. The type and
  // request id go into our error messages, so accept only identifier-shaped strings.
  static readonly #TYPE_SHAPE = /^[a-z_]{1,64}$/
  static readonly #REQUEST_ID_SHAPE = /^req_[A-Za-z0-9]{1,64}$/
  static readonly #NO_USAGE: AiUsage = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, webSearches: 0 }

  readonly #sdk: Anthropic
  readonly #timeoutMs: number
  readonly #apiKey: string
  readonly #models: Record<AiJob, string>
  readonly #ledger: AiSpendLedger

  constructor({ apiKey, models, ledger, timeoutMs = 60000, baseURL, fetch }: AnthropicClientConfig) {
    this.#apiKey = apiKey
    this.#models = models
    this.#ledger = ledger
    this.#timeoutMs = timeoutMs
    // maxRetries 0 is load-bearing: the job dispatcher is the only retrier, and every request is billed once.
    // The SDK would otherwise read ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN and ANTHROPIC_LOG (debug logs
    // response bodies), so each is pinned here. It offers no switch for ANTHROPIC_CUSTOM_HEADERS, which a
    // Worker never sets.
    this.#sdk = new Anthropic({
      apiKey,
      authToken: null,
      baseURL: baseURL ?? 'https://api.anthropic.com',
      logLevel: 'off',
      timeout: timeoutMs,
      maxRetries: 0,
      fetch,
    })
  }

  /**
   * One logical turn. A `pause_turn` reply (server tools such as web search ran long) is continued
   * by re-sending the paused content, and every block from every round is returned in order.
   */
  async createMessage(body: MessageRequest, { job }: CallOptions): Promise<Message> {
    const content: ContentBlock[] = []
    for (let continuation = 0; ; continuation++) {
      // Each round is its own request and its own reservation: the re-sent content makes the next one larger.
      const message = await this.#send(
        content.length === 0 ? body : { ...body, messages: [...body.messages, { role: 'assistant', content }] },
        job,
      )
      content.push(...message.content)
      if (message.stop_reason !== 'pause_turn') return { ...message, content }
      if (continuation === AnthropicClient.#MAX_CONTINUATIONS) {
        throw new AnthropicUnavailableError(`Claude was still paused after ${AnthropicClient.#MAX_CONTINUATIONS} continuations`)
      }
    }
  }

  /** A reply constrained to `schema` (structured outputs), parsed and checked against it. */
  async structured<S extends z.ZodType>(body: MessageRequest, schema: S, { job }: CallOptions): Promise<z.infer<S>> {
    // Not messages.parse with zodOutputFormat: parse reads only the first text block (an answer can span
    // several), and the SDK's schema transform (0.135.0) moves `enum` into a description, so the API
    // would never see the allowed values. The schema is zod's own JSON Schema, which closes every object.
    const { $schema: _draft, ...jsonSchema } = z.toJSONSchema(schema)
    const message = await this.#send({ ...body, output_config: { format: { type: 'json_schema', schema: jsonSchema } } }, job)
    if (message.stop_reason === 'refusal') throw new AnthropicRefusalError('Claude refused to answer')
    // A cut-off answer is not valid JSON, and asking again with the same limit would be cut off again.
    if (message.stop_reason === 'max_tokens') throw new AnthropicRequestError('Claude ran out of max_tokens before finishing the answer')
    let json: unknown
    try {
      json = JSON.parse(textOf(message))
    } catch {
      throw new AnthropicRequestError('Claude returned text that is not valid JSON')
    }
    const parsed = schema.safeParse(json)
    if (!parsed.success) throw new AnthropicRequestError('Claude returned JSON that does not match the schema')
    return parsed.data
  }

  /**
   * One request: reserve its worst case, send it, then settle with what the API reports. Only a clear "not processed"
   * (a 4xx or 529) is released; an outcome we cannot know (a transport failure, a 500 or 504, an unreadable body, a 200
   * that is not a message) is settled at the reserved worst case. A reply that was billed is settled before it is
   * judged, so a refusal or a cut-off answer still counts. maxRetries 0 keeps this to one reserve, one send, one settle.
   */
  async #send(body: MessageRequest & { output_config?: unknown }, job: AiJob): Promise<Message> {
    // Empty until someone copies it into the environment; fail here (a bug to fix) rather than send a bad request.
    if (!this.#apiKey) throw new Error('ANTHROPIC_API_KEY is not set')
    const model = this.#models[job]
    // A call we cannot price is a call we cannot cap, so it is not made.
    if (!priceOf(model)) throw new AnthropicConfigError(`No price is known for the model "${model}" configured for the ${job} job`)

    const payload = { ...body, model }
    const estimate = estimateMicros(model, {
      inputTokens: estimateInputTokens(payload),
      maxOutputTokens: payload.max_tokens,
      maxSearches: AnthropicClient.#searchesIn(payload.tools),
    })
    // AiBudgetExceededError reaches the caller as it is. Any other failure means spend we cannot count, so the call
    // fails closed: nothing is sent, and the error says nothing about the ledger (it can name the database).
    let reservationId: string
    try {
      reservationId = await this.#ledger.reserve({ job, model, estimateMicros: estimate })
    } catch (error) {
      if (error instanceof AiBudgetExceededError) throw error
      console.error({ outcome: 'ai-ledger-failed' })
      throw new AnthropicUnavailableError('Claude was not called because the spend ledger is unavailable')
    }

    let reply: unknown
    try {
      // MessageRequest keeps tools and content blocks loose (Record<string, unknown>), which the SDK's
      // strict union param types reject; the API validates them, so cast once here.
      reply = await this.#sdk.messages.create(
        payload as Anthropic.Messages.MessageCreateParamsNonStreaming,
        // The SDK's own timeout stops covering the request once headers arrive; this bounds the body read too.
        { signal: AbortSignal.timeout(this.#timeoutMs) },
      )
    } catch (error) {
      // A numeric 4xx (429 included) or 529 says the request was not processed. Any other status (500, 504...), and
      // every failure without one (connection, timeout, abort, an unreadable body), may have done the work: the
      // worst case is billed.
      const status = error instanceof APIError ? error.status : undefined
      if (typeof status === 'number' && ((status >= 400 && status < 500) || status === 529)) await this.#release(reservationId)
      else await this.#settle(reservationId, { usage: AnthropicClient.#NO_USAGE, costMicros: estimate })
      throw AnthropicClient.#toError(error)
    }

    // Usage is read first: a 200 that carries a usage block was billed even if it turns out not to be a message.
    const usage = AnthropicClient.#usageOf(reply)
    let message: Message
    try {
      message = AnthropicClient.#toMessage(reply)
    } catch (error) {
      await this.#settle(reservationId, usage ? { usage, costMicros: costMicros(model, usage) } : { usage: AnthropicClient.#NO_USAGE, costMicros: estimate })
      throw error
    }
    // Without a usage block the call cannot be measured, so it is counted at the most it could have cost.
    await this.#settle(reservationId, usage ? { usage, costMicros: costMicros(model, usage) } : { usage: AnthropicClient.#NO_USAGE, costMicros: estimate })
    return message
  }

  // Accounting must never decide the call's outcome, and the log carries no detail: a ledger error can name the database.
  async #settle(reservationId: string, entry: { usage: AiUsage; costMicros: number }): Promise<void> {
    try {
      await this.#ledger.settle(reservationId, entry)
    } catch {
      console.error({ outcome: 'ai-ledger-failed' })
    }
  }

  async #release(reservationId: string): Promise<void> {
    try {
      await this.#ledger.release(reservationId)
    } catch {
      console.error({ outcome: 'ai-ledger-failed' })
    }
  }

  /** Every search the request permits: the max_uses of its web_search tools. Other tools are not billed per use. */
  static #searchesIn(tools: MessageRequest['tools']): number {
    return (tools ?? []).reduce((sum, tool) => {
      if (tool.name !== 'web_search') return sum
      // Without a limit the worst case is unbounded, so there would be nothing to reserve.
      if (typeof tool.max_uses !== 'number') throw new Error('A web_search tool must set max_uses')
      return sum + tool.max_uses
    }, 0)
  }

  static #count(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
  }

  /** The API's usage block in our names, with a field the API left out read as zero. Undefined when there is no usage block. */
  static #usageOf(body: unknown): AiUsage | undefined {
    const usage = (body as { usage?: unknown } | null)?.usage
    if (typeof usage !== 'object' || usage === null) return undefined
    const u = usage as Record<string, unknown>
    return {
      inputTokens: AnthropicClient.#count(u.input_tokens),
      outputTokens: AnthropicClient.#count(u.output_tokens),
      cacheWriteTokens: AnthropicClient.#count(u.cache_creation_input_tokens),
      cacheReadTokens: AnthropicClient.#count(u.cache_read_input_tokens),
      webSearches: AnthropicClient.#count((u.server_tool_use as { web_search_requests?: unknown } | null | undefined)?.web_search_requests),
    }
  }

  static #toMessage(body: unknown): Message {
    const { content, stop_reason } = (body ?? {}) as { content?: unknown; stop_reason?: unknown }
    // Not a message at all (an HTML page from a proxy, say): the API did not really answer, so it is transient.
    if (!Array.isArray(content)) throw new AnthropicUnavailableError('Claude returned a reply that is not a message')
    return { ...(body as object), role: 'assistant', content: content as ContentBlock[], stop_reason: typeof stop_reason === 'string' ? stop_reason : null }
  }

  /** Maps an SDK error to ours, naming only the kind, status, error type and request id. Anything unreadable is Unavailable by constructor name only. */
  static #toError(error: unknown): unknown {
    if (error instanceof AnthropicUnavailableError) return error
    // Includes APIConnectionTimeoutError; only the kind, never the cause text.
    if (error instanceof APIConnectionError) return new AnthropicUnavailableError(`Claude request failed before a response (${error.constructor.name})`)
    if (error instanceof APIUserAbortError) return new AnthropicUnavailableError('Claude request was aborted (timeout)')
    // A body that is cut off or malformed surfaces as a raw SyntaxError or TypeError whose message can embed model output.
    if (!(error instanceof APIError)) return new AnthropicUnavailableError(`Claude reply could not be read (${(error as object)?.constructor?.name})`)

    const body = error.error as { error?: { type?: unknown }; request_id?: unknown } | undefined
    const type = AnthropicClient.#shaped(body?.error?.type, AnthropicClient.#TYPE_SHAPE)
    const requestId = AnthropicClient.#shaped(error.requestID ?? body?.request_id, AnthropicClient.#REQUEST_ID_SHAPE)
    const described = `HTTP ${error.status}, type ${type ?? 'none'}, request_id ${requestId ?? 'none'}`
    const { status } = error
    if (status === undefined || status === 429 || status >= 500) return new AnthropicUnavailableError(`Claude unavailable (${described})`)
    if (AnthropicClient.#CONFIG_STATUSES.has(status)) return new AnthropicConfigError(`Claude rejected our credentials or account (${described})`)
    return new AnthropicRequestError(`Claude rejected the request (${described})`)
  }

  static #shaped(value: unknown, shape: RegExp): string | undefined {
    return typeof value === 'string' && shape.test(value) ? value : undefined
  }
}
