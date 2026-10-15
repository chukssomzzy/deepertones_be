import { vi } from 'vitest'

/*
 * Test support for everything that talks to the Claude Messages API through fetch: realistic
 * response bodies (shapes from platform.claude.com/docs/en/api/errors and the web search tool
 * docs) and a fetch stub that records requests. No secrets, no network.
 */

export const API_KEY = 'sk-ant-test-super-secret-key'
export const MODEL = 'claude-test-model'
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

export type MessageOptions = { content: Block[]; stop_reason?: string }

/** The body of a successful Messages API response. */
export const messageBody = ({ content, stop_reason = 'end_turn' }: MessageOptions) => ({
  id: 'msg_01XFDUDYJgAACzvnptvVoYEL',
  type: 'message',
  role: 'assistant',
  model: MODEL,
  content,
  stop_reason,
  stop_sequence: null,
  usage: { input_tokens: 2095, output_tokens: 503, server_tool_use: { web_search_requests: 1 } },
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
 * Stubs global fetch. Each request gets the next responder; the last responder repeats once the list
 * runs out. Responders are factories because a Response body can be read only once.
 */
export const stubFetch = (...responders: (() => Response | Promise<Response>)[]) => {
  const calls: Call[] = []
  const stub = async (input: RequestInfo | URL, init?: RequestInit) => {
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
  vi.stubGlobal('fetch', stub)
  return calls
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
