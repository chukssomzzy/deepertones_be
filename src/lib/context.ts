import { AsyncLocalStorage } from 'node:async_hooks'
import { ForbiddenError, UnauthorizedError } from './errors'

/**
 * Who is doing the work. Every unit of work has one, even an unauthenticated request,
 * so "is anyone signed in?" is answered by narrowing on `kind`, never by null checks.
 *
 * `public` means no usable token. A guest is not public: it is a real `user` whose
 * status is `anonymous` (the other status is `verified`), so a guest has an id its data can be saved against.
 */
export type Actor =
  | { kind: 'public' }
  | { kind: 'user'; userId: string; status: 'anonymous' | 'verified' }
  | { kind: 'system'; job: string } // queue consumers, cron triggers

/** Why a `public` actor has no identity: no token was sent, or the one sent was expired or unusable. */
export type TokenProblem = 'missing' | 'expired' | 'invalid'

export type RequestContext = {
  actor: Actor
  requestId: string
  /** Set only for `public` actors; the guards turn it into the matching 401 code. */
  tokenProblem?: TokenProblem
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

/**
 * The current actor, required to be a user: any account, guests included.
 * Throws 401 AUTH_REQUIRED (no token), TOKEN_EXPIRED or TOKEN_INVALID.
 */
export const requireUser = (): Extract<Actor, { kind: 'user' }> => {
  const { actor, tokenProblem } = currentContext()
  if (actor.kind === 'user') return actor
  if (actor.kind === 'public' && tokenProblem === 'expired') {
    throw new UnauthorizedError('TOKEN_EXPIRED', 'Your session has expired')
  }
  if (actor.kind === 'public' && tokenProblem === 'invalid') {
    throw new UnauthorizedError('TOKEN_INVALID', 'Your session is not valid')
  }
  throw new UnauthorizedError('AUTH_REQUIRED', 'Sign in to do this')
}

/** requireUser, and the account must be verified: a guest gets 403 VERIFICATION_REQUIRED. */
export const requireVerified = (): Extract<Actor, { kind: 'user' }> => {
  const user = requireUser()
  if (user.status !== 'verified') {
    throw new ForbiddenError('VERIFICATION_REQUIRED', 'Verify your account to do this')
  }
  return user
}
