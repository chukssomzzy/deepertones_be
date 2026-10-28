import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runAs } from '../../lib/context'
import type { Escalation, Response } from '../catalog/catalog.workbook.service'
import { FakeEscalationHoldsRepository } from './skin-care.holds.repository.fake'
import { FakeStepPausesRepository } from './skin-care.pauses.repository.fake'
import { FakeSkinCareRepository } from './skin-care.repository.fake'
import { SkinCareService } from './skin-care.service'
import type { NewStepPause, SkinCareRoutine, StepPause } from './skin-care.types'

// A valid log is always stored, and a pause that cannot be made never leaves a harm log with nothing (spec #233, PR 4b): a harm signal needs the open pauses and the routine, and
// when either cannot be read the log is stored and the answer is "nothing to pause", with the check-in that has no step if the pauses store can be written. The routine is read once for
// a harm signal and never for a red flag, advice or a good day. A pause whose product the routine no longer has is stale, and `stateFor` heals it.

const T0 = new Date('2030-06-15T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const AMARA = 'profile-amara'
const ACTOR = { kind: 'user', userId: 'user-amara', status: 'verified', profileId: AMARA } as const

const NOTHING: Response = { title: 'Nothing to pause yet', body: 'Keep {step} simple until it settles.', whatToDoNow: 'Keep sunscreen if it does not sting.' }
const PAUSED: Response = { title: 'We paused your {step}', body: 'A rest from your {step}.', whatToDoNow: null }
const ADVICE: Response = { title: 'Itchy skin', body: 'Common while your skin settles.', whatToDoNow: null }
const SWELLING: Escalation = { whoToSee: 'A doctor or pharmacist about swelling.', howSoon: 'Today.', whatToTellThem: 'Where it swelled.' }
const TWO_PAUSED: Escalation = { whoToSee: 'A doctor or pharmacist.', howSoon: 'Within a day.', whatToTellThem: 'Which steps are paused.' }

const routine = (): SkinCareRoutine => ({
  dayOne: '2030-06-10',
  steps: [
    { step: 'cleanse', title: 'Gentle Cleanser', productRef: { kind: 'shelf', id: 'entry-cleanse' }, productId: 'prod-cleanse', changedOn: '2030-06-10', activeGroups: [] },
    { step: 'treat', title: 'Retinol Serum', productRef: { kind: 'candidate', code: 'TREAT-1' }, productId: 'prod-treat', changedOn: '2030-06-12', activeGroups: ['retinoid'] },
    { step: 'moisturise', title: 'Plain Moisturiser', productRef: { kind: 'shelf', id: 'entry-moist' }, productId: 'prod-moist', changedOn: '2030-06-11', activeGroups: [] },
  ],
  stepDownRunning: false,
})

let repository: FakeSkinCareRepository
let pauses: FakeStepPausesRepository
let current: SkinCareRoutine
let now: Date
let routineReads: number
let stepDownCalls: { today: string; read: SkinCareRoutine | null | undefined }[]
let routineFails: boolean
let inboxFails: boolean
let errors: unknown[][]

const makeService = (store: FakeStepPausesRepository = pauses) =>
  new SkinCareService({
    repository,
    pauses: store,
    holds: new FakeEscalationHoldsRepository(),
    safety: { markReactionProduct: async () => ({ marked: false }) },
    verdicts: { savedFor: async () => null },
    catalog: { namedProduct: async () => Promise.reject(new Error('unused')) },
    workbook: {
      responseFor: async (outcome) => (outcome === 'paused' ? PAUSED : outcome === 'nothing-to-pause' ? NOTHING : outcome === 'advice-itching' ? ADVICE : null),
      escalationFor: async (reason) => (reason === 'swelling' ? SWELLING : reason === 'harm-while-two-paused' ? TWO_PAUSED : null),
      // PR 5: a replaced product is brought back on a ladder, so a reconcile reads one.
      reintroductionFor: async () => [
        { fromWeek: 1, toWeek: 1, frequency: 'weekly' },
        { fromWeek: 2, toWeek: 2, frequency: 'back' },
      ],
    },
    reminders: { zoneFor: async () => null },
    routine: {
      stepDownRunning: async (_profileId, today, read) => {
        stepDownCalls.push({ today, read })
        return read?.stepDownRunning ?? false
      },
      skinCareRoutineFor: async () => {
        routineReads++
        if (routineFails) throw new Error('routine read failed')
        return structuredClone(current)
      },
    },
    inbox: {
      write: async () => {
        if (inboxFails) throw new Error('inbox write failed')
        return { id: 'inbox-row', created: true }
      },
    },
    now: () => now,
  })

let service: SkinCareService
const log = (input: Parameters<SkinCareService['log']>[0]) => runAs(ACTOR, () => service.log(input))
const undo = (id: string) => runAs(ACTOR, () => service.undo(id))
const STING: Parameters<SkinCareService['log']>[0] = { noticing: ['stinging-or-burning'], howBad: 'mild' }

beforeEach(() => {
  repository = new FakeSkinCareRepository()
  pauses = new FakeStepPausesRepository()
  current = routine()
  now = T0
  routineReads = 0
  stepDownCalls = []
  routineFails = false
  inboxFails = false
  errors = []
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errors.push(args))
  service = makeService()
})
afterEach(() => vi.restoreAllMocks())

const NOTHING_RESULT = { outcome: { kind: 'nothing-to-pause' }, paused: null, response: { title: 'Nothing to pause yet', body: 'Keep your routine simple until it settles.', whatToDoNow: 'Keep sunscreen if it does not sting.' } }
const idsLine = (outcome: string) => [{ outcome, profileId: AMARA }]
const stepsOf = (rows: StepPause[]) => rows.map((row) => row.step)

describe('SkinCareService.log, when the routine cannot be read', () => {
  it('stores the log as nothing to pause, answers the reviewed text, opens the check-in with no step and logs ids only', async () => {
    routineFails = true

    const result = await log(STING)

    expect(result).toMatchObject(NOTHING_RESULT)
    expect(result.log.outcome).toBe('nothing-to-pause')
    expect((await repository.recent(AMARA, 10))[0]).toMatchObject({ id: result.log.id, outcome: 'nothing-to-pause', reason: null })
    expect(await pauses.openFor(AMARA)).toEqual([expect.objectContaining({ step: null, state: 'paused', checkDay: '2030-06-18', sourceLogId: result.log.id })])
    expect(errors).toEqual([[...idsLine('skin-care-routine-read-failed')]])
  })

  it('does the same for a hard-to-ignore symptom, which would otherwise be read against a step-down', async () => {
    routineFails = true

    expect(await log({ noticing: ['new-redness'], howBad: 'hard-to-ignore' })).toMatchObject(NOTHING_RESULT)
  })

  it('moves the one open check-in with no step to the new check day on a second failed read, and adds no row', async () => {
    routineFails = true
    await log(STING)
    const [first] = await pauses.openFor(AMARA)
    now = new Date(T0.getTime() + 2 * DAY)

    await log(STING)

    expect(await pauses.openFor(AMARA)).toEqual([expect.objectContaining({ id: first!.id, step: null, checkDay: '2030-06-20' })])
    expect(errors).toEqual([[...idsLine('skin-care-routine-read-failed')], [...idsLine('skin-care-routine-read-failed')]])
  })

  it('still answers nothing to pause, with the log stored, when the check-in cannot be written either', async () => {
    routineFails = true
    class NoInsert extends FakeStepPausesRepository {
      override async insert(): Promise<never> {
        throw new Error('down')
      }
    }
    service = makeService(new NoInsert())

    const result = await log(STING)

    expect(result).toMatchObject(NOTHING_RESULT)
    expect(await repository.recent(AMARA, 10)).toHaveLength(1)
    expect(errors).toEqual([[...idsLine('skin-care-routine-read-failed')], [...idsLine('skin-care-check-in-write-failed')]])
  })

  it('is the cap\'s professional result, not nothing to pause, when two steps are paused: the cap does not need the routine', async () => {
    await log(STING)
    await log(STING)
    routineFails = true
    routineReads = 0

    const result = await log(STING)

    expect(result.outcome).toEqual({ kind: 'professional', reason: 'harm-while-two-paused' })
    expect(result.log.outcome).toBe('professional')
    // The three logs share one clock reading, so `recent` orders them by id: look the log up by its own id, not by position.
    expect((await repository.recent(AMARA, 10)).find((row) => row.id === result.log.id)).toMatchObject({ outcome: 'professional', reason: 'harm-while-two-paused' })
    expect(stepsOf(await pauses.openFor(AMARA)).sort()).toEqual(['moisturise', 'treat'])
    expect(errors).toEqual([])
  })

  it('leaves a red flag alone: it reads nothing, so it is a professional result whatever is down', async () => {
    routineFails = true

    const result = await log({ noticing: ['swelling'], howBad: 'mild' })

    expect(result.outcome).toEqual({ kind: 'professional', reason: 'swelling' })
    expect(routineReads).toBe(0)
    expect(errors).toEqual([])
  })
})

describe('SkinCareService.log, when the open pauses cannot be read', () => {
  it('stores the log as nothing to pause and writes the check-in with no step, as the store allows', async () => {
    pauses.failNext()

    const result = await log(STING)

    expect(result).toMatchObject(NOTHING_RESULT)
    expect((await repository.recent(AMARA, 10))[0]).toMatchObject({ outcome: 'nothing-to-pause' })
    expect(await pauses.openFor(AMARA)).toEqual([expect.objectContaining({ step: null, checkDay: '2030-06-18' })])
    expect(errors).toEqual([[...idsLine('skin-care-routine-read-failed')]])
  })

  it('still answers nothing to pause when the store is down for every call', async () => {
    class Down extends FakeStepPausesRepository {
      override async openFor(): Promise<never> {
        throw new Error('down')
      }
      override async insert(): Promise<never> {
        throw new Error('down')
      }
    }
    service = makeService(new Down())

    const result = await log(STING)

    expect(result).toMatchObject(NOTHING_RESULT)
    expect(await repository.recent(AMARA, 10)).toHaveLength(1)
    expect(errors).toEqual([[...idsLine('skin-care-routine-read-failed')], [...idsLine('skin-care-check-in-write-failed')]])
  })
})

describe('SkinCareService.log, when the pause cannot be written', () => {
  // A competing request (a double tap, a retry) pauses the same step first: this request's insert then breaks the table's unique index.
  class Raced extends FakeStepPausesRepository {
    raced: NewStepPause | null = null
    override async insert(pause: NewStepPause): Promise<StepPause> {
      if (pause.step !== null && this.raced === null) {
        this.raced = { ...pause, id: 'competing-pause', sourceLogId: 'competing-log', checkDay: '2030-06-19' }
        await super.insert(this.raced)
      }
      return super.insert(pause)
    }
  }

  it('answers with the pause that stands for the same step when the write loses a race: idempotent, and the log keeps saying pause', async () => {
    const raced = new Raced()
    service = makeService(raced)

    const result = await log(STING)

    expect(result.outcome).toEqual({ kind: 'pause', duringStepDown: false })
    expect(result.paused).toEqual({ id: 'competing-pause', step: 'treat', title: 'Retinol Serum', checkDay: '2030-06-19' })
    expect(result.response).toMatchObject({ title: 'We paused your Treatment' })
    expect((await repository.recent(AMARA, 10))[0]).toMatchObject({ outcome: 'pause' })
    expect(stepsOf(await raced.openFor(AMARA))).toEqual(['treat'])
    expect(errors).toEqual([[...idsLine('skin-care-pause-write-failed')]])
  })

  it('answers with its own pause when only a later write fails (the other check days)', async () => {
    class UpdateFails extends FakeStepPausesRepository {
      override async update(): Promise<never> {
        throw new Error('down')
      }
    }
    const store = new UpdateFails()
    service = makeService(store)
    await log(STING)
    now = new Date(T0.getTime() + 1000)

    const second = await log(STING)

    expect(second.paused).toMatchObject({ step: 'moisturise' })
    expect(stepsOf(await store.openFor(AMARA)).sort()).toEqual(['moisturise', 'treat'])
    expect(errors).toEqual([[...idsLine('skin-care-pause-write-failed')]])
  })

  it('falls back to nothing to pause with the check-in with no step, and the stored log says so', async () => {
    class StepInsertFails extends FakeStepPausesRepository {
      override async insert(pause: NewStepPause): Promise<StepPause> {
        if (pause.step !== null) throw new Error('down')
        return super.insert(pause)
      }
    }
    const store = new StepInsertFails()
    service = makeService(store)

    const result = await log(STING)

    expect(result).toMatchObject(NOTHING_RESULT)
    expect(result.log.outcome).toBe('nothing-to-pause')
    expect((await repository.recent(AMARA, 10))[0]).toMatchObject({ id: result.log.id, outcome: 'nothing-to-pause', reason: null })
    expect(await store.openFor(AMARA)).toEqual([expect.objectContaining({ step: null, checkDay: '2030-06-18', sourceLogId: result.log.id })])
    expect(errors).toEqual([[...idsLine('skin-care-pause-write-failed')]])
  })

  it('still answers nothing to pause, with the log changed to say so, when no pause of any kind can be written', async () => {
    class NoInsert extends FakeStepPausesRepository {
      override async insert(): Promise<never> {
        throw new Error('down')
      }
    }
    service = makeService(new NoInsert())

    const result = await log(STING)

    expect(result).toMatchObject(NOTHING_RESULT)
    expect((await repository.recent(AMARA, 10))[0]).toMatchObject({ outcome: 'nothing-to-pause' })
    expect(errors).toEqual([[...idsLine('skin-care-pause-write-failed')], [...idsLine('skin-care-check-in-write-failed')]])
  })

  it('writes no inbox row for a pause that fell back', async () => {
    const written: unknown[] = []
    class NoInsert extends FakeStepPausesRepository {
      override async insert(): Promise<never> {
        throw new Error('down')
      }
    }
    service = new SkinCareService({ ...depsOf(new NoInsert()), inbox: { write: async (input) => (written.push(input), { id: 'x', created: true }) } })

    await log(STING)

    expect(written).toEqual([])
  })
})

describe('SkinCareService.log, what it reads', () => {
  it('reads the routine once for a pause and hands that read to the step-down answer, on the person\'s local day', async () => {
    const result = await log(STING)

    expect(result.paused).toMatchObject({ step: 'treat' })
    expect(routineReads).toBe(1)
    expect(stepDownCalls).toEqual([{ today: '2030-06-15', read: routine() }])
  })

  it('reads it once for a hard-to-ignore symptom during a step-down too', async () => {
    current = { ...routine(), stepDownRunning: true }

    expect((await log({ noticing: ['new-redness'], howBad: 'hard-to-ignore' })).paused).toMatchObject({ step: 'treat' })
    expect(routineReads).toBe(1)
  })

  it('reads nothing for a red flag, advice or a good day: no routine, no step-down, no pauses', async () => {
    routineFails = true
    pauses.failNext()

    expect((await log({ noticing: ['swelling'], howBad: 'mild' })).outcome.kind).toBe('professional')
    expect((await log({ noticing: ['itching'], howBad: 'mild' })).outcome.kind).toBe('advice')
    expect((await log({ noticing: ['nothing-unusual'] })).outcome.kind).toBe('logged')

    expect(routineReads).toBe(0)
    expect(stepDownCalls).toEqual([])
    // The one-shot failure was never consumed: nothing read the pauses.
    await expect(pauses.openFor(AMARA)).rejects.toThrow()
    expect(errors).toEqual([])
  })
})

describe('SkinCareService.log, a pause the routine no longer has', () => {
  it('does not count towards the cap: a stale pause is not one of the two', async () => {
    await log(STING)
    await log(STING)
    current.steps.find(({ step }) => step === 'treat')!.productId = 'prod-better-treat'

    const third = await log(STING)

    expect(third.outcome).toEqual({ kind: 'pause', duringStepDown: false })
    expect(third.paused).toMatchObject({ step: 'treat' })
  })

  it('does not hold its step: the step\'s new product can be paused', async () => {
    const first = await log(STING)
    current.steps.find(({ step }) => step === 'treat')!.productId = 'prod-better-treat'

    const second = await log(STING)

    expect(second.paused).toMatchObject({ step: 'treat' })
    expect(second.paused!.id).not.toBe(first.paused!.id)
  })
})

describe('SkinCareService.stateFor, healing a rebuild whose hook was missed', () => {
  it('sets a pause to replaced when the step\'s product has changed, and does not list the old product', async () => {
    const result = await log(STING)
    current.steps.find(({ step }) => step === 'treat')!.productId = 'prod-better-treat'

    // The old product is not listed. (From PR 5 the new product is brought back on a ladder: skin-care.service.check-ins.test.ts says whether and when it is listed.)
    expect((await service.stateFor(AMARA, '2030-06-15')).pauses).not.toContainEqual(expect.objectContaining({ productId: 'prod-treat' }))

    expect(await pauses.find(AMARA, result.paused!.id)).toMatchObject({ state: 'replaced' })
  })

  it('keeps and lists a pause that is still in the routine', async () => {
    await log(STING)

    expect((await service.stateFor(AMARA, '2030-06-15')).pauses).toEqual([{ step: 'treat', productId: 'prod-treat', state: 'paused' }])
  })

  it('reads the routine only when there is a pause with a step to check', async () => {
    await service.stateFor(AMARA, '2030-06-15')

    expect(routineReads).toBe(0)
  })

  it('is not fatal when the routine cannot be read: the pauses are still answered, and the failure is logged by ids', async () => {
    await log(STING)
    routineFails = true
    errors = []

    expect((await service.stateFor(AMARA, '2030-06-15')).pauses).toEqual([{ step: 'treat', productId: 'prod-treat', state: 'paused' }])
    expect(errors).toEqual([[...idsLine('skin-care-reconcile-failed')]])
  })

  it('still fails when the pauses cannot be read', async () => {
    await log(STING)
    pauses.failNext(new Error('D1 is down'))

    await expect(service.stateFor(AMARA, '2030-06-15')).rejects.toThrow('D1 is down')
  })
})

describe('SkinCareService.undo, a request that can be repeated', () => {
  it('marks the log first: when the state change fails, a repeat still finds the pause and marks the log', async () => {
    const result = await log(STING)
    const real = pauses.update.bind(pauses)
    let fail = true
    pauses.update = async (...args: Parameters<typeof real>) => {
      if (fail) {
        fail = false
        throw new Error('down')
      }
      return real(...args)
    }

    await expect(undo(result.paused!.id)).rejects.toThrow('down')
    expect((await repository.recent(AMARA, 10))[0]).toMatchObject({ overridden: true })
    expect(await pauses.find(AMARA, result.paused!.id)).toMatchObject({ state: 'paused' })

    await expect(undo(result.paused!.id)).resolves.toEqual({ id: result.paused!.id, state: 'undone' })
  })

  it('never turns a pause another request has closed into undone: the state change is conditional on paused', async () => {
    const result = await log(STING)
    const real = pauses.update.bind(pauses)
    pauses.update = async (profileId, id, patch, onlyIfState) => {
      // A rebuild replaces the pause between the read and the write.
      await real(profileId, id, { state: 'replaced' })
      return real(profileId, id, patch, onlyIfState)
    }

    await expect(undo(result.paused!.id)).rejects.toMatchObject({ code: 'PAUSE_NOT_FOUND' })
    expect(await pauses.find(AMARA, result.paused!.id)).toMatchObject({ state: 'replaced' })
  })
})

describe('SkinCareService.log, the inbox row of a pause', () => {
  it('logs ids only when the row cannot be written, and the pause and the answer stand', async () => {
    inboxFails = true

    const result = await log(STING)

    expect(result.paused).toMatchObject({ step: 'treat' })
    expect(await pauses.openFor(AMARA)).toHaveLength(1)
    expect(errors).toEqual([[{ outcome: 'paused-inbox-write-failed', profileId: AMARA, pauseId: result.paused!.id }]])
  })
})

function depsOf(store: FakeStepPausesRepository) {
  return {
    repository,
    pauses: store,
    workbook: {
      responseFor: async (outcome: string) => (outcome === 'paused' ? PAUSED : outcome === 'nothing-to-pause' ? NOTHING : null),
      escalationFor: async () => SWELLING,
    },
    reminders: { zoneFor: async () => null },
    routine: { stepDownRunning: async () => false, skinCareRoutineFor: async () => routine() },
    inbox: { write: async () => ({ id: 'inbox-row', created: true }) },
    now: () => now,
  } as unknown as ConstructorParameters<typeof SkinCareService>[0]
}
