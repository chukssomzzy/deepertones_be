import { createDb } from './lib/db'
import { once } from './lib/once'
import { D1HealthRepository } from './modules/health/health.repository'
import { HealthService } from './modules/health/health.service'

/**
 * The composition root: the ONLY file that knows concrete repository, provider and
 * service classes. Built per request (bindings arrive with the request) and lazy, so a
 * request only constructs what it touches.
 *
 * To add a module: build its repository from db(), its providers from env, and pass
 * other modules' services (never their repositories) by calling their `once` factory.
 *   const tracks = once(() => new TracksService(new D1TracksRepository(db()), users()))
 * then expose it as a getter below.
 */
export const buildContainer = (env: CloudflareBindings) => {
  const db = once(() => createDb(env.DB))

  const health = once(() => new HealthService(new D1HealthRepository(db()), env.ENVIRONMENT))

  return {
    get health() {
      return health()
    },
  }
}

export type Container = ReturnType<typeof buildContainer>
