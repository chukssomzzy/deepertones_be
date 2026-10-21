import { describe, expect, it } from 'vitest'
import type { ProductImage } from '../product-analysis/product-analyst.provider'
import { MemoryProductRecognizer } from './memory.product-recognizer'
import type { Recognition, ShelfRecognition } from './product-recognizer.provider'

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

const SHELF: ShelfRecognition = {
  classification: 'beauty-product',
  products: [{ position: 'left', brand: 'Glow Co', name: 'Bright Tone Serum', category: 'skin', confidence: 0.9 }],
  excluded: { otherProducts: 1, unreadable: 0 },
}

describe('MemoryProductRecognizer recognizeShelf', () => {
  it('says unreadable with no products and nothing excluded until told otherwise', async () => {
    const recognizer = new MemoryProductRecognizer()

    await expect(recognizer.recognizeShelf(IMAGE)).resolves.toStrictEqual({
      classification: 'unreadable',
      products: [],
      excluded: { otherProducts: 0, unreadable: 0 },
    })
  })

  it('answers with what the function given to respondToShelfWith computes from the image', async () => {
    const recognizer = new MemoryProductRecognizer()
    recognizer.respondToShelfWith((image) => (image.mediaType === 'image/webp' ? SHELF : { classification: 'other-product', products: [], excluded: { otherProducts: 2, unreadable: 0 } }))

    await expect(recognizer.recognizeShelf(IMAGE)).resolves.toEqual(SHELF)
    await expect(recognizer.recognizeShelf({ ...IMAGE, mediaType: 'image/jpeg' })).resolves.toMatchObject({ classification: 'other-product' })
  })

  it('records every image it was shown in shelfCalls, apart from calls', async () => {
    const recognizer = new MemoryProductRecognizer()
    const other: ProductImage = { bytes: new Uint8Array([9]), mediaType: 'image/jpeg' }

    await recognizer.recognizeShelf(IMAGE)
    await recognizer.recognizeShelf(other)

    expect(recognizer.shelfCalls).toEqual([IMAGE, other])
    expect(recognizer.calls).toEqual([])
  })

  it('does not change what recognize answers, and respondWith does not change the shelf answer', async () => {
    const recognizer = new MemoryProductRecognizer()
    recognizer.respondWith(() => SERUM)
    recognizer.respondToShelfWith(() => SHELF)

    await expect(recognizer.recognize(IMAGE)).resolves.toEqual(SERUM)
    await expect(recognizer.recognizeShelf(IMAGE)).resolves.toEqual(SHELF)
    expect(recognizer.calls).toEqual([IMAGE])
    expect(recognizer.shelfCalls).toEqual([IMAGE])
  })

  it('failNextWith rejects the next shelf call only, records nothing for it, then recovers', async () => {
    const recognizer = new MemoryProductRecognizer()
    recognizer.respondToShelfWith(() => SHELF)
    const failure = new Error('boom')
    recognizer.failNextWith(failure)

    await expect(recognizer.recognizeShelf(IMAGE)).rejects.toBe(failure)
    expect(recognizer.shelfCalls).toEqual([])

    await expect(recognizer.recognizeShelf(IMAGE)).resolves.toEqual(SHELF)
    expect(recognizer.shelfCalls).toEqual([IMAGE])
  })

  it('failNextWith fails whichever method is called next, and only once across both', async () => {
    const recognizer = new MemoryProductRecognizer()
    const failure = new Error('boom')
    recognizer.failNextWith(failure)

    await expect(recognizer.recognizeShelf(IMAGE)).rejects.toBe(failure)
    await expect(recognizer.recognize(IMAGE)).resolves.toEqual({ classification: 'unreadable' })
  })
})

const TARGET = { position: 'orange jar, bottom right', hint: { brand: 'Glow Co', name: 'Bright Tone' } }

describe('MemoryProductRecognizer recognizeShelfProduct', () => {
  it('says unreadable until told otherwise', async () => {
    const recognizer = new MemoryProductRecognizer()

    await expect(recognizer.recognizeShelfProduct(IMAGE, TARGET)).resolves.toStrictEqual({ classification: 'unreadable' })
  })

  it('answers with what the function given to respondToShelfProductWith computes from the image and the target', async () => {
    const recognizer = new MemoryProductRecognizer()
    recognizer.respondToShelfProductWith((image, target) => (target.position === 'orange jar, bottom right' && image.mediaType === 'image/webp' ? SERUM : { classification: 'other-product' }))

    await expect(recognizer.recognizeShelfProduct(IMAGE, TARGET)).resolves.toEqual(SERUM)
    await expect(recognizer.recognizeShelfProduct(IMAGE, { ...TARGET, position: 'elsewhere' })).resolves.toEqual({ classification: 'other-product' })
  })

  it('records every image and target it was shown in shelfProductCalls, in order, apart from calls and shelfCalls', async () => {
    const recognizer = new MemoryProductRecognizer()
    const other: ProductImage = { bytes: new Uint8Array([9]), mediaType: 'image/jpeg' }
    const second = { position: 'blue tube, left', hint: { brand: 'Nuxe', name: 'Huile', variant: 'Néroli' } }

    await recognizer.recognizeShelfProduct(IMAGE, TARGET)
    await recognizer.recognizeShelfProduct(other, second)

    expect(recognizer.shelfProductCalls).toEqual([
      { image: IMAGE, target: TARGET },
      { image: other, target: second },
    ])
    expect(recognizer.calls).toEqual([])
    expect(recognizer.shelfCalls).toEqual([])
  })

  it('does not change what recognize or recognizeShelf answer, and they do not change the second look', async () => {
    const recognizer = new MemoryProductRecognizer()
    recognizer.respondWith(() => SERUM)
    recognizer.respondToShelfWith(() => SHELF)
    recognizer.respondToShelfProductWith(() => ({ classification: 'face-or-person' }))

    await expect(recognizer.recognize(IMAGE)).resolves.toEqual(SERUM)
    await expect(recognizer.recognizeShelf(IMAGE)).resolves.toEqual(SHELF)
    await expect(recognizer.recognizeShelfProduct(IMAGE, TARGET)).resolves.toEqual({ classification: 'face-or-person' })
  })

  it('failNextWith rejects the next second look only, records nothing for it, then recovers', async () => {
    const recognizer = new MemoryProductRecognizer()
    recognizer.respondToShelfProductWith(() => SERUM)
    const failure = new Error('boom')
    recognizer.failNextWith(failure)

    await expect(recognizer.recognizeShelfProduct(IMAGE, TARGET)).rejects.toBe(failure)
    expect(recognizer.shelfProductCalls).toEqual([])

    await expect(recognizer.recognizeShelfProduct(IMAGE, TARGET)).resolves.toEqual(SERUM)
    expect(recognizer.shelfProductCalls).toEqual([{ image: IMAGE, target: TARGET }])
  })

  it('failNextWith fails whichever method is called next, and only once across all three', async () => {
    const recognizer = new MemoryProductRecognizer()
    const failure = new Error('boom')
    recognizer.failNextWith(failure)

    await expect(recognizer.recognizeShelfProduct(IMAGE, TARGET)).rejects.toBe(failure)
    await expect(recognizer.recognize(IMAGE)).resolves.toEqual({ classification: 'unreadable' })
    await expect(recognizer.recognizeShelf(IMAGE)).resolves.toMatchObject({ classification: 'unreadable' })
  })
})
