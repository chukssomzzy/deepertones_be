import { describe, expect, it } from 'vitest'
import type { DraftRequest, DraftResult } from './catalog-drafter.provider'
import { MemoryCatalogDrafter } from './memory.catalog-drafter'

const REQUEST: DraftRequest = {
  product: { brand: 'The Ordinary', name: 'Niacinamide 10% + Zinc 1%', category: 'skin' },
  columns: ['skin_concerns', 'frequency'],
  countries: [{ code: 'NG', currency: 'NGN' }],
}
const OTHER: DraftRequest = { product: { brand: 'CeraVe', name: 'Hydrating Cleanser', category: 'skin' }, columns: [], countries: [{ code: 'GB', currency: 'GBP' }] }

const ANSWER: DraftResult = {
  cells: { frequency: { value: 'pm', sourceUrl: 'https://theordinary.example/niacinamide' } },
  availability: [],
}

describe('MemoryCatalogDrafter', () => {
  it('drafts nothing until told what to answer', async () => {
    await expect(new MemoryCatalogDrafter().draft(REQUEST)).resolves.toEqual({ cells: {}, availability: [] })
  })

  it('answers with whatever respondWith computes from the request', async () => {
    const drafter = new MemoryCatalogDrafter()
    drafter.respondWith((request) => (request.product.brand === 'The Ordinary' ? ANSWER : { cells: {}, availability: [] }))

    await expect(drafter.draft(REQUEST)).resolves.toEqual(ANSWER)
    await expect(drafter.draft(OTHER)).resolves.toEqual({ cells: {}, availability: [] })
  })

  it('records the requests it was asked, in order', async () => {
    const drafter = new MemoryCatalogDrafter()

    await drafter.draft(REQUEST)
    await drafter.draft(OTHER)

    expect(drafter.calls).toEqual([REQUEST, OTHER])
  })

  it('failNextWith rejects the next draft only, records nothing, then recovers', async () => {
    const drafter = new MemoryCatalogDrafter()
    drafter.respondWith(() => ANSWER)
    const failure = new Error('boom')
    drafter.failNextWith(failure)

    await expect(drafter.draft(REQUEST)).rejects.toBe(failure)
    expect(drafter.calls).toEqual([])

    await expect(drafter.draft(REQUEST)).resolves.toEqual(ANSWER)
    expect(drafter.calls).toEqual([REQUEST])
  })
})
