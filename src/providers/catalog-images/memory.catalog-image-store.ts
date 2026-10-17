import type { ProductImage } from '../product-analysis/product-analyst.provider'
import type { CatalogImageStore } from './catalog-image-store.provider'

/** Serves the images you set per URL, keeps what is put, and records every fetch. For tests. */
export class MemoryCatalogImageStore implements CatalogImageStore {
  private static readonly PUBLIC_BASE = 'https://images.test'

  readonly fetched: string[] = []
  readonly pageLookups: string[] = []
  readonly stored = new Map<string, ProductImage>()
  private readonly responses = new Map<string, ProductImage | null>()
  private readonly pageResponses = new Map<string, string | null>()

  /** `null` makes the URL answer null again, as if the download failed. */
  respondTo(url: string, image: ProductImage | null) {
    this.responses.set(url, image)
  }

  async fetchImage(url: string): Promise<ProductImage | null> {
    this.fetched.push(url)
    return this.responses.get(url) ?? null
  }

  /** The image URL a page's meta tags name; `null` makes the page answer null again. */
  respondToPage(pageUrl: string, imageUrl: string | null) {
    this.pageResponses.set(pageUrl, imageUrl)
  }

  async pageImageUrl(pageUrl: string): Promise<string | null> {
    this.pageLookups.push(pageUrl)
    return this.pageResponses.get(pageUrl) ?? null
  }

  async put(key: string, image: ProductImage): Promise<void> {
    this.stored.set(key, image)
  }

  async delete(key: string): Promise<void> {
    this.stored.delete(key)
  }

  publicUrl(key: string): string {
    return `${MemoryCatalogImageStore.PUBLIC_BASE}/${key}`
  }
}
