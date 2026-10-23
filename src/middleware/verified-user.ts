import { notSignedIn, verificationRequired } from '../lib/actor'
import { factory } from '../lib/factory'

/**
 * Route middleware (`middleware: [verifiedUser()]` in defineRoute): signedIn, and the account must be verified. Answers 401 from `c.var.auth`
 * when the caller is not a user and 403 VERIFICATION_REQUIRED for a guest, so a route that parses a large body (an upload) can put it before
 * `bodyLimit` and a guest never costs a parse. It is an early exit, not the guard: the service's requireVerified still decides, from the request context.
 */
export const verifiedUser = () =>
  factory.createMiddleware(async (c, next) => {
    const auth = c.var.auth
    if (auth?.actor.kind !== 'user') throw notSignedIn(auth?.tokenProblem)
    if (auth.actor.status !== 'verified') throw verificationRequired()
    return next()
  })
