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
  // In preference order; the first rank with a non-empty value wins.
  private static readonly IMAGE_META_RANKS = [['og:image'], ['og:image:secure_url', 'og:image:url'], ['twitter:image']]
  private static readonly META_TAG = /<meta\b[^>]*>/gi
  private static readonly ATTRIBUTE = /([^\s"'<>/=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g
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
      const value = R2CatalogImageStore.imageMetaValue(new TextDecoder().decode(response.bytes))
      if (value === null) return null
      const resolved = new URL(value, response.url).href
      return isSafePublicHttpsUrl(resolved) ? resolved : null
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

  /** The content of the best-ranked image meta tag in `html`, or null. */
  private static imageMetaValue(html: string): string | null {
    const found = new Map<string, string>()
    for (const [tag] of html.matchAll(R2CatalogImageStore.META_TAG)) {
      const attributes = new Map<string, string>()
      for (const match of tag.matchAll(R2CatalogImageStore.ATTRIBUTE)) {
        const name = match[1]!.toLowerCase()
        if (!attributes.has(name)) attributes.set(name, match[2] ?? match[3] ?? match[4] ?? '')
      }
      const key = (attributes.get('property') ?? attributes.get('name'))?.trim().toLowerCase()
      const content = attributes.get('content')
      if (key && content !== undefined && !found.has(key)) found.set(key, R2CatalogImageStore.decodeEntities(content).trim())
    }
    for (const rank of R2CatalogImageStore.IMAGE_META_RANKS) {
      for (const key of rank) {
        const value = found.get(key)
        if (value) return value
      }
    }
    return null
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
