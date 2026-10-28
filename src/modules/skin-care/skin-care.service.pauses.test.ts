import { beforeEach, describe, expect, it } from 'vitest'
import { type Actor, runAs } from '../../lib/context'
import type { EscalationReason, ResponseOutcome, RoutineStep } from '../catalog/catalog.vocabulary'
import type { CatalogWorkbookService, Escalation, Response } from '../catalog/catalog.workbook.service'
import { FakeInboxRepository } from '../inbox/inbox.repository.fake'
import { type InboxWrite, InboxService } from '../inbox/inbox.service'
import { FORBIDDEN_WORDING } from '../routines/routines.wording'
import { FakeSkinCareRepository } from './skin-care.repository.fake'
import { FakeStepPausesRepository } from './skin-care.pauses.repository.fake'
import { SkinCareService } from './skin-care.service'
import type { ScheduleStep } from '../catalog/catalog.workbook.schema'
import type { SkinCareRoutine, SkinCareRoutineStep, StepPause } from './skin-care.types'

// Pausing a step, choosing it, Undo, reconcile and stateFor (spec #233, PR 4b). The service is tested at its own seam with a world fake: one mutable clock, the stored time
// zones, the reviewed text of the workbook, the routine in force and whether a step-down is running. The skin-log repository, the pauses repository and the inbox service
// (over its own fake repository) are the real fakes. The pure choice of the step is skin-care.step-choice.test.ts's; here it is only what `log` does with it.
//
// THE CONTRACT THIS FILE PINS (assumed: the brief names the behaviour; the constructor and the shapes follow SkinCareService today):
//   new SkinCareService({ repository, pauses, workbook, reminders, routine, inbox, now? })
//     repository  SkinCareRepository        the logs, as before
//     pauses      StepPausesRepository      insert, find, openFor, update (skin-care.pauses.repository.contract.ts)
//     workbook    Pick<CatalogWorkbookService, 'responseFor' | 'escalationFor'>
//     reminders   Pick<RemindersService, 'zoneFor'>
//     routine     { stepDownRunning(profileId, today): Promise<boolean>; skinCareRoutineFor(profileId): Promise<SkinCareRoutine | null> }   both RoutineViewerService's, lazily wired
//     inbox       Pick<InboxService, 'write'>
//   log(input): Promise<LogResult>   LogResult = { log, outcome, response, paused }, where `outcome` is now the FINAL action and `log.outcome` (and the stored log) says the same:
//       { kind: 'pause', duringStepDown } with response = the reviewed `paused` Response and paused = { id, step, title, checkDay }
//       { kind: 'professional', reason: 'harm-while-two-paused' | 'hard-to-ignore-during-step-down' } with the reviewed Escalation & { facts } and paused = null
//       { kind: 'nothing-to-pause' } with the reviewed `nothing-to-pause` Response and paused = null
//       every other outcome as in skin-care.service.test.ts, with paused = null
//     paused.step is the step; paused.title is the routine's own title for the step (SkinCareRoutineStep.title); paused.checkDay is 'YYYY-MM-DD'.
//     Turning a pause outcome into an action (owner rules, #233):
//       - two steps already `paused` (state 'paused' only; a stepless row is not a step): professional, reason harm-while-two-paused. Checked first, so it also beats a step-down's rule.
//       - duringStepDown: the step is chosen among the ACTIVE steps only (never the basics); none left -> professional hard-to-ignore-during-step-down.
//       - no routine, a routine not started (dayOne null), or nothing pausable (stepToPause answers null): nothing-to-pause, a stepless pause row (step null, productId null,
//         productKey '') with check day = local day + 3. A profile has ONE open stepless check-in (owner decision, #233): a nothing-to-pause log while one is open reuses that row
//         and moves its check day to the new local day + 3; it adds no row. Once the row is closed the next such log opens a new one.
//       - otherwise stepToPause chooses the step; the pause row is made with check day = local day + 3, and every OTHER open 'paused' row's check day moves to the same day.
//     The pause row: { profileId, step, productKey, productId, productRef, ingredientGroup, state 'paused', pausedOn: local day, checkDay, sameCount 0, sourceLogId: the log's id }.
//     productKey is the step's catalog productId when it has one, else the shelf entry id of its productRef; ingredientGroup is the first of the step's activeGroups, else null.
//     A pause is made BEFORE the reviewed text is looked up (as the log is stored first): a missing reviewed row is 503 CONTENT_UNAVAILABLE and the pause stands.
//     {step} in the reviewed title, body and whatToDoNow is filled with the plain noun (Cleanser, Treatment, Moisturiser), "your routine" for nothing-to-pause.
//     A pause writes one inbox row: { profileId, kind: 'paused', day: local day, title, body (the filled paused text), link: '/routine', key: `paused:${pauseId}` }.
//     No other outcome writes an inbox row in this PR.
//   undo(pauseId): Promise<{ id: string; state: 'undone' }>   by session. Same local day only (the pause's frozen pausedOn against today in the zone stored now).
//       401 AUTH_REQUIRED, 403 SIGNUP_REQUIRED (a guest), 404 PAUSE_NOT_FOUND (another profile's pause, none, or one that is no longer 'paused': undone twice, or replaced), 409 UNDO_EXPIRED after the day.
//       Sets the pause to 'undone' and marks its source log overridden (the log is kept); nothing else, and never a professional log.
//   reconcile(profileId): Promise<void>   by profile id. For each open pause with a step: kept when the routine still has that step with the same product key; set to 'replaced'
//       when the step now has another product key. No routine (null) changes nothing. Idempotent. (From PR 5 the new product is brought back on a ladder: skin-care.service.check-ins.test.ts.)
//   stateFor(profileId, today): Promise<SkinCareState>   { pauses: the profile's open 'paused' rows that have a step, as { step, productId: the row's productKey, state: 'paused' }, held: false }.
//       productId carries the pause's product KEY, so a no-label own product (productId null in the routine) is paused under its shelf entry id. A storage failure rejects: it
//       never answers "no pauses".

// Every date hangs off this one instant (the clock) and its UTC day; fixtures are offsets from them.
const T0 = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs)
const dayAt = (offsetDays: number) => at(offsetDays * DAY).toISOString().slice(0, 10)
const TODAY = dayAt(0)

const AMARA_USER = 'user-amara'
const AMARA = 'profile-amara'
const TOLU_USER = 'user-tolu'
const TOLU = 'profile-tolu'

const actor = (userId: string, profileId: string, status: 'anonymous' | 'verified' = 'verified'): Actor => ({ kind: 'user', userId, status, profileId })
const AMARA_ACTOR = actor(AMARA_USER, AMARA)
const TOLU_ACTOR = actor(TOLU_USER, TOLU)
const GUEST = actor('user-guest', 'profile-guest', 'anonymous')
const PUBLIC: Actor = { kind: 'public' }

// The ladder the workbook gives every group here (PR 5: a replaced product is brought back on one).
const LADDER: ScheduleStep[] = [
  { fromWeek: 1, toWeek: 1, frequency: 'weekly' },
  { fromWeek: 2, toWeek: 2, frequency: 'back' },
]

const PAUSED_TEXT: Response = {
  title: 'We paused your {step}',
  body: 'Your skin needs a rest from your {step}. We will ask how it feels in three days.',
  whatToDoNow: 'Skip anything that stings. Keep sunscreen if it does not sting.',
}
const NOTHING_TEXT: Response = {
  title: 'Nothing to pause yet',
  body: 'Skip anything that stings and rinse with water. Keep {step} simple until it settles.',
  whatToDoNow: 'Keep sunscreen if it does not sting.',
}
const ESCALATIONS: Partial<Record<EscalationReason, Escalation>> = {
  'harm-while-two-paused': { whoToSee: 'A doctor or pharmacist.', howSoon: 'Within a day.', whatToTellThem: 'Which steps are paused and what you noticed.' },
  'hard-to-ignore-during-step-down': { whoToSee: 'A doctor or pharmacist about a strong flare.', howSoon: 'Today.', whatToTellThem: 'What you noticed and the cream you are stepping down.' },
  swelling: { whoToSee: 'A doctor or pharmacist about swelling.', howSoon: 'Today.', whatToTellThem: 'Where it swelled and since when.' },
}

const NOUN: Record<'cleanse' | 'treat' | 'moisturise', string> = { cleanse: 'Cleanser', treat: 'Treatment', moisturise: 'Moisturiser' }

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
  stepDown: boolean
  routines: Map<string, SkinCareRoutine | null>
  responses: Partial<Record<ResponseOutcome, Response>>
  escalations: Partial<Record<EscalationReason, Escalation>>
  inboxWrites: InboxWrite[]
}
let world: World
let repository: FakeSkinCareRepository
let pauses: FakeStepPausesRepository
let inboxRows: InboxService
let service: SkinCareService

const makeService = () =>
  new SkinCareService({
    repository,
    pauses,
    workbook: {
      responseFor: async (outcome) => world.responses[outcome] ?? null,
      escalationFor: async (reason) => world.escalations[reason] ?? null,
      reintroductionFor: async () => structuredClone(LADDER),
    } satisfies Pick<CatalogWorkbookService, 'responseFor' | 'escalationFor' | 'reintroductionFor'>,
    reminders: { zoneFor: async (profileId: string) => world.zones.get(profileId) ?? null },
    routine: {
      stepDownRunning: async () => world.stepDown,
      skinCareRoutineFor: async (profileId: string) => {
        const routine = world.routines.get(profileId) ?? null
        return routine === null ? null : { ...structuredClone(routine), stepDownRunning: world.stepDown }
      },
    },
    inbox: {
      write: async (input: InboxWrite) => {
        world.inboxWrites.push(input)
        return inboxRows.write(input)
      },
    },
    now: () => world.now,
  })

type LogInput = Parameters<SkinCareService['log']>[0]
const log = (who: Actor, input: LogInput) => runAs(who, () => service.log(input))
const undo = (who: Actor, pauseId: string) => runAs(who, () => service.undo(pauseId))
const stored = (profileId: string) => repository.recent(profileId, 100)
const openPauses = (profileId: string) => pauses.openFor(profileId)
const stepsOf = (rows: StepPause[]) => rows.map((row) => row.step)

const STING: LogInput = { noticing: ['stinging-or-burning'], howBad: 'mild' }
const STRONG_REDNESS: LogInput = { noticing: ['new-redness'], howBad: 'hard-to-ignore' }
const harm = (who: Actor = AMARA_ACTOR) => log(who, STING)

beforeEach(() => {
  world = {
    now: T0,
    zones: new Map(),
    stepDown: false,
    routines: new Map([[AMARA, amarasRoutine()], [TOLU, amarasRoutine()]]),
    responses: { paused: { ...PAUSED_TEXT }, 'nothing-to-pause': { ...NOTHING_TEXT }, 'check-calmer': { title: 'Good news about {step}', body: 'We will bring {step} back slowly.', whatToDoNow: null } },
    escalations: { ...ESCALATIONS },
    inboxWrites: [],
  }
  repository = new FakeSkinCareRepository()
  pauses = new FakeStepPausesRepository()
  inboxRows = new InboxService({ repository: new FakeInboxRepository(), now: () => world.now })
  service = makeService()
})

describe('SkinCareService.log, a pause outcome pauses a step', () => {
  it('pauses the newest active step: the answer, the reviewed text with {step} filled, and the log as it was decided', async () => {
    const result = await harm()

    expect(result.outcome).toEqual({ kind: 'pause', duringStepDown: false })
    expect(result.response).toEqual({
      title: 'We paused your Treatment',
      body: 'Your skin needs a rest from your Treatment. We will ask how it feels in three days.',
      whatToDoNow: 'Skip anything that stings. Keep sunscreen if it does not sting.',
    })
    expect(result.paused).toEqual({ id: expect.any(String), step: 'treat', title: 'Retinol Serum', checkDay: dayAt(3) })
    expect(result.log).toMatchObject({ outcome: 'pause', noticing: ['stinging-or-burning'], howBad: 'mild' })
    expect((await stored(AMARA))[0]).toMatchObject({ id: result.log.id, outcome: 'pause', reason: null, overridden: false })
  })

  it('stores the pause with the step\'s identity, the frozen group, the local days and the log that caused it', async () => {
    const result = await harm()

    expect(await openPauses(AMARA)).toMatchObject([
      {
        id: result.paused!.id,
        profileId: AMARA,
        step: 'treat',
        productKey: 'prod-treat',
        productId: 'prod-treat',
        productRef: { kind: 'candidate', code: 'TREAT-1' },
        ingredientGroup: 'retinoid',
        state: 'paused',
        pausedOn: TODAY,
        checkDay: dayAt(3),
        sameCount: 0,
        sourceLogId: result.log.id,
        ladderCode: null,
        ladderStartedOn: null,
        createdAt: T0,
      },
    ])
  })

  it('freezes the first of the step\'s active groups on the pause, and none for a step with no active group', async () => {
    world.routines.get(AMARA)!.steps.find((s) => s.step === 'treat')!.activeGroups = ['retinoid', 'exfoliating-acid']
    const active = await harm()
    world.routines.get(TOLU)!.steps.find((s) => s.step === 'treat')!.activeGroups = []
    const plain = await harm(TOLU_ACTOR)

    expect((await openPauses(AMARA))[0]).toMatchObject({ id: active.paused!.id, ingredientGroup: 'retinoid' })
    expect((await openPauses(TOLU))[0]).toMatchObject({ id: plain.paused!.id, ingredientGroup: null })
  })

  it('pauses for new redness and for any symptom at hard to ignore alike', async () => {
    expect((await log(AMARA_ACTOR, { noticing: ['new-redness'], howBad: 'noticeable' })).paused).toMatchObject({ step: 'treat' })
    expect((await log(TOLU_ACTOR, { noticing: ['itching'], howBad: 'hard-to-ignore' })).paused).toMatchObject({ step: 'treat' })
  })

  it('pauses the most recently changed step when no step is active, and never the sunscreen', async () => {
    const routine = world.routines.get(AMARA)!
    routine.steps.find((s) => s.step === 'treat')!.activeGroups = []
    routine.steps.find((s) => s.step === 'protect')!.changedOn = dayAt(-1)
    routine.steps.find((s) => s.step === 'moisturise')!.changedOn = dayAt(-2)

    const result = await harm()

    expect(result.paused).toMatchObject({ step: 'moisturise' })
    expect(result.response).toMatchObject({ title: 'We paused your Moisturiser' })
  })

  it.each([
    ['cleanse', 'Cleanser'],
    ['treat', 'Treatment'],
    ['moisturise', 'Moisturiser'],
  ] as ['cleanse' | 'treat' | 'moisturise', string][])('fills {step} with the plain noun of the %s step, not the product title', async (name, noun) => {
    const routine = world.routines.get(AMARA)!
    for (const entry of routine.steps) entry.activeGroups = entry.step === name ? ['retinoid'] : []

    const result = await harm()

    expect(NOUN[name]).toBe(noun)
    expect(result.paused).toMatchObject({ step: name })
    expect(result.response).toMatchObject({ title: `We paused your ${noun}`, body: `Your skin needs a rest from your ${noun}. We will ask how it feels in three days.` })
    expect(JSON.stringify(result.response)).not.toContain('{step}')
    expect(JSON.stringify(result.response)).not.toContain(routine.steps.find((s) => s.step === name)!.title)
  })

  it('leaves the other steps alone: only the one pause is open', async () => {
    await harm()

    expect(stepsOf(await openPauses(AMARA))).toEqual(['treat'])
  })

  it('pauses a second harm log\'s next step by the same rule, never the one already paused', async () => {
    const first = await harm()
    const second = await harm()

    expect(first.paused).toMatchObject({ step: 'treat' })
    // No active step is left; the moisturiser changed after the cleanser.
    expect(second.paused).toMatchObject({ step: 'moisturise' })
    expect(stepsOf(await openPauses(AMARA)).sort()).toEqual(['moisturise', 'treat'])
  })

  it('keeps each profile\'s pauses apart', async () => {
    await harm(AMARA_ACTOR)

    expect(await openPauses(TOLU)).toEqual([])
    expect(await openPauses(AMARA)).toHaveLength(1)
  })

  it('says nothing that breaks the wording rules once {step} is filled, on a pause and on nothing to pause', async () => {
    const lines: string[] = []
    const collect = (result: { outcome: { kind: string }; response: unknown }, kind: string) => {
      expect(result.outcome.kind).toBe(kind)
      lines.push(...Object.values(result.response as Record<string, string | null>).filter((value): value is string => typeof value === 'string'))
    }
    collect(await harm(), 'pause')
    collect(await harm(), 'pause')
    // Amara has two steps paused now; Tolu has no routine at all.
    world.routines.set(TOLU, null)
    collect(await harm(TOLU_ACTOR), 'nothing-to-pause')

    expect(lines).toHaveLength(9)
    for (const line of lines) {
      expect(line).not.toContain('{step}')
      for (const { code, pattern } of FORBIDDEN_WORDING) expect(pattern.test(line), `"${line}" trips ${code}`).toBe(false)
    }
  })
})

describe('SkinCareService.log, the check day', () => {
  it('is three local days on from the day of the pause', async () => {
    expect((await harm()).paused!.checkDay).toBe('2030-06-18')
  })

  it('carries over the end of a month', async () => {
    world.now = at(14 * DAY)

    const result = await harm()

    expect(dayAt(14)).toBe('2030-06-29')
    expect(result.paused!.checkDay).toBe('2030-07-02')
    expect((await openPauses(AMARA))[0]).toMatchObject({ pausedOn: '2030-06-29', checkDay: '2030-07-02' })
  })

  it.each([
    ['Africa/Lagos', 11 * HOUR - 1, '2030-06-15', '2030-06-18'],
    ['Africa/Lagos', 11 * HOUR, '2030-06-16', '2030-06-19'],
    ['America/New_York', 16 * HOUR - 1, '2030-06-15', '2030-06-18'],
    ['America/New_York', 16 * HOUR, '2030-06-16', '2030-06-19'],
    [null, 12 * HOUR - 1, '2030-06-15', '2030-06-18'],
    [null, 12 * HOUR, '2030-06-16', '2030-06-19'],
  ] as [string | null, number, string, string][])('counts from the person\'s own day: in %s at T0 + %i ms the pause is on %s and checked on %s', async (zone, offset, pausedOn, checkDay) => {
    world.zones.set(AMARA, zone)
    world.now = at(offset)

    const result = await harm()

    expect(result.paused!.checkDay).toBe(checkDay)
    expect((await openPauses(AMARA))[0]).toMatchObject({ pausedOn, checkDay })
  })

  it('moves the check day of every other open paused step to the new pause\'s check day', async () => {
    const first = await harm()
    world.now = at(2 * DAY)

    const second = await harm()

    expect(first.paused!.checkDay).toBe(dayAt(3))
    expect(second.paused!.checkDay).toBe(dayAt(5))
    const rows = await openPauses(AMARA)
    expect(rows.map((row) => [row.id, row.checkDay, row.pausedOn])).toEqual([
      [first.paused!.id, dayAt(5), TODAY],
      [second.paused!.id, dayAt(5), dayAt(2)],
    ])
  })

  it('leaves a closed pause\'s check day where it was', async () => {
    const first = await harm()
    await undo(AMARA_ACTOR, first.paused!.id)
    world.now = at(DAY)

    const second = await harm()

    expect(second.paused).toMatchObject({ step: 'treat', checkDay: dayAt(4) })
    expect(await pauses.find(AMARA, first.paused!.id)).toMatchObject({ state: 'undone', checkDay: dayAt(3) })
  })

  it('does not move another profile\'s check days', async () => {
    const toluFirst = await harm(TOLU_ACTOR)
    world.now = at(DAY)

    await harm(AMARA_ACTOR)

    expect(await pauses.find(TOLU, toluFirst.paused!.id)).toMatchObject({ checkDay: dayAt(3) })
  })
})

describe('SkinCareService.log, pause identity', () => {
  it('keys a pause by the catalog product when the step has one', async () => {
    const result = await harm()

    expect(await pauses.find(AMARA, result.paused!.id)).toMatchObject({ productKey: 'prod-treat', productId: 'prod-treat' })
  })

  it('keys a no-label own product by its shelf entry, so it can be paused', async () => {
    const routine = world.routines.get(AMARA)!
    const treat = routine.steps.find((s) => s.step === 'treat')!
    treat.productRef = { kind: 'shelf', id: 'entry-unlabelled' }
    treat.productId = null

    const result = await harm()

    expect(result.paused).toMatchObject({ step: 'treat' })
    expect(await pauses.find(AMARA, result.paused!.id)).toMatchObject({ productKey: 'entry-unlabelled', productId: null, productRef: { kind: 'shelf', id: 'entry-unlabelled' } })
  })
})

describe('SkinCareService.log, nothing to pause', () => {
  const expectNothing = async (result: Awaited<ReturnType<typeof harm>>) => {
    expect(result.outcome).toEqual({ kind: 'nothing-to-pause' })
    expect(result.log.outcome).toBe('nothing-to-pause')
    expect(result.paused).toBeNull()
    expect(result.response).toEqual({
      title: 'Nothing to pause yet',
      body: 'Skip anything that stings and rinse with water. Keep your routine simple until it settles.',
      whatToDoNow: 'Keep sunscreen if it does not sting.',
    })
    expect((await stored(AMARA))[0]).toMatchObject({ outcome: 'nothing-to-pause', reason: null })
    expect(await openPauses(AMARA)).toEqual([
      expect.objectContaining({ profileId: AMARA, step: null, productId: null, state: 'paused', pausedOn: TODAY, checkDay: dayAt(3), sameCount: 0, sourceLogId: result.log.id }),
    ])
  }

  it('is the outcome before there is a routine at all, with a stepless pause that is checked in three days', async () => {
    world.routines.set(AMARA, null)

    await expectNothing(await harm())
  })

  it('is the outcome before Start: a routine whose day 1 has not been set', async () => {
    world.routines.set(AMARA, { ...amarasRoutine(), dayOne: null })

    await expectNothing(await harm())
  })

  it('is the outcome when the only step is the sunscreen', async () => {
    world.routines.set(AMARA, { ...amarasRoutine(), steps: [step('protect', { activeGroups: ['retinoid'] })] })

    await expectNothing(await harm())
  })

  it('is the outcome for a routine with no steps', async () => {
    world.routines.set(AMARA, { ...amarasRoutine(), steps: [] })

    await expectNothing(await harm())
  })

  it('is the outcome once every step but the sunscreen is paused and the cap has not been reached', async () => {
    world.routines.set(AMARA, { ...amarasRoutine(), steps: [step('cleanse'), step('protect')] })
    const first = await harm()
    expect(first.paused).toMatchObject({ step: 'cleanse' })
    world.now = at(MINUTE)

    const second = await harm()

    expect(second.outcome).toEqual({ kind: 'nothing-to-pause' })
    expect(second.paused).toBeNull()
    expect(await openPauses(AMARA)).toHaveLength(2)
    expect(stepsOf(await openPauses(AMARA))).toEqual(['cleanse', null])
  })

  it('reaches the stepless pause\'s check day by local day, as any pause', async () => {
    world.routines.set(AMARA, null)
    world.zones.set(AMARA, 'Africa/Lagos')
    world.now = at(11 * HOUR)

    await harm()

    expect((await openPauses(AMARA))[0]).toMatchObject({ pausedOn: dayAt(1), checkDay: dayAt(4) })
  })

  describe('one open check-in with no step for the profile', () => {
    beforeEach(() => {
      world.routines.set(AMARA, null)
    })

    it('reuses the open stepless pause for a second log, moving its check day to the new local day + 3 and adding no row', async () => {
      const first = await harm()
      const [open] = await openPauses(AMARA)
      expect(first.outcome).toEqual({ kind: 'nothing-to-pause' })
      world.now = at(2 * DAY)

      const second = await harm()

      expect(second.outcome).toEqual({ kind: 'nothing-to-pause' })
      expect(second.paused).toBeNull()
      expect(second.response).toMatchObject({ title: 'Nothing to pause yet' })
      expect(await openPauses(AMARA)).toEqual([expect.objectContaining({ id: open!.id, step: null, state: 'paused', checkDay: dayAt(5) })])
      expect((await stored(AMARA)).map((row) => row.outcome)).toEqual(['nothing-to-pause', 'nothing-to-pause'])
    })

    it('moves the check day by the person\'s own local day', async () => {
      world.zones.set(AMARA, 'Africa/Lagos')
      await harm()
      // Lagos is on the 16th from T0 + 11 h.
      world.now = at(11 * HOUR)

      await harm()

      expect((await openPauses(AMARA)).map((row) => row.checkDay)).toEqual([dayAt(4)])
    })

    it('keeps one row through any number of logs', async () => {
      for (const offset of [0, HOUR, DAY, 2 * DAY]) {
        world.now = at(offset)
        await harm()
      }

      expect(await openPauses(AMARA)).toEqual([expect.objectContaining({ step: null, checkDay: dayAt(5) })])
    })

    it('opens a new stepless pause once the earlier one is closed', async () => {
      await harm()
      const [first] = await openPauses(AMARA)
      // Nothing closes a stepless pause until the check-in (PR 5), so it is closed through the repository, as that PR will.
      await pauses.update(AMARA, first!.id, { state: 'ended' })
      world.now = at(DAY)

      await harm()

      const open = await openPauses(AMARA)
      expect(open).toHaveLength(1)
      expect(open[0]!.id).not.toBe(first!.id)
      expect(open[0]).toMatchObject({ checkDay: dayAt(4), pausedOn: dayAt(1) })
    })

    it('does not reuse another profile\'s stepless pause', async () => {
      world.routines.set(TOLU, null)
      await harm(TOLU_ACTOR)

      await harm(AMARA_ACTOR)

      expect(await openPauses(AMARA)).toHaveLength(1)
      expect(await openPauses(TOLU)).toHaveLength(1)
      expect((await openPauses(AMARA))[0]!.id).not.toBe((await openPauses(TOLU))[0]!.id)
    })
  })

  it('does not put the stepless pause in stateFor, which names steps', async () => {
    world.routines.set(AMARA, null)
    await harm()

    expect(await service.stateFor(AMARA, TODAY)).toEqual({ pauses: [], held: false })
  })
})

describe('SkinCareService.log, the cap of two pauses', () => {
  const professional = (reason: EscalationReason) => ({ kind: 'professional', reason })

  it('sends a harm log to a professional when two steps are already paused, and pauses nothing', async () => {
    await harm()
    world.now = at(HOUR)
    await harm()
    const before = await openPauses(AMARA)
    world.now = at(2 * HOUR)

    const third = await log(AMARA_ACTOR, { ...STING, note: 'Still stinging.' })

    expect(third.outcome).toEqual(professional('harm-while-two-paused'))
    expect(third.log.outcome).toBe('professional')
    expect(third.paused).toBeNull()
    expect(third.response).toEqual({ ...ESCALATIONS['harm-while-two-paused'], facts: { noticing: ['stinging-or-burning'], where: [], howBad: 'mild', note: 'Still stinging.' } })
    expect((await stored(AMARA))[0]).toMatchObject({ id: third.log.id, outcome: 'professional', reason: 'harm-while-two-paused', overridden: false })
    expect(await openPauses(AMARA)).toEqual(before)
  })

  it('counts only paused steps: undoing one leaves one paused, and the next harm log pauses again', async () => {
    const first = await harm()
    await harm()
    await undo(AMARA_ACTOR, first.paused!.id)

    const third = await harm()

    expect(third.outcome).toEqual({ kind: 'pause', duringStepDown: false })
    expect(third.paused).toMatchObject({ step: 'treat' })
    expect(await openPauses(AMARA)).toHaveLength(2)
  })

  it('counts only paused steps: a replaced pause no longer counts', async () => {
    await harm()
    await harm()
    world.routines.get(AMARA)!.steps.find((s) => s.step === 'treat')!.productId = 'prod-other-treat'
    world.routines.get(AMARA)!.steps.find((s) => s.step === 'treat')!.productRef = { kind: 'candidate', code: 'TREAT-2' }
    await service.reconcile(AMARA)

    const third = await harm()

    expect(third.outcome.kind).toBe('pause')
    expect(third.paused).toMatchObject({ step: 'treat' })
  })

  // A step being brought back is not a paused one, so it is not one of the two. (PR 5: it is the step a harm signal then pauses again, in place, rather than one the choice goes
  // around; that is skin-care.service.check-ins.test.ts's. Here it is only that the cap is not reached by it.)
  it('does not count a pause that is being brought back', async () => {
    const first = await harm()
    await harm()
    world.now = at(3 * DAY)
    await runAs(AMARA_ACTOR, () => service.answerCheckIn(first.paused!.id, 'calmer'))
    expect(await pauses.find(AMARA, first.paused!.id)).toMatchObject({ state: 'bringing-back' })

    const result = await harm()

    expect(result.outcome).toEqual({ kind: 'pause', duringStepDown: false })
    expect(result.paused).toMatchObject({ id: first.paused!.id, step: 'treat' })
  })

  it('applies during a step-down too: the cap is the first rule', async () => {
    await harm()
    await harm()
    world.stepDown = true

    const result = await log(AMARA_ACTOR, STRONG_REDNESS)

    expect(result.outcome).toEqual(professional('harm-while-two-paused'))
    expect(await openPauses(AMARA)).toHaveLength(2)
  })

  it('does not count a stepless pause: the cap is of two steps', async () => {
    world.routines.set(AMARA, { ...amarasRoutine(), steps: [step('cleanse'), step('protect')] })
    await harm()
    world.now = at(MINUTE)
    expect((await harm()).outcome).toEqual({ kind: 'nothing-to-pause' })
    world.now = at(2 * MINUTE)

    const third = await harm()

    expect(third.outcome).toEqual({ kind: 'nothing-to-pause' })
    expect(third.response).toMatchObject({ title: 'Nothing to pause yet' })
    // The cleanser's pause and the one stepless check-in, reused.
    expect(stepsOf(await openPauses(AMARA)).sort()).toEqual(['cleanse', null].sort())
  })

  it('does not apply to a red flag, which is a professional outcome of its own', async () => {
    await harm()
    await harm()

    const result = await log(AMARA_ACTOR, { noticing: ['swelling'], howBad: 'mild' })

    expect(result.outcome).toEqual(professional('swelling'))
  })

  it('does not apply to advice, which pauses nothing', async () => {
    await harm()
    await harm()
    world.responses['advice-itching'] = { title: 'Itchy skin', body: 'Common while your skin settles.', whatToDoNow: 'Keep your moisturiser plain.' }

    const result = await log(AMARA_ACTOR, { noticing: ['itching'], howBad: 'mild' })

    expect(result.outcome.kind).toBe('advice')
  })

  it('counts each profile\'s pauses on their own', async () => {
    await harm(AMARA_ACTOR)
    await harm(AMARA_ACTOR)

    expect((await harm(TOLU_ACTOR)).outcome.kind).toBe('pause')
  })

  it('needs no reviewed pause text: only the escalation row', async () => {
    await harm()
    await harm()
    delete world.responses.paused
    delete world.responses['nothing-to-pause']

    expect((await harm()).outcome).toEqual(professional('harm-while-two-paused'))
  })

  it('answers 503 CONTENT_UNAVAILABLE when the escalation row is missing, and still stores the log with its reason', async () => {
    await harm()
    await harm()
    delete world.escalations['harm-while-two-paused']
    world.now = at(HOUR)

    const error = await errorOf(harm())

    expect(error).toMatchObject({ name: 'UnavailableError', code: 'CONTENT_UNAVAILABLE' })
    expect((await stored(AMARA))[0]).toMatchObject({ outcome: 'professional', reason: 'harm-while-two-paused' })
    expect(await openPauses(AMARA)).toHaveLength(2)
  })
})

describe('SkinCareService.log, a hard-to-ignore symptom during a step-down', () => {
  beforeEach(() => {
    world.stepDown = true
  })

  it('pauses another active step, with the step-down\'s own flag on the outcome', async () => {
    const result = await log(AMARA_ACTOR, STRONG_REDNESS)

    expect(result.outcome).toEqual({ kind: 'pause', duringStepDown: true })
    expect(result.paused).toMatchObject({ step: 'treat' })
    expect(result.response).toMatchObject({ title: 'We paused your Treatment' })
  })

  it('never pauses a basic step: with no active step it goes to a professional, and nothing is paused', async () => {
    world.routines.get(AMARA)!.steps.find((s) => s.step === 'treat')!.activeGroups = []

    const result = await log(AMARA_ACTOR, STRONG_REDNESS)

    expect(result.outcome).toEqual({ kind: 'professional', reason: 'hard-to-ignore-during-step-down' })
    expect(result.log.outcome).toBe('professional')
    expect(result.paused).toBeNull()
    expect(result.response).toEqual({ ...ESCALATIONS['hard-to-ignore-during-step-down'], facts: { noticing: ['new-redness'], where: [], howBad: 'hard-to-ignore', note: null } })
    expect((await stored(AMARA))[0]).toMatchObject({ outcome: 'professional', reason: 'hard-to-ignore-during-step-down' })
    expect(await openPauses(AMARA)).toEqual([])
  })

  it('goes to a professional when the only active step is already paused (one pause, so not the cap)', async () => {
    world.stepDown = false
    await harm()
    world.stepDown = true

    const result = await log(AMARA_ACTOR, STRONG_REDNESS)

    expect(result.outcome).toEqual({ kind: 'professional', reason: 'hard-to-ignore-during-step-down' })
    expect(await openPauses(AMARA)).toHaveLength(1)
  })

  it('goes to a professional when the only active step is the sunscreen', async () => {
    world.routines.set(AMARA, { ...amarasRoutine(), steps: [step('cleanse'), step('protect', { activeGroups: ['retinoid'] })] })

    expect((await log(AMARA_ACTOR, STRONG_REDNESS)).outcome).toEqual({ kind: 'professional', reason: 'hard-to-ignore-during-step-down' })
  })

  it('goes to a professional with no routine at all, not to "nothing to pause"', async () => {
    world.routines.set(AMARA, null)

    expect((await log(AMARA_ACTOR, STRONG_REDNESS)).outcome).toEqual({ kind: 'professional', reason: 'hard-to-ignore-during-step-down' })
  })

  it('leaves mild redness the expected flare, pausing nothing', async () => {
    world.responses['expected-flare'] = { title: 'The expected flare', body: 'Redness is common while you step down a cream.', whatToDoNow: null }

    const result = await log(AMARA_ACTOR, { noticing: ['new-redness'], howBad: 'noticeable' })

    expect(result.outcome).toEqual({ kind: 'expected-flare' })
    expect(result.paused).toBeNull()
    expect(await openPauses(AMARA)).toEqual([])
  })

  it('answers 503 for a missing escalation row and still stores the log with its reason', async () => {
    world.routines.get(AMARA)!.steps.find((s) => s.step === 'treat')!.activeGroups = []
    delete world.escalations['hard-to-ignore-during-step-down']

    expect(await errorOf(log(AMARA_ACTOR, STRONG_REDNESS))).toMatchObject({ code: 'CONTENT_UNAVAILABLE' })
    expect((await stored(AMARA))[0]).toMatchObject({ outcome: 'professional', reason: 'hard-to-ignore-during-step-down' })
  })
})

describe('SkinCareService.log, a pause with no reviewed text yet', () => {
  it('answers 503 CONTENT_UNAVAILABLE, and the pause stands: a harm signal pauses whatever the workbook holds', async () => {
    delete world.responses.paused

    const error = await errorOf(harm())

    expect(error).toMatchObject({ name: 'UnavailableError', code: 'CONTENT_UNAVAILABLE' })
    expect((await stored(AMARA))[0]).toMatchObject({ outcome: 'pause' })
    expect(stepsOf(await openPauses(AMARA))).toEqual(['treat'])
    expect(world.inboxWrites).toEqual([])
  })

  it('answers 503 for a missing nothing-to-pause row, and the stepless pause stands', async () => {
    world.routines.set(AMARA, null)
    delete world.responses['nothing-to-pause']

    expect(await errorOf(harm())).toMatchObject({ code: 'CONTENT_UNAVAILABLE' })
    expect(stepsOf(await openPauses(AMARA))).toEqual([null])
  })
})

describe('SkinCareService.log, the inbox row of a pause', () => {
  it('writes one row, keyed by the pause, with the paused text filled and a link to the routine', async () => {
    const result = await harm()

    expect(world.inboxWrites).toEqual([
      {
        profileId: AMARA,
        kind: 'paused',
        day: TODAY,
        title: 'We paused your Treatment',
        body: 'Your skin needs a rest from your Treatment. We will ask how it feels in three days.',
        link: '/routine',
        key: `paused:${result.paused!.id}`,
      },
    ])
    expect((await inboxRows.summaryFor(AMARA)).latest).toEqual([expect.objectContaining({ kind: 'paused', day: TODAY, title: 'We paused your Treatment', link: '/routine', read: false })])
  })

  it('writes a row for each pause, under its own key', async () => {
    const first = await harm()
    const second = await harm()

    expect(world.inboxWrites.map((write) => write.key)).toEqual([`paused:${first.paused!.id}`, `paused:${second.paused!.id}`])
    expect(world.inboxWrites.map((write) => write.title)).toEqual(['We paused your Treatment', 'We paused your Moisturiser'])
  })

  it('writes the profile\'s local day on the row', async () => {
    world.zones.set(AMARA, 'Africa/Lagos')
    world.now = at(11 * HOUR)

    await harm()

    expect(world.inboxWrites[0]).toMatchObject({ day: dayAt(1) })
  })

  it('writes no row for the outcomes that pause nothing', async () => {
    world.responses['advice-itching'] = { title: 'Itchy skin', body: 'Common while your skin settles.', whatToDoNow: 'Keep your moisturiser plain.' }
    await log(AMARA_ACTOR, { noticing: ['itching'], howBad: 'mild' })
    await log(AMARA_ACTOR, { noticing: ['swelling'], howBad: 'mild' })
    await log(AMARA_ACTOR, { noticing: ['nothing-unusual'] })
    await harm()
    await harm()
    world.inboxWrites = []
    await harm()

    expect(world.inboxWrites).toEqual([])
  })
})

describe('SkinCareService.undo', () => {
  it('sets the pause to undone and marks its log overridden, keeping the log, on the day of the pause', async () => {
    const result = await harm()
    world.now = at(HOUR)

    const undone = await undo(AMARA_ACTOR, result.paused!.id)

    expect(undone).toEqual({ id: result.paused!.id, state: 'undone' })
    expect(await pauses.find(AMARA, result.paused!.id)).toMatchObject({ state: 'undone', step: 'treat' })
    expect(await openPauses(AMARA)).toEqual([])
    expect(await stored(AMARA)).toEqual([expect.objectContaining({ id: result.log.id, outcome: 'pause', overridden: true })])
  })

  it('marks only the log that caused the pause, not the profile\'s other logs', async () => {
    const first = await harm()
    const second = await harm()
    const other = await log(AMARA_ACTOR, { noticing: ['nothing-unusual'] })

    await undo(AMARA_ACTOR, first.paused!.id)

    const logs = new Map((await stored(AMARA)).map((row) => [row.id, row.overridden]))
    expect(logs.get(first.log.id)).toBe(true)
    expect(logs.get(second.log.id)).toBe(false)
    expect(logs.get(other.log.id)).toBe(false)
    expect(await pauses.find(AMARA, second.paused!.id)).toMatchObject({ state: 'paused' })
  })

  it('brings the step back at once: stateFor no longer names it, and a new harm log can pause it again', async () => {
    const result = await harm()
    await undo(AMARA_ACTOR, result.paused!.id)

    expect(await service.stateFor(AMARA, TODAY)).toEqual({ pauses: [], held: false })
    expect((await harm()).paused).toMatchObject({ step: 'treat' })
  })

  it('is allowed up to the last instant of the pause\'s local day and expired from the first of the next (Lagos, UTC+1)', async () => {
    world.zones.set(AMARA, 'Africa/Lagos')
    world.now = at(10 * HOUR)
    const late = await harm()
    expect(late.paused).toMatchObject({ checkDay: dayAt(3) })
    world.now = at(11 * HOUR - 1)
    await expect(undo(AMARA_ACTOR, late.paused!.id)).resolves.toEqual({ id: late.paused!.id, state: 'undone' })

    world.now = at(10 * HOUR)
    const again = await harm()
    world.now = at(11 * HOUR)
    const expired = await errorOf(undo(AMARA_ACTOR, again.paused!.id))

    expect(expired).toMatchObject({ name: 'ConflictError', code: 'UNDO_EXPIRED' })
    expect(await pauses.find(AMARA, again.paused!.id)).toMatchObject({ state: 'paused', pausedOn: TODAY })
    expect((await stored(AMARA)).find((row) => row.id === again.log.id)).toMatchObject({ overridden: false })
  })

  it('reads the person\'s zone: the same two instants with no zone stored are both still the day of the pause', async () => {
    world.now = at(10 * HOUR)
    const result = await harm()

    world.now = at(11 * HOUR)
    await expect(undo(AMARA_ACTOR, result.paused!.id)).resolves.toMatchObject({ state: 'undone' })

    world.now = at(10 * HOUR)
    const next = await harm()
    world.now = at(12 * HOUR)
    expect(await errorOf(undo(AMARA_ACTOR, next.paused!.id))).toMatchObject({ code: 'UNDO_EXPIRED' })
  })

  it('answers 409 UNDO_EXPIRED the next day, and leaves the pause and its log as they were', async () => {
    const result = await harm()
    world.now = at(DAY)

    const error = await errorOf(undo(AMARA_ACTOR, result.paused!.id))

    expect(error).toMatchObject({ name: 'ConflictError', code: 'UNDO_EXPIRED' })
    expect(await pauses.find(AMARA, result.paused!.id)).toMatchObject({ state: 'paused' })
    expect((await stored(AMARA))[0]).toMatchObject({ overridden: false })
  })

  it('keeps the day of the pause when the zone changes later: the day is frozen, today is read in the zone stored now', async () => {
    world.zones.set(AMARA, 'Africa/Lagos')
    const result = await harm()
    // New York is still on the 15th when Lagos is on the 16th, and turns over five hours later.
    world.zones.set(AMARA, 'America/New_York')
    world.now = at(11 * HOUR)
    await expect(undo(AMARA_ACTOR, result.paused!.id)).resolves.toMatchObject({ state: 'undone' })

    world.zones.set(AMARA, 'Africa/Lagos')
    world.now = at(0)
    const next = await harm()
    world.zones.set(AMARA, 'America/New_York')
    world.now = at(16 * HOUR)
    expect(await errorOf(undo(AMARA_ACTOR, next.paused!.id))).toMatchObject({ code: 'UNDO_EXPIRED' })
  })

  it('answers 404 PAUSE_NOT_FOUND for another profile\'s pause, and changes nothing', async () => {
    const hers = await harm(TOLU_ACTOR)

    const error = await errorOf(undo(AMARA_ACTOR, hers.paused!.id))

    expect(error).toMatchObject({ name: 'NotFoundError', code: 'PAUSE_NOT_FOUND' })
    expect(await pauses.find(TOLU, hers.paused!.id)).toMatchObject({ state: 'paused' })
    expect((await stored(TOLU))[0]).toMatchObject({ overridden: false })
  })

  it('answers 404 PAUSE_NOT_FOUND for a pause that is no longer paused (already undone, or replaced by a rebuild), and changes nothing', async () => {
    const undone = await harm()
    await undo(AMARA_ACTOR, undone.paused!.id)
    const replaced = await harm()
    world.routines.get(AMARA)!.steps.find((s) => s.step === 'treat')!.productId = 'prod-better-treat'
    await service.reconcile(AMARA)

    expect(await errorOf(undo(AMARA_ACTOR, undone.paused!.id))).toMatchObject({ name: 'NotFoundError', code: 'PAUSE_NOT_FOUND' })
    expect(await errorOf(undo(AMARA_ACTOR, replaced.paused!.id))).toMatchObject({ name: 'NotFoundError', code: 'PAUSE_NOT_FOUND' })
    expect(await pauses.find(AMARA, undone.paused!.id)).toMatchObject({ state: 'undone' })
    expect(await pauses.find(AMARA, replaced.paused!.id)).toMatchObject({ state: 'replaced' })
  })

  it('answers 404 PAUSE_NOT_FOUND for a pause nobody holds', async () => {
    expect(await errorOf(undo(AMARA_ACTOR, crypto.randomUUID()))).toMatchObject({ name: 'NotFoundError', code: 'PAUSE_NOT_FOUND' })
  })

  // The check-in with no step ("nothing to pause") is not a pause of anything: there is nothing to undo, so undo answers 404 as for a pause nobody holds, and the row and its log stay.
  it('answers 404 PAUSE_NOT_FOUND for the check-in with no step (nothing to pause), and changes nothing', async () => {
    world.routines.set(AMARA, null)
    const nothing = await harm()
    expect(nothing.outcome).toEqual({ kind: 'nothing-to-pause' })
    const checkIn = (await openPauses(AMARA))[0]!
    expect(checkIn).toMatchObject({ step: null, state: 'paused' })

    const error = await errorOf(undo(AMARA_ACTOR, checkIn.id))

    expect(error).toMatchObject({ name: 'NotFoundError', code: 'PAUSE_NOT_FOUND' })
    expect(await pauses.find(AMARA, checkIn.id)).toMatchObject({ step: null, state: 'paused' })
    expect((await stored(AMARA))[0]).toMatchObject({ id: nothing.log.id, outcome: 'nothing-to-pause', overridden: false })
  })

  it('never undoes a professional result: the log that sent the person to a professional stays as it was', async () => {
    const first = await harm()
    await harm()
    const professional = await harm()
    expect(professional.outcome.kind).toBe('professional')

    await undo(AMARA_ACTOR, first.paused!.id)

    expect((await stored(AMARA)).find((row) => row.id === professional.log.id)).toMatchObject({ outcome: 'professional', reason: 'harm-while-two-paused', overridden: false })
  })

  it('answers 401 AUTH_REQUIRED with no session and 403 SIGNUP_REQUIRED to a guest, changing nothing', async () => {
    const result = await harm()

    expect(await errorOf(undo(PUBLIC, result.paused!.id))).toMatchObject({ name: 'UnauthorizedError', code: 'AUTH_REQUIRED' })
    expect(await errorOf(undo(GUEST, result.paused!.id))).toMatchObject({ name: 'ForbiddenError', code: 'SIGNUP_REQUIRED' })
    expect(await pauses.find(AMARA, result.paused!.id)).toMatchObject({ state: 'paused' })
  })
})

describe('SkinCareService.reconcile', () => {
  const treat = (profileId = AMARA) => world.routines.get(profileId)!.steps.find((s) => s.step === 'treat')!

  it('keeps a pause whose step and product are still in the routine', async () => {
    const result = await harm()
    world.routines.get(AMARA)!.steps.find((s) => s.step === 'cleanse')!.productId = 'prod-new-cleanser'

    await service.reconcile(AMARA)

    expect(await pauses.find(AMARA, result.paused!.id)).toMatchObject({ state: 'paused' })
    expect(await service.stateFor(AMARA, TODAY)).toEqual({ pauses: [{ step: 'treat', productId: 'prod-treat', state: 'paused' }], held: false })
  })

  it('sets a pause to replaced when the step now has another product', async () => {
    const result = await harm()
    treat().productId = 'prod-better-treat'
    treat().productRef = { kind: 'candidate', code: 'TREAT-2' }

    await service.reconcile(AMARA)

    expect(await pauses.find(AMARA, result.paused!.id)).toMatchObject({ state: 'replaced' })
    expect(await openPauses(AMARA)).not.toContainEqual(expect.objectContaining({ id: result.paused!.id }))
  })

  it('replaces only the pause whose product changed', async () => {
    const first = await harm()
    const second = await harm()
    treat().productId = 'prod-better-treat'

    await service.reconcile(AMARA)

    expect(await pauses.find(AMARA, first.paused!.id)).toMatchObject({ state: 'replaced' })
    expect(await pauses.find(AMARA, second.paused!.id)).toMatchObject({ state: 'paused' })
  })

  it('keeps the pause when a candidate becomes the person\'s own shelf entry of the same product (I got it)', async () => {
    const result = await harm()
    treat().productRef = { kind: 'shelf', id: 'entry-got-it' }

    await service.reconcile(AMARA)

    expect(await pauses.find(AMARA, result.paused!.id)).toMatchObject({ state: 'paused', productKey: 'prod-treat' })
    expect((await service.stateFor(AMARA, TODAY)).pauses).toEqual([{ step: 'treat', productId: 'prod-treat', state: 'paused' }])
  })

  it('keeps a no-label own product\'s pause while the same shelf entry is in the step, and replaces it when another entry is', async () => {
    treat().productRef = { kind: 'shelf', id: 'entry-unlabelled' }
    treat().productId = null
    const result = await harm()

    await service.reconcile(AMARA)
    expect(await pauses.find(AMARA, result.paused!.id)).toMatchObject({ state: 'paused' })

    treat().productRef = { kind: 'shelf', id: 'entry-another-unlabelled' }
    await service.reconcile(AMARA)
    expect(await pauses.find(AMARA, result.paused!.id)).toMatchObject({ state: 'replaced' })
  })

  it('is idempotent: running it again changes nothing', async () => {
    const kept = await harm()
    const replaced = await harm()
    world.routines.get(AMARA)!.steps.find((s) => s.step === 'moisturise')!.productId = 'prod-new-moisturiser'
    await service.reconcile(AMARA)
    const once = [await pauses.find(AMARA, kept.paused!.id), await pauses.find(AMARA, replaced.paused!.id), await openPauses(AMARA)]

    await service.reconcile(AMARA)
    await service.reconcile(AMARA)

    expect([await pauses.find(AMARA, kept.paused!.id), await pauses.find(AMARA, replaced.paused!.id), await openPauses(AMARA)]).toEqual(once)
    expect(once[1]).toMatchObject({ state: 'replaced' })
    expect(once[0]).toMatchObject({ state: 'paused' })
  })

  it('changes nothing while there is no routine to read (none, or one a safety change hides)', async () => {
    const result = await harm()
    world.routines.set(AMARA, null)

    await service.reconcile(AMARA)

    expect(await pauses.find(AMARA, result.paused!.id)).toMatchObject({ state: 'paused' })
  })

  it('leaves another profile\'s pauses alone', async () => {
    const hers = await harm(TOLU_ACTOR)
    await harm(AMARA_ACTOR)
    treat(AMARA).productId = 'prod-better-treat'

    await service.reconcile(AMARA)

    expect(await pauses.find(TOLU, hers.paused!.id)).toMatchObject({ state: 'paused' })
  })

  it('leaves a stepless pause alone', async () => {
    world.routines.set(AMARA, null)
    await harm()
    world.routines.set(AMARA, amarasRoutine())

    await service.reconcile(AMARA)

    expect(stepsOf(await openPauses(AMARA))).toEqual([null])
  })

  it('does nothing for a profile with no pauses', async () => {
    await expect(service.reconcile(AMARA)).resolves.toBeUndefined()
  })
})

describe('SkinCareService.stateFor', () => {
  it('answers no pauses and no hold for a profile with none', async () => {
    expect(await service.stateFor(AMARA, TODAY)).toEqual({ pauses: [], held: false })
  })

  it('answers each open paused step as { step, productId, state: paused }, and no hold', async () => {
    await harm()
    await harm()

    const state = await service.stateFor(AMARA, TODAY)

    expect(state.held).toBe(false)
    expect([...state.pauses].sort((a, b) => a.step.localeCompare(b.step))).toEqual([
      { step: 'moisturise', productId: 'prod-moisturise', state: 'paused' },
      { step: 'treat', productId: 'prod-treat', state: 'paused' },
    ])
  })

  it('names a no-label own product by its shelf entry id, which is its pause\'s key', async () => {
    const treatStep = world.routines.get(AMARA)!.steps.find((s) => s.step === 'treat')!
    treatStep.productRef = { kind: 'shelf', id: 'entry-unlabelled' }
    treatStep.productId = null
    await harm()

    expect((await service.stateFor(AMARA, TODAY)).pauses).toEqual([{ step: 'treat', productId: 'entry-unlabelled', state: 'paused' }])
  })

  it('leaves out an undone pause, and another profile\'s', async () => {
    const undone = await harm()
    await undo(AMARA_ACTOR, undone.paused!.id)
    await harm(TOLU_ACTOR)

    expect(await service.stateFor(AMARA, TODAY)).toEqual({ pauses: [], held: false })
    expect((await service.stateFor(TOLU, TODAY)).pauses).toHaveLength(1)
  })

  it('answers the same for any day: the pause overlay does not depend on the date', async () => {
    await harm()

    expect(await service.stateFor(AMARA, dayAt(30))).toEqual(await service.stateFor(AMARA, TODAY))
  })

  it('fails when the pauses cannot be read: it never answers "no pauses" for a storage failure', async () => {
    await harm()
    pauses.failNext(new Error('D1 is down'))

    await expect(service.stateFor(AMARA, TODAY)).rejects.toThrow('D1 is down')
  })
})
