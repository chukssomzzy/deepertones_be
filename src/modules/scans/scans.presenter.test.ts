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
    product: { id: 'p1', brand: 'Glow Co', name: 'Serum', variant: null, category: 'skin', imageUrl: null },
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
        product: { id: 'p1', brand: 'Glow Co', name: 'Serum', variant: null, category: 'skin', imageUrl: null },
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
})
