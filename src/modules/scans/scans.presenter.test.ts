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
  product: {
    product: { id: 'p1', kind: 'named', brand: 'Glow Co', name: 'Serum', variant: null, form: null, category: 'skin', imageUrl: null },
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
      recognised: { brand: 'Glow Co', name: 'Serum', variant: null, form: null, category: 'skin' },
      product: {
        product: { id: 'p1', kind: 'named', brand: 'Glow Co', name: 'Serum', variant: null, form: null, category: 'skin', imageUrl: null },
        formulation: { id: 'f1', ingredients: ['Aqua'], source: { kind: 'web', url: 'https://example.test/serum' }, foundAt: '2030-01-01T00:00:00.000Z', analysedAt: null },
        concerns: [{ kind: 'fragrance', severity: 'low', ingredients: ['Parfum'], why: 'w', whoShouldTakeCare: 'x', traits: ['t'], sources: ['s'] }],
        reference: { version: 'v1', coverage: 'partial' },
      },
      image: { kind: 'stock', url: 'https://example.test/serum.jpg' },
    })
  })

  it('publishes the form of what was read and of the product, when they have one', () => {
    const item = readyItem()
    const sprayed: ScanItemView = {
      ...item,
      recognised: { ...item.recognised!, form: 'spray' },
      product: { ...item.product!, product: { ...item.product!.product, form: 'spray' } },
    }

    const response = toScanItemResponse(sprayed)

    expect(response.recognised).toEqual({ brand: 'Glow Co', name: 'Serum', variant: null, form: 'spray', category: 'skin' })
    expect(response.product!.product.form).toBe('spray')
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
      product: { ...named.product!, product: { id: 'p2', kind: 'unnamed', brand: '', name: '', variant: null, form: null, category: 'other', imageUrl: null } },
    }

    const response = toScanItemResponse(unnamed)

    expect(toScanItemResponse(named).product!.product).toMatchObject({ kind: 'named' })
    expect(response.product!.product).toEqual({ id: 'p2', kind: 'unnamed', brand: '', name: '', variant: null, form: null, category: 'other', imageUrl: null })
    expect(ScanItemResponse.safeParse(response).success).toBe(true)
  })

  it('rejects a product kind the response schema does not name', () => {
    const response = toScanItemResponse(readyItem())

    const parsed = ScanItemResponse.safeParse({ ...response, product: { ...response.product!, product: { ...response.product!.product, kind: 'mystery' } } })

    expect(parsed.success).toBe(false)
  })
  describe('an unidentified item', () => {
    const CONCERNS = [
      { kind: 'banned-substance', severity: 'high', ingredients: ['mercury', 'hydroquinone', 'corticosteroids'], why: 'w1', whoShouldTakeCare: 'x1', traits: [], sources: [] },
      { kind: 'irritation', severity: 'medium', ingredients: [], why: 'w2', whoShouldTakeCare: 'x2', traits: ['sensitive'], sources: [] },
    ]
    const unidentifiedItem = (over: Partial<NonNullable<ScanItemView['noLabel']>> = {}): ScanItemView => ({
      id: 'item-4',
      position: 2,
      state: 'unidentified',
      reason: null,
      noLabel: { source: 'market-vendor', purpose: 'lighten', usedFor: 'over-2-years', concerns: CONCERNS, rulesVersion: 1, ...over },
      image: null,
    })

    it('publishes the answers, the cautions field by field and the rules version, with a null image and no product', () => {
      const response = toScanItemResponse(unidentifiedItem({ description: 'A pink tub' }))

      expect(response).toEqual({
        id: 'item-4',
        position: 2,
        state: 'unidentified',
        reason: null,
        noLabel: { source: 'market-vendor', purpose: 'lighten', usedFor: 'over-2-years', description: 'A pink tub', concerns: CONCERNS, rulesVersion: 1 },
        image: null,
      })
      expect(response).not.toHaveProperty('product')
      expect(ScanItemResponse.safeParse(response).success).toBe(true)
    })

    it('leaves description out of the block, not undefined, when the user gave none', () => {
      const response = toScanItemResponse(unidentifiedItem())

      expect(response.noLabel).not.toHaveProperty('description')
      expect(Object.keys(response.noLabel!)).not.toContain('description')
    })

    it('leaves out a field the view gains that the response schema does not name, in the block and in each caution', () => {
      const item = unidentifiedItem()
      const grown = {
        ...item,
        noLabel: { ...item.noLabel!, internalNote: 'n', concerns: [{ ...CONCERNS[0]!, internalNote: 'n' }, CONCERNS[1]!] },
      } as unknown as ScanItemView

      expect(toScanItemResponse(item)).toHaveProperty('noLabel')
      expect(toScanItemResponse(grown)).toEqual(toScanItemResponse(item))
    })

    it('leaves noLabel out of the response, not undefined, for every other state', () => {
      for (const item of [readyItem(), { id: 'i', position: 0, state: 'needs-identification', reason: 'unreadable', image: null } as ScanItemView]) {
        expect(toScanItemResponse(item)).not.toHaveProperty('noLabel')
        expect(Object.keys(toScanItemResponse(item))).not.toContain('noLabel')
      }
    })

    // Written out, not made by the presenter, so a refusal below is the schema's and not an artefact of a missing block.
    const wire = (over: Record<string, unknown> = {}, without: string[] = []) => {
      const noLabel: Record<string, unknown> = { source: 'market-vendor', purpose: 'lighten', usedFor: 'over-2-years', concerns: CONCERNS, rulesVersion: 1, ...over }
      for (const key of without) delete noLabel[key]
      return { id: 'item-4', position: 2, state: 'unidentified', reason: null, noLabel, image: null }
    }

    it('accepts a block with every field, and one with a description', () => {
      expect(ScanItemResponse.safeParse(wire()).success).toBe(true)
      expect(ScanItemResponse.safeParse(wire({ description: 'A pink tub' })).success).toBe(true)
    })

    it.each([
      ['source', { source: 'a stall' }],
      ['purpose', { purpose: 'bleach' }],
      ['usedFor', { usedFor: 'a while' }],
    ])('rejects a %s the response schema does not name', (_field, over) => {
      expect(ScanItemResponse.safeParse(wire()).success).toBe(true)

      expect(ScanItemResponse.safeParse(wire(over)).success).toBe(false)
    })

    it('accepts every source, purpose and time used the response schema names', () => {
      for (const source of ['market-vendor', 'pharmacy', 'online', 'gift', 'not-sure']) expect(ScanItemResponse.safeParse(wire({ source })).success, source).toBe(true)
      for (const purpose of ['lighten', 'moisturise', 'treat-spots', 'not-sure']) expect(ScanItemResponse.safeParse(wire({ purpose })).success, purpose).toBe(true)
      for (const usedFor of ['under-1-month', '1-6-months', '6-months-2-years', 'over-2-years']) expect(ScanItemResponse.safeParse(wire({ usedFor })).success, usedFor).toBe(true)
    })

    it.each(['source', 'purpose', 'usedFor', 'concerns', 'rulesVersion'])('requires %s in the block', (field) => {
      expect(ScanItemResponse.safeParse(wire()).success).toBe(true)

      expect(ScanItemResponse.safeParse(wire({}, [field])).success).toBe(false)
    })
  })
})
