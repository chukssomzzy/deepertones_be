import { runWithContext } from '../lib/context'
import { factory } from '../lib/factory'

/**
 * Runs the rest of the request inside a RequestContext, so services can call
 * currentActor() without ever seeing Hono's `c`.
 *
 * Every request is anonymous until auth exists. The auth middleware will resolve the
 * actor before this one runs and this will read it from there.
 */
export const requestContext = factory.createMiddleware((c, next) =>
  runWithContext({ actor: { kind: 'anonymous' }, requestId: c.var.requestId }, next),
)
