import { createFactory } from 'hono/factory'
import type { RequestIdVariables } from 'hono/request-id'
import type { Container } from '../container'

/**
 * The one Env contract for the whole app. Bindings come from wrangler.jsonc
 * (regenerate with `npm run cf-typegen`); Variables are what middleware puts on `c.var`.
 */
export type AppEnv = {
  Bindings: CloudflareBindings
  Variables: RequestIdVariables & {
    /** This request's services, built by the container middleware. */
    services: Container
  }
}

/**
 * Build middleware from this factory so `c.env` and `c.var` are typed identically everywhere:
 *   factory.createMiddleware()   -> a middleware
 *
 * Route modules do NOT use factory.createApp(): they use openapiApp() from ./openapi, which
 * carries the same AppEnv and puts every route in the OpenAPI spec (enforced by lint:arch).
 */
export const factory = createFactory<AppEnv>()
