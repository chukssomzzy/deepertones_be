import { describe, expect, it } from 'vitest'
import { base64Of, fromBase64Url, toBase64Url } from './base64'

describe('toBase64Url', () => {
  it.each([
    [[], ''],
    [[0x66], 'Zg'],
    [[0x66, 0x6f], 'Zm8'],
    [[0x66, 0x6f, 0x6f], 'Zm9v'],
    // Bytes whose standard base64 is "+/+/": the url alphabet uses - and _ instead, and never pads.
    [[0xfb, 0xff, 0xbf], '-_-_'],
    [[0xff, 0xfe], '__4'],
  ])('encodes %j as %j', (bytes, expected) => {
    expect(toBase64Url(new Uint8Array(bytes))).toBe(expected)
  })

  it('encodes a photo-sized input without overflowing the stack', () => {
    const bytes = new Uint8Array(500_000).fill(0xfb)

    const text = toBase64Url(bytes)

    expect(text).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(Array.from(fromBase64Url(text).subarray(0, 4))).toEqual([0xfb, 0xfb, 0xfb, 0xfb])
    expect(fromBase64Url(text).length).toBe(bytes.length)
  })
})

describe('fromBase64Url', () => {
  it('round-trips every byte value, at every length from 0 to 5', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i)
    for (let length = 0; length <= 5; length++) {
      const bytes = all.subarray(250 - length, 250)
      expect(Array.from(fromBase64Url(toBase64Url(bytes)))).toEqual(Array.from(bytes))
    }
    expect(Array.from(fromBase64Url(toBase64Url(all)))).toEqual(Array.from(all))
  })

  it('agrees with standard base64 once the alphabet is swapped back', () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0xbf, 0x01])

    expect(toBase64Url(bytes)).toBe(base64Of(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''))
  })

  it.each([
    ['standard + and /', 'ab+/'],
    ['padding', 'Zg=='],
    ['a space', 'Zm 9v'],
    ['a newline', 'Zm9v\n'],
    ['a non-ASCII letter', 'Zm9é'],
    ['an impossible length', 'Zm9vY'],
  ])('throws on %s', (_label, text) => {
    expect(() => fromBase64Url(text)).toThrow()
  })
})
