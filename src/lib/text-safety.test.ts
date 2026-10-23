import { describe, expect, it } from 'vitest'
import { hasLink, hasLinkOrMarkup, hasMarkup } from './text-safety'

const LINKS = ['https://evil.example/buy', 'http://evil.example', 'ftp://files.example', 'javascript://x', 'Visit www.evil.example', 'WWW.EVIL.EXAMPLE']
const MARKUP = ['use <script>evil()</script>', 'use <SCRIPT>evil()</SCRIPT>', 'it ends </p> evil', 'a <!-- evil --> comment', 'a rating <evil', 'Serum <b>bold</b>']
const ORDINARY = ['SPF < 30 Day Cream', 'Retinol <1% Night Serum', 'pH > 5 Toner', 'Vitamin C + E (10%)', "L'Oréal Paris", 'Phenoxyethanol <1%', 'Aqua (Water)', 'a < b > c', '']

describe('hasLink', () => {
  it.each(LINKS)('finds the link in %j', (text) => {
    expect(hasLink(text)).toBe(true)
  })

  it.each([...MARKUP, ...ORDINARY])('finds no link in %j', (text) => {
    expect(hasLink(text)).toBe(false)
  })
})

describe('hasMarkup', () => {
  it.each(MARKUP)('finds the markup in %j', (text) => {
    expect(hasMarkup(text)).toBe(true)
  })

  it.each([...LINKS, ...ORDINARY])('finds no markup in %j', (text) => {
    expect(hasMarkup(text)).toBe(false)
  })
})

describe('hasLinkOrMarkup', () => {
  it.each([...LINKS, ...MARKUP, 'https://evil.example <b>x</b>'])('flags %j', (text) => {
    expect(hasLinkOrMarkup(text)).toBe(true)
  })

  it.each(ORDINARY)('accepts %j', (text) => {
    expect(hasLinkOrMarkup(text)).toBe(false)
  })
})

// A workbook cell can hold 32767 characters and a letter run is also a legal start of a scheme, so a check that tried every start position
// against an unbounded run (`[a-z][a-z0-9+.-]*://`) took seconds on one cell. A scheme is at most 32 characters, and a check on a long cell
// must cost about its length, not its length squared.
const WITHIN_MS = 100
const timed = <T>(run: () => T): { result: T; ms: number } => {
  const started = performance.now()
  const result = run()
  return { result, ms: performance.now() - started }
}

describe('hasLinkOrMarkup on text of the longest length a cell can have', () => {
  it.each([
    ['letters', 'a'.repeat(32767)],
    ['letters and dots', 'a.'.repeat(16383)],
    ['letters and plus signs', 'a+'.repeat(16383)],
    ['letters and hyphens', 'a-'.repeat(16383)],
    ['words', 'serum '.repeat(5461)],
  ])('finds no link or markup in %s, and says so in under 100 ms', (_name, text) => {
    const { result, ms } = timed(() => hasLinkOrMarkup(text))

    expect(result).toBe(false)
    expect(ms).toBeLessThan(WITHIN_MS)
  })

  it('still finds a link at the end of a long run of letters, in under 100 ms', () => {
    const { result, ms } = timed(() => hasLinkOrMarkup(`${'a'.repeat(32700)} https://evil.example`))

    expect(result).toBe(true)
    expect(ms).toBeLessThan(WITHIN_MS)
  })

  it('still finds a scheme of a letter and up to 31 more characters before "://", however long the run before it', () => {
    expect(hasLink(`${'a'.repeat(31)}://x`)).toBe(true)
    expect(hasLink(`a${'b'.repeat(31)}://x`)).toBe(true)
    // Longer than 32: the last 32 characters before "://" are still a scheme, so it is a link either way.
    expect(hasLink(`${'a'.repeat(40)}://x`)).toBe(true)
    expect(hasLink(`${'a'.repeat(32767)}://x`)).toBe(true)
  })

  it('still finds a link in text that holds a longer ordinary word first', () => {
    expect(hasLinkOrMarkup(`${'dermatologist-tested '.repeat(1500)}www.evil.example`)).toBe(true)
  })
})
