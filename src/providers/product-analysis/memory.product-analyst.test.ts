import { describe, expect, it } from 'vitest'
import type { ProductIdentity } from '../product-research/product-researcher.provider'
import { MemoryProductAnalyst } from './memory.product-analyst'
import type { AnalysisInput, DraftConcern, ProductImage } from './product-analyst.provider'

const SERUM: ProductIdentity = { brand: 'Glow Co', name: 'Bright Tone Serum', category: 'skin' }
const OTHER: ProductIdentity = { brand: 'Glow Company', name: 'Brighttone Serum', category: 'skin' }
const IMAGE: ProductImage = { bytes: new Uint8Array([1, 2, 3]), mediaType: 'image/webp' }

const INPUT: AnalysisInput = {
  product: SERUM,
  ingredients: ['Aqua', 'Hydroquinone'],
  flaggedFacts: [{ kind: 'restricted-or-banned', ingredient: 'Hydroquinone', rule: 'Banned', source: 'https://cosing.example' }],
  kinds: ['restricted-or-banned'],
  severities: ['avoid'],
  traits: ['sensitive-skin'],
}

const CONCERN: DraftConcern = {
  kind: 'restricted-or-banned',
  severity: 'avoid',
  ingredients: ['Hydroquinone'],
  why: 'Banned.',
  whoShouldTakeCare: 'Everyone.',
  traits: ['sensitive-skin'],
  sources: ['https://cosing.example'],
}

describe('MemoryProductAnalyst', () => {
  it('answers each method with what its With function computes from the arguments', async () => {
    const analyst = new MemoryProductAnalyst()
    analyst.analyseWith((input) => (input.flaggedFacts.length > 0 ? [CONCERN] : []))
    analyst.sameProductWith((a, b) => a.brand === b.brand)
    analyst.imageShowsProductWith((image) => image.mediaType === 'image/webp')

    await expect(analyst.analyse(INPUT)).resolves.toEqual([CONCERN])
    await expect(analyst.analyse({ ...INPUT, flaggedFacts: [] })).resolves.toEqual([])
    await expect(analyst.sameProduct(SERUM, SERUM)).resolves.toBe(true)
    await expect(analyst.sameProduct(SERUM, OTHER)).resolves.toBe(false)
    await expect(analyst.imageShowsProduct(IMAGE, SERUM)).resolves.toBe(true)
    await expect(analyst.imageShowsProduct({ ...IMAGE, mediaType: 'image/png' }, SERUM)).resolves.toBe(false)
  })

  it('records the arguments of every call, per method, in order', async () => {
    const analyst = new MemoryProductAnalyst()

    await analyst.analyse(INPUT)
    await analyst.sameProduct(SERUM, OTHER)
    await analyst.imageShowsProduct(IMAGE, SERUM)
    await analyst.sameProduct(OTHER, SERUM)

    expect(analyst.calls.analyse).toEqual([INPUT])
    expect(analyst.calls.sameProduct).toEqual([
      [SERUM, OTHER],
      [OTHER, SERUM],
    ])
    expect(analyst.calls.imageShowsProduct).toEqual([[IMAGE, SERUM]])
  })

  it('failNextWith rejects the next call of any method only, records nothing, then recovers', async () => {
    const analyst = new MemoryProductAnalyst()
    analyst.sameProductWith(() => true)
    const failure = new Error('boom')
    analyst.failNextWith(failure)

    await expect(analyst.sameProduct(SERUM, OTHER)).rejects.toBe(failure)
    expect(analyst.calls.sameProduct).toEqual([])

    await expect(analyst.sameProduct(SERUM, OTHER)).resolves.toBe(true)
    expect(analyst.calls.sameProduct).toEqual([[SERUM, OTHER]])
  })
})
