import { AsyncLocalStorage } from 'node:async_hooks'
import { UnauthorizedError } from './errors'

/**
 * Who is doing the work. Every unit of work has one, even an unauthenticated request,
 * so "is anyone signed in?" is answered by narrowing on `kind`, never by null checks.
 * The user variant grows (roles, plan, ...) once auth is chosen.
 */
export type Actor =
  | { kind: 'anonymous' }
  | { kind: 'user'; userId: string }
  | { kind: 'system'; job: string } // queue consumers, cron triggers

export type RequestContext = {
  actor: Actor
  requestId: string
}

const storage = new AsyncLocalStorage<RequestContext>()

/**
 * Run `fn` (and everything it awaits) with `ctx` as the current context.
 * The requestContext middleware does this for HTTP; queue/cron handlers use runAs.
 */
export const runWithContext = <T>(ctx: RequestContext, fn: () => T): T => storage.run(ctx, fn)

/** runWithContext for work that has no incoming request: queue/cron handlers and tests. */
export const runAs = <T>(actor: Actor, fn: () => T): T =>
  runWithContext({ actor, requestId: crypto.randomUUID() }, fn)

/**
 * The current context. Throws when there is none: a missing context is a wiring bug,
 * and failing loudly here beats a wrong permission decision later.
 *
 * Only services read the context (enforced by dependency-cruiser). Repositories and
 * providers receive what they need as plain arguments.
 */
export const currentContext = (): RequestContext => {
  const ctx = storage.getStore()
  if (!ctx) {
    throw new Error('No request context: wrap this call in runWithContext() or runAs()')
  }
  return ctx
}

export const currentActor = (): Actor => currentContext().actor

/** The current actor, required to be a signed-in user. */
export const requireUser = (): Extract<Actor, { kind: 'user' }> => {
  const actor = currentActor()
  if (actor.kind !== 'user') {
    throw new UnauthorizedError('AUTH_REQUIRED', 'Sign in to do this')
  }
  return actor
}
