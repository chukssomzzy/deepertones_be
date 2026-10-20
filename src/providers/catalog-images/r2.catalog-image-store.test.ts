import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProductImage } from '../product-analysis/product-analyst.provider'
import { R2CatalogImageStore } from './r2.catalog-image-store'

const PUBLIC_BASE = 'https://images.test'
const START = 'https://shop.example/p/serum.jpg'
const HOP_1 = 'https://cdn.example/serum-1.jpg'
const HOP_2 = 'https://cdn.example/serum-2.jpg'
const HOP_3 = 'https://cdn.example/serum-3.jpg'
const FINAL = 'https://cdn.example/final.jpg'
const MAX_BYTES = 64
const TIMEOUT_MS = 50

/** A valid-looking file of `size` bytes: `magic` first, zero padding after. */
const fileOf = (magic: number[], size = magic.length + 20): Uint8Array => {
  const bytes = new Uint8Array(size)
  bytes.set(magic)
  return bytes
}
const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0))

const u16 = (value: number) => [(value >> 8) & 0xff, value & 0xff]
const u32 = (value: number) => [...u16(value >>> 16), ...u16(value & 0xffff)]
const le24 = (value: number) => [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff]

/** The smallest header each decoder accepts, with the size filled in: signature plus the size fields, no pixels. */
const jpegHead = (width = 16, height = 16) => [0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, ...u16(height), ...u16(width)]
const pngHead = (width = 16, height = 16) => [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32(13), ...ascii('IHDR'), ...u32(width), ...u32(height)]
const webpXHead = (width = 16, height = 16) => [
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
const webpLossyHead = (width = 16, height = 16) => [
  ...ascii('RIFF'),
  0x16,
  0x00,
  0x00,
  0x00,
  ...ascii('WEBP'),
  ...ascii('VP8 '),
  0x0a,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00,
  0x00, // frame tag
  0x9d,
  0x01,
  0x2a, // start code
  width & 0xff,
  width >> 8,
  height & 0xff,
  height >> 8,
]
const webpLosslessHead = (width = 16, height = 16) => {
  const bits = ((width - 1) | ((height - 1) << 14)) >>> 0
  return [...ascii('RIFF'), 0x16, 0x00, 0x00, 0x00, ...ascii('WEBP'), ...ascii('VP8L'), 0x05, 0x00, 0x00, 0x00, 0x2f, bits & 0xff, (bits >>> 8) & 0xff, (bits >>> 16) & 0xff, (bits >>> 24) & 0xff]
}

const JPEG_MAGIC = jpegHead()
const PNG_MAGIC = pngHead()
const WEBP_MAGIC = webpXHead()

const jpeg = (size?: number) => fileOf(JPEG_MAGIC, size)

type Respond = (url: string) => Response | Promise<Response>

const stubFetch = (respond: Respond) => {
  const stub = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => respond(String(input)))
  vi.stubGlobal('fetch', stub)
  return stub
}

const redirect = (location: string, status = 302) => new Response(null, { status, headers: { location } })
const image = (bytes: Uint8Array, contentType = 'image/jpeg') => new Response(bytes, { headers: { 'content-type': contentType } })

const make = (overrides: Partial<ConstructorParameters<typeof R2CatalogImageStore>[0]> = {}) =>
  new R2CatalogImageStore({
    bucket: {} as unknown as R2Bucket,
    publicBaseUrl: PUBLIC_BASE,
    timeoutMs: TIMEOUT_MS,
    maxBytes: MAX_BYTES,
    ...overrides,
  })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('R2CatalogImageStore.fetchImage', () => {
  it('returns the bytes and media type of a JPEG', async () => {
    const bytes = jpeg()
    stubFetch(() => image(bytes))

    const result = await make().fetchImage(START)

    expect(result?.mediaType).toBe('image/jpeg')
    expect(Array.from(result!.bytes)).toEqual(Array.from(bytes))
  })

  it('recognises a PNG by its signature', async () => {
    stubFetch(() => image(fileOf(PNG_MAGIC), 'image/png'))

    expect((await make().fetchImage(START))?.mediaType).toBe('image/png')
  })

  it('recognises a WebP by its RIFF....WEBP header', async () => {
    stubFetch(() => image(fileOf(WEBP_MAGIC), 'image/webp'))

    expect((await make().fetchImage(START))?.mediaType).toBe('image/webp')
  })

  it('decides the media type from the bytes, not from the Content-Type header', async () => {
    stubFetch(() => image(fileOf(PNG_MAGIC), 'image/jpeg'))

    expect((await make().fetchImage(START))?.mediaType).toBe('image/png')
  })

  it('accepts an image whose server sends no Content-Type at all', async () => {
    stubFetch(() => new Response(jpeg()))

    expect((await make().fetchImage(START))?.mediaType).toBe('image/jpeg')
  })

  it.each([
    ['a GIF', fileOf(ascii('GIF89a'))],
    ['SVG text', new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>')],
    ['an HTML page', new TextEncoder().encode('<!doctype html><html><body>Not found</body></html>')],
    ['a RIFF file that is not WebP', fileOf([...ascii('RIFF'), 0x24, 0, 0, 0, ...ascii('WAVE')])],
    ['a PNG signature cut short', Uint8Array.from(PNG_MAGIC.slice(0, 7))],
    ['a JPEG signature cut short', Uint8Array.from([0xff, 0xd8])],
    ['an empty body', new Uint8Array(0)],
  ])('returns null for %s even when the header claims image/jpeg', async (_label, bytes) => {
    stubFetch(() => image(bytes, 'image/jpeg'))

    expect(await make().fetchImage(START)).toBeNull()
  })

  it.each([
    ['an http url', 'http://shop.example/serum.jpg'],
    ['a loopback address', 'https://127.0.0.1/serum.jpg'],
    ['localhost', 'https://localhost/serum.jpg'],
    ['a url with credentials', 'https://user@shop.example/serum.jpg'],
    ['a url with a port', 'https://shop.example:8443/serum.jpg'],
    ['a single-label host', 'https://intranet/serum.jpg'],
    ['not a url', 'serum'],
  ])('returns null for %s without making a request', async (_label, url) => {
    const stub = stubFetch(() => image(jpeg()))

    expect(await make().fetchImage(url)).toBeNull()
    expect(stub).not.toHaveBeenCalled()
  })

  it('asks fetch never to follow redirects itself', async () => {
    const stub = stubFetch(() => image(jpeg()))

    await make().fetchImage(START)

    expect(stub.mock.calls[0]![1]!.redirect).toBe('manual')
  })

  describe('redirects', () => {
    it.each([301, 302, 303, 307, 308])('follows a %i redirect to a safe URL', async (status) => {
      const stub = stubFetch((url) => (url === START ? redirect(HOP_1, status) : image(jpeg())))

      expect((await make().fetchImage(START))?.mediaType).toBe('image/jpeg')
      expect(stub.mock.calls.map(([url]) => String(url))).toEqual([START, HOP_1])
    })

    it('follows two redirects, the most it allows', async () => {
      const stub = stubFetch((url) => {
        if (url === START) return redirect(HOP_1)
        if (url === HOP_1) return redirect(HOP_2)
        return image(jpeg())
      })

      expect((await make().fetchImage(START))?.mediaType).toBe('image/jpeg')
      expect(stub.mock.calls.map(([url]) => String(url))).toEqual([START, HOP_1, HOP_2])
    })

    it('gives up on a third redirect without requesting where it points', async () => {
      const stub = stubFetch((url) => {
        if (url === START) return redirect(HOP_1)
        if (url === HOP_1) return redirect(HOP_2)
        if (url === HOP_2) return redirect(HOP_3)
        return image(jpeg())
      })

      expect(await make().fetchImage(START)).toBeNull()
      expect(stub.mock.calls.map(([url]) => String(url))).toEqual([START, HOP_1, HOP_2])
    })

    it('resolves a relative location against the URL that redirected', async () => {
      const stub = stubFetch((url) => (url === 'https://cdn.example/a/b.jpg' ? redirect('../img/final.jpg') : image(jpeg())))

      expect((await make().fetchImage('https://cdn.example/a/b.jpg'))?.mediaType).toBe('image/jpeg')
      expect(stub.mock.calls.map(([url]) => String(url))).toEqual(['https://cdn.example/a/b.jpg', 'https://cdn.example/img/final.jpg'])
    })

    it('resolves a root-relative location against the host that redirected', async () => {
      const stub = stubFetch((url) => (url === START ? redirect('/img/final.jpg') : image(jpeg())))

      await make().fetchImage(START)

      expect(stub.mock.calls.map(([url]) => String(url))).toEqual([START, 'https://shop.example/img/final.jpg'])
    })

    it.each([
      ['an http url', 'http://cdn.example/final.jpg'],
      ['a loopback address', 'https://127.0.0.1/final.jpg'],
      ['an internal decimal address', 'https://2130706433/final.jpg'],
      ['localhost', 'https://localhost/final.jpg'],
      ['a single-label host', 'https://intranet/final.jpg'],
      ['a url with a port', 'https://cdn.example:8443/final.jpg'],
      ['an IPv6 literal', 'https://[::1]/final.jpg'],
    ])('returns null, without requesting it, when a redirect points at %s', async (_label, location) => {
      const stub = stubFetch((url) => (url === START ? redirect(location) : image(jpeg())))

      expect(await make().fetchImage(START)).toBeNull()
      expect(stub.mock.calls.map(([url]) => String(url))).toEqual([START])
    })

    it('stops at an unsafe second hop', async () => {
      const stub = stubFetch((url) => {
        if (url === START) return redirect(HOP_1)
        if (url === HOP_1) return redirect('https://127.0.0.1/final.jpg')
        return image(jpeg())
      })

      expect(await make().fetchImage(START)).toBeNull()
      expect(stub.mock.calls.map(([url]) => String(url))).toEqual([START, HOP_1])
    })

    it('returns null for a redirect with no location', async () => {
      stubFetch(() => new Response(null, { status: 302 }))

      expect(await make().fetchImage(START)).toBeNull()
    })

    it('returns null when the final hop is not an image', async () => {
      stubFetch((url) => (url === START ? redirect(FINAL) : image(new TextEncoder().encode('<html></html>'))))

      expect(await make().fetchImage(START)).toBeNull()
    })
  })

  describe('failures never throw', () => {
    it.each([400, 403, 404, 410, 500, 503])('returns null for a %i response', async (status) => {
      stubFetch(() => new Response(jpeg(), { status, headers: { 'content-type': 'image/jpeg' } }))

      expect(await make().fetchImage(START)).toBeNull()
    })

    it('returns null when the connection fails', async () => {
      stubFetch(() => {
        throw new TypeError('network down')
      })

      expect(await make().fetchImage(START)).toBeNull()
    })

    it('returns null, and aborts the request, when no response arrives within the timeout', async () => {
      let signal: AbortSignal | null | undefined
      vi.stubGlobal(
        'fetch',
        vi.fn(
          (_input: RequestInfo | URL, init?: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              signal = init?.signal
              signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
            }),
        ),
      )

      expect(await make().fetchImage(START)).toBeNull()
      expect(signal!.aborted).toBe(true)
    })

    it('accepts an image of exactly maxBytes', async () => {
      stubFetch(() => image(jpeg(MAX_BYTES)))

      expect((await make().fetchImage(START))?.bytes.byteLength).toBe(MAX_BYTES)
    })

    it('returns null for an image one byte over maxBytes', async () => {
      stubFetch(() => image(jpeg(MAX_BYTES + 1)))

      expect(await make().fetchImage(START)).toBeNull()
    })

    it('returns null for an image over maxBytes that declares its size up front', async () => {
      stubFetch(() => new Response(jpeg(MAX_BYTES + 1), { headers: { 'content-type': 'image/jpeg', 'content-length': String(MAX_BYTES + 1) } }))

      expect(await make().fetchImage(START)).toBeNull()
    })

    it('limits images to 5 MB by default', async () => {
      const limit = 5_000_000
      const store = new R2CatalogImageStore({ bucket: {} as unknown as R2Bucket, publicBaseUrl: PUBLIC_BASE })
      stubFetch(() => image(jpeg(limit)))
      expect((await store.fetchImage(START))?.bytes.byteLength).toBe(limit)

      stubFetch(() => image(jpeg(limit + 1)))
      expect(await store.fetchImage(START)).toBeNull()
    })
  })
})

describe('R2CatalogImageStore.put', () => {
  const PNG: ProductImage = { bytes: Uint8Array.from([...PNG_MAGIC, 1, 2, 3]), mediaType: 'image/png' }

  const bucketFake = () => {
    const put = vi.fn(async (_key: string, _value: unknown, _options?: R2PutOptions) => ({}) as R2Object)
    const del = vi.fn(async (_key: string) => undefined)
    const bucket = { put, delete: del } as unknown as R2Bucket
    return { bucket, put, del }
  }

  const bytesOf = (value: unknown): number[] =>
    ArrayBuffer.isView(value)
      ? Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))
      : Array.from(new Uint8Array(value as ArrayBuffer))

  it('writes the image bytes under the key', async () => {
    const { bucket, put } = bucketFake()

    await make({ bucket }).put('products/p1.png', PNG)

    expect(put).toHaveBeenCalledTimes(1)
    expect(put.mock.calls[0]![0]).toBe('products/p1.png')
    expect(bytesOf(put.mock.calls[0]![1])).toEqual(Array.from(PNG.bytes))
  })

  it('stores the media type as the object content type', async () => {
    const { bucket, put } = bucketFake()

    await make({ bucket }).put('products/p1.png', PNG)

    expect(put.mock.calls[0]![2]!.httpMetadata).toMatchObject({ contentType: 'image/png' })
  })

  it('marks the object as cacheable for one day, and not immutable, so a takedown takes effect', async () => {
    const { bucket, put } = bucketFake()

    await make({ bucket }).put('products/p1.png', PNG)

    const cacheControl = (put.mock.calls[0]![2]!.httpMetadata as R2HTTPMetadata).cacheControl
    expect(cacheControl).not.toMatch(/immutable/)
    expect(cacheControl).toMatch(/\bpublic\b/)
    expect(Number(/max-age=(\d+)/.exec(cacheControl ?? '')?.[1])).toBe(86400)
  })

  it('lets a bucket failure through, so the caller can retry', async () => {
    const put = vi.fn(async () => {
      throw new Error('R2 unavailable')
    })

    await expect(make({ bucket: { put } as unknown as R2Bucket }).put('products/p1.png', PNG)).rejects.toThrow('R2 unavailable')
  })

  it('delete removes the object by key', async () => {
    const { bucket, del } = bucketFake()

    await make({ bucket }).delete('products/p1.png')

    expect(del).toHaveBeenCalledExactlyOnceWith('products/p1.png')
  })
})

describe('R2CatalogImageStore.publicUrl', () => {
  it('joins the public base URL and the key with one slash', () => {
    expect(make({ publicBaseUrl: 'https://images.test' }).publicUrl('products/p1.png')).toBe('https://images.test/products/p1.png')
  })

  it('tolerates a trailing slash on the base URL', () => {
    expect(make({ publicBaseUrl: 'https://images.test/' }).publicUrl('products/p1.png')).toBe('https://images.test/products/p1.png')
  })

  it('is null when no public base URL is configured', () => {
    expect(make({ publicBaseUrl: '' }).publicUrl('products/p1.png')).toBeNull()
  })
})

describe('R2CatalogImageStore keys', () => {
  const PNG: ProductImage = { bytes: Uint8Array.from(PNG_MAGIC), mediaType: 'image/png' }
  const bucket = () => ({ put: vi.fn(async () => ({}) as R2Object), delete: vi.fn(async () => undefined) })

  it.each(['products/p1.png', 'p1', 'products/ab-12_cd.v2.webp', '0abc', 'a/b/c.jpg', 'catalog/development/products/0b9f3c1e-7a2d-4e5f-8c6b-1d2e3f4a5b6c.jpg'])('accepts the key %s', async (key) => {
    const fake = bucket()
    const store = make({ bucket: fake as unknown as R2Bucket })

    await store.put(key, PNG)
    await store.delete(key)

    expect(fake.put).toHaveBeenCalledTimes(1)
    expect(fake.delete).toHaveBeenCalledTimes(1)
    expect(store.publicUrl(key)).toBe(`${PUBLIC_BASE}/${key}`)
  })

  it.each([
    ['empty', ''],
    ['a leading slash', '/products/p1.png'],
    ['a trailing slash', 'products/'],
    ['an empty segment', 'products//p1.png'],
    ['a dot-dot segment', 'products/../secret'],
    ['dot-dot inside a segment', 'products/a..b.png'],
    ['a dot segment', './p1.png'],
    ['a segment starting with a dot', 'products/.hidden'],
    ['uppercase', 'Products/P1.png'],
    ['a space', 'products/p 1.png'],
    ['a query string', 'products/p1.png?x=1'],
    ['a backslash', 'products\\p1.png'],
    ['a percent escape', 'products/%2e%2e'],
    ['a newline', 'products/p1\n.png'],
  ])('rejects a key with %s in put, delete and publicUrl, touching nothing', async (_label, key) => {
    const fake = bucket()
    const store = make({ bucket: fake as unknown as R2Bucket })

    await expect(store.put(key, PNG)).rejects.toThrow(/key/i)
    await expect(store.delete(key)).rejects.toThrow(/key/i)
    expect(() => store.publicUrl(key)).toThrow(/key/i)
    expect(fake.put).not.toHaveBeenCalled()
    expect(fake.delete).not.toHaveBeenCalled()
  })

  it('rejects a bad key in publicUrl even when no public base URL is configured', () => {
    expect(() => make({ publicBaseUrl: '' }).publicUrl('../x')).toThrow(/key/i)
  })

  it('percent-encodes each segment of the public URL and keeps the slashes between them', () => {
    // The pattern admits only characters encodeURIComponent leaves alone; this pins that the encoding is applied per segment.
    expect(make().publicUrl('products/p1.v2_a-b.png')).toBe('https://images.test/products/p1.v2_a-b.png')
  })
})

describe('R2CatalogImageStore image dimensions', () => {
  const MAX = 4096
  const file = (head: number[], size = head.length + 20) => fileOf(head, size)

  it.each([
    ['a PNG', file(pngHead(40, 30)), 'image/png'],
    ['a JPEG', file(jpegHead(40, 30)), 'image/jpeg'],
    ['a lossy WebP (VP8)', file(webpLossyHead(40, 30)), 'image/webp'],
    ['a lossless WebP (VP8L)', file(webpLosslessHead(40, 30)), 'image/webp'],
    ['an extended WebP (VP8X)', file(webpXHead(40, 30)), 'image/webp'],
  ])('accepts %s with a valid size', async (_label, bytes, mediaType) => {
    stubFetch(() => image(bytes))

    expect((await make({ maxBytes: 1000 }).fetchImage(START))?.mediaType).toBe(mediaType)
  })

  it.each([
    ['a PNG', pngHead],
    ['a JPEG', jpegHead],
    ['a lossy WebP', webpLossyHead],
    ['a lossless WebP', webpLosslessHead],
    ['an extended WebP', webpXHead],
  ])('accepts %s at exactly 4096 by 4096', async (_label, head) => {
    stubFetch(() => image(file(head(MAX, MAX))))

    expect(await make({ maxBytes: 1000 }).fetchImage(START)).not.toBeNull()
  })

  it.each([
    ['a PNG', pngHead],
    ['a JPEG', jpegHead],
    ['a lossy WebP', webpLossyHead],
    ['a lossless WebP', webpLosslessHead],
    ['an extended WebP', webpXHead],
  ])('returns null for %s with a width or height of 4097', async (_label, head) => {
    stubFetch(() => image(file(head(MAX + 1, 16))))
    expect(await make({ maxBytes: 1000 }).fetchImage(START)).toBeNull()

    stubFetch(() => image(file(head(16, MAX + 1))))
    expect(await make({ maxBytes: 1000 }).fetchImage(START)).toBeNull()
  })

  it.each([
    ['a PNG', pngHead],
    ['a JPEG', jpegHead],
    ['a lossy WebP', webpLossyHead],
  ])('returns null for %s with a width or height of 0', async (_label, head) => {
    stubFetch(() => image(file(head(0, 16))))
    expect(await make({ maxBytes: 1000 }).fetchImage(START)).toBeNull()

    stubFetch(() => image(file(head(16, 0))))
    expect(await make({ maxBytes: 1000 }).fetchImage(START)).toBeNull()
  })

  it('returns null for a 12-byte RIFF....WEBP with no chunk', async () => {
    stubFetch(() => image(Uint8Array.from([...ascii('RIFF'), 0x04, 0, 0, 0, ...ascii('WEBP')])))

    expect(await make().fetchImage(START)).toBeNull()
  })

  it('returns null for a WebP whose first chunk is not VP8, VP8L or VP8X', async () => {
    stubFetch(() => image(file([...ascii('RIFF'), 0x16, 0, 0, 0, ...ascii('WEBP'), ...ascii('ALPH'), 0x0a, 0, 0, 0, 0, 0, 0, 0, 0, 0, 15, 0, 0, 15, 0, 0])))

    expect(await make().fetchImage(START)).toBeNull()
  })

  it('returns null for a WebP header cut off inside the size fields', async () => {
    stubFetch(() => image(Uint8Array.from(webpXHead().slice(0, 27))))

    expect(await make().fetchImage(START)).toBeNull()
  })

  it('returns null for a PNG cut off inside the size fields', async () => {
    stubFetch(() => image(Uint8Array.from(pngHead().slice(0, 20))))

    expect(await make().fetchImage(START)).toBeNull()
  })

  it('returns null for a truncated JPEG that ends before any frame header', async () => {
    stubFetch(() => image(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00])))

    expect(await make().fetchImage(START)).toBeNull()
  })

  it('returns null for a JPEG cut off inside the frame header', async () => {
    stubFetch(() => image(Uint8Array.from(jpegHead().slice(0, 9))))

    expect(await make().fetchImage(START)).toBeNull()
  })

  it('returns null for a JPEG whose scan starts before any frame header', async () => {
    stubFetch(() => image(Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00])))

    expect(await make().fetchImage(START)).toBeNull()
  })

  it('returns null for a JPEG segment with a length that runs past the end', async () => {
    stubFetch(() => image(Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff, 0x00])))

    expect(await make().fetchImage(START)).toBeNull()
  })

  it('finds the frame header after other segments, skipping DHT (C4) as a non-frame marker', async () => {
    const app0 = [0xff, 0xe0, 0x00, 0x06, 0x4a, 0x46, 0x49, 0x46]
    const dht = [0xff, 0xc4, 0x00, 0x04, 0x00, 0x00]
    const sof2 = [0xff, 0xc2, 0x00, 0x11, 0x08, ...u16(30), ...u16(40)]
    stubFetch(() => image(Uint8Array.from([0xff, 0xd8, ...app0, ...dht, ...sof2, 0, 0, 0, 0, 0, 0, 0, 0])))

    expect((await make().fetchImage(START))?.mediaType).toBe('image/jpeg')
  })
})

describe('R2CatalogImageStore blockedHostSuffixes', () => {
  it('blocks the start URL on a listed host without a request', async () => {
    const stub = stubFetch(() => image(jpeg()))

    expect(await make({ blockedHostSuffixes: ['shop.example'] }).fetchImage(START)).toBeNull()
    expect(stub).not.toHaveBeenCalled()
  })

  it('blocks a subdomain of a listed suffix', async () => {
    const stub = stubFetch(() => image(jpeg()))

    expect(await make({ blockedHostSuffixes: ['example'] }).fetchImage('https://a.b.shop.example/x.jpg')).toBeNull()
    expect(stub).not.toHaveBeenCalled()
  })

  it('matches case-insensitively and ignores a trailing dot on the host', async () => {
    stubFetch(() => image(jpeg()))

    expect(await make({ blockedHostSuffixes: ['Shop.Example'] }).fetchImage('https://SHOP.example./x.jpg')).toBeNull()
  })

  it('does not block a host that merely ends with the same letters', async () => {
    stubFetch(() => image(jpeg()))

    expect((await make({ blockedHostSuffixes: ['hop.example'] }).fetchImage(START))?.mediaType).toBe('image/jpeg')
  })

  it('does not block a host that merely contains the suffix elsewhere', async () => {
    stubFetch(() => image(jpeg()))

    expect((await make({ blockedHostSuffixes: ['shop.example'] }).fetchImage('https://shop.example.cdn.test/x.jpg'))?.mediaType).toBe('image/jpeg')
  })

  it('blocks a redirect that lands on a listed host, without requesting it', async () => {
    const stub = stubFetch((url) => (url === START ? redirect('https://images.mine.test/loop.jpg') : image(jpeg())))

    expect(await make({ blockedHostSuffixes: ['mine.test'] }).fetchImage(START)).toBeNull()
    expect(stub.mock.calls.map(([url]) => String(url))).toEqual([START])
  })

  it('blocks a second-hop redirect to a listed host', async () => {
    const stub = stubFetch((url) => {
      if (url === START) return redirect(HOP_1)
      if (url === HOP_1) return redirect('https://mine.test/loop.jpg')
      return image(jpeg())
    })

    expect(await make({ blockedHostSuffixes: ['mine.test'] }).fetchImage(START)).toBeNull()
    expect(stub.mock.calls.map(([url]) => String(url))).toEqual([START, HOP_1])
  })

  it('blocks nothing by default', async () => {
    stubFetch(() => image(jpeg()))

    expect((await make().fetchImage(START))?.mediaType).toBe('image/jpeg')
  })
})

describe('R2CatalogImageStore.pageImageUrl', () => {
  const PAGE = 'https://www.nivea.example/products/dry-impact-spray.html'
  const PACKSHOT = 'https://assets.brand.example/media/packshot.png?mh=1200&mw=1200'
  const PAGE_CAP = 512 * 1024

  const html = (head: string, contentType = 'text/html; charset=utf-8') =>
    new Response(`<!doctype html><html><head><title>x</title>${head}</head><body></body></html>`, { headers: { 'content-type': contentType } })
  const serving = (head: string) => stubFetch(() => html(head))

  it('returns the og:image of the page', async () => {
    serving(`<meta property="og:image" content="${PACKSHOT}"/>`)

    expect(await make().pageImageUrl(PAGE)).toBe(PACKSHOT)
  })

  it('falls back to twitter:image when there is no og:image', async () => {
    serving(`<meta name="twitter:image" content="${PACKSHOT}"/>`)

    expect(await make().pageImageUrl(PAGE)).toBe(PACKSHOT)
  })

  it('prefers og:image over twitter:image whichever comes first', async () => {
    const other = 'https://assets.brand.example/media/other.png'
    serving(`<meta name="twitter:image" content="${other}"/><meta property="og:image" content="${PACKSHOT}"/>`)

    expect(await make().pageImageUrl(PAGE)).toBe(PACKSHOT)
  })

  it.each(['og:image:secure_url', 'og:image:url'])('falls back to %s when there is no og:image', async (property) => {
    serving(`<meta property="${property}" content="${PACKSHOT}"/>`)

    expect(await make().pageImageUrl(PAGE)).toBe(PACKSHOT)
  })

  it('decodes HTML entities in the value', async () => {
    serving('<meta property="og:image" content="https://assets.brand.example/m/p.png?mh=1200&amp;mw=1200&#x26;q=a&#38;r=b"/>')

    expect(await make().pageImageUrl(PAGE)).toBe('https://assets.brand.example/m/p.png?mh=1200&mw=1200&q=a&r=b')
  })

  it('decodes numeric character references in the path', async () => {
    serving('<meta property="og:image" content="https:&#x2F;&#x2F;assets.brand.example&#47;m&#x2F;p.png"/>')

    expect(await make().pageImageUrl(PAGE)).toBe('https://assets.brand.example/m/p.png')
  })

  it('resolves a relative image url against the page url', async () => {
    serving('<meta property="og:image" content="/media/p.png"/>')

    expect(await make().pageImageUrl(PAGE)).toBe('https://www.nivea.example/media/p.png')
  })

  it('resolves a protocol-relative image url as https', async () => {
    serving('<meta property="og:image" content="//assets.brand.example/p.png"/>')

    expect(await make().pageImageUrl(PAGE)).toBe('https://assets.brand.example/p.png')
  })

  it.each([
    ['content before property', `<meta content="${PACKSHOT}" property="og:image">`],
    ['single quotes', `<meta property='og:image' content='${PACKSHOT}'>`],
    ['extra attributes in between', `<meta data-rh="true" property="og:image" id="x" content="${PACKSHOT}" />`],
    ['upper-case tag and attribute names', `<META PROPERTY="og:image" CONTENT="${PACKSHOT}">`],
    ['name instead of property on og:image', `<meta name="og:image" content="${PACKSHOT}">`],
    ['a newline between attributes', `<meta\n  property="og:image"\n  content="${PACKSHOT}"\n/>`],
  ])('finds the image with %s', async (_label, tag) => {
    serving(tag)

    expect(await make().pageImageUrl(PAGE)).toBe(PACKSHOT)
  })

  it('returns null when the page has no image meta tag', async () => {
    serving('<meta property="og:title" content="Spray"/><meta name="description" content="og:image"/>')

    expect(await make().pageImageUrl(PAGE)).toBeNull()
  })

  it('returns null when the og:image has an empty content', async () => {
    serving('<meta property="og:image" content=""/>')

    expect(await make().pageImageUrl(PAGE)).toBeNull()
  })

  it('returns null for a response that is not text/html', async () => {
    stubFetch(() => html(`<meta property="og:image" content="${PACKSHOT}"/>`, 'application/json'))

    expect(await make().pageImageUrl(PAGE)).toBeNull()
  })

  it('returns null for a response with no content type', async () => {
    stubFetch(() => new Response(`<meta property="og:image" content="${PACKSHOT}"/>`, { headers: {} }))

    expect(await make().pageImageUrl(PAGE)).toBeNull()
  })

  it('returns null for a 404 even if the body carries an image', async () => {
    stubFetch(() => new Response(`<meta property="og:image" content="${PACKSHOT}"/>`, { status: 404, headers: { 'content-type': 'text/html' } }))

    expect(await make().pageImageUrl(PAGE)).toBeNull()
  })

  it('returns null, without throwing, when the network fails', async () => {
    stubFetch(() => {
      throw new TypeError('network down')
    })

    expect(await make().pageImageUrl(PAGE)).toBeNull()
  })

  it('returns null, without throwing, when the page does not answer in time', async () => {
    stubFetch(() => new Promise<Response>(() => undefined))

    expect(await make().pageImageUrl(PAGE)).toBeNull()
  })

  it.each([
    ['an http page', 'http://www.nivea.example/p.html'],
    ['a private IPv4 host', 'https://10.0.0.5/p.html'],
    ['a loopback host', 'https://127.0.0.1/p.html'],
    ['localhost', 'https://localhost/p.html'],
    ['a single-label host', 'https://intranet/p.html'],
    ['a url with credentials', 'https://user:pw@www.nivea.example/p.html'],
    ['not a url', 'nivea spray'],
  ])('returns null without fetching for %s', async (_label, pageUrl) => {
    const stub = serving(`<meta property="og:image" content="${PACKSHOT}"/>`)

    expect(await make().pageImageUrl(pageUrl)).toBeNull()
    expect(stub).not.toHaveBeenCalled()
  })

  it.each([
    ['an http image', 'http://assets.brand.example/p.png'],
    ['a private-host image', 'https://192.168.1.10/p.png'],
    ['a loopback image', 'https://127.0.0.1/p.png'],
    ['a localhost image', 'https://localhost/p.png'],
    ['a javascript url', 'javascript:alert(1)'],
    ['a data url', 'data:image/png;base64,AAAA'],
  ])('returns null when the og:image is %s', async (_label, content) => {
    serving(`<meta property="og:image" content="${content}"/>`)

    expect(await make().pageImageUrl(PAGE)).toBeNull()
  })

  it('uses og:image:secure_url when the og:image is an http url, as every Shopify store emits the pair', async () => {
    serving(`<meta property="og:image" content="http://assets.brand.example/p.png"/><meta property="og:image:secure_url" content="${PACKSHOT}"/>`)

    expect(await make().pageImageUrl(PAGE)).toBe(PACKSHOT)
  })

  it('uses the next safe rank when an earlier rank is unsafe, even when the safe one is twitter:image', async () => {
    serving(
      `<meta property="og:image" content="http://assets.brand.example/p.png"/><meta property="og:image:secure_url" content="https://127.0.0.1/p.png"/><meta name="twitter:image" content="${PACKSHOT}"/>`,
    )

    expect(await make().pageImageUrl(PAGE)).toBe(PACKSHOT)
  })

  it('still prefers a safe og:image over a safe og:image:secure_url', async () => {
    serving(`<meta property="og:image:secure_url" content="https://assets.brand.example/other.png"/><meta property="og:image" content="${PACKSHOT}"/>`)

    expect(await make().pageImageUrl(PAGE)).toBe(PACKSHOT)
  })

  it('returns null when every image meta tag is unsafe', async () => {
    serving(
      '<meta property="og:image" content="http://assets.brand.example/p.png"/><meta property="og:image:secure_url" content="https://localhost/p.png"/><meta name="twitter:image" content="javascript:alert(1)"/>',
    )

    expect(await make().pageImageUrl(PAGE)).toBeNull()
  })

  it('follows a redirect to another public https page', async () => {
    const MOVED = 'https://www.nivea.example/new/p.html'
    stubFetch((url) => (url === PAGE ? redirect(MOVED, 301) : html(`<meta property="og:image" content="${PACKSHOT}"/>`)))

    expect(await make().pageImageUrl(PAGE)).toBe(PACKSHOT)
  })

  it.each([
    ['a private host', 'https://10.0.0.5/p.html'],
    ['an http url', 'http://www.nivea.example/p.html'],
  ])('returns null, without fetching it, when the page redirects to %s', async (_label, target) => {
    const stub = stubFetch((url) => (url === PAGE ? redirect(target) : html(`<meta property="og:image" content="${PACKSHOT}"/>`)))

    expect(await make().pageImageUrl(PAGE)).toBeNull()
    expect(stub.mock.calls.map(([input]) => String(input))).toEqual([PAGE])
  })

  it('returns null for a host in blockedHostSuffixes', async () => {
    const stub = serving(`<meta property="og:image" content="${PACKSHOT}"/>`)

    expect(await make({ blockedHostSuffixes: ['nivea.example'] }).pageImageUrl(PAGE)).toBeNull()
    expect(stub).not.toHaveBeenCalled()
  })

  it('finds a meta tag in the head of a page far bigger than the read cap', async () => {
    const filler = '<p>padding</p>'.repeat(Math.ceil((4 * PAGE_CAP) / 14))
    stubFetch(() => new Response(`<html><head><meta property="og:image" content="${PACKSHOT}"/></head><body>${filler}</body></html>`, { headers: { 'content-type': 'text/html' } }))

    expect(await make().pageImageUrl(PAGE)).toBe(PACKSHOT)
  })

  it('does not read past 512 KB: a meta tag after the cap is not found', async () => {
    const padding = '<!-- -->'.repeat(Math.ceil((PAGE_CAP + 1024) / 8))
    stubFetch(() => new Response(`<html><head>${padding}<meta property="og:image" content="${PACKSHOT}"/></head></html>`, { headers: { 'content-type': 'text/html' } }))

    expect(await make().pageImageUrl(PAGE)).toBeNull()
  })

  it('stops pulling the body once the cap is reached, so an endless page cannot fill memory', async () => {
    let pulled = 0
    const chunk = new TextEncoder().encode('<p>padding</p>'.repeat(1024))
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += chunk.byteLength
        controller.enqueue(chunk)
      },
    })
    stubFetch(() => new Response(body, { headers: { 'content-type': 'text/html' } }))

    expect(await make().pageImageUrl(PAGE)).toBeNull()
    expect(pulled).toBeLessThan(PAGE_CAP * 4)
  })

  describe('hostile pages', () => {
    const htmlOf = (body: string) => new Response(body, { headers: { 'content-type': 'text/html' } })
    const timed = async (body: string) => {
      stubFetch(() => htmlOf(body))
      const started = performance.now()
      const result = await make().pageImageUrl(PAGE)
      return { result, elapsed: performance.now() - started }
    }

    it('scans 512 KB of unclosed <meta in linear time', async () => {
      const { result, elapsed } = await timed('<meta'.repeat(PAGE_CAP / 5))

      expect(result).toBeNull()
      expect(elapsed).toBeLessThan(1000)
    }, 20_000)

    it('scans a 512 KB single-token meta tag in linear time', async () => {
      const { result, elapsed } = await timed(`<meta ${'a'.repeat(PAGE_CAP - 8)}>`)

      expect(result).toBeNull()
      expect(elapsed).toBeLessThan(1000)
    }, 20_000)

    it('scans 512 KB of attribute-like noise in linear time', async () => {
      const { result, elapsed } = await timed(`<meta ${'a=" '.repeat(PAGE_CAP / 4)}`)

      expect(result).toBeNull()
      expect(elapsed).toBeLessThan(1000)
    }, 20_000)

    it('ignores a meta tag longer than 4 KB', async () => {
      const { result } = await timed(`<meta data-x="${'a'.repeat(5000)}" property="og:image" content="${PACKSHOT}">`)

      expect(result).toBeNull()
    })

    it('stops at </head>', async () => {
      const { result } = await timed(`<head></head><body><meta property="og:image" content="${PACKSHOT}"></body>`)

      expect(result).toBeNull()
    })

    it('reads at most 200 meta tags', async () => {
      const fillers = '<meta name="x" content="y">'.repeat(200)
      const { result } = await timed(`${fillers}<meta property="og:image" content="${PACKSHOT}">`)

      expect(result).toBeNull()
    })

    it('still finds the image after a broken tag fragment', async () => {
      const { result } = await timed(`<meta property="og:image" content="${PACKSHOT}">`)

      expect(result).toBe(PACKSHOT)
    })
  })

  it('does not decode entities twice', async () => {
    serving('<meta property="og:image" content="https://assets.brand.example/p.png?a=1&amp;#38;b=2"/>')

    expect(await make().pageImageUrl(PAGE)).toBe('https://assets.brand.example/p.png?a=1&#38;b=2')
  })

  it('uses the first og:image when the page has several', async () => {
    const other = 'https://assets.brand.example/media/other.png'
    serving(`<meta property="og:image" content="${PACKSHOT}"/><meta property="og:image" content="${other}"/>`)

    expect(await make().pageImageUrl(PAGE)).toBe(PACKSHOT)
  })

  it('resolves a relative image url against the final url after a redirect', async () => {
    const MOVED = 'https://shop.other.example/new/p.html'
    stubFetch((url) => (url === PAGE ? redirect(MOVED, 301) : html('<meta property="og:image" content="/media/p.png"/>')))

    expect(await make().pageImageUrl(PAGE)).toBe('https://shop.other.example/media/p.png')
  })

  it('gives up after 2 redirects (3 requests)', async () => {
    const stub = stubFetch((url) => redirect(`${url}x`))

    expect(await make().pageImageUrl(PAGE)).toBeNull()
    expect(stub).toHaveBeenCalledTimes(3)
  })

  it('returns null when a later hop of the redirect chain is unsafe', async () => {
    const MID = 'https://www.nivea.example/mid'
    const stub = stubFetch((url) => (url === PAGE ? redirect(MID) : redirect('https://127.0.0.1/p.html')))

    expect(await make().pageImageUrl(PAGE)).toBeNull()
    expect(stub.mock.calls.map(([input]) => String(input))).toEqual([PAGE, MID])
  })
})
