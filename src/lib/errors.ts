import type { ErrorHandler, NotFoundHandler } from 'hono'
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

/** The one place domain errors become HTTP. Add a row when you add a kind. */
const statusByKind = new Map<new (...args: never[]) => DomainError, ContentfulStatusCode>([
  [ValidationError, 400],
  [UnauthorizedError, 401],
  [ForbiddenError, 403],
  [NotFoundError, 404],
  [ConflictError, 409],
])

const statusOf = (err: DomainError): ContentfulStatusCode => {
  for (const [kind, status] of statusByKind) {
    if (err instanceof kind) return status
  }
  // A bare DomainError or an unmapped subclass is a bug in the thrower, but the
  // client still gets the code; 500 makes the gap visible in monitoring.
  return 500
}

/** Every error response from the API has this shape. */
export type ErrorBody = {
  error: {
    code: string
    message: string
    details?: unknown
    requestId: string
  }
}

export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  const requestId = c.var.requestId

  if (err instanceof DomainError) {
    return c.json<ErrorBody>(
      { error: { code: err.code, message: err.message, details: err.details, requestId } },
      statusOf(err),
    )
  }

  // Thrown by Hono's built-in middleware (bodyLimit, auth helpers, ...).
  if (err instanceof HTTPException) {
    // Some carry a prepared response (e.g. WWW-Authenticate headers); keep it intact.
    if (err.res) return err.getResponse()
    return c.json<ErrorBody>(
      { error: { code: `HTTP_${err.status}`, message: err.message, requestId } },
      err.status,
    )
  }

  // Anything else is a bug: log the details, never leak them to the client.
  console.error({ requestId, error: err })
  return c.json<ErrorBody>(
    { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong', requestId } },
    500,
  )
}

export const notFoundHandler: NotFoundHandler<AppEnv> = (c) =>
  c.json<ErrorBody>(
    {
      error: {
        code: 'NOT_FOUND',
        message: `${c.req.method} ${c.req.path} not found`,
        requestId: c.var.requestId,
      },
    },
    404,
  )
