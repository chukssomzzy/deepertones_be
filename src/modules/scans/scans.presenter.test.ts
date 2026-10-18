import { describe, expect, it } from 'vitest'
import type { ScanItemView, ScanPhotoView, ScanView } from './scans.service'
import { toScanItemResponse, toScanPhotoResponse, toScanResponse } from './scans.presenter'
import { ScanItemResponse, ScanPhotoResponse, ScanResponse } from './scans.schemas'

const readyItem = (): ScanItemView => ({
  id: 'item-1',
  photoId: 'photo-1',
  position: 0,
  state: 'ready',
  reason: null,
  recognised: { brand: 'Glow Co', name: 'Serum', variant: null, form: null, category: 'skin' },
  product: { id: 'p1', kind: 'named', brand: 'Glow Co', name: 'Serum', variant: null, form: null, category: 'skin', imageUrl: null },
  image: { kind: 'stock', url: 'https://example.test/serum.jpg' },
})

describe('toScanItemResponse', () => {
  it('publishes the product summary field by field, and nothing else about the product', () => {
    expect(toScanItemResponse(readyItem())).toEqual({
      id: 'item-1',
      photoId: 'photo-1',
      position: 0,
      state: 'ready',
      reason: null,
      recognised: { brand: 'Glow Co', name: 'Serum', variant: null, form: null, category: 'skin' },
      product: { id: 'p1', kind: 'named', brand: 'Glow Co', name: 'Serum', variant: null, form: null, category: 'skin', imageUrl: null },
      image: { kind: 'stock', url: 'https://example.test/serum.jpg' },
    })
  })

  it('publishes exactly the summary keys for a ready item\'s product, even when the view carries formulation, concerns and reference', () => {
    const carrying = {
      ...readyItem(),
      product: { ...readyItem().product!, formulation: { id: 'f1' }, concerns: [], reference: { version: 'v1' }, product: { id: 'nested' } },
    } as unknown as ScanItemView

    const response = toScanItemResponse(carrying)

    expect(Object.keys(response.product!).sort()).toEqual(['brand', 'category', 'form', 'id', 'imageUrl', 'kind', 'name', 'variant'])
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
    const item: ScanItemView = { id: 'item-2', photoId: null, position: 1, state: 'failed', reason: 'label-unreadable', image: { kind: 'user', url: '/scans/photos/t' } }

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
    const item: ScanItemView = { id: 'item-3', photoId: null, position: 0, state, reason, image: null }

    const response = toScanItemResponse(item)

    expect(response).toMatchObject({ state, reason })
    expect(ScanItemResponse.safeParse(response).success).toBe(true)
  })

  it('publishes retakesLeft on an item asking for a retake, as the response schema allows', () => {
    const item: ScanItemView = { id: 'item-3', photoId: null, position: 0, state: 'needs-retake', reason: 'label-not-visible', retakesLeft: 2, image: null }

    const response = toScanItemResponse(item)

    expect(response.retakesLeft).toBe(2)
    expect(ScanItemResponse.safeParse(response).success).toBe(true)
  })

  it('leaves retakesLeft out of the response, not undefined, when the item has none (needs-identification, or any other state)', () => {
    const item: ScanItemView = { id: 'item-3', photoId: null, position: 0, state: 'needs-identification', reason: 'unreadable', image: null }

    expect(toScanItemResponse(item)).not.toHaveProperty('retakesLeft')
    expect(Object.keys(toScanItemResponse(item))).not.toContain('retakesLeft')
    expect(Object.keys(toScanItemResponse(readyItem()))).not.toContain('retakesLeft')
  })

  it('publishes the product\'s kind, and an unnamed product with its empty brand and name, as the response schema allows', () => {
    const named = readyItem()
    const unnamed: ScanItemView = {
      ...named,
      product: { id: 'p2', kind: 'unnamed', brand: '', name: '', variant: null, form: null, category: 'other', imageUrl: null },
    }

    const response = toScanItemResponse(unnamed)

    expect(toScanItemResponse(named).product).toMatchObject({ kind: 'named' })
    expect(response.product).toEqual({ id: 'p2', kind: 'unnamed', brand: '', name: '', variant: null, form: null, category: 'other', imageUrl: null })
    expect(ScanItemResponse.safeParse(response).success).toBe(true)
  })

  it('rejects a product kind the response schema does not name', () => {
    const response = toScanItemResponse(readyItem())

    const parsed = ScanItemResponse.safeParse({ ...response, product: { ...response.product!, kind: 'mystery' } })

    expect(parsed.success).toBe(false)
  })
  describe('an unidentified item', () => {
    const CONCERNS = [
      { kind: 'banned-substance', severity: 'high', ingredients: ['mercury', 'hydroquinone', 'corticosteroids'], why: 'w1', whoShouldTakeCare: 'x1', traits: [], sources: [] },
      { kind: 'irritation', severity: 'medium', ingredients: [], why: 'w2', whoShouldTakeCare: 'x2', traits: ['sensitive'], sources: [] },
    ]
    const unidentifiedItem = (over: Partial<NonNullable<ScanItemView['noLabel']>> = {}): ScanItemView => ({
      id: 'item-4',
      photoId: null,
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
        photoId: null,
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
      for (const item of [readyItem(), { id: 'i', photoId: null, position: 0, state: 'needs-identification', reason: 'unreadable', image: null } as ScanItemView]) {
        expect(toScanItemResponse(item)).not.toHaveProperty('noLabel')
        expect(Object.keys(toScanItemResponse(item))).not.toContain('noLabel')
      }
    })

    // Written out, not made by the presenter, so a refusal below is the schema's and not an artefact of a missing block.
    const wire = (over: Record<string, unknown> = {}, without: string[] = []) => {
      const noLabel: Record<string, unknown> = { source: 'market-vendor', purpose: 'lighten', usedFor: 'over-2-years', concerns: CONCERNS, rulesVersion: 1, ...over }
      for (const key of without) delete noLabel[key]
      return { id: 'item-4', photoId: null, position: 2, state: 'unidentified', reason: null, noLabel, image: null }
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

describe('toScanItemResponse: the photo an item was read from', () => {
  it('publishes photoId as the id of the photo the item came from', () => {
    expect(toScanItemResponse(readyItem()).photoId).toBe('photo-1')
  })

  it('publishes photoId as null, not left out, for an item from before the column, which the response schema allows', () => {
    const response = toScanItemResponse({ ...readyItem(), photoId: null })

    expect(response).toHaveProperty('photoId', null)
    expect(ScanItemResponse.safeParse(response).success).toBe(true)
  })
})

const photoView = (over: Partial<ScanPhotoView> = {}): ScanPhotoView => ({
  id: 'photo-1',
  position: 0,
  state: 'recognised',
  skipped: { notBeauty: 2, unreadable: 3, overLimit: 4, dailyLimit: 5 },
  ...over,
})

describe('toScanPhotoResponse', () => {
  it('publishes the id, the position, the state and the four skipped counts, field by field', () => {
    expect(toScanPhotoResponse(photoView())).toEqual({
      id: 'photo-1',
      position: 0,
      state: 'recognised',
      skipped: { notBeauty: 2, unreadable: 3, overLimit: 4, dailyLimit: 5 },
    })
  })

  it('leaves out a field the view gains that the response schema does not name, on the photo and in skipped', () => {
    const grown = { ...photoView(), photoKey: 'photos/secret', recognition: '{}', skipped: { ...photoView().skipped, internal: 9 } } as unknown as ScanPhotoView

    expect(toScanPhotoResponse(grown)).toEqual(toScanPhotoResponse(photoView()))
    expect(Object.keys(toScanPhotoResponse(grown).skipped).sort()).toEqual(['dailyLimit', 'notBeauty', 'overLimit', 'unreadable'])
  })

  it.each(['recognising', 'recognised', 'rejected'] as const)('shows a %s photo, which the response schema allows', (state) => {
    expect(ScanPhotoResponse.safeParse(toScanPhotoResponse(photoView({ state }))).success).toBe(true)
  })

  it('is refused by the response schema when the state is not one it names', () => {
    expect(ScanPhotoResponse.safeParse({ ...toScanPhotoResponse(photoView()), state: 'lost' }).success).toBe(false)
  })
})

describe('toScanResponse', () => {
  const scanView = (over: Partial<ScanView> = {}): ScanView => ({
    id: 'scan-1',
    createdAt: new Date('2030-06-15T12:00:00.000Z'),
    kind: 'shelf',
    photos: [photoView(), photoView({ id: 'photo-2', position: 1, state: 'rejected' })],
    items: [readyItem()],
    ...over,
  })

  it('publishes exactly id, createdAt, kind, photos and items', () => {
    expect(Object.keys(toScanResponse(scanView())).sort()).toEqual(['createdAt', 'id', 'items', 'kind', 'photos'])
  })

  it('publishes the kind, and each photo as toScanPhotoResponse shows it, in the order given', () => {
    const response = toScanResponse(scanView())

    expect(response.kind).toBe('shelf')
    expect(response.photos).toEqual([toScanPhotoResponse(photoView()), toScanPhotoResponse(photoView({ id: 'photo-2', position: 1, state: 'rejected' }))])
    expect(response.items).toEqual([toScanItemResponse(readyItem())])
  })

  it('shows a product scan with kind product', () => {
    expect(toScanResponse(scanView({ kind: 'product' })).kind).toBe('product')
  })

  it('shows a scan with no photos as an empty list, not a missing field', () => {
    expect(toScanResponse(scanView({ photos: [] }))).toHaveProperty('photos', [])
  })

  it('makes a response the response schema accepts, and refuses a kind it does not name', () => {
    const response = toScanResponse(scanView())

    expect(ScanResponse.safeParse(response).success).toBe(true)
    expect(ScanResponse.safeParse({ ...response, kind: 'face' }).success).toBe(false)
  })
})
