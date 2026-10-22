import { describe, expect, it } from 'vitest'
import { describeImageBytes } from './image-header'

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const u32 = (n: number) => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
const u16 = (n: number) => [(n >>> 8) & 0xff, n & 0xff]

/** A PNG up to and including its IHDR width and height. */
const png = (width: number, height: number) => new Uint8Array([...PNG_SIGNATURE, ...u32(13), 0x49, 0x48, 0x44, 0x52, ...u32(width), ...u32(height), 8, 6, 0, 0, 0])
/** A JPEG with an APP0 segment and then a baseline start-of-frame. */
const jpeg = (width: number, height: number, marker = 0xc0) =>
  new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...u16(4), 0, 0, 0xff, marker, ...u16(11), 8, ...u16(height), ...u16(width), 3, 1, 0x22, 0])

describe('describeImageBytes', () => {
  it('reads the format and the size of a PNG from its IHDR', () => {
    expect(describeImageBytes(png(1080, 1440))).toEqual({ format: 'png', width: 1080, height: 1440 })
  })

  it('reads the format and the size of a JPEG from its start-of-frame', () => {
    expect(describeImageBytes(jpeg(1080, 1440))).toEqual({ format: 'jpeg', width: 1080, height: 1440 })
    expect(describeImageBytes(jpeg(640, 480, 0xc2))).toEqual({ format: 'jpeg', width: 640, height: 480 })
  })

  it('does not hold a mask to the size limit a photo is held to: it reports what the header says', () => {
    expect(describeImageBytes(png(8000, 6000))).toEqual({ format: 'png', width: 8000, height: 6000 })
  })

  it('knows a PNG whose header is cut short, with no size', () => {
    expect(describeImageBytes(new Uint8Array([...PNG_SIGNATURE, 0, 0, 0, 0]))).toEqual({ format: 'png', width: null, height: null })
    expect(describeImageBytes(new Uint8Array(PNG_SIGNATURE))).toEqual({ format: 'png', width: null, height: null })
  })

  it('knows a JPEG with no frame header, with no size', () => {
    expect(describeImageBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2]))).toEqual({ format: 'jpeg', width: null, height: null })
    expect(describeImageBytes(new Uint8Array([0xff, 0xd8, 0xff]))).toEqual({ format: 'jpeg', width: null, height: null })
  })

  it('gives no size for a width or height of 0', () => {
    expect(describeImageBytes(png(0, 100))).toEqual({ format: 'png', width: null, height: null })
    expect(describeImageBytes(png(100, 0))).toEqual({ format: 'png', width: null, height: null })
  })

  it.each([
    ['empty', new Uint8Array()],
    ['text', new TextEncoder().encode('https://masks.test/age_spot.png?sig=abc')],
    ['a GIF', new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0])],
    ['a WebP', new Uint8Array([...new TextEncoder().encode('RIFF'), 0, 0, 0, 0, ...new TextEncoder().encode('WEBPVP8 '), ...new Array<number>(20).fill(0)])],
  ])('calls %s other, with no size', (_label, bytes) => {
    expect(describeImageBytes(bytes)).toEqual({ format: 'other', width: null, height: null })
  })

  it('reads only the header: a truncated body after it changes nothing', () => {
    expect(describeImageBytes(png(10, 20).subarray(0, 24))).toEqual({ format: 'png', width: 10, height: 20 })
  })
})
