import { firstValueFrom, lastValueFrom, toArray } from 'rxjs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpNetworkError, HttpTimeoutError, HttpTooLargeError, HttpTransportError, requestBytes$, requestHeadBytes$, requestJson$ } from './http'

const URL_ = 'https://vendor.test/send'
const TIMEOUT_MS = 20

afterEach(() => {
  vi.unstubAllGlobals()
})

const stubFetch = (respond: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) => {
  const stub = vi.fn(respond)
  vi.stubGlobal('fetch', stub)
  return stub
}

const caught = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the promise to reject')
}

describe('requestJson$', () => {
  it('emits the parsed JSON body of a 200 once, then completes', async () => {
    stubFetch(async () => Response.json({ id: 'wamid.X' }))

    const emitted = await lastValueFrom(requestJson$(URL_, { timeoutMs: TIMEOUT_MS }).pipe(toArray()))

    expect(emitted).toEqual([{ status: 200, ok: true, body: { id: 'wamid.X' } }])
  })

  it('emits a non-2xx response as a value, not an error', async () => {
    stubFetch(async () => Response.json({ error: { code: 131026 } }, { status: 400 }))

    expect(await firstValueFrom(requestJson$(URL_, { timeoutMs: TIMEOUT_MS }))).toEqual({
      status: 400,
      ok: false,
      body: { error: { code: 131026 } },
    })
  })

  it('returns the raw text when the body is not JSON', async () => {
    stubFetch(async () => new Response('Bad Request', { status: 400 }))

    expect(await firstValueFrom(requestJson$(URL_, { timeoutMs: TIMEOUT_MS }))).toEqual({
      status: 400,
      ok: false,
      body: 'Bad Request',
    })
  })

  it('returns an empty string for an empty body', async () => {
    stubFetch(async () => new Response(null, { status: 202 }))

    expect(await firstValueFrom(requestJson$(URL_, { timeoutMs: TIMEOUT_MS }))).toEqual({
      status: 202,
      ok: true,
      body: '',
    })
  })

  it('passes url, method, headers and body through to fetch', async () => {
    const stub = stubFetch(async () => Response.json({}))

    await firstValueFrom(
      requestJson$(URL_, {
        method: 'POST',
        headers: { Authorization: 'Bearer t', 'Content-Type': 'application/json' },
        body: '{"a":1}',
        timeoutMs: TIMEOUT_MS,
      }),
    )

    expect(stub).toHaveBeenCalledTimes(1)
    const [url, init] = stub.mock.calls[0]!
    expect(String(url)).toBe(URL_)
    expect(init!.method).toBe('POST')
    const headers = new Headers(init!.headers)
    expect(headers.get('Authorization')).toBe('Bearer t')
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(init!.body).toBe('{"a":1}')
  })

  it('does nothing until subscribed', async () => {
    const stub = stubFetch(async () => Response.json({}))

    const request$ = requestJson$(URL_, { timeoutMs: TIMEOUT_MS })
    expect(stub).not.toHaveBeenCalled()

    await firstValueFrom(request$)
    expect(stub).toHaveBeenCalledTimes(1)
  })

  it('errors with HttpNetworkError when fetch rejects, without retrying', async () => {
    const stub = stubFetch(async () => {
      throw new TypeError('network down')
    })

    const error = await caught(firstValueFrom(requestJson$(URL_, { timeoutMs: TIMEOUT_MS })))

    expect(error).toBeInstanceOf(HttpNetworkError)
    expect(error).toBeInstanceOf(HttpTransportError)
    expect(stub).toHaveBeenCalledTimes(1)
  })

  it('errors with HttpTimeoutError and aborts the request when no response arrives in time, without retrying', async () => {
    let signal: AbortSignal | null | undefined
    const stub = stubFetch(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init?.signal
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )

    const error = await caught(firstValueFrom(requestJson$(URL_, { timeoutMs: TIMEOUT_MS })))

    expect(error).toBeInstanceOf(HttpTimeoutError)
    expect(error).toBeInstanceOf(HttpTransportError)
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal!.aborted).toBe(true)
    expect(stub).toHaveBeenCalledTimes(1)
  })
})

describe('requestBytes$', () => {
  const MAX_BYTES = 8

  const request = (overrides: Partial<{ maxBytes: number; timeoutMs: number; headers: Record<string, string> }> = {}) =>
    requestBytes$(URL_, { timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES, ...overrides })

  /** A body that records whether anyone started reading it. highWaterMark 0 stops the runtime pre-reading. */
  const watchedBody = (chunks: Uint8Array[]) => {
    const pulled = vi.fn()
    const queue = [...chunks]
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled()
          const next = queue.shift()
          if (next) controller.enqueue(next)
          else controller.close()
        },
      },
      { highWaterMark: 0 },
    )
    return { body, pulled }
  }

  it('emits the status, content type and exact body bytes once, then completes', async () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255])
    stubFetch(async () => new Response(bytes, { headers: { 'content-type': 'image/png' } }))

    const emitted = await lastValueFrom(request().pipe(toArray()))

    expect(emitted).toHaveLength(1)
    expect(emitted[0]).toMatchObject({ status: 200, ok: true, contentType: 'image/png', location: null })
    expect(emitted[0]!.bytes).toBeInstanceOf(Uint8Array)
    expect(Array.from(emitted[0]!.bytes)).toEqual([0, 1, 2, 250, 255])
  })

  it('reports a missing content-type as null', async () => {
    stubFetch(async () => new Response(new Uint8Array([1]), { headers: {} }))

    const result = await firstValueFrom(request())

    expect(result.contentType).toBeNull()
  })

  it('emits a redirect as a value with its location, and asks fetch not to follow it', async () => {
    const stub = stubFetch(async () => new Response(null, { status: 302, headers: { location: 'https://cdn.test/final.png' } }))

    const result = await firstValueFrom(request())

    expect(result).toMatchObject({ status: 302, ok: false, location: 'https://cdn.test/final.png' })
    expect(result.bytes.byteLength).toBe(0)
    expect(stub).toHaveBeenCalledTimes(1)
    expect(stub.mock.calls[0]![1]!.redirect).toBe('manual')
  })

  it('emits a non-2xx response as a value, not an error', async () => {
    stubFetch(async () => new Response('gone', { status: 404 }))

    expect(await firstValueFrom(request())).toMatchObject({ status: 404, ok: false })
  })

  it('passes the url and headers through to fetch', async () => {
    const stub = stubFetch(async () => new Response(new Uint8Array([1])))

    await firstValueFrom(request({ headers: { Accept: 'image/*' } }))

    const [url, init] = stub.mock.calls[0]!
    expect(String(url)).toBe(URL_)
    expect(new Headers(init!.headers).get('Accept')).toBe('image/*')
  })

  it('does nothing until subscribed', async () => {
    const stub = stubFetch(async () => new Response(new Uint8Array([1])))

    const request$ = request()
    expect(stub).not.toHaveBeenCalled()

    await firstValueFrom(request$)
    expect(stub).toHaveBeenCalledTimes(1)
  })

  it('errors with HttpNetworkError when fetch rejects, without retrying', async () => {
    const stub = stubFetch(async () => {
      throw new TypeError('network down')
    })

    const error = await caught(firstValueFrom(request()))

    expect(error).toBeInstanceOf(HttpNetworkError)
    expect(stub).toHaveBeenCalledTimes(1)
  })

  it('errors with HttpTimeoutError and aborts the request when no response arrives in time', async () => {
    let signal: AbortSignal | null | undefined
    stubFetch(
      (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          signal = init?.signal
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )

    const error = await caught(firstValueFrom(request()))

    expect(error).toBeInstanceOf(HttpTimeoutError)
    expect(signal!.aborted).toBe(true)
  })

  it('accepts a body of exactly maxBytes, declared by content-length', async () => {
    stubFetch(async () => new Response(new Uint8Array(MAX_BYTES), { headers: { 'content-length': String(MAX_BYTES) } }))

    expect((await firstValueFrom(request())).bytes.byteLength).toBe(MAX_BYTES)
  })

  it('errors with HttpTooLargeError when content-length is one byte over maxBytes, without reading the body', async () => {
    const { body, pulled } = watchedBody([new Uint8Array(MAX_BYTES + 1)])
    stubFetch(async () => new Response(body, { headers: { 'content-length': String(MAX_BYTES + 1) } }))

    const error = await caught(firstValueFrom(request()))

    expect(error).toBeInstanceOf(HttpTooLargeError)
    expect(pulled).not.toHaveBeenCalled()
  })

  it('accepts a body of exactly maxBytes that declares no content-length', async () => {
    const { body } = watchedBody([new Uint8Array(MAX_BYTES / 2), new Uint8Array(MAX_BYTES / 2)])
    stubFetch(async () => new Response(body))

    expect((await firstValueFrom(request())).bytes.byteLength).toBe(MAX_BYTES)
  })

  it('errors with HttpTooLargeError when a body without content-length is one byte over maxBytes', async () => {
    const { body } = watchedBody([new Uint8Array(MAX_BYTES), new Uint8Array(1)])
    stubFetch(async () => new Response(body))

    expect(await caught(firstValueFrom(request()))).toBeInstanceOf(HttpTooLargeError)
  })

  it('stops reading an endless body at maxBytes instead of buffering it', async () => {
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(4))
      },
    })
    stubFetch(async () => new Response(endless))

    expect(await caught(firstValueFrom(request()))).toBeInstanceOf(HttpTooLargeError)
  })

  it('cancels the body reader when it stops reading an endless body', async () => {
    const cancel = vi.fn()
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(4))
      },
      cancel,
    })
    stubFetch(async () => new Response(endless))

    await caught(firstValueFrom(request()))

    expect(cancel).toHaveBeenCalledTimes(1)
  })

  it('errors with HttpTimeoutError when a body drips slowly past timeoutMs, though each chunk is quick', async () => {
    let sent = 0
    const dripping = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, TIMEOUT_MS / 2))
        if (sent++ < 6) controller.enqueue(new Uint8Array(1))
        else controller.close()
      },
    })
    stubFetch(async () => new Response(dripping))

    expect(await caught(firstValueFrom(request()))).toBeInstanceOf(HttpTimeoutError)
  })

  it('makes HttpTooLargeError its own error, not a transport error', async () => {
    stubFetch(async () => new Response(new Uint8Array(MAX_BYTES + 1), { headers: { 'content-length': String(MAX_BYTES + 1) } }))

    const error = await caught(firstValueFrom(request()))

    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(HttpTransportError)
  })
})

describe('requestHeadBytes$', () => {
  const MAX_BYTES = 8
  const request = () => requestHeadBytes$(URL_, { timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES })

  it('cuts a body bigger than maxBytes at the cap instead of failing', async () => {
    stubFetch(async () => new Response(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]), { headers: { 'content-length': '12' } }))

    const result = await firstValueFrom(request())

    expect(Array.from(result.bytes)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('returns a body under the cap whole', async () => {
    stubFetch(async () => new Response(new Uint8Array([1, 2, 3])))

    expect(Array.from((await firstValueFrom(request())).bytes)).toEqual([1, 2, 3])
  })

  it('stops pulling an endless body once the cap is reached', async () => {
    let pulled = 0
    const body = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          pulled += 4
          controller.enqueue(new Uint8Array(4))
        },
      },
      { highWaterMark: 0 },
    )
    stubFetch(async () => new Response(body))

    const result = await firstValueFrom(request())

    expect(result.bytes.byteLength).toBe(MAX_BYTES)
    expect(pulled).toBeLessThanOrEqual(MAX_BYTES + 4)
  })

  it('does not follow a redirect and emits its location', async () => {
    const stub = stubFetch(async () => new Response(null, { status: 302, headers: { location: 'https://cdn.test/x' } }))

    const result = await firstValueFrom(request())

    expect(result).toMatchObject({ status: 302, location: 'https://cdn.test/x' })
    expect(stub.mock.calls[0]![1]).toMatchObject({ redirect: 'manual' })
  })
})
