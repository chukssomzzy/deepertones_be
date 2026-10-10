import { cors as honoCors } from 'hono/cors'
import { factory } from '../lib/factory'

/** CORS allowlist read from the CORS_ORIGINS var, so each environment sets its own. */
export const cors = factory.createMiddleware((c, next) => {
  const allowed = c.env.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)

  return honoCors({
    origin: (origin) => (allowed.includes(origin) ? origin : null),
  })(c, next)
})
