import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Actor, runAs } from '../../lib/context'
import type { EscalationReason, ResponseOutcome, RoutineStep } from '../catalog/catalog.vocabulary'
import type { CatalogWorkbookService, Escalation, Response } from '../catalog/catalog.workbook.service'
import type { ScheduleStep } from '../catalog/catalog.workbook.schema'
import { FakeInboxRepository } from '../inbox/inbox.repository.fake'
import { type InboxWrite, InboxService } from '../inbox/inbox.service'
import { FORBIDDEN_WORDING } from '../routines/routines.wording'
import { FakeSkinCareRepository } from './skin-care.repository.fake'
import { FakeEscalationHoldsRepository } from './skin-care.holds.repository.fake'
import { FakeStepPausesRepository } from './skin-care.pauses.repository.fake'
import { SkinCareService } from './skin-care.service'
import type { SkinCareRoutine, SkinCareRoutineStep } from './skin-care.types'

// The check-in after a pause and the bring-back ladder (spec #233, PR 5), at the service seam with the same world fake as skin-care.service.pauses.test.ts: one mutable clock,
// the stored time zones, the reviewed text and ladders of the workbook, the routine in force, and the inbox service over its own fake repository. The skin-log and pauses repositories
// are the real fakes. A person reaches a state the way the product does: a harm log pauses a step, and the answer to the check-in brings it back. No row is written into a state
// the product cannot make.
//
// THE CONTRACT THIS FILE PINS (assumed: the brief names the behaviour; the names below follow it and the code as it is today):
//   new SkinCareService({ ..., workbook })    workbook is now Pick<CatalogWorkbookService, 'responseFor' | 'escalationFor' | 'reintroductionFor'>
//   checkInsDue(profileId: string, today: string): Promise<{ id: string; ... }[]>     by profile id, no session. The profile's open rows in state 'paused' (the stepless row too) whose
//       checkDay <= today ('YYYY-MM-DD'). Never a bringing-back, escalated or closed row, or another profile's. (Assumed to answer the rows, so that `.id` is read.)
//   answerCheckIn(pauseId: string, answer: 'calmer' | 'same' | 'worse'): Promise<{ outcome, response, pause }> for the session profile:
//       outcome  { kind: 'calmer' } | { kind: 'same' } | { kind: 'professional', reason: 'worse-after-pause' | 'unchanged-after-checks' }
//       response the reviewed text of check-calmer / check-same with {step} filled (the plain noun, "your routine" for the stepless row); for a professional the reviewed
//                Escalation { whoToSee, howSoon, whatToTellThem }
//       pause    { id, step: RoutineStep | null, state, checkDay: string | null }   checkDay is null once the row is not 'paused' any more
//     401 AUTH_REQUIRED, 403 SIGNUP_REQUIRED, 404 PAUSE_NOT_FOUND (not theirs, none, not 'paused'), 409 CHECK_IN_NOT_DUE before checkDay (today in the zone stored now, against the
//     frozen day).
//     calmer, with a step: state 'bringing-back', ladderStartedOn today, ladderCode the SCHEDULE of the row's frozen group (else the default ladder), serialised as JSON; the inbox
//       row { key: `bringing-back:${id}:1`, link: '/routine' }. No ladder, or an empty one: 503 CONTENT_UNAVAILABLE and the row is as it was. Stepless: state 'ended'.
//     same: checkDay = today + 3, sameCount + 1; the third in a row is a professional 'unchanged-after-checks'. worse: a professional 'worse-after-pause'.
//     a professional: the row becomes 'escalated' (a new state): never due again, the step stays out of the routine (stateFor emits it as 'paused'), and not counted by the cap.
//   stateFor(profileId, today): a bringing-back row is { step, productId: productKey, state: 'bringing-back', frequency, anchor }; the ladder is in weeks (ScheduleStep): rung n starts
//     on ladderStartedOn + 7 * (fromWeek - 1) days, `anchor` is the start day of the current rung and `frequency` its frequency. From the start day of the 'back' rung the row is
//     'ended' (best effort) and the step is omitted.
//   log: a harm signal on a step being brought back (the row's step and product are still in the routine) flips THAT row to 'paused' in place (see rePause in the pauses contract).
//   undo: of that re-pause, answers { id, state: 'bringing-back' } and restores the ladder row; of a first pause it is 'undone' as before.
//   reconcile: a stepped pause set to 'replaced' starts the ladder for the step's new product (state 'bringing-back', its own first active group, ladder frozen, started today,
//     inbox `bringing-back:${newId}:1`); with no ladder it opens a 'paused' row for the new product with checkDay today + 3.

// Every date hangs off this one instant (the clock) and its UTC day; fixtures are offsets from them.
const T0 = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs)
const dayAt = (offsetDays: number) => at(offsetDays * DAY).toISOString().slice(0, 10)
const TODAY = dayAt(0)
/** The pause made at T0 is checked three days on, and the ladders here start the day it is answered. */
const CHECK_DAY = dayAt(3)
const STARTED = dayAt(3)

// The days the clocks change in New York, 2030 (spring forward on 10 March at 07:00 UTC; fall back on 3 November at 06:00 UTC). A pause is made at noon local three days before the
// check day, so the check day's first instant lies after the change, and a check day counted in hours from the pause would be an hour out.
const SPRING_PAUSED_AT = new Date('2030-03-08T17:00:00.000Z') // 12:00 EST, 8 March: checked 11 March; 11 March begins 04:00 UTC (EDT)
const SPRING_CHECK_DAY_BEGINS = 59 * HOUR
const FALL_PAUSED_AT = new Date('2030-11-01T16:00:00.000Z') // 12:00 EDT, 1 November: checked 4 November; 4 November begins 05:00 UTC (EST)
const FALL_CHECK_DAY_BEGINS = 61 * HOUR

const AMARA_USER = 'user-amara'
const AMARA = 'profile-amara'
const TOLU_USER = 'user-tolu'
const TOLU = 'profile-tolu'

const actor = (userId: string, profileId: string, status: 'anonymous' | 'verified' = 'verified'): Actor => ({ kind: 'user', userId, status, profileId })
const AMARA_ACTOR = actor(AMARA_USER, AMARA)
const TOLU_ACTOR = actor(TOLU_USER, TOLU)
const GUEST = actor('user-guest', 'profile-guest', 'anonymous')
const PUBLIC: Actor = { kind: 'public' }

const PAUSED_TEXT: Response = {
  title: 'We paused your {step}',
  body: 'Your skin needs a rest from your {step}. We will ask how it feels in three days.',
  whatToDoNow: 'Skip anything that stings. Keep sunscreen if it does not sting.',
}
const NOTHING_TEXT: Response = { title: 'Nothing to pause yet', body: 'Skip anything that stings and rinse with water. Keep {step} simple until it settles.', whatToDoNow: 'Keep sunscreen if it does not sting.' }
const CALMER_TEXT: Response = { title: 'Good news about {step}', body: 'We will bring {step} back slowly, one small step at a time.', whatToDoNow: 'Follow the plan the routine shows.' }
const SAME_TEXT: Response = { title: 'No change in {step} yet', body: 'We will ask about {step} again in three days.', whatToDoNow: 'Keep it paused for now.' }
const WORSE_TEXT: Response = { title: 'Still bothered by {step}', body: 'Keep {step} paused.', whatToDoNow: null }
const ESCALATIONS: Partial<Record<EscalationReason, Escalation>> = {
  'harm-while-two-paused': { whoToSee: 'A doctor or pharmacist.', howSoon: 'Within a day.', whatToTellThem: 'Which steps are paused and what you noticed.' },
  swelling: { whoToSee: 'A doctor or pharmacist about swelling.', howSoon: 'Today.', whatToTellThem: 'Where it swelled and since when.' },
  'worse-after-pause': { whoToSee: 'A doctor or pharmacist about skin that is worse.', howSoon: 'Within a day or two.', whatToTellThem: 'What you paused, for how long, and how it is now.' },
  'unchanged-after-checks': { whoToSee: 'A pharmacist or a doctor about skin that has not settled.', howSoon: 'This week.', whatToTellThem: 'What you paused, and that it has not changed in nine days.' },
}

// Two ladders, in weeks. The default has a rung of one week each; the retinoid one has a first rung of two weeks, so the two cannot be taken for each other.
const DEFAULT_LADDER: ScheduleStep[] = [
  { fromWeek: 1, toWeek: 1, frequency: 'weekly' },
  { fromWeek: 2, toWeek: 2, frequency: 'alternate-days' },
  { fromWeek: 3, toWeek: 3, frequency: 'back' },
]
const RETINOID_LADDER: ScheduleStep[] = [
  { fromWeek: 1, toWeek: 2, frequency: 'weekly' },
  { fromWeek: 3, toWeek: 3, frequency: 'alternate-days' },
  { fromWeek: 4, toWeek: 4, frequency: 'back' },
]
const ACID_LADDER: ScheduleStep[] = [
  { fromWeek: 1, toWeek: 1, frequency: 'as-needed' },
  { fromWeek: 2, toWeek: 2, frequency: 'back' },
]

const step = (name: RoutineStep, over: Partial<SkinCareRoutineStep> = {}): SkinCareRoutineStep => ({
  step: name,
  title: `${name} title`,
  productRef: { kind: 'shelf', id: `entry-${name}` },
  productId: `prod-${name}`,
  changedOn: dayAt(-5),
  activeGroups: [],
  ...over,
})
/** Amara's started routine: day 1 five days ago; the treat step is the one active step (a retinoid), changed three days ago; the moisturiser changed four days ago. */
const amarasRoutine = (): SkinCareRoutine => ({
  dayOne: dayAt(-5),
  steps: [
    step('cleanse', { title: 'Gentle Cleanser', changedOn: dayAt(-5) }),
    step('treat', { title: 'Retinol Serum', productRef: { kind: 'candidate', code: 'TREAT-1' }, changedOn: dayAt(-3), activeGroups: ['retinoid'] }),
    step('moisturise', { title: 'Plain Moisturiser', productRef: { kind: 'candidate', code: 'MOIST-1' }, changedOn: dayAt(-4) }),
    step('protect', { title: 'Daily Sunscreen', changedOn: dayAt(-5) }),
  ],
  stepDownRunning: false,
})

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error as Error & { code?: string }
  }
  throw new Error('expected the promise to reject')
}

type World = {
  now: Date
  zones: Map<string, string | null>
  routines: Map<string, SkinCareRoutine | null>
  responses: Partial<Record<ResponseOutcome, Response>>
  escalations: Partial<Record<EscalationReason, Escalation>>
  /** The approved ladders by group, 'default' for the one with no group. A group without a ladder of its own gets the default, as the workbook gives it; none at all is empty. */
  ladders: Map<string, ScheduleStep[]>
  ladderReadFails: boolean
  inboxWrites: InboxWrite[]
  inboxFails: boolean
}
let world: World
let repository: FakeSkinCareRepository
let pauses: FakeStepPausesRepository
let inboxRows: InboxService
let service: SkinCareService
let errors: unknown[][]

const makeService = () =>
  new SkinCareService({
    repository,
    pauses,
    holds: new FakeEscalationHoldsRepository(),
    safety: { markReactionProduct: async () => ({ marked: false }) },
    verdicts: { savedFor: async () => null },
    catalog: { namedProduct: async () => Promise.reject(new Error('unused')) },
    workbook: {
      responseFor: async (outcome) => world.responses[outcome] ?? null,
      escalationFor: async (reason) => world.escalations[reason] ?? null,
      reintroductionFor: async (group) => {
        if (world.ladderReadFails) throw new Error('ladder read failed')
        return structuredClone((group === null ? undefined : world.ladders.get(group)) ?? world.ladders.get('default') ?? [])
      },
    } satisfies Pick<CatalogWorkbookService, 'responseFor' | 'escalationFor' | 'reintroductionFor'>,
    reminders: { zoneFor: async (profileId: string) => world.zones.get(profileId) ?? null },
    routine: {
      stepDownRunning: async () => false,
      skinCareRoutineFor: async (profileId: string) => {
        const routine = world.routines.get(profileId) ?? null
        return routine === null ? null : structuredClone(routine)
      },
    },
    inbox: {
      write: async (input: InboxWrite) => {
        if (world.inboxFails) throw new Error('inbox write failed')
        world.inboxWrites.push(input)
        return inboxRows.write(input)
      },
    },
    now: () => world.now,
  })

type LogInput = Parameters<SkinCareService['log']>[0]
const log = (who: Actor, input: LogInput) => runAs(who, () => service.log(input))
const undo = (who: Actor, pauseId: string) => runAs(who, () => service.undo(pauseId))
const checkIn = (who: Actor, pauseId: string, answer: 'calmer' | 'same' | 'worse') => runAs(who, () => service.answerCheckIn(pauseId, answer))
const openPauses = (profileId: string) => pauses.openFor(profileId)
const row = async (id: string, profileId = AMARA) => (await pauses.find(profileId, id))!
const dueIds = async (day: string, profileId = AMARA) => (await service.checkInsDue(profileId, day)).map((due) => due.id).sort()
const ladderOf = (stored: { ladderCode: string | null }) => JSON.parse(stored.ladderCode!) as ScheduleStep[]
const bringingBackWrites = () => world.inboxWrites.filter((write) => write.key.startsWith('bringing-back:'))

const STING: LogInput = { noticing: ['stinging-or-burning'], howBad: 'mild' }
const harm = (who: Actor = AMARA_ACTOR) => log(who, STING)
const treat = (profileId = AMARA) => world.routines.get(profileId)!.steps.find((s) => s.step === 'treat')!

/** A harm log pauses the treatment at T0 (checked on CHECK_DAY); the person answers Calmer on the check day. Leaves the clock on that day, and the treatment on its first rung. */
const bringBack = async (who: Actor = AMARA_ACTOR) => {
  const made = await harm(who)
  world.now = at(3 * DAY)
  const answered = await checkIn(who, made.paused!.id, 'calmer')
  return { id: made.paused!.id, answered }
}
const onRung = (frequency: string, anchor: string, productId = 'prod-treat', stepName: RoutineStep = 'treat') => ({ step: stepName, productId, state: 'bringing-back', frequency, anchor })

beforeEach(() => {
  world = {
    now: T0,
    zones: new Map(),
    routines: new Map([[AMARA, amarasRoutine()], [TOLU, amarasRoutine()]]),
    responses: { paused: { ...PAUSED_TEXT }, 'nothing-to-pause': { ...NOTHING_TEXT }, 'check-calmer': { ...CALMER_TEXT }, 'check-same': { ...SAME_TEXT }, 'check-worse': { ...WORSE_TEXT } },
    escalations: { ...ESCALATIONS },
    ladders: new Map([['default', structuredClone(DEFAULT_LADDER)]]),
    ladderReadFails: false,
    inboxWrites: [],
    inboxFails: false,
  }
  repository = new FakeSkinCareRepository()
  pauses = new FakeStepPausesRepository()
  inboxRows = new InboxService({ repository: new FakeInboxRepository(), now: () => world.now })
  service = makeService()
  errors = []
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errors.push(args))
})
afterEach(() => vi.restoreAllMocks())

// --- 1. what is due ---

describe('SkinCareService.checkInsDue', () => {
  it('lists a paused step from its check day on, and not the day before', async () => {
    const made = await harm()

    expect(await dueIds(dayAt(2))).toEqual([])
    expect(await dueIds(CHECK_DAY)).toEqual([made.paused!.id])
    expect(await dueIds(dayAt(10))).toEqual([made.paused!.id])
  })

  it('lists the check-in with no step too', async () => {
    world.routines.set(AMARA, null)
    await harm()
    const [stepless] = await openPauses(AMARA)

    expect(stepless).toMatchObject({ step: null })
    expect(await dueIds(dayAt(2))).toEqual([])
    expect(await dueIds(CHECK_DAY)).toEqual([stepless!.id])
  })

  it('never lists a step being brought back, a step sent to a professional, or a closed pause, however late it is', async () => {
    const first = await harm()
    const second = await harm()
    world.now = at(3 * DAY)
    // Treat: brought back. Moisturise: sent to a professional.
    await checkIn(AMARA_ACTOR, first.paused!.id, 'calmer')
    await checkIn(AMARA_ACTOR, second.paused!.id, 'worse')

    expect(await dueIds(dayAt(60))).toEqual([])
  })

  it('lists only the profile\'s own rows', async () => {
    const mine = await harm(AMARA_ACTOR)
    const hers = await harm(TOLU_ACTOR)

    expect(await dueIds(CHECK_DAY, AMARA)).toEqual([mine.paused!.id])
    expect(await dueIds(CHECK_DAY, TOLU)).toEqual([hers.paused!.id])
  })

  it('asks for no session: it is read by profile id, by the job and by Today', async () => {
    const made = await harm()

    // No runAs here: the call is made outside any request.
    expect((await service.checkInsDue(AMARA, CHECK_DAY)).map((due) => due.id)).toEqual([made.paused!.id])
  })
})

// --- 2. who may answer, and when ---

describe('SkinCareService.answerCheckIn, who may answer and when', () => {
  it('answers 401 AUTH_REQUIRED with no session and 403 SIGNUP_REQUIRED to a guest, changing nothing', async () => {
    const made = await harm()
    world.now = at(3 * DAY)

    expect(await errorOf(checkIn(PUBLIC, made.paused!.id, 'calmer'))).toMatchObject({ name: 'UnauthorizedError', code: 'AUTH_REQUIRED' })
    expect(await errorOf(checkIn(GUEST, made.paused!.id, 'calmer'))).toMatchObject({ name: 'ForbiddenError', code: 'SIGNUP_REQUIRED' })
    expect(await row(made.paused!.id)).toMatchObject({ state: 'paused', checkDay: CHECK_DAY, ladderCode: null })
  })

  it('answers 404 PAUSE_NOT_FOUND for another profile\'s pause, and changes nothing', async () => {
    const hers = await harm(TOLU_ACTOR)
    world.now = at(3 * DAY)

    const error = await errorOf(checkIn(AMARA_ACTOR, hers.paused!.id, 'calmer'))

    expect(error).toMatchObject({ name: 'NotFoundError', code: 'PAUSE_NOT_FOUND' })
    expect(await row(hers.paused!.id, TOLU)).toMatchObject({ state: 'paused', ladderCode: null })
  })

  it('answers 404 PAUSE_NOT_FOUND for a pause nobody holds', async () => {
    expect(await errorOf(checkIn(AMARA_ACTOR, crypto.randomUUID(), 'same'))).toMatchObject({ name: 'NotFoundError', code: 'PAUSE_NOT_FOUND' })
  })

  it('answers 404 PAUSE_NOT_FOUND for a pause that is no longer paused: brought back or sent to a professional', async () => {
    const brought = await harm()
    const escalated = await harm()
    world.now = at(3 * DAY)
    await checkIn(AMARA_ACTOR, brought.paused!.id, 'calmer')
    await checkIn(AMARA_ACTOR, escalated.paused!.id, 'worse')
    const gone = await row(brought.paused!.id)
    const sent = await row(escalated.paused!.id)

    for (const id of [brought.paused!.id, escalated.paused!.id]) {
      for (const answer of ['calmer', 'same', 'worse'] as const) expect(await errorOf(checkIn(AMARA_ACTOR, id, answer))).toMatchObject({ name: 'NotFoundError', code: 'PAUSE_NOT_FOUND' })
    }
    expect(await row(brought.paused!.id)).toEqual(gone)
    expect(await row(escalated.paused!.id)).toEqual(sent)
  })

  it('answers 404 PAUSE_NOT_FOUND for an undone pause and for a replaced one', async () => {
    const undone = await harm()
    await undo(AMARA_ACTOR, undone.paused!.id)
    const replaced = await harm()
    treat().productId = 'prod-better-treat'
    treat().productRef = { kind: 'candidate', code: 'TREAT-2' }
    world.ladders.clear()
    await service.reconcile(AMARA)
    world.now = at(3 * DAY)

    expect(await errorOf(checkIn(AMARA_ACTOR, undone.paused!.id, 'calmer'))).toMatchObject({ code: 'PAUSE_NOT_FOUND' })
    expect(await errorOf(checkIn(AMARA_ACTOR, replaced.paused!.id, 'calmer'))).toMatchObject({ code: 'PAUSE_NOT_FOUND' })
  })

  it('answers 409 CHECK_IN_NOT_DUE before the check day, and leaves the row as it was; a day later it is answered', async () => {
    const made = await harm()
    world.now = at(3 * DAY - 12 * HOUR - 1)

    const error = await errorOf(checkIn(AMARA_ACTOR, made.paused!.id, 'same'))

    expect(error).toMatchObject({ name: 'ConflictError', code: 'CHECK_IN_NOT_DUE' })
    expect(await row(made.paused!.id)).toMatchObject({ state: 'paused', checkDay: CHECK_DAY, sameCount: 0 })

    world.now = at(3 * DAY - 12 * HOUR)
    await expect(checkIn(AMARA_ACTOR, made.paused!.id, 'same')).resolves.toMatchObject({ outcome: { kind: 'same' } })
  })

  it.each([
    ['Africa/Lagos', 2 * DAY + 11 * HOUR - 1, false],
    ['Africa/Lagos', 2 * DAY + 11 * HOUR, true],
    ['America/New_York', 2 * DAY + 16 * HOUR - 1, false],
    ['America/New_York', 2 * DAY + 16 * HOUR, true],
    [null, 2 * DAY + 12 * HOUR - 1, false],
    [null, 2 * DAY + 12 * HOUR, true],
  ] as [string | null, number, boolean][])('reads the check day (18 June) in the person\'s own zone: in %s at T0 + %i ms it is due: %s', async (zone, offset, due) => {
    world.zones.set(AMARA, zone)
    const made = await harm()
    world.now = at(offset)

    const refused = await checkIn(AMARA_ACTOR, made.paused!.id, 'same').then(
      () => null,
      (error: Error) => error,
    )

    if (due) expect(refused).toBeNull()
    else expect(refused).toMatchObject({ name: 'ConflictError', code: 'CHECK_IN_NOT_DUE' })
  })

  it('keeps the check day the pause froze when the zone changes later: today is read in the zone stored now', async () => {
    world.zones.set(AMARA, 'Africa/Lagos')
    const made = await harm()
    // At this instant Lagos is on the check day, 18 June, and New York is still on the 17th.
    world.now = at(2 * DAY + 11 * HOUR)
    world.zones.set(AMARA, 'America/New_York')
    expect(await errorOf(checkIn(AMARA_ACTOR, made.paused!.id, 'same'))).toMatchObject({ code: 'CHECK_IN_NOT_DUE' })

    world.zones.set(AMARA, 'Africa/Lagos')
    await expect(checkIn(AMARA_ACTOR, made.paused!.id, 'same')).resolves.toMatchObject({ outcome: { kind: 'same' } })
  })

  it.each([
    ['spring forward', SPRING_PAUSED_AT, SPRING_CHECK_DAY_BEGINS, '2030-03-11'],
    ['fall back', FALL_PAUSED_AT, FALL_CHECK_DAY_BEGINS, '2030-11-04'],
  ] as [string, Date, number, string][])('counts three calendar days across the clocks changing (%s), not 72 hours: due from the first instant of %s', async (_name, pausedAt, beginsAfter, checkDay) => {
    world.zones.set(AMARA, 'America/New_York')
    world.now = pausedAt
    const made = await harm()
    expect(made.paused!.checkDay).toBe(checkDay)

    world.now = new Date(pausedAt.getTime() + beginsAfter - 1)
    expect(await errorOf(checkIn(AMARA_ACTOR, made.paused!.id, 'calmer'))).toMatchObject({ code: 'CHECK_IN_NOT_DUE' })

    world.now = new Date(pausedAt.getTime() + beginsAfter)
    await expect(checkIn(AMARA_ACTOR, made.paused!.id, 'calmer')).resolves.toMatchObject({ outcome: { kind: 'calmer' } })
    expect(await row(made.paused!.id)).toMatchObject({ state: 'bringing-back', ladderStartedOn: checkDay })
  })

  it('applies the same rules to the check-in with no step: not before its check day, and from it', async () => {
    world.routines.set(AMARA, null)
    await harm()
    const [stepless] = await openPauses(AMARA)
    world.now = at(3 * DAY - 12 * HOUR - 1)

    expect(await errorOf(checkIn(AMARA_ACTOR, stepless!.id, 'same'))).toMatchObject({ name: 'ConflictError', code: 'CHECK_IN_NOT_DUE' })
    expect(await errorOf(checkIn(TOLU_ACTOR, stepless!.id, 'same'))).toMatchObject({ name: 'NotFoundError', code: 'PAUSE_NOT_FOUND' })
    expect(await errorOf(checkIn(PUBLIC, stepless!.id, 'same'))).toMatchObject({ code: 'AUTH_REQUIRED' })

    world.now = at(3 * DAY - 12 * HOUR)
    await expect(checkIn(AMARA_ACTOR, stepless!.id, 'same')).resolves.toMatchObject({ outcome: { kind: 'same' } })
  })
})

// --- 3. calmer ---

describe('SkinCareService.answerCheckIn, calmer on a step', () => {
  it('answers the reviewed check-calmer text with the plain noun, and the pause as being brought back with no check day', async () => {
    const made = await harm()
    world.now = at(3 * DAY)

    const result = await checkIn(AMARA_ACTOR, made.paused!.id, 'calmer')

    expect(result).toEqual({
      outcome: { kind: 'calmer' },
      response: { title: 'Good news about Treatment', body: 'We will bring Treatment back slowly, one small step at a time.', whatToDoNow: 'Follow the plan the routine shows.' },
      pause: { id: made.paused!.id, step: 'treat', state: 'bringing-back', checkDay: null },
    })
  })

  it('starts the ladder on the row: bringing-back, started on the local day of the answer, never at full strength', async () => {
    const { id } = await bringBack()

    expect(await row(id)).toMatchObject({ id, step: 'treat', productKey: 'prod-treat', state: 'bringing-back', ladderStartedOn: STARTED })
    expect(await openPauses(AMARA)).toHaveLength(1)
    // The first rung is gentler than the routine's own frequency: 'back' only comes at the end.
    expect(await service.stateFor(AMARA, STARTED)).toEqual({ pauses: [onRung('weekly', STARTED)], held: false })
  })

  it('starts the ladder on the person\'s local day, not the UTC day', async () => {
    world.zones.set(AMARA, 'Africa/Lagos')
    const made = await harm()
    // 23:00 UTC on 17 June is 00:00 on the 18th in Lagos: the check day.
    world.now = at(2 * DAY + 11 * HOUR)

    await checkIn(AMARA_ACTOR, made.paused!.id, 'calmer')

    expect(await row(made.paused!.id)).toMatchObject({ ladderStartedOn: CHECK_DAY })
  })

  it('freezes the schedule itself on the row, for the group the pause froze', async () => {
    world.ladders.set('retinoid', structuredClone(RETINOID_LADDER))
    const made = await harm()
    expect(await row(made.paused!.id)).toMatchObject({ ingredientGroup: 'retinoid' })
    world.now = at(3 * DAY)

    await checkIn(AMARA_ACTOR, made.paused!.id, 'calmer')

    expect(ladderOf(await row(made.paused!.id))).toEqual(RETINOID_LADDER)
  })

  it('uses the group frozen on the row, not the group the routine\'s product has now', async () => {
    world.ladders.set('retinoid', structuredClone(RETINOID_LADDER))
    world.ladders.set('exfoliating-acid', structuredClone(ACID_LADDER))
    const made = await harm()
    // The product keeps its place in the routine but now reads as an acid: the pause froze retinoid when it was made.
    treat().activeGroups = ['exfoliating-acid']
    world.now = at(3 * DAY)

    await checkIn(AMARA_ACTOR, made.paused!.id, 'calmer')

    expect(ladderOf(await row(made.paused!.id))).toEqual(RETINOID_LADDER)
  })

  it('uses the default ladder for a pause with no group, and for a group the workbook has no ladder of its own for', async () => {
    treat().activeGroups = []
    const plain = await harm()
    world.now = at(3 * DAY)
    await checkIn(AMARA_ACTOR, plain.paused!.id, 'calmer')
    expect(await row(plain.paused!.id)).toMatchObject({ ingredientGroup: null })
    expect(ladderOf(await row(plain.paused!.id))).toEqual(DEFAULT_LADDER)

    world.now = T0
    treat(TOLU).activeGroups = ['benzoyl-peroxide']
    const group = await harm(TOLU_ACTOR)
    world.now = at(3 * DAY)
    await checkIn(TOLU_ACTOR, group.paused!.id, 'calmer')
    expect(ladderOf(await row(group.paused!.id, TOLU))).toEqual(DEFAULT_LADDER)
  })

  it('keeps a running ladder as it was frozen: a later edit of the workbook changes nothing', async () => {
    const { id } = await bringBack()
    world.ladders.set('default', [{ fromWeek: 1, toWeek: 1, frequency: 'as-needed' }, { fromWeek: 2, toWeek: 2, frequency: 'back' }])
    world.ladders.set('retinoid', [{ fromWeek: 1, toWeek: 5, frequency: 'as-needed' }, { fromWeek: 6, toWeek: 6, frequency: 'back' }])

    expect(ladderOf(await row(id))).toEqual(DEFAULT_LADDER)
    expect((await service.stateFor(AMARA, dayAt(10))).pauses).toEqual([onRung('alternate-days', dayAt(10))])
    // Its end is still the start of the third week of the frozen schedule, not the second of the edited one.
    expect((await service.stateFor(AMARA, dayAt(16))).pauses).toEqual([onRung('alternate-days', dayAt(10))])
    expect((await service.stateFor(AMARA, dayAt(17))).pauses).toEqual([])
  })

  it('writes one inbox row for the first rung, keyed by the pause, with the filled text and a link to the routine', async () => {
    const { id } = await bringBack()

    expect(bringingBackWrites()).toEqual([
      expect.objectContaining({
        profileId: AMARA,
        day: STARTED,
        title: 'Good news about Treatment',
        body: 'We will bring Treatment back slowly, one small step at a time.',
        link: '/routine',
        key: `bringing-back:${id}:1`,
      }),
    ])
  })

  it.each([
    ['is empty', () => world.ladders.clear()],
    ['cannot be read', () => (world.ladderReadFails = true)],
  ] as [string, () => unknown][])('answers 503 CONTENT_UNAVAILABLE when the ladder %s, leaves the row as it was and writes nothing; once there is a ladder it can be answered again', async (_name, break_) => {
    const made = await harm()
    world.now = at(3 * DAY)
    const before = await row(made.paused!.id)
    break_()

    const error = await errorOf(checkIn(AMARA_ACTOR, made.paused!.id, 'calmer'))

    expect(error).toMatchObject({ name: 'UnavailableError', code: 'CONTENT_UNAVAILABLE' })
    expect(await row(made.paused!.id)).toEqual(before)
    expect(before).toMatchObject({ state: 'paused', ladderCode: null, ladderStartedOn: null })
    expect(bringingBackWrites()).toEqual([])

    world.ladderReadFails = false
    world.ladders.set('default', structuredClone(DEFAULT_LADDER))
    await expect(checkIn(AMARA_ACTOR, made.paused!.id, 'calmer')).resolves.toMatchObject({ outcome: { kind: 'calmer' } })
    expect(await row(made.paused!.id)).toMatchObject({ state: 'bringing-back', ladderStartedOn: STARTED })
  })
})

describe('SkinCareService.answerCheckIn, calmer on the check-in with no step', () => {
  it('ends it and answers the check-calmer text with "your routine"; it reads no ladder and writes no inbox row', async () => {
    world.routines.set(AMARA, null)
    await harm()
    const [stepless] = await openPauses(AMARA)
    world.now = at(3 * DAY)
    world.ladderReadFails = true

    const result = await checkIn(AMARA_ACTOR, stepless!.id, 'calmer')

    expect(result).toEqual({
      outcome: { kind: 'calmer' },
      response: { title: 'Good news about your routine', body: 'We will bring your routine back slowly, one small step at a time.', whatToDoNow: 'Follow the plan the routine shows.' },
      pause: { id: stepless!.id, step: null, state: 'ended', checkDay: null },
    })
    expect(await row(stepless!.id)).toMatchObject({ state: 'ended', ladderCode: null, ladderStartedOn: null })
    expect(await openPauses(AMARA)).toEqual([])
    expect(bringingBackWrites()).toEqual([])
  })
})

// --- 4. same ---

describe('SkinCareService.answerCheckIn, about the same', () => {
  it('asks again three days after the answer, counts it, keeps the step paused and answers the check-same text', async () => {
    const made = await harm()
    world.now = at(3 * DAY)

    const result = await checkIn(AMARA_ACTOR, made.paused!.id, 'same')

    expect(result).toEqual({
      outcome: { kind: 'same' },
      response: { title: 'No change in Treatment yet', body: 'We will ask about Treatment again in three days.', whatToDoNow: 'Keep it paused for now.' },
      pause: { id: made.paused!.id, step: 'treat', state: 'paused', checkDay: dayAt(6) },
    })
    expect(await row(made.paused!.id)).toMatchObject({ state: 'paused', checkDay: dayAt(6), sameCount: 1, ladderCode: null })
    expect(await service.stateFor(AMARA, dayAt(3))).toEqual({ pauses: [{ step: 'treat', productId: 'prod-treat', state: 'paused' }], held: false })
  })

  it('counts three days from the day it is answered, not from the old check day', async () => {
    const made = await harm()
    world.now = at(5 * DAY)

    await checkIn(AMARA_ACTOR, made.paused!.id, 'same')

    // Answered two days late: 8 days after the pause, not 6.
    expect((await row(made.paused!.id)).checkDay).toBe(dayAt(8))
  })

  it('is due again from the new check day and not the day before', async () => {
    const made = await harm()
    world.now = at(3 * DAY)
    await checkIn(AMARA_ACTOR, made.paused!.id, 'same')

    expect(await dueIds(dayAt(5))).toEqual([])
    expect(await dueIds(dayAt(6))).toEqual([made.paused!.id])
  })

  it('counts the days from the person\'s local day', async () => {
    world.zones.set(AMARA, 'Africa/Lagos')
    const made = await harm()
    world.now = at(2 * DAY + 11 * HOUR)

    await checkIn(AMARA_ACTOR, made.paused!.id, 'same')

    expect((await row(made.paused!.id)).checkDay).toBe(dayAt(6))
  })

  it('counts three calendar days across the clocks changing, from the day it is answered', async () => {
    world.zones.set(AMARA, 'America/New_York')
    world.now = FALL_PAUSED_AT
    const made = await harm()
    // Answered on 6 November (two days after the check day; the clocks changed on the 3rd): checked again on 9 November.
    world.now = new Date(FALL_PAUSED_AT.getTime() + 5 * DAY)

    await checkIn(AMARA_ACTOR, made.paused!.id, 'same')

    expect((await row(made.paused!.id)).checkDay).toBe('2030-11-09')
  })

  it('sends the third in a row to a professional, with the reviewed text of unchanged-after-checks, and the step is escalated; the first two do not', async () => {
    const made = await harm()
    world.now = at(3 * DAY)
    const first = await checkIn(AMARA_ACTOR, made.paused!.id, 'same')
    world.now = at(6 * DAY)
    const second = await checkIn(AMARA_ACTOR, made.paused!.id, 'same')
    expect([first.outcome.kind, second.outcome.kind]).toEqual(['same', 'same'])
    expect(await row(made.paused!.id)).toMatchObject({ state: 'paused', sameCount: 2, checkDay: dayAt(9) })
    world.now = at(9 * DAY)

    const third = await checkIn(AMARA_ACTOR, made.paused!.id, 'same')

    expect(third.outcome).toEqual({ kind: 'professional', reason: 'unchanged-after-checks' })
    expect(third.response).toEqual(ESCALATIONS['unchanged-after-checks'])
    expect(third.pause).toMatchObject({ id: made.paused!.id, step: 'treat', state: 'escalated' })
    expect(await row(made.paused!.id)).toMatchObject({ state: 'escalated' })
  })

  it('counts the check-in with no step the same way: three days on, and the third is a professional', async () => {
    world.routines.set(AMARA, null)
    await harm()
    const [stepless] = await openPauses(AMARA)
    world.now = at(3 * DAY)

    const first = await checkIn(AMARA_ACTOR, stepless!.id, 'same')

    expect(first.response).toMatchObject({ title: 'No change in your routine yet' })
    expect(await row(stepless!.id)).toMatchObject({ state: 'paused', checkDay: dayAt(6), sameCount: 1 })
    world.now = at(6 * DAY)
    await checkIn(AMARA_ACTOR, stepless!.id, 'same')
    world.now = at(9 * DAY)
    const third = await checkIn(AMARA_ACTOR, stepless!.id, 'same')
    expect(third.outcome).toEqual({ kind: 'professional', reason: 'unchanged-after-checks' })
    expect(await row(stepless!.id)).toMatchObject({ state: 'escalated' })
  })
})

// --- 5 and 6. worse, and what a professional result leaves ---

describe('SkinCareService.answerCheckIn, worse', () => {
  it('sends the person to a professional with the reviewed worse-after-pause text, and the step is escalated', async () => {
    const made = await harm()
    world.now = at(3 * DAY)

    const result = await checkIn(AMARA_ACTOR, made.paused!.id, 'worse')

    expect(result).toEqual({
      outcome: { kind: 'professional', reason: 'worse-after-pause' },
      response: ESCALATIONS['worse-after-pause'],
      pause: { id: made.paused!.id, step: 'treat', state: 'escalated', checkDay: null },
    })
    expect(await row(made.paused!.id)).toMatchObject({ state: 'escalated' })
  })

  it('does the same for the check-in with no step', async () => {
    world.routines.set(AMARA, null)
    await harm()
    const [stepless] = await openPauses(AMARA)
    world.now = at(3 * DAY)

    const result = await checkIn(AMARA_ACTOR, stepless!.id, 'worse')

    expect(result.outcome).toEqual({ kind: 'professional', reason: 'worse-after-pause' })
    expect(result.response).toEqual(ESCALATIONS['worse-after-pause'])
    expect(await row(stepless!.id)).toMatchObject({ state: 'escalated' })
  })

  it('does not change the pauses of the other steps', async () => {
    const first = await harm()
    const second = await harm()
    world.now = at(3 * DAY)

    await checkIn(AMARA_ACTOR, first.paused!.id, 'worse')

    expect(await row(second.paused!.id)).toMatchObject({ state: 'paused', checkDay: CHECK_DAY })
  })
})

describe('an escalated step', () => {
  it('is never due again, and cannot be answered again', async () => {
    const made = await harm()
    world.now = at(3 * DAY)
    await checkIn(AMARA_ACTOR, made.paused!.id, 'worse')

    expect(await dueIds(dayAt(400))).toEqual([])
    expect(await errorOf(checkIn(AMARA_ACTOR, made.paused!.id, 'same'))).toMatchObject({ code: 'PAUSE_NOT_FOUND' })
  })

  it('stays out of the routine: the overlay shows it as paused, for any day', async () => {
    const made = await harm()
    world.now = at(3 * DAY)
    await checkIn(AMARA_ACTOR, made.paused!.id, 'worse')

    for (const day of [dayAt(3), dayAt(40)]) {
      expect(await service.stateFor(AMARA, day)).toEqual({ pauses: [{ step: 'treat', productId: 'prod-treat', state: 'paused' }], held: true })
    }
  })

  it('holds its step: the next harm log pauses another step, never the escalated one again', async () => {
    const made = await harm()
    world.now = at(3 * DAY)
    await checkIn(AMARA_ACTOR, made.paused!.id, 'worse')

    const next = await harm()

    expect(next.paused).toMatchObject({ step: 'moisturise' })
    expect(await row(made.paused!.id)).toMatchObject({ state: 'escalated' })
  })

  it('does not count towards the cap of two paused steps, which counts only paused', async () => {
    const made = await harm()
    world.now = at(3 * DAY)
    await checkIn(AMARA_ACTOR, made.paused!.id, 'worse')

    const second = await harm()
    const third = await harm()
    const fourth = await harm()

    expect(second.outcome).toEqual({ kind: 'pause', duringStepDown: false })
    expect(second.paused).toMatchObject({ step: 'moisturise' })
    expect(third.outcome).toEqual({ kind: 'pause', duringStepDown: false })
    expect(third.paused).toMatchObject({ step: 'cleanse' })
    // Moisturiser and cleanser are paused now: two. The escalated treatment is not a third.
    expect(fourth.outcome).toEqual({ kind: 'professional', reason: 'harm-while-two-paused' })
  })
})

// --- 7. the ladder in stateFor ---

describe('SkinCareService.stateFor, a step being brought back', () => {
  it.each([
    [0, 'weekly', 0],
    [6, 'weekly', 0],
    [7, 'alternate-days', 7],
    [13, 'alternate-days', 7],
  ])('on the ladder\'s day %i is on %s, with the rung\'s start (day %i) as its anchor', async (offset, frequency, anchorOffset) => {
    await bringBack()

    expect(await service.stateFor(AMARA, dayAt(3 + offset))).toEqual({ pauses: [onRung(frequency, dayAt(3 + anchorOffset))], held: false })
  })

  it('counts the weeks of a rung from the day the ladder started: a rung of two weeks keeps one anchor', async () => {
    world.ladders.set('default', structuredClone(RETINOID_LADDER))
    await bringBack()

    expect((await service.stateFor(AMARA, dayAt(3 + 13))).pauses).toEqual([onRung('weekly', dayAt(3))])
    expect((await service.stateFor(AMARA, dayAt(3 + 14))).pauses).toEqual([onRung('alternate-days', dayAt(3 + 14))])
    expect((await service.stateFor(AMARA, dayAt(3 + 20))).pauses).toEqual([onRung('alternate-days', dayAt(3 + 14))])
    expect((await service.stateFor(AMARA, dayAt(3 + 21))).pauses).toEqual([])
  })

  it('ends the ladder on the first day of the back rung: the step is omitted and the row is ended, and the day before it is not', async () => {
    const { id } = await bringBack()

    expect((await service.stateFor(AMARA, dayAt(3 + 13))).pauses).toHaveLength(1)
    expect(await row(id)).toMatchObject({ state: 'bringing-back' })

    expect(await service.stateFor(AMARA, dayAt(3 + 14))).toEqual({ pauses: [], held: false })
    expect(await row(id)).toMatchObject({ state: 'ended' })
    expect(await openPauses(AMARA)).toEqual([])
    // Back at full strength for good: later days say the same.
    expect(await service.stateFor(AMARA, dayAt(3 + 30))).toEqual({ pauses: [], held: false })
  })

  it('omits a step whose ladder has ended even when the row cannot be written, and logs ids only', async () => {
    const { id } = await bringBack()
    pauses.update = async () => {
      throw new Error('down')
    }

    const state = await service.stateFor(AMARA, dayAt(3 + 14))

    expect(state).toEqual({ pauses: [], held: false })
    expect(await row(id)).toMatchObject({ state: 'bringing-back' })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toEqual([expect.objectContaining({ profileId: AMARA })])
    expect(JSON.stringify(errors)).not.toContain('down')
  })

  it('lists a step being brought back beside a paused one', async () => {
    const first = await harm()
    await harm()
    world.now = at(3 * DAY)
    await checkIn(AMARA_ACTOR, first.paused!.id, 'calmer')

    const state = await service.stateFor(AMARA, STARTED)

    expect([...state.pauses].sort((a, b) => a.step.localeCompare(b.step))).toEqual([
      { step: 'moisturise', productId: 'prod-moisturise', state: 'paused' },
      onRung('weekly', STARTED),
    ])
  })

  it('names a no-label own product by its shelf entry, as its pause did', async () => {
    treat().productRef = { kind: 'shelf', id: 'entry-unlabelled' }
    treat().productId = null
    await bringBack()

    expect((await service.stateFor(AMARA, STARTED)).pauses).toEqual([onRung('weekly', STARTED, 'entry-unlabelled')])
  })
})

// --- 8. a harm signal on a step being brought back ---

describe('SkinCareService.log, a harm signal on a step being brought back', () => {
  const sameDayLater = () => (world.now = at(3 * DAY + HOUR))

  it('pauses that same row again, in place: the new days, this log, no same answers, and the ladder kept', async () => {
    const made = await harm()
    world.now = at(3 * DAY)
    await checkIn(AMARA_ACTOR, made.paused!.id, 'same')
    world.now = at(6 * DAY)
    await checkIn(AMARA_ACTOR, made.paused!.id, 'calmer')
    const before = await row(made.paused!.id)
    world.now = at(6 * DAY + HOUR)

    const result = await harm()

    expect(result.outcome).toEqual({ kind: 'pause', duringStepDown: false })
    expect(result.response).toMatchObject({ title: 'We paused your Treatment' })
    expect(result.paused).toEqual({ id: made.paused!.id, step: 'treat', title: 'Retinol Serum', checkDay: dayAt(9) })
    expect(await openPauses(AMARA)).toHaveLength(1)
    expect(await row(made.paused!.id)).toEqual({ ...before, state: 'paused', pausedOn: dayAt(6), checkDay: dayAt(9), sourceLogId: result.log.id, sameCount: 0 })
    expect(ladderOf(await row(made.paused!.id))).toEqual(DEFAULT_LADDER)
  })

  it('shows the step as paused again, due for a check-in three days on, and not on the ladder any more', async () => {
    const { id } = await bringBack()
    sameDayLater()

    await harm()

    expect(await service.stateFor(AMARA, STARTED)).toEqual({ pauses: [{ step: 'treat', productId: 'prod-treat', state: 'paused' }], held: false })
    expect(await dueIds(dayAt(5))).toEqual([])
    expect(await dueIds(dayAt(6))).toEqual([id])
  })

  it('never makes a second open row for the step', async () => {
    const { id } = await bringBack()
    sameDayLater()

    await harm()
    await harm()

    // The second log has no ladder to hit: it pauses another step. Still one row for the treatment.
    expect((await openPauses(AMARA)).filter((open) => open.step === 'treat').map((open) => open.id)).toEqual([id])
  })

  it('hits the ladder that was started most recently when two steps are being brought back', async () => {
    const treatment = await harm()
    const moisturiser = await harm()
    const ids = { treat: treatment.paused!.id, moisturise: moisturiser.paused!.id }
    expect(moisturiser.paused).toMatchObject({ step: 'moisturise' })

    world.now = at(3 * DAY)
    await checkIn(AMARA_ACTOR, ids.treat, 'calmer')
    world.now = at(4 * DAY)
    await checkIn(AMARA_ACTOR, ids.moisturise, 'calmer')

    const first = await harm()
    const second = await harm()

    expect(first.paused).toMatchObject({ id: ids.moisturise, step: 'moisturise' })
    expect(second.paused).toMatchObject({ id: ids.treat, step: 'treat' })
  })

  it('hits the later ladder in the other order too: it is the start of the ladder that counts, not the step or the order the rows were made in', async () => {
    const treatment = await harm()
    const moisturiser = await harm()
    world.now = at(3 * DAY)
    await checkIn(AMARA_ACTOR, moisturiser.paused!.id, 'calmer')
    world.now = at(4 * DAY)
    await checkIn(AMARA_ACTOR, treatment.paused!.id, 'calmer')

    const first = await harm()

    expect(first.paused).toMatchObject({ id: treatment.paused!.id, step: 'treat' })
    expect(await row(moisturiser.paused!.id)).toMatchObject({ state: 'bringing-back' })
  })

  it('chooses the step as before when the step being brought back is no longer in the routine with that product', async () => {
    const { id } = await bringBack()
    // A rebuild has changed the treatment's product and the hook has not run yet: the ladder is the old product's.
    treat().productId = 'prod-new-treat'
    treat().productRef = { kind: 'candidate', code: 'TREAT-2' }
    sameDayLater()

    const result = await harm()

    expect(result.paused).toMatchObject({ step: 'treat' })
    expect(result.paused!.id).not.toBe(id)
    expect(await row(result.paused!.id)).toMatchObject({ productKey: 'prod-new-treat', state: 'paused', ladderCode: null, ladderStartedOn: null })
    expect(await row(id)).not.toMatchObject({ state: 'paused' })
  })

  it('chooses the step as before when nothing is being brought back: a paused step is not re-paused', async () => {
    const made = await harm()

    const result = await harm()

    expect(result.paused).toMatchObject({ step: 'moisturise' })
    expect(await row(made.paused!.id)).toMatchObject({ state: 'paused' })
  })

  it('leaves the ladder running for a log that is not a harm signal: a red flag or a good day', async () => {
    const { id } = await bringBack()
    sameDayLater()

    await log(AMARA_ACTOR, { noticing: ['swelling'], howBad: 'mild' })
    await log(AMARA_ACTOR, { noticing: ['nothing-unusual'] })

    expect(await row(id)).toMatchObject({ state: 'bringing-back', ladderStartedOn: STARTED })
  })

  it('says nothing that breaks the wording rules: the text of the re-pause is the paused text with its step filled', async () => {
    await bringBack()
    sameDayLater()

    const result = await harm()

    for (const line of Object.values(result.response as Record<string, string | null>)) {
      if (typeof line === 'string') expect(line).not.toContain('{step}')
    }
    expect(result.response).toMatchObject({ body: 'Your skin needs a rest from your Treatment. We will ask how it feels in three days.' })
  })
})

// --- 9. undo of a re-pause, and a second calmer ---

describe('SkinCareService.undo, of a pause made again', () => {
  const repause = async () => {
    const { id } = await bringBack()
    const ladder = await row(id)
    world.now = at(3 * DAY + HOUR)
    const result = await harm()
    return { id, ladder, result }
  }

  it('puts the step back on its ladder as it was, not undone: the step never comes back at full strength', async () => {
    const { id, ladder, result } = await repause()
    world.now = at(3 * DAY + 2 * HOUR)

    const undone = await undo(AMARA_ACTOR, id)

    expect(undone).toEqual({ id, state: 'bringing-back' })
    expect(await row(id)).toMatchObject({ state: 'bringing-back', ladderCode: ladder.ladderCode, ladderStartedOn: ladder.ladderStartedOn })
    expect(await service.stateFor(AMARA, STARTED)).toEqual({ pauses: [onRung('weekly', STARTED)], held: false })
    expect((await repository.recent(AMARA, 10)).find((entry) => entry.id === result.log.id)).toMatchObject({ overridden: true })
    expect(await dueIds(dayAt(60))).toEqual([])
  })

  // The first pause was on the 15th and this one is on the 18th: the undo above is allowed only if the day of the pause is the new one.
  it('expires the day after the step was paused again', async () => {
    const { id } = await repause()
    expect(await row(id)).toMatchObject({ pausedOn: CHECK_DAY })
    world.now = at(4 * DAY)

    expect(await errorOf(undo(AMARA_ACTOR, id))).toMatchObject({ name: 'ConflictError', code: 'UNDO_EXPIRED' })
    expect(await row(id)).toMatchObject({ state: 'paused' })
  })

  it('still sets the first pause of a step to undone: it was never on a ladder', async () => {
    const made = await harm()

    expect(await undo(AMARA_ACTOR, made.paused!.id)).toEqual({ id: made.paused!.id, state: 'undone' })
    expect(await row(made.paused!.id)).toMatchObject({ state: 'undone', ladderStartedOn: null })
  })

  it('starts the ladder over at the first rung when the person answers calmer after a re-pause, with a schedule frozen afresh', async () => {
    const { id } = await bringBack()
    world.now = at(3 * DAY + HOUR)
    await harm()
    const edited: ScheduleStep[] = [{ fromWeek: 1, toWeek: 3, frequency: 'as-needed' }, { fromWeek: 4, toWeek: 4, frequency: 'back' }]
    world.ladders.set('default', edited)
    world.now = at(6 * DAY)

    const result = await checkIn(AMARA_ACTOR, id, 'calmer')

    expect(result.pause).toEqual({ id, step: 'treat', state: 'bringing-back', checkDay: null })
    expect(await row(id)).toMatchObject({ state: 'bringing-back', ladderStartedOn: dayAt(6) })
    expect(ladderOf(await row(id))).toEqual(edited)
    expect((await service.stateFor(AMARA, dayAt(6))).pauses).toEqual([onRung('as-needed', dayAt(6))])
  })
})

// --- 10. replaced starts the ladder for the new product ---

describe('SkinCareService.reconcile, a pause whose product was replaced', () => {
  const swapTreat = (over: Partial<SkinCareRoutineStep> = {}) => {
    treat().productId = 'prod-better-treat'
    treat().productRef = { kind: 'candidate', code: 'TREAT-2' }
    Object.assign(treat(), over)
  }
  const rowFor = async (productKey: string, profileId = AMARA) => (await pauses.openFor(profileId)).find((open) => open.productKey === productKey)

  it('closes the old pause and brings the new product back from its first rung, on the ladder of its own first active group, frozen', async () => {
    world.ladders.set('retinoid', structuredClone(RETINOID_LADDER))
    world.ladders.set('exfoliating-acid', structuredClone(ACID_LADDER))
    const made = await harm()
    swapTreat({ activeGroups: ['exfoliating-acid', 'benzoyl-peroxide'] })
    world.now = at(HOUR)

    await service.reconcile(AMARA)

    expect(await row(made.paused!.id)).toMatchObject({ state: 'replaced' })
    const fresh = (await rowFor('prod-better-treat'))!
    expect(fresh).toMatchObject({
      step: 'treat',
      productKey: 'prod-better-treat',
      productId: 'prod-better-treat',
      productRef: { kind: 'candidate', code: 'TREAT-2' },
      ingredientGroup: 'exfoliating-acid',
      state: 'bringing-back',
      ladderStartedOn: TODAY,
    })
    expect(ladderOf(fresh)).toEqual(ACID_LADDER)
    expect(await openPauses(AMARA)).toHaveLength(1)
    expect((await service.stateFor(AMARA, TODAY)).pauses).toEqual([onRung('as-needed', TODAY, 'prod-better-treat')])
  })

  it('uses the default ladder for a new product with no active group', async () => {
    await harm()
    swapTreat({ activeGroups: [] })

    await service.reconcile(AMARA)

    const fresh = (await rowFor('prod-better-treat'))!
    expect(fresh).toMatchObject({ state: 'bringing-back', ingredientGroup: null })
    expect(ladderOf(fresh)).toEqual(DEFAULT_LADDER)
  })

  it('starts the ladder on the local day of the reconcile, and writes no inbox row: the only reviewed line is the calmer one, which would be untrue here', async () => {
    world.zones.set(AMARA, 'Africa/Lagos')
    await harm()
    swapTreat()
    // 23:00 UTC on the 15th is the 16th in Lagos.
    world.now = at(11 * HOUR)

    await service.reconcile(AMARA)

    const fresh = (await rowFor('prod-better-treat'))!
    expect(fresh).toMatchObject({ ladderStartedOn: dayAt(1) })
    expect(world.inboxWrites.filter((write) => write.key.startsWith('bringing-back:'))).toEqual([])
  })

  it('does the same for a product that was being brought back: the new product starts at the first rung', async () => {
    const { id } = await bringBack()
    world.now = at(5 * DAY)
    swapTreat({ activeGroups: [] })

    await service.reconcile(AMARA)

    expect(await row(id)).toMatchObject({ state: 'replaced' })
    const fresh = (await rowFor('prod-better-treat'))!
    expect(fresh).toMatchObject({ state: 'bringing-back', ladderStartedOn: dayAt(5) })
    expect((await service.stateFor(AMARA, dayAt(5))).pauses).toEqual([onRung('weekly', dayAt(5), 'prod-better-treat')])
  })

  it.each([
    ['is empty', () => world.ladders.clear()],
    ['cannot be read', () => (world.ladderReadFails = true)],
  ] as [string, () => unknown][])('opens a paused row for the new product, checked in three days, when the ladder %s: the safe side', async (_name, break_) => {
    await harm()
    swapTreat()
    break_()
    world.now = at(DAY)

    await service.reconcile(AMARA)

    const fresh = (await rowFor('prod-better-treat'))!
    expect(fresh).toMatchObject({ step: 'treat', state: 'paused', checkDay: dayAt(4), ladderCode: null, ladderStartedOn: null, sameCount: 0 })
    expect(bringingBackWrites()).toEqual([])
    expect((await service.stateFor(AMARA, dayAt(1))).pauses).toEqual([{ step: 'treat', productId: 'prod-better-treat', state: 'paused' }])
    expect(await dueIds(dayAt(3))).toEqual([])
    expect(await dueIds(dayAt(4))).toEqual([fresh.id])
  })

  it('opens nothing for a step whose new product has no key to hold a pause by, or that the routine no longer has', async () => {
    const withoutKey = await harm()
    treat().productId = null
    treat().productRef = { kind: 'none' }
    await service.reconcile(AMARA)
    expect(await row(withoutKey.paused!.id)).toMatchObject({ state: 'replaced' })
    expect(await openPauses(AMARA)).toEqual([])

    const gone = await harm()
    expect(gone.paused).toMatchObject({ step: 'moisturise' })
    world.routines.get(AMARA)!.steps = world.routines.get(AMARA)!.steps.filter((entry) => entry.step !== 'moisturise')
    await service.reconcile(AMARA)
    expect(await row(gone.paused!.id)).toMatchObject({ state: 'replaced' })
    expect(await openPauses(AMARA)).toEqual([])
  })

  it('is idempotent: a second reconcile finds the new row matching the routine and does nothing', async () => {
    await harm()
    swapTreat()
    await service.reconcile(AMARA)
    const once = await openPauses(AMARA)

    await service.reconcile(AMARA)
    await service.reconcile(AMARA)

    expect(await openPauses(AMARA)).toEqual(once)
    expect(once).toHaveLength(1)
    expect(bringingBackWrites()).toHaveLength(0)
  })

  it('starts the ladder when a read heals a rebuild whose hook was missed: the next read lists the new product being brought back', async () => {
    await harm()
    swapTreat({ activeGroups: [] })

    await service.stateFor(AMARA, TODAY)

    expect((await service.stateFor(AMARA, TODAY)).pauses).toEqual([onRung('weekly', TODAY, 'prod-better-treat')])
  })

  it('leaves the other steps\' pauses alone', async () => {
    const made = await harm()
    const other = await harm()
    treat().productId = 'prod-better-treat'

    await service.reconcile(AMARA)

    expect(await row(other.paused!.id)).toMatchObject({ state: 'paused', ladderCode: null })
    expect(await row(made.paused!.id)).toMatchObject({ state: 'replaced' })
  })

  it('opens the row and leaves the inbox alone, so a broken inbox changes nothing', async () => {
    await harm()
    swapTreat()
    world.inboxFails = true

    await service.reconcile(AMARA)

    expect(await rowFor('prod-better-treat')).toMatchObject({ state: 'bringing-back' })
    expect(errors).toEqual([])
  })
})

// --- review fixes ---

describe('SkinCareService.stateFor, when reconcile fails', () => {
  const swapTreat = () => {
    treat().productId = 'prod-better-treat'
    treat().productRef = { kind: 'candidate', code: 'TREAT-2' }
  }
  const rowsFor = async (productKey: string) => (await openPauses(AMARA)).filter((open) => open.productKey === productKey)

  it('accepts a competing request having opened the new product\'s row first (the insert hits the unique index): it lists that row, once', async () => {
    await harm()
    swapTreat()
    const insert = pauses.insert.bind(pauses)
    let calls = 0
    pauses.insert = async (pause) => {
      if (calls++ > 0) return insert(pause)
      await insert({ ...pause, id: crypto.randomUUID() })
      throw new Error('UNIQUE constraint failed')
    }

    const state = await service.stateFor(AMARA, TODAY)

    expect(state).toEqual({ pauses: [onRung('weekly', TODAY, 'prod-better-treat')], held: false })
    expect(await rowsFor('prod-better-treat')).toHaveLength(1)
    expect(await openPauses(AMARA)).toHaveLength(1)
  })

  it('rejects, rather than show the replaced step as active, when the new product\'s row cannot be written', async () => {
    const made = await harm()
    swapTreat()
    pauses.insert = async () => {
      throw new Error('down')
    }

    await expect(service.stateFor(AMARA, TODAY)).rejects.toThrow()

    expect(await row(made.paused!.id)).toMatchObject({ state: 'paused' })
    expect(JSON.stringify(errors)).not.toContain('down')
  })

  it('rejects when the routine could not be read for the reconcile and the pause it held has been replaced since: it re-reads, and the old pause no longer holds its step', async () => {
    await harm()
    swapTreat()
    let reads = 0
    const read = world.routines.get(AMARA)
    world.routines = new Map([[AMARA, read!]])
    const serviceReading = new SkinCareService({
      repository,
      pauses,
      holds: new FakeEscalationHoldsRepository(),
      safety: { markReactionProduct: async () => ({ marked: false }) },
      verdicts: { savedFor: async () => null },
      catalog: { namedProduct: async () => Promise.reject(new Error('unused')) },
      workbook: { responseFor: async (o) => world.responses[o] ?? null, escalationFor: async () => null, reintroductionFor: async () => structuredClone(DEFAULT_LADDER) },
      reminders: { zoneFor: async () => null },
      routine: {
        stepDownRunning: async () => false,
        skinCareRoutineFor: async () => {
          if (reads++ === 0) throw new Error('routine read failed')
          return structuredClone(read!)
        },
      },
      inbox: { write: async () => ({ id: 'row', created: true }) },
      now: () => world.now,
    })

    await expect(serviceReading.stateFor(AMARA, TODAY)).rejects.toThrow()
  })

  it('is still not fatal when the routine cannot be read at all: the pauses are answered, as they were', async () => {
    await harm()
    const failing = new SkinCareService({
      repository,
      pauses,
      holds: new FakeEscalationHoldsRepository(),
      safety: { markReactionProduct: async () => ({ marked: false }) },
      verdicts: { savedFor: async () => null },
      catalog: { namedProduct: async () => Promise.reject(new Error('unused')) },
      workbook: { responseFor: async () => null, escalationFor: async () => null, reintroductionFor: async () => [] },
      reminders: { zoneFor: async () => null },
      routine: {
        stepDownRunning: async () => false,
        skinCareRoutineFor: async () => {
          throw new Error('routine read failed')
        },
      },
      inbox: { write: async () => ({ id: 'row', created: true }) },
      now: () => world.now,
    })

    expect((await failing.stateFor(AMARA, TODAY)).pauses).toEqual([{ step: 'treat', productId: 'prod-treat', state: 'paused' }])
  })
})

describe('SkinCareService.reconcile, an escalated step whose product was replaced', () => {
  it('opens the new product\'s row as escalated: no ladder, no inbox row, the step stays out and is never due', async () => {
    const made = await harm()
    world.now = at(3 * DAY)
    await checkIn(AMARA_ACTOR, made.paused!.id, 'worse')
    treat().productId = 'prod-better-treat'
    treat().productRef = { kind: 'candidate', code: 'TREAT-2' }

    await service.reconcile(AMARA)

    expect(await row(made.paused!.id)).toMatchObject({ state: 'replaced' })
    const fresh = (await openPauses(AMARA)).find((open) => open.productKey === 'prod-better-treat')!
    expect(fresh).toMatchObject({ step: 'treat', state: 'escalated', ladderCode: null, ladderStartedOn: null })
    expect(world.inboxWrites.filter((write) => write.key.startsWith('bringing-back:'))).toEqual([])
    expect(await service.stateFor(AMARA, dayAt(3))).toEqual({ pauses: [{ step: 'treat', productId: 'prod-better-treat', state: 'paused' }], held: true })
    expect(await dueIds(dayAt(400))).toEqual([])
    expect(await errorOf(checkIn(AMARA_ACTOR, fresh.id, 'calmer'))).toMatchObject({ code: 'PAUSE_NOT_FOUND' })
  })

  it('is idempotent', async () => {
    const made = await harm()
    world.now = at(3 * DAY)
    await checkIn(AMARA_ACTOR, made.paused!.id, 'worse')
    treat().productId = 'prod-better-treat'
    treat().productRef = { kind: 'candidate', code: 'TREAT-2' }
    await service.reconcile(AMARA)
    const once = await openPauses(AMARA)

    await service.reconcile(AMARA)

    expect(await openPauses(AMARA)).toEqual(once)
    expect(once).toHaveLength(1)
  })
})

describe('SkinCareService.log, the cap of two and a step being brought back', () => {
  /** Cleanser on a ladder (it is the one active step then), its product stale while treatment and moisturiser are paused, and then back in the routine: two paused and a ladder running. */
  const twoPausedAndALadder = async () => {
    const cleanse = world.routines.get(AMARA)!.steps.find((entry) => entry.step === 'cleanse')!
    treat().activeGroups = []
    cleanse.activeGroups = ['exfoliating-acid']
    cleanse.changedOn = dayAt(-1)
    const first = await harm()
    expect(first.paused).toMatchObject({ step: 'cleanse' })
    world.now = at(3 * DAY)
    await checkIn(AMARA_ACTOR, first.paused!.id, 'calmer')
    world.now = at(3 * DAY + HOUR)
    // The cleanser's product is no longer one the routine can key a pause by, so the ladder is stale and the next two harm logs pause the other steps.
    const key = [cleanse.productId, cleanse.productRef] as const
    cleanse.productId = null
    cleanse.productRef = { kind: 'none' }
    const second = await harm()
    const third = await harm()
    expect([second.paused?.step, third.paused?.step].sort()).toEqual(['moisturise', 'treat'])
    cleanse.productId = key[0]
    cleanse.productRef = key[1]
    return { ladder: first.paused!.id }
  }

  it('is still the cap\'s professional result, and the ladder row is paused again in place so it never keeps running', async () => {
    const { ladder } = await twoPausedAndALadder()
    world.now = at(3 * DAY + 2 * HOUR)

    const result = await harm()

    expect(result.outcome).toEqual({ kind: 'professional', reason: 'harm-while-two-paused' })
    expect(result.paused).toBeNull()
    expect(await row(ladder)).toMatchObject({ state: 'paused', pausedOn: dayAt(3), checkDay: dayAt(6), sameCount: 0, sourceLogId: result.log.id })
    expect(ladderOf(await row(ladder))).toEqual(DEFAULT_LADDER)
    expect((await service.stateFor(AMARA, dayAt(3))).pauses.map((entry) => entry.state)).toEqual(['paused', 'paused', 'paused'])
  })

  it('still answers the cap when the ladder row cannot be paused again, and logs ids only', async () => {
    const { ladder } = await twoPausedAndALadder()
    world.now = at(3 * DAY + 2 * HOUR)
    pauses.rePause = async () => {
      throw new Error('down')
    }
    errors.length = 0

    const result = await harm()

    expect(result.outcome).toEqual({ kind: 'professional', reason: 'harm-while-two-paused' })
    expect(await row(ladder)).toMatchObject({ state: 'bringing-back' })
    expect(errors).toEqual([[expect.objectContaining({ profileId: AMARA })]])
    expect(JSON.stringify(errors)).not.toContain('down')
  })
})

describe('SkinCareService.stateFor, a ladder that cannot be read', () => {
  const corrupt = (name: string, code: string) => [name, code] as const
  const CORRUPT = [
    corrupt('a null rung', '[null]'),
    corrupt('a week no date can hold', JSON.stringify([{ fromWeek: 1, toWeek: 1, frequency: 'weekly' }, { fromWeek: 1e20, toWeek: 1e20, frequency: 'back' }])),
    corrupt('rungs out of order', JSON.stringify([{ fromWeek: 3, toWeek: 3, frequency: 'back' }, { fromWeek: 1, toWeek: 2, frequency: 'weekly' }])),
    corrupt('a first rung before week 1', JSON.stringify([{ fromWeek: 0, toWeek: 1, frequency: 'weekly' }, { fromWeek: 2, toWeek: 2, frequency: 'back' }])),
    corrupt('a ladder that does not start at week 1', JSON.stringify([{ fromWeek: 2, toWeek: 2, frequency: 'weekly' }, { fromWeek: 3, toWeek: 3, frequency: 'back' }])),
    corrupt('a ladder that does not end with back', JSON.stringify([{ fromWeek: 1, toWeek: 1, frequency: 'weekly' }, { fromWeek: 2, toWeek: 2, frequency: 'alternate-days' }])),
    corrupt('a rung that ends before it starts', JSON.stringify([{ fromWeek: 2, toWeek: 1, frequency: 'weekly' }, { fromWeek: 3, toWeek: 3, frequency: 'back' }])),
    corrupt('a frequency nobody knows', JSON.stringify([{ fromWeek: 1, toWeek: 1, frequency: 'hourly' }, { fromWeek: 2, toWeek: 2, frequency: 'back' }])),
    corrupt('text that is not JSON', 'not json'),
  ]

  it.each(CORRUPT)('does not fail the read for %s: the step is shown paused and the pause is made due now, to ask again', async (_name, code) => {
    const { id } = await bringBack()
    await pauses.update(AMARA, id, { ladderCode: code })

    const state = await service.stateFor(AMARA, STARTED)

    expect(state).toEqual({ pauses: [{ step: 'treat', productId: 'prod-treat', state: 'paused' }], held: false })
    const stored = await row(id)
    expect(stored).toMatchObject({ state: 'paused', checkDay: STARTED, pausedOn: STARTED, sameCount: 0, sourceLogId: (await row(id)).sourceLogId })
    expect(await dueIds(STARTED)).toEqual([id])
  })

  it('keeps the log the pause came from, and a Calmer answer then freezes a fresh ladder', async () => {
    const { id } = await bringBack()
    const before = await row(id)
    await pauses.update(AMARA, id, { ladderCode: '[null]' })
    await service.stateFor(AMARA, STARTED)
    expect(await row(id)).toMatchObject({ sourceLogId: before.sourceLogId })

    const result = await checkIn(AMARA_ACTOR, id, 'calmer')

    expect(result.pause).toMatchObject({ state: 'bringing-back' })
    expect(ladderOf(await row(id))).toEqual(DEFAULT_LADDER)
  })

  it('still shows the step paused when the row cannot be written, and logs ids only', async () => {
    const { id } = await bringBack()
    await pauses.update(AMARA, id, { ladderCode: '[null]' })
    pauses.rePause = async () => {
      throw new Error('down')
    }
    errors.length = 0

    const state = await service.stateFor(AMARA, STARTED)

    expect(state.pauses).toEqual([{ step: 'treat', productId: 'prod-treat', state: 'paused' }])
    expect(await row(id)).toMatchObject({ state: 'bringing-back' })
    expect(errors.map((line) => line[0])).toEqual(expect.arrayContaining([expect.objectContaining({ profileId: AMARA, pauseId: id })]))
    expect(JSON.stringify(errors)).not.toContain('down')
  })
})

describe('SkinCareService.undo, a pause the person did not make', () => {
  it('answers 404 PAUSE_NOT_FOUND for the paused row a replacement opens when there is no ladder, and leaves it', async () => {
    await harm()
    treat().productId = 'prod-better-treat'
    treat().productRef = { kind: 'candidate', code: 'TREAT-2' }
    world.ladders.clear()
    await service.reconcile(AMARA)
    const fresh = (await openPauses(AMARA)).find((open) => open.productKey === 'prod-better-treat')!
    expect(fresh).toMatchObject({ state: 'paused', sourceLogId: null })

    expect(await errorOf(undo(AMARA_ACTOR, fresh.id))).toMatchObject({ name: 'NotFoundError', code: 'PAUSE_NOT_FOUND' })
    expect(await row(fresh.id)).toMatchObject({ state: 'paused' })
  })
})

// --- best effort ---

describe('SkinCareService.answerCheckIn, when the inbox cannot be written', () => {
  it('still brings the step back and answers, and logs ids only', async () => {
    world.inboxFails = true
    const made = await harm()
    errors.length = 0
    world.now = at(3 * DAY)

    const result = await checkIn(AMARA_ACTOR, made.paused!.id, 'calmer')

    expect(result.pause).toMatchObject({ state: 'bringing-back' })
    expect(await row(made.paused!.id)).toMatchObject({ state: 'bringing-back', ladderStartedOn: STARTED })
    expect(errors).toEqual([[expect.objectContaining({ profileId: AMARA, pauseId: made.paused!.id })]])
    expect(JSON.stringify(errors)).not.toContain('Good news')
  })
})

// --- 12. wording ---

describe('what the check-in says', () => {
  it('breaks none of the wording rules once {step} is filled: the answers and the inbox rows, for a step and for none', async () => {
    const lines: string[] = []
    const collect = (value: unknown) => lines.push(...Object.values(value as Record<string, string | null>).filter((line): line is string => typeof line === 'string'))
    const calmer = await bringBack()
    collect(calmer.answered.response)
    const second = await harm()
    world.now = at(6 * DAY)
    collect((await checkIn(AMARA_ACTOR, second.paused!.id, 'same')).response)
    world.routines.set(TOLU, null)
    world.now = at(6 * DAY + HOUR)
    await harm(TOLU_ACTOR)
    const [stepless] = await openPauses(TOLU)
    world.now = at(9 * DAY)
    collect((await checkIn(TOLU_ACTOR, stepless!.id, 'same')).response)
    for (const write of world.inboxWrites) lines.push(write.title, write.body)

    expect(lines.length).toBeGreaterThanOrEqual(9)
    for (const line of lines) {
      expect(line).not.toContain('{step}')
      for (const { code, pattern } of FORBIDDEN_WORDING) expect(pattern.test(line), `"${line}" trips ${code}`).toBe(false)
    }
  })
})
