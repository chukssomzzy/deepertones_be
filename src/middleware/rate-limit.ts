import { RateLimitedError } from '../lib/errors'
import { factory } from '../lib/factory'

type LimiterName = { [K in keyof CloudflareBindings]-?: CloudflareBindings[K] extends RateLimit ? K : never }[keyof CloudflareBindings]

const RETRY_AFTER_SECONDS = 60

/**
 * Route middleware (`middleware: [rateLimit(...)]` in defineRoute) over a Workers rate-limit binding.
 * It runs after `auth` but outside requestContext, so it reads c.var.auth and never currentActor().
 *
 * `ip` keys on the client address Cloudflare sets; `user` keys on the token's user id and is skipped
 * for a public caller (the IP limiter already covers them, and the route's guard rejects them).
 * The binding's period is fixed at 60 s in wrangler.jsonc, hence the constant Retry-After.
 */
export const rateLimit = (binding: LimiterName, key: 'ip' | 'user') =>
  factory.createMiddleware(async (c, next) => {
    let subject: string | undefined
    if (key === 'ip') {
      // Cloudflare always sets cf-connecting-ip at the edge; the fallback only triggers in local dev and
      // tests, where every caller then shares one bucket.
      subject = c.req.header('cf-connecting-ip') ?? 'unknown'
    } else {
      const actor = c.var.auth?.actor
      subject = actor?.kind === 'user' ? actor.userId : undefined
    }
    if (subject !== undefined) {
      const { success } = await c.env[binding].limit({ key: subject })
      if (!success) {
        throw new RateLimitedError('RATE_LIMITED', 'Too many requests, try again shortly', {
          retryAfterSeconds: RETRY_AFTER_SECONDS,
        })
      }
    }
    return next()
  })
