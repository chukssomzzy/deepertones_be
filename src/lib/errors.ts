import type { Context, ErrorHandler, NotFoundHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { AppEnv } from './factory'

/**
 * Base for every error a service throws on purpose. Carries a stable `code` for
 * clients and no HTTP knowledge, so the same service works from a route, a queue
 * consumer or a cron trigger. Throw a subclass; the kind decides the status.
 */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
    this.name = new.target.name
  }
}

/** Input breaks a rule (shape or business). */
export class ValidationError extends DomainError {}
/** No authenticated actor where one is required. */
export class UnauthorizedError extends DomainError {}
/** The actor is known but not allowed to do this. */
export class ForbiddenError extends DomainError {}
/** The thing asked for does not exist (or is invisible to this actor). */
export class NotFoundError extends DomainError {}
/** The request clashes with current state (duplicate, wrong status, stale write). */
export class ConflictError extends DomainError {}
/** A dependency is down; the same request may work later. */
export class UnavailableError extends DomainError {}

/** The one place domain errors become HTTP. Add a row when you add a kind. */
const statusByKind = new Map<new (...args: never[]) => DomainError, ContentfulStatusCode>([
  [ValidationError, 400],
  [UnauthorizedError, 401],
  [ForbiddenError, 403],
  [NotFoundError, 404],
  [ConflictError, 409],
  [UnavailableError, 503],
])

const statusOf = (err: DomainError): ContentfulStatusCode => {
  for (const [kind, status] of statusByKind) {
    if (err instanceof kind) return status
  }
  // A bare DomainError or an unmapped subclass is a bug in the thrower, but the
  // client still gets the code; 500 makes the gap visible in monitoring.
  return 500
}

/** Every error response from the API has this shape; `status` always equals the HTTP status. */
export type ErrorBody = {
  success: false
  status: number
  message: string
  error: {
    code: string
    details?: unknown
    requestId: string
  }
}

type ErrorContent = { code: string; message: string; details?: unknown }

const isContentful = (status: number): status is ContentfulStatusCode =>
  ![101, 204, 205, 304].includes(status)

/**
 * Repeated names (Set-Cookie) are grouped into arrays: a plain name-to-value record keeps
 * only the last one. content-type/length describe the prepared body, not our JSON envelope.
 */
const forwardableHeaders = (headers: Headers) => {
  const grouped: Record<string, string[]> = {}
  for (const [name, value] of headers) {
    if (name === 'content-type' || name === 'content-length') continue
    ;(grouped[name] ??= []).push(value)
  }
  return grouped
}

/** The only place an ErrorBody is built, so no error path can drift from the documented shape. */
const renderError = (
  c: Context<AppEnv>,
  status: ContentfulStatusCode,
  { code, message, details }: ErrorContent,
  headers?: Record<string, string | string[]>,
) =>
  c.json<ErrorBody>(
    { success: false, status, message, error: { code, details, requestId: c.var.requestId } },
    status,
    headers,
  )

export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  if (err instanceof DomainError) {
    return renderError(c, statusOf(err), err)
  }

  // Thrown by Hono's built-in middleware (bodyLimit, auth helpers, ...).
  if (err instanceof HTTPException) {
    // Some carry a prepared response (e.g. WWW-Authenticate headers). Keep its status and
    // headers, but not content-type/length: they describe its body, not our JSON envelope.
    // A bodyless prepared status (204, 304, ...) cannot carry the envelope, so err.status wins.
    const preparedStatus = err.res?.status
    const status = preparedStatus !== undefined && isContentful(preparedStatus) ? preparedStatus : err.status
    const prepared = status === preparedStatus ? err.res : undefined
    return renderError(
      c,
      status,
      { code: `HTTP_${status}`, message: err.message || `Request failed with status ${status}` },
      prepared && forwardableHeaders(prepared.headers),
    )
  }

  // Anything else is a bug: log the details, never leak them to the client.
  console.error({ requestId: c.var.requestId, error: err })
  return renderError(c, 500, { code: 'INTERNAL_ERROR', message: 'Something went wrong' })
}

export const notFoundHandler: NotFoundHandler<AppEnv> = (c) =>
  renderError(c, 404, { code: 'NOT_FOUND', message: `${c.req.method} ${c.req.path} not found` })
