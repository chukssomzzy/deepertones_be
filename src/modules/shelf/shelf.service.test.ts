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
const entry = (who: Actor, entryId: string) => runAs(who, () => service.entry(entryId))
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
      // Adding from search is pinned by the route tests; these cases never add.
      createTyped: async () => {
        throw new Error('not used here')
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

// The shelf as the shelf verdict reads it (spec #171, slice D1): by profile id, with no session (the build runs as a job), as narrow rows (ids, not views), in a fixed order so that the fingerprint and the response are the same every time.
describe('ShelfService.activeEntriesFor', () => {
  it('gives the profile\'s active entries oldest added first, entries added at the same time by id, whatever order they were last scanned in', async () => {
    put(AMARA.profileId, 1, { addedAt: at(30 * MINUTE), lastScannedAt: at(1 * MINUTE) })
    put(AMARA.profileId, 2, { addedAt: at(10 * MINUTE), lastScannedAt: at(90 * MINUTE) })
    put(AMARA.profileId, 4, { addedAt: at(20 * MINUTE) })
    put(AMARA.profileId, 3, { addedAt: at(10 * MINUTE) })

    const rows = await service.activeEntriesFor(AMARA.profileId)

    expect(rows.map((row) => row.id)).toEqual(['entry-2', 'entry-3', 'entry-4', 'entry-1'])
  })

  it('gives a product as its id, kind, added time, catalog product and formulation, and a no-label entry as its id, kind, added time and source item: nothing else', async () => {
    put(AMARA.profileId, 1, { addedAt: at(1 * MINUTE) })
    put(AMARA.profileId, 2, { kind: 'no-label', productId: null, formulationId: null, addedAt: at(2 * MINUTE) })

    const rows = await service.activeEntriesFor(AMARA.profileId)

    expect(rows).toEqual([
      { id: 'entry-1', kind: 'product', addedAt: at(1 * MINUTE), productId: 'product-1', formulationId: 'formulation-1' },
      { id: 'entry-2', kind: 'no-label', addedAt: at(2 * MINUTE), itemId: 'item-2' },
    ])
  })

  it('leaves out an entry the user took off the shelf, and every entry of another profile', async () => {
    put(AMARA.profileId, 1)
    put(AMARA.profileId, 2, { removedAt: at(5 * MINUTE), removedReason: 'finished' })
    put(TOLU.profileId, 3)

    const rows = await service.activeEntriesFor(AMARA.profileId)

    expect(rows.map((row) => row.id)).toEqual(['entry-1'])
  })

  it('leaves out a product row that has no formulation, as the shelf list does, since there is nothing to judge', async () => {
    put(AMARA.profileId, 1)
    put(AMARA.profileId, 2, { formulationId: null })

    const rows = await service.activeEntriesFor(AMARA.profileId)

    expect(rows.map((row) => row.id)).toEqual(['entry-1'])
  })

  it('answers for the profile it is asked about and never for the caller: it needs no session, and a session of another profile changes nothing', async () => {
    put(AMARA.profileId, 1)
    put(TOLU.profileId, 2)

    expect((await service.activeEntriesFor(AMARA.profileId)).map((row) => row.id)).toEqual(['entry-1'])
    expect((await runAs(TOLU, () => service.activeEntriesFor(AMARA.profileId))).map((row) => row.id)).toEqual(['entry-1'])
  })

  it('gives the whole active shelf, not the 200 the shelf list is kept to: the least recently scanned entry of 201 is still there', async () => {
    expect(SHELF_POLICY.maxEntries).toBe(200)
    // Entry 1 is the least recently scanned (and the first added), the one a cap of 200 newest-scanned would drop.
    for (let n = 1; n <= SHELF_POLICY.maxEntries + 1; n++) put(AMARA.profileId, n)

    const rows = await service.activeEntriesFor(AMARA.profileId)

    expect(rows).toHaveLength(SHELF_POLICY.maxEntries + 1)
    expect(rows[0]!.id).toBe('entry-1')
    expect(new Set(rows.map((row) => row.id)).size).toBe(SHELF_POLICY.maxEntries + 1)
  })

  it('answers an empty list for a profile with no shelf', async () => {
    expect(await service.activeEntriesFor('profile-nobody')).toEqual([])
  })
})

// One entry, by id (spec #171 follow-up): the same view `list` builds for it, or SHELF_ENTRY_NOT_FOUND, the answer `remove` gives for an entry that is not the caller's.
describe('ShelfService.entry', () => {
  it('gives a product entry exactly as list shows it, through the same view path', async () => {
    put(AMARA.profileId, 1)
    put(AMARA.profileId, 2)

    const { entries } = await list(AMARA)

    expect(await entry(AMARA, 'entry-2')).toEqual(entries.find((e) => e.id === 'entry-2'))
    expect(await entry(AMARA, 'entry-2')).toMatchObject({ id: 'entry-2', kind: 'product', source: { scanId: 'scan-2', itemId: 'item-2' }, product: summaryOf('formulation-2') })
  })

  it('gives a no-label entry exactly as list shows it', async () => {
    put(AMARA.profileId, 1, { kind: 'no-label', productId: null, formulationId: null })

    const { entries } = await list(AMARA)

    expect(await entry(AMARA, 'entry-1')).toEqual(entries[0])
    expect(await entry(AMARA, 'entry-1')).toMatchObject({ kind: 'no-label', noLabel: { source: 'market-vendor', rulesVersion: 1 } })
    expect(await entry(AMARA, 'entry-1')).not.toHaveProperty('product')
  })

  it('reads only the one entry\'s product, not the shelf\'s', async () => {
    put(AMARA.profileId, 1)
    put(AMARA.profileId, 2)
    put(AMARA.profileId, 3, { kind: 'no-label', productId: null, formulationId: null })

    await entry(AMARA, 'entry-2')

    expect(summaryCalls.flat()).toEqual(['formulation-2'])
    expect(noLabelCalls.flat()).toEqual([])
  })

  it('refuses an unknown id with SHELF_ENTRY_NOT_FOUND', async () => {
    put(AMARA.profileId, 1)

    expect((await errorOf(entry(AMARA, 'entry-nobody'))).code).toBe('SHELF_ENTRY_NOT_FOUND')
  })

  it('refuses an entry taken off the shelf, which remove still answers as done', async () => {
    put(AMARA.profileId, 1, { removedAt: at(5 * MINUTE), removedReason: 'finished' })

    expect((await errorOf(entry(AMARA, 'entry-1'))).code).toBe('SHELF_ENTRY_NOT_FOUND')
  })

  it('refuses another profile\'s entry the same way as one that does not exist, and the owner still has it', async () => {
    put(AMARA.profileId, 1)

    const refused = await errorOf(entry(TOLU, 'entry-1'))
    const unknown = await errorOf(entry(TOLU, 'entry-nobody'))

    expect(refused.code).toBe('SHELF_ENTRY_NOT_FOUND')
    expect(refused.message).toBe(unknown.message)
    expect((await entry(AMARA, 'entry-1')).id).toBe('entry-1')
  })

  it('refuses an entry whose product no longer resolves, as list leaves it out, and logs only its id', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    put(AMARA.profileId, 1)
    known.delete('formulation-1')

    expect((await errorOf(entry(AMARA, 'entry-1'))).code).toBe('SHELF_ENTRY_NOT_FOUND')

    expect(error).toHaveBeenCalledWith({ outcome: 'shelf-entry-unresolved', entryId: 'entry-1' })
  })
})

// The views the shelf verdict joins to its products (and the routine and the events publisher can too): by the profile id given, with no session, for the ids asked.
describe('ShelfService.viewsFor', () => {
  it('gives each asked entry as the view list shows it, by entry id', async () => {
    put(AMARA.profileId, 1)
    put(AMARA.profileId, 2, { kind: 'no-label', productId: null, formulationId: null })
    put(AMARA.profileId, 3)
    const { entries } = await list(AMARA)

    const views = await service.viewsFor(AMARA.profileId, ['entry-1', 'entry-2'])

    expect([...views.keys()].sort()).toEqual(['entry-1', 'entry-2'])
    expect(views.get('entry-1')).toEqual(entries.find((e) => e.id === 'entry-1'))
    expect(views.get('entry-2')).toEqual(entries.find((e) => e.id === 'entry-2'))
  })

  it('answers for the profile it is given and never for the caller: it needs no session, and a session of another profile changes nothing', async () => {
    put(AMARA.profileId, 1)
    put(TOLU.profileId, 2)

    expect([...(await service.viewsFor(AMARA.profileId, ['entry-1'])).keys()]).toEqual(['entry-1'])
    expect([...(await runAs(TOLU, () => service.viewsFor(AMARA.profileId, ['entry-1']))).keys()]).toEqual(['entry-1'])
    expect((await runAs(TOLU, () => service.viewsFor(AMARA.profileId, ['entry-2']))).size).toBe(0)
  })

  it('leaves out an entry that is removed, another profile\'s, unknown or unresolved, without throwing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    put(AMARA.profileId, 1)
    put(AMARA.profileId, 2, { removedAt: at(5 * MINUTE), removedReason: 'stopped' })
    put(TOLU.profileId, 3)
    put(AMARA.profileId, 4)
    known.delete('formulation-4')

    const views = await service.viewsFor(AMARA.profileId, ['entry-1', 'entry-2', 'entry-3', 'entry-4', 'entry-nobody'])

    expect([...views.keys()]).toEqual(['entry-1'])
  })

  it('reads the products in one batched call and the no-label answers in one, for the whole ask', async () => {
    put(AMARA.profileId, 1)
    put(AMARA.profileId, 2)
    put(AMARA.profileId, 3, { kind: 'no-label', productId: null, formulationId: null })
    put(AMARA.profileId, 4, { kind: 'no-label', productId: null, formulationId: null })

    await service.viewsFor(AMARA.profileId, ['entry-1', 'entry-2', 'entry-3', 'entry-4'])

    expect(summaryCalls).toHaveLength(1)
    expect([...summaryCalls[0]!].sort()).toEqual(['formulation-1', 'formulation-2'])
    expect(noLabelCalls).toHaveLength(1)
    expect([...noLabelCalls[0]!].sort()).toEqual(['item-3', 'item-4'])
  })

  it('is not capped at the 200 entries list shows: the least recently scanned of 201 is still answered', async () => {
    for (let n = 1; n <= SHELF_POLICY.maxEntries + 1; n++) put(AMARA.profileId, n)

    const views = await service.viewsFor(AMARA.profileId, ['entry-1'])

    expect([...views.keys()]).toEqual(['entry-1'])
  })

  it('answers an empty map for no ids, or for a profile with no shelf', async () => {
    put(AMARA.profileId, 1)

    expect((await service.viewsFor(AMARA.profileId, [])).size).toBe(0)
    expect((await service.viewsFor('profile-nobody', ['entry-1'])).size).toBe(0)
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
