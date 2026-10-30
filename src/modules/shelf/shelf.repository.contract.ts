import { describe, expect, it } from 'vitest'
import type { ShelfRepository } from './shelf.repository'
import type { ShelfEntryRow } from './shelf.types'

// The one clock every fixture hangs off; later times are offsets from it.
const BASE = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000
const at = (offsetMs: number) => new Date(BASE.getTime() + offsetMs)

/**
 * What a shelf contract run needs: the repository, a profile that really exists (D1 enforces profile_products.profile_id -> profiles),
 * a way to put a row on a shelf and a way to read every row of a profile, removed ones included.
 *
 * `put` writes the row as the scan moves will have written it. Those moves belong to the scans repository and are proved in its
 * contract; the shelf's reads and removes are proved here from rows already in place. `stored` is the one way to see a removed row,
 * as the repository has no read for them.
 */
export type ShelfContractSetup = {
  repository: ShelfRepository
  newProfile: () => Promise<string>
  put: (row: ShelfEntryRow) => Promise<void>
  stored: (profileId: string) => Promise<ShelfEntryRow[]>
}

// Ids are unique per call: the D1 run shares one database across every test in its file.
const productRow = (profileId: string, over: Partial<ShelfEntryRow> = {}): ShelfEntryRow => ({
  id: `entry-${crypto.randomUUID()}`,
  profileId,
  kind: 'product',
  productId: `product-${crypto.randomUUID()}`,
  formulationId: `formulation-${crypto.randomUUID()}`,
  scanId: `scan-${crypto.randomUUID()}`,
  itemId: `item-${crypto.randomUUID()}`,
  addedAt: BASE,
  lastScannedAt: BASE,
  removedAt: null,
  removedReason: null,
  ...over,
})
const noLabelRow = (profileId: string, over: Partial<ShelfEntryRow> = {}): ShelfEntryRow =>
  productRow(profileId, { kind: 'no-label', productId: null, formulationId: null, ...over })

const idsOf = (rows: ShelfEntryRow[]) => rows.map((row) => row.id)

/**
 * Behaviour every ShelfRepository must have. Runs against the fake (unit tier) and real local D1 (integration tier).
 *
 * `remove(profileId, entryId, reason | null, at)` answers what it found: `'removed'` (the profile's active row is now removed),
 * `'already-removed'` (the profile's row was removed before; it is left exactly as it was) or `'not-found'` (no such row for that
 * profile: unknown, or another profile's, which is left alone).
 */
export const shelfRepositoryContract = (name: string, make: () => ShelfContractSetup | Promise<ShelfContractSetup>) => {
  describe(`ShelfRepository contract: ${name}`, () => {
    describe('activeFor', () => {
      it('is empty for a profile with nothing on its shelf', async () => {
        const { repository, newProfile } = await make()

        expect(await repository.activeFor(await newProfile(), 200)).toEqual([])
      })

      it('returns an entry as it was stored, product and no-label alike', async () => {
        const { repository, newProfile, put } = await make()
        const profileId = await newProfile()
        const product = productRow(profileId, { addedAt: at(MINUTE), lastScannedAt: at(2 * MINUTE) })
        const noLabel = noLabelRow(profileId, { addedAt: at(MINUTE), lastScannedAt: at(MINUTE) })
        await put(product)
        await put(noLabel)

        const [first, second] = await repository.activeFor(profileId, 200)

        expect(first).toMatchObject({ ...product, addedAt: at(MINUTE), lastScannedAt: at(2 * MINUTE), removedAt: null, removedReason: null })
        expect(second).toMatchObject({ ...noLabel, productId: null, formulationId: null })
      })

      it('orders entries by last scanned time, newest first, whatever order they were put in', async () => {
        const { repository, newProfile, put } = await make()
        const profileId = await newProfile()
        const middle = productRow(profileId, { lastScannedAt: at(2 * MINUTE) })
        const newest = productRow(profileId, { lastScannedAt: at(3 * MINUTE) })
        const oldest = productRow(profileId, { lastScannedAt: at(MINUTE) })
        for (const row of [middle, oldest, newest]) await put(row)

        expect(idsOf(await repository.activeFor(profileId, 200))).toEqual([newest.id, middle.id, oldest.id])
      })

      it('orders entries that were scanned at the same moment the same way every time', async () => {
        const { repository, newProfile, put } = await make()
        const profileId = await newProfile()
        const rows = [productRow(profileId), productRow(profileId), noLabelRow(profileId), productRow(profileId)]
        for (const row of rows) await put(row)

        const first = idsOf(await repository.activeFor(profileId, 200))
        const second = idsOf(await repository.activeFor(profileId, 200))

        expect([...first].sort()).toEqual(idsOf(rows).sort())
        expect(second).toEqual(first)
      })

      it('puts entries scanned at the same moment in id order, under newer ones', async () => {
        const { repository, newProfile, put } = await make()
        const profileId = await newProfile()
        // One shared prefix keeps the ids unique across runs on a shared D1 while their order stays the suffixes'.
        const prefix = `entry-${crypto.randomUUID()}`
        const newer = productRow(profileId, { id: `${prefix}-c`, lastScannedAt: at(MINUTE) })
        const rows = [productRow(profileId, { id: `${prefix}-b` }), noLabelRow(profileId, { id: `${prefix}-a` }), productRow(profileId, { id: `${prefix}-d` })]
        for (const row of [rows[0]!, newer, rows[2]!, rows[1]!]) await put(row)

        expect(idsOf(await repository.activeFor(profileId, 200))).toEqual([`${prefix}-c`, `${prefix}-a`, `${prefix}-b`, `${prefix}-d`])
      })

      it('returns at most the limit, keeping the newest', async () => {
        const { repository, newProfile, put } = await make()
        const profileId = await newProfile()
        const rows = [1, 2, 3, 4].map((n) => productRow(profileId, { lastScannedAt: at(n * MINUTE) }))
        for (const row of rows) await put(row)

        expect(idsOf(await repository.activeFor(profileId, 3))).toEqual([rows[3]!.id, rows[2]!.id, rows[1]!.id])
        expect(await repository.activeFor(profileId, 4)).toHaveLength(4)
        expect(await repository.activeFor(profileId, 5)).toHaveLength(4)
      })

      it('leaves out removed entries, and a removed one does not use up the limit', async () => {
        const { repository, newProfile, put } = await make()
        const profileId = await newProfile()
        const removed = productRow(profileId, { lastScannedAt: at(3 * MINUTE), removedAt: at(4 * MINUTE), removedReason: 'finished' })
        const older = productRow(profileId, { lastScannedAt: at(2 * MINUTE) })
        const oldest = productRow(profileId, { lastScannedAt: at(MINUTE) })
        for (const row of [removed, older, oldest]) await put(row)

        expect(idsOf(await repository.activeFor(profileId, 2))).toEqual([older.id, oldest.id])
      })

      it('returns only the profile\'s own entries', async () => {
        const { repository, newProfile, put } = await make()
        const amara = await newProfile()
        const tolu = await newProfile()
        const hers = productRow(amara)
        const theirs = productRow(tolu)
        await put(hers)
        await put(theirs)

        expect(idsOf(await repository.activeFor(amara, 200))).toEqual([hers.id])
        expect(idsOf(await repository.activeFor(tolu, 200))).toEqual([theirs.id])
      })
    })

    describe('activeForProduct', () => {
      it('finds the profile\'s active entry for a product, as it was stored', async () => {
        const { repository, newProfile, put } = await make()
        const profileId = await newProfile()
        const wanted = productRow(profileId, { addedAt: at(MINUTE), lastScannedAt: at(2 * MINUTE) })
        await put(wanted)
        await put(productRow(profileId))

        expect(await repository.activeForProduct(profileId, wanted.productId!)).toMatchObject({ ...wanted, removedAt: null, removedReason: null })
      })

      it('finds nothing for a product the profile has not shelved', async () => {
        const { repository, newProfile, put } = await make()
        const profileId = await newProfile()
        await put(productRow(profileId))

        expect(await repository.activeForProduct(profileId, `product-${crypto.randomUUID()}`)).toBeNull()
      })

      it('finds nothing for an entry that was removed, whatever the reason', async () => {
        const { repository, newProfile, put } = await make()
        const profileId = await newProfile()
        const removed = productRow(profileId, { removedAt: at(MINUTE), removedReason: 'finished' })
        await put(removed)

        expect(await repository.activeForProduct(profileId, removed.productId!)).toBeNull()
      })

      it('finds nothing in a profile that did not shelve the product, though another profile did', async () => {
        const { repository, newProfile, put } = await make()
        const [amara, tolu] = [await newProfile(), await newProfile()]
        const hers = productRow(amara)
        await put(hers)

        expect(await repository.activeForProduct(tolu, hers.productId!)).toBeNull()
        expect((await repository.activeForProduct(amara, hers.productId!))!.id).toBe(hers.id)
      })

      it('does not take a no-label entry for a product', async () => {
        const { repository, newProfile, put } = await make()
        const profileId = await newProfile()
        await put(noLabelRow(profileId))

        expect(await repository.activeForProduct(profileId, `product-${crypto.randomUUID()}`)).toBeNull()
      })
    })

    describe('activeByIds', () => {
      it('finds the profile\'s active entries among the ids asked, as they were stored, in id order', async () => {
        const { repository, newProfile, put } = await make()
        const profileId = await newProfile()
        const prefix = `entry-${crypto.randomUUID()}`
        const product = productRow(profileId, { id: `${prefix}-b` })
        const noLabel = noLabelRow(profileId, { id: `${prefix}-a` })
        const unasked = productRow(profileId, { id: `${prefix}-c` })
        for (const row of [product, unasked, noLabel]) await put(row)

        expect(await repository.activeByIds(profileId, [product.id, noLabel.id])).toEqual([noLabel, product])
      })

      it('leaves out a removed entry, another profile\'s entry and an id nobody has', async () => {
        const { repository, newProfile, put } = await make()
        const profileId = await newProfile()
        const other = await newProfile()
        const kept = productRow(profileId)
        const removed = productRow(profileId, { removedAt: at(MINUTE), removedReason: 'stopped' })
        const foreign = productRow(other)
        for (const row of [kept, removed, foreign]) await put(row)

        expect(idsOf(await repository.activeByIds(profileId, [kept.id, removed.id, foreign.id, crypto.randomUUID()]))).toEqual([kept.id])
      })

      it('answers nothing for no ids', async () => {
        const { repository, newProfile, put } = await make()
        const profileId = await newProfile()
        await put(productRow(profileId))

        expect(await repository.activeByIds(profileId, [])).toEqual([])
      })

      it('is not capped: more ids than one statement can bind are all found', async () => {
        const { repository, newProfile, put } = await make()
        const profileId = await newProfile()
        const rows = Array.from({ length: 205 }, () => productRow(profileId))
        for (const row of rows) await put(row)

        expect(idsOf(await repository.activeByIds(profileId, idsOf(rows))).sort()).toEqual(idsOf(rows).sort())
      })
    })

    // #259 B4: the routines module needs to know which of a profile's entries were taken off the shelf, and why, so a step-down for a removed product can go on.
    // `removedFor(profileId)` answers every soft-removed row of the profile, as stored, oldest removal first (ties by id), and is not capped.
    describe('removedFor', () => {
      it('is empty for a profile with nothing removed, whatever is on its shelf', async () => {
        const { repository, newProfile, put } = await make()
        const profileId = await newProfile()
        await put(productRow(profileId))

        expect(await repository.removedFor(profileId)).toEqual([])
      })

      it('returns a removed entry as it was stored, with its time and reason, product and no-label alike', async () => {
        const { repository, newProfile, put } = await make()
        const profileId = await newProfile()
        const product = productRow(profileId, { removedAt: at(MINUTE), removedReason: 'finished' })
        const noLabel = noLabelRow(profileId, { removedAt: at(2 * MINUTE), removedReason: null })
        await put(product)
        await put(noLabel)

        const [first, second] = await repository.removedFor(profileId)

        expect(first).toMatchObject({ ...product, removedReason: 'finished' })
        expect(first!.removedAt!.getTime()).toBe(at(MINUTE).getTime())
        expect(second).toMatchObject({ ...noLabel, productId: null, removedReason: null })
        expect(second!.removedAt!.getTime()).toBe(at(2 * MINUTE).getTime())
      })

      it('gives each reason back as it was stored: finished, stopped, not-mine, and none', async () => {
        const { repository, newProfile, put } = await make()
        const profileId = await newProfile()
        const reasons = ['finished', 'stopped', 'not-mine', null] as const
        const rows = reasons.map((removedReason, n) => productRow(profileId, { removedAt: at((n + 1) * MINUTE), removedReason }))
        for (const row of rows) await put(row)

        expect((await repository.removedFor(profileId)).map((row) => [row.id, row.removedReason])).toEqual(rows.map((row) => [row.id, row.removedReason]))
      })

      it('leaves out an entry that is on the shelf', async () => {
        const { repository, newProfile, put } = await make()
        const profileId = await newProfile()
        const removed = productRow(profileId, { removedAt: at(MINUTE), removedReason: 'stopped' })
        await put(productRow(profileId))
        await put(removed)

        expect(idsOf(await repository.removedFor(profileId))).toEqual([removed.id])
      })

      it('returns only the profile\'s own removed entries', async () => {
        const { repository, newProfile, put } = await make()
        const amara = await newProfile()
        const tolu = await newProfile()
        const hers = productRow(amara, { removedAt: at(MINUTE), removedReason: 'finished' })
        const theirs = productRow(tolu, { removedAt: at(MINUTE), removedReason: 'finished' })
        await put(hers)
        await put(theirs)

        expect(idsOf(await repository.removedFor(amara))).toEqual([hers.id])
        expect(idsOf(await repository.removedFor(tolu))).toEqual([theirs.id])
      })

      it('orders entries by the time they were removed, oldest first, whatever order they were put in or last scanned', async () => {
        const { repository, newProfile, put } = await make()
        const profileId = await newProfile()
        const second = productRow(profileId, { lastScannedAt: at(MINUTE), removedAt: at(2 * MINUTE), removedReason: null })
        const third = productRow(profileId, { lastScannedAt: at(2 * MINUTE), removedAt: at(3 * MINUTE), removedReason: null })
        const first = productRow(profileId, { lastScannedAt: at(3 * MINUTE), removedAt: at(MINUTE), removedReason: null })
        for (const row of [second, third, first]) await put(row)

        expect(idsOf(await repository.removedFor(profileId))).toEqual([first.id, second.id, third.id])
      })

      it('puts entries removed at the same moment in id order', async () => {
        const { repository, newProfile, put } = await make()
        const profileId = await newProfile()
        const prefix = `entry-${crypto.randomUUID()}`
        const rows = ['c', 'a', 'b'].map((suffix) => productRow(profileId, { id: `${prefix}-${suffix}`, removedAt: at(MINUTE), removedReason: null }))
        for (const row of rows) await put(row)

        expect(idsOf(await repository.removedFor(profileId))).toEqual([`${prefix}-a`, `${prefix}-b`, `${prefix}-c`])
      })

      it('is not capped: more removed entries than one statement can bind are all found', async () => {
        const { repository, newProfile, put } = await make()
        const profileId = await newProfile()
        const rows = Array.from({ length: 205 }, () => productRow(profileId, { removedAt: at(MINUTE), removedReason: null }))
        for (const row of rows) await put(row)

        expect(idsOf(await repository.removedFor(profileId)).sort()).toEqual(idsOf(rows).sort())
      })

      it('finds an entry just removed through `remove`, with the reason it was given', async () => {
        const { repository, newProfile, put } = await make()
        const profileId = await newProfile()
        const row = productRow(profileId)
        await put(row)
        await repository.remove(profileId, row.id, 'finished', at(5 * MINUTE))

        const [found] = await repository.removedFor(profileId)

        expect(found).toMatchObject({ id: row.id, removedReason: 'finished' })
        expect(found!.removedAt!.getTime()).toBe(at(5 * MINUTE).getTime())
      })
    })

    describe('remove', () => {
      it('removes the profile\'s own entry with its reason and the time, and says it did', async () => {
        const { repository, newProfile, put, stored } = await make()
        const profileId = await newProfile()
        const row = productRow(profileId)
        await put(row)

        expect(await repository.remove(profileId, row.id, 'stopped', at(5 * MINUTE))).toBe('removed')

        expect(await repository.activeFor(profileId, 200)).toEqual([])
        const [kept] = await stored(profileId)
        expect(kept).toMatchObject({ id: row.id, removedReason: 'stopped' })
        expect(kept!.removedAt!.getTime()).toBe(at(5 * MINUTE).getTime())
      })

      it('removes an entry the person said was the wrong product (reason wrong-product), keeps that reason, and the product is then no longer on the shelf', async () => {
        const { repository, newProfile, put, stored } = await make()
        const profileId = await newProfile()
        const row = productRow(profileId)
        await put(row)

        expect(await repository.remove(profileId, row.id, 'wrong-product', at(2 * MINUTE))).toBe('removed')

        const [kept] = await stored(profileId)
        expect(kept).toMatchObject({ id: row.id, removedReason: 'wrong-product' })
        expect(kept!.removedAt!.getTime()).toBe(at(2 * MINUTE).getTime())
        expect(await repository.activeForProduct(profileId, row.productId!)).toBeNull()
        expect(await repository.remove(profileId, row.id, 'finished', at(3 * MINUTE))).toBe('already-removed')
        expect((await stored(profileId))[0]).toMatchObject({ removedReason: 'wrong-product' })
      })

      it('removes with no reason: the time is set and the reason stays empty', async () => {
        const { repository, newProfile, put, stored } = await make()
        const profileId = await newProfile()
        const row = noLabelRow(profileId)
        await put(row)

        expect(await repository.remove(profileId, row.id, null, at(MINUTE))).toBe('removed')

        const [kept] = await stored(profileId)
        expect(kept!.removedAt!.getTime()).toBe(at(MINUTE).getTime())
        expect(kept!.removedReason).toBeNull()
      })

      it('removes only the entry asked for', async () => {
        const { repository, newProfile, put } = await make()
        const profileId = await newProfile()
        const target = productRow(profileId, { lastScannedAt: at(MINUTE) })
        const other = productRow(profileId, { lastScannedAt: at(2 * MINUTE) })
        await put(target)
        await put(other)

        await repository.remove(profileId, target.id, null, at(3 * MINUTE))

        expect(idsOf(await repository.activeFor(profileId, 200))).toEqual([other.id])
      })

      it('says not-found for another profile\'s entry and leaves it on that shelf, untouched', async () => {
        const { repository, newProfile, put, stored } = await make()
        const owner = await newProfile()
        const intruder = await newProfile()
        const row = productRow(owner)
        await put(row)

        expect(await repository.remove(intruder, row.id, 'not-mine', at(MINUTE))).toBe('not-found')

        expect(idsOf(await repository.activeFor(owner, 200))).toEqual([row.id])
        expect((await stored(owner))[0]).toMatchObject({ removedAt: null, removedReason: null })
      })

      it('says not-found for an id nobody has', async () => {
        const { repository, newProfile } = await make()

        expect(await repository.remove(await newProfile(), crypto.randomUUID(), null, at(MINUTE))).toBe('not-found')
      })

      it('says already-removed for an entry removed before, and leaves its first time and reason as they were', async () => {
        const { repository, newProfile, put, stored } = await make()
        const profileId = await newProfile()
        const row = productRow(profileId)
        await put(row)
        await repository.remove(profileId, row.id, 'finished', at(MINUTE))

        expect(await repository.remove(profileId, row.id, 'not-mine', at(2 * MINUTE))).toBe('already-removed')

        const [kept] = await stored(profileId)
        expect(kept).toMatchObject({ removedReason: 'finished' })
        expect(kept!.removedAt!.getTime()).toBe(at(MINUTE).getTime())
      })
    })

    // removeMany(profileId, entryIds, reason | null, at) is all or nothing, in one write (on D1 one batch). It answers
    // `{ status: 'removed', removedIds }` (every id asked is now removed; `removedIds` are the ones THIS call removed, so an id that was already
    // removed is not among them, in any order) or `{ status: 'not-found' }` when ANY id is unknown or another profile's (not told apart,
    // already-removed ids of the profile are fine) and then nothing at all has changed. The service puts `removedIds` in request order.
    describe('removeMany', () => {
      const byId = (rows: ShelfEntryRow[], id: string) => rows.find((row) => row.id === id)!

      it('removes every entry named with the reason and the time, says which it removed, and leaves the others on the shelf', async () => {
        const { repository, newProfile, put, stored } = await make()
        const profileId = await newProfile()
        const [first, second, third] = [productRow(profileId), noLabelRow(profileId), productRow(profileId)]
        for (const row of [first, second, third]) await put(row)

        const result = await repository.removeMany(profileId, [first.id, second.id], 'stopped', at(5 * MINUTE))

        expect(result.status).toBe('removed')
        expect(result.status === 'removed' && [...result.removedIds].sort()).toEqual([first.id, second.id].sort())
        expect(idsOf(await repository.activeFor(profileId, 200))).toEqual([third.id])
        const rows = await stored(profileId)
        for (const row of [first, second]) {
          expect(byId(rows, row.id)).toMatchObject({ removedReason: 'stopped' })
          expect(byId(rows, row.id).removedAt!.getTime()).toBe(at(5 * MINUTE).getTime())
        }
        expect(byId(rows, third.id)).toMatchObject({ removedAt: null, removedReason: null })
      })

      it('removes with no reason: the time is set and the reason stays empty', async () => {
        const { repository, newProfile, put, stored } = await make()
        const profileId = await newProfile()
        const row = productRow(profileId)
        await put(row)

        expect(await repository.removeMany(profileId, [row.id], null, at(MINUTE))).toEqual({ status: 'removed', removedIds: [row.id] })

        const [kept] = await stored(profileId)
        expect(kept!.removedAt!.getTime()).toBe(at(MINUTE).getTime())
        expect(kept!.removedReason).toBeNull()
      })

      it('changes nothing and says not-found when one id among good ones is unknown', async () => {
        const { repository, newProfile, put, stored } = await make()
        const profileId = await newProfile()
        const [first, second] = [productRow(profileId), productRow(profileId)]
        for (const row of [first, second]) await put(row)

        expect(await repository.removeMany(profileId, [first.id, crypto.randomUUID(), second.id], 'finished', at(MINUTE))).toEqual({ status: 'not-found' })

        expect(idsOf(await repository.activeFor(profileId, 200)).sort()).toEqual([first.id, second.id].sort())
        for (const row of await stored(profileId)) expect(row).toMatchObject({ removedAt: null, removedReason: null })
      })

      it('changes nothing and says not-found when one id is another profile\'s, leaving that entry on its own shelf untouched', async () => {
        const { repository, newProfile, put, stored } = await make()
        const owner = await newProfile()
        const intruder = await newProfile()
        const theirs = productRow(owner)
        const mine = productRow(intruder)
        await put(theirs)
        await put(mine)

        expect(await repository.removeMany(intruder, [mine.id, theirs.id], 'not-mine', at(MINUTE))).toEqual({ status: 'not-found' })

        expect(idsOf(await repository.activeFor(owner, 200))).toEqual([theirs.id])
        expect(idsOf(await repository.activeFor(intruder, 200))).toEqual([mine.id])
        expect((await stored(owner))[0]).toMatchObject({ removedAt: null, removedReason: null })
        expect((await stored(intruder))[0]).toMatchObject({ removedAt: null, removedReason: null })
      })

      it('says not-found for another profile\'s entry that was removed already, as it does for one still on the shelf', async () => {
        const { repository, newProfile, put } = await make()
        const owner = await newProfile()
        const intruder = await newProfile()
        const theirs = productRow(owner, { removedAt: at(MINUTE), removedReason: 'finished' })
        await put(theirs)

        expect(await repository.removeMany(intruder, [theirs.id], null, at(2 * MINUTE))).toEqual({ status: 'not-found' })
      })

      it('accepts an entry removed before without counting it, and keeps its first time and reason while it removes the rest', async () => {
        const { repository, newProfile, put, stored } = await make()
        const profileId = await newProfile()
        const before = productRow(profileId, { removedAt: at(MINUTE), removedReason: 'finished' })
        const active = productRow(profileId)
        await put(before)
        await put(active)

        const result = await repository.removeMany(profileId, [before.id, active.id], 'stopped', at(2 * MINUTE))

        expect(result).toEqual({ status: 'removed', removedIds: [active.id] })
        const rows = await stored(profileId)
        expect(byId(rows, before.id)).toMatchObject({ removedReason: 'finished' })
        expect(byId(rows, before.id).removedAt!.getTime()).toBe(at(MINUTE).getTime())
        expect(byId(rows, active.id)).toMatchObject({ removedReason: 'stopped' })
        expect(byId(rows, active.id).removedAt!.getTime()).toBe(at(2 * MINUTE).getTime())
      })

      it('answers removed with nothing removed when every entry named was removed before', async () => {
        const { repository, newProfile, put, stored } = await make()
        const profileId = await newProfile()
        const row = productRow(profileId, { removedAt: at(MINUTE), removedReason: 'finished' })
        await put(row)

        expect(await repository.removeMany(profileId, [row.id], 'stopped', at(2 * MINUTE))).toEqual({ status: 'removed', removedIds: [] })

        const [kept] = await stored(profileId)
        expect(kept).toMatchObject({ removedReason: 'finished' })
        expect(kept!.removedAt!.getTime()).toBe(at(MINUTE).getTime())
      })

      it('removes 50 entries at once, the most a request may name', async () => {
        const { repository, newProfile, put } = await make()
        const profileId = await newProfile()
        const rows = Array.from({ length: 50 }, () => productRow(profileId))
        for (const row of rows) await put(row)

        const result = await repository.removeMany(profileId, idsOf(rows), 'finished', at(MINUTE))

        expect(result.status).toBe('removed')
        expect(result.status === 'removed' && [...result.removedIds].sort()).toEqual(idsOf(rows).sort())
        expect(await repository.activeFor(profileId, 200)).toEqual([])
      })
    })
  })
}
