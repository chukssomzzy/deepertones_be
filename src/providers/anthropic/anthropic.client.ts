import Anthropic, { APIConnectionError, APIError } from '@anthropic-ai/sdk'
import { z } from 'zod'
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

export type AnthropicClientConfig = {
  apiKey: string
  model: string
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

  readonly #sdk: Anthropic
  readonly #apiKey: string
  readonly #model: string

  constructor({ apiKey, model, timeoutMs = 60000, baseURL, fetch }: AnthropicClientConfig) {
    this.#apiKey = apiKey
    this.#model = model
    // maxRetries 0 is load-bearing: the job dispatcher is the only retrier, and every request is billed once.
    this.#sdk = new Anthropic({ apiKey, baseURL, timeout: timeoutMs, maxRetries: 0, fetch })
  }

  /**
   * One logical turn. A `pause_turn` reply (server tools such as web search ran long) is continued
   * by re-sending the paused content, and every block from every round is returned in order.
   */
  async createMessage(body: MessageRequest): Promise<Message> {
    const content: ContentBlock[] = []
    for (let continuation = 0; ; continuation++) {
      const message = await this.#send(
        content.length === 0 ? body : { ...body, messages: [...body.messages, { role: 'assistant', content }] },
      )
      content.push(...message.content)
      if (message.stop_reason !== 'pause_turn') return { ...message, content }
      if (continuation === AnthropicClient.#MAX_CONTINUATIONS) {
        throw new AnthropicUnavailableError(`Claude was still paused after ${AnthropicClient.#MAX_CONTINUATIONS} continuations`)
      }
    }
  }

  /** A reply constrained to `schema` (structured outputs), parsed and checked against it. */
  async structured<S extends z.ZodType>(body: MessageRequest, schema: S): Promise<z.infer<S>> {
    // Not messages.parse with zodOutputFormat: parse reads only the first text block (an answer can span
    // several), and the SDK's schema transform (0.135.0) moves `enum` into a description, so the API
    // would never see the allowed values. The schema is zod's own JSON Schema, which closes every object.
    const { $schema: _draft, ...jsonSchema } = z.toJSONSchema(schema)
    const message = await this.#send({ ...body, output_config: { format: { type: 'json_schema', schema: jsonSchema } } })
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

  async #send(body: MessageRequest & { output_config?: unknown }): Promise<Message> {
    // Empty until someone copies it into the environment; fail here (a bug to fix) rather than send a bad request.
    if (!this.#apiKey) throw new Error('ANTHROPIC_API_KEY is not set')
    try {
      // MessageRequest keeps tools and content blocks loose (Record<string, unknown>), which the SDK's
      // strict union param types reject; the API validates them, so cast once here.
      const reply = await this.#sdk.messages.create({ ...body, model: this.#model } as Anthropic.Messages.MessageCreateParamsNonStreaming)
      return AnthropicClient.#toMessage(reply)
    } catch (error) {
      throw AnthropicClient.#toError(error)
    }
  }

  static #toMessage(body: unknown): Message {
    const { content, stop_reason } = (body ?? {}) as { content?: unknown; stop_reason?: unknown }
    // Not a message at all (an HTML page from a proxy, say): the API did not really answer, so it is transient.
    if (!Array.isArray(content)) throw new AnthropicUnavailableError('Claude returned a reply that is not a message')
    return { ...(body as object), role: 'assistant', content: content as ContentBlock[], stop_reason: typeof stop_reason === 'string' ? stop_reason : null }
  }

  /** Maps an SDK error to ours, naming only the kind, status, error type and request id. Anything else is returned as is. */
  static #toError(error: unknown): unknown {
    if (error instanceof AnthropicUnavailableError) return error
    // Includes APIConnectionTimeoutError; only the kind, never the cause text.
    if (error instanceof APIConnectionError) return new AnthropicUnavailableError(`Claude request failed before a response (${error.constructor.name})`)
    if (!(error instanceof APIError)) return error

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
