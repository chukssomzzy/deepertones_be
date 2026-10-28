import { describe, expect, it } from 'vitest'
import type { RoutinesRepository } from './routines.repository'
import type { Goal } from '../goals/goals.vocabulary'
import type { CautionState } from './routines.types'

// The stored routine versions (spec #189): one row per build, appended `pending` and filled in once to `ready` (or appended `ready` outright), with the
// newest `ready` row being the routine in force. Behaviour every
// RoutinesRepository must have; it runs against the fake (unit tier) and real local D1 (integration tier). Times are Dates (the table stores
// milliseconds, as the verdicts table does).
//
// Assumed shapes (what this file pins):
//   append(row)                    resolves to undefined. `row` has every column: id, profileId, status, createdAt, steps, tapers, expectation, startedOn,
//                                  servedAt, model, promptHash, catalogVersion, rulesVersion, hintsShown, verdictFingerprint, routineFingerprint, source,
//                                  reason, writerRetryDueAt, writerCalls, cautions, goal, readyAt. A pending row has steps [], tapers [], expectation null, cautions null,
//                                  source null and no writer calls yet; a rules-built row has no model or prompt hash. An id already used rejects.
//                                  Each taper is { shelfProductId, templateId, startedOn: Date | null } (a StoredTaper) and must come back with its
//                                  startedOn a Date, to the millisecond, or null: a JSON column keeps text, so the repository has to turn it back.
//                                  `cautions` is the skeleton's CautionState[] (order kept, [] is not null) or null while pending. `goal` is the goal the
//                                  version was built for, or null while pending (and on a row written before the column). `readyAt` is when the version became ready:
//                                  the caller gives it for a row appended already ready, and null for a pending one.
//                                  `shelfCounts` (PR 5) is how the build sorted the shelf: { keep, reduce, drop, stop } whole numbers, or null while pending and on a row
//                                  written before the column. Fixed at build time, it comes back exactly as given and is changed by nothing but `complete`.

//                                  `notInRoutine` (PR 6) is what the build left out: { entryId, title, status: 'stepping-down' | 'left-out', reason }[] in the order given ([] is not null),
//                                  or null while pending and on a row written before the column. Fixed at build time, it comes back exactly as given and is changed by nothing
//                                  but `complete` and `setNotInRoutine`.
//   complete(id, built)            fills that one pending row with the finished build (steps, tapers, expectation, model, promptHash, catalogVersion,
//                                  routineFingerprint, source, hintsShown, writerRetryDueAt, writerCalls, cautions, goal, shelfCounts, notInRoutine, readyAt) and makes it 'ready', resolving to true. It does so
//                                  once: an unknown id, or a row that is already ready, resolves to false and changes nothing.
//   latest(profileId)              the row with the newest createdAt, whatever its status, or null.
//   current(profileId)             the `ready` row that became ready last (readyAt, then the larger id; a row with no readyAt counts from its createdAt),
//                                  or null: a build that was created first but finished last is the current one.
//   clearWriterRetry(id)           sets writerRetryDueAt to null on that one row, changing nothing else of it; a row nobody has is ignored. Resolves to undefined.
//   setRoutineFingerprint(id, fingerprint)   sets routineFingerprint on that one row (a rebuild that found nothing to change records the inputs it checked), changing
//                                  nothing else of it; a row nobody has is ignored. Resolves to undefined.
//   setShelfCounts(id, counts)     sets shelfCounts on that one row, changing nothing else of it; a row nobody has is ignored. Resolves to undefined.
//   setNotInRoutine(id, items)     sets notInRoutine on that one row, changing nothing else of it; a row nobody has is ignored. Resolves to undefined.
//   markServed(id, at)             sets servedAt on that one row, replacing an earlier value; a row nobody has is ignored. Resolves to undefined.
//   markStarted(profileId, on)     sets startedOn to `on` on every row of that profile whose startedOn is null, a pending row included, and on no other row:
//                                  an earlier start is never moved, so calling it again is a no-op. Resolves to undefined; a profile with no rows is ignored.
//                                  It also stamps `on` as the startedOn of each step-down of those rows whose startedOn is null (one already dated keeps
//                                  its date): that is how Start puts the date on a step-down of the routine in force. Otherwise a ready row is changed by
//                                  nothing but servedAt, startedOn, writerRetryDueAt (clearWriterRetry) and routineFingerprint (setRoutineFingerprint) (the other markStarted tests use rows with no step-downs, to keep that apart).
//   lastServedBefore(profileId, excludeId)   the profile's newest `ready` row (in the order `current` uses) whose servedAt is not null and whose id is not `excludeId`, or null.
//                                  Pending rows never count, even when marked served. It is "every served version but this one", not "older than this one".
//   writerBuildsSince(profileId, since)   how many of that profile's rows have writerCalls > 0 and createdAt >= since, whatever their source, status or reason.
//
// The build requests (spec #189, PR 3b): ONE row per profile in `routine_requests`, which keeps the same request from being queued twice and holds the
// state of the dead-letter retry. A claim is held until it is released or goes stale. Assumed shapes (what this file pins; the first two are the brief's):
//   claim(profileId, key, now, staleBefore)   boolean. True on a profile with no request row (the row is created: requestKey `key`, requestedAt `now`, no retry
//                                  due, not retried) and on a row whose requestedAt is `staleBefore` or older (taken over: key and time rewritten, retry fields
//                                  reset). False, changing nothing, on a row whose requestedAt is newer than `staleBefore`. One statement, so parallel claims
//                                  cannot both win. Rejects (D1) a profile that does not exist.
//   release(profileId, requestedAt)   gives back the claim made at exactly that time (moves the row's requestedAt to the epoch, so the next claim wins at once);
//                                  a no-op for any other requestedAt and for a missing row. Resolves to undefined.
//   findRequest(profileId)         { profileId, requestKey, requestedAt, retryDueAt, retried } | null.
//   setRequestRetry(profileId, { retried, retryDueAt })   sets those two columns, nothing else of the row; a profile with no request row is ignored (not created).
//
// The daily sweeps (spec #189, PR 3c). Each answers at most `limit` rows. Assumed shapes (what this file pins):
//   dueRequests(now, limit)        the build requests (RoutineRequestRow) whose retryDueAt is `now` or earlier, the longest overdue first; one with no retry due is never
//                                  returned. A row is returned until its retry is cleared (setRequestRetry) or the request is claimed again.
//   writerRetriesDue(now, limit)   the routine in force (the profile's `ready` version that became ready last, as `current` answers) of each profile, when that version's
//                                  writerRetryDueAt is `now` or earlier; a version a newer ready version has replaced is never returned, even with a retry due. Rows are
//                                  RoutineVersionRows (the sweep keys its request by the version's id).
//   retiredCodeVersions(limit)     (in the order of the versions' ids, so the rows a run leaves for the next are always the same) the routine in force of each profile, when one of its steps holds a recommended product (product.kind 'candidate') whose code is
//                                  `retired` in the catalog with updatedInVersion greater than the version's catalogVersion (that is, retired after the version was built;
//                                  equal is not). Each version once, however many of its codes are retired; a version replaced by a newer ready one is never returned.
//                                  Rows are RoutineVersionRows. The catalog is not this repository's table, so the setup gives the contract `retireCode`.
//
// Fixtures never give two rows of one profile the same createdAt: which of two such rows is newest is not specified.

const BASE = new Date('2030-06-15T12:00:00.000Z')
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const at = (offsetMs: number) => new Date(BASE.getTime() + offsetMs)

type Row = NonNullable<Awaited<ReturnType<RoutinesRepository['latest']>>>
type Appended = Parameters<RoutinesRepository['append']>[0]
type Completed = Parameters<RoutinesRepository['complete']>[1]

export type RoutinesContractSetup = {
  repository: RoutinesRepository
  /** A user with its default profile, made the way the product makes one (D1 enforces routine_versions.profile_id -> profiles). */
  newAccount: () => Promise<{ userId: string; profileId: string }>
  /**
   * Makes the recommended product `code` retired in the catalog, as of catalog version `updatedInVersion` (calling it again moves it). The retired-code sweep joins the
   * catalog's recommended_products table, which this repository does not write, so each tier says how its catalog is told: the fake is told directly, D1 gets the rows.
   */
  retireCode: (code: string, updatedInVersion: number) => Promise<void>
}

// A stored step is a routine entry plus `gotIt`, `fixedFrom` and `changedOn` (the calendar day the step's product last changed, as a Date; null means day 1). One of each product kind, so a JSON column cannot quietly drop a variant: a shelf
// product the version carried over unchanged, a candidate the user has got, and "use what you have".
const stepsOf = (): Appended['steps'] => [
  { step: 'cleanse', product: { kind: 'shelf', id: 'entry-1' }, frequency: 'am-pm', reason: 'You already use this and it suits your goal.', grounding: [], gotIt: false, fixedFrom: 'version-0', changedOn: null },
  {
    step: 'treat',
    product: { kind: 'candidate', code: 'SERUM-1' },
    frequency: 'pm',
    reason: 'Niacinamide works on dark marks.',
    grounding: ['https://example.org/evidence/serum-1', 'https://example.org/ingredients/serum-1'],
    gotIt: true,
    fixedFrom: null,
    // A calendar date (the UTC midnight of a local day) and a step with none: a JSON column keeps the date as text, so the repository has to turn it back.
    changedOn: new Date(BASE.getTime() - 3 * DAY),
  },
  { step: 'moisturise', product: { kind: 'none' }, frequency: 'am', reason: 'Use what you have for now.', grounding: [], gotIt: false, fixedFrom: null, changedOn: null },
  { step: 'protect', product: { kind: 'shelf', id: 'entry-2' }, frequency: 'am', reason: 'Sunscreen keeps dark marks from coming back.', grounding: ['https://example.org/evidence/spf'], gotIt: false, fixedFrom: 'version-0', changedOn: new Date(BASE.getTime() - DAY) },
]

// One step-down under way (a start date, to the millisecond) and one not started (null): a JSON column must give both back as they were.
const tapersOf = (): Appended['tapers'] => [
  { shelfProductId: 'entry-3', templateId: 'TPR-STEROID-1', startedOn: new Date(BASE.getTime() - DAY + 456) },
  { shelfProductId: 'entry-4', templateId: 'TPR-LIGHTENING-1', startedOn: null },
]

const cautionsOf = (): CautionState[] => ['tapering', 'recent-reaction']

const GOAL: Goal = 'fade-dark-marks'

// Four different numbers, so a column that swaps two of them, or keeps only a total, cannot pass.
const COUNTS = { keep: 4, reduce: 1, drop: 3, stop: 2 }

// One of each status, so a column that drops a field or swaps two items cannot pass; the order is the one the build gave.
const LEFT_OUT: NonNullable<Appended['notInRoutine']> = [
  { entryId: 'entry-3', title: 'Cream', status: 'stepping-down', reason: 'It has a steroid in it, so we stop it slowly.' },
  { entryId: 'entry-5', title: 'Gel cleanser', status: 'left-out', reason: 'It does the same job as your cleanser.' },
]

/** A pending row: a build requested and not yet done. The routine and what only the build knows are empty. */
const pendingRow = (profileId: string, id: string, createdAt: Date, over: Partial<Appended> = {}): Appended => ({
  id,
  profileId,
  status: 'pending',
  createdAt,
  steps: [],
  tapers: [],
  expectation: null,
  cautions: null,
  goal: null,
  shelfCounts: null,
  notInRoutine: null,
  readyAt: null,
  startedOn: null,
  servedAt: null,
  model: null,
  promptHash: null,
  catalogVersion: null,
  rulesVersion: '1',
  hintsShown: false,
  verdictFingerprint: 'verdict-fp-1',
  routineFingerprint: null,
  source: null,
  reason: 'first',
  writerRetryDueAt: null,
  writerCalls: 0,
  ...over,
})

/** A ready row built by the writer, in one call. */
const readyRow = (profileId: string, id: string, createdAt: Date, over: Partial<Appended> = {}): Appended => ({
  id,
  profileId,
  status: 'ready',
  createdAt,
  steps: stepsOf(),
  tapers: tapersOf(),
  expectation: 'Give it 8 to 12 weeks before judging.',
  cautions: cautionsOf(),
  goal: GOAL,
  shelfCounts: COUNTS,
  notInRoutine: LEFT_OUT,
  readyAt: createdAt,
  startedOn: at(-DAY),
  servedAt: null,
  model: 'claude-sonnet-5-5',
  promptHash: 'prompt-hash-1',
  catalogVersion: 7,
  rulesVersion: '1',
  hintsShown: true,
  verdictFingerprint: 'verdict-fp-1',
  routineFingerprint: 'routine-fp-1',
  source: 'writer',
  reason: 'first',
  writerRetryDueAt: null,
  writerCalls: 1,
  ...over,
})

/** What a build fills a pending row with, as the writer's build in `readyRow`. */
const builtOf = (over: Partial<Completed> = {}): Completed => ({
  steps: stepsOf(),
  tapers: tapersOf(),
  expectation: 'Give it 8 to 12 weeks before judging.',
  cautions: cautionsOf(),
  goal: GOAL,
  shelfCounts: COUNTS,
  notInRoutine: LEFT_OUT,
  readyAt: at(DAY),
  model: 'claude-sonnet-5-5',
  promptHash: 'prompt-hash-1',
  catalogVersion: 7,
  routineFingerprint: 'routine-fp-1',
  source: 'writer',
  hintsShown: true,
  writerRetryDueAt: null,
  writerCalls: 1,
  ...over,
})

const latestOf = async (repository: RoutinesRepository, profileId: string): Promise<Row> => {
  const row = await repository.latest(profileId)
  if (!row) throw new Error('expected a routine version')
  return row
}

export const routinesRepositoryContract = (name: string, make: () => RoutinesContractSetup | Promise<RoutinesContractSetup>) => {
  describe(`RoutinesRepository contract: ${name}`, () => {
    describe('a profile with no routine versions', () => {
      it('has no latest and no current version', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()

        expect(await repository.latest(profileId)).toBeNull()
        expect(await repository.current(profileId)).toBeNull()
      })

      it('has had no writer builds', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()

        expect(await repository.writerBuildsSince(profileId, at(-DAY))).toBe(0)
      })
    })

    describe('append', () => {
      it('stores a ready version whole, which is then both the latest and the current one', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = readyRow(profileId, crypto.randomUUID(), BASE)

        await expect(repository.append(row)).resolves.toBeUndefined()

        expect(await repository.latest(profileId)).toEqual(row)
        expect(await repository.current(profileId)).toEqual(row)
      })

      it('gives steps back with every product kind, the grounding, gotIt and fixedFrom intact, and the step-downs with them', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.append(readyRow(profileId, crypto.randomUUID(), BASE))

        const row = await latestOf(repository, profileId)

        expect(row.steps).toEqual(stepsOf())
        expect(row.steps.map((s) => s.product.kind)).toEqual(['shelf', 'candidate', 'none', 'shelf'])
        expect(row.steps.map((s) => s.gotIt)).toEqual([false, true, false, false])
        expect(row.steps.map((s) => s.fixedFrom)).toEqual(['version-0', null, null, 'version-0'])
        expect(row.tapers).toEqual(tapersOf())
      })

      it('gives each step\'s changedOn back as a Date, or null when it has none: a JSON column keeps text', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.append(readyRow(profileId, crypto.randomUUID(), BASE))

        const row = await latestOf(repository, profileId)

        expect(row.steps.map((s) => s.changedOn)).toEqual([null, new Date(BASE.getTime() - 3 * DAY), null, new Date(BASE.getTime() - DAY)])
        expect(row.steps[1]!.changedOn).toBeInstanceOf(Date)
      })

      it('reads a step stored before the field existed as changedOn null, which means day 1', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        // A row an older build wrote: its steps have no changedOn at all.
        const legacy = stepsOf().map(({ changedOn: _changedOn, ...step }) => step) as unknown as Appended['steps']
        await repository.append(readyRow(profileId, crypto.randomUUID(), BASE, { steps: legacy }))

        const row = await latestOf(repository, profileId)

        expect(row.steps.map((s) => s.changedOn)).toEqual([null, null, null, null])
        expect(row.steps.map((s) => s.step)).toEqual(['cleanse', 'treat', 'moisturise', 'protect'])
      })

      it('stores a pending version with no routine in it: no steps, no step-downs, no expectation', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = pendingRow(profileId, crypto.randomUUID(), BASE)

        await repository.append(row)

        const stored = await latestOf(repository, profileId)
        expect(stored).toEqual(row)
        expect(stored.status).toBe('pending')
        expect(stored.steps).toEqual([])
        expect(stored.tapers).toEqual([])
        expect(stored.expectation).toBeNull()
      })

      it('stores what a rules-only build records, whichever reason it gives: no model and no prompt hash, and the writer retry due time', async () => {
        const { repository, newAccount } = await make()
        const reasons = ['first', 'shelf', 'goal', 'safety', 'verdict', 'review-point', 'catalog-retired', 'sold-here', 'got-it', 'writer-retry'] as const

        for (const reason of reasons) {
          // One account per row: only the newest of a profile can be read back, so each reason gets a profile of its own.
          const { profileId } = await newAccount()
          const row = readyRow(profileId, crypto.randomUUID(), BASE, { source: 'rules', model: null, promptHash: null, reason, writerRetryDueAt: at(DAY), hintsShown: false })

          await repository.append(row)

          expect(await repository.latest(profileId), reason).toEqual(row)
        }
      })

      it('refuses a second version with an id already used, and keeps the first as it was: versions are never overwritten', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const first = readyRow(profileId, crypto.randomUUID(), BASE)
        await repository.append(first)

        await expect(repository.append({ ...first, createdAt: at(HOUR), routineFingerprint: 'routine-fp-2' })).rejects.toThrow()

        expect(await repository.latest(profileId)).toEqual(first)
      })

      it('keeps a start date that is null or set, as given', async () => {
        const { repository, newAccount } = await make()
        const notStarted = await newAccount()
        const started = await newAccount()
        await repository.append(readyRow(notStarted.profileId, crypto.randomUUID(), BASE, { startedOn: null }))
        await repository.append(readyRow(started.profileId, crypto.randomUUID(), BASE, { startedOn: at(-3 * DAY) }))

        expect((await latestOf(repository, notStarted.profileId)).startedOn).toBeNull()
        expect((await latestOf(repository, started.profileId)).startedOn).toEqual(at(-3 * DAY))
      })
    })

    describe('latest and current', () => {
      it('has a newer pending version as the latest, while the current one is still the ready version before it', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const ready = readyRow(profileId, crypto.randomUUID(), BASE)
        const pending = pendingRow(profileId, crypto.randomUUID(), at(HOUR), { reason: 'shelf' })
        await repository.append(ready)
        await repository.append(pending)

        expect(await repository.latest(profileId)).toEqual(pending)
        expect(await repository.current(profileId)).toEqual(ready)
      })

      it('has no current version while every version is still pending', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const pending = pendingRow(profileId, crypto.randomUUID(), BASE)
        await repository.append(pending)

        expect(await repository.current(profileId)).toBeNull()
        expect(await repository.latest(profileId)).toEqual(pending)
      })

      it('moves the current version to the newer one when a second ready version is appended', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const first = readyRow(profileId, crypto.randomUUID(), BASE)
        const second = readyRow(profileId, crypto.randomUUID(), at(HOUR), { reason: 'shelf', routineFingerprint: 'routine-fp-2' })
        await repository.append(first)
        expect(await repository.current(profileId)).toEqual(first)

        await repository.append(second)

        expect(await repository.current(profileId)).toEqual(second)
        expect(await repository.latest(profileId)).toEqual(second)
      })

      it('goes by creation time, not by the order the rows were appended in', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const newer = readyRow(profileId, crypto.randomUUID(), at(2 * HOUR), { routineFingerprint: 'routine-fp-newer' })
        const older = readyRow(profileId, crypto.randomUUID(), at(HOUR), { routineFingerprint: 'routine-fp-older' })
        await repository.append(newer)
        await repository.append(older)

        expect(await repository.latest(profileId)).toEqual(newer)
        expect(await repository.current(profileId)).toEqual(newer)
      })

      it('tells a version a millisecond newer from the one before it', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const first = readyRow(profileId, crypto.randomUUID(), BASE)
        const second = readyRow(profileId, crypto.randomUUID(), at(1), { routineFingerprint: 'routine-fp-2' })
        await repository.append(first)
        await repository.append(second)

        expect((await latestOf(repository, profileId)).id).toBe(second.id)
        expect((await repository.current(profileId))!.id).toBe(second.id)
      })

      it('makes current the version that became ready last, not the one created last: a build asked for first that finishes after a later one replaces it', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const slow = pendingRow(profileId, crypto.randomUUID(), at(HOUR), { reason: 'shelf' })
        const quick = readyRow(profileId, crypto.randomUUID(), at(2 * HOUR), { reason: 'got-it', routineFingerprint: 'routine-fp-quick' })
        await repository.append(slow)
        await repository.append(quick)
        expect((await repository.current(profileId))!.id).toBe(quick.id)

        await repository.complete(slow.id, builtOf({ readyAt: at(3 * HOUR) }))

        expect((await repository.current(profileId))!.id).toBe(slow.id)
        expect((await repository.latest(profileId))!.id).toBe(quick.id)
      })

      it('goes by the larger id when two versions became ready at the same moment', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const [low, high] = ['a-version', 'b-version']
        await repository.append(readyRow(profileId, high!, at(HOUR), { readyAt: at(3 * HOUR), routineFingerprint: 'routine-fp-high' }))
        await repository.append(readyRow(profileId, low!, at(2 * HOUR), { readyAt: at(3 * HOUR), routineFingerprint: 'routine-fp-low' }))

        expect((await repository.current(profileId))!.id).toBe(high)
      })

      it('counts a ready version with no readyAt from its creation time', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const old = readyRow(profileId, crypto.randomUUID(), at(HOUR), { readyAt: null, routineFingerprint: 'routine-fp-old' })
        const earlier = readyRow(profileId, crypto.randomUUID(), at(2 * HOUR), { readyAt: at(30 * MINUTE), routineFingerprint: 'routine-fp-earlier' })
        await repository.append(earlier)
        await repository.append(old)

        expect((await repository.current(profileId))!.id).toBe(old.id)
      })

      it('never gives one profile another profile\'s versions', async () => {
        const { repository, newAccount } = await make()
        const [amara, tolu, nobody] = await Promise.all([newAccount(), newAccount(), newAccount()])
        const amarasRow = readyRow(amara.profileId, crypto.randomUUID(), at(HOUR), { routineFingerprint: 'amara' })
        const tolusRow = readyRow(tolu.profileId, crypto.randomUUID(), BASE, { routineFingerprint: 'tolu' })
        const tolusNewerPending = pendingRow(tolu.profileId, crypto.randomUUID(), at(2 * HOUR))
        await repository.append(amarasRow)
        await repository.append(tolusRow)
        await repository.append(tolusNewerPending)

        expect(await repository.latest(amara.profileId)).toEqual(amarasRow)
        expect(await repository.current(amara.profileId)).toEqual(amarasRow)
        expect(await repository.latest(tolu.profileId)).toEqual(tolusNewerPending)
        expect(await repository.current(tolu.profileId)).toEqual(tolusRow)
        expect(await repository.latest(nobody.profileId)).toBeNull()
        expect(await repository.current(nobody.profileId)).toBeNull()
      })
    })

    describe('complete', () => {
      it('fills a pending version with its build and makes it ready, every completed field coming back as given and the rest of the row as it was', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const pending = pendingRow(profileId, crypto.randomUUID(), BASE, { startedOn: at(-DAY), reason: 'shelf' })
        await repository.append(pending)
        const built = builtOf({ writerRetryDueAt: at(DAY), writerCalls: 2 })

        await expect(repository.complete(pending.id, built)).resolves.toBe(true)

        expect(await repository.latest(profileId)).toEqual({ ...pending, ...built, status: 'ready' })
        expect(await repository.latest(profileId)).toMatchObject({
          status: 'ready',
          steps: stepsOf(),
          tapers: tapersOf(),
          expectation: 'Give it 8 to 12 weeks before judging.',
          model: 'claude-sonnet-5-5',
          promptHash: 'prompt-hash-1',
          catalogVersion: 7,
          routineFingerprint: 'routine-fp-1',
          source: 'writer',
          hintsShown: true,
          writerRetryDueAt: at(DAY),
          writerCalls: 2,
        })
      })

      it('takes a rules-built completion, with no model and no prompt hash', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const pending = pendingRow(profileId, crypto.randomUUID(), BASE)
        await repository.append(pending)
        const built = builtOf({ source: 'rules', model: null, promptHash: null, hintsShown: false, writerRetryDueAt: at(DAY), writerCalls: 3 })

        await expect(repository.complete(pending.id, built)).resolves.toBe(true)

        expect(await repository.latest(profileId)).toEqual({ ...pending, ...built, status: 'ready' })
      })

      it('makes the completed version the current one', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const before = readyRow(profileId, crypto.randomUUID(), BASE)
        const pending = pendingRow(profileId, crypto.randomUUID(), at(HOUR), { reason: 'shelf' })
        await repository.append(before)
        await repository.append(pending)
        expect(await repository.current(profileId)).toEqual(before)

        await repository.complete(pending.id, builtOf({ routineFingerprint: 'routine-fp-2' }))

        const current = await repository.current(profileId)
        expect(current?.id).toBe(pending.id)
        expect(current?.status).toBe('ready')
        expect(current?.routineFingerprint).toBe('routine-fp-2')
      })

      it('completes a version once: the second time resolves to false and changes nothing', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const pending = pendingRow(profileId, crypto.randomUUID(), BASE)
        await repository.append(pending)
        const built = builtOf()
        await repository.complete(pending.id, built)

        await expect(repository.complete(pending.id, builtOf({ routineFingerprint: 'routine-fp-other', source: 'rules', model: null, promptHash: null, writerCalls: 3 }))).resolves.toBe(false)

        expect(await repository.latest(profileId)).toEqual({ ...pending, ...built, status: 'ready' })
      })

      it('does not change a version that was appended ready', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const ready = readyRow(profileId, crypto.randomUUID(), BASE)
        await repository.append(ready)

        await expect(repository.complete(ready.id, builtOf({ routineFingerprint: 'routine-fp-other' }))).resolves.toBe(false)

        expect(await repository.latest(profileId)).toEqual(ready)
      })

      it('keeps the served time of a completed version through markServed, and the rest as completed', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const pending = pendingRow(profileId, crypto.randomUUID(), BASE)
        await repository.append(pending)
        const built = builtOf()
        await repository.complete(pending.id, built)

        await repository.markServed(pending.id, at(HOUR))

        expect(await repository.latest(profileId)).toEqual({ ...pending, ...built, status: 'ready', servedAt: at(HOUR) })
      })

      it('resolves to false for a version nobody has, creating nothing', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()

        await expect(repository.complete(crypto.randomUUID(), builtOf())).resolves.toBe(false)

        expect(await repository.latest(profileId)).toBeNull()
      })

      it('completes only the version it is given, not another pending one of the profile or of another profile', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const other = await newAccount()
        const target = pendingRow(profileId, crypto.randomUUID(), BASE)
        const sibling = pendingRow(profileId, crypto.randomUUID(), at(HOUR))
        const othersRow = pendingRow(other.profileId, crypto.randomUUID(), BASE)
        await repository.append(target)
        await repository.append(sibling)
        await repository.append(othersRow)

        await repository.complete(target.id, builtOf())

        expect(await repository.latest(profileId)).toEqual(sibling)
        expect(await repository.current(profileId)).toMatchObject({ id: target.id, status: 'ready' })
        expect(await repository.latest(other.profileId)).toEqual(othersRow)
      })
    })

    describe('markServed', () => {
      it('records when that version was returned to the user, and changes nothing else of it', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = readyRow(profileId, crypto.randomUUID(), BASE)
        await repository.append(row)

        await expect(repository.markServed(row.id, at(2 * HOUR))).resolves.toBeUndefined()

        expect(await repository.current(profileId)).toEqual({ ...row, servedAt: at(2 * HOUR) })
      })

      it('replaces an earlier served time with the new one: it is when the version was last returned', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = readyRow(profileId, crypto.randomUUID(), BASE)
        await repository.append(row)
        await repository.markServed(row.id, at(HOUR))

        await repository.markServed(row.id, at(3 * HOUR))

        expect((await latestOf(repository, profileId)).servedAt).toEqual(at(3 * HOUR))
      })

      it('marks only the version it is given, not a newer one of the profile or another profile\'s', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const other = await newAccount()
        const older = readyRow(profileId, crypto.randomUUID(), BASE)
        const newer = readyRow(profileId, crypto.randomUUID(), at(HOUR), { routineFingerprint: 'routine-fp-2' })
        const othersRow = readyRow(other.profileId, crypto.randomUUID(), BASE)
        await repository.append(older)
        await repository.append(newer)
        await repository.append(othersRow)

        await repository.markServed(older.id, at(2 * HOUR))

        // Only the newest row of a profile can be read back: it is not marked because an older one was, and the other profile's row is untouched.
        expect(await repository.current(profileId)).toEqual(newer)
        expect(await repository.current(other.profileId)).toEqual(othersRow)
      })

      it('can mark a pending version like any other', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const pending = pendingRow(profileId, crypto.randomUUID(), BASE)
        await repository.append(pending)

        await repository.markServed(pending.id, at(MINUTE))

        expect(await repository.latest(profileId)).toEqual({ ...pending, servedAt: at(MINUTE) })
      })

      it('ignores a version nobody has, creating nothing', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()

        await expect(repository.markServed(crypto.randomUUID(), at(HOUR))).resolves.toBeUndefined()

        expect(await repository.latest(profileId)).toBeNull()
      })
    })

    describe('cautions', () => {
      it('keeps the cautions of a version in the order they were given, and an empty list as an empty list, not as null', async () => {
        const { repository, newAccount } = await make()
        const withSome = await newAccount()
        const withNone = await newAccount()
        await repository.append(readyRow(withSome.profileId, crypto.randomUUID(), BASE, { cautions: ['pregnant', 'tapering', 'prescription'] }))
        await repository.append(readyRow(withNone.profileId, crypto.randomUUID(), BASE, { cautions: [] }))

        expect((await latestOf(repository, withSome.profileId)).cautions).toEqual(['pregnant', 'tapering', 'prescription'])
        expect((await latestOf(repository, withNone.profileId)).cautions).toEqual([])
      })

      it('has none recorded on a version appended without them: null, which is not the same as no cautions', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.append(readyRow(profileId, crypto.randomUUID(), BASE, { cautions: null }))

        expect((await latestOf(repository, profileId)).cautions).toBeNull()
      })

      it('is null while a version is pending, and is filled in with the build\'s cautions when it completes', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const pending = pendingRow(profileId, crypto.randomUUID(), BASE)
        await repository.append(pending)
        expect((await latestOf(repository, profileId)).cautions).toBeNull()

        await repository.complete(pending.id, builtOf({ cautions: ['breastfeeding', 'recent-reaction'] }))

        expect((await latestOf(repository, profileId)).cautions).toEqual(['breastfeeding', 'recent-reaction'])
      })
    })

    describe('goal', () => {
      it('keeps the goal a version was built for, and null for one appended without it', async () => {
        const { repository, newAccount } = await make()
        const withGoal = await newAccount()
        const withNone = await newAccount()
        await repository.append(readyRow(withGoal.profileId, crypto.randomUUID(), BASE, { goal: 'glow' }))
        await repository.append(readyRow(withNone.profileId, crypto.randomUUID(), BASE, { goal: null }))

        expect((await latestOf(repository, withGoal.profileId)).goal).toBe('glow')
        expect((await latestOf(repository, withNone.profileId)).goal).toBeNull()
      })

      it('is null while a version is pending, and is filled in with the build\'s goal when it completes', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const pending = pendingRow(profileId, crypto.randomUUID(), BASE)
        await repository.append(pending)
        expect((await latestOf(repository, profileId)).goal).toBeNull()

        await repository.complete(pending.id, builtOf({ goal: 'glow' }))

        expect((await latestOf(repository, profileId)).goal).toBe('glow')
      })
    })

    describe('shelf counts', () => {
      it('keeps the four counts of a version as given, each in its own place', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.append(readyRow(profileId, crypto.randomUUID(), BASE, { shelfCounts: { keep: 7, reduce: 0, drop: 5, stop: 1 } }))

        expect((await latestOf(repository, profileId)).shelfCounts).toEqual({ keep: 7, reduce: 0, drop: 5, stop: 1 })
        expect((await repository.current(profileId))!.shelfCounts).toEqual({ keep: 7, reduce: 0, drop: 5, stop: 1 })
      })

      it('has none recorded on a version appended without them: null, which is not the same as four zeros', async () => {
        const { repository, newAccount } = await make()
        const withNone = await newAccount()
        const withZeros = await newAccount()
        await repository.append(readyRow(withNone.profileId, crypto.randomUUID(), BASE, { shelfCounts: null }))
        await repository.append(readyRow(withZeros.profileId, crypto.randomUUID(), BASE, { shelfCounts: { keep: 0, reduce: 0, drop: 0, stop: 0 } }))

        expect((await latestOf(repository, withNone.profileId)).shelfCounts).toBeNull()
        expect((await latestOf(repository, withZeros.profileId)).shelfCounts).toEqual({ keep: 0, reduce: 0, drop: 0, stop: 0 })
      })

      it('is null while a version is pending, and is filled in with the build\'s counts when it completes', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const pending = pendingRow(profileId, crypto.randomUUID(), BASE)
        await repository.append(pending)
        expect((await latestOf(repository, profileId)).shelfCounts).toBeNull()

        await repository.complete(pending.id, builtOf({ shelfCounts: { keep: 2, reduce: 6, drop: 0, stop: 3 } }))

        expect((await latestOf(repository, profileId)).shelfCounts).toEqual({ keep: 2, reduce: 6, drop: 0, stop: 3 })
      })

      it('completes with no counts as null, when the build has none to give', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const pending = pendingRow(profileId, crypto.randomUUID(), BASE)
        await repository.append(pending)

        await repository.complete(pending.id, builtOf({ shelfCounts: null }))

        expect((await latestOf(repository, profileId)).shelfCounts).toBeNull()
      })

      it('is changed by nothing that marks the version later: serving it, starting it, clearing its writer retry or recording its fingerprint', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = readyRow(profileId, crypto.randomUUID(), BASE, { startedOn: null, writerRetryDueAt: at(DAY), shelfCounts: { keep: 7, reduce: 0, drop: 5, stop: 1 } })
        await repository.append(row)

        await repository.markServed(row.id, at(HOUR))
        await repository.markStarted(profileId, at(2 * HOUR))
        await repository.clearWriterRetry(row.id)
        await repository.setRoutineFingerprint(row.id, 'routine-fp-2')

        expect((await latestOf(repository, profileId)).shelfCounts).toEqual({ keep: 7, reduce: 0, drop: 5, stop: 1 })
      })
    })

    describe('not in the routine', () => {
      it('keeps the list of a version as given, each item whole and in the order given', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.append(readyRow(profileId, crypto.randomUUID(), BASE, { notInRoutine: [...LEFT_OUT].reverse() }))

        expect((await latestOf(repository, profileId)).notInRoutine).toEqual([...LEFT_OUT].reverse())
        expect((await repository.current(profileId))!.notInRoutine).toEqual([...LEFT_OUT].reverse())
      })

      it('keeps an empty list and no list apart: none left out is [], a version built before the column is null', async () => {
        const { repository, newAccount } = await make()
        const withNone = await newAccount()
        const withEmpty = await newAccount()
        await repository.append(readyRow(withNone.profileId, crypto.randomUUID(), BASE, { notInRoutine: null }))
        await repository.append(readyRow(withEmpty.profileId, crypto.randomUUID(), BASE, { notInRoutine: [] }))

        expect((await latestOf(repository, withNone.profileId)).notInRoutine).toBeNull()
        expect((await latestOf(repository, withEmpty.profileId)).notInRoutine).toEqual([])
      })

      it('is null while a version is pending, and is filled in with the build\'s list when it completes', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const pending = pendingRow(profileId, crypto.randomUUID(), BASE)
        await repository.append(pending)
        expect((await latestOf(repository, profileId)).notInRoutine).toBeNull()

        await repository.complete(pending.id, builtOf({ notInRoutine: [LEFT_OUT[1]!] }))

        expect((await latestOf(repository, profileId)).notInRoutine).toEqual([LEFT_OUT[1]])
      })

      it('completes with no list as null, when the build has none to give', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const pending = pendingRow(profileId, crypto.randomUUID(), BASE)
        await repository.append(pending)

        await repository.complete(pending.id, builtOf({ notInRoutine: null }))

        expect((await latestOf(repository, profileId)).notInRoutine).toBeNull()
      })

      it('is changed by nothing that marks the version later: serving it, starting it, clearing its writer retry, recording its fingerprint or its counts', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = readyRow(profileId, crypto.randomUUID(), BASE, { startedOn: null, writerRetryDueAt: at(DAY) })
        await repository.append(row)

        await repository.markServed(row.id, at(HOUR))
        await repository.markStarted(profileId, at(2 * HOUR))
        await repository.clearWriterRetry(row.id)
        await repository.setRoutineFingerprint(row.id, 'routine-fp-2')
        await repository.setShelfCounts(row.id, { keep: 1, reduce: 1, drop: 1, stop: 1 })

        expect((await latestOf(repository, profileId)).notInRoutine).toEqual(LEFT_OUT)
      })
    })

    describe('step-downs as stored', () => {
      it('gives each start date back as a Date to the millisecond, and a step-down not started as null, from an appended version', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.append(readyRow(profileId, crypto.randomUUID(), BASE))

        const [started, notStarted] = (await latestOf(repository, profileId)).tapers

        expect(started!.startedOn).toBeInstanceOf(Date)
        expect(started!.startedOn!.getTime()).toBe(BASE.getTime() - DAY + 456)
        expect(notStarted).toEqual({ shelfProductId: 'entry-4', templateId: 'TPR-LIGHTENING-1', startedOn: null })
      })

      it('gives the same back from a version completed from pending', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const pending = pendingRow(profileId, crypto.randomUUID(), BASE)
        await repository.append(pending)

        await repository.complete(pending.id, builtOf())

        const [started, notStarted] = (await latestOf(repository, profileId)).tapers
        expect(started).toEqual({ shelfProductId: 'entry-3', templateId: 'TPR-STEROID-1', startedOn: new Date(BASE.getTime() - DAY + 456) })
        expect(started!.startedOn).toBeInstanceOf(Date)
        expect(notStarted!.startedOn).toBeNull()
      })
    })

    describe('markStarted', () => {
      it('sets the start date on the profile\'s ready version and changes nothing else of it', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = readyRow(profileId, crypto.randomUUID(), BASE, { startedOn: null, tapers: [] })
        await repository.append(row)

        await expect(repository.markStarted(profileId, at(HOUR))).resolves.toBeUndefined()

        expect(await repository.current(profileId)).toEqual({ ...row, startedOn: at(HOUR) })
      })

      it('stamps the start date on each step-down of the version that is not dated yet, and leaves a step-down already under way with its own date', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = readyRow(profileId, crypto.randomUUID(), BASE, { startedOn: null })
        await repository.append(row)

        await repository.markStarted(profileId, at(HOUR))

        const stored = await latestOf(repository, profileId)
        expect(stored.startedOn).toEqual(at(HOUR))
        expect(stored.tapers).toEqual([
          { shelfProductId: 'entry-3', templateId: 'TPR-STEROID-1', startedOn: new Date(BASE.getTime() - DAY + 456) },
          { shelfProductId: 'entry-4', templateId: 'TPR-LIGHTENING-1', startedOn: at(HOUR) },
        ])
        expect(stored.steps).toEqual(row.steps)
      })

      it('starts a pending version too, so a build under way carries the start date into its routine', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const ready = readyRow(profileId, crypto.randomUUID(), BASE, { startedOn: null, tapers: [] })
        const pending = pendingRow(profileId, crypto.randomUUID(), at(MINUTE))
        await repository.append(ready)
        await repository.append(pending)

        await repository.markStarted(profileId, at(HOUR))

        expect(await repository.latest(profileId)).toEqual({ ...pending, startedOn: at(HOUR) })
        expect(await repository.current(profileId)).toEqual({ ...ready, startedOn: at(HOUR) })
      })

      it('starts every version of the profile that has no start date, the older ready ones included', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const oldest = readyRow(profileId, crypto.randomUUID(), BASE, { startedOn: null, tapers: [] })
        const newest = readyRow(profileId, crypto.randomUUID(), at(HOUR), { startedOn: null, tapers: [], routineFingerprint: 'routine-fp-2' })
        await repository.append(oldest)
        await repository.append(newest)
        // The only way to read an older row back is as the last one served.
        await repository.markServed(oldest.id, at(2 * HOUR))

        await repository.markStarted(profileId, at(3 * HOUR))

        expect(await repository.lastServedBefore(profileId, newest.id)).toEqual({ ...oldest, servedAt: at(2 * HOUR), startedOn: at(3 * HOUR) })
        expect((await latestOf(repository, profileId)).startedOn).toEqual(at(3 * HOUR))
      })

      it('keeps a start date already set: the first start is the start, so asking again moves nothing', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = readyRow(profileId, crypto.randomUUID(), BASE, { startedOn: null, tapers: [] })
        await repository.append(row)
        await repository.markStarted(profileId, at(HOUR))

        await expect(repository.markStarted(profileId, at(5 * DAY))).resolves.toBeUndefined()

        expect((await latestOf(repository, profileId)).startedOn).toEqual(at(HOUR))
      })

      it('does not move the start date of a version that was already started when it was appended', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = readyRow(profileId, crypto.randomUUID(), BASE, { startedOn: at(-3 * DAY), tapers: [] })
        await repository.append(row)

        await repository.markStarted(profileId, at(HOUR))

        expect(await repository.latest(profileId)).toEqual(row)
      })

      it('starts only that profile\'s versions', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const other = await newAccount()
        await repository.append(readyRow(profileId, crypto.randomUUID(), BASE, { startedOn: null, tapers: [] }))
        const othersRow = readyRow(other.profileId, crypto.randomUUID(), BASE, { startedOn: null, tapers: [] })
        await repository.append(othersRow)

        await repository.markStarted(profileId, at(HOUR))

        expect(await repository.latest(other.profileId)).toEqual(othersRow)
      })

      it('keeps the start date to the millisecond', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.append(readyRow(profileId, crypto.randomUUID(), BASE, { startedOn: null, tapers: [] }))

        await repository.markStarted(profileId, new Date(BASE.getTime() + 789))

        expect((await latestOf(repository, profileId)).startedOn!.getTime()).toBe(BASE.getTime() + 789)
      })

      it('ignores a profile with no versions, creating nothing', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()

        await expect(repository.markStarted(profileId, at(HOUR))).resolves.toBeUndefined()

        expect(await repository.latest(profileId)).toBeNull()
      })
    })

    describe('clearWriterRetry', () => {
      it('clears the writer retry due time of that version and changes nothing else of it', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = readyRow(profileId, crypto.randomUUID(), BASE, { source: 'rules', model: null, promptHash: null, writerRetryDueAt: at(DAY) })
        await repository.append(row)

        await expect(repository.clearWriterRetry(row.id)).resolves.toBeUndefined()

        expect(await repository.current(profileId)).toEqual({ ...row, writerRetryDueAt: null })
      })

      it('leaves the profile\'s other versions, and a version nobody has, alone', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const first = readyRow(profileId, crypto.randomUUID(), BASE, { writerRetryDueAt: at(DAY) })
        const second = readyRow(profileId, crypto.randomUUID(), at(HOUR), { writerRetryDueAt: at(2 * DAY), routineFingerprint: 'routine-fp-2' })
        await repository.append(first)
        await repository.append(second)

        await repository.clearWriterRetry(first.id)
        await expect(repository.clearWriterRetry(crypto.randomUUID())).resolves.toBeUndefined()

        expect((await repository.current(profileId))!.writerRetryDueAt).toEqual(at(2 * DAY))
      })
    })

    describe('setRoutineFingerprint', () => {
      it('sets the routine fingerprint of that version and changes nothing else of it', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = readyRow(profileId, crypto.randomUUID(), BASE, { routineFingerprint: 'routine-fp-1' })
        await repository.append(row)

        await expect(repository.setRoutineFingerprint(row.id, 'routine-fp-2')).resolves.toBeUndefined()

        expect(await repository.current(profileId)).toEqual({ ...row, routineFingerprint: 'routine-fp-2' })
      })

      it('leaves the profile\'s other versions, and a version nobody has, alone', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const first = readyRow(profileId, crypto.randomUUID(), BASE, { routineFingerprint: 'routine-fp-1' })
        const second = readyRow(profileId, crypto.randomUUID(), at(HOUR), { routineFingerprint: 'routine-fp-2' })
        await repository.append(first)
        await repository.append(second)

        await repository.setRoutineFingerprint(first.id, 'routine-fp-3')
        await expect(repository.setRoutineFingerprint(crypto.randomUUID(), 'routine-fp-4')).resolves.toBeUndefined()

        expect((await repository.current(profileId))!.routineFingerprint).toBe('routine-fp-2')
        expect((await repository.latest(profileId))!.routineFingerprint).toBe('routine-fp-2')
      })

      it('can fill a fingerprint that was null', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = readyRow(profileId, crypto.randomUUID(), BASE, { routineFingerprint: null })
        await repository.append(row)

        await repository.setRoutineFingerprint(row.id, 'routine-fp-1')

        expect((await repository.current(profileId))!.routineFingerprint).toBe('routine-fp-1')
      })
    })

    describe('setShelfCounts', () => {
      it('sets the shelf counts of that version and changes nothing else of it', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = readyRow(profileId, crypto.randomUUID(), BASE, { shelfCounts: null, routineFingerprint: 'routine-fp-1' })
        await repository.append(row)

        await expect(repository.setShelfCounts(row.id, { keep: 6, reduce: 1, drop: 2, stop: 3 })).resolves.toBeUndefined()

        expect(await repository.current(profileId)).toEqual({ ...row, shelfCounts: { keep: 6, reduce: 1, drop: 2, stop: 3 } })
      })

      it('leaves the profile\'s other versions, and a version nobody has, alone', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const first = readyRow(profileId, crypto.randomUUID(), BASE)
        const second = readyRow(profileId, crypto.randomUUID(), at(HOUR))
        await repository.append(first)
        await repository.append(second)

        await repository.setShelfCounts(first.id, { keep: 9, reduce: 9, drop: 9, stop: 9 })
        await expect(repository.setShelfCounts(crypto.randomUUID(), { keep: 8, reduce: 8, drop: 8, stop: 8 })).resolves.toBeUndefined()

        expect((await repository.current(profileId))!.shelfCounts).toEqual(COUNTS)
        expect((await repository.latest(profileId))!.shelfCounts).toEqual(COUNTS)
      })
    })

    describe('setNotInRoutine', () => {
      it('sets the list of that version and changes nothing else of it', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = readyRow(profileId, crypto.randomUUID(), BASE, { notInRoutine: null, routineFingerprint: 'routine-fp-1' })
        await repository.append(row)

        await expect(repository.setNotInRoutine(row.id, LEFT_OUT)).resolves.toBeUndefined()

        expect(await repository.current(profileId)).toEqual({ ...row, notInRoutine: LEFT_OUT })
      })

      it('replaces a list already there, and can set an empty one', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = readyRow(profileId, crypto.randomUUID(), BASE)
        await repository.append(row)

        await repository.setNotInRoutine(row.id, [LEFT_OUT[1]!])
        expect((await repository.current(profileId))!.notInRoutine).toEqual([LEFT_OUT[1]])

        await repository.setNotInRoutine(row.id, [])
        expect((await repository.current(profileId))!.notInRoutine).toEqual([])
      })

      it('leaves the profile\'s other versions, and a version nobody has, alone', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const first = readyRow(profileId, crypto.randomUUID(), BASE)
        const second = readyRow(profileId, crypto.randomUUID(), at(HOUR))
        await repository.append(first)
        await repository.append(second)

        await repository.setNotInRoutine(first.id, [])
        await expect(repository.setNotInRoutine(crypto.randomUUID(), [])).resolves.toBeUndefined()

        expect((await repository.current(profileId))!.notInRoutine).toEqual(LEFT_OUT)
        expect((await repository.latest(profileId))!.notInRoutine).toEqual(LEFT_OUT)
      })
    })

    describe('lastServedBefore', () => {
      it('is the newest ready version that was served, apart from the one named', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const first = readyRow(profileId, crypto.randomUUID(), BASE, { routineFingerprint: 'routine-fp-1' })
        const second = readyRow(profileId, crypto.randomUUID(), at(HOUR), { routineFingerprint: 'routine-fp-2' })
        const third = readyRow(profileId, crypto.randomUUID(), at(2 * HOUR), { routineFingerprint: 'routine-fp-3' })
        for (const row of [first, second, third]) await repository.append(row)
        await repository.markServed(first.id, at(3 * HOUR))
        await repository.markServed(second.id, at(4 * HOUR))

        expect(await repository.lastServedBefore(profileId, third.id)).toEqual({ ...second, servedAt: at(4 * HOUR) })
      })

      it('skips a version that was never served, however new: the current version is not the one the user last saw', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const served = readyRow(profileId, crypto.randomUUID(), BASE, { routineFingerprint: 'routine-fp-1' })
        const unserved = readyRow(profileId, crypto.randomUUID(), at(HOUR), { routineFingerprint: 'routine-fp-2' })
        await repository.append(served)
        await repository.append(unserved)
        await repository.markServed(served.id, at(2 * HOUR))

        expect(await repository.lastServedBefore(profileId, crypto.randomUUID())).toEqual({ ...served, servedAt: at(2 * HOUR) })
      })

      it('goes by the version named, not by age: naming the older one gives the newer served one', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const older = readyRow(profileId, crypto.randomUUID(), BASE, { routineFingerprint: 'routine-fp-1' })
        const newer = readyRow(profileId, crypto.randomUUID(), at(HOUR), { routineFingerprint: 'routine-fp-2' })
        await repository.append(older)
        await repository.append(newer)
        await repository.markServed(older.id, at(2 * HOUR))
        await repository.markServed(newer.id, at(3 * HOUR))

        expect((await repository.lastServedBefore(profileId, older.id))?.id).toBe(newer.id)
        expect((await repository.lastServedBefore(profileId, newer.id))?.id).toBe(older.id)
      })

      it('is null when no version was served, and when the only served one is the one named', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const row = readyRow(profileId, crypto.randomUUID(), BASE)
        await repository.append(row)
        expect(await repository.lastServedBefore(profileId, crypto.randomUUID())).toBeNull()

        await repository.markServed(row.id, at(HOUR))

        expect(await repository.lastServedBefore(profileId, row.id)).toBeNull()
        expect((await repository.lastServedBefore(profileId, crypto.randomUUID()))?.id).toBe(row.id)
      })

      it('never gives a pending version, even one marked served', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const pending = pendingRow(profileId, crypto.randomUUID(), BASE)
        await repository.append(pending)
        await repository.markServed(pending.id, at(HOUR))

        expect(await repository.lastServedBefore(profileId, crypto.randomUUID())).toBeNull()
      })

      it('gives only that profile\'s versions', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const other = await newAccount()
        const othersRow = readyRow(other.profileId, crypto.randomUUID(), BASE)
        await repository.append(othersRow)
        await repository.markServed(othersRow.id, at(HOUR))

        expect(await repository.lastServedBefore(profileId, crypto.randomUUID())).toBeNull()
        expect((await repository.lastServedBefore(other.profileId, crypto.randomUUID()))?.id).toBe(othersRow.id)
      })
    })

    describe('writerBuildsSince', () => {
      it('counts the builds with writer calls made at or after the cut-off: one at the cut-off counts, one a millisecond before does not', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const since = at(-DAY)
        await repository.append(readyRow(profileId, crypto.randomUUID(), new Date(since.getTime() - 1)))
        expect(await repository.writerBuildsSince(profileId, since)).toBe(0)

        await repository.append(readyRow(profileId, crypto.randomUUID(), since))
        expect(await repository.writerBuildsSince(profileId, since)).toBe(1)

        await repository.append(readyRow(profileId, crypto.randomUUID(), new Date(since.getTime() + 1)))
        expect(await repository.writerBuildsSince(profileId, since)).toBe(2)
      })

      it('does not count a build that made no writer calls, pending or built by the rules alone', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.append(pendingRow(profileId, crypto.randomUUID(), at(-HOUR)))
        await repository.append(readyRow(profileId, crypto.randomUUID(), at(-2 * HOUR), { source: 'rules', model: null, promptHash: null, writerCalls: 0 }))
        await repository.append(readyRow(profileId, crypto.randomUUID(), at(-3 * HOUR)))

        expect(await repository.writerBuildsSince(profileId, at(-DAY))).toBe(1)
      })

      it('counts a rules-built version after failed writer calls, because those calls were paid for', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.append(readyRow(profileId, crypto.randomUUID(), at(-HOUR), { source: 'rules', model: null, promptHash: null, writerRetryDueAt: at(DAY), writerCalls: 2 }))

        expect(await repository.writerBuildsSince(profileId, at(-DAY))).toBe(1)
      })

      it('counts a build once, however many writer calls it made and whether it was built pending then completed or appended ready', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const pending = pendingRow(profileId, crypto.randomUUID(), at(-HOUR))
        await repository.append(pending)
        expect(await repository.writerBuildsSince(profileId, at(-DAY))).toBe(0)

        await repository.complete(pending.id, builtOf({ writerCalls: 3 }))
        expect(await repository.writerBuildsSince(profileId, at(-DAY))).toBe(1)

        await repository.append(readyRow(profileId, crypto.randomUUID(), at(-2 * HOUR), { writerCalls: 2 }))
        expect(await repository.writerBuildsSince(profileId, at(-DAY))).toBe(2)
      })

      it('counts the writer\'s retries like its first builds', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.append(readyRow(profileId, crypto.randomUUID(), at(-2 * HOUR), { reason: 'first' }))
        await repository.append(readyRow(profileId, crypto.randomUUID(), at(-HOUR), { reason: 'writer-retry' }))

        expect(await repository.writerBuildsSince(profileId, at(-DAY))).toBe(2)
      })

      it('counts only that profile\'s builds', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const other = await newAccount()
        await repository.append(readyRow(profileId, crypto.randomUUID(), at(-HOUR)))
        await repository.append(readyRow(other.profileId, crypto.randomUUID(), at(-HOUR)))
        await repository.append(readyRow(other.profileId, crypto.randomUUID(), at(-2 * HOUR)))

        expect(await repository.writerBuildsSince(profileId, at(-DAY))).toBe(1)
        expect(await repository.writerBuildsSince(other.profileId, at(-DAY))).toBe(2)
      })
    })

    describe('build requests: claim', () => {
      const KEY_1 = 'routine-fp-1'
      const KEY_2 = 'review-point:scan-9'

      it('creates the request on a profile with none, holding it at the time of the claim, and answers true', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()

        expect(await repository.claim(profileId, KEY_1, BASE, at(-HOUR))).toBe(true)

        expect(await repository.findRequest(profileId)).toEqual({ profileId, requestKey: KEY_1, requestedAt: BASE, retryDueAt: null, retried: false })
      })

      it('has no request for a profile that never asked for a build', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()

        expect(await repository.findRequest(profileId)).toBeNull()
      })

      it('lets exactly one of two parallel claims win', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()

        const answers = await Promise.all([repository.claim(profileId, KEY_1, BASE, at(-HOUR)), repository.claim(profileId, KEY_1, BASE, at(-HOUR))])

        expect(answers.filter(Boolean)).toHaveLength(1)
      })

      it('answers false and changes nothing for the same key while the claim is newer than staleBefore', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.claim(profileId, KEY_1, BASE, at(-HOUR))
        const before = await repository.findRequest(profileId)

        // staleBefore is one millisecond before the claim: the claim is not stale.
        expect(await repository.claim(profileId, KEY_1, at(HOUR), at(-1))).toBe(false)

        expect(await repository.findRequest(profileId)).toEqual(before)
      })

      it('answers false and changes nothing while the claim is newer than staleBefore, even with a different key', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.claim(profileId, KEY_1, BASE, at(-HOUR))
        const before = await repository.findRequest(profileId)

        expect(await repository.claim(profileId, KEY_2, at(HOUR), at(-1))).toBe(false)

        expect(await repository.findRequest(profileId)).toEqual(before)
      })

      it('takes the claim over when it was made exactly at staleBefore', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.claim(profileId, KEY_1, BASE, at(-HOUR))

        expect(await repository.claim(profileId, KEY_1, at(HOUR), BASE)).toBe(true)

        expect(await repository.findRequest(profileId)).toMatchObject({ requestKey: KEY_1, requestedAt: at(HOUR) })
      })

      it('takes the claim over when it was made before staleBefore, rewriting the key and the time', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.claim(profileId, KEY_1, BASE, at(-HOUR))

        expect(await repository.claim(profileId, KEY_2, at(HOUR), at(1))).toBe(true)

        expect(await repository.findRequest(profileId)).toMatchObject({ requestKey: KEY_2, requestedAt: at(HOUR) })
      })

      it('lets exactly one of two parallel takeovers of a stale claim win', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.claim(profileId, KEY_1, BASE, at(-HOUR))

        const answers = await Promise.all([repository.claim(profileId, KEY_1, at(HOUR), at(MINUTE)), repository.claim(profileId, KEY_1, at(HOUR), at(MINUTE))])

        expect(answers.filter(Boolean)).toHaveLength(1)
      })

      it('resets the dead-letter retry when it takes a claim over: a new request supersedes the retry that was waiting', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.claim(profileId, KEY_1, BASE, at(-HOUR))
        await repository.setRequestRetry(profileId, { retried: true, retryDueAt: at(DAY) })

        await repository.claim(profileId, KEY_1, at(HOUR), at(MINUTE))

        expect(await repository.findRequest(profileId)).toMatchObject({ retried: false, retryDueAt: null })
      })

      it('keeps one profile\'s claim apart from another\'s', async () => {
        const { repository, newAccount } = await make()
        const first = await newAccount()
        const second = await newAccount()
        await repository.claim(first.profileId, KEY_1, BASE, at(-HOUR))

        expect(await repository.claim(second.profileId, KEY_1, BASE, at(-HOUR))).toBe(true)
      })
    })

    describe('build requests: release', () => {
      const KEY_1 = 'routine-fp-1'

      it('lets the very next claim win when the claim made at exactly that time is released', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.claim(profileId, KEY_1, BASE, at(-HOUR))

        await repository.release(profileId, BASE)

        // The same key, one millisecond on, with a cut-off far older than the claim: only the release makes it claimable.
        expect(await repository.claim(profileId, KEY_1, at(1), at(-HOUR))).toBe(true)
      })

      it('leaves a claim made at another time alone: a claim taken since by another request is not given back', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.claim(profileId, KEY_1, at(MINUTE), at(-HOUR))

        await repository.release(profileId, BASE)
        await repository.release(profileId, at(MINUTE + 1))

        expect(await repository.claim(profileId, KEY_1, at(2 * MINUTE), at(-HOUR))).toBe(false)
        expect(await repository.findRequest(profileId)).toMatchObject({ requestedAt: at(MINUTE) })
      })

      it('ignores a profile with no request row, creating nothing', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()

        await expect(repository.release(profileId, BASE)).resolves.toBeUndefined()

        expect(await repository.findRequest(profileId)).toBeNull()
      })

      it('keeps the dead-letter retry that was set: giving back a claim does not cancel it', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.claim(profileId, KEY_1, BASE, at(-HOUR))
        await repository.setRequestRetry(profileId, { retried: true, retryDueAt: at(DAY) })

        await repository.release(profileId, BASE)

        expect(await repository.findRequest(profileId)).toMatchObject({ retried: true, retryDueAt: at(DAY) })
      })
    })

    describe('build requests: the dead-letter retry', () => {
      it('stores when the retry is due and that it was used, to the millisecond, changing nothing else of the request', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.claim(profileId, 'routine-fp-1', BASE, at(-HOUR))
        const due = new Date(BASE.getTime() + DAY + 789)

        await repository.setRequestRetry(profileId, { retried: true, retryDueAt: due })

        const row = await repository.findRequest(profileId)
        expect(row).toMatchObject({ profileId, requestKey: 'routine-fp-1', requestedAt: BASE, retried: true })
        expect(row!.retryDueAt!.getTime()).toBe(due.getTime())
      })

      it('clears a retry that was due when set to none', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.claim(profileId, 'routine-fp-1', BASE, at(-HOUR))
        await repository.setRequestRetry(profileId, { retried: true, retryDueAt: at(DAY) })

        await repository.setRequestRetry(profileId, { retried: true, retryDueAt: null })

        expect(await repository.findRequest(profileId)).toMatchObject({ retried: true, retryDueAt: null })
      })

      it('ignores a profile with no request row, creating nothing', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()

        await repository.setRequestRetry(profileId, { retried: true, retryDueAt: at(DAY) })

        expect(await repository.findRequest(profileId)).toBeNull()
      })
    })
    describe('the daily sweeps: build requests whose dead-letter retry is due', () => {
      // Dues sit in a window no other fixture uses, so that rows other tests left in a shared database cannot come between these.
      const FAR = -1000 * DAY
      const requestWithRetryDue = async (repository: RoutinesRepository, profileId: string, key: string, due: Date | null) => {
        await repository.claim(profileId, key, at(FAR), at(FAR - HOUR))
        await repository.setRequestRetry(profileId, { retried: true, retryDueAt: due })
      }
      const mine = <T extends { profileId: string }>(rows: T[], ...profileIds: string[]) => rows.filter((row) => profileIds.includes(row.profileId))

      it('returns a request whose retry is due, and not a millisecond before: the due time itself is due', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await requestWithRetryDue(repository, profileId, 'routine-fp-1', at(DAY))

        expect(mine(await repository.dueRequests(at(DAY - 1), 1000), profileId)).toEqual([])
        const due = mine(await repository.dueRequests(at(DAY), 1000), profileId)

        expect(due).toHaveLength(1)
        expect(due[0]).toMatchObject({ profileId, requestKey: 'routine-fp-1', retried: true })
        expect(due[0]!.retryDueAt!.getTime()).toBe(at(DAY).getTime())
      })

      it('never returns a request with no retry due', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.claim(profileId, 'routine-fp-1', BASE, at(-HOUR))

        expect(mine(await repository.dueRequests(at(10 * DAY), 1000), profileId)).toEqual([])
      })

      it('stops returning a request once its retry is cleared', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await requestWithRetryDue(repository, profileId, 'routine-fp-1', at(DAY))
        await repository.setRequestRetry(profileId, { retried: true, retryDueAt: null })

        expect(mine(await repository.dueRequests(at(10 * DAY), 1000), profileId)).toEqual([])
      })

      it('returns the longest overdue first and at most the limit', async () => {
        const { repository, newAccount } = await make()
        const [a, b, c] = [await newAccount(), await newAccount(), await newAccount()]
        await requestWithRetryDue(repository, b.profileId, 'routine-fp-b', at(FAR + 2 * DAY))
        await requestWithRetryDue(repository, c.profileId, 'routine-fp-c', at(FAR + 3 * DAY))
        await requestWithRetryDue(repository, a.profileId, 'routine-fp-a', at(FAR + DAY))

        const two = await repository.dueRequests(at(0), 2)
        const three = await repository.dueRequests(at(0), 3)

        expect(two.map((row) => row.profileId)).toEqual([a.profileId, b.profileId])
        expect(three.map((row) => row.profileId)).toEqual([a.profileId, b.profileId, c.profileId])
      })
    })

    describe('the daily sweeps: the routine in force whose writer retry is due', () => {
      const mine = <T extends { profileId: string }>(rows: T[], ...profileIds: string[]) => rows.filter((row) => profileIds.includes(row.profileId))
      const rulesRow = (profileId: string, id: string, createdAt: Date, retryDueAt: Date | null): Appended =>
        readyRow(profileId, id, createdAt, { source: 'rules', model: null, promptHash: null, writerCalls: 3, writerRetryDueAt: retryDueAt })

      it('returns a version whose retry is due, and not a millisecond before: the due time itself is due', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const id = crypto.randomUUID()
        await repository.append(rulesRow(profileId, id, BASE, at(DAY)))

        expect(mine(await repository.writerRetriesDue(at(DAY - 1), 1000), profileId)).toEqual([])
        const due = mine(await repository.writerRetriesDue(at(DAY), 1000), profileId)

        expect(due.map((row) => row.id)).toEqual([id])
      })

      it('never returns a version with no retry due', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.append(rulesRow(profileId, crypto.randomUUID(), BASE, null))

        expect(mine(await repository.writerRetriesDue(at(10 * DAY), 1000), profileId)).toEqual([])
      })

      it('does not return a version that a newer ready version has replaced, even though its retry is due', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.append(rulesRow(profileId, crypto.randomUUID(), BASE, at(DAY)))
        await repository.append(readyRow(profileId, crypto.randomUUID(), at(HOUR), { writerRetryDueAt: null }))

        expect(mine(await repository.writerRetriesDue(at(10 * DAY), 1000), profileId)).toEqual([])
      })

      it('returns only the newest ready version when an older one has a retry due too', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const newest = crypto.randomUUID()
        await repository.append(rulesRow(profileId, crypto.randomUUID(), BASE, at(DAY)))
        await repository.append(rulesRow(profileId, newest, at(HOUR), at(DAY + HOUR)))

        expect(mine(await repository.writerRetriesDue(at(10 * DAY), 1000), profileId).map((row) => row.id)).toEqual([newest])
      })

      it('returns the version that became ready last, not the one created last (a build that finished late)', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const late = crypto.randomUUID()
        await repository.append(pendingRow(profileId, late, BASE))
        await repository.append(rulesRow(profileId, crypto.randomUUID(), at(HOUR), at(DAY)))
        await repository.complete(late, builtOf({ source: 'rules', model: null, promptHash: null, writerCalls: 3, writerRetryDueAt: at(2 * DAY), readyAt: at(2 * HOUR) }))

        expect(mine(await repository.writerRetriesDue(at(10 * DAY), 1000), profileId).map((row) => row.id)).toEqual([late])
      })

      it('returns at most the limit', async () => {
        const { repository, newAccount } = await make()
        const accounts = [await newAccount(), await newAccount(), await newAccount()]
        for (const { profileId } of accounts) await repository.append(rulesRow(profileId, crypto.randomUUID(), BASE, at(DAY)))

        expect(await repository.writerRetriesDue(at(DAY), 2)).toHaveLength(2)
        expect(mine(await repository.writerRetriesDue(at(DAY), 1000), ...accounts.map((a) => a.profileId))).toHaveLength(3)
      })
    })

    describe('the daily sweeps: the routine in force that holds a code retired since it was built', () => {
      const mine = <T extends { profileId: string }>(rows: T[], ...profileIds: string[]) => rows.filter((row) => profileIds.includes(row.profileId))
      // Codes are made up for each test: the catalog is shared by every account, and other tests retire their own.
      const newCode = () => `CODE-${crypto.randomUUID()}`
      const candidateStep = (step: 'treat' | 'moisturise', code: string): Appended['steps'][number] => ({
        step,
        product: { kind: 'candidate', code },
        frequency: 'pm',
        reason: 'A test reason.',
        grounding: [],
        gotIt: false,
        fixedFrom: null,
        changedOn: null,
      })
      const versionHolding = (profileId: string, id: string, createdAt: Date, codes: string[], over: Partial<Appended> = {}): Appended =>
        readyRow(profileId, id, createdAt, { catalogVersion: 7, steps: [...codes.map((code, i) => candidateStep(i === 0 ? 'treat' : 'moisturise', code)), stepsOf()[0]!, stepsOf()[3]!], ...over })

      it('returns the version when a code it holds was retired after it was built, and not when it was retired in the same catalog version or before', async () => {
        const { repository, newAccount, retireCode } = await make()
        const { profileId } = await newAccount()
        const code = newCode()
        const id = crypto.randomUUID()
        await repository.append(versionHolding(profileId, id, BASE, [code]))

        await retireCode(code, 6)
        expect(mine(await repository.retiredCodeVersions(1000), profileId)).toEqual([])
        await retireCode(code, 7)
        expect(mine(await repository.retiredCodeVersions(1000), profileId)).toEqual([])
        await retireCode(code, 8)

        expect(mine(await repository.retiredCodeVersions(1000), profileId).map((row) => row.id)).toEqual([id])
      })

      it('does not return a version whose code the catalog has not retired, though other codes are', async () => {
        const { repository, newAccount, retireCode } = await make()
        const { profileId } = await newAccount()
        await repository.append(versionHolding(profileId, crypto.randomUUID(), BASE, [newCode()]))
        await retireCode(newCode(), 99)

        expect(mine(await repository.retiredCodeVersions(1000), profileId)).toEqual([])
      })

      it('ignores the products of a version that are not recommended ones: a shelf product, or use what you have', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.append(readyRow(profileId, crypto.randomUUID(), BASE, { steps: [stepsOf()[0]!, stepsOf()[2]!, stepsOf()[3]!] }))

        expect(mine(await repository.retiredCodeVersions(1000), profileId)).toEqual([])
      })

      it('returns a version once, however many of its codes were retired', async () => {
        const { repository, newAccount, retireCode } = await make()
        const { profileId } = await newAccount()
        const [first, second] = [newCode(), newCode()]
        const id = crypto.randomUUID()
        await repository.append(versionHolding(profileId, id, BASE, [first, second]))
        await retireCode(first, 8)
        await retireCode(second, 9)

        expect(mine(await repository.retiredCodeVersions(1000), profileId).map((row) => row.id)).toEqual([id])
      })

      it('does not return a version that a newer ready version has replaced, even though it holds a retired code', async () => {
        const { repository, newAccount, retireCode } = await make()
        const { profileId } = await newAccount()
        const code = newCode()
        await repository.append(versionHolding(profileId, crypto.randomUUID(), BASE, [code]))
        await repository.append(versionHolding(profileId, crypto.randomUUID(), at(HOUR), [newCode()], { catalogVersion: 9 }))
        await retireCode(code, 8)

        expect(mine(await repository.retiredCodeVersions(1000), profileId)).toEqual([])
      })

      it('returns only the newest version when both hold the retired code', async () => {
        const { repository, newAccount, retireCode } = await make()
        const { profileId } = await newAccount()
        const code = newCode()
        const newest = crypto.randomUUID()
        await repository.append(versionHolding(profileId, crypto.randomUUID(), BASE, [code]))
        await repository.append(versionHolding(profileId, newest, at(HOUR), [code]))
        await retireCode(code, 8)

        expect(mine(await repository.retiredCodeVersions(1000), profileId).map((row) => row.id)).toEqual([newest])
      })

      it('returns the versions in the order of their ids, whichever order they were stored in, so a run that stops at the limit leaves the same rest each day', async () => {
        const { repository, newAccount, retireCode } = await make()
        const code = newCode()
        const accounts = [await newAccount(), await newAccount(), await newAccount()]
        const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()].sort()
        // Stored last-id first, and on the accounts in the opposite order again, so neither insertion order nor profile order is the id order.
        for (const [i, id] of [ids[2]!, ids[0]!, ids[1]!].entries()) await repository.append(versionHolding(accounts[i]!.profileId, id, BASE, [code]))
        await retireCode(code, 8)

        const returned = mine(await repository.retiredCodeVersions(1000), ...accounts.map((a) => a.profileId)).map((row) => row.id)

        expect(returned).toEqual(ids)
      })

      it('returns at most the limit', async () => {
        const { repository, newAccount, retireCode } = await make()
        const code = newCode()
        const accounts = [await newAccount(), await newAccount(), await newAccount()]
        for (const { profileId } of accounts) await repository.append(versionHolding(profileId, crypto.randomUUID(), BASE, [code]))
        await retireCode(code, 8)

        expect(await repository.retiredCodeVersions(2)).toHaveLength(2)
        expect(mine(await repository.retiredCodeVersions(1000), ...accounts.map((a) => a.profileId))).toHaveLength(3)
      })
    })
  })
}
