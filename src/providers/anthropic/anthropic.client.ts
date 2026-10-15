import { firstValueFrom } from 'rxjs'
import { type HttpResponse, HttpTransportError, requestJson$ } from '../../lib/http'
import {
  AnthropicConfigError,
  AnthropicRefusalError,
  AnthropicRequestError,
  AnthropicUnavailableError,
  type ContentBlock,
  type Message,
  type MessageRequest,
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
  model: string
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
  async createMessage(body: MessageRequest): Promise<Message> {
    const content: ContentBlock[] = []
    for (let continuation = 0; ; continuation++) {
      const message = await this.send(
        content.length === 0 ? body : { ...body, messages: [...body.messages, { role: 'assistant', content }] },
      )
      content.push(...message.content)
      if (message.stop_reason !== 'pause_turn') return { ...message, content }
      if (continuation === MAX_CONTINUATIONS) {
        throw new AnthropicUnavailableError(`Claude was still paused after ${MAX_CONTINUATIONS} continuations`)
      }
    }
  }

  /** A reply constrained to `schema` (structured outputs), parsed. The caller owns the type; the API enforces the schema. */
  async structured<T>(body: MessageRequest, schema: Record<string, unknown>): Promise<T> {
    const message = await this.send({ ...body, output_config: { format: { type: 'json_schema', schema } } })
    if (message.stop_reason === 'refusal') throw new AnthropicRefusalError('Claude refused to answer')
    // A cut-off answer is not valid JSON, and asking again with the same limit would be cut off again.
    if (message.stop_reason === 'max_tokens') throw new AnthropicRequestError('Claude ran out of max_tokens before finishing the answer')
    try {
      return JSON.parse(textOf(message)) as T
    } catch {
      throw new AnthropicRequestError('Claude returned text that is not valid JSON')
    }
  }

  private async send(body: MessageRequest & { output_config?: unknown }): Promise<Message> {
    const { apiKey, model, timeoutMs = DEFAULT_TIMEOUT_MS, apiUrl = DEFAULT_API_URL } = this.config
    // Empty until someone copies it into the environment; fail here (a bug to fix) rather than send a bad request.
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set')
    let response: HttpResponse
    try {
      response = await firstValueFrom(
        requestJson$(apiUrl, {
          method: 'POST',
          timeoutMs,
          headers: { 'x-api-key': apiKey, 'anthropic-version': API_VERSION, 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, model }),
        }),
      )
    } catch (error) {
      // Only the kind (HttpTimeoutError or HttpNetworkError), never the cause text.
      if (error instanceof HttpTransportError) throw new AnthropicUnavailableError(`Claude request failed before a response (${error.name})`)
      throw error
    }
    if (response.ok) return asMessage(response.body)

    const { type, requestId } = apiError(response.body)
    const described = `HTTP ${response.status}, type ${type ?? 'none'}, request_id ${requestId ?? 'none'}`
    if (response.status === 429 || response.status >= 500) throw new AnthropicUnavailableError(`Claude unavailable (${described})`)
    if (CONFIG_STATUSES.has(response.status)) throw new AnthropicConfigError(`Claude rejected our credentials or account (${described})`)
    throw new AnthropicRequestError(`Claude rejected the request (${described})`)
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
