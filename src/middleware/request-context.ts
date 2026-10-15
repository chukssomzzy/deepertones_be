import { runWithContext } from '../lib/context'
import { factory } from '../lib/factory'

/**
 * Runs the rest of the request inside a RequestContext, so services can call
 * currentActor() without ever seeing Hono's `c`.
 *
 * Every request is the public actor (no token) until the auth middleware exists. That
 * middleware will resolve the actor, and its tokenProblem, before this one runs, and this
 * will read them from there.
 */
export const requestContext = factory.createMiddleware((c, next) =>
  runWithContext({ actor: { kind: 'public' }, requestId: c.var.requestId, tokenProblem: 'missing' }, next),
)
