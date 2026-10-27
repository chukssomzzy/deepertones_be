import { afterEach, describe, expect, it, vi } from 'vitest'
import { ExpoPushSender } from './expo.push'
import { PushUnavailableError, type PushMessage } from './push.provider'

const SEND_URL = 'https://exp.host/--/api/v2/push/send'
const RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts'
const ACCESS_TOKEN = 'expo-super-secret-access-token'
const PUSH_TOKEN = 'ExponentPushToken[private-device-482913]'
const TITLE = 'Private title 482913'
const BODY = 'Private body 482913'

const MESSAGE: PushMessage = {
  to: PUSH_TOKEN,
  title: TITLE,
  body: BODY,
  data: { url: '/scans/s1', kind: 'scan-finished', scanId: 's1' },
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

type Call = { url: string; init: RequestInit; body: unknown }

const config = { accessToken: ACCESS_TOKEN }

const make = (respond: (call: Call) => Response | Promise<Response>, overrides: Partial<typeof config> = {}) => {
  const calls: Call[] = []
  const stub = async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
    const call = { url: String(input), init: init ?? {}, body }
    calls.push(call)
    return respond(call)
  }
  vi.stubGlobal('fetch', stub)
  const sender = new ExpoPushSender({ ...config, ...overrides })
  return { sender, calls }
}

const caught = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the promise to reject')
}

const messages = (count: number): PushMessage[] =>
  Array.from({ length: count }, (_, i) => ({ ...MESSAGE, to: `ExponentPushToken[t${i}]` }))

/** Answers each message of a send request with an ok ticket whose id names its token. */
const echoTickets = ({ body }: Call) =>
  json({ data: (body as { to: string }[]).map(({ to }) => ({ status: 'ok', id: `id-${to}` })) })

const expoError = (error?: string) => ({
  status: 'error',
  message: `Private Expo text mentioning ${PUSH_TOKEN}`,
  ...(error ? { details: { error } } : {}),
})

const FAILURE_MAPPING = [
  ['DeviceNotRegistered', 'device-not-registered'],
  ['MessageRateExceeded', 'rate-limited'],
  ['MismatchSenderId', 'misconfigured'],
  ['InvalidCredentials', 'misconfigured'],
  ['MessageTooBig', 'other'],
  ['SomethingNewExpoInvented', 'other'],
] as const

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('ExpoPushSender', () => {
  it('keeps the access token out of the sender when it is serialised or spread', () => {
    const { sender } = make(() => json({ data: [] }))

    expect(JSON.stringify(sender)).not.toContain(ACCESS_TOKEN)
    expect(JSON.stringify({ ...sender })).not.toContain(ACCESS_TOKEN)
  })
})

describe('ExpoPushSender.send', () => {
  it('posts the messages to the Expo send endpoint with the expected headers and an array body', async () => {
    const { sender, calls } = make(echoTickets)

    await sender.send([MESSAGE])

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.url).toBe(SEND_URL)
    expect(call.init.method).toBe('POST')
    const headers = new Headers(call.init.headers)
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('Accept')).toBe('application/json')
    expect(headers.get('Authorization')).toBe(`Bearer ${ACCESS_TOKEN}`)
    expect(call.body).toEqual([
      { to: PUSH_TOKEN, title: TITLE, body: BODY, data: MESSAGE.data, sound: 'default' },
    ])
  })

  it('passes the message\'s categoryId to Expo as categoryId, which is how the phone knows to show the category\'s actions (the reminder\'s "Done")', async () => {
    const { sender, calls } = make(echoTickets)

    await sender.send([{ ...MESSAGE, categoryId: 'routine-reminder' }])

    expect(calls[0]!.body).toEqual([
      { to: PUSH_TOKEN, title: TITLE, body: BODY, data: MESSAGE.data, sound: 'default', categoryId: 'routine-reminder' },
    ])
  })

  it('returns an ok ticket carrying the id Expo assigned', async () => {
    const { sender } = make(() => json({ data: [{ status: 'ok', id: 'abc' }] }))

    await expect(sender.send([MESSAGE])).resolves.toEqual([{ status: 'ok', id: 'abc' }])
  })

  it('sends 100 messages in one request', async () => {
    const { sender, calls } = make(echoTickets)

    const tickets = await sender.send(messages(100))

    expect(calls).toHaveLength(1)
    expect(calls[0]!.body).toHaveLength(100)
    expect(tickets).toHaveLength(100)
  })

  it('splits 101 messages into a request of 100 and a request of 1', async () => {
    const { sender, calls } = make(echoTickets)

    await sender.send(messages(101))

    expect(calls.map((c) => (c.body as unknown[]).length)).toEqual([100, 1])
  })

  it('splits 150 messages into 100 then 50 and returns the tickets in message order', async () => {
    const input = messages(150)
    const { sender, calls } = make(echoTickets)

    const tickets = await sender.send(input)

    expect(calls.map((c) => c.url)).toEqual([SEND_URL, SEND_URL])
    expect(calls.map((c) => (c.body as unknown[]).length)).toEqual([100, 50])
    expect((calls[0]!.body as { to: string }[])[0]!.to).toBe('ExponentPushToken[t0]')
    expect((calls[1]!.body as { to: string }[])[0]!.to).toBe('ExponentPushToken[t100]')
    expect(tickets).toEqual(input.map((m) => ({ status: 'ok', id: `id-${m.to}` })))
  })

  it.each(FAILURE_MAPPING)('maps the Expo ticket error %s to %s', async (expoCode, reason) => {
    const { sender } = make(() => json({ data: [expoError(expoCode)] }))

    await expect(sender.send([MESSAGE])).resolves.toEqual([{ status: 'error', reason }])
  })

  it('maps a ticket error with no details to other', async () => {
    const { sender } = make(() => json({ data: [expoError()] }))

    await expect(sender.send([MESSAGE])).resolves.toEqual([{ status: 'error', reason: 'other' }])
  })

  it('keeps one ticket per message when ok and failed tickets are mixed', async () => {
    const { sender } = make(() =>
      json({ data: [{ status: 'ok', id: 'a' }, expoError('DeviceNotRegistered'), { status: 'ok', id: 'c' }] }),
    )

    await expect(sender.send(messages(3))).resolves.toEqual([
      { status: 'ok', id: 'a' },
      { status: 'error', reason: 'device-not-registered' },
      { status: 'ok', id: 'c' },
    ])
  })

  it('rejects when the first request fails, and sends nothing further', async () => {
    const { sender, calls } = make(() => new Response('oops', { status: 500 }))

    const error = await caught(sender.send(messages(150)))

    expect(error).toBeInstanceOf(PushUnavailableError)
    expect(calls).toHaveLength(1)
  })

  it('rejects with a plain Error when the first request is refused as a configuration error', async () => {
    const { sender, calls } = make(() => json({ errors: [{ code: 'UNAUTHORIZED', message: 'x' }] }, 401))

    const error = await caught(sender.send(messages(150)))

    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(PushUnavailableError)
    expect(calls).toHaveLength(1)
  })

  it.each([
    ['HTTP 429', () => new Response('slow down', { status: 429 })],
    ['HTTP 500', () => new Response('oops', { status: 500 })],
    ['HTTP 503', () => new Response('oops', { status: 503 })],
    ['a network failure', () => Promise.reject(new TypeError('network down'))],
  ])('resolves when a later batch fails on %s: earlier tickets are kept and the failed batch is marked unavailable', async (_label, fail) => {
    const input = messages(150)
    const { sender } = make((call) => (call.body as unknown[]).length === 100 ? echoTickets(call) : fail())

    const tickets = await sender.send(input)

    expect(tickets).toHaveLength(150)
    expect(tickets.slice(0, 100)).toEqual(input.slice(0, 100).map((m) => ({ status: 'ok', id: `id-${m.to}` })))
    expect(tickets.slice(100)).toEqual(Array.from({ length: 50 }, () => ({ status: 'error', reason: 'unavailable' })))
  })

  it('resolves when a later batch times out, marking its messages unavailable', async () => {
    let requests = 0
    const stub = (_input: RequestInfo | URL, init?: RequestInit) => {
      requests += 1
      if (requests === 1) return Promise.resolve(echoTickets({ url: SEND_URL, init: init ?? {}, body: JSON.parse(init!.body as string) }))
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    }
    vi.stubGlobal('fetch', stub)
    const sender = new ExpoPushSender({ ...config, timeoutMs: 10 })

    const tickets = await sender.send(messages(150))

    expect(tickets.slice(0, 100).every((t) => t.status === 'ok')).toBe(true)
    expect(tickets.slice(100)).toEqual(Array.from({ length: 50 }, () => ({ status: 'error', reason: 'unavailable' })))
  })

  it('resolves when a later batch is refused as a configuration error, marking its messages misconfigured', async () => {
    const input = messages(150)
    const { sender } = make((call) =>
      (call.body as unknown[]).length === 100 ? echoTickets(call) : json({ errors: [{ code: 'UNAUTHORIZED', message: 'x' }] }, 401),
    )

    const tickets = await sender.send(input)

    expect(tickets.slice(0, 100)).toEqual(input.slice(0, 100).map((m) => ({ status: 'ok', id: `id-${m.to}` })))
    expect(tickets.slice(100)).toEqual(Array.from({ length: 50 }, () => ({ status: 'error', reason: 'misconfigured' })))
  })

  it.each([
    ['data is not an array', () => json({ data: { status: 'ok', id: 'a' } })],
    ['there is no data', () => json({})],
    ['the ticket count does not match the messages', () => json({ data: [{ status: 'ok', id: 'a' }] })],
    ['a ticket has an unknown status', () => json({ data: [{ status: 'weird' }, { status: 'ok', id: 'b' }] })],
    ['an ok ticket has no id', () => json({ data: [{ status: 'ok' }, { status: 'ok', id: 'b' }] })],
    ['the body is HTML', () => new Response('<html>gateway</html>', { status: 200 })],
    ['the body is empty', () => new Response('', { status: 200 })],
  ])('resolves with other for every message of the batch when a 2xx reply is malformed: %s', async (_label, respond) => {
    const { sender } = make(respond)

    await expect(sender.send(messages(2))).resolves.toEqual([
      { status: 'error', reason: 'other' },
      { status: 'error', reason: 'other' },
    ])
  })

  it('marks only the batch whose 2xx reply is malformed as other, keeping the tickets of the others', async () => {
    const input = messages(150)
    const { sender } = make((call) => (call.body as unknown[]).length === 100 ? echoTickets(call) : json({ data: 'nope' }))

    const tickets = await sender.send(input)

    expect(tickets.slice(0, 100)).toEqual(input.slice(0, 100).map((m) => ({ status: 'ok', id: `id-${m.to}` })))
    expect(tickets.slice(100)).toEqual(Array.from({ length: 50 }, () => ({ status: 'error', reason: 'other' })))
  })

  it('makes no request and returns no tickets for an empty batch', async () => {
    const { sender, calls } = make(echoTickets)

    await expect(sender.send([])).resolves.toEqual([])
    expect(calls).toEqual([])
  })

  it.each([
    ['HTTP 429', () => new Response('slow down', { status: 429 })],
    ['HTTP 500', () => new Response('oops', { status: 500 })],
    ['HTTP 503', () => new Response('oops', { status: 503 })],
  ])('throws PushUnavailableError on %s', async (_label, respond) => {
    const { sender } = make(respond)

    const error = await caught(sender.send([MESSAGE]))

    expect(error).toBeInstanceOf(PushUnavailableError)
    expect((error as Error).name).toBe('PushUnavailableError')
  })

  it('throws PushUnavailableError when the network request fails', async () => {
    const { sender } = make(() => Promise.reject(new TypeError('network down')))

    expect(await caught(sender.send([MESSAGE]))).toBeInstanceOf(PushUnavailableError)
  })

  it('throws PushUnavailableError instead of hanging when Expo never answers', async () => {
    let signal: AbortSignal | null | undefined
    const hanging = (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        signal = init?.signal
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    vi.stubGlobal('fetch', hanging)
    const sender = new ExpoPushSender({ ...config, timeoutMs: 10 })

    const error = await caught(sender.send([MESSAGE]))

    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal!.aborted).toBe(true)
    expect(error).toBeInstanceOf(PushUnavailableError)
  })

  it.each([
    [401, { errors: [{ code: 'UNAUTHORIZED', message: `Bad token ${ACCESS_TOKEN}` }] }],
    [403, { errors: [{ code: 'FORBIDDEN', message: 'Nope' }] }],
    [400, { errors: [{ code: 'PUSH_TOO_MANY_EXPERIENCE_IDS', message: `Mixed ${PUSH_TOKEN} ${TITLE} ${BODY}` }] }],
  ])('throws a plain Error with the HTTP status and Expo code on HTTP %i, never leaking secrets or content', async (status, body) => {
    const { sender } = make(() => json(body, status))

    const error = await caught(sender.send([MESSAGE]))

    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(PushUnavailableError)
    const message = (error as Error).message
    expect(message).toContain(String(status))
    expect(message).toContain(body.errors[0]!.code)
    expect(message).not.toContain(ACCESS_TOKEN)
    expect(message).not.toContain(PUSH_TOKEN)
    expect(message).not.toContain(TITLE)
    expect(message).not.toContain(BODY)
  })

  it('throws a plain Error naming the status for a rejection with no Expo codes', async () => {
    const { sender } = make(() => new Response('forbidden', { status: 403 }))

    const error = await caught(sender.send([MESSAGE]))

    expect(error).not.toBeInstanceOf(PushUnavailableError)
    expect((error as Error).message).toContain('403')
  })

  it('drops Expo codes that are not code-shaped, so free text never reaches the message', async () => {
    const { sender } = make(() =>
      json({ errors: [{ code: PUSH_TOKEN, message: 'x' }, { code: 'lower case words', message: 'y' }] }, 400),
    )

    const error = await caught(sender.send([MESSAGE]))

    expect(error).not.toBeInstanceOf(PushUnavailableError)
    expect((error as Error).message).toContain('400')
    expect((error as Error).message).not.toContain(PUSH_TOKEN)
    expect((error as Error).message).not.toContain('lower case words')
  })

  it.each([
    ['empty', ''],
    ['padded with a trailing newline', `${ACCESS_TOKEN}\n`],
    ['padded with a leading space', ` ${ACCESS_TOKEN}`],
    ['split by a space', 'expo token'],
    ['split by a tab', 'expo\ttoken'],
  ])('throws a plain Error naming EXPO_ACCESS_TOKEN, without calling Expo, when the access token is %s', async (_label, accessToken) => {
    const { sender, calls } = make(echoTickets, { accessToken })

    const error = await caught(sender.send([MESSAGE]))

    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(PushUnavailableError)
    expect((error as Error).message).toContain('EXPO_ACCESS_TOKEN')
    expect((error as Error).message).not.toContain(ACCESS_TOKEN)
    expect(calls).toEqual([])
  })
})

describe('ExpoPushSender.receipts', () => {
  it('posts the ids to the Expo getReceipts endpoint with the expected headers', async () => {
    const { sender, calls } = make(() => json({ data: {} }))

    await sender.receipts(['id-1', 'id-2'])

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.url).toBe(RECEIPTS_URL)
    expect(call.init.method).toBe('POST')
    const headers = new Headers(call.init.headers)
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('Accept')).toBe('application/json')
    expect(headers.get('Authorization')).toBe(`Bearer ${ACCESS_TOKEN}`)
    expect(call.body).toEqual({ ids: ['id-1', 'id-2'] })
  })

  it('returns ok receipts keyed by ticket id', async () => {
    const { sender } = make(() => json({ data: { 'id-1': { status: 'ok' }, 'id-2': { status: 'ok' } } }))

    await expect(sender.receipts(['id-1', 'id-2'])).resolves.toEqual({
      'id-1': { status: 'ok' },
      'id-2': { status: 'ok' },
    })
  })

  it.each(FAILURE_MAPPING)('maps the Expo receipt error %s to %s', async (expoCode, reason) => {
    const { sender } = make(() => json({ data: { 'id-1': expoError(expoCode) } }))

    await expect(sender.receipts(['id-1'])).resolves.toEqual({ 'id-1': { status: 'error', reason } })
  })

  it('maps a receipt error with no details to other', async () => {
    const { sender } = make(() => json({ data: { 'id-1': expoError() } }))

    await expect(sender.receipts(['id-1'])).resolves.toEqual({ 'id-1': { status: 'error', reason: 'other' } })
  })

  it('leaves out ids Expo does not know yet', async () => {
    const { sender } = make(() => json({ data: { 'id-1': { status: 'ok' } } }))

    const receipts = await sender.receipts(['id-1', 'id-not-ready'])

    expect(Object.keys(receipts)).toEqual(['id-1'])
  })

  it('splits 1000 ids into one request and 1001 ids into 1000 then 1, merging the receipts', async () => {
    const answer = ({ body }: Call) =>
      json({ data: Object.fromEntries((body as { ids: string[] }).ids.map((id) => [id, { status: 'ok' }])) })
    const ids = Array.from({ length: 1001 }, (_, i) => `id-${i}`)

    const exact = make(answer)
    await exact.sender.receipts(ids.slice(0, 1000))
    expect(exact.calls).toHaveLength(1)

    const over = make(answer)
    const receipts = await over.sender.receipts(ids)
    expect(over.calls.map((c) => (c.body as { ids: string[] }).ids.length)).toEqual([1000, 1])
    expect((over.calls[1]!.body as { ids: string[] }).ids).toEqual(['id-1000'])
    expect(Object.keys(receipts)).toHaveLength(1001)
    expect(receipts['id-1000']).toEqual({ status: 'ok' })
  })

  const answerReceipts = ({ body }: Call) =>
    json({ data: Object.fromEntries((body as { ids: string[] }).ids.map((id) => [id, { status: 'ok' }])) })
  const manyIds = Array.from({ length: 1001 }, (_, i) => `id-${i}`)

  it('rejects when the first request fails, and sends nothing further', async () => {
    const { sender, calls } = make(() => new Response('oops', { status: 500 }))

    const error = await caught(sender.receipts(manyIds))

    expect(error).toBeInstanceOf(PushUnavailableError)
    expect(calls).toHaveLength(1)
  })

  it.each([
    ['HTTP 429', () => new Response('slow down', { status: 429 })],
    ['HTTP 503', () => new Response('oops', { status: 503 })],
    ['a network failure', () => Promise.reject(new TypeError('network down'))],
    ['HTTP 401', () => json({ errors: [{ code: 'UNAUTHORIZED', message: 'x' }] }, 401)],
  ])('resolves when a later request fails on %s, leaving its ids absent', async (_label, fail) => {
    const { sender } = make((call) => ((call.body as { ids: string[] }).ids.length === 1000 ? answerReceipts(call) : fail()))

    const receipts = await sender.receipts(manyIds)

    expect(Object.keys(receipts)).toHaveLength(1000)
    expect(receipts['id-999']).toEqual({ status: 'ok' })
    expect('id-1000' in receipts).toBe(false)
  })

  it.each([
    ['data is not an object', () => json({ data: 'nope' })],
    ['data is an array', () => json({ data: [{ status: 'ok' }] })],
    ['there is no data', () => json({})],
    ['the body is HTML', () => new Response('<html>gateway</html>', { status: 200 })],
  ])('resolves with no receipts when a 2xx reply is malformed: %s', async (_label, respond) => {
    const { sender } = make(respond)

    await expect(sender.receipts(['id-1', 'id-2'])).resolves.toEqual({})
  })

  it('leaves out a single malformed receipt entry and keeps the good ones', async () => {
    const { sender } = make(() =>
      json({ data: { 'id-1': { status: 'ok' }, 'id-2': { status: 'weird' }, 'id-3': 'nope', 'id-4': expoError('DeviceNotRegistered') } }),
    )

    await expect(sender.receipts(['id-1', 'id-2', 'id-3', 'id-4'])).resolves.toEqual({
      'id-1': { status: 'ok' },
      'id-4': { status: 'error', reason: 'device-not-registered' },
    })
  })

  it('makes no request and returns no receipts for no ids', async () => {
    const { sender, calls } = make(() => json({ data: {} }))

    await expect(sender.receipts([])).resolves.toEqual({})
    expect(calls).toEqual([])
  })

  it.each([
    ['HTTP 429', () => new Response('slow down', { status: 429 })],
    ['HTTP 500', () => new Response('oops', { status: 500 })],
    ['HTTP 503', () => new Response('oops', { status: 503 })],
    ['a network failure', () => Promise.reject(new TypeError('network down'))],
  ])('throws PushUnavailableError on %s', async (_label, respond) => {
    const { sender } = make(respond)

    expect(await caught(sender.receipts(['id-1']))).toBeInstanceOf(PushUnavailableError)
  })

  it('throws PushUnavailableError instead of hanging when Expo never answers', async () => {
    const hanging = (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    vi.stubGlobal('fetch', hanging)
    const sender = new ExpoPushSender({ ...config, timeoutMs: 10 })

    expect(await caught(sender.receipts(['id-1']))).toBeInstanceOf(PushUnavailableError)
  })

  it.each([401, 403, 400])('throws a plain Error with the HTTP status and Expo code on HTTP %i, never leaking the access token', async (status) => {
    const { sender } = make(() =>
      json({ errors: [{ code: 'PUSH_BAD_THING', message: `Echoed ${ACCESS_TOKEN} ${PUSH_TOKEN}` }] }, status),
    )

    const error = await caught(sender.receipts(['id-1']))

    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(PushUnavailableError)
    const message = (error as Error).message
    expect(message).toContain(String(status))
    expect(message).toContain('PUSH_BAD_THING')
    expect(message).not.toContain(ACCESS_TOKEN)
    expect(message).not.toContain(PUSH_TOKEN)
  })

  it.each([
    ['empty', ''],
    ['padded with a trailing newline', `${ACCESS_TOKEN}\n`],
    ['split by a space', 'expo token'],
  ])('throws a plain Error naming EXPO_ACCESS_TOKEN, without calling Expo, when the access token is %s', async (_label, accessToken) => {
    const { sender, calls } = make(() => json({ data: {} }), { accessToken })

    const error = await caught(sender.receipts(['id-1']))

    expect(error).not.toBeInstanceOf(PushUnavailableError)
    expect((error as Error).message).toContain('EXPO_ACCESS_TOKEN')
    expect((error as Error).message).not.toContain(ACCESS_TOKEN)
    expect(calls).toEqual([])
  })
})
