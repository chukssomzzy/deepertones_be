import { firstValueFrom, type Observable } from 'rxjs'
import { type HttpBytesResponse, HttpTooLargeError, HttpTransportError, requestBytes$, requestHeadBytes$ } from '../../lib/http'
import { readImageHeader } from '../../lib/image-header'
import { isSafePublicHttpsUrl } from '../../lib/url-safety'
import type { ProductImage } from '../product-analysis/product-analyst.provider'
import type { CatalogImageStore } from './catalog-image-store.provider'

export type R2CatalogImageStoreConfig = {
  /** The public bucket; stock images go under their own key prefix (see ProductCatalogService), apart from the CI-synced assets. */
  bucket: R2Bucket
  /** Where the bucket is served from, e.g. https://assets.deepertones.com; '' when it has no public address. */
  publicBaseUrl: string
  /** Give up on each request after this long; default 10000. */
  timeoutMs?: number
  /** Refuse an image bigger than this; default 5 MB. */
  maxBytes?: number
  /** Never download from these hosts or their subdomains (our own zones, so a redirect cannot loop back at us). Default none. */
  blockedHostSuffixes?: string[]
}

/**
 * Downloads stock images from brand and retailer sites and keeps them in R2.
 *
 * The URL comes from a model reading web pages, so it is hostile input. This class only makes sure
 * the download is a real JPEG, PNG or WebP of sane size from a public https host. It cannot tell
 * whether the picture shows the right product: a hostile page can still serve a valid image of the
 * wrong thing. The vision match in the catalog service is the second gate, and nothing here may be
 * stored without passing it.
 */
export class R2CatalogImageStore implements CatalogImageStore {
  private static readonly DEFAULT_TIMEOUT_MS = 10_000
  private static readonly DEFAULT_MAX_BYTES = 5_000_000
  private static readonly MAX_REDIRECTS = 2
  // The image meta tags live in <head>; a page is not read past this.
  private static readonly PAGE_MAX_BYTES = 512 * 1024
  // In preference order; the first value that resolves to a safe url wins, so an http og:image does not hide a good og:image:secure_url.
  private static readonly IMAGE_META_RANKS = [['og:image'], ['og:image:secure_url', 'og:image:url'], ['twitter:image']]
  // The scan is a forward-only walk, not a regex: the page is hostile and a backtracking pattern on it costs minutes of CPU.
  private static readonly MAX_META_TAGS = 200
  private static readonly MAX_META_TAG_LENGTH = 4096
  private static readonly WHITESPACE = new Set([' ', '\t', '\n', '\r', '\f'])
  private static readonly ENTITY = /&(?:#x([0-9a-f]+)|#(\d+)|(amp|quot|apos|lt|gt));/gi
  private static readonly NAMED_ENTITIES: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' }
  private static readonly REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
  // One day, not immutable: a deleted or replaced image must stop being served soon (takedowns).
  private static readonly CACHE_CONTROL = 'public, max-age=86400'
  // Lowercase path segments of letters, digits, '.', '_' and '-'. A key that breaks this is our bug, not the vendor's.
  private static readonly KEY_PATTERN = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/

  private readonly config: R2CatalogImageStoreConfig

  constructor(config: R2CatalogImageStoreConfig) {
    this.config = config
  }

  async fetchImage(url: string): Promise<ProductImage | null> {
    const { timeoutMs = R2CatalogImageStore.DEFAULT_TIMEOUT_MS, maxBytes = R2CatalogImageStore.DEFAULT_MAX_BYTES } = this.config
    const response = await this.get(url, (current) => requestBytes$(current, { timeoutMs, maxBytes }))
    if (!response?.ok) return null
    // The header is the server's claim; only the bytes count.
    const header = readImageHeader(response.bytes)
    return header ? { bytes: response.bytes, mediaType: header.mediaType } : null
  }

  async pageImageUrl(pageUrl: string): Promise<string | null> {
    const { timeoutMs = R2CatalogImageStore.DEFAULT_TIMEOUT_MS } = this.config
    try {
      const response = await this.get(pageUrl, (current) => requestHeadBytes$(current, { timeoutMs, maxBytes: R2CatalogImageStore.PAGE_MAX_BYTES }))
      if (!response?.ok || !response.contentType?.toLowerCase().startsWith('text/html')) return null
      for (const value of R2CatalogImageStore.imageMetaValues(new TextDecoder().decode(response.bytes))) {
        const resolved = R2CatalogImageStore.resolve(value, response.url)
        if (resolved !== null && isSafePublicHttpsUrl(resolved)) return resolved
      }
      return null
    } catch {
      // Hostile input: nothing here may leak the page or its URL, so no logging either.
      return null
    }
  }

  /**
   * Requests `url`, following at most MAX_REDIRECTS redirects. Every hop must pass the safe-URL and blocked-host
   * checks before it is requested. Null for an unsafe hop, too many redirects or a transport failure.
   */
  private async get(url: string, request: (url: string) => Observable<HttpBytesResponse>): Promise<(HttpBytesResponse & { url: string }) | null> {
    const { blockedHostSuffixes = [] } = this.config
    let current = url
    for (let redirects = 0; ; redirects++) {
      // Every hop, not just the first: a safe host can redirect to an internal one.
      if (!isSafePublicHttpsUrl(current) || R2CatalogImageStore.isBlockedHost(current, blockedHostSuffixes)) return null
      let response: HttpBytesResponse
      try {
        response = await firstValueFrom(request(current))
      } catch (error) {
        if (error instanceof HttpTransportError || error instanceof HttpTooLargeError) return null
        throw error
      }

      if (!R2CatalogImageStore.REDIRECT_STATUSES.has(response.status)) return { ...response, url: current }
      if (redirects === R2CatalogImageStore.MAX_REDIRECTS || !response.location) return null
      try {
        current = new URL(response.location, current).href
      } catch {
        return null
      }
    }
  }

  async put(key: string, image: ProductImage): Promise<void> {
    R2CatalogImageStore.assertValidKey(key)
    await this.config.bucket.put(key, image.bytes, { httpMetadata: { contentType: image.mediaType, cacheControl: R2CatalogImageStore.CACHE_CONTROL } })
  }

  async delete(key: string): Promise<void> {
    R2CatalogImageStore.assertValidKey(key)
    await this.config.bucket.delete(key)
  }

  publicUrl(key: string): string | null {
    R2CatalogImageStore.assertValidKey(key)
    const base = this.config.publicBaseUrl.replace(/\/+$/, '')
    return base === '' ? null : `${base}/${key.split('/').map(encodeURIComponent).join('/')}`
  }

  private static resolve(value: string, base: string): string | null {
    try {
      return new URL(value, base).href
    } catch {
      return null
    }
  }

  /** The content of every non-empty image meta tag in `html`, best-ranked first. Linear in the length of `html`. */
  private static imageMetaValues(html: string): string[] {
    const found = new Map<string, string>()
    // Lower-cased once, same length for ASCII tag names; offsets are only used to cut the original.
    const lower = html.toLowerCase()
    const headEnd = lower.indexOf('</head')
    const end = lower.length === html.length && headEnd !== -1 ? headEnd : html.length
    let position = 0
    for (let tags = 0; tags < R2CatalogImageStore.MAX_META_TAGS; tags++) {
      const start = lower.indexOf('<meta', position)
      if (start === -1 || start >= end) break
      const close = lower.indexOf('>', start)
      if (close === -1) break
      position = close + 1
      if (close - start > R2CatalogImageStore.MAX_META_TAG_LENGTH || lower.length !== html.length) continue
      const attributes = R2CatalogImageStore.attributesOf(html.slice(start + 5, close))
      const key = (attributes.get('property') ?? attributes.get('name'))?.trim().toLowerCase()
      const content = attributes.get('content')
      if (key && content !== undefined && !found.has(key)) found.set(key, R2CatalogImageStore.decodeEntities(content).trim())
    }
    const values: string[] = []
    for (const rank of R2CatalogImageStore.IMAGE_META_RANKS) {
      for (const key of rank) {
        const value = found.get(key)
        if (value) values.push(value)
      }
    }
    return values
  }

  /** The attributes of one tag's inside, names lower-cased, first occurrence kept. One forward pass; every iteration advances. */
  private static attributesOf(inside: string): Map<string, string> {
    const attributes = new Map<string, string>()
    const space = R2CatalogImageStore.WHITESPACE
    const length = inside.length
    let i = 0
    while (i < length) {
      while (i < length && (space.has(inside[i]!) || inside[i] === '/')) i++
      const nameStart = i
      while (i < length && !space.has(inside[i]!) && inside[i] !== '=' && inside[i] !== '/') i++
      const name = inside.slice(nameStart, i).toLowerCase()
      while (i < length && space.has(inside[i]!)) i++
      let value = ''
      if (inside[i] === '=') {
        i++
        while (i < length && space.has(inside[i]!)) i++
        const quote = inside[i]
        if (quote === '"' || quote === "'") {
          const closing = inside.indexOf(quote, i + 1)
          const valueEnd = closing === -1 ? length : closing
          value = inside.slice(i + 1, valueEnd)
          i = valueEnd + 1
        } else {
          const valueStart = i
          while (i < length && !space.has(inside[i]!)) i++
          value = inside.slice(valueStart, i)
        }
      } else if (i === nameStart) {
        i++
      }
      if (name !== '' && !attributes.has(name)) attributes.set(name, value)
    }
    return attributes
  }

  // One pass, so "&amp;#38;" decodes to "&#38;" and not further.
  private static decodeEntities(text: string): string {
    return text.replace(R2CatalogImageStore.ENTITY, (whole, hex: string | undefined, decimal: string | undefined, named: string | undefined) => {
      if (named) return R2CatalogImageStore.NAMED_ENTITIES[named.toLowerCase()] ?? whole
      const code = hex !== undefined ? parseInt(hex, 16) : Number(decimal)
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    })
  }

  private static isBlockedHost(url: string, suffixes: string[]): boolean {
    const host = new URL(url).hostname.replace(/\.+$/, '').toLowerCase()
    return suffixes.some((suffix) => {
      const blocked = suffix.replace(/^\.+|\.+$/g, '').toLowerCase()
      return blocked !== '' && (host === blocked || host.endsWith(`.${blocked}`))
    })
  }

  private static assertValidKey(key: string): void {
    if (!R2CatalogImageStore.KEY_PATTERN.test(key) || key.includes('..')) throw new Error(`Invalid catalog image key: ${JSON.stringify(key)}`)
  }
}
