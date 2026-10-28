import { describe, expect, it } from 'vitest'
import type { SafetyRepository } from './safety.repository'
import type { SafetyMentionRow, SafetyRow } from './safety.types'

// The one clock every fixture hangs off; later times are offsets from it.
const BASE = new Date('2030-06-15T12:00:00.000Z')
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const at = (offsetMs: number) => new Date(BASE.getTime() + offsetMs)

type Account = { userId: string; profileId: string }

/**
 * What a safety contract run needs: the repository, and a way to get an account that really exists, the way every account does in
 * life (D1 enforces profile_safety.profile_id -> profiles). `newAccount` is a user with its default profile; `newProfile` adds
 * another profile to that user.
 */
export type SafetyContractSetup = {
  repository: SafetyRepository
  newAccount: () => Promise<Account>
  newProfile: (userId: string) => Promise<string>
}

// Ids are unique per call: the D1 run shares one database across every test in its file.
const rowOf = (profileId: string, over: Partial<SafetyRow> = {}): SafetyRow => ({
  id: `safety-${crypto.randomUUID()}`,
  profileId,
  choices: ['none'],
  reactionText: null,
  prescriptionText: null,
  parseState: 'none',
  parseDueAt: null,
  parseRetried: false,
  createdAt: BASE,
  ...over,
})

// Ids are unique per call for the same reason. A product mention by default; `safetyId` is the row it was parsed from.
const mentionOf = (safetyId: string, over: Partial<SafetyMentionRow> = {}): SafetyMentionRow => ({
  id: `mention-${crypto.randomUUID()}`,
  safetyId,
  source: 'reaction',
  kind: 'product',
  brand: 'Caro White',
  name: 'Caro White',
  variant: null,
  category: 'skin',
  productId: null,
  resolution: 'pending',
  position: 0,
  createdAt: BASE,
  ...over,
})

const idsOf = (rows: { id: string }[]) => rows.map((row) => row.id)

/**
 * Behaviour every SafetyRepository must have. Runs against the fake (unit tier) and real local D1 (integration tier). Putting the choices
 * in the vocabulary's order, and keeping each once, is the service's rule: the repository gives back what it was given.
 */
export const safetyRepositoryContract = (name: string, make: () => SafetyContractSetup | Promise<SafetyContractSetup>) => {
  describe(`SafetyRepository contract: ${name}`, () => {
    describe('append and current', () => {
      it('has no current answer for a profile that never set one', async () => {
        const { repository, newAccount } = await make()
        const account = await newAccount()

        expect(await repository.current(account.profileId)).toBeNull()
      })

      it('returns an appended row as it was given, with the choices as an array', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = rowOf(profileId, { choices: ['pregnant', 'reaction', 'prescription'], reactionText: 'Caro White and fragrance', prescriptionText: 'clobetasol', createdAt: at(MINUTE) })

        await repository.append(row)

        const found = await repository.current(profileId)
        expect(found).toMatchObject({ id: row.id, profileId, choices: ['pregnant', 'reaction', 'prescription'], reactionText: 'Caro White and fragrance', prescriptionText: 'clobetasol' })
        expect(Array.isArray(found!.choices)).toBe(true)
        expect(found!.createdAt.getTime()).toBe(at(MINUTE).getTime())
      })

      it('keeps a ticked choice with no text, and null as null', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = rowOf(profileId, { choices: ['reaction'], reactionText: null, prescriptionText: null })

        await repository.append(row)

        expect(await repository.current(profileId)).toMatchObject({ id: row.id, choices: ['reaction'], reactionText: null, prescriptionText: null })
      })

      it('gives back every choice a row can hold, in the order it was given', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = rowOf(profileId, { choices: ['pregnant', 'breastfeeding', 'reaction', 'prescription'], reactionText: 'a', prescriptionText: 'b' })

        await repository.append(row)

        expect((await repository.current(profileId))!.choices).toEqual(['pregnant', 'breastfeeding', 'reaction', 'prescription'])
      })

      it('makes the newest row by time the current one, even when it was appended before an older one', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const newest = rowOf(profileId, { choices: ['pregnant'], createdAt: at(10 * MINUTE) })
        const older = rowOf(profileId, { choices: ['none'], createdAt: at(MINUTE) })

        await repository.append(newest)
        await repository.append(older)

        expect((await repository.current(profileId))!.id).toBe(newest.id)
      })

      it('makes the row appended later the current one when two rows share the same time', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const earlier = rowOf(profileId, { choices: ['none'], createdAt: at(MINUTE) })
        const later = rowOf(profileId, { choices: ['pregnant'], createdAt: at(MINUTE) })

        await repository.append(earlier)
        await repository.append(later)

        expect((await repository.current(profileId))!.id).toBe(later.id)
      })

      it('changes the current answer when a newer row is appended', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.append(rowOf(profileId, { choices: ['none'], createdAt: at(MINUTE) }))
        const later = rowOf(profileId, { choices: ['breastfeeding'], createdAt: at(2 * MINUTE) })

        await repository.append(later)

        expect(await repository.current(profileId)).toMatchObject({ id: later.id, choices: ['breastfeeding'] })
      })
    })

    describe('history', () => {
      it('is empty for a profile that never set an answer', async () => {
        const { repository, newAccount } = await make()
        const account = await newAccount()

        expect(await repository.history(account.profileId)).toEqual([])
      })

      it('keeps every row ever appended, newest first', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const first = rowOf(profileId, { choices: ['none'], createdAt: at(MINUTE) })
        const second = rowOf(profileId, { choices: ['reaction'], reactionText: 'fragrance', createdAt: at(2 * MINUTE) })
        const third = rowOf(profileId, { choices: ['pregnant'], createdAt: at(3 * MINUTE) })

        // Appended out of time order on purpose: the order comes from created_at.
        await repository.append(second)
        await repository.append(third)
        await repository.append(first)

        expect(idsOf(await repository.history(profileId))).toEqual([third.id, second.id, first.id])
      })
    })

    describe('ties', () => {
      it('lists the row appended later first when two rows share the same time', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const first = rowOf(profileId, { choices: ['none'], createdAt: at(MINUTE) })
        const second = rowOf(profileId, { choices: ['reaction'], createdAt: at(MINUTE) })
        const third = rowOf(profileId, { choices: ['pregnant'], createdAt: at(MINUTE) })

        await repository.append(first)
        await repository.append(second)
        await repository.append(third)

        expect(idsOf(await repository.history(profileId))).toEqual([third.id, second.id, first.id])
      })
    })

    describe('find', () => {
      it('finds a row by its id, whoever it belongs to', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = rowOf(profileId, { choices: ['reaction'], reactionText: 'Caro White and fragrance', createdAt: at(MINUTE) })
        await repository.append(row)

        expect(await repository.find(row.id)).toMatchObject({ id: row.id, profileId, choices: ['reaction'], reactionText: 'Caro White and fragrance' })
      })

      it('finds a row that is no longer the current one', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const older = rowOf(profileId, { createdAt: at(MINUTE) })
        const newer = rowOf(profileId, { createdAt: at(2 * MINUTE) })
        await repository.append(older)
        await repository.append(newer)

        expect((await repository.find(older.id))!.id).toBe(older.id)
        expect((await repository.current(profileId))!.id).toBe(newer.id)
      })

      it('answers null for an id nothing has', async () => {
        const { repository } = await make()

        expect(await repository.find(`safety-${crypto.randomUUID()}`)).toBeNull()
      })
    })

    describe('parse state', () => {
      it('has no parse to wait for (none, no due time) on a row appended that way', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = rowOf(profileId)
        await repository.append(row)

        expect(await repository.find(row.id)).toMatchObject({ parseState: 'none', parseDueAt: null })
      })

      it('returns the parse state and the due time as appended, the due time as a date', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = rowOf(profileId, { choices: ['reaction'], reactionText: 'x', parseState: 'pending', parseDueAt: at(5 * MINUTE) })
        await repository.append(row)

        const found = await repository.find(row.id)
        expect(found!.parseState).toBe('pending')
        expect(found!.parseDueAt!.getTime()).toBe(at(5 * MINUTE).getTime())
        expect((await repository.current(profileId))!.parseState).toBe('pending')
      })

      it.each(['none', 'pending', 'done', 'failed'] as const)('moves a row to %s', async (parseState) => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = rowOf(profileId, { choices: ['reaction'], reactionText: 'x', parseState: parseState === 'pending' ? 'done' : 'pending', parseDueAt: at(MINUTE) })
        await repository.append(row)

        await repository.setParseState(row.id, parseState)

        expect((await repository.find(row.id))!.parseState).toBe(parseState)
      })

      it('changes the state and nothing else of that row, and leaves the profile\'s other rows as they were', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const older = rowOf(profileId, { choices: ['reaction'], reactionText: 'old', parseState: 'pending', parseDueAt: at(MINUTE), createdAt: at(MINUTE) })
        const newer = rowOf(profileId, { choices: ['reaction'], reactionText: 'new', parseState: 'pending', parseDueAt: at(2 * MINUTE), createdAt: at(2 * MINUTE) })
        await repository.append(older)
        await repository.append(newer)

        await repository.setParseState(newer.id, 'done')

        expect(await repository.find(newer.id)).toMatchObject({ choices: ['reaction'], reactionText: 'new', parseState: 'done', parseDueAt: at(2 * MINUTE), createdAt: at(2 * MINUTE) })
        expect(await repository.find(older.id)).toMatchObject({ reactionText: 'old', parseState: 'pending', parseDueAt: at(MINUTE) })
        expect(idsOf(await repository.history(profileId))).toEqual([newer.id, older.id])
      })

      it('does nothing, and does not fail, for a row that does not exist, as when the profile went while a message waited', async () => {
        const { repository } = await make()

        await expect(repository.setParseState(`safety-${crypto.randomUUID()}`, 'failed')).resolves.toBeUndefined()
      })
    })

    describe('parse retried', () => {
      it('is false for a row appended that way, and true for one appended with it', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const plain = rowOf(profileId, { createdAt: at(MINUTE) })
        const retried = rowOf(profileId, { choices: ['reaction'], reactionText: 'x', parseState: 'pending', parseDueAt: at(5 * MINUTE), parseRetried: true, createdAt: at(2 * MINUTE) })
        await repository.append(plain)
        await repository.append(retried)

        expect((await repository.find(plain.id))!.parseRetried).toBe(false)
        expect((await repository.find(retried.id))!.parseRetried).toBe(true)
      })

      it('retryParseAt puts the row back to pending, marks it retried and sets its due time, changing nothing else', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = rowOf(profileId, { choices: ['reaction'], reactionText: 'Caro White', parseState: 'pending', parseDueAt: at(MINUTE), createdAt: at(MINUTE) })
        await repository.append(row)

        await repository.retryParseAt(row.id, at(13 * HOUR))

        const found = (await repository.find(row.id))!
        expect(found).toMatchObject({ parseState: 'pending', parseRetried: true, choices: ['reaction'], reactionText: 'Caro White', prescriptionText: null })
        expect(found.parseDueAt!.getTime()).toBe(at(13 * HOUR).getTime())
        expect(found.createdAt.getTime()).toBe(at(MINUTE).getTime())
      })

      it('retryParseAt leaves the profile\'s other rows as they were', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const older = rowOf(profileId, { reactionText: 'old', choices: ['reaction'], parseState: 'pending', parseDueAt: at(MINUTE), createdAt: at(MINUTE) })
        const newer = rowOf(profileId, { reactionText: 'new', choices: ['reaction'], parseState: 'pending', parseDueAt: at(2 * MINUTE), createdAt: at(2 * MINUTE) })
        await repository.append(older)
        await repository.append(newer)

        await repository.retryParseAt(newer.id, at(HOUR))

        expect(await repository.find(older.id)).toMatchObject({ parseState: 'pending', parseRetried: false, parseDueAt: at(MINUTE) })
      })

      it('retryParseAt does nothing, and does not fail, for a row that does not exist', async () => {
        const { repository } = await make()

        await expect(repository.retryParseAt(`safety-${crypto.randomUUID()}`, at(HOUR))).resolves.toBeUndefined()
      })

      it('setParseState leaves the retried mark as it is', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = rowOf(profileId, { choices: ['reaction'], reactionText: 'x', parseState: 'pending', parseDueAt: at(MINUTE), parseRetried: true })
        await repository.append(row)

        await repository.setParseState(row.id, 'failed')

        expect(await repository.find(row.id)).toMatchObject({ parseState: 'failed', parseRetried: true })
      })
    })

    describe('pending parses that are due', () => {
      // The database is shared by every test of the D1 run, and other tests leave pending rows, so a test reads back only the rows it made.
      const pending = (profileId: string, dueAt: Date | null, over: Partial<SafetyRow> = {}) =>
        rowOf(profileId, { choices: ['reaction'], reactionText: 'x', parseState: 'pending', parseDueAt: dueAt, ...over })
      const mine = (found: SafetyRow[], rows: { id: string }[]) => found.filter((row) => rows.some((r) => r.id === row.id))

      it('lists a pending row whose due time is now or earlier, and not one due a millisecond later (the boundary)', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const earlier = pending(profileId, at(HOUR - 1), { createdAt: at(MINUTE) })
        const exact = pending(profileId, at(HOUR), { createdAt: at(2 * MINUTE) })
        const later = pending(profileId, at(HOUR + 1), { createdAt: at(3 * MINUTE) })
        for (const row of [earlier, exact, later]) await repository.append(row)

        const found = mine(await repository.pendingDue(at(HOUR), 1000), [earlier, exact, later])

        expect(idsOf(found).sort()).toEqual([earlier.id, exact.id].sort())
      })

      it('lists only pending rows: not done, failed or none, however long overdue', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const rows = (['pending', 'done', 'failed', 'none'] as const).map((parseState, i) => pending(profileId, at(MINUTE), { parseState, createdAt: at(i * MINUTE) }))
        for (const row of rows) await repository.append(row)

        const found = mine(await repository.pendingDue(at(30 * 24 * HOUR), 1000), rows)

        expect(idsOf(found)).toEqual([rows[0]!.id])
      })

      it('lists rows of every profile, with the row as stored', async () => {
        const { repository, newAccount } = await make()
        const [ada, bo] = [await newAccount(), await newAccount()]
        const [adas, bos] = [pending(ada.profileId, at(MINUTE)), pending(bo.profileId, at(MINUTE), { parseRetried: true })]
        await repository.append(adas)
        await repository.append(bos)

        const found = mine(await repository.pendingDue(at(HOUR), 1000), [adas, bos])

        expect(found.map((row) => [row.id, row.profileId, row.parseRetried]).sort()).toEqual([[adas.id, ada.profileId, false], [bos.id, bo.profileId, true]].sort())
      })

      it('lists the longest overdue first', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const [third, first, second] = [pending(profileId, at(3 * MINUTE)), pending(profileId, at(MINUTE)), pending(profileId, at(2 * MINUTE))]
        for (const row of [third, first, second]) await repository.append(row)

        expect(idsOf(mine(await repository.pendingDue(at(HOUR), 1000), [first, second, third]))).toEqual([first.id, second.id, third.id])
      })

      it('returns at most `limit` rows, the longest overdue ones', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        for (const [i, offset] of [3, 1, 2].entries()) await repository.append(pending(profileId, at(offset * MINUTE), { createdAt: at(i * SECOND) }))

        // Other tests may have left pending rows, so the limited answers are compared with the unlimited one, not with a fixed list.
        const all = idsOf(await repository.pendingDue(at(HOUR), 10_000))
        expect(all.length).toBeGreaterThanOrEqual(3)
        expect(idsOf(await repository.pendingDue(at(HOUR), 2))).toEqual(all.slice(0, 2))
        expect(idsOf(await repository.pendingDue(at(HOUR), 1))).toEqual(all.slice(0, 1))
        expect(await repository.pendingDue(at(HOUR), 0)).toEqual([])
      })

      it('does not list a retried row until its new due time', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = pending(profileId, at(MINUTE))
        await repository.append(row)
        await repository.retryParseAt(row.id, at(13 * HOUR))

        expect(mine(await repository.pendingDue(at(13 * HOUR - 1), 1000), [row])).toEqual([])
        expect(idsOf(mine(await repository.pendingDue(at(13 * HOUR), 1000), [row]))).toEqual([row.id])
      })
    })

    describe('mentions', () => {
      it('has none for a row nothing was parsed from', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = rowOf(profileId)
        await repository.append(row)

        expect(await repository.mentions(row.id)).toEqual([])
      })

      it('returns a product mention as it was appended, every field, the product id and the time included', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = rowOf(profileId, { choices: ['prescription'], prescriptionText: 'Dermovate Fort' })
        await repository.append(row)
        const mention = mentionOf(row.id, {
          source: 'prescription',
          brand: 'Dermovate',
          name: 'Dermovate',
          variant: 'Fort',
          category: 'body',
          productId: 'product-1',
          resolution: 'resolved',
          position: 0,
          createdAt: at(MINUTE),
        })

        await repository.appendMentions([mention])

        const [found] = await repository.mentions(row.id)
        const { createdAt, ...fields } = mention
        expect(found).toMatchObject(fields)
        expect(found!.createdAt.getTime()).toBe(createdAt.getTime())
      })

      it('returns an ingredient mention with no brand, variant, category, product or resolution', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = rowOf(profileId, { choices: ['reaction'], reactionText: 'fragrance' })
        await repository.append(row)
        const mention = mentionOf(row.id, { kind: 'ingredient', brand: null, name: 'fragrance', variant: null, category: null, productId: null, resolution: null })

        await repository.appendMentions([mention])

        expect(await repository.mentions(row.id)).toMatchObject([
          { kind: 'ingredient', brand: null, name: 'fragrance', variant: null, category: null, productId: null, resolution: null },
        ])
      })

      it('keeps a product mention with no brand and no category, which is what the reader gives for a market cream', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = rowOf(profileId, { choices: ['reaction'], reactionText: 'the white tub' })
        await repository.append(row)

        await repository.appendMentions([mentionOf(row.id, { brand: null, name: 'white tub', category: null, resolution: 'unresolved' })])

        expect(await repository.mentions(row.id)).toMatchObject([{ kind: 'product', brand: null, name: 'white tub', category: null, resolution: 'unresolved' }])
      })

      it('lists the mentions in position order, whatever order they were appended in, across both texts', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = rowOf(profileId, { choices: ['reaction', 'prescription'], reactionText: 'a', prescriptionText: 'b' })
        await repository.append(row)
        const first = mentionOf(row.id, { source: 'reaction', position: 0 })
        const second = mentionOf(row.id, { source: 'reaction', kind: 'ingredient', name: 'fragrance', position: 1 })
        const third = mentionOf(row.id, { source: 'prescription', name: 'Dermovate', brand: 'Dermovate', position: 2 })

        await repository.appendMentions([third, first])
        await repository.appendMentions([second])

        expect(idsOf(await repository.mentions(row.id))).toEqual([first.id, second.id, third.id])
        expect((await repository.mentions(row.id)).map((m) => m.position)).toEqual([0, 1, 2])
      })

      it('lists a row\'s mentions apart from those of another row of the same profile', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const older = rowOf(profileId, { createdAt: at(MINUTE) })
        const newer = rowOf(profileId, { createdAt: at(2 * MINUTE) })
        await repository.append(older)
        await repository.append(newer)
        const olds = mentionOf(older.id, { name: 'Old' })
        const news = mentionOf(newer.id, { name: 'New' })
        await repository.appendMentions([olds, news])

        expect(idsOf(await repository.mentions(older.id))).toEqual([olds.id])
        expect(idsOf(await repository.mentions(newer.id))).toEqual([news.id])
      })

      it('lets a mention carry a product id that no table here knows: it is a catalog id, with no link to follow', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = rowOf(profileId)
        await repository.append(row)
        const mention = mentionOf(row.id, { productId: `product-${crypto.randomUUID()}`, resolution: 'resolved' })

        await repository.appendMentions([mention])

        expect((await repository.mentions(row.id))[0]!.productId).toBe(mention.productId)
      })

      it('appends nothing, and does not fail, for an empty list', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = rowOf(profileId)
        await repository.append(row)

        await expect(repository.appendMentions([])).resolves.toBeUndefined()

        expect(await repository.mentions(row.id)).toEqual([])
      })
    })

    describe('resolving a mention', () => {
      it('records that a pending product mention resolved to a catalog product', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = rowOf(profileId)
        await repository.append(row)
        const mention = mentionOf(row.id)
        await repository.appendMentions([mention])

        await repository.resolveMention(mention.id, { resolution: 'resolved', productId: 'product-1' })

        expect((await repository.mentions(row.id))[0]).toMatchObject({ id: mention.id, resolution: 'resolved', productId: 'product-1' })
      })

      it('records unresolved with no product, and unresolved with the product kept (research found nothing for a product that is in the catalog)', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = rowOf(profileId)
        await repository.append(row)
        const without = mentionOf(row.id, { position: 0 })
        const kept = mentionOf(row.id, { position: 1, name: 'Other' })
        await repository.appendMentions([without, kept])

        await repository.resolveMention(without.id, { resolution: 'unresolved', productId: null })
        await repository.resolveMention(kept.id, { resolution: 'unresolved', productId: 'product-2' })

        expect(await repository.mentions(row.id)).toMatchObject([
          { id: without.id, resolution: 'unresolved', productId: null },
          { id: kept.id, resolution: 'unresolved', productId: 'product-2' },
        ])
      })

      it('changes only that mention, and only its resolution and product', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = rowOf(profileId)
        await repository.append(row)
        const target = mentionOf(row.id, { position: 0, variant: 'Extra', createdAt: at(MINUTE) })
        const other = mentionOf(row.id, { position: 1, name: 'Other' })
        await repository.appendMentions([target, other])

        await repository.resolveMention(target.id, { resolution: 'resolved', productId: 'product-1' })

        const [changed, untouched] = await repository.mentions(row.id)
        const { createdAt, ...fields } = target
        expect(changed).toMatchObject({ ...fields, resolution: 'resolved', productId: 'product-1' })
        expect(changed!.createdAt.getTime()).toBe(createdAt.getTime())
        expect(untouched).toMatchObject({ id: other.id, resolution: 'pending', productId: null })
      })

      it('does nothing, and does not fail, for a mention that does not exist', async () => {
        const { repository } = await make()

        await expect(repository.resolveMention(`mention-${crypto.randomUUID()}`, { resolution: 'unresolved', productId: null })).resolves.toBeUndefined()
      })
    })

    describe('appending a row with mentions carried onto it', () => {
      it('makes the row the current answer and gives it the carried mentions, in position order, leaving the older row\'s mentions as they were', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const older = rowOf(profileId, { createdAt: at(MINUTE) })
        await repository.append(older)
        const olds = mentionOf(older.id, { source: 'skin-log', name: 'Night Cream', resolution: 'resolved', productId: 'product-night' })
        await repository.appendMentions([olds])
        const newer = rowOf(profileId, { choices: ['pregnant'], createdAt: at(2 * MINUTE) })
        const second = mentionOf(newer.id, { source: 'skin-log', name: 'Day Cream', resolution: 'resolved', productId: 'product-day', position: 1 })
        const first = mentionOf(newer.id, { source: 'skin-log', name: 'Night Cream', resolution: 'resolved', productId: 'product-night', position: 0 })

        await repository.appendCarrying(newer, [second, first])

        expect((await repository.current(profileId))!.id).toBe(newer.id)
        expect(idsOf(await repository.history(profileId))).toEqual([newer.id, older.id])
        expect(idsOf(await repository.mentions(newer.id))).toEqual([first.id, second.id])
        expect(idsOf(await repository.mentions(older.id))).toEqual([olds.id])
      })

      it('appends the row, and fails nothing, when there is nothing to carry', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = rowOf(profileId, { choices: ['breastfeeding'] })

        await expect(repository.appendCarrying(row, [])).resolves.toBeUndefined()

        expect(await repository.current(profileId)).toMatchObject({ id: row.id, choices: ['breastfeeding'] })
        expect(await repository.mentions(row.id)).toEqual([])
      })

      it('stores a mention whose source is skin-log, and reads it back as it was written (the source column takes it with no migration)', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = rowOf(profileId)
        const mention = mentionOf(row.id, {
          source: 'skin-log',
          kind: 'product',
          brand: 'Orbis',
          name: 'Night Cream',
          variant: null,
          category: 'skin',
          productId: 'product-night',
          resolution: 'resolved',
          position: 0,
          createdAt: at(MINUTE),
        })

        await repository.appendCarrying(row, [mention])

        const [found] = await repository.mentions(row.id)
        const { createdAt, ...fields } = mention
        expect(found).toMatchObject(fields)
        expect(found!.createdAt.getTime()).toBe(createdAt.getTime())
      })
    })

    describe('profiles', () => {
      it('keeps one profile\'s answers out of another account\'s current and history', async () => {
        const { repository, newAccount } = await make()
        const ada = await newAccount()
        const bo = await newAccount()
        const adas = rowOf(ada.profileId, { choices: ['pregnant'], createdAt: at(MINUTE) })
        await repository.append(adas)

        expect(await repository.current(bo.profileId)).toBeNull()
        expect(await repository.history(bo.profileId)).toEqual([])
        expect(idsOf(await repository.history(ada.profileId))).toEqual([adas.id])
      })

      it('keeps two profiles of one account apart, each with its own newest answer', async () => {
        const { repository, newAccount, newProfile } = await make()
        const { userId, profileId } = await newAccount()
        const second = await newProfile(userId)
        const first = rowOf(profileId, { choices: ['pregnant'], createdAt: at(5 * MINUTE) })
        const other = rowOf(second, { choices: ['none'], createdAt: at(MINUTE) })
        await repository.append(first)
        await repository.append(other)

        expect((await repository.current(profileId))!.id).toBe(first.id)
        expect((await repository.current(second))!.id).toBe(other.id)
        expect(idsOf(await repository.history(second))).toEqual([other.id])
      })
    })
  })
}
