import { hmacSha256Hex, timingSafeEqual } from '../lib/crypto'
import { UnauthorizedError } from '../lib/errors'
import { factory } from '../lib/factory'

/**
 * Route middleware (`middleware: [rateLimit('ADMIN_IP_LIMITER', 'ip'), adminToken()]` in defineRoute) for /api/v1/admin: the request must carry
 * `X-Admin-Token`, equal to the ADMIN_API_TOKEN secret. A user's bearer token never stands in for it (the header is the only place read),
 * and a secret that is not set, or is empty, refuses every caller, the one who sends nothing included.
 *
 * Both sides are HMAC'd under a key made fresh for the call and the digests are compared, so what is compared has the same length whatever
 * the caller sent, and the time taken says nothing about how much of the token was right.
 */
export const adminToken = () =>
  factory.createMiddleware(async (c, next) => {
    const secret = c.env.ADMIN_API_TOKEN
    const sent = c.req.header('X-Admin-Token')
    const key = crypto.randomUUID()
    const [expected, actual] = await Promise.all([hmacSha256Hex(key, secret ?? ''), hmacSha256Hex(key, sent ?? '')])
    // The digests are compared whatever the secret is, so an unset one takes as long as a wrong guess; then it refuses anyway.
    const same = timingSafeEqual(expected, actual)
    if (!secret || sent === undefined || !same) throw new UnauthorizedError('ADMIN_TOKEN_INVALID', 'A valid admin token is required')
    return next()
  })
