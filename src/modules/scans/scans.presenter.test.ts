import { describe, expect, it } from 'vitest'
import type { ScanItemView } from './scans.service'
import { toScanItemResponse } from './scans.presenter'
import { ScanItemResponse } from './scans.schemas'

const readyItem = (): ScanItemView => ({
  id: 'item-1',
  position: 0,
  state: 'ready',
  reason: null,
  recognised: { brand: 'Glow Co', name: 'Serum', variant: null, category: 'skin' },
  product: {
    product: { id: 'p1', kind: 'named', brand: 'Glow Co', name: 'Serum', variant: null, category: 'skin', imageUrl: null },
    formulation: { id: 'f1', ingredients: ['Aqua'], source: { kind: 'web', url: 'https://example.test/serum' }, foundAt: new Date('2030-01-01T00:00:00Z'), analysedAt: null },
    concerns: [{ kind: 'fragrance', severity: 'low', ingredients: ['Parfum'], why: 'w', whoShouldTakeCare: 'x', traits: ['t'], sources: ['s'] }],
    reference: { version: 'v1', coverage: 'partial' },
  },
  image: { kind: 'stock', url: 'https://example.test/serum.jpg' },
})

describe('toScanItemResponse', () => {
  it('publishes the catalog view field by field, with its dates as ISO strings', () => {
    expect(toScanItemResponse(readyItem())).toEqual({
      id: 'item-1',
      position: 0,
      state: 'ready',
      reason: null,
      recognised: { brand: 'Glow Co', name: 'Serum', variant: null, category: 'skin' },
      product: {
        product: { id: 'p1', kind: 'named', brand: 'Glow Co', name: 'Serum', variant: null, category: 'skin', imageUrl: null },
        formulation: { id: 'f1', ingredients: ['Aqua'], source: { kind: 'web', url: 'https://example.test/serum' }, foundAt: '2030-01-01T00:00:00.000Z', analysedAt: null },
        concerns: [{ kind: 'fragrance', severity: 'low', ingredients: ['Parfum'], why: 'w', whoShouldTakeCare: 'x', traits: ['t'], sources: ['s'] }],
        reference: { version: 'v1', coverage: 'partial' },
      },
      image: { kind: 'stock', url: 'https://example.test/serum.jpg' },
    })
  })

  it('leaves out a field the catalog view gains that the response schema does not name', () => {
    const item = readyItem()
    const grown = {
      ...item,
      recognised: { ...item.recognised!, confidence: 0.9 },
      product: {
        ...item.product!,
        product: { ...item.product!.product, imageKey: 'secret/key' },
        formulation: { ...item.product!.formulation, ingredientsKey: 'k' },
        concerns: [{ ...item.product!.concerns[0]!, internalNote: 'n' }],
        reference: { ...item.product!.reference, listHash: 'h' },
      },
      image: { ...item.image!, key: 'photos/x' },
    } as unknown as ScanItemView

    expect(toScanItemResponse(grown)).toEqual(toScanItemResponse(item))
  })

  it('shows a failed item with the reason label-unreadable, which the response schema allows', () => {
    const item: ScanItemView = { id: 'item-2', position: 1, state: 'failed', reason: 'label-unreadable', image: { kind: 'user', url: '/scans/photos/t' } }

    const response = toScanItemResponse(item)

    expect(response).toMatchObject({ state: 'failed', reason: 'label-unreadable' })
    expect(ScanItemResponse.safeParse(response).success).toBe(true)
  })

  it.each([
    ['needs-retake', 'unreadable'],
    ['needs-retake', 'label-not-visible'],
    ['needs-identification', 'unreadable'],
    ['needs-identification', 'label-not-visible'],
  ] as const)('shows an item in %s with the reason %s, which the response schema allows', (state, reason) => {
    const item: ScanItemView = { id: 'item-3', position: 0, state, reason, image: null }

    const response = toScanItemResponse(item)

    expect(response).toMatchObject({ state, reason })
    expect(ScanItemResponse.safeParse(response).success).toBe(true)
  })

  it('publishes retakesLeft on an item asking for a retake, as the response schema allows', () => {
    const item: ScanItemView = { id: 'item-3', position: 0, state: 'needs-retake', reason: 'label-not-visible', retakesLeft: 2, image: null }

    const response = toScanItemResponse(item)

    expect(response.retakesLeft).toBe(2)
    expect(ScanItemResponse.safeParse(response).success).toBe(true)
  })

  it('leaves retakesLeft out of the response, not undefined, when the item has none (needs-identification, or any other state)', () => {
    const item: ScanItemView = { id: 'item-3', position: 0, state: 'needs-identification', reason: 'unreadable', image: null }

    expect(toScanItemResponse(item)).not.toHaveProperty('retakesLeft')
    expect(Object.keys(toScanItemResponse(item))).not.toContain('retakesLeft')
    expect(Object.keys(toScanItemResponse(readyItem()))).not.toContain('retakesLeft')
  })

  it('publishes the product\'s kind, and an unnamed product with its empty brand and name, as the response schema allows', () => {
    const named = readyItem()
    const unnamed: ScanItemView = {
      ...named,
      product: { ...named.product!, product: { id: 'p2', kind: 'unnamed', brand: '', name: '', variant: null, category: 'other', imageUrl: null } },
    }

    const response = toScanItemResponse(unnamed)

    expect(toScanItemResponse(named).product!.product).toMatchObject({ kind: 'named' })
    expect(response.product!.product).toEqual({ id: 'p2', kind: 'unnamed', brand: '', name: '', variant: null, category: 'other', imageUrl: null })
    expect(ScanItemResponse.safeParse(response).success).toBe(true)
  })

  it('rejects a product kind the response schema does not name', () => {
    const response = toScanItemResponse(readyItem())

    const parsed = ScanItemResponse.safeParse({ ...response, product: { ...response.product!, product: { ...response.product!.product, kind: 'mystery' } } })

    expect(parsed.success).toBe(false)
  })
})
