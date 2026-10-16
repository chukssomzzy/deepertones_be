import { describe, expect, it } from 'vitest'
import type { ProductImage } from '../product-analysis/product-analyst.provider'
import { MemoryLabelReader } from './memory.label-reader'
import type { LabelReading } from './label-reader.provider'

const IMAGE: ProductImage = { bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/webp' }
const READ: LabelReading = { readable: true, ingredients: ['Aqua', 'Glycerin'] }

describe('MemoryLabelReader', () => {
  it('says not readable until told otherwise, then answers with what its function computes from the image', async () => {
    const reader = new MemoryLabelReader()
    await expect(reader.read(IMAGE)).resolves.toEqual({ readable: false })

    reader.respondWith((image) => (image.mediaType === 'image/webp' ? READ : { readable: false }))

    await expect(reader.read(IMAGE)).resolves.toEqual(READ)
    await expect(reader.read({ ...IMAGE, mediaType: 'image/jpeg' })).resolves.toEqual({ readable: false })
  })

  it('records every image it was shown, in order', async () => {
    const reader = new MemoryLabelReader()
    const other: ProductImage = { bytes: new Uint8Array([9]), mediaType: 'image/jpeg' }

    await reader.read(IMAGE)
    await reader.read(other)

    expect(reader.calls).toEqual([IMAGE, other])
  })

  it('failNextWith rejects the next call only, records nothing for it, then recovers', async () => {
    const reader = new MemoryLabelReader()
    reader.respondWith(() => READ)
    const failure = new Error('boom')
    reader.failNextWith(failure)

    await expect(reader.read(IMAGE)).rejects.toBe(failure)
    expect(reader.calls).toEqual([])

    await expect(reader.read(IMAGE)).resolves.toEqual(READ)
    expect(reader.calls).toEqual([IMAGE])
  })
})
