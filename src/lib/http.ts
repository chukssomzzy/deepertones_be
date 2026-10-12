import { catchError, type Observable, throwError, timeout, TimeoutError } from 'rxjs'
import { fromFetch } from 'rxjs/fetch'

/**
 * The one HTTP client for vendor adapters (src/providers only; lint:arch enforces it). It returns an
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
    catchError((error: unknown) =>
      throwError(() =>
        error instanceof TimeoutError
          ? new HttpTimeoutError(`No response within ${timeoutMs}ms`, { cause: error })
          : new HttpNetworkError('Request failed before a response', { cause: error }),
      ),
    ),
  )
}
