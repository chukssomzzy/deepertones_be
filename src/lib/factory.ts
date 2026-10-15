import { createFactory } from 'hono/factory'
import type { Container } from '../container'
import type { Actor, TokenProblem } from './actor'
import type { BaseEnv } from './env'

/**
 * The one Env contract for the whole app. Bindings come from wrangler.jsonc
 * (regenerate with `npm run cf-typegen`); Variables are what middleware puts on `c.var`.
 */
export type AppEnv = {
  Bindings: BaseEnv['Bindings']
  Variables: BaseEnv['Variables'] & {
    /** This request's services, built by the container middleware. */
    services: Container
    /** Who the bearer token says is calling, set by the auth middleware. Unset where it does not run. */
    auth?: { actor: Actor; tokenProblem?: TokenProblem }
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
