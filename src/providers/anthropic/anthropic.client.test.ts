import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnthropicClient } from './anthropic.client'
import {
  AnthropicConfigError,
  AnthropicRefusalError,
  AnthropicRequestError,
  AnthropicUnavailableError,
  sourceUrlsOf,
  textOf,
} from './anthropic.provider'
import {
  API_KEY,
  type Block,
  caught,
  citation,
  DEFAULT_API_URL,
  errorResponse,
  json,
  MODEL,
  messageResponse,
  REQUEST_ID,
  searchCall,
  searchError,
  searchResults,
  stubFetch,
  textBlock,
  thinkingBlock,
} from './messages-api.fake'

const API_URL = 'https://anthropic.example/v1/messages'
const PROMPT = 'Private prompt text 482913'

const BODY = {
  max_tokens: 1024,
  system: 'You are a careful assistant.',
  messages: [{ role: 'user', content: PROMPT }],
}

const config = { apiKey: API_KEY, model: MODEL, apiUrl: API_URL }

const make = (overrides: Partial<ConstructorParameters<typeof AnthropicClient>[0]> = {}) =>
  new AnthropicClient({ ...config, ...overrides })

const ok = (content: Block[] = [textBlock('hi')], stop_reason = 'end_turn') => () => messageResponse({ content, stop_reason })

/** The assistant content blocks a request carries after the original messages, across consecutive assistant messages. */
const assistantBlocks = (body: any): Block[] =>
  body.messages.filter((m: any) => m.role === 'assistant').flatMap((m: any) => m.content)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('AnthropicClient.createMessage', () => {
  it('posts the body to the Messages API with the key, version and content-type headers and the configured model', async () => {
    const calls = stubFetch(ok([textBlock('hello')]))

    const message = await make().createMessage(BODY)

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.url).toBe(API_URL)
    expect(call.init.method).toBe('POST')
    expect(call.headers.get('x-api-key')).toBe(API_KEY)
    expect(call.headers.get('anthropic-version')).toBe('2023-06-01')
    expect(call.headers.get('content-type')).toBe('application/json')
    expect(call.body).toEqual({ ...BODY, model: MODEL })
    expect(message).toMatchObject({ role: 'assistant', stop_reason: 'end_turn', content: [textBlock('hello')] })
  })

  it('posts to the public Messages API URL when no apiUrl is configured', async () => {
    const calls = stubFetch(ok())

    await make({ apiUrl: undefined }).createMessage(BODY)

    expect(calls[0]!.url).toBe(DEFAULT_API_URL)
  })

  it('rejects naming ANTHROPIC_API_KEY when the key is empty, without calling the API', async () => {
    const calls = stubFetch(ok())
    const client = make({ apiKey: '' })

    const error = await caught(Promise.resolve().then(() => client.createMessage(BODY)))

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('ANTHROPIC_API_KEY')
    expect(calls).toEqual([])
  })

  it.each([
    [401, 'authentication_error'],
    [402, 'billing_error'],
    [403, 'permission_error'],
  ])('throws an AnthropicConfigError on HTTP %s %s, which is neither a request nor an unavailable error', async (status, type) => {
    stubFetch(() => errorResponse(status, type))

    const error = await caught(make().createMessage(BODY))

    expect(error).toBeInstanceOf(AnthropicConfigError)
    expect(error).not.toBeInstanceOf(AnthropicRequestError)
    expect(error).not.toBeInstanceOf(AnthropicUnavailableError)
  })

  it.each([
    [400, 'invalid_request_error'],
    [404, 'not_found_error'],
    [413, 'request_too_large'],
  ])('throws a non-retryable AnthropicRequestError on HTTP %s %s', async (status, type) => {
    stubFetch(() => errorResponse(status, type))

    const error = await caught(make().createMessage(BODY))

    expect(error).toBeInstanceOf(AnthropicRequestError)
    expect(error).not.toBeInstanceOf(AnthropicUnavailableError)
  })

  it.each([
    [429, 'rate_limit_error'],
    [500, 'api_error'],
    [504, 'timeout_error'],
    [529, 'overloaded_error'],
  ])('throws a retryable AnthropicUnavailableError on HTTP %s %s', async (status, type) => {
    stubFetch(() => errorResponse(status, type))

    const error = await caught(make().createMessage(BODY))

    expect(error).toBeInstanceOf(AnthropicUnavailableError)
    expect(error).not.toBeInstanceOf(AnthropicRequestError)
  })

  it.each([
    [401, 'authentication_error'],
    [529, 'overloaded_error'],
  ])('describes an HTTP %s failure by status, error type and request id only, never the key or any content', async (status, type) => {
    stubFetch(() => errorResponse(status, type, 'Free text from the API 7731'))

    const error = await caught(make().createMessage(BODY))

    const message = (error as Error).message
    expect(message).toContain(String(status))
    expect(message).toContain(type)
    expect(message).toContain(REQUEST_ID)
    expect(message).not.toContain(API_KEY)
    expect(message).not.toContain(PROMPT)
    expect(message).not.toContain('Free text from the API 7731')
  })

  it('reports unavailable when the network request fails', async () => {
    stubFetch(() => Promise.reject(new TypeError('network down')))

    const error = await caught(make().createMessage(BODY))

    expect(error).toBeInstanceOf(AnthropicUnavailableError)
  })

  it('reports unavailable instead of hanging when the API never answers', async () => {
    let signal: AbortSignal | null | undefined
    vi.stubGlobal(
      'fetch',
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init?.signal
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )

    const error = await caught(make({ timeoutMs: 10 }).createMessage(BODY))

    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal!.aborted).toBe(true)
    expect(error).toBeInstanceOf(AnthropicUnavailableError)
  })
})

describe('AnthropicClient.createMessage pause_turn continuation', () => {
  const first: Block[] = [textBlock('Searching.'), searchCall('srvtoolu_1', 'brand serum ingredients')]
  const second: Block[] = [searchResults('srvtoolu_1', ['https://brand.example/serum']), textBlock('Still working.')]
  const third: Block[] = [searchCall('srvtoolu_2', 'brand serum inci')]
  const last: Block[] = [textBlock('{"done":true}')]

  it('re-sends the request with the paused assistant content appended unchanged, and returns every block in order', async () => {
    const calls = stubFetch(ok(first, 'pause_turn'), ok(last))

    const message = await make().createMessage(BODY)

    expect(calls).toHaveLength(2)
    expect(calls[1]!.body).toEqual({
      ...calls[0]!.body,
      messages: [...BODY.messages, { role: 'assistant', content: first }],
    })
    expect(message).toMatchObject({ stop_reason: 'end_turn', content: [...first, ...last] })
  })

  it('allows three continuations: the original request plus three re-sends', async () => {
    const calls = stubFetch(ok(first, 'pause_turn'), ok(second, 'pause_turn'), ok(third, 'pause_turn'), ok(last))

    const message = await make().createMessage(BODY)

    expect(calls).toHaveLength(4)
    expect(assistantBlocks(calls[3]!.body)).toEqual([...first, ...second, ...third])
    expect(message).toMatchObject({ stop_reason: 'end_turn', content: [...first, ...second, ...third, ...last] })
  })

  it('throws AnthropicUnavailableError, without a fifth request, when the model is still paused after three continuations', async () => {
    const calls = stubFetch(ok(first, 'pause_turn'))

    const error = await caught(make().createMessage(BODY))

    expect(error).toBeInstanceOf(AnthropicUnavailableError)
    expect(calls).toHaveLength(4)
  })
})

describe('AnthropicClient.structured', () => {
  const SCHEMA = {
    type: 'object',
    properties: { same: { type: 'boolean' } },
    required: ['same'],
    additionalProperties: false,
  }

  it('sends the body with a json_schema output format and returns the parsed JSON', async () => {
    const calls = stubFetch(ok([textBlock('{"same":true}')]))

    const result = await make().structured<{ same: boolean }>(BODY, SCHEMA)

    expect(result).toEqual({ same: true })
    expect(calls[0]!.body).toEqual({
      ...BODY,
      model: MODEL,
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    })
  })

  it('ignores thinking blocks and joins the text blocks before parsing', async () => {
    stubFetch(ok([thinkingBlock('{"same":false}'), textBlock('{"same":'), textBlock('true}')]))

    const result = await make().structured<{ same: boolean }>(BODY, SCHEMA)

    expect(result).toEqual({ same: true })
  })

  it('throws AnthropicRefusalError when the model refuses', async () => {
    stubFetch(ok([textBlock('I cannot help with that.')], 'refusal'))

    const error = await caught(make().structured(BODY, SCHEMA))

    expect(error).toBeInstanceOf(AnthropicRefusalError)
  })

  it('throws a non-retryable AnthropicRequestError when the output was cut off by max_tokens', async () => {
    stubFetch(ok([textBlock('{"same":')], 'max_tokens'))

    const error = await caught(make().structured(BODY, SCHEMA))

    expect(error).toBeInstanceOf(AnthropicRequestError)
    expect(error).not.toBeInstanceOf(AnthropicUnavailableError)
  })

  it('throws AnthropicRequestError, without echoing the output, when the text is not JSON', async () => {
    stubFetch(ok([textBlock('Sorry, secret-output-5521 is not JSON')]))

    const error = await caught(make().structured(BODY, SCHEMA))

    expect(error).toBeInstanceOf(AnthropicRequestError)
    expect((error as Error).message).not.toContain('secret-output-5521')
  })

  it('rejects naming ANTHROPIC_API_KEY when the key is empty, without calling the API', async () => {
    const calls = stubFetch(ok())
    const client = make({ apiKey: '' })

    const error = await caught(Promise.resolve().then(() => client.structured(BODY, SCHEMA)))

    expect((error as Error).message).toContain('ANTHROPIC_API_KEY')
    expect(calls).toEqual([])
  })
})

describe('textOf', () => {
  it('concatenates the text of every text block and nothing else', () => {
    const message = {
      content: [
        thinkingBlock('not this'),
        textBlock('Hello '),
        searchCall('srvtoolu_1', 'not this either'),
        searchResults('srvtoolu_1', ['https://a.example']),
        textBlock('world', [citation('https://a.example')]),
      ],
    }

    expect(textOf(message as never)).toBe('Hello world')
  })
})

describe('sourceUrlsOf', () => {
  const A = 'https://a.example/page'
  const B = 'https://b.example/page'
  const C = 'https://c.example/page'
  const D = 'https://d.example/page'

  it('collects every search result url and every cited url once, ignoring failed searches', () => {
    const message = {
      content: [
        searchCall('srvtoolu_1', 'q1'),
        searchResults('srvtoolu_1', [A, B]),
        searchCall('srvtoolu_2', 'q2'),
        searchResults('srvtoolu_2', [B, C]),
        searchCall('srvtoolu_3', 'q3'),
        searchError('srvtoolu_3'),
        textBlock('uncited'),
        textBlock('cited', [citation(C), citation(D)]),
      ],
    }

    const urls = sourceUrlsOf(message as never)

    expect([...urls].sort()).toEqual([A, B, C, D])
  })

  it('returns nothing when the only search failed', () => {
    const message = { content: [searchCall('srvtoolu_1', 'q'), searchError('srvtoolu_1', 'unavailable'), textBlock('none')] }

    expect([...sourceUrlsOf(message as never)]).toEqual([])
  })
})

describe('AnthropicClient failure descriptions', () => {
  it('names a network failure by kind, without the cause text', async () => {
    stubFetch(() => Promise.reject(new TypeError('network down 90210')))

    const error = await caught(make().createMessage(BODY))

    expect(error).toBeInstanceOf(AnthropicUnavailableError)
    expect((error as Error).message).toContain('HttpNetworkError')
    expect((error as Error).message).not.toContain('90210')
  })

  it('names a timeout by kind', async () => {
    vi.stubGlobal(
      'fetch',
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )

    const error = await caught(make({ timeoutMs: 10 }).createMessage(BODY))

    expect(error).toBeInstanceOf(AnthropicUnavailableError)
    expect((error as Error).message).toContain('HttpTimeoutError')
  })

  it.each([
    ['an HTML page', () => new Response('<html>Bad gateway</html>', { status: 200 })],
    ['JSON without content', () => json({ type: 'message', stop_reason: 'end_turn' })],
  ])('reports unavailable, not a request error, for a 200 that is %s', async (_label, respond) => {
    stubFetch(respond)

    const error = await caught(make().createMessage(BODY))

    expect(error).toBeInstanceOf(AnthropicUnavailableError)
    expect(error).not.toBeInstanceOf(AnthropicRequestError)
  })
})
