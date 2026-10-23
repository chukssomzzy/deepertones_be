// Kept apart from context.ts so factory.ts and middleware can use the actor types and the sign-in error without reading the
// request context (only services may; see context-only-in-services). context.ts re-exports the types.
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
  | { kind: 'user'; userId: string; status: 'anonymous' | 'verified'; profileId: string }
  | { kind: 'system'; job: string } // queue consumers, cron triggers

/** Why a `public` actor has no identity: no token was sent, or the one sent was expired or unusable. */
export type TokenProblem = 'missing' | 'expired' | 'invalid'

/**
 * The 401 for a caller who is not signed in: AUTH_REQUIRED (no token), TOKEN_EXPIRED or TOKEN_INVALID. One place, so the
 * requireUser guard and the signedIn middleware cannot disagree about which code a caller gets.
 */
export const notSignedIn = (tokenProblem?: TokenProblem): UnauthorizedError => {
  if (tokenProblem === 'expired') return new UnauthorizedError('TOKEN_EXPIRED', 'Your session has expired')
  if (tokenProblem === 'invalid') return new UnauthorizedError('TOKEN_INVALID', 'Your session is not valid')
  return new UnauthorizedError('AUTH_REQUIRED', 'Sign in to do this')
}

/** The 403 for a guest who tries what only a verified account may do. One place, so the requireVerified guard and the verifiedUser middleware say the same thing. */
export const verificationRequired = (): ForbiddenError => new ForbiddenError('VERIFICATION_REQUIRED', 'Verify your account to do this')
