import { DrizzleQueryError } from 'drizzle-orm/errors'
import { describe, expect, it } from 'vitest'
import { describeUnexpectedError } from './safe-error'

const SECRET = 'param-secret-7f3a'

describe('describeUnexpectedError', () => {
  it('names an error and never keeps its message', () => {
    expect(describeUnexpectedError(new TypeError(`bad ${SECRET}`))).toBe('TypeError')
  })

  it('names a drizzle query error by its class and its cause, dropping the params in its message', () => {
    const error = new DrizzleQueryError('insert into t (a) values (?)', [SECRET], new Error(`constraint failed: ${SECRET}`))

    const described = describeUnexpectedError(error)

    expect(described).toBe('DrizzleQueryError (cause: Error)')
    expect(described).not.toContain(SECRET)
  })

  it('names what a non-error cause or a thrown non-error is, by type only', () => {
    expect(describeUnexpectedError(new Error('x', { cause: `raw ${SECRET}` }))).toBe('Error (cause: string)')
    expect(describeUnexpectedError(`raw ${SECRET}`)).toBe('non-error string')
    expect(describeUnexpectedError(undefined)).toBe('non-error undefined')
  })
})
