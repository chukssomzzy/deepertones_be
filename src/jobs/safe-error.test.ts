import { DrizzleQueryError } from 'drizzle-orm/errors'
import { describe, expect, it } from 'vitest'
import { NotFoundError, UnavailableError } from '../lib/errors'
import { PermanentJobError } from './job'
import { describeError } from './safe-error'

const SECRET = 'param-secret-7f3a'

describe('describeError', () => {
  it('keeps the code and message of a domain error, which the app wrote', () => {
    expect(describeError(new NotFoundError('FORMULATION_NOT_FOUND', 'Formulation not found'))).toBe('FORMULATION_NOT_FOUND: Formulation not found')
    expect(describeError(new UnavailableError('CATALOG_BUSY', 'Catalog is busy'))).toBe('CATALOG_BUSY: Catalog is busy')
  })

  it('keeps the message of a PermanentJobError', () => {
    expect(describeError(new PermanentJobError('number is not on whatsapp'))).toBe('number is not on whatsapp')
  })

  it('names any other error and never keeps its message', () => {
    expect(describeError(new TypeError(`bad ${SECRET}`))).toBe('TypeError')
  })

  it('names a drizzle query error by its class, since drizzle leaves its name as Error, and drops the params in its message', () => {
    const error = new DrizzleQueryError('insert into t (a) values (?)', [SECRET], new Error(`constraint failed: ${SECRET}`))

    const described = describeError(error)

    expect(described).toBe('DrizzleQueryError (cause: Error)')
    expect(described).not.toContain(SECRET)
  })

  it('names the cause of a plain error too', () => {
    expect(describeError(new Error(`outer ${SECRET}`, { cause: new RangeError(`inner ${SECRET}`) }))).toBe('Error (cause: RangeError)')
  })

  it('does not follow the cause of a domain error', () => {
    const error = new UnavailableError('X', 'down')
    error.cause = new Error(`inner ${SECRET}`)

    expect(describeError(error)).toBe('X: down')
  })

  it('describes a cause that is not an error by its type only', () => {
    expect(describeError(new Error('x', { cause: `raw ${SECRET}` }))).toBe('Error (cause: string)')
  })

  it('describes a thrown value that is not an error by its type only', () => {
    expect(describeError(`raw ${SECRET}`)).toBe('non-error string')
    expect(describeError({ message: SECRET })).toBe('non-error object')
    expect(describeError(undefined)).toBe('non-error undefined')
  })
})
