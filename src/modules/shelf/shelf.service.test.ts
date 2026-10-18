import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Actor, runAs } from '../../lib/context'
import type { ProductSummary } from '../catalog/catalog.service'
import type { ScanItemView } from '../scans/scans.service'
import { FakeShelfRepository } from './shelf.repository.fake'
import { SHELF_POLICY, ShelfService } from './shelf.service'
import { FakeShelfStore } from './shelf.store.fake'
import type { ShelfEntryRow } from './shelf.types'

// The one clock every test hangs off; later times are offsets from it.
const T0 = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs)

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error as Error & { code?: string }
  }
  throw new Error('expected the promise to reject')
}

const actor = (userId: string, profileId: string): Extract<Actor, { kind: 'user' }> => ({ kind: 'user', userId, status: 'anonymous', profileId })
const AMARA = actor('user-amara', 'profile-amara')
const TOLU = actor('user-tolu', 'profile-tolu')

type NoLabelView = NonNullable<ScanItemView['noLabel']>

const summaryOf = (formulationId: string): ProductSummary => ({
  id: `product-of-${formulationId}`,
  kind: 'named',
  brand: 'Glow Co',
  name: `Serum ${formulationId}`,
  variant: null,
  form: null,
  category: 'skin',
  imageUrl: null,
})

let store: FakeShelfStore
let known: Set<string>
let summaryCalls: string[][]
let noLabelCalls: string[][]
let service: ShelfService

/** A shelf row as a scan's move leaves it. Its formulation resolves in the catalog unless the test says otherwise. */
const put = (profileId: string, n: number, over: Partial<ShelfEntryRow> = {}): ShelfEntryRow => {
  const row: ShelfEntryRow = {
    id: `entry-${n}`,
    profileId,
    kind: 'product',
    productId: `product-${n}`,
    formulationId: `formulation-${n}`,
    scanId: `scan-${n}`,
    itemId: `item-${n}`,
    addedAt: at(n * MINUTE),
    lastScannedAt: at(n * MINUTE),
    removedAt: null,
    removedReason: null,
    ...over,
  }
  store.rows.push(row)
  if (row.formulationId !== null) known.add(row.formulationId)
  return row
}

const list = (who: Actor) => runAs(who, () => service.list())
const remove = (who: Actor, entryId: string, reason?: 'finished' | 'stopped' | 'not-mine') => runAs(who, () => service.remove(entryId, reason))

beforeEach(() => {
  store = new FakeShelfStore()
  known = new Set()
  summaryCalls = []
  noLabelCalls = []
  service = new ShelfService({
    repository: new FakeShelfRepository(store),
    // Answers only the formulations the test made known: the rest "no longer resolve", as one the catalog deleted does.
    catalog: {
      productSummaries: async (ids: string[]) => {
        summaryCalls.push(ids)
        return new Map(ids.filter((id) => known.has(id)).map((id) => [id, summaryOf(id)]))
      },
    },
    scans: {
      noLabelViews: async (ids: string[]) => {
        noLabelCalls.push(ids)
        return new Map(ids.map((id): [string, NoLabelView] => [id, { source: 'market-vendor', purpose: 'lighten', usedFor: 'under-1-month', concerns: [], rulesVersion: 1 }]))
      },
    },
    now: () => at(100 * MINUTE),
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ShelfService.list', () => {
  it('keeps the shelf to 200 entries, the newest scanned, and reads their products in one call', async () => {
    expect(SHELF_POLICY.maxEntries).toBe(200)
    for (let n = 1; n <= 201; n++) put(AMARA.profileId, n)

    const { entries } = await list(AMARA)

    expect(entries).toHaveLength(200)
    expect(entries[0]!.id).toBe('entry-201')
    expect(entries[199]!.id).toBe('entry-2')
    expect(summaryCalls).toHaveLength(1)
    expect(summaryCalls[0]).toHaveLength(200)
  })

  it('reads a product through its formulation and a no-label entry through its source item, each in one batched call', async () => {
    put(AMARA.profileId, 1)
    put(AMARA.profileId, 2, { kind: 'no-label', productId: null, formulationId: null })
    put(AMARA.profileId, 3, { kind: 'no-label', productId: null, formulationId: null })

    const { entries } = await list(AMARA)

    expect(entries.map((e) => [e.id, e.kind])).toEqual([['entry-3', 'no-label'], ['entry-2', 'no-label'], ['entry-1', 'product']])
    expect(summaryCalls.flat()).toEqual(['formulation-1'])
    expect(noLabelCalls).toHaveLength(1)
    expect([...noLabelCalls[0]!].sort()).toEqual(['item-2', 'item-3'])
    expect(entries[2]).toMatchObject({ source: { scanId: 'scan-1', itemId: 'item-1' }, product: summaryOf('formulation-1') })
    expect(entries[0]).toMatchObject({ source: { scanId: 'scan-3', itemId: 'item-3' }, noLabel: { source: 'market-vendor', rulesVersion: 1 } })
  })

  it('leaves out an entry whose formulation no longer resolves, logging only its id', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    put(AMARA.profileId, 1)
    put(AMARA.profileId, 2)
    known.delete('formulation-2')

    const { entries } = await list(AMARA)

    expect(entries.map((e) => e.id)).toEqual(['entry-1'])
    expect(error).toHaveBeenCalledWith({ outcome: 'shelf-entry-unresolved', entryId: 'entry-2' })
  })

  it('shows a profile only its own entries', async () => {
    put(AMARA.profileId, 1)
    put(TOLU.profileId, 2)

    expect((await list(AMARA)).entries.map((e) => e.id)).toEqual(['entry-1'])
    expect((await list(TOLU)).entries.map((e) => e.id)).toEqual(['entry-2'])
  })
})

describe('ShelfService.remove', () => {
  it('takes the entry off the shelf with the reason and the time it was removed', async () => {
    put(AMARA.profileId, 1)

    await remove(AMARA, 'entry-1', 'finished')

    expect((await list(AMARA)).entries).toEqual([])
    expect(store.rows[0]).toMatchObject({ removedReason: 'finished' })
    expect(store.rows[0]!.removedAt!.getTime()).toBe(at(100 * MINUTE).getTime())
  })

  it('succeeds again for an entry already removed, changing nothing', async () => {
    put(AMARA.profileId, 1)
    await remove(AMARA, 'entry-1', 'finished')

    await expect(remove(AMARA, 'entry-1', 'stopped')).resolves.toBeUndefined()

    expect(store.rows[0]).toMatchObject({ removedReason: 'finished' })
  })

  it('refuses another profile\'s entry and an unknown one with SHELF_ENTRY_NOT_FOUND, leaving the entry on its shelf', async () => {
    put(AMARA.profileId, 1)

    expect((await errorOf(remove(TOLU, 'entry-1'))).code).toBe('SHELF_ENTRY_NOT_FOUND')
    expect((await errorOf(remove(AMARA, 'entry-nobody'))).code).toBe('SHELF_ENTRY_NOT_FOUND')

    expect((await list(AMARA)).entries.map((e) => e.id)).toEqual(['entry-1'])
  })
})
