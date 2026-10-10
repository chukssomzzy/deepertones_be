import { describe, expect, it } from 'vitest'
import { ValidationError } from './errors'
import { parsePhoneNumber } from './phone'

describe('parsePhoneNumber', () => {
  it.each([
    ['0803 123 4567', '+2348031234567'],
    ['+2348031234567', '+2348031234567'],
    ['2348031234567', '+2348031234567'],
    ['+44 7911 123456', '+447911123456'],
  ])('normalises %j to %s', (input, expected) => {
    expect(parsePhoneNumber(input)).toBe(expected)
  })

  it.each(['', 'abc', '12345'])('rejects %j as INVALID_PHONE', (input) => {
    expect(() => parsePhoneNumber(input)).toThrow(ValidationError)
    expect(() => parsePhoneNumber(input)).toThrow(expect.objectContaining({ code: 'INVALID_PHONE' }))
  })
})
