import { DomainError } from '../lib/errors'
import { describeUnexpectedError } from '../lib/safe-error'
import { PermanentJobError } from './job'

/**
 * What a job record or log line may say about an error. Only the app's own errors (a DomainError, a PermanentJobError)
 * keep their message, because the app wrote it. Anything else is named and nothing more (see describeUnexpectedError).
 */
export const describeError = (error: unknown): string => {
  if (error instanceof DomainError) return `${error.code}: ${error.message}`
  if (error instanceof PermanentJobError) return error.message
  return describeUnexpectedError(error)
}
