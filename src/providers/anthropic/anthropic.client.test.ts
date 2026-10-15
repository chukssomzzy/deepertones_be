import { afterEach, describe, expect, it, vi } from 'vitest'
import { AnthropicClient, type AnthropicClientConfig } from './anthropic.client'
import {
  AnthropicConfigError,
  AnthropicRefusalError,
  AnthropicRequestError,
  AnthropicUnavailableError,
  sourceUrlsOf,
  textOf,
} from './anthropic.provider'
import { estimateInputTokens, estimateMicros } from './anthropic.provider'
import { AiBudgetExceededError, type AiJob, type AiSpendLedger } from './ai-spend.provider'
import { MemoryAiSpendLedger } from './memory.ai-spend-ledger'
import {
  type ApiUsage,
  API_KEY,
  BIG_CAP_MICROS,
  type Block,
  caught,
  citation,
  DEFAULT_API_URL,
  errorResponse,
  json,
  MODEL,
  MODELS,
  messageResponse,
  REQUEST_ID,
  ROUTED_MODELS,
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

/** The job most tests run under; every job is on MODEL unless a test routes them elsewhere. */
const RESEARCH = { job: 'research' } as const

const newLedger = () => new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS })

const make = (overrides: Partial<AnthropicClientConfig> = {}) =>
  new AnthropicClient({ apiKey: API_KEY, models: MODELS, ledger: newLedger(), apiUrl: API_URL, ...overrides })

const ok = (content: Block[] = [textBlock('hi')], stop_reason = 'end_turn') => () => messageResponse({ content, stop_reason })

/** The assistant content blocks a request carries after the original messages, across consecutive assistant messages. */
const assistantBlocks = (body: any): Block[] =>
  body.messages.filter((m: any) => m.role === 'assistant').flatMap((m: any) => m.content)

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('AnthropicClient.createMessage', () => {
  it('posts the body to the Messages API with the key, version and content-type headers and the model of its job', async () => {
    const calls = stubFetch(ok([textBlock('hello')]))

    const message = await make().createMessage(BODY, RESEARCH)

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

    await make({ apiUrl: undefined }).createMessage(BODY, RESEARCH)

    expect(calls[0]!.url).toBe(DEFAULT_API_URL)
  })

  it('rejects naming ANTHROPIC_API_KEY when the key is empty, without calling the API', async () => {
    const calls = stubFetch(ok())
    const ledger = newLedger()
    const client = make({ apiKey: '', ledger })

    const error = await caught(Promise.resolve().then(() => client.createMessage(BODY, RESEARCH)))

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('ANTHROPIC_API_KEY')
    expect(calls).toEqual([])
    expect(ledger.entries).toEqual([])
  })

  it.each([
    [401, 'authentication_error'],
    [402, 'billing_error'],
    [403, 'permission_error'],
  ])('throws an AnthropicConfigError on HTTP %s %s, which is neither a request nor an unavailable error', async (status, type) => {
    stubFetch(() => errorResponse(status, type))

    const error = await caught(make().createMessage(BODY, RESEARCH))

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

    const error = await caught(make().createMessage(BODY, RESEARCH))

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

    const error = await caught(make().createMessage(BODY, RESEARCH))

    expect(error).toBeInstanceOf(AnthropicUnavailableError)
    expect(error).not.toBeInstanceOf(AnthropicRequestError)
  })

  it.each([
    [401, 'authentication_error'],
    [529, 'overloaded_error'],
  ])('describes an HTTP %s failure by status, error type and request id only, never the key or any content', async (status, type) => {
    stubFetch(() => errorResponse(status, type, 'Free text from the API 7731'))

    const error = await caught(make().createMessage(BODY, RESEARCH))

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

    const error = await caught(make().createMessage(BODY, RESEARCH))

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

    const error = await caught(make({ timeoutMs: 10 }).createMessage(BODY, RESEARCH))

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

    const message = await make().createMessage(BODY, RESEARCH)

    expect(calls).toHaveLength(2)
    expect(calls[1]!.body).toEqual({
      ...calls[0]!.body,
      messages: [...BODY.messages, { role: 'assistant', content: first }],
    })
    expect(message).toMatchObject({ stop_reason: 'end_turn', content: [...first, ...last] })
  })

  it('allows three continuations: the original request plus three re-sends', async () => {
    const calls = stubFetch(ok(first, 'pause_turn'), ok(second, 'pause_turn'), ok(third, 'pause_turn'), ok(last))

    const message = await make().createMessage(BODY, RESEARCH)

    expect(calls).toHaveLength(4)
    expect(assistantBlocks(calls[3]!.body)).toEqual([...first, ...second, ...third])
    expect(message).toMatchObject({ stop_reason: 'end_turn', content: [...first, ...second, ...third, ...last] })
  })

  it('throws AnthropicUnavailableError, without a fifth request, when the model is still paused after three continuations', async () => {
    const calls = stubFetch(ok(first, 'pause_turn'))
    const ledger = newLedger()

    const error = await caught(make({ ledger }).createMessage(BODY, RESEARCH))

    expect(error).toBeInstanceOf(AnthropicUnavailableError)
    expect(calls).toHaveLength(4)
    // All four rounds were answered, so all four were billed; none is released.
    expect(ledger.entries.map((e) => e.status)).toEqual(['settled', 'settled', 'settled', 'settled'])
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

    const result = await make().structured<{ same: boolean }>(BODY, SCHEMA, RESEARCH)

    expect(result).toEqual({ same: true })
    expect(calls[0]!.body).toEqual({
      ...BODY,
      model: MODEL,
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    })
  })

  it('ignores thinking blocks and joins the text blocks before parsing', async () => {
    stubFetch(ok([thinkingBlock('{"same":false}'), textBlock('{"same":'), textBlock('true}')]))

    const result = await make().structured<{ same: boolean }>(BODY, SCHEMA, RESEARCH)

    expect(result).toEqual({ same: true })
  })

  it('throws AnthropicRefusalError when the model refuses', async () => {
    stubFetch(ok([textBlock('I cannot help with that.')], 'refusal'))

    const error = await caught(make().structured(BODY, SCHEMA, RESEARCH))

    expect(error).toBeInstanceOf(AnthropicRefusalError)
  })

  it('throws a non-retryable AnthropicRequestError when the output was cut off by max_tokens', async () => {
    stubFetch(ok([textBlock('{"same":')], 'max_tokens'))

    const error = await caught(make().structured(BODY, SCHEMA, RESEARCH))

    expect(error).toBeInstanceOf(AnthropicRequestError)
    expect(error).not.toBeInstanceOf(AnthropicUnavailableError)
  })

  it('throws AnthropicRequestError, without echoing the output, when the text is not JSON', async () => {
    stubFetch(ok([textBlock('Sorry, secret-output-5521 is not JSON')]))

    const error = await caught(make().structured(BODY, SCHEMA, RESEARCH))

    expect(error).toBeInstanceOf(AnthropicRequestError)
    expect((error as Error).message).not.toContain('secret-output-5521')
  })

  it('rejects naming ANTHROPIC_API_KEY when the key is empty, without calling the API', async () => {
    const calls = stubFetch(ok())
    const ledger = newLedger()
    const client = make({ apiKey: '', ledger })

    const error = await caught(Promise.resolve().then(() => client.structured(BODY, SCHEMA, RESEARCH)))

    expect((error as Error).message).toContain('ANTHROPIC_API_KEY')
    expect(calls).toEqual([])
    expect(ledger.entries).toEqual([])
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

    const error = await caught(make().createMessage(BODY, RESEARCH))

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

    const error = await caught(make({ timeoutMs: 10 }).createMessage(BODY, RESEARCH))

    expect(error).toBeInstanceOf(AnthropicUnavailableError)
    expect((error as Error).message).toContain('HttpTimeoutError')
  })

  it.each([
    ['an HTML page', () => new Response('<html>Bad gateway</html>', { status: 200 })],
    ['JSON without content', () => json({ type: 'message', stop_reason: 'end_turn' })],
  ])('reports unavailable, not a request error, for a 200 that is %s', async (_label, respond) => {
    stubFetch(respond)

    const error = await caught(make().createMessage(BODY, RESEARCH))

    expect(error).toBeInstanceOf(AnthropicUnavailableError)
    expect(error).not.toBeInstanceOf(AnthropicRequestError)
  })
})


/*
 * Spend accounting. Expected costs are worked out by hand from Anthropic's prices (see anthropic.pricing.test.ts);
 * the worst-case reservation is checked against the formula applied to the request the test saw being sent.
 */
const JOBS = Object.keys(ROUTED_MODELS) as AiJob[]

const okWith = (usage: ApiUsage | null, content: Block[] = [textBlock('hi')], stop_reason = 'end_turn') => () =>
  messageResponse({ content, stop_reason, usage })

const searchesIn = (body: any): number =>
  (body.tools ?? []).filter((t: any) => t.name === 'web_search').reduce((sum: number, t: any) => sum + t.max_uses, 0)

/** The reservation the spec calls for, for a request as it was actually sent. */
const worstCaseOf = (sent: any): number =>
  estimateMicros(sent.model, { inputTokens: estimateInputTokens(sent), maxOutputTokens: sent.max_tokens, maxSearches: searchesIn(sent) })

const SEARCH_TOOL = { type: 'web_search_20250305', name: 'web_search', max_uses: 5 }

describe('AnthropicClient job routing', () => {
  it.each(JOBS)('sends createMessage for the %s job to the model configured for that job', async (job) => {
    const calls = stubFetch(ok())

    await make({ models: ROUTED_MODELS }).createMessage(BODY, { job })

    expect(calls[0]!.body.model).toBe(ROUTED_MODELS[job])
  })

  it.each(JOBS)('sends structured for the %s job to the model configured for that job', async (job) => {
    const calls = stubFetch(ok([textBlock('{"same":true}')]))

    await make({ models: ROUTED_MODELS }).structured(BODY, { type: 'object' }, { job })

    expect(calls[0]!.body.model).toBe(ROUTED_MODELS[job])
  })

  it.each(JOBS)('records the %s job and its model on the reservation', async (job) => {
    stubFetch(ok())
    const ledger = newLedger()

    await make({ models: ROUTED_MODELS, ledger }).createMessage(BODY, { job })

    expect(ledger.entries).toHaveLength(1)
    expect(ledger.entries[0]).toMatchObject({ job, model: ROUTED_MODELS[job] })
  })
})

describe('AnthropicClient reserving before a request', () => {
  it('reserves the worst case of the request, in the job and model of the call, BEFORE sending it', async () => {
    const calls = stubFetch(ok())
    const requestsSeenAtReserve: number[] = []
    class Spy extends MemoryAiSpendLedger {
      override async reserve(input: Parameters<AiSpendLedger['reserve']>[0]) {
        requestsSeenAtReserve.push(calls.length)
        return super.reserve(input)
      }
    }
    const ledger = new Spy({ capMicros: BIG_CAP_MICROS })

    await make({ ledger }).createMessage(BODY, RESEARCH)

    expect(requestsSeenAtReserve).toEqual([0])
    expect(ledger.entries).toHaveLength(1)
    expect(ledger.entries[0]).toMatchObject({ job: 'research', model: MODEL, estimateMicros: worstCaseOf(calls[0]!.body) })
    // The whole 1024-token output allowance at $10 per million tokens is already 10240 micros.
    expect(ledger.entries[0]!.estimateMicros).toBeGreaterThanOrEqual(10_240)
  })

  it('reserves for a structured request too, counting the schema it sends', async () => {
    const calls = stubFetch(ok([textBlock('{"same":true}')]))
    const ledger = newLedger()
    const schema = { type: 'object', properties: { same: { type: 'boolean' } }, required: ['same'], additionalProperties: false }

    await make({ ledger }).structured(BODY, schema, RESEARCH)

    expect(calls[0]!.body.output_config.format.schema).toEqual(schema)
    expect(ledger.entries[0]!.estimateMicros).toBe(worstCaseOf(calls[0]!.body))
  })

  it('allows for every search the request permits: the max_uses of all its web_search tools, and no other tool', async () => {
    const calls = stubFetch(ok())
    const ledger = newLedger()
    const tools = [SEARCH_TOOL, { type: 'web_search_20250305', name: 'web_search', max_uses: 2 }, { type: 'custom', name: 'lookup', max_uses: 40 }]

    await make({ ledger }).createMessage({ ...BODY, tools }, RESEARCH)

    const sent = calls[0]!.body
    const expected = estimateMicros(MODEL, { inputTokens: estimateInputTokens(sent), maxOutputTokens: 1024, maxSearches: 7 })
    expect(ledger.entries[0]!.estimateMicros).toBe(expected)
  })

  it('reserves again before each pause_turn continuation, from the larger request it is about to send', async () => {
    const paused: Block[] = [textBlock('Searching.'), searchCall('srvtoolu_1', 'brand serum ingredients'), searchResults('srvtoolu_1', ['https://brand.example/serum'])]
    const calls = stubFetch(ok(paused, 'pause_turn'), ok([textBlock('{"done":true}')]))
    const ledger = newLedger()

    await make({ ledger }).createMessage(BODY, RESEARCH)

    expect(calls).toHaveLength(2)
    expect(ledger.entries).toHaveLength(2)
    expect(ledger.entries[0]!.estimateMicros).toBe(worstCaseOf(calls[0]!.body))
    expect(ledger.entries[1]!.estimateMicros).toBe(worstCaseOf(calls[1]!.body))
    expect(ledger.entries[1]!.estimateMicros).toBeGreaterThan(ledger.entries[0]!.estimateMicros)
  })

  describe('the cap', () => {
    // The request createMessage will send, written out, so the cap can be set to exactly its worst case.
    const SENT = { ...BODY, model: MODEL }

    it('sends a request whose worst case is exactly what the cap has left', async () => {
      const calls = stubFetch(ok())
      const ledger = new MemoryAiSpendLedger({ capMicros: worstCaseOf(SENT) })

      await make({ ledger }).createMessage(BODY, RESEARCH)

      expect(calls).toHaveLength(1)
    })

    it('refuses with AiBudgetExceededError, and sends nothing, when the worst case is one micro over', async () => {
      const calls = stubFetch(ok())
      const ledger = new MemoryAiSpendLedger({ capMicros: worstCaseOf(SENT) - 1 })

      const error = await caught(make({ ledger }).createMessage(BODY, RESEARCH))

      expect(error).toBeInstanceOf(AiBudgetExceededError)
      expect(calls).toEqual([])
      expect(ledger.entries).toEqual([])
    })

    it('refuses a structured request over the cap the same way', async () => {
      const calls = stubFetch(ok())
      const ledger = new MemoryAiSpendLedger({ capMicros: 0 })

      const error = await caught(make({ ledger }).structured(BODY, { type: 'object' }, RESEARCH))

      expect(error).toBeInstanceOf(AiBudgetExceededError)
      expect(calls).toEqual([])
    })

    it('lets the very error the ledger threw through, not a wrapped one', async () => {
      stubFetch(ok())
      const thrown = new AiBudgetExceededError('cap reached')
      class Refuses extends MemoryAiSpendLedger {
        override async reserve(): Promise<string> {
          throw thrown
        }
      }

      const error = await caught(make({ ledger: new Refuses({ capMicros: 0 }) }).createMessage(BODY, RESEARCH))

      expect(error).toBe(thrown)
    })

    it('stops a pause_turn continuation the cap cannot afford, after the first round was sent and billed', async () => {
      const paused: Block[] = [textBlock('Searching.'), searchCall('srvtoolu_1', 'q'), searchResults('srvtoolu_1', ['https://brand.example/serum'])]
      const calls = stubFetch(ok(paused, 'pause_turn'), ok([textBlock('{"done":true}')]))
      // Room for the first round's reservation and no more: its settled cost plus the larger second reservation cannot fit.
      const ledger = new MemoryAiSpendLedger({ capMicros: worstCaseOf(SENT) })

      const error = await caught(make({ ledger }).createMessage(BODY, RESEARCH))

      expect(error).toBeInstanceOf(AiBudgetExceededError)
      expect(calls).toHaveLength(1)
      expect(ledger.entries.map((e) => e.status)).toEqual(['settled'])
    })

    it.each([
      ['createMessage', (client: AnthropicClient) => client.createMessage(BODY, RESEARCH)],
      ['structured', (client: AnthropicClient) => client.structured(BODY, { type: 'object' }, RESEARCH)],
    ])('sends nothing, and throws a retryable AnthropicUnavailableError with no detail, when the ledger cannot be reached (%s: spend that cannot be counted is not allowed)', async (_name, run) => {
      const calls = stubFetch(ok())
      const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      class Unreachable extends MemoryAiSpendLedger {
        override async reserve(): Promise<string> {
          throw new Error('database is down: ledger-secret-detail 4417')
        }
      }

      const error = await caught(Promise.resolve().then(() => run(make({ ledger: new Unreachable({ capMicros: BIG_CAP_MICROS }) }))))

      expect(error).toBeInstanceOf(AnthropicUnavailableError)
      expect((error as Error).message).not.toContain('ledger-secret-detail')
      expect((error as Error).message).not.toContain('database')
      expect(calls).toEqual([])
      expect(log.mock.calls).toEqual([[{ outcome: 'ai-ledger-failed' }]])
    })
  })

  describe('a model with no price', () => {
    it('throws AnthropicConfigError before reserving or fetching', async () => {
      const calls = stubFetch(ok())
      const ledger = newLedger()

      const error = await caught(make({ models: { ...MODELS, research: 'claude-test-model' }, ledger }).createMessage(BODY, RESEARCH))

      expect(error).toBeInstanceOf(AnthropicConfigError)
      expect(calls).toEqual([])
      expect(ledger.entries).toEqual([])
    })

    it('does the same for structured', async () => {
      const calls = stubFetch(ok())
      const ledger = newLedger()

      const error = await caught(make({ models: { ...MODELS, research: 'claude-test-model' }, ledger }).structured(BODY, { type: 'object' }, RESEARCH))

      expect(error).toBeInstanceOf(AnthropicConfigError)
      expect(calls).toEqual([])
      expect(ledger.entries).toEqual([])
    })

    it('only matters for the job being run: another job on an unpriced model does not stop research', async () => {
      const calls = stubFetch(ok())

      await make({ models: { ...MODELS, analysis: 'claude-test-model' } }).createMessage(BODY, RESEARCH)

      expect(calls).toHaveLength(1)
    })
  })
})

describe('AnthropicClient settling after a response', () => {
  it('settles with the usage the API reported and its cost: 2000 + 5000 + 500 + 300 + 2 searches at 10000 is 27800 micros on Sonnet', async () => {
    stubFetch(
      okWith({
        input_tokens: 1000,
        output_tokens: 500,
        cache_creation_input_tokens: 200,
        cache_read_input_tokens: 3000,
        server_tool_use: { web_search_requests: 2 },
      }),
    )
    const ledger = newLedger()

    await make({ ledger }).createMessage(BODY, RESEARCH)

    expect(ledger.entries).toHaveLength(1)
    expect(ledger.entries[0]).toMatchObject({
      status: 'settled',
      costMicros: 27_800,
      usage: { inputTokens: 1000, outputTokens: 500, cacheWriteTokens: 200, cacheReadTokens: 3000, webSearches: 2 },
    })
  })

  it('reads a field the API left out as zero: no cache counts and no server_tool_use is 100 in and 50 out, 200 + 500 micros', async () => {
    stubFetch(okWith({ input_tokens: 100, output_tokens: 50 }))
    const ledger = newLedger()

    await make({ ledger }).createMessage(BODY, RESEARCH)

    expect(ledger.entries[0]).toMatchObject({
      status: 'settled',
      costMicros: 700,
      usage: { inputTokens: 100, outputTokens: 50, cacheWriteTokens: 0, cacheReadTokens: 0, webSearches: 0 },
    })
  })

  it('prices a structured answer with the model of its job: a 150000-token Haiku prompt is at the high tier, 75000 + 250 micros', async () => {
    stubFetch(okWith({ input_tokens: 150_000, output_tokens: 100 }, [textBlock('{"same":true}')]))
    const ledger = newLedger()

    await make({ models: ROUTED_MODELS, ledger }).structured(BODY, { type: 'object' }, { job: 'analysis' })

    expect(ledger.entries[0]).toMatchObject({ status: 'settled', model: 'claude-haiku-5-5', costMicros: 75_250 })
  })

  it('settles every round of a pause_turn on its own usage', async () => {
    const paused: Block[] = [textBlock('Searching.'), searchCall('srvtoolu_1', 'q'), searchResults('srvtoolu_1', ['https://brand.example/serum'])]
    stubFetch(
      okWith({ input_tokens: 1000, output_tokens: 100, server_tool_use: { web_search_requests: 1 } }, paused, 'pause_turn'),
      okWith({ input_tokens: 2000, output_tokens: 300 }, [textBlock('{"done":true}')]),
    )
    const ledger = newLedger()

    await make({ ledger }).createMessage(BODY, RESEARCH)

    // Round 1: 2000 + 1000 + 10000. Round 2: 4000 + 3000.
    expect(ledger.entries.map((e) => [e.status, e.costMicros])).toEqual([
      ['settled', 13_000],
      ['settled', 7_000],
    ])
  })

  it.each([
    ['a refusal', 'refusal', [textBlock('I cannot help with that.')], AnthropicRefusalError],
    ['an answer cut off by max_tokens', 'max_tokens', [textBlock('{"same":')], AnthropicRequestError],
    ['text that is not JSON', 'end_turn', [textBlock('not json')], AnthropicRequestError],
  ] as const)('settles a structured call that ends in %s, because the API billed it', async (_label, stop_reason, content, expectedError) => {
    stubFetch(okWith({ input_tokens: 1000, output_tokens: 500 }, [...content], stop_reason))
    const ledger = newLedger()

    const error = await caught(make({ ledger }).structured(BODY, { type: 'object' }, RESEARCH))

    expect(error).toBeInstanceOf(expectedError)
    expect(ledger.entries.map((e) => [e.status, e.costMicros])).toEqual([['settled', 7_000]])
  })

  it('settles at the reserved worst case when the reply carries no usage (what cannot be measured is counted high)', async () => {
    stubFetch(okWith(null))
    const ledger = newLedger()

    await make({ ledger }).createMessage(BODY, RESEARCH)

    expect(ledger.entries).toHaveLength(1)
    expect(ledger.entries[0]!.status).toBe('settled')
    expect(ledger.entries[0]!.costMicros).toBe(ledger.entries[0]!.estimateMicros)
  })

  it('settles at the reserved worst case, and still reports unavailable, for a 200 that is not a message', async () => {
    stubFetch(() => new Response('<html>Bad gateway</html>', { status: 200 }))
    const ledger = newLedger()

    const error = await caught(make({ ledger }).createMessage(BODY, RESEARCH))

    expect(error).toBeInstanceOf(AnthropicUnavailableError)
    expect(ledger.entries).toHaveLength(1)
    expect(ledger.entries[0]!.status).toBe('settled')
    expect(ledger.entries[0]!.costMicros).toBe(ledger.entries[0]!.estimateMicros)
  })
})

describe('AnthropicClient releasing only when the request was clearly not processed', () => {
  const hangs = () => {
    vi.stubGlobal(
      'fetch',
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )
  }

  // Not processed: any 4xx (429 included) and 529 (overloaded). Nothing was billed, so the reservation is given back.
  it.each([
    [400, 'invalid_request_error'],
    [401, 'authentication_error'],
    [402, 'billing_error'],
    [404, 'not_found_error'],
    [413, 'request_too_large'],
    [429, 'rate_limit_error'],
    [529, 'overloaded_error'],
  ])('releases the reservation on HTTP %s %s, and settles nothing', async (status, type) => {
    stubFetch(() => errorResponse(status, type))
    const ledger = newLedger()

    await caught(make({ ledger }).createMessage(BODY, RESEARCH))

    expect(ledger.entries.map((e) => [e.status, e.costMicros, e.usage])).toEqual([['released', null, null]])
  })

  // Unknown outcome: the API may have done the work, so the call is billed at the reserved worst case (usage zeros).
  it.each([
    [500, 'api_error'],
    [502, 'api_error'],
    [503, 'api_error'],
    [504, 'timeout_error'],
  ])('settles at the reserved estimate on HTTP %s %s, because the API may have done the work', async (status, type) => {
    stubFetch(() => errorResponse(status, type))
    const ledger = newLedger()

    const error = await caught(make({ ledger }).createMessage(BODY, RESEARCH))

    expect(error).toBeInstanceOf(AnthropicUnavailableError)
    expect(ledger.entries).toHaveLength(1)
    expect(ledger.entries[0]).toMatchObject({
      status: 'settled',
      costMicros: ledger.entries[0]!.estimateMicros,
      usage: { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, webSearches: 0 },
    })
  })

  // The whole table, as the outcome for each way a request can end without a usable answer.
  it.each([
    ['HTTP 400', 400, 'released'],
    ['HTTP 429', 429, 'released'],
    ['HTTP 500', 500, 'settled'],
    ['HTTP 504', 504, 'settled'],
    ['HTTP 529', 529, 'released'],
  ])('ends %s as %s', async (_label, status, expected) => {
    stubFetch(() => errorResponse(status, 'some_error'))
    const ledger = newLedger()

    await caught(make({ ledger }).createMessage(BODY, RESEARCH))

    expect(ledger.entries.map((e) => e.status)).toEqual([expected])
  })

  it('settles a structured call that fails with HTTP 500 at the reserved estimate', async () => {
    stubFetch(() => errorResponse(500, 'api_error'))
    const ledger = newLedger()

    await caught(make({ ledger }).structured(BODY, { type: 'object' }, RESEARCH))

    expect(ledger.entries.map((e) => [e.status, e.costMicros === e.estimateMicros])).toEqual([['settled', true]])
  })

  it('settles at the reserved estimate when the network fails (HttpNetworkError)', async () => {
    stubFetch(() => Promise.reject(new TypeError('network down')))
    const ledger = newLedger()

    const error = await caught(make({ ledger }).createMessage(BODY, RESEARCH))

    expect(error).toBeInstanceOf(AnthropicUnavailableError)
    expect(ledger.entries.map((e) => [e.status, e.costMicros === e.estimateMicros])).toEqual([['settled', true]])
  })

  it('settles at the reserved estimate when the request times out (HttpTimeoutError)', async () => {
    hangs()
    const ledger = newLedger()

    const error = await caught(make({ timeoutMs: 10, ledger }).createMessage(BODY, RESEARCH))

    expect(error).toBeInstanceOf(AnthropicUnavailableError)
    expect(ledger.entries.map((e) => [e.status, e.costMicros === e.estimateMicros])).toEqual([['settled', true]])
  })

  it('keeps the first round of a pause_turn billed when the continuation is refused as overloaded (released)', async () => {
    const paused: Block[] = [textBlock('Searching.'), searchCall('srvtoolu_1', 'q'), searchResults('srvtoolu_1', ['https://brand.example/serum'])]
    stubFetch(ok(paused, 'pause_turn'), () => errorResponse(529, 'overloaded_error'))
    const ledger = newLedger()

    const error = await caught(make({ ledger }).createMessage(BODY, RESEARCH))

    expect(error).toBeInstanceOf(AnthropicUnavailableError)
    expect(ledger.entries.map((e) => e.status)).toEqual(['settled', 'released'])
  })

  it('bills both rounds of a pause_turn when the continuation fails with a 500', async () => {
    const paused: Block[] = [textBlock('Searching.'), searchCall('srvtoolu_1', 'q'), searchResults('srvtoolu_1', ['https://brand.example/serum'])]
    stubFetch(ok(paused, 'pause_turn'), () => errorResponse(500, 'api_error'))
    const ledger = newLedger()

    await caught(make({ ledger }).createMessage(BODY, RESEARCH))

    expect(ledger.entries.map((e) => e.status)).toEqual(['settled', 'settled'])
  })
})

describe('AnthropicClient when the ledger fails after the call', () => {
  const DB_DOWN = 'database is down: ledger-secret-detail 4417'
  class SettleFails extends MemoryAiSpendLedger {
    override async settle(): Promise<void> {
      throw new Error(DB_DOWN)
    }
  }
  class ReleaseFails extends MemoryAiSpendLedger {
    override async release(): Promise<void> {
      throw new Error(DB_DOWN)
    }
  }
  const logged = () => vi.spyOn(console, 'error').mockImplementation(() => undefined)

  it('still returns the message when settling fails, and logs only the fixed outcome', async () => {
    stubFetch(ok([textBlock('hello')]))
    const log = logged()

    const message = await make({ ledger: new SettleFails({ capMicros: BIG_CAP_MICROS }) }).createMessage(BODY, RESEARCH)

    expect(message).toMatchObject({ content: [textBlock('hello')] })
    expect(log.mock.calls).toEqual([[{ outcome: 'ai-ledger-failed' }]])
  })

  it('still returns the parsed answer of a structured call when settling fails', async () => {
    stubFetch(ok([textBlock('{"same":true}')]))
    logged()

    const result = await make({ ledger: new SettleFails({ capMicros: BIG_CAP_MICROS }) }).structured(BODY, { type: 'object' }, RESEARCH)

    expect(result).toEqual({ same: true })
  })

  it("keeps the call's own error when settling fails too (a refusal stays a refusal)", async () => {
    stubFetch(ok([textBlock('No.')], 'refusal'))
    logged()

    const error = await caught(make({ ledger: new SettleFails({ capMicros: BIG_CAP_MICROS }) }).structured(BODY, { type: 'object' }, RESEARCH))

    expect(error).toBeInstanceOf(AnthropicRefusalError)
  })

  it('goes on to the next pause_turn round when settling fails', async () => {
    const paused: Block[] = [textBlock('Searching.'), searchCall('srvtoolu_1', 'q')]
    const calls = stubFetch(ok(paused, 'pause_turn'), ok([textBlock('{"done":true}')]))
    logged()

    const message = await make({ ledger: new SettleFails({ capMicros: BIG_CAP_MICROS }) }).createMessage(BODY, RESEARCH)

    expect(calls).toHaveLength(2)
    expect(message.stop_reason).toBe('end_turn')
  })

  it("keeps the call's own error when releasing fails, and logs only the fixed outcome", async () => {
    stubFetch(() => errorResponse(529, 'overloaded_error'))
    const log = logged()

    const error = await caught(make({ ledger: new ReleaseFails({ capMicros: BIG_CAP_MICROS }) }).createMessage(BODY, RESEARCH))

    expect(error).toBeInstanceOf(AnthropicUnavailableError)
    expect(log.mock.calls).toEqual([[{ outcome: 'ai-ledger-failed' }]])
  })
})
