import { describe, expect, it } from 'vitest'
import { isSafePublicHttpsUrl } from './url-safety'

describe('isSafePublicHttpsUrl', () => {
  it.each([
    ['a plain https url', 'https://www.cerave.example/images/hydrating-cleanser.png'],
    ['a CDN host', 'https://cdn.shopify.com/a.jpg'],
    ['a two-label host', 'https://example.com/a.jpg'],
    ['a url with a query string', 'https://example.com/a.jpg?w=800&v=2'],
    ['a host with a trailing dot', 'https://example.com./a.jpg'],
  ])('accepts %s', (_label, value) => {
    expect(isSafePublicHttpsUrl(value)).toBe(true)
  })

  it.each([
    ['an http url', 'http://example.com/a.jpg'],
    ['a relative url', '/images/x.png'],
    ['a javascript url', 'javascript:alert(1)'],
    ['not a url', 'a picture of the bottle'],
    ['an empty string', ''],
    ['a url with credentials', 'https://user:secret@www.cerave.example/x.png'],
    ['a url with a username only', 'https://user@example.com/x'],
    ['a url with a port', 'https://www.cerave.example:8443/x.png'],
    ['a url with the default https port spelled out', 'https://example.com:443/a.jpg'],
    ['localhost', 'https://localhost/x.png'],
    ['localhost with a trailing dot', 'https://localhost./x.png'],
    ['a localhost subdomain', 'https://admin.localhost/x.png'],
    ['an IPv4 literal', 'https://203.0.113.7/x.png'],
    ['a loopback IPv4 literal', 'https://127.0.0.1/x.png'],
    ['a decimal IPv4 literal', 'https://2130706433/x'],
    ['a hex IPv4 literal', 'https://0x7f.1/x'],
    ['an IPv6 literal', 'https://[2001:db8::1]/x.png'],
    ['a loopback IPv6 literal', 'https://[::1]/x'],
    ['a single-label host', 'https://intranet/x.png'],
    ['a single-label host with a trailing dot', 'https://intranet./x.png'],
  ])('rejects %s', (_label, value) => {
    expect(isSafePublicHttpsUrl(value)).toBe(false)
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['an object', {}],
    ['a URL object', new URL('https://example.com/a.jpg')],
  ])('rejects %s, which is not a string', (_label, value) => {
    expect(isSafePublicHttpsUrl(value)).toBe(false)
  })
})

describe('isSafePublicHttpsUrl length limit', () => {
  const padded = (length: number) => `https://example.com/${'a'.repeat(length - 'https://example.com/'.length)}`

  it('accepts a url of exactly 2048 characters', () => {
    expect(padded(2048)).toHaveLength(2048)
    expect(isSafePublicHttpsUrl(padded(2048))).toBe(true)
  })

  it('rejects a url of 2049 characters', () => {
    expect(isSafePublicHttpsUrl(padded(2049))).toBe(false)
  })
})
