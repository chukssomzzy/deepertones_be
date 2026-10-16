import { DomainError } from '../lib/errors'
import { PermanentJobError } from './job'

/** `name` alone is useless for drizzle's DrizzleQueryError, which leaves it as 'Error'; the class name still tells them apart. */
const nameOf = (error: Error): string => (error.name === 'Error' && error.constructor?.name ? error.constructor.name : error.name)

/**
 * What a job record or log line may say about an error. Only the app's own errors (a DomainError, a PermanentJobError)
 * keep their message, because the app wrote it. Anything else is named and nothing more: drizzle's query errors carry
 * their SQL params in the message (model-written text, user-typed text, hashes), and a vendor's can carry a request body.
 * The name of the cause is added, one level deep, so "DrizzleQueryError (cause: Error)" still points at where to look.
 */
export const describeError = (error: unknown): string => {
  if (error instanceof DomainError) return `${error.code}: ${error.message}`
  if (error instanceof PermanentJobError) return error.message
  if (!(error instanceof Error)) return `non-error ${typeof error}`
  if (error.cause === undefined) return nameOf(error)
  return `${nameOf(error)} (cause: ${error.cause instanceof Error ? nameOf(error.cause) : typeof error.cause})`
}
