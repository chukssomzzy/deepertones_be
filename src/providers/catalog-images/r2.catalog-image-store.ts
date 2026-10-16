import { firstValueFrom } from 'rxjs'
import { type HttpBytesResponse, HttpTooLargeError, HttpTransportError, requestBytes$ } from '../../lib/http'
import { readImageHeader } from '../../lib/image-header'
import { isSafePublicHttpsUrl } from '../../lib/url-safety'
import type { ProductImage } from '../product-analysis/product-analyst.provider'
import type { CatalogImageStore } from './catalog-image-store.provider'

export type R2CatalogImageStoreConfig = {
  /** The public catalog-image bucket for this environment. */
  bucket: R2Bucket
  /** Where the bucket is served from, e.g. https://images.deepertones.com; '' when it has no public address. */
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
  static readonly #DEFAULT_TIMEOUT_MS = 10_000
  static readonly #DEFAULT_MAX_BYTES = 5_000_000
  static readonly #MAX_REDIRECTS = 2
  static readonly #REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
  // One day, not immutable: a deleted or replaced image must stop being served soon (takedowns).
  static readonly #CACHE_CONTROL = 'public, max-age=86400'
  // Lowercase path segments of letters, digits, '.', '_' and '-'. A key that breaks this is our bug, not the vendor's.
  static readonly #KEY_PATTERN = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/

  readonly #config: R2CatalogImageStoreConfig

  constructor(config: R2CatalogImageStoreConfig) {
    this.#config = config
  }

  async fetchImage(url: string): Promise<ProductImage | null> {
    const { timeoutMs = R2CatalogImageStore.#DEFAULT_TIMEOUT_MS, maxBytes = R2CatalogImageStore.#DEFAULT_MAX_BYTES, blockedHostSuffixes = [] } = this.#config
    let current = url
    for (let redirects = 0; ; redirects++) {
      // Every hop, not just the first: a safe host can redirect to an internal one.
      if (!isSafePublicHttpsUrl(current) || R2CatalogImageStore.#isBlockedHost(current, blockedHostSuffixes)) return null
      let response: HttpBytesResponse
      try {
        response = await firstValueFrom(requestBytes$(current, { timeoutMs, maxBytes }))
      } catch (error) {
        if (error instanceof HttpTransportError || error instanceof HttpTooLargeError) return null
        throw error
      }

      if (!R2CatalogImageStore.#REDIRECT_STATUSES.has(response.status)) {
        if (!response.ok) return null
        // The header is the server's claim; only the bytes count.
        const header = readImageHeader(response.bytes)
        return header ? { bytes: response.bytes, mediaType: header.mediaType } : null
      }
      if (redirects === R2CatalogImageStore.#MAX_REDIRECTS || !response.location) return null
      try {
        current = new URL(response.location, current).href
      } catch {
        return null
      }
    }
  }

  async put(key: string, image: ProductImage): Promise<void> {
    R2CatalogImageStore.#assertValidKey(key)
    await this.#config.bucket.put(key, image.bytes, { httpMetadata: { contentType: image.mediaType, cacheControl: R2CatalogImageStore.#CACHE_CONTROL } })
  }

  async delete(key: string): Promise<void> {
    R2CatalogImageStore.#assertValidKey(key)
    await this.#config.bucket.delete(key)
  }

  publicUrl(key: string): string | null {
    R2CatalogImageStore.#assertValidKey(key)
    const base = this.#config.publicBaseUrl.replace(/\/+$/, '')
    return base === '' ? null : `${base}/${key.split('/').map(encodeURIComponent).join('/')}`
  }

  static #isBlockedHost(url: string, suffixes: string[]): boolean {
    const host = new URL(url).hostname.replace(/\.+$/, '').toLowerCase()
    return suffixes.some((suffix) => {
      const blocked = suffix.replace(/^\.+|\.+$/g, '').toLowerCase()
      return blocked !== '' && (host === blocked || host.endsWith(`.${blocked}`))
    })
  }

  static #assertValidKey(key: string): void {
    if (!R2CatalogImageStore.#KEY_PATTERN.test(key) || key.includes('..')) throw new Error(`Invalid catalog image key: ${JSON.stringify(key)}`)
  }
}
