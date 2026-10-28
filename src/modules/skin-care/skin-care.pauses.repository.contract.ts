import { describe, expect, it } from 'vitest'
import type { StepPausesRepository } from './skin-care.pauses.repository'
import type { NewStepPause, StepPause } from './skin-care.types'

// The one clock every fixture hangs off; later times are offsets from it. Days are calendar dates 'YYYY-MM-DD' anchored to the same day.
const BASE = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE
const at = (offsetMs: number) => new Date(BASE.getTime() + offsetMs)
const dayAt = (offsetDays: number) => at(offsetDays * DAY).toISOString().slice(0, 10)

type Account = { userId: string; profileId: string }

/**
 * What a step-pauses contract run needs: the repository, and a way to get an account that really exists, the way every account does in life (D1 enforces
 * step_pauses.profile_id -> profiles).
 *
 * THE CONTRACT THIS FILE PINS (assumed: the brief names the table and every column, not the methods; they follow skin-care.repository.ts):
 *   src/modules/skin-care/skin-care.types.ts
 *     StepPause = {
 *       id, profileId,
 *       step: RoutineStep | null,                 null for the "nothing to pause" row, which has no step
 *       productKey: string,                       the catalog product id when there is one, else the shelf entry id; the stepless row has none and stores ''
 *       productId: string | null,                 the catalog product id; null for a no-label own product and for the stepless row
 *       productRef: SkinCareProductRef,           json: { kind: 'shelf', id } | { kind: 'candidate', code } | { kind: 'none' }
 *       ingredientGroup: IngredientGroup | null,  the group frozen when the pause was made (null for a step with no active group)
 *       state: 'paused' | 'bringing-back' | 'ended' | 'replaced' | 'undone',
 *       pausedOn: string, checkDay: string,       calendar dates 'YYYY-MM-DD', stored as given
 *       sameCount: number,                        the "about the same" answers in a row
 *       sourceLogId: string | null,               the skin log that caused the pause; plain text, NOT a foreign key (a pause outlives nothing, but a contract run holds no logs)
 *       ladderCode: string | null, ladderStartedOn: string | null,   filled by the check-in PR (5); stored as given
 *       versionId: string | null,                 the routine version the pause was last reconciled against
 *       createdAt: Date
 *     }
 *     NewStepPause = StepPause   (the caller makes the id and the time; every column is given)
 *   Open states are 'paused' and 'bringing-back'. Closed: 'ended', 'replaced', 'undone'.
 *   insert(pause: NewStepPause): Promise<StepPause>
 *       Stores the row as given and answers it whole. Rejects an id already held (the first row stays), a profile that does not exist (D1), and a SECOND OPEN row for the same
 *       (profileId, step, productKey): a partial unique index over the open states. A closed row does not hold the key, so a pause may be made again once the first is closed.
 *       A profile also has at most ONE open stepless ("nothing to pause") row (owner decision, #233; every stepless row stores product_key ''): a second open insert with no
 *       step rejects. In D1 that is a second partial unique index, over (profile) where the step is null and the state is open. (An index over COALESCE(step, '') would do the same,
 *       but drizzle-kit cannot write an index expression that holds a comma.) The service reuses the open row instead of adding another. The fake mirrors both indexes.
 *   find(profileId, id): Promise<StepPause | null>      the row in any state, or null for another profile's row and for an id nobody holds
 *   openFor(profileId): Promise<StepPause[]>            the profile's rows in an open state, oldest createdAt first (ties by id), whole; [] when none
 *   update(profileId, id, patch): Promise<boolean>      patch: Partial<Pick<StepPause, 'state' | 'checkDay' | 'sameCount' | 'ladderCode' | 'ladderStartedOn' | 'versionId'>>.
 *       Sets exactly the fields given on that profile's row and resolves true. Another profile's row, or an id nobody holds, changes nothing and resolves false.
 *       Nothing else on the row changes, and no other row is touched. An empty patch resolves true for a row that exists and changes nothing.
 */
export type StepPausesContractSetup = {
  repository: StepPausesRepository
  newAccount: () => Promise<Account>
}

// Every test shares one database in the D1 tier, and an id is a primary key, so a test's ids carry its profile's id: `labelled(profileId, 'target')` is 'target:<profile id>'.
const idOf = (profileId: string, label: string) => `${label}:${profileId}`
const labelsOf = (rows: { id: string }[]) => rows.map((row) => row.id.split(':')[0])

const pauseFor = (profileId: string, over: Partial<NewStepPause> = {}): NewStepPause => ({
  id: crypto.randomUUID(),
  profileId,
  step: 'treat',
  productKey: `prod-${profileId}`,
  productId: `prod-${profileId}`,
  productRef: { kind: 'shelf', id: `entry-${profileId}` },
  ingredientGroup: null,
  state: 'paused',
  pausedOn: dayAt(0),
  checkDay: dayAt(3),
  sameCount: 0,
  sourceLogId: null,
  ladderCode: null,
  ladderStartedOn: null,
  versionId: null,
  createdAt: at(MINUTE),
  ...over,
})
const labelled = (profileId: string, label: string, over: Partial<NewStepPause> = {}): NewStepPause => pauseFor(profileId, { ...over, id: idOf(profileId, label) })

const CLOSED = ['ended', 'replaced', 'undone'] as const
const OPEN = ['paused', 'bringing-back'] as const

/** Behaviour every StepPausesRepository must have. Runs against the fake (unit tier) and real local D1 (integration tier). */
export const stepPausesRepositoryContract = (name: string, make: () => StepPausesContractSetup | Promise<StepPausesContractSetup>) => {
  describe(`StepPausesRepository contract: ${name}`, () => {
    it('stores a pause whole, every column, and reads it back the same through find and openFor', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()
      const pause = pauseFor(profileId, {
        step: 'moisturise',
        productKey: 'prod-77',
        productId: 'prod-77',
        productRef: { kind: 'candidate', code: 'MOIST-77' },
        ingredientGroup: 'retinoid',
        state: 'bringing-back',
        pausedOn: dayAt(-4),
        checkDay: dayAt(-1),
        sameCount: 2,
        sourceLogId: `log-${profileId}`,
        ladderCode: 'default',
        ladderStartedOn: dayAt(-1),
        versionId: `version-${profileId}`,
        createdAt: at(5 * MINUTE),
      })

      const stored = await repository.insert(pause)

      expect(stored).toEqual(pause)
      expect(await repository.find(profileId, pause.id)).toEqual(pause)
      expect(await repository.openFor(profileId)).toEqual([pause])
    })

    it('keeps the nullable columns null: a stepless pause, a no-label product, no group, no ladder, no source and no version', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()
      const stepless = pauseFor(profileId, { step: null, productKey: '', productId: null, productRef: { kind: 'none' }, ingredientGroup: null })
      const noLabel = pauseFor(profileId, { step: 'cleanse', productKey: `entry-${profileId}`, productId: null, productRef: { kind: 'shelf', id: `entry-${profileId}` }, createdAt: at(2 * MINUTE) })

      await repository.insert(stepless)
      await repository.insert(noLabel)

      expect(await repository.find(profileId, stepless.id)).toMatchObject({ step: null, productKey: '', productId: null, productRef: { kind: 'none' }, ingredientGroup: null, sourceLogId: null, ladderCode: null, ladderStartedOn: null, versionId: null })
      expect(await repository.find(profileId, noLabel.id)).toMatchObject({ step: 'cleanse', productKey: `entry-${profileId}`, productId: null })
    })

    it('stores each kind of product reference as given', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()
      const refs = [{ kind: 'shelf', id: 'entry-1' }, { kind: 'candidate', code: 'SERUM-1' }, { kind: 'none' }] as const
      const steps = ['cleanse', 'treat', 'moisturise'] as const

      for (const [index, ref] of refs.entries()) await repository.insert(labelled(profileId, `ref${index}`, { step: steps[index]!, productKey: `key-${index}`, productRef: ref, createdAt: at((index + 1) * MINUTE) }))

      expect((await repository.openFor(profileId)).map((row) => row.productRef)).toEqual([...refs])
    })

    it('refuses a second pause with an id already held, and leaves the first as it was', async () => {
      const { repository, newAccount } = await make()
      const { profileId } = await newAccount()
      await repository.insert(labelled(profileId, 'same', { step: 'cleanse', productKey: 'one' }))

      await expect(repository.insert(labelled(profileId, 'same', { step: 'treat', productKey: 'two', createdAt: at(2 * MINUTE) }))).rejects.toThrow()

      expect(await repository.openFor(profileId)).toMatchObject([{ step: 'cleanse', productKey: 'one' }])
    })

    describe('one open pause for a step and product', () => {
      it.each(OPEN)('refuses a second open pause for the same step and product while the first is %s, and leaves the first alone', async (state) => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.insert(labelled(profileId, 'first', { state }))

        await expect(repository.insert(labelled(profileId, 'second', { state: 'paused', createdAt: at(2 * MINUTE) }))).rejects.toThrow()

        expect(labelsOf(await repository.openFor(profileId))).toEqual(['first'])
        expect(await repository.find(profileId, idOf(profileId, 'second'))).toBeNull()
      })

      it.each(CLOSED)('allows a new open pause for the same step and product once the first is %s', async (state) => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.insert(labelled(profileId, 'first', { state }))

        await repository.insert(labelled(profileId, 'second', { createdAt: at(2 * MINUTE) }))

        expect(labelsOf(await repository.openFor(profileId))).toEqual(['second'])
        expect(await repository.find(profileId, idOf(profileId, 'first'))).toMatchObject({ state })
      })

      it('allows a closed pause beside an open one for the same step and product, and several closed ones', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.insert(labelled(profileId, 'open'))
        await repository.insert(labelled(profileId, 'undone', { state: 'undone', createdAt: at(2 * MINUTE) }))
        await repository.insert(labelled(profileId, 'replaced', { state: 'replaced', createdAt: at(3 * MINUTE) }))

        expect(labelsOf(await repository.openFor(profileId))).toEqual(['open'])
      })

      it('allows an open pause once the first is closed by update, and refuses it before', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.insert(labelled(profileId, 'first'))
        await expect(repository.insert(labelled(profileId, 'second', { createdAt: at(2 * MINUTE) }))).rejects.toThrow()

        await repository.update(profileId, idOf(profileId, 'first'), { state: 'undone' })
        await repository.insert(labelled(profileId, 'second', { createdAt: at(2 * MINUTE) }))

        expect(labelsOf(await repository.openFor(profileId))).toEqual(['second'])
      })

      it('allows the same product on a different step, and a different product on the same step, both open', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.insert(labelled(profileId, 'treat-a', { step: 'treat', productKey: 'a' }))
        await repository.insert(labelled(profileId, 'cleanse-a', { step: 'cleanse', productKey: 'a', createdAt: at(2 * MINUTE) }))
        await repository.insert(labelled(profileId, 'treat-b', { step: 'treat', productKey: 'b', createdAt: at(3 * MINUTE) }))

        expect(labelsOf(await repository.openFor(profileId))).toEqual(['treat-a', 'cleanse-a', 'treat-b'])
      })

      it('allows another profile to pause the same step and product', async () => {
        const { repository, newAccount } = await make()
        const mine = (await newAccount()).profileId
        const other = (await newAccount()).profileId
        await repository.insert(labelled(mine, 'mine', { productKey: 'shared' }))

        await repository.insert(labelled(other, 'other', { productKey: 'shared' }))

        expect(labelsOf(await repository.openFor(other))).toEqual(['other'])
      })

      const stepless = (profileId: string, label: string, over: Partial<NewStepPause> = {}) =>
        labelled(profileId, label, { step: null, productKey: '', productId: null, productRef: { kind: 'none' }, ...over })

      it.each(OPEN)('refuses a second open stepless pause for the profile while the first is %s: one open "nothing to pause" check-in each', async (state) => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.insert(stepless(profileId, 'first', { state }))

        await expect(repository.insert(stepless(profileId, 'second', { createdAt: at(2 * MINUTE) }))).rejects.toThrow()

        expect(labelsOf(await repository.openFor(profileId))).toEqual(['first'])
      })

      it.each(CLOSED)('allows a new open stepless pause once the first is %s', async (state) => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.insert(stepless(profileId, 'first', { state }))

        await repository.insert(stepless(profileId, 'second', { createdAt: at(2 * MINUTE) }))

        expect(labelsOf(await repository.openFor(profileId))).toEqual(['second'])
      })

      it('allows an open stepless pause beside open pauses that have a step, and another profile\'s own', async () => {
        const { repository, newAccount } = await make()
        const mine = (await newAccount()).profileId
        const other = (await newAccount()).profileId
        await repository.insert(labelled(mine, 'treat', { step: 'treat', productKey: 't' }))
        await repository.insert(stepless(mine, 'nothing', { createdAt: at(2 * MINUTE) }))
        await repository.insert(stepless(other, 'theirs'))

        expect(labelsOf(await repository.openFor(mine))).toEqual(['treat', 'nothing'])
        expect(labelsOf(await repository.openFor(other))).toEqual(['theirs'])
      })

      it('allows the stepless pause to be closed and a new one opened, in turn, any number of times', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.insert(stepless(profileId, 'one'))
        await repository.update(profileId, idOf(profileId, 'one'), { state: 'ended' })
        await repository.insert(stepless(profileId, 'two', { createdAt: at(2 * MINUTE) }))
        await repository.update(profileId, idOf(profileId, 'two'), { state: 'undone' })

        await repository.insert(stepless(profileId, 'three', { createdAt: at(3 * MINUTE) }))

        expect(labelsOf(await repository.openFor(profileId))).toEqual(['three'])
      })
    })

    describe('openFor', () => {
      it('answers only the open pauses, paused and bringing-back, oldest first, by when they were made', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.insert(labelled(profileId, 'late', { step: 'moisturise', productKey: 'm', createdAt: at(3 * MINUTE) }))
        await repository.insert(labelled(profileId, 'early', { step: 'cleanse', productKey: 'c', state: 'bringing-back', createdAt: at(MINUTE) }))
        await repository.insert(labelled(profileId, 'middle', { step: 'treat', productKey: 't', createdAt: at(2 * MINUTE) }))
        for (const [index, state] of CLOSED.entries()) await repository.insert(labelled(profileId, `closed-${state}`, { state, step: 'protect', productKey: `p${index}`, createdAt: at((10 + index) * MINUTE) }))

        expect(labelsOf(await repository.openFor(profileId))).toEqual(['early', 'middle', 'late'])
      })

      it('orders pauses made at one instant by id, so the order is the same on every call', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        await repository.insert(labelled(profileId, 'b', { step: 'treat', productKey: 'b' }))
        await repository.insert(labelled(profileId, 'a', { step: 'cleanse', productKey: 'a' }))
        await repository.insert(labelled(profileId, 'c', { step: 'moisturise', productKey: 'c' }))

        expect(labelsOf(await repository.openFor(profileId))).toEqual(['a', 'b', 'c'])
        expect(labelsOf(await repository.openFor(profileId))).toEqual(['a', 'b', 'c'])
      })

      it('answers nothing for a profile that never paused, and never another profile\'s pauses', async () => {
        const { repository, newAccount } = await make()
        const mine = (await newAccount()).profileId
        const other = (await newAccount()).profileId
        await repository.insert(labelled(other, 'other'))

        expect(await repository.openFor(mine)).toEqual([])
        expect(labelsOf(await repository.openFor(other))).toEqual(['other'])
      })
    })

    describe('find', () => {
      it('finds a pause in any state, closed ones included', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        for (const [index, state] of [...OPEN, ...CLOSED].entries()) await repository.insert(labelled(profileId, state, { state, step: 'treat', productKey: `k${index}`, createdAt: at((index + 1) * MINUTE) }))

        for (const state of [...OPEN, ...CLOSED]) expect(await repository.find(profileId, idOf(profileId, state))).toMatchObject({ state })
      })

      it('answers null for another profile\'s pause and for an id nobody holds', async () => {
        const { repository, newAccount } = await make()
        const owner = (await newAccount()).profileId
        const stranger = (await newAccount()).profileId
        const theirs = pauseFor(owner)
        await repository.insert(theirs)

        expect(await repository.find(stranger, theirs.id)).toBeNull()
        expect(await repository.find(owner, crypto.randomUUID())).toBeNull()
      })
    })

    describe('update', () => {
      it('sets the fields given and nothing else on the row, and touches no other row', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const target = labelled(profileId, 'target', { ingredientGroup: 'retinoid', sourceLogId: 'log-1', versionId: 'v1', createdAt: at(MINUTE) })
        const neighbour = labelled(profileId, 'neighbour', { step: 'cleanse', productKey: 'c', createdAt: at(2 * MINUTE) })
        await repository.insert(target)
        await repository.insert(neighbour)

        const changed = await repository.update(profileId, target.id, { checkDay: dayAt(6), sameCount: 1, ladderCode: 'default', ladderStartedOn: dayAt(6), versionId: 'v2', state: 'bringing-back' })

        expect(changed).toBe(true)
        expect(await repository.find(profileId, target.id)).toEqual({ ...target, checkDay: dayAt(6), sameCount: 1, ladderCode: 'default', ladderStartedOn: dayAt(6), versionId: 'v2', state: 'bringing-back' })
        expect(await repository.find(profileId, neighbour.id)).toEqual(neighbour)
      })

      it('moves only the check day when only the check day is given', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const target = pauseFor(profileId)
        await repository.insert(target)

        await repository.update(profileId, target.id, { checkDay: dayAt(9) })

        expect(await repository.find(profileId, target.id)).toEqual({ ...target, checkDay: dayAt(9) })
      })

      it('changes the state of a pause, and a closed pause leaves openFor', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const target = pauseFor(profileId)
        await repository.insert(target)

        await repository.update(profileId, target.id, { state: 'undone' })

        expect(await repository.find(profileId, target.id)).toMatchObject({ state: 'undone' })
        expect(await repository.openFor(profileId)).toEqual([])
      })

      it('resolves true for an empty patch on a pause that exists, and changes nothing', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const target = pauseFor(profileId)
        await repository.insert(target)

        expect(await repository.update(profileId, target.id, {})).toBe(true)

        expect(await repository.find(profileId, target.id)).toEqual(target)
      })

      it('changes nothing for another profile\'s pause, and says so', async () => {
        const { repository, newAccount } = await make()
        const owner = (await newAccount()).profileId
        const stranger = (await newAccount()).profileId
        const theirs = pauseFor(owner)
        await repository.insert(theirs)

        expect(await repository.update(stranger, theirs.id, { state: 'undone', checkDay: dayAt(30) })).toBe(false)

        expect(await repository.find(owner, theirs.id)).toEqual(theirs)
      })

      // Added in PR 4b: a compare-and-set, so a pause another request has closed is not written over.
      it('with onlyIfState writes only while the pause is in that state, and says so', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const target = pauseFor(profileId)
        await repository.insert(target)

        expect(await repository.update(profileId, target.id, { state: 'undone' }, 'bringing-back')).toBe(false)
        expect(await repository.find(profileId, target.id)).toEqual(target)
        expect(await repository.update(profileId, target.id, { state: 'undone' }, 'paused')).toBe(true)
        expect(await repository.update(profileId, target.id, { state: 'ended' }, 'paused')).toBe(false)
        expect(await repository.find(profileId, target.id)).toMatchObject({ state: 'undone' })
      })

      it('with onlyIfState and an empty patch resolves true only while the pause is in that state', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const target = pauseFor(profileId)
        await repository.insert(target)

        expect(await repository.update(profileId, target.id, {}, 'paused')).toBe(true)
        expect(await repository.update(profileId, target.id, {}, 'ended')).toBe(false)
      })

      it('changes nothing for an id nobody holds, and says so', async () => {
        const { repository, newAccount } = await make()
        const { profileId } = await newAccount()
        const held = pauseFor(profileId)
        await repository.insert(held)

        expect(await repository.update(profileId, crypto.randomUUID(), { state: 'undone' })).toBe(false)

        expect(await repository.find(profileId, held.id)).toEqual(held)
      })
    })
  })
}
