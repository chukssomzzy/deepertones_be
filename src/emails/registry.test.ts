import { afterAll, describe, expect, it, vi } from 'vitest'
import { BRAND } from './brand'
import { escapeHtml } from './html'
import { renderEmail, templates } from './registry'

// Collection-time rendering below needs the clock pinned before any describe body runs.
vi.useFakeTimers({ toFake: ['Date'] })
vi.setSystemTime(new Date('2030-06-15T12:00:00Z'))
afterAll(() => vi.useRealTimers())

const COPYRIGHT = '© 2030 Deeper Tones'
const TAG_PATTERN = /<[a-z!/][^>]*>/i

describe.each(Object.entries(templates))('layout of the %s email', (name, template) => {
  const out = renderEmail(name as keyof typeof templates, template.sample as never)

  it('has a non-empty subject', () => {
    expect(out.subject.trim()).not.toBe('')
  })

  it('is a full HTML document', () => {
    expect(out.html.trimStart().toLowerCase().startsWith('<!doctype html>')).toBe(true)
  })

  it('shows the brand logo with the brand alt text', () => {
    const img = out.html.match(/<img\b[^>]*>/i)?.[0] ?? ''
    expect(img).toContain(`src="${BRAND.logoUrl}"`)
    expect(img).toContain('alt="Deeper Tones"')
  })

  it('keeps the logo alt text readable on the dark header when the image is blocked', () => {
    const img = out.html.match(/<img\b[^>]*>/i)?.[0] ?? ''
    expect(img).toContain(BRAND.colors.lightText)
  })

  it('has the tagline, support address and copyright in the html footer', () => {
    expect(out.html).toContain(escapeHtml(BRAND.tagline))
    expect(out.html).toContain(BRAND.supportEmail)
    expect(out.html).toContain(COPYRIGHT)
  })

  it('has a plain-text part with the same footer and no markup', () => {
    expect(out.text.trim()).not.toBe('')
    expect(out.text).toContain(BRAND.tagline)
    expect(out.text).toContain(BRAND.supportEmail)
    expect(out.text).toContain(COPYRIGHT)
    expect(out.text).not.toMatch(TAG_PATTERN)
  })
})

describe('otp-code email', () => {
  const out = renderEmail('otp-code', { code: '482913', ttlMinutes: 10 })

  it('puts the code in the subject', () => {
    expect(out.subject).toBe('482913 is your Deeper Tones sign-in code')
  })

  it('shows the code in the html', () => {
    expect(out.html).toContain('482913')
  })

  it('tells the reader the code, its lifetime and what to do if they did not ask', () => {
    expect(out.text).toContain('482913')
    expect(out.text).toContain('10 minutes')
    expect(out.text).toMatch(/didn.?t (ask|request)/i)
  })

  it('keeps the hidden preheader in html but out of the plain text', () => {
    expect(out.html).toContain('Your code expires in 10 minutes.')
    expect(out.text).not.toContain('Your code expires in 10 minutes.')
    expect(out.text).toContain('It expires in 10 minutes.')
  })

  it('closes the html document', () => {
    expect(out.html).toContain('</html>')
  })

  it('states the lifetime it was given', () => {
    expect(renderEmail('otp-code', { code: '111111', ttlMinutes: 15 }).text).toContain('15 minutes')
  })

  it('escapes markup in the data', () => {
    const { html } = renderEmail('otp-code', { code: '<b>9</b>', ttlMinutes: 10 })
    expect(html).toContain('&lt;b&gt;9&lt;/b&gt;')
    expect(html).not.toContain('<b>9</b>')
  })
})

describe('otp-code pluralisation', () => {
  it('says "1 minute" for a one-minute code', () => {
    const out = renderEmail('otp-code', { code: '482913', ttlMinutes: 1 })
    expect(out.text).toContain('It expires in 1 minute.')
    expect(out.text).not.toContain('1 minutes')
    expect(out.html).toContain('Your code expires in 1 minute.')
  })
})

describe('renderEmail types', () => {
  it('rejects wrong data and unknown template names at compile time', () => {
    // Never executed: only the type checker evaluates these lines.
    const neverRun = () => {
      // @ts-expect-error ttlMinutes is required
      renderEmail('otp-code', { code: '482913' })
      // @ts-expect-error no such template
      renderEmail('no-such-template', { code: '1' })
    }
    expect(neverRun).toBeTypeOf('function')
  })
})
