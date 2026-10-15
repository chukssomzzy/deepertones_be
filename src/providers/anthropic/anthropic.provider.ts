/*
 * The shared vocabulary for talking to the Claude Messages API: message shapes, errors and helpers
 * for reading a reply. It lives in a *.provider.ts file so product adapters can import it as values
 * without importing the client class, which only the container may do.
 */

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
