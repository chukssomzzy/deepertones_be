import { describe, expect, it } from 'vitest'
import type { SavedVerdictProduct } from './verdicts.types'
import type { VerdictsRepository } from './verdicts.repository'

// The saved shelf verdict (spec #171, D2a): ONE row per profile, claimed by an atomic upsert (`requestBuild`), filled by an UPDATE-only `save`, and
// carrying the state of the fit judge's retries. Behaviour every VerdictsRepository must have; it runs against the fake (unit tier) and real local D1
// (integration tier). Times are Dates (the table stores milliseconds, as the safety table does).
//
// Assumed shapes (what this file pins):
//   find(profileId)                     row | null. A row has: profileId, status, fingerprint, requestedAt, fit, products, builtAt, rulesVersion,
//                                       catalogVersion, model, promptHash, inputs, fitAttempts, fitRetried, fitRetryDueAt.
//   requestBuild(profileId, fp, now, staleBefore)   boolean. A new row is pending with products [], fit null and every build column null.
//   save(profileId, built)              UPDATE only; `built` has every column after the first four above (fingerprint included) plus the fit columns.
//   setFitState(profileId, state)       { fitAttempts, fitRetried, fitRetryDueAt }, nothing else of the row changes.
//   fitDue(now, limit)                  rows whose fitRetryDueAt <= now, longest overdue first (ties by profileId), at most `limit`.

const BASE = new Date('2030-06-15T12:00:00.000Z')
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const at = (offsetMs: number) => new Date(BASE.getTime() + offsetMs)

type Row = NonNullable<Awaited<ReturnType<VerdictsRepository['find']>>>
type Built = Parameters<VerdictsRepository['save']>[1]
type FitState = Parameters<VerdictsRepository['setFitState']>[1]


export type VerdictsContractSetup = {
  repository: VerdictsRepository
  /** A user with its default profile, made the way the product makes one (D1 enforces shelf_verdicts.profile_id -> profiles). */
  newAccount: () => Promise<{ userId: string; profileId: string }>
}

const FP_1 = 'fingerprint-1'
const FP_2 = 'fingerprint-2'

// One of each verdict the routine reads, so a JSON column cannot quietly drop a variant, with a step and sources on some and none on others.
const productsOf = (): SavedVerdictProduct[] => [
  { entryId: 'entry-1', group: 'helping', verdict: { kind: 'keep' }, escalate: false, reason: 'Niacinamide works on dark marks.', facts: [], step: 'treat', sourceUrls: [] },
  {
    entryId: 'entry-2',
    group: 'conflicting',
    verdict: { kind: 'reduce', maxFrequency: 'alternate-days' },
    escalate: false,
    reason: 'Clashes with the acid on your shelf.',
    facts: [],
    step: 'treat',
    sourceUrls: ['https://example.org/rules/retinol'],
  },
  {
    entryId: 'entry-3',
    group: 'likely-the-problem',
    verdict: { kind: 'stop', taperTemplateId: 'TPR-STEROID-1' },
    escalate: false,
    reason: 'Holds a steroid, which is stopped step by step.',
    facts: [{ kind: 'ingredient-group', group: 'steroid', ingredient: 'Clobetasol Propionate', ruleName: 'clobetasol propionate' }],
    step: null,
    sourceUrls: ['https://example.org/rules/clobetasol', 'https://example.org/rules/steroids'],
  },
  {
    entryId: 'entry-4',
    group: 'cant-tell',
    verdict: { kind: 'drop' },
    escalate: false,
    reason: 'We cannot tell what is in it.',
    facts: [{ kind: 'unknown-contents' }],
    nudge: 'photograph-back-label',
    step: null,
    sourceUrls: [],
  },
  { entryId: 'entry-5', group: 'redundant', verdict: { kind: 'drop' }, escalate: false, reason: 'Does the same job as entry 1.', facts: [], sameJobAs: 'entry-1', step: 'moisturise', sourceUrls: [] },
]

// The provenance: what the build read. Ids and codes only, never the words the user typed.
const inputsOf = (): Built['inputs'] => ({
  goal: 'fade-dark-marks',
  entries: [
    { id: 'entry-1', formulationId: 'form-1' },
    { id: 'entry-4', noLabelPurpose: 'lighten' },
  ],
  scan: { skinType: 'combination', concerns: [{ concern: 'hd_age_spot', band: 'some' }] },
  safety: { choices: ['reaction'], parseState: 'done' },
  taperCodes: ['TPR-STEROID-1'],
})

const builtOf = (over: Partial<Built> = {}): Built => ({
  fingerprint: FP_1,
  products: productsOf(),
  fit: 'ready',
  builtAt: at(5 * MINUTE),
  rulesVersion: 'rules-0123456789abcdef',
  catalogVersion: 7,
  model: 'claude-sonnet-5-5',
  promptHash: 'prompt-hash-1',
  inputs: inputsOf(),
  fitAttempts: 1,
  fitRetried: false,
  fitRetryDueAt: null,
  ...over,
})

const found = async (repository: VerdictsRepository, profileId: string): Promise<Row> => {
  const row = await repository.find(profileId)
  if (!row) throw new Error('expected a verdict row')
  return row
}

/** A row that has been requested at `requestedAt` and built, the way the product gets one. */
const readyRow = async (repository: VerdictsRepository, profileId: string, over: Partial<Built> = {}, requestedAt = BASE) => {
  expect(await repository.requestBuild(profileId, over.fingerprint ?? FP_1, requestedAt, at(-HOUR))).toBe(true)
  await repository.save(profileId, builtOf(over))
}

export const verdictsRepositoryContract = (name: string, make: () => VerdictsContractSetup | Promise<VerdictsContractSetup>) => {
  describe(`VerdictsRepository contract: ${name}`, () => {
    describe('find', () => {
      it('has no row for a profile that never asked for a verdict', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()

        expect(await repository.find(profileId)).toBeNull()
      })
    })

    describe('requestBuild on a profile with no row', () => {
      it('creates a pending row with nothing built yet, and answers true', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()

        expect(await repository.requestBuild(profileId, FP_1, BASE, at(-HOUR))).toBe(true)

        expect(await found(repository, profileId)).toEqual({
          profileId,
          status: 'pending',
          fingerprint: FP_1,
          requestedAt: BASE,
          fit: null,
          products: [],
          builtAt: null,
          rulesVersion: null,
          catalogVersion: null,
          model: null,
          promptHash: null,
          inputs: null,
          fitAttempts: 0,
          fitRetried: false,
          fitRetryDueAt: null,
        })
      })

      it('lets exactly one of two parallel requests win', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()

        const answers = await Promise.all([repository.requestBuild(profileId, FP_1, BASE, at(-HOUR)), repository.requestBuild(profileId, FP_1, BASE, at(-HOUR))])

        expect(answers.filter(Boolean)).toHaveLength(1)
      })
    })

    describe('requestBuild on a ready row', () => {
      it('answers false and changes nothing when the fingerprint is the same, however long ago it was built', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await readyRow(repository, profileId)
        const before = await found(repository, profileId)

        expect(await repository.requestBuild(profileId, FP_1, at(10 * HOUR), at(9 * HOUR))).toBe(false)

        expect(await found(repository, profileId)).toEqual(before)
      })

      it('answers true when the fingerprint differs, rewriting the row to pending with the new fingerprint and time and the fit retries reset', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await readyRow(repository, profileId, { fit: 'not-ready', fitAttempts: 3, fitRetried: true, fitRetryDueAt: at(HOUR) })

        expect(await repository.requestBuild(profileId, FP_2, at(2 * HOUR), at(HOUR))).toBe(true)

        expect(await found(repository, profileId)).toMatchObject({
          status: 'pending',
          fingerprint: FP_2,
          requestedAt: at(2 * HOUR),
          fitAttempts: 0,
          fitRetried: false,
          fitRetryDueAt: null,
        })
      })

      it('keeps the previous products and fit while the rebuild is pending, so the last verdict can still be shown', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await readyRow(repository, profileId)

        await repository.requestBuild(profileId, FP_2, at(HOUR), at(-HOUR))

        const row = await found(repository, profileId)
        expect(row.products).toEqual(productsOf())
        expect(row.fit).toBe('ready')
        expect(row.builtAt).toEqual(at(5 * MINUTE))
      })

      it('lets exactly one of two parallel requests with a new fingerprint win', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await readyRow(repository, profileId)

        const answers = await Promise.all([repository.requestBuild(profileId, FP_2, at(HOUR), at(-HOUR)), repository.requestBuild(profileId, FP_2, at(HOUR), at(-HOUR))])

        expect(answers.filter(Boolean)).toHaveLength(1)
      })
    })

    describe('requestBuild on a pending row', () => {
      it('answers false and changes nothing while the request is newer than staleBefore, even with a different fingerprint', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.requestBuild(profileId, FP_1, BASE, at(-HOUR))
        const before = await found(repository, profileId)

        // staleBefore is one millisecond before the request: the request is not stale.
        expect(await repository.requestBuild(profileId, FP_2, at(HOUR), at(-1))).toBe(false)

        expect(await found(repository, profileId)).toEqual(before)
      })

      it('takes the request over when it was made exactly at staleBefore', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.requestBuild(profileId, FP_1, BASE, at(-HOUR))

        expect(await repository.requestBuild(profileId, FP_2, at(HOUR), BASE)).toBe(true)

        expect(await found(repository, profileId)).toMatchObject({ status: 'pending', fingerprint: FP_2, requestedAt: at(HOUR) })
      })

      it('takes the request over when it was made before staleBefore, even with the same fingerprint', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.requestBuild(profileId, FP_1, BASE, at(-HOUR))

        expect(await repository.requestBuild(profileId, FP_1, at(HOUR), at(1))).toBe(true)

        expect(await found(repository, profileId)).toMatchObject({ status: 'pending', fingerprint: FP_1, requestedAt: at(HOUR) })
      })

      it('resets the fit retries when it takes a stale request over', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.requestBuild(profileId, FP_1, BASE, at(-HOUR))
        await repository.setFitState(profileId, { fitAttempts: 2, fitRetried: true, fitRetryDueAt: at(HOUR) })

        await repository.requestBuild(profileId, FP_1, at(HOUR), at(MINUTE))

        expect(await found(repository, profileId)).toMatchObject({ fitAttempts: 0, fitRetried: false, fitRetryDueAt: null })
      })
    })

    describe('save', () => {
      it('turns the pending row ready and stores everything that was built', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.requestBuild(profileId, FP_1, BASE, at(-HOUR))

        await repository.save(profileId, builtOf())

        expect(await found(repository, profileId)).toEqual({
          profileId,
          status: 'ready',
          fingerprint: FP_1,
          requestedAt: BASE,
          fit: 'ready',
          products: productsOf(),
          builtAt: at(5 * MINUTE),
          rulesVersion: 'rules-0123456789abcdef',
          catalogVersion: 7,
          model: 'claude-sonnet-5-5',
          promptHash: 'prompt-hash-1',
          inputs: inputsOf(),
          fitAttempts: 1,
          fitRetried: false,
          fitRetryDueAt: null,
        })
      })

      it('gives products back with every verdict kind, the routine step (or null) and the rule sources intact', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.requestBuild(profileId, FP_1, BASE, at(-HOUR))

        await repository.save(profileId, builtOf())

        const { products } = await found(repository, profileId)
        expect(products.map((p) => p.verdict)).toEqual([
          { kind: 'keep' },
          { kind: 'reduce', maxFrequency: 'alternate-days' },
          { kind: 'stop', taperTemplateId: 'TPR-STEROID-1' },
          { kind: 'drop' },
          { kind: 'drop' },
        ])
        expect(products.map((p) => (p as SavedVerdictProduct).step)).toEqual(['treat', 'treat', null, null, 'moisturise'])
        expect(products.map((p) => (p as SavedVerdictProduct).sourceUrls)).toEqual([[], ['https://example.org/rules/retinol'], ['https://example.org/rules/clobetasol', 'https://example.org/rules/steroids'], [], []])
      })

      it('keeps the fingerprint it is given, which may differ from the one requested', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.requestBuild(profileId, FP_1, BASE, at(-HOUR))

        await repository.save(profileId, builtOf({ fingerprint: FP_2 }))

        expect(await found(repository, profileId)).toMatchObject({ status: 'ready', fingerprint: FP_2 })
      })

      it('stores a verdict whose fit is not ready, with the fit retries as given', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.requestBuild(profileId, FP_1, BASE, at(-HOUR))

        await repository.save(profileId, builtOf({ fit: 'not-ready', fitAttempts: 3, fitRetried: true, fitRetryDueAt: at(24 * HOUR) }))

        expect(await found(repository, profileId)).toMatchObject({ status: 'ready', fit: 'not-ready', fitAttempts: 3, fitRetried: true, fitRetryDueAt: at(24 * HOUR) })
      })

      it('replaces the previous build when a rebuild is saved', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await readyRow(repository, profileId)
        await repository.requestBuild(profileId, FP_2, at(HOUR), at(-HOUR))

        await repository.save(profileId, builtOf({ fingerprint: FP_2, products: productsOf().slice(0, 1), builtAt: at(HOUR + MINUTE), catalogVersion: 8 }))

        expect(await found(repository, profileId)).toMatchObject({ status: 'ready', fingerprint: FP_2, builtAt: at(HOUR + MINUTE), catalogVersion: 8 })
        expect((await found(repository, profileId)).products).toHaveLength(1)
      })

      it('writes nothing, and does not fail, for a profile with no row', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()

        await expect(repository.save(profileId, builtOf())).resolves.toBeUndefined()
        await expect(repository.save(crypto.randomUUID(), builtOf())).resolves.toBeUndefined()

        expect(await repository.find(profileId)).toBeNull()
      })
    })

    describe('setFitState', () => {
      it('sets the three fit retry columns and changes nothing else of the row', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await readyRow(repository, profileId, { fit: 'not-ready' })
        const before = await found(repository, profileId)
        const state: FitState = { fitAttempts: 3, fitRetried: true, fitRetryDueAt: at(24 * HOUR + 123) }

        await repository.setFitState(profileId, state)

        expect(await found(repository, profileId)).toEqual({ ...before, ...state })
      })

      it('can clear the due time', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await readyRow(repository, profileId, { fit: 'not-ready', fitRetryDueAt: at(HOUR) })

        await repository.setFitState(profileId, { fitAttempts: 0, fitRetried: false, fitRetryDueAt: null })

        expect((await found(repository, profileId)).fitRetryDueAt).toBeNull()
      })

      it('ignores a profile with no row', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()

        await expect(repository.setFitState(profileId, { fitAttempts: 1, fitRetried: false, fitRetryDueAt: at(HOUR) })).resolves.toBeUndefined()

        expect(await repository.find(profileId)).toBeNull()
      })
    })

    describe('fitDue', () => {
      const dueAt = async (repository: VerdictsRepository, profileId: string, due: Date | null) => {
        await readyRow(repository, profileId, { fit: 'not-ready' })
        await repository.setFitState(profileId, { fitAttempts: 3, fitRetried: false, fitRetryDueAt: due })
      }
      const idsOf = (rows: { profileId: string }[]) => rows.map((row) => row.profileId)

      it('returns the rows due at or before now, the longest overdue first, and leaves out later ones and those with no due time', async () => {
        const { repository, newAccount } = await make()
        // The D1 run shares one database across tests, so only this test's own profiles are looked at.
        const [overdue, justDue, notYet, never, oldest] = await Promise.all([newAccount(), newAccount(), newAccount(), newAccount(), newAccount()])
        await dueAt(repository, overdue.profileId, at(-HOUR))
        await dueAt(repository, justDue.profileId, at(0))
        await dueAt(repository, notYet.profileId, at(1))
        await dueAt(repository, never.profileId, null)
        await dueAt(repository, oldest.profileId, at(-3 * HOUR))
        const mine = new Set([overdue, justDue, notYet, never, oldest].map((account) => account.profileId))

        const due = (await repository.fitDue(BASE, 1000)).filter((row) => mine.has(row.profileId))

        expect(idsOf(due)).toEqual([oldest.profileId, overdue.profileId, justDue.profileId])
      })

      it('returns at most the limit, keeping the longest overdue', async () => {
        const { repository, newAccount } = await make()
        const accounts = await Promise.all([newAccount(), newAccount(), newAccount()])
        await dueAt(repository, accounts[0]!.profileId, at(-2 * HOUR))
        await dueAt(repository, accounts[1]!.profileId, at(-3 * HOUR))
        await dueAt(repository, accounts[2]!.profileId, at(-HOUR))
        const mine = new Set(accounts.map((account) => account.profileId))

        // Rows of other tests in a shared database may be due too, so ask for a window of the whole table and keep ours in order.
        const all = (await repository.fitDue(BASE, 100_000)).filter((row) => mine.has(row.profileId))
        expect(idsOf(all)).toEqual([accounts[1]!.profileId, accounts[0]!.profileId, accounts[2]!.profileId])

        const limited = await repository.fitDue(BASE, 2)
        expect(limited).toHaveLength(2)
        expect(idsOf(limited)).toEqual(idsOf(await repository.fitDue(BASE, 100_000)).slice(0, 2))
      })

      it('breaks a tie of due times by profile id, so the order is the same on every read', async () => {
        const { repository, newAccount } = await make()
        const accounts = await Promise.all([newAccount(), newAccount(), newAccount()])
        for (const { profileId } of accounts) await dueAt(repository, profileId, at(-7 * HOUR))
        const mine = new Set(accounts.map((account) => account.profileId))

        const due = (await repository.fitDue(BASE, 100_000)).filter((row) => mine.has(row.profileId))

        expect(idsOf(due)).toEqual(accounts.map((account) => account.profileId).sort())
      })

      it('gives no rows when nothing is due', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await dueAt(repository, profileId, at(HOUR))

        const mine = (await repository.fitDue(BASE, 100_000)).filter((row) => row.profileId === profileId)

        expect(mine).toEqual([])
      })
    })
  })
}
