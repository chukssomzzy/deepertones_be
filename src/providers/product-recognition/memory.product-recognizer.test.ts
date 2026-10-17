import { describe, expect, it } from 'vitest'
import type { ProductImage } from '../product-analysis/product-analyst.provider'
import { MemoryProductRecognizer } from './memory.product-recognizer'
import type { Recognition } from './product-recognizer.provider'

const IMAGE: ProductImage = { bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/webp' }
const SERUM: Recognition = { classification: 'beauty-product', brand: 'Glow Co', name: 'Bright Tone Serum', category: 'skin', confidence: 0.9 }

describe('MemoryProductRecognizer', () => {
  it('says unreadable until told otherwise, then answers with what its function computes from the image', async () => {
    const recognizer = new MemoryProductRecognizer()
    await expect(recognizer.recognize(IMAGE)).resolves.toEqual({ classification: 'unreadable' })

    recognizer.respondWith((image) => (image.mediaType === 'image/webp' ? SERUM : { classification: 'other-product' }))

    await expect(recognizer.recognize(IMAGE)).resolves.toEqual(SERUM)
    await expect(recognizer.recognize({ ...IMAGE, mediaType: 'image/jpeg' })).resolves.toEqual({ classification: 'other-product' })
  })

  it('passes a form through with the rest of the recognition', async () => {
    const recognizer = new MemoryProductRecognizer()
    const spray: Recognition = { ...SERUM, form: 'spray' }
    recognizer.respondWith(() => spray)

    await expect(recognizer.recognize(IMAGE)).resolves.toStrictEqual(spray)
  })

  it('records every image it was shown, in order', async () => {
    const recognizer = new MemoryProductRecognizer()
    const other: ProductImage = { bytes: new Uint8Array([9]), mediaType: 'image/jpeg' }

    await recognizer.recognize(IMAGE)
    await recognizer.recognize(other)

    expect(recognizer.calls).toEqual([IMAGE, other])
  })

  it('failNextWith rejects the next call only, records nothing for it, then recovers', async () => {
    const recognizer = new MemoryProductRecognizer()
    recognizer.respondWith(() => SERUM)
    const failure = new Error('boom')
    recognizer.failNextWith(failure)

    await expect(recognizer.recognize(IMAGE)).rejects.toBe(failure)
    expect(recognizer.calls).toEqual([])

    await expect(recognizer.recognize(IMAGE)).resolves.toEqual(SERUM)
    expect(recognizer.calls).toEqual([IMAGE])
  })
})
