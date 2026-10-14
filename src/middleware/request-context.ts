import { runWithContext } from '../lib/context'
import { factory } from '../lib/factory'

/**
 * Runs the rest of the request inside a RequestContext, so services can call
 * currentActor() without ever seeing Hono's `c`.
 *
 * The actor and tokenProblem come from the auth middleware (c.var.auth). Where it did not run, the
 * request is public with tokenProblem 'missing'.
 */
export const requestContext = factory.createMiddleware((c, next) => {
  const { actor, tokenProblem } = c.var.auth ?? { actor: { kind: 'public' as const }, tokenProblem: 'missing' as const }
  return runWithContext({ actor, requestId: c.var.requestId, tokenProblem }, next)
})
