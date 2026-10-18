import { catchError, type Observable, throwError, timeout, TimeoutError } from 'rxjs'
import { fromFetch } from 'rxjs/fetch'

/**
 * The one HTTP client for vendor adapters (src/providers, plus build scripts under scripts/; lint:arch only checks src, so the scripts side is by convention).
 * `requestJson$` is for JSON APIs and `requestBytes$` for binary downloads. Both return an
 * Observable so an adapter can compose operators over it. Adapters convert at their own boundary
 * with `firstValueFrom`, so services stay Promise-based and never see rxjs.
 *
 * No retries, on purpose: a retried OTP send could deliver, and bill, a second code. Whether and
 * how to retry is each caller's decision.
 */

export type HttpResponse = {
  status: number
  ok: boolean
  /** Parsed JSON when the body is JSON, the raw text when it is not, '' when empty. */
  body: unknown
}

/** The request produced no response at all. A response with any status is a value, not this. */
export class HttpTransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = new.target.name
  }
}
/** The connection failed before a response arrived. */
export class HttpNetworkError extends HttpTransportError {}
/** No response arrived within `timeoutMs`; the request was aborted. */
export class HttpTimeoutError extends HttpTransportError {}

export type HttpBytesResponse = {
  status: number
  ok: boolean
  contentType: string | null
  /** The Location header, for a redirect the caller decides whether to follow. */
  location: string | null
  bytes: Uint8Array
}

/** The body is bigger than the caller allows. Not a transport failure: the server did answer. */
export class HttpTooLargeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = new.target.name
  }
}

const transportErrors =
  (timeoutMs: number) =>
  <T>(source: Observable<T>): Observable<T> =>
    source.pipe(
      catchError((error: unknown) =>
        throwError(() =>
          error instanceof HttpTooLargeError
            ? error
            : error instanceof TimeoutError
              ? new HttpTimeoutError(`No response within ${timeoutMs}ms`, { cause: error })
              : new HttpNetworkError('Request failed before a response', { cause: error }),
        ),
      ),
    )

/**
 * Cold: nothing is sent until subscribed, and unsubscribing aborts the request. Emits once, for any
 * status. Errors only with HttpTransportError subclasses.
 */
export const requestJson$ = (url: string, init: RequestInit & { timeoutMs: number }): Observable<HttpResponse> => {
  const { timeoutMs, ...fetchInit } = init
  return fromFetch<HttpResponse>(url, {
    ...fetchInit,
    // Read inside the selector: fromFetch aborts its controller once the response is emitted and
    // the stream completes, which would cut off a body still being read downstream.
    selector: async (response) => {
      const text = await response.text()
      let body: unknown = text
      if (text) {
        try {
          body = JSON.parse(text)
        } catch {
          // not JSON: keep the text
        }
      }
      return { status: response.status, ok: response.ok, body }
    },
  }).pipe(
    timeout({ first: timeoutMs }),
    transportErrors(timeoutMs),
  )
}

/**
 * Like `requestJson$`, for binary bodies from servers we do not trust. Redirects are never followed
 * (`redirect: 'manual'`): a 3xx is emitted with its `location` so the caller can vet the next hop.
 * The body is capped at `maxBytes`: a larger `content-length` fails before any byte is read, and
 * otherwise the body is streamed and abandoned the moment the cap is passed, so a server that never
 * stops sending cannot fill memory. Errors with HttpTooLargeError or HttpTransportError subclasses.
 * `timeoutMs` covers the response and the whole body.
 */
export const requestBytes$ = (url: string, init: RequestInit & { timeoutMs: number; maxBytes: number }): Observable<HttpBytesResponse> => {
  const { timeoutMs, maxBytes, ...fetchInit } = init
  return fromFetch<HttpBytesResponse>(url, {
    ...fetchInit,
    redirect: 'manual',
    selector: async (response) => ({
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get('content-type'),
      location: response.headers.get('location'),
      bytes: await readCapped(response, maxBytes, false),
    }),
  }).pipe(timeout({ first: timeoutMs }), transportErrors(timeoutMs))
}

/**
 * Like `requestBytes$`, for when only the start of a body matters (the head of a web page). A body
 * past `maxBytes` is cut there and the stream cancelled, not an error.
 */
export const requestHeadBytes$ = (url: string, init: RequestInit & { timeoutMs: number; maxBytes: number }): Observable<HttpBytesResponse> => {
  const { timeoutMs, maxBytes, ...fetchInit } = init
  return fromFetch<HttpBytesResponse>(url, {
    ...fetchInit,
    redirect: 'manual',
    selector: async (response) => ({
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get('content-type'),
      location: response.headers.get('location'),
      bytes: await readCapped(response, maxBytes, true),
    }),
  }).pipe(timeout({ first: timeoutMs }), transportErrors(timeoutMs))
}

const readCapped = async (response: Response, maxBytes: number, truncate: boolean): Promise<Uint8Array> => {
  const declared = Number(response.headers.get('content-length'))
  if (!truncate && declared > maxBytes) {
    await response.body?.cancel()
    throw new HttpTooLargeError(`Body is ${declared} bytes, over the ${maxBytes} byte limit`)
  }
  if (!response.body) return new Uint8Array(0)

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (total + value.byteLength > maxBytes) {
      await reader.cancel()
      if (!truncate) throw new HttpTooLargeError(`Body is over the ${maxBytes} byte limit`)
      chunks.push(value.subarray(0, maxBytes - total))
      total = maxBytes
      break
    }
    total += value.byteLength
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
