import { zValidator } from '@hono/zod-validator'
import type { ValidationTargets } from 'hono'
import type * as z from 'zod'
import { ValidationError } from './errors'

/**
 * zValidator wired to our error contract: bad input throws ValidationError (400), so it
 * reaches the client in the same shape as every other error.
 *
 *   .post('/', validate('json', schema), (c) => { const body = c.req.valid('json') })
 */
export const validate = <Target extends keyof ValidationTargets, Schema extends z.ZodType>(
  target: Target,
  schema: Schema,
) =>
  zValidator(target, schema, (result) => {
    if (!result.success) {
      throw new ValidationError(
        'VALIDATION_FAILED',
        `Invalid ${target}`,
        result.error.issues.map((issue) => ({
          path: issue.path.map(String).join('.'),
          message: issue.message,
        })),
      )
    }
  })
