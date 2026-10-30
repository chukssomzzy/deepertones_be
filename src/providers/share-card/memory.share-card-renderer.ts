import type { ProductImage } from '../product-analysis/product-analyst.provider'
import type { ShareCard, ShareCardLayout, ShareCardRenderer } from './share-card.provider'

/** Records what it was asked to draw and answers a fixed card. Set `failure` to make `render` throw it. For tests. */
export class MemoryShareCardRenderer implements ShareCardRenderer {
  readonly calls: { layout: ShareCardLayout; before: ProductImage; after: ProductImage; logo: ProductImage }[] = []
  failure: Error | null = null

  private readonly card: ShareCard

  constructor({ card = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), mediaType: 'image/png' } }: { card?: ShareCard } = {}) {
    this.card = card
  }

  async render(input: { layout: ShareCardLayout; before: ProductImage; after: ProductImage; logo: ProductImage }): Promise<ShareCard> {
    this.calls.push(input)
    if (this.failure) throw this.failure
    return this.card
  }
}
