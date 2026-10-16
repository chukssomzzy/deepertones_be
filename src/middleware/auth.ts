import { factory } from '../lib/factory'

/**
 * Turns `Authorization: Bearer <access token>` into `c.var.auth` for requestContext. It never
 * responds: an expired token must not block /auth/refresh, and public routes must ignore a bad
 * header. The guards (requireUser, requireVerified) turn the recorded problem into the right 401.
 * No database read here; the token version is checked only at refresh.
 */
export const auth = factory.createMiddleware(async (c, next) => {
  const header = c.req.header('Authorization')
  if (header === undefined) {
    c.set('auth', { actor: { kind: 'public' }, tokenProblem: 'missing' })
    return next()
  }

  const token = /^bearer (\S+)$/i.exec(header.trim())?.[1]
  const result = token ? await c.var.services.tokens.verifyAccess(token) : undefined
  if (result?.ok) {
    c.set('auth', { actor: { kind: 'user', userId: result.userId, status: result.status, profileId: result.profileId } })
  } else {
    c.set('auth', { actor: { kind: 'public' }, tokenProblem: result?.problem ?? 'invalid' })
  }
  return next()
})
