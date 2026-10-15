/** Widest or tallest image accepted; a header can claim any size, and a decoder downstream pays for it. */
export const MAX_DIMENSION = 4096

const ascii = (text: string): number[] => Array.from(text, (char) => char.charCodeAt(0))
const startsWith = (bytes: Uint8Array, signature: number[], offset = 0): boolean =>
  bytes.length >= offset + signature.length && signature.every((byte, i) => bytes[offset + i] === byte)

const u16be = (bytes: Uint8Array, at: number) => (bytes[at]! << 8) | bytes[at + 1]!
const u32be = (bytes: Uint8Array, at: number) => bytes[at]! * 2 ** 24 + (bytes[at + 1]! << 16) + (bytes[at + 2]! << 8) + bytes[at + 3]!

export type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/webp'

type Size = { width: number; height: number }

const JPEG = [0xff, 0xd8, 0xff]
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const RIFF = ascii('RIFF')
const WEBP = ascii('WEBP')

/**
 * What the bytes say they are, from the file header alone: the media type by signature and the size
 * from the format's own header. Null for anything else, for a header cut short, and for a width or
 * height of 0 or over MAX_DIMENSION. Never decodes pixels, so a decompression bomb costs nothing.
 */
export const readImageHeader = (bytes: Uint8Array): (Size & { mediaType: ImageMediaType }) | null => {
  let mediaType: ImageMediaType
  let size: Size | null
  if (startsWith(bytes, JPEG)) {
    mediaType = 'image/jpeg'
    size = jpegSize(bytes)
  } else if (startsWith(bytes, PNG)) {
    mediaType = 'image/png'
    size = pngSize(bytes)
  } else if (startsWith(bytes, RIFF) && startsWith(bytes, WEBP, 8)) {
    mediaType = 'image/webp'
    size = webpSize(bytes)
  } else {
    return null
  }
  if (!size || size.width < 1 || size.height < 1 || size.width > MAX_DIMENSION || size.height > MAX_DIMENSION) return null
  return { mediaType, ...size }
}

// IHDR is the first chunk: 8 signature bytes, 4 length, 4 type, then width and height.
const pngSize = (bytes: Uint8Array): Size | null => (bytes.length < 24 ? null : { width: u32be(bytes, 16), height: u32be(bytes, 20) })

// SOF0-SOF15 carry the frame size, except C4 (DHT), C8 (JPG) and CC (DAC), which share the range.
const isStartOfFrame = (marker: number) => marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc

const jpegSize = (bytes: Uint8Array): Size | null => {
  let at = 2
  while (at + 1 < bytes.length) {
    if (bytes[at] !== 0xff) return null
    const marker = bytes[at + 1]!
    if (marker === 0xff) {
      at += 1 // fill byte before a marker
      continue
    }
    if (isStartOfFrame(marker)) {
      // marker(2) length(2) precision(1) height(2) width(2)
      return at + 9 > bytes.length ? null : { height: u16be(bytes, at + 5), width: u16be(bytes, at + 7) }
    }
    // The scan or the end comes before any frame header: there is no size to find.
    if (marker === 0xda || marker === 0xd9) return null
    // Markers without a length: SOI, TEM and RST0-7.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      at += 2
      continue
    }
    if (at + 4 > bytes.length) return null
    const length = u16be(bytes, at + 2)
    if (length < 2) return null
    at += 2 + length
  }
  return null
}

// RIFF(4) size(4) WEBP(4), then the first chunk: type(4) size(4) data.
const webpSize = (bytes: Uint8Array): Size | null => {
  if (bytes.length < 16) return null
  const chunk = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!)
  if (chunk === 'VP8 ') {
    if (bytes.length < 30) return null
    return { width: (bytes[26]! | (bytes[27]! << 8)) & 0x3fff, height: (bytes[28]! | (bytes[29]! << 8)) & 0x3fff }
  }
  if (chunk === 'VP8L') {
    // Signature byte 0x2f at 20, then two 14-bit fields holding size - 1, packed little-endian.
    if (bytes.length < 25) return null
    const bits = (bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! << 24)) >>> 0
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (chunk === 'VP8X') {
    if (bytes.length < 30) return null
    return {
      width: 1 + (bytes[24]! | (bytes[25]! << 8) | (bytes[26]! << 16)),
      height: 1 + (bytes[27]! | (bytes[28]! << 8) | (bytes[29]! << 16)),
    }
  }
  return null
}
