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
 * Build every sub-app and middleware from this factory so `c.env` and `c.var`
 * are typed identically everywhere:
 *   factory.createApp()          -> a route module
 *   factory.createMiddleware()   -> a middleware
 *   factory.createHandlers()     -> handlers defined outside a route chain
 */
export const factory = createFactory<AppEnv>()
