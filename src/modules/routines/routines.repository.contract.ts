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

//   complete(id, built)            fills that one pending row with the finished build (steps, tapers, expectation, model, promptHash, catalogVersion,
//                                  routineFingerprint, source, hintsShown, writerRetryDueAt, writerCalls, cautions, goal, readyAt) and makes it 'ready', resolving to true. It does so
//                                  once: an unknown id, or a row that is already ready, resolves to false and changes nothing.
//   latest(profileId)              the row with the newest createdAt, whatever its status, or null.
//   current(profileId)             the `ready` row that became ready last (readyAt, then the larger id; a row with no readyAt counts from its createdAt),
//                                  or null: a build that was created first but finished last is the current one.
//   clearWriterRetry(id)           sets writerRetryDueAt to null on that one row, changing nothing else of it; a row nobody has is ignored. Resolves to undefined.
//   markServed(id, at)             sets servedAt on that one row, replacing an earlier value; a row nobody has is ignored. Resolves to undefined.
//   markStarted(profileId, on)     sets startedOn to `on` on every row of that profile whose startedOn is null, a pending row included, and on no other row:
//                                  an earlier start is never moved, so calling it again is a no-op. Resolves to undefined; a profile with no rows is ignored.
//                                  It also stamps `on` as the startedOn of each step-down of those rows whose startedOn is null (one already dated keeps
//                                  its date): that is how Start puts the date on a step-down of the routine in force. Otherwise a ready row is changed by
//                                  nothing but servedAt and startedOn (the other markStarted tests use rows with no step-downs, to keep that apart).
//   lastServedBefore(profileId, excludeId)   the profile's newest `ready` row (in the order `current` uses) whose servedAt is not null and whose id is not `excludeId`, or null.
//                                  Pending rows never count, even when marked served. It is "every served version but this one", not "older than this one".
//   writerBuildsSince(profileId, since)   how many of that profile's rows have writerCalls > 0 and createdAt >= since, whatever their source, status or reason.
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
}

// A stored step is a routine entry plus `gotIt` and `fixedFrom`. One of each product kind, so a JSON column cannot quietly drop a variant: a shelf
// product the version carried over unchanged, a candidate the user has got, and "use what you have".
const stepsOf = (): Appended['steps'] => [
  { step: 'cleanse', product: { kind: 'shelf', id: 'entry-1' }, frequency: 'am-pm', reason: 'You already use this and it suits your goal.', grounding: [], gotIt: false, fixedFrom: 'version-0' },
  {
    step: 'treat',
    product: { kind: 'candidate', code: 'SERUM-1' },
    frequency: 'pm',
    reason: 'Niacinamide works on dark marks.',
    grounding: ['https://example.org/evidence/serum-1', 'https://example.org/ingredients/serum-1'],
    gotIt: true,
    fixedFrom: null,
  },
  { step: 'moisturise', product: { kind: 'none' }, frequency: 'am', reason: 'Use what you have for now.', grounding: [], gotIt: false, fixedFrom: null },
  { step: 'protect', product: { kind: 'shelf', id: 'entry-2' }, frequency: 'am', reason: 'Sunscreen keeps dark marks from coming back.', grounding: ['https://example.org/evidence/spf'], gotIt: false, fixedFrom: 'version-0' },
]

// One step-down under way (a start date, to the millisecond) and one not started (null): a JSON column must give both back as they were.
const tapersOf = (): Appended['tapers'] => [
  { shelfProductId: 'entry-3', templateId: 'TPR-STEROID-1', startedOn: new Date(BASE.getTime() - DAY + 456) },
  { shelfProductId: 'entry-4', templateId: 'TPR-LIGHTENING-1', startedOn: null },
]

const cautionsOf = (): CautionState[] => ['tapering', 'recent-reaction']

const GOAL: Goal = 'fade-dark-marks'

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
  })
}
