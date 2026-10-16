import { notSignedIn } from '../lib/actor'
import { factory } from '../lib/factory'

/**
 * Route middleware (`middleware: [signedIn()]` in defineRoute): answers 401 from `c.var.auth` when the caller is not a user, so a
 * route that parses a large body (an upload) can put it before `bodyLimit` and an unsigned caller never costs a parse.
 * It is an early exit, not the guard: the service's requireUser still decides, from the request context.
 */
export const signedIn = () =>
  factory.createMiddleware(async (c, next) => {
    const auth = c.var.auth
    if (auth?.actor.kind !== 'user') throw notSignedIn(auth?.tokenProblem)
    return next()
  })
