import type { ProductImage } from '../product-analysis/product-analyst.provider'
import type { CatalogImageStore } from './catalog-image-store.provider'

const PUBLIC_BASE = 'https://images.test'

/** Serves the images you set per URL, keeps what is put, and records every fetch. For tests. */
export class MemoryCatalogImageStore implements CatalogImageStore {
  readonly fetched: string[] = []
  readonly stored = new Map<string, ProductImage>()
  private readonly responses = new Map<string, ProductImage | null>()

  /** `null` makes the URL answer null again, as if the download failed. */
  respondTo(url: string, image: ProductImage | null) {
    this.responses.set(url, image)
  }

  async fetchImage(url: string): Promise<ProductImage | null> {
    this.fetched.push(url)
    return this.responses.get(url) ?? null
  }

  async put(key: string, image: ProductImage): Promise<void> {
    this.stored.set(key, image)
  }

  async delete(key: string): Promise<void> {
    this.stored.delete(key)
  }

  publicUrl(key: string): string {
    return `${PUBLIC_BASE}/${key}`
  }
}
