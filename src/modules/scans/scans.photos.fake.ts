import type { ProductImage } from '../../providers/product-analysis/product-analyst.provider'

// Photo fixtures for the scan tests: the smallest headers readImageHeader accepts, with the size filled in, then zero padding.
// Written here from the file formats (not by calling the code under test) so a wrong size or type check fails.

const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0))
const u16 = (value: number) => [(value >> 8) & 0xff, value & 0xff]
const u32 = (value: number) => [...u16(value >>> 16), ...u16(value & 0xffff)]
const le24 = (value: number) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff]

const jpegHead = (width: number, height: number) => [0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, ...u16(height), ...u16(width)]
const pngHead = (width: number, height: number) => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32(13), ...ascii('IHDR'), ...u32(width), ...u32(height)]
const webpHead = (width: number, height: number) => [
  ...ascii('RIFF'),
  0x16,
  0x00,
  0x00,
  0x00,
  ...ascii('WEBP'),
  ...ascii('VP8X'),
  0x0a,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  ...le24(width - 1),
  ...le24(height - 1),
]

const fileOf = (head: number[], size?: number): Uint8Array => {
  const bytes = new Uint8Array(Math.max(size ?? 0, head.length + 16))
  bytes.set(head)
  return bytes
}

type Shape = { width?: number; height?: number; size?: number }

/** A JPEG whose header says width x height (default 800 x 600) and which is exactly `size` bytes (default a few dozen). */
export const jpegPhoto = ({ width = 800, height = 600, size }: Shape = {}): ProductImage => ({ bytes: fileOf(jpegHead(width, height), size), mediaType: 'image/jpeg' })

/** A WebP (extended format) with the same knobs. */
export const webpPhoto = ({ width = 800, height = 600, size }: Shape = {}): ProductImage => ({ bytes: fileOf(webpHead(width, height), size), mediaType: 'image/webp' })

/** A valid PNG: a real image, but not a type the scan accepts. */
export const pngPhoto = ({ width = 800, height = 600, size }: Shape = {}): ProductImage => ({ bytes: fileOf(pngHead(width, height), size), mediaType: 'image/png' })

/** Bytes with no image signature at all, claiming to be a JPEG. */
export const garbagePhoto = (): ProductImage => ({ bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]), mediaType: 'image/jpeg' })

/** A distinguishable JPEG: the same header, a marker byte after it, so two photos can be told apart in storage. */
export const markedJpeg = (marker: number): ProductImage => {
  const photo = jpegPhoto()
  photo.bytes[photo.bytes.length - 1] = marker
  return photo
}
