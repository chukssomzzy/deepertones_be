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
