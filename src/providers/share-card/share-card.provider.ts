import type { ProductImage } from '../product-analysis/product-analyst.provider'

/** Whole pixels from the canvas's top left corner. */
export type Rect = { left: number; top: number; width: number; height: number }

/**
 * A photo's place on the card. The box and the fit are all that can be asked of a photo: there is deliberately no key for colour, brightness, contrast, a filter or a blur, so
 * the card cannot edit a face. `contain` shows the whole photo inside the box (the rest of the box is the canvas colour); `cover` fills the box and crops the overflow.
 */
export type Placement = { rect: Rect; fit: 'cover' | 'contain' }

export type ShareCardLayout = {
  canvas: { width: number; height: number; background: string }
  photos: { before: Placement; after: Placement }
  /**
   * The before label first. Text is drawn from the rect's top left corner; the rect is the band reserved for it, sized for the label's `size` read as points (the larger of the
   * two readings of Cloudflare's text option) with line height and padding to spare. `size` is passed to the Images text overlay as it is.
   */
  labels: { text: string; rect: Rect; size: number; color: string }[]
  logo: { rect: Rect }
}

/** The finished card: the bytes of a PNG. */
export type ShareCard = { bytes: Uint8Array; mediaType: 'image/png' }

/**
 * Draws the before-and-after share card (spec #259): the day-one photo and a later one, each fitted into its box of the layout and never edited beyond that resize, with the
 * layout's labels and the logo. The card is returned to the caller; the renderer keeps nothing. Throws `ShareCardQuotaError` when the image service refuses for want of allowance, and the
 * vendor's own error for anything else.
 */
export interface ShareCardRenderer {
  render(input: { layout: ShareCardLayout; before: ProductImage; after: ProductImage; logo: ProductImage }): Promise<ShareCard>
}

/** The image service's free allowance is used up: it refuses new work until the month turns over, or until the account is upgraded. The owner is told; the user is not. */
export class ShareCardQuotaError extends Error {
  constructor() {
    super('The share card renderer is out of allowance')
    this.name = 'ShareCardQuotaError'
  }
}
