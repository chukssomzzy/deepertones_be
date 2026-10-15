// Kept apart from context.ts so factory.ts can type the auth variable without reading the
// request context (only services may; see context-only-in-services). context.ts re-exports both.

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
