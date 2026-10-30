import { describe, expect, it } from 'vitest'
import { CloudflareImagesShareCardRenderer } from './cloudflare-images.share-card-renderer'
import { type ShareCardLayout, ShareCardQuotaError } from './share-card.provider'

// The real renderer over a recording stand-in for the Images binding (the binding is not available locally; the real one is checked once on staging). What is pinned here is
// what the card asks of the binding: one PNG output, photos that are only resized, and the quota refusal told apart from any other failure.

// A small layout of its own: this file is about what the renderer asks of the binding, not about where the layout puts things (face-shares.layout.test.ts).
const LAYOUT: ShareCardLayout = {
  canvas: { width: 1080, height: 1920, background: '#0e0e0e' },
  photos: {
    before: { rect: { left: 100, top: 100, width: 400, height: 500 }, fit: 'contain' },
    after: { rect: { left: 100, top: 700, width: 400, height: 500 }, fit: 'contain' },
  },
  labels: [
    { text: 'Day 1', rect: { left: 100, top: 40, width: 400, height: 50 }, size: 30, color: '#f1f1f1' },
    { text: 'Day 15', rect: { left: 100, top: 640, width: 400, height: 50 }, size: 30, color: '#f1f1f1' },
  ],
  logo: { rect: { left: 800, top: 1850, width: 254, height: 40 } },
}

type Call = { method: string; args: unknown[] }

const CARD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
const PHOTO = (marker: number) => ({ bytes: new Uint8Array([0xff, 0xd8, marker]), mediaType: 'image/jpeg' as const })
const LOGO = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9]), mediaType: 'image/png' as const }

const recordingImages = (options: { outputFails?: unknown } = {}) => {
  const calls: Call[] = []
  const inputs: Uint8Array[] = []
  const handle = (): unknown =>
    new Proxy(
      {},
      {
        get: (_target, method: string) => {
          if (method === 'then') return undefined
          if (method === 'output') {
            return async (...args: unknown[]) => {
              calls.push({ method, args })
              if (options.outputFails) throw options.outputFails
              return { image: () => new Response(CARD).body! }
            }
          }
          return (...args: unknown[]) => {
            calls.push({ method, args })
            return handle()
          }
        },
      },
    )
  const binding = {
    input: (stream: ReadableStream<Uint8Array>) => {
      calls.push({ method: 'input', args: [stream] })
      void new Response(stream).arrayBuffer().then((buffer) => inputs.push(new Uint8Array(buffer)))
      return handle()
    },
    text: (...args: unknown[]) => {
      calls.push({ method: 'text', args })
      return handle()
    },
  } as unknown as ImagesBinding
  return { binding, calls, inputs }
}

const render = (images: ImagesBinding) =>
  new CloudflareImagesShareCardRenderer({ images, fontUrl: 'https://fonts.test/label.ttf' }).render({ layout: LAYOUT, before: PHOTO(1), after: PHOTO(2), logo: LOGO })

describe('CloudflareImagesShareCardRenderer', () => {
  it('answers the bytes of one PNG, asking the binding for a PNG once', async () => {
    const { binding, calls } = recordingImages()

    const card = await render(binding)

    expect(card).toEqual({ bytes: CARD, mediaType: 'image/png' })
    expect(calls.filter((call) => call.method === 'output').map((call) => call.args)).toEqual([[{ format: 'image/png' }]])
  })

  it('only resizes the photos: every transform asked of the binding is a size, a fit or the canvas colour behind a fit, and nothing else', async () => {
    const { binding, calls } = recordingImages()

    await render(binding)

    const transforms = calls.filter((call) => call.method === 'transform')
    expect(transforms.length).toBeGreaterThan(0)
    for (const call of transforms) {
      expect(Object.keys(call.args[0] as object).every((key) => ['width', 'height', 'fit', 'background'].includes(key))).toBe(true)
    }
  })

  it('draws the two labels with the font it was given', async () => {
    const { binding, calls } = recordingImages()

    await render(binding)

    const texts = calls.filter((call) => call.method === 'text')
    expect(texts.map((call) => call.args[0])).toEqual(['Day 1', 'Day 15'])
    for (const call of texts) expect(call.args[1]).toMatchObject({ font: { url: 'https://fonts.test/label.ttf' } })
  })

  it('tells the free allowance running out (error 9422) apart: ShareCardQuotaError', async () => {
    const { binding } = recordingImages({ outputFails: Object.assign(new Error('quota'), { code: 9422 }) })

    await expect(render(binding)).rejects.toBeInstanceOf(ShareCardQuotaError)
  })

  it('lets any other failure through as it was', async () => {
    const failure = Object.assign(new Error('bad input'), { code: 9412 })
    const { binding } = recordingImages({ outputFails: failure })

    await expect(render(binding)).rejects.toBe(failure)
  })

  it('builds the canvas from a valid 1 x 1 PNG of the layout colour', async () => {
    const { binding, inputs } = recordingImages()

    await render(binding)
    await new Promise((resolve) => setTimeout(resolve, 0))

    const pixel = inputs[0]!
    expect(Array.from(pixel.slice(0, 8))).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    // 8 bytes of signature, the 25-byte IHDR chunk, the IDAT chunk's 8-byte head, the 2-byte zlib header and the 5-byte stored-block head, then the scanline: filter 0 and #0e0e0e.
    expect(Array.from(pixel.slice(48, 52))).toEqual([0, 0x0e, 0x0e, 0x0e])
    expect(pixel).toHaveLength(72)
  })
})
