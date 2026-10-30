import type { ProductImage } from '../product-analysis/product-analyst.provider'
import { type Placement, type ShareCard, ShareCardQuotaError, type ShareCardLayout, type ShareCardRenderer } from './share-card.provider'

export type CloudflareImagesShareCardRendererConfig = {
  /** The Images binding, env.IMAGES. */
  images: ImagesBinding
  /** A public .ttf, .otf, .woff or .woff2 file: the Images service fetches it to draw the labels. */
  fontUrl: string
}

/** What Cloudflare Images answers with once the free plan's 5,000 unique transformations a month are used: new transformations are refused with this error code. */
const QUOTA_ERROR_CODE = 9422

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (bytes: Uint8Array): number => {
  let c = 0xffffffff
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/**
 * A 1 x 1 PNG of one #rrggbb colour. The Images binding can only start from an image, never from a colour, so the card's plain background is this pixel stretched to the
 * canvas. Hand-built (a stored zlib block, no compression) to need no library.
 */
const solidPixelPng = (hex: string): Uint8Array => {
  const rgb = [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16))
  const chunk = (type: string, data: number[]): number[] => {
    const body = new Uint8Array([...Array.from(type, (character) => character.charCodeAt(0)), ...data])
    const view = new DataView(new ArrayBuffer(4))
    view.setUint32(0, data.length)
    const length = Array.from(new Uint8Array(view.buffer))
    view.setUint32(0, crc32(body))
    return [...length, ...body, ...new Uint8Array(view.buffer)]
  }
  const be32 = (value: number) => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
  const scanline = [0, ...rgb]
  let a = 1
  let b = 0
  for (const byte of scanline) {
    a = (a + byte) % 65521
    b = (b + a) % 65521
  }
  const adler = ((b << 16) | a) >>> 0
  // zlib: header, one final stored block (length 4), the scanline, the Adler-32 of the scanline.
  const idat = [0x78, 0x01, 0x01, 0x04, 0x00, 0xfb, 0xff, ...scanline, ...be32(adler)]
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk('IHDR', [...be32(1), ...be32(1), 8, 2, 0, 0, 0]), ...chunk('IDAT', idat), ...chunk('IEND', [])])
}

/** Where an overlay goes: only its corner, since its size is set on the overlay itself. */
const at = ({ top, left }: { top: number; left: number }) => ({ top, left })

const streamOf = (bytes: Uint8Array): ReadableStream<Uint8Array> => new Response(bytes).body!

/** Whether the error is the Images binding's quota refusal. `ImagesError` is an interface, not a class, so it is told by its code. */
const isQuotaRefusal = (error: unknown): boolean => typeof error === 'object' && error !== null && 'code' in error && error.code === QUOTA_ERROR_CODE

/**
 * Draws the share card on Cloudflare Images: a canvas of the layout's colour, the two photos each fitted into its box, the labels, the logo, as a PNG. The photos only ever
 * pass through `width`, `height` and `fit` (and the canvas colour behind a `contain`): nothing here can change a pixel of a face.
 */
export class CloudflareImagesShareCardRenderer implements ShareCardRenderer {
  private readonly images: ImagesBinding
  private readonly fontUrl: string

  constructor({ images, fontUrl }: CloudflareImagesShareCardRendererConfig) {
    this.images = images
    this.fontUrl = fontUrl
  }

  async render({ layout, before, after, logo }: { layout: ShareCardLayout; before: ProductImage; after: ProductImage; logo: ProductImage }): Promise<ShareCard> {
    try {
      const { canvas } = layout
      let card = this.images.input(streamOf(solidPixelPng(canvas.background))).transform({ width: canvas.width, height: canvas.height, fit: 'squeeze' })
      card = card.draw(this.photo(before, layout.photos.before, canvas.background), at(layout.photos.before.rect))
      card = card.draw(this.photo(after, layout.photos.after, canvas.background), at(layout.photos.after.rect))
      for (const { text, rect, size, color } of layout.labels) card = card.draw(this.images.text(text, { font: { url: this.fontUrl }, size, color }), at(rect))
      card = card.draw(this.images.input(streamOf(logo.bytes)).transform({ width: layout.logo.rect.width, height: layout.logo.rect.height }), at(layout.logo.rect))
      const result = await card.output({ format: 'image/png' })
      return { bytes: new Uint8Array(await new Response(result.image()).arrayBuffer()), mediaType: 'image/png' }
    } catch (error) {
      if (isQuotaRefusal(error)) throw new ShareCardQuotaError()
      throw error
    }
  }

  /** One photo resized into its box. `contain` is Images' `pad`, which fills the rest of the box with the canvas colour so the overlay is exactly the box. */
  private photo(image: ProductImage, { rect, fit }: Placement, background: string): ImageTransformer {
    const size = { width: rect.width, height: rect.height }
    return this.images.input(streamOf(image.bytes)).transform(fit === 'cover' ? { ...size, fit: 'cover' } : { ...size, fit: 'pad', background })
  }
}
