/*
 * The shared vocabulary for talking to the Claude Messages API: message shapes, errors and helpers
 * for reading a reply. It lives in a *.provider.ts file so product adapters can import it as values
 * without importing the client class, which only the container may do.
 */
import type { AiJob, AiUsage } from './ai-spend.provider'

/** A content block as the API returns it (text, thinking, server_tool_use, web_search_tool_result...). Passed back unchanged. */
export type ContentBlock = { type: string; [key: string]: unknown }

export type InputMessage = { role: string; content: string | ContentBlock[] }

/** The request fields callers control; the client adds the model. */
export type MessageRequest = {
  max_tokens: number
  system?: string
  messages: InputMessage[]
  tools?: Record<string, unknown>[]
}

export type Message = {
  role: 'assistant'
  content: ContentBlock[]
  stop_reason: string | null
}

/** What the client needs to know about a call's job: which model to use and which line of the ledger it belongs to. */
export type CallOptions = { job: AiJob }

/*
 * Three sibling error classes; a caller retries on the first only.
 *   AnthropicUnavailableError  retry later: the API is down, throttling us, unreachable, or sent a non-message reply.
 *   AnthropicConfigError       our key, billing or permissions are wrong: fix the setup, retrying cannot help.
 *   AnthropicRequestError      permanent for this input: the same request will be rejected or cut off again.
 */

/** The API is down, throttling us, or unreachable; the same request may work later. */
export class AnthropicUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AnthropicUnavailableError'
  }
}

/** Our API key, billing or permissions are rejected: a setup task, like a bad ZeptoMail key, not a problem with the input. */
export class AnthropicConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AnthropicConfigError'
  }
}

/** The API rejected the request or returned something unusable; repeating it unchanged will not help. */
export class AnthropicRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AnthropicRequestError'
  }
}

/** The model declined to answer (stop_reason "refusal"). */
export class AnthropicRefusalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AnthropicRefusalError'
  }
}

// These two helpers live here, not in the client, because adapters need them as values and only a
// *.provider.ts file may be imported that way outside the container.
/** The text of every text block, joined; thinking and tool blocks are left out. */
export const textOf = (message: Pick<Message, 'content'>): string =>
  message.content.flatMap((block) => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])).join('')

/** Every URL the web search returned or the answer cites. A failed search returns an error object, not a list, and adds none. */
export const sourceUrlsOf = (message: Pick<Message, 'content'>): Set<string> => {
  const urls = new Set<string>()
  const add = (value: unknown) => {
    const url = (value as { url?: unknown } | null)?.url
    if (typeof url === 'string') urls.add(url)
  }
  for (const block of message.content) {
    if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) block.content.forEach(add)
    if (block.type === 'text' && Array.isArray(block.citations)) block.citations.forEach(add)
  }
  return urls
}

/*
 * Prices. They live here and not in a file of their own because the client may import only *.provider.ts files from
 * its folder (concrete-classes-only-in-container), and it is the client that prices every call.
 *
 * Source: https://platform.claude.com/docs/en/about-claude/pricing (model pricing and the web search tool), fetched
 * 2026-10-15. Re-read that page and update the table and this date when a model is added or prices change; a model
 * missing from the table is refused by the client rather than counted as free.
 *
 * Only the 5-minute cache-write rate is priced: no request uses a 1-hour cache_control. Add a rate for it (1h writes cost
 * more) before ever sending one, or its writes would be under-counted.
 *
 * Rates are thousandths of a micro-USD per token (a price of $2 per million tokens is 2 micro-USD per token, 2000 here),
 * so every price on the page is a whole number and a call is summed in integers, rounded up to a whole micro once.
 * Floating-point sums can land a hair above an exact total and round up one micro too many.
 */
type Rates = { input: number; output: number; cacheWrite: number; cacheRead: number }
type Price = { base: Rates; /** Rates for a prompt over PROMPT_TIER_TOKENS, when the model prices by prompt length. */ long?: Rates }

/** Haiku 5.5 charges more for a request whose prompt (input + cache reads + cache writes) is over this many tokens. */
const PROMPT_TIER_TOKENS = 100_000
/** $10 per 1,000 searches, in thousandths of a micro. */
const SEARCH_RATE = 10_000_000
/**
 * Input tokens a web search can add to the prompt (the results it fetched, fed back to the model), for the worst case.
 * A CALIBRATION KNOB, not a measured fact: it is added per allowed search to the input before the reservation picks its
 * Haiku tier, so it also decides whether a search call is reserved at the long-prompt rates. Tune it from real
 * `ai_usage` rows: the largest input_tokens per search seen on a settled research call (input_tokens / web_searches).
 */
export const SEARCH_INPUT_ALLOWANCE = 25_000

/** Tokens reserved per image: its real cost depends on its dimensions, which are not known here, never on the size of the file. */
const IMAGE_TOKENS = 5000

const PRICES: Record<string, Price> = {
  'claude-sonnet-5-5': { base: { input: 2000, output: 10_000, cacheWrite: 2500, cacheRead: 100 } },
  'claude-haiku-5-5': {
    base: { input: 100, output: 500, cacheWrite: 125, cacheRead: 10 },
    long: { input: 500, output: 2500, cacheWrite: 625, cacheRead: 50 },
  },
  'claude-opus-5-5': { base: { input: 4000, output: 20_000, cacheWrite: 5000, cacheRead: 200 } },
}

/** The price of a model, or undefined for one that is not in the table. */
export const priceOf = (model: string): Price | undefined => (Object.hasOwn(PRICES, model) ? PRICES[model] : undefined)

const requirePrice = (model: string): Price => {
  const price = priceOf(model)
  if (!price) throw new Error(`No price is known for the model "${model}"`)
  return price
}

const ratesFor = (price: Price, promptTokens: number): Rates => (price.long && promptTokens > PROMPT_TIER_TOKENS ? price.long : price.base)

/** What a response cost, in whole micro-USD, rounded up once on the total. Throws for a model with no price. */
export const costMicros = (model: string, usage: AiUsage): number => {
  const rates = ratesFor(requirePrice(model), usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens)
  const thousandths =
    usage.inputTokens * rates.input +
    usage.outputTokens * rates.output +
    usage.cacheWriteTokens * rates.cacheWrite +
    usage.cacheReadTokens * rates.cacheRead +
    usage.webSearches * SEARCH_RATE
  return Math.ceil(thousandths / 1000)
}

/**
 * The most a request can cost: all its input, the whole output allowance and every search it permits, each search also
 * adding SEARCH_INPUT_ALLOWANCE tokens of results to the prompt. That input is added BEFORE the tier is chosen, so a
 * Haiku call with searches is reserved at the long-prompt rates the real bill would use.
 */
export const estimateMicros = (model: string, request: { inputTokens: number; maxOutputTokens: number; maxSearches: number }): number => {
  const inputTokens = request.inputTokens + request.maxSearches * SEARCH_INPUT_ALLOWANCE
  const rates = ratesFor(requirePrice(model), inputTokens)
  return Math.ceil((inputTokens * rates.input + request.maxOutputTokens * rates.output + request.maxSearches * SEARCH_RATE) / 1000)
}

const textEncoder = new TextEncoder()

/**
 * An estimate of a request's input tokens: its JSON bytes divided by 2.5, rounded up (the current tokenizer averages
 * about 2.5 characters per token, so dividing by more would under-count), plus a flat IMAGE_TOKENS for each image. An
 * image's base64 is left out of the count, because its cost depends on its dimensions and not on the size of the file.
 */
export const estimateInputTokens = (request: unknown): number => {
  let images = 0
  const json = JSON.stringify(request, (_key, value: { type?: unknown; source?: object } | null) => {
    if (value?.type !== 'image') return value
    images++
    return { ...value, source: { ...value.source, data: '' } }
  })
  return Math.ceil((textEncoder.encode(json).length * 2) / 5) + images * IMAGE_TOKENS
}
