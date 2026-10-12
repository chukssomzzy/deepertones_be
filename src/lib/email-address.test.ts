import { describe, expect, it } from 'vitest'
import { parseEmailAddress } from './email-address'
import { ValidationError } from './errors'

describe('parseEmailAddress', () => {
  it.each([
    ['  Ada@Example.COM ', 'ada@example.com'],
    ['a.b+tag@mail.deepertones.com', 'a.b+tag@mail.deepertones.com'],
    [`${'a'.repeat(64)}@example.com`, `${'a'.repeat(64)}@example.com`],
  ])('normalises %j to %s', (input, expected) => {
    expect(parseEmailAddress(input)).toBe(expected)
  })

  it('accepts an address of exactly 254 characters', () => {
    const domain = `${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.com`
    const local = 'a'.repeat(254 - domain.length - 1)
    const address = `${local}@${domain}`
    expect(address).toHaveLength(254)
    expect(local.length).toBeLessThanOrEqual(64)
    expect(parseEmailAddress(address)).toBe(address)
  })

  it.each([
    ['empty', ''],
    ['no at sign', 'abc'],
    ['domain without a dot', 'a@b'],
    ['two at signs', 'a@@b.com'],
    ['whitespace in local part', 'a b@c.com'],
    ['leading hyphen in label', 'a@-b.com'],
    ['trailing hyphen in label', 'a@b-.com'],
    ['empty domain label', 'a@b..com'],
    ['empty local part', '@b.com'],
    ['65-char local part', `${'a'.repeat(65)}@example.com`],
    ['over 254 characters', `${'a'.repeat(60)}@${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.${'e'.repeat(20)}.com`],
  ])('rejects %s as INVALID_EMAIL', (_label, input) => {
    expect(() => parseEmailAddress(input)).toThrow(ValidationError)
    expect(() => parseEmailAddress(input)).toThrow(
      expect.objectContaining({ code: 'INVALID_EMAIL', message: 'Enter a valid email address' }),
    )
  })

  it('rejects an address of 255 characters', () => {
    const domain = `${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.com`
    const address = `${'a'.repeat(255 - domain.length - 1)}@${domain}`
    expect(address).toHaveLength(255)
    expect(() => parseEmailAddress(address)).toThrow(expect.objectContaining({ code: 'INVALID_EMAIL' }))
  })
})
