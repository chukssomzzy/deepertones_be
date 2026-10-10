import { describe, expect, it, vi } from 'vitest'
import { hmacSha256Hex, randomDigits, timingSafeEqual } from './crypto'

describe('randomDigits', () => {
  it('returns exactly n decimal digits', () => {
    for (const n of [1, 6, 12]) {
      for (let i = 0; i < 50; i++) expect(randomDigits(n)).toMatch(new RegExp(`^[0-9]{${n}}$`))
    }
  })

  it('is not constant across calls', () => {
    const seen = new Set(Array.from({ length: 50 }, () => randomDigits(6)))
    expect(seen.size).toBeGreaterThan(1)
  })
})

describe('randomDigits rejection sampling', () => {
  it('discards bytes of 250 and above and draws more, using only the accepted bytes mod 10', () => {
    const stream = [250, 7, 255, 13, 251, 9, 21, 32, 43, 54, 65, 76]
    let next = 0
    const spy = vi.spyOn(crypto, 'getRandomValues').mockImplementation(((array: Uint8Array) => {
      for (let i = 0; i < array.length; i++) array[i] = stream[next++]!
      return array
    }) as typeof crypto.getRandomValues)

    try {
      expect(randomDigits(6)).toBe('739123')
    } finally {
      spy.mockRestore()
    }
  })
})

describe('hmacSha256Hex', () => {
  it('returns 64 lowercase hex characters', async () => {
    expect(await hmacSha256Hex('key', 'value')).toMatch(/^[0-9a-f]{64}$/)
  })

  it('matches the RFC 4231 test case 2 vector', async () => {
    expect(await hmacSha256Hex('Jefe', 'what do ya want for nothing?')).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    )
  })

  it('is deterministic for the same key and value', async () => {
    expect(await hmacSha256Hex('key', 'value')).toBe(await hmacSha256Hex('key', 'value'))
  })

  it('differs when the key differs', async () => {
    expect(await hmacSha256Hex('key-a', 'value')).not.toBe(await hmacSha256Hex('key-b', 'value'))
  })

  it('differs when the value differs', async () => {
    expect(await hmacSha256Hex('key', 'value-a')).not.toBe(await hmacSha256Hex('key', 'value-b'))
  })
})

describe('timingSafeEqual', () => {
  it('is true for equal strings', () => {
    expect(timingSafeEqual('abc123', 'abc123')).toBe(true)
  })

  it('is false for strings of the same length that differ', () => {
    expect(timingSafeEqual('abc123', 'abc124')).toBe(false)
  })

  it('is false for strings of different lengths', () => {
    expect(timingSafeEqual('abc', 'abcd')).toBe(false)
    expect(timingSafeEqual('abcd', 'abc')).toBe(false)
  })
})
