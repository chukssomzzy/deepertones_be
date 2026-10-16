import { describe, expect, it } from 'vitest'
import { MemoryProductResearcher } from './memory.product-researcher'
import type { ProductIdentity, ResearchResult } from './product-researcher.provider'

const SERUM: ProductIdentity = { brand: 'The Ordinary', name: 'Niacinamide 10% + Zinc 1%', category: 'skin' }
const SHAMPOO: ProductIdentity = { brand: 'Pantene', name: 'Pro-V Shampoo', variant: 'Smooth', category: 'hair' }

const FOUND: ResearchResult = {
  found: true,
  ingredients: ['Aqua', 'Niacinamide'],
  sourceUrl: 'https://theordinary.example/niacinamide',
}

describe('MemoryProductResearcher', () => {
  it('reports not found until told what to answer', async () => {
    await expect(new MemoryProductResearcher().research(SERUM)).resolves.toEqual({ found: false })
  })

  it('answers with whatever respondWith computes from the product', async () => {
    const researcher = new MemoryProductResearcher()
    researcher.respondWith((product) => (product.brand === 'The Ordinary' ? FOUND : { found: false }))

    await expect(researcher.research(SERUM)).resolves.toEqual(FOUND)
    await expect(researcher.research(SHAMPOO)).resolves.toEqual({ found: false })
  })

  it('records the products it was asked about, in order', async () => {
    const researcher = new MemoryProductResearcher()

    await researcher.research(SERUM)
    await researcher.research(SHAMPOO)

    expect(researcher.calls).toEqual([SERUM, SHAMPOO])
  })

  it('failNextWith rejects the next research only, records nothing, then recovers', async () => {
    const researcher = new MemoryProductResearcher()
    researcher.respondWith(() => FOUND)
    const failure = new Error('boom')
    researcher.failNextWith(failure)

    await expect(researcher.research(SERUM)).rejects.toBe(failure)
    expect(researcher.calls).toEqual([])

    await expect(researcher.research(SERUM)).resolves.toEqual(FOUND)
    expect(researcher.calls).toEqual([SERUM])
  })
})
