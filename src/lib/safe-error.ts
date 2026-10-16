/** `name` alone is useless for drizzle's DrizzleQueryError, which leaves it as 'Error'; the class name still tells them apart. */
const nameOf = (error: Error): string => (error.name === 'Error' && error.constructor?.name ? error.constructor.name : error.name)

/**
 * What a log line may say about an error nobody on the app wrote a message for: its name, plus the name of its `cause`
 * when it has one (`DrizzleQueryError (cause: Error)`), and `non-error <typeof>` for a thrown non-error. Never the message:
 * drizzle's query errors carry their SQL params in it (model-written text, user-typed text, hashes), and a vendor's can
 * carry a request body. A leaf file, so lib/errors.ts can use it; jobs/safe-error.ts adds the errors the app does author.
 */
export const describeUnexpectedError = (error: unknown): string => {
  if (!(error instanceof Error)) return `non-error ${typeof error}`
  if (error.cause === undefined) return nameOf(error)
  return `${nameOf(error)} (cause: ${error.cause instanceof Error ? nameOf(error.cause) : typeof error.cause})`
}
