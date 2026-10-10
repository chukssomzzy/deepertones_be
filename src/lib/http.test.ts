import { firstValueFrom, lastValueFrom, toArray } from 'rxjs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpNetworkError, HttpTimeoutError, HttpTransportError, requestJson$ } from './http'

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
