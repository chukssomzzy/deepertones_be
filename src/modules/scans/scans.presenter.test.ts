import { describe, expect, it } from 'vitest'
import type { ScanItemView } from './scans.service'
import { toScanItemResponse } from './scans.presenter'
import { ScanItemResponse } from './scans.schemas'

const readyItem = (): ScanItemView => ({
  id: 'item-1',
  position: 0,
  state: 'ready',
  reason: null,
  recognised: { brand: 'Glow Co', name: 'Serum', variant: null, form: null, category: 'skin' },
  product: { id: 'p1', brand: 'Glow Co', name: 'Serum', variant: null, form: null, category: 'skin', imageUrl: null },
  image: { kind: 'stock', url: 'https://example.test/serum.jpg' },
})

describe('toScanItemResponse', () => {
  it('publishes the product summary field by field, and nothing else about the product', () => {
    expect(toScanItemResponse(readyItem())).toEqual({
      id: 'item-1',
      position: 0,
      state: 'ready',
      reason: null,
      recognised: { brand: 'Glow Co', name: 'Serum', variant: null, form: null, category: 'skin' },
      product: { id: 'p1', brand: 'Glow Co', name: 'Serum', variant: null, form: null, category: 'skin', imageUrl: null },
      image: { kind: 'stock', url: 'https://example.test/serum.jpg' },
    })
  })

  it('publishes exactly the summary keys for a ready item\'s product, even when the view carries formulation, concerns and reference', () => {
    const carrying = {
      ...readyItem(),
      product: { ...readyItem().product!, formulation: { id: 'f1' }, concerns: [], reference: { version: 'v1' }, product: { id: 'nested' } },
    } as unknown as ScanItemView

    const response = toScanItemResponse(carrying)

    expect(Object.keys(response.product!).sort()).toEqual(['brand', 'category', 'form', 'id', 'imageUrl', 'name', 'variant'])
  })

  it('publishes the form of what was read and of the product, when they have one', () => {
    const item = readyItem()
    const sprayed: ScanItemView = {
      ...item,
      recognised: { ...item.recognised!, form: 'spray' },
      product: { ...item.product!, form: 'spray' },
    }

    const response = toScanItemResponse(sprayed)

    expect(response.recognised).toEqual({ brand: 'Glow Co', name: 'Serum', variant: null, form: 'spray', category: 'skin' })
    expect(response.product!.form).toBe('spray')
  })

  it('leaves out a field the product summary gains that the response schema does not name', () => {
    const item = readyItem()
    const grown = {
      ...item,
      recognised: { ...item.recognised!, confidence: 0.9 },
      product: { ...item.product!, imageKey: 'secret/key' },
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
