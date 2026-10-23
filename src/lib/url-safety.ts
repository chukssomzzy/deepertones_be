// Real image URLs are far shorter; a longer one is a payload.
const MAX_URL_LENGTH = 2048
const IPV4_LITERAL = /^\d{1,3}(\.\d{1,3}){3}$/

/**
 * Whether `value` is an https URL on a public-looking hostname that a server may fetch: no
 * userinfo, no explicit port, no IP literal, no localhost, no single-label (intranet) host.
 * A string filter, not SSRF protection on its own: it cannot see what a name resolves to, so a
 * caller that fetches must also refuse unsafe redirects and cap the bytes it reads.
 */
export const isSafePublicHttpsUrl = (value: unknown): value is string => {
  if (typeof value !== 'string' || value.length > MAX_URL_LENGTH) return false
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  // The parser drops a spelled-out default port (`:443`), so the port is read from the raw text.
  // Any ':' left in the authority is a port or an IPv6 literal; both are refused.
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '' || hasColonInAuthority(value)) return false

  // The parser rewrites decimal, octal and hex IPv4 spellings to dotted form and wraps IPv6 in brackets.
  const host = url.hostname.replace(/\.+$/, '')
  return !(host === 'localhost' || host.endsWith('.localhost') || host.startsWith('[') || IPV4_LITERAL.test(host) || !host.includes('.'))
}

/** The parser ignores tabs and newlines, treats `\` as `/`, and accepts `https:host` without slashes; so does this. */
const hasColonInAuthority = (raw: string): boolean => {
  const afterScheme = raw
    .replace(/[\t\n\r]/g, '')
    .trim()
    .replace(/^https:[/\\]*/i, '')
  const authority = afterScheme.split(/[/\\?#]/, 1)[0]!
  return authority.slice(authority.lastIndexOf('@') + 1).includes(':')
}

/**
 * An address as two of them are compared to tell whether they name the same page: scheme and host in lower case (the URL parser does that), no fragment,
 * no trailing slash. The query stays: a page at another query is not known to be the same page. Undefined when it is not a web address.
 */
export const comparableUrl = (address: string): string | undefined => {
  try {
    const url = new URL(address)
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}${url.search}`
  } catch {
    return undefined
  }
}
