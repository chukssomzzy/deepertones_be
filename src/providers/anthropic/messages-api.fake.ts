import type { AiJob } from './ai-spend.provider'

/*
 * Test support for everything that talks to the Claude Messages API through fetch: realistic
 * response bodies (shapes from platform.claude.com/docs/en/api/errors and the web search tool
 * docs) and a fetch function that records requests. No secrets, no network.
 */

export const API_KEY = 'sk-ant-test-super-secret-key'
/** A priced model: the client refuses to call a model it cannot price (see the price table in anthropic.provider.ts). */
export const MODEL = 'claude-sonnet-5-5'
/** Every job on MODEL. */
export const MODELS: Record<AiJob, string> = {
  research: MODEL,
  analysis: MODEL,
  'same-product': MODEL,
  'image-check': MODEL,
  recognize: MODEL,
  'recognize-shelf': MODEL,
  'read-label': MODEL,
  'split-name': MODEL,
  'read-goal': MODEL,
  'read-mentions': MODEL,
  'draft-catalog-row': MODEL,
  'judge-draft': MODEL,
  'judge-routine': MODEL,
  'label-routine': MODEL,
  'judge-grounding': MODEL,
  'write-routine': MODEL,
  'fit-verdict': MODEL,
}
/** A different priced model per job, so a test can tell which model a job was routed to. */
export const ROUTED_MODELS: Record<AiJob, string> = {
  research: 'claude-sonnet-5-5',
  analysis: 'claude-haiku-5-5',
  'same-product': 'claude-opus-5-5',
  'image-check': 'claude-haiku-5-5',
  recognize: 'claude-opus-5-5',
  'recognize-shelf': 'claude-sonnet-5-5',
  'read-label': 'claude-sonnet-5-5',
  'split-name': 'claude-haiku-5-5',
  'read-goal': 'claude-haiku-5-5',
  'read-mentions': 'claude-haiku-5-5',
  'draft-catalog-row': 'claude-opus-5-5',
  'judge-draft': 'claude-sonnet-5-5',
  'judge-routine': 'claude-opus-5-5',
  'label-routine': 'claude-opus-5-5',
  'judge-grounding': 'claude-haiku-5-5',
  'write-routine': 'claude-sonnet-5-5',
  'fit-verdict': 'claude-sonnet-5-5',
}
/** A cap no test comes near, for tests that are not about the cap. */
export const BIG_CAP_MICROS = 1_000_000_000_000
export const DEFAULT_API_URL = 'https://api.anthropic.com/v1/messages'
export const REQUEST_ID = 'req_011CSHoEeqs5C35K2UUqR7Fy'

export type Block = Record<string, unknown>

export const textBlock = (text: string, citations?: Block[]): Block => ({
  type: 'text',
  text,
  ...(citations !== undefined && { citations }),
})

export const citation = (url: string, title = 'Page'): Block => ({
  type: 'web_search_result_location',
  url,
  title,
  encrypted_index: 'Eo8BCioIAhgBIiQ=',
  cited_text: 'Aqua, Glycerin, Niacinamide...',
})

export const thinkingBlock = (thinking = 'Let me think about the label.'): Block => ({
  type: 'thinking',
  thinking,
  signature: 'EqQBCgIYAhIM',
})

export const searchCall = (id: string, query: string): Block => ({
  type: 'server_tool_use',
  id,
  name: 'web_search',
  input: { query },
})

export const searchResults = (toolUseId: string, urls: string[]): Block => ({
  type: 'web_search_tool_result',
  tool_use_id: toolUseId,
  content: urls.map((url) => ({
    type: 'web_search_result',
    url,
    title: `Title of ${url}`,
    encrypted_content: 'EqgfCioIARgBIiQ3YTAwMjY1Mi1mZjM5',
    page_age: 'April 30, 2025',
  })),
})

export const searchError = (toolUseId: string, errorCode = 'max_uses_exceeded'): Block => ({
  type: 'web_search_tool_result',
  tool_use_id: toolUseId,
  content: { type: 'web_search_tool_result_error', error_code: errorCode },
})

export const fetchCall = (id: string, url: string): Block => ({
  type: 'server_tool_use',
  id,
  name: 'web_fetch',
  input: { url },
})

/** A page the web fetch tool read: the shape of the tool's documentation (the url is the one fetched; the docs do not say whether that is before or after a redirect). */
export const fetchedPage = (toolUseId: string, url: string): Block => ({
  type: 'web_fetch_tool_result',
  tool_use_id: toolUseId,
  content: {
    type: 'web_fetch_result',
    url,
    retrieved_at: '2026-01-01T00:00:00Z',
    content: { type: 'document', title: 'A page', source: { type: 'text', media_type: 'text/plain', data: 'Page text.' } },
  },
})

/** A fetch that failed. It names the url it was asked for, which still does not make that page fetched. */
export const fetchError = (toolUseId: string, url?: string, errorCode = 'url_not_accessible'): Block => ({
  type: 'web_fetch_tool_result',
  tool_use_id: toolUseId,
  content: { type: 'web_fetch_tool_result_error', error_code: errorCode, ...(url !== undefined && { url }) },
})

/** The usage block of a response, in the API's own field names. Fields the API omits (cache counts, server_tool_use) are optional. */
export type ApiUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
  server_tool_use?: { web_search_requests?: number }
}

export const DEFAULT_USAGE: ApiUsage = { input_tokens: 2095, output_tokens: 503, server_tool_use: { web_search_requests: 1 } }

/** `usage: null` leaves the usage block out of the response altogether. */
export type MessageOptions = { content: Block[]; stop_reason?: string; usage?: ApiUsage | null }

/** The body of a successful Messages API response. */
export const messageBody = ({ content, stop_reason = 'end_turn', usage = DEFAULT_USAGE }: MessageOptions) => ({
  id: 'msg_01XFDUDYJgAACzvnptvVoYEL',
  type: 'message',
  role: 'assistant',
  model: MODEL,
  content,
  stop_reason,
  stop_sequence: null,
  ...(usage !== null && { usage }),
})

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export const messageResponse = (options: MessageOptions) => json(messageBody(options))

/** An error response in the documented shape. `message` is free text from the API and must never be echoed. */
export const errorResponse = (
  status: number,
  type: string,
  message = 'Free text from the API 7731',
  requestId: string | undefined = REQUEST_ID,
) => json({ type: 'error', error: { type, message }, ...(requestId !== undefined && { request_id: requestId }) }, status)

export type Call = { url: string; init: RequestInit; headers: Headers; body: any }

/**
 * A fetch function to inject into AnthropicClient (nothing global is stubbed). Each request gets the
 * next responder; the last responder repeats once the list runs out. Responders are factories
 * because a Response body can be read only once. `calls` records every request the client sent.
 */
export const stubFetch = (...responders: (() => Response | Promise<Response>)[]) => {
  const calls: Call[] = []
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestInit = init ?? {}
    calls.push({
      url: String(input),
      init: requestInit,
      headers: new Headers(requestInit.headers),
      body: typeof requestInit.body === 'string' ? JSON.parse(requestInit.body) : undefined,
    })
    const responder = responders[Math.min(calls.length, responders.length) - 1]!
    return responder()
  }
  return { calls, fetch }
}

/** A fetch that never answers; it rejects with an AbortError only when the request's signal aborts. */
export const hangingFetch = () => {
  const state: { signal: AbortSignal | null | undefined } = { signal: undefined }
  const fetch = (_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      state.signal = init?.signal
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    })
  return { state, fetch }
}

/** Rejects with the error the promise rejected with; fails if it resolved. */
export const caught = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the promise to reject')
}

/** All text a request sends to the model: the system prompt plus every text in every message. */
export const requestText = (body: any): string => {
  const parts: string[] = []
  const walk = (value: unknown) => {
    if (typeof value === 'string') parts.push(value)
    else if (Array.isArray(value)) value.forEach(walk)
    else if (value && typeof value === 'object' && (value as Block).type === 'text') parts.push(String((value as Block).text))
  }
  walk(body.system)
  for (const message of body.messages ?? []) walk(message.content)
  return parts.join('\n')
}
