import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Actor, runAs } from '../../lib/context'
import { NotFoundError } from '../../lib/errors'
import type { EscalationReason, ResponseOutcome, RoutineStep } from '../catalog/catalog.vocabulary'
import type { CatalogWorkbookService, Escalation, Response } from '../catalog/catalog.workbook.service'
import type { ScheduleStep } from '../catalog/catalog.workbook.schema'
import { FakeInboxRepository } from '../inbox/inbox.repository.fake'
import { type InboxWrite, InboxService } from '../inbox/inbox.service'
import { FakeEscalationHoldsRepository } from './skin-care.holds.repository.fake'
import { FakeSkinCareRepository } from './skin-care.repository.fake'
import { FakeStepPausesRepository } from './skin-care.pauses.repository.fake'
import { SkinCareService } from './skin-care.service'
import type { EscalationHold, NewEscalationHold, SkinCareRoutine, SkinCareRoutineStep } from './skin-care.types'

// Wiring the escalation hold into skin care, closing it, and marking a product that keeps reacting (spec #233, PR 6b-ii), at the service seam with the same world fake as
// skin-care.service.check-ins.test.ts: one mutable clock, the stored time zones, the reviewed text and ladders of the workbook, the routine in force, and the inbox service over
// its own fake repository. The skin-log, pauses and holds repositories are the real fakes. A person reaches every state the way the product does: a log or a check-in sends
// them to a professional, and a harm log pauses a step. No row is written into a state the product cannot make.
//
// THE CONTRACT THIS FILE PINS (assumed: the brief names the behaviour; the names below are the assumptions):
//   new SkinCareService({ ..., holds, safety, verdicts, catalog })
//     holds     EscalationHoldsRepository          (skin-care.holds.repository.ts)
//     safety    { markReactionProduct(profileId, { productId, brand, name, category }): Promise<{ marked: boolean }> }     SafetyService's
//     verdicts  { savedFor(profileId): Promise<unknown> }                                                                  VerdictService's; a verdict build is queued by the call
//     catalog   { namedProduct(productId): Promise<{ brand, name, category, ... }> }                                       ProductCatalogService's; rejects PRODUCT_NOT_FOUND for an id it does not hold
//   Every professional result opens the profile's hold (the table allows one open hold; a later professional keeps it):
//     log:       pus-or-hot-patch, swelling, near-eyes, harm-while-two-paused, hard-to-ignore-during-step-down   (sourceLogId = the log)
//     check-in:  worse-after-pause, unchanged-after-checks                                                      (sourceLogId = the pause's source log)
//     openedOn = the person's local day, read in the zone stored now.
//   The inbox row { kind: 'escalation', key: `escalation:${holdId}`, link: '/routine', day: the local day, title, body }, from the reviewed escalation text, is written once per hold.
//     A failure of the hold or of the inbox write is logged by ids and never changes the answer.
//   stateFor(profileId, today).held is true while a hold is open; when the hold cannot be read, stateFor rejects.
//   While a hold is open the steps heldSteps() names are out of reach of a harm log's stepToPause.
//   closeHold(how: 'seen' | 'settled'): Promise<{ closed: true; checkInsDue: StepPause[] }> for the session profile (401, 403 SIGNUP_REQUIRED, 404 HOLD_NOT_FOUND). It closes the hold
//     (holds.close(profileId, holdId, how, now), a compare-and-set), then for each held step of the routine at the close: an escalated row goes back to paused (check day today,
//     same_count 0); an open paused row has its check day moved to today; a bringing-back row is left alone; a step with no row gets a paused row due today with no source log.
//     checkInsDue is what is due on the close day (assumed: the same rows checkInsDue(profileId, today) answers, with `id` and `step`).
//     With the routine unreadable the hold is still closed and every escalated row goes back to paused, due today.
//   Reaction marking: a re-pause of a step being brought back (including the one a cap-hit harm log makes) and a worse-after-pause result call
//     safety.markReactionProduct(profileId, { productId, brand, name, category }) with the pause's catalog product read through catalog.namedProduct; when it answers
//     marked: true, verdicts.savedFor(profileId) is called. A pause with no catalog productId marks nothing, nor does unchanged-after-checks. A failure is logged by ids only.

// Every date hangs off this one instant (the clock) and its UTC day; fixtures are offsets from them.
const T0 = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs)
const dayAt = (offsetDays: number) => at(offsetDays * DAY).toISOString().slice(0, 10)
const TODAY = dayAt(0)

// Two instants where the person's local day is not the UTC day. 23:30 UTC on the 14th is half past midnight on the 15th in Lagos (UTC+1, no daylight saving); 02:30 UTC on the
// 15th is half past ten at night on the 14th in New York (UTC-4 in June).
const ZONE_CASES: [string, number, string][] = [
  ['Africa/Lagos', -12 * HOUR - 30 * MINUTE, dayAt(0)],
  ['America/New_York', -9 * HOUR - 30 * MINUTE, dayAt(-1)],
]

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
const ESCALATIONS: Record<EscalationReason, Escalation> = {
  'pus-or-hot-patch': { whoToSee: 'A doctor today about a hot patch.', howSoon: 'Today.', whatToTellThem: 'Where the patch is and since when.' },
  swelling: { whoToSee: 'A doctor or pharmacist about swelling.', howSoon: 'Today.', whatToTellThem: 'Where it swelled and since when.' },
  'near-eyes': { whoToSee: 'A doctor about skin near the eyes.', howSoon: 'Today.', whatToTellThem: 'What you noticed near your eyes.' },
  'harm-while-two-paused': { whoToSee: 'A doctor or pharmacist.', howSoon: 'Within a day.', whatToTellThem: 'Which steps are paused and what you noticed.' },
  'hard-to-ignore-during-step-down': { whoToSee: 'A doctor or pharmacist about a strong flare.', howSoon: 'Today.', whatToTellThem: 'What you noticed and the cream you are stepping down.' },
  'worse-after-pause': { whoToSee: 'A doctor or pharmacist about skin that is worse.', howSoon: 'Within a day or two.', whatToTellThem: 'What you paused, for how long, and how it is now.' },
  'unchanged-after-checks': { whoToSee: 'A pharmacist or a doctor about skin that has not settled.', howSoon: 'This week.', whatToTellThem: 'What you paused, and that it has not changed in nine days.' },
}

// The default ladder has a rung of a week each; the retinoid one has a first rung of two weeks, so the two cannot be taken for each other.
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

// What the catalog says of each product: the brand, name and category the reaction mark is made from. Not the routine's title for the step.
const CATALOG: Record<string, { brand: string; name: string; category: 'skin' | 'body' }> = {
  'prod-treat': { brand: 'Maison Noire', name: 'Night Retinol', category: 'skin' },
  'prod-cleanse': { brand: 'Kora', name: 'Clear Wash', category: 'body' },
  'prod-moisturise': { brand: 'Ife', name: 'Cloud Cream', category: 'skin' },
}
const TREAT_PRODUCT = { productId: 'prod-treat', brand: 'Maison Noire', name: 'Night Retinol', category: 'skin' }

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

type Mark = { profileId: string; product: { productId: string; brand: string; name: string; category: string } }

type World = {
  now: Date
  zones: Map<string, string | null>
  routines: Map<string, SkinCareRoutine | null>
  responses: Partial<Record<ResponseOutcome, Response>>
  escalations: Partial<Record<EscalationReason, Escalation>>
  /** The approved ladders by group, 'default' for the one with no group. */
  ladders: Map<string, ScheduleStep[]>
  inboxWrites: InboxWrite[]
  inboxFails: boolean
  stepDown: boolean
  routineReadFails: boolean
  /** The catalog reads made, by product id. */
  catalogReads: string[]
  catalogFails: boolean
  /** The reaction marks asked for; `marked` is what the safety service answers. */
  safetyMarks: Mark[]
  marked: boolean
  safetyFails: boolean
  /** The profiles a verdict build was asked for. */
  savedFor: string[]
  savedForFails: boolean
}
let world: World
let repository: FakeSkinCareRepository
let pauses: FakeStepPausesRepository
let holds: FlakyHolds
let inboxRows: InboxService
let service: SkinCareService
let errors: unknown[][]

/** The real fake, with a way to make one kind of call fail (its own `failNext` fails whichever call comes first, and a service may read before it writes). */
class FlakyHolds extends FakeEscalationHoldsRepository {
  openFails = false
  openForFails = false

  override async open(hold: NewEscalationHold): Promise<EscalationHold> {
    if (this.openFails) throw new Error('down')
    return super.open(hold)
  }

  override async openFor(profileId: string): Promise<EscalationHold | null> {
    if (this.openForFails) throw new Error('down')
    return super.openFor(profileId)
  }
}

const makeService = () =>
  new SkinCareService({
    repository,
    pauses,
    holds,
    workbook: {
      responseFor: async (outcome) => world.responses[outcome] ?? null,
      escalationFor: async (reason) => world.escalations[reason] ?? null,
      reintroductionFor: async (group) => structuredClone((group === null ? undefined : world.ladders.get(group)) ?? world.ladders.get('default') ?? []),
    } satisfies Pick<CatalogWorkbookService, 'responseFor' | 'escalationFor' | 'reintroductionFor'>,
    reminders: { zoneFor: async (profileId: string) => world.zones.get(profileId) ?? null },
    routine: {
      stepDownRunning: async () => world.stepDown,
      skinCareRoutineFor: async (profileId: string) => {
        if (world.routineReadFails) throw new Error('routine read failed')
        const routine = world.routines.get(profileId) ?? null
        return routine === null ? null : { ...structuredClone(routine), stepDownRunning: world.stepDown }
      },
    },
    inbox: {
      write: async (input: InboxWrite) => {
        if (world.inboxFails) throw new Error('inbox write failed')
        // The rows made: an escalation row is asked for on every professional result (the same key is a no-op), and "once per hold" is about the row.
        const written = await inboxRows.write(input)
        if (written.created) world.inboxWrites.push(input)
        return written
      },
    },
    safety: {
      markReactionProduct: async (profileId: string, product: Mark['product']) => {
        world.safetyMarks.push({ profileId, product })
        if (world.safetyFails) throw new Error('down')
        return { marked: world.marked }
      },
    },
    verdicts: {
      savedFor: async (profileId: string) => {
        world.savedFor.push(profileId)
        if (world.savedForFails) throw new Error('down')
        return null
      },
    },
    catalog: {
      namedProduct: async (productId: string) => {
        world.catalogReads.push(productId)
        if (world.catalogFails) throw new Error('down')
        const known = CATALOG[productId]
        if (known === undefined) throw new NotFoundError('PRODUCT_NOT_FOUND', 'Product not found')
        return { id: productId, kind: 'named' as const, variant: null, form: null, imageUrl: null, ...known }
      },
    },
    now: () => world.now,
  })

type LogInput = Parameters<SkinCareService['log']>[0]
const log = (who: Actor, input: LogInput) => runAs(who, () => service.log(input))
const checkIn = (who: Actor, pauseId: string, answer: 'calmer' | 'same' | 'worse') => runAs(who, () => service.answerCheckIn(pauseId, answer))
const undo = (who: Actor, pauseId: string) => runAs(who, () => service.undo(pauseId))
const close = (who: Actor = AMARA_ACTOR, how: 'seen' | 'settled' = 'seen') => runAs(who, () => service.closeHold(how))
const openPauses = (profileId = AMARA) => pauses.openFor(profileId)
const row = async (id: string, profileId = AMARA) => (await pauses.find(profileId, id))!
/** The open row of a step, by the step (never by the order rows were made in). */
const openRowOf = async (stepName: RoutineStep, profileId = AMARA) => (await openPauses(profileId)).find((open) => open.step === stepName)
const dueIds = async (day: string, profileId = AMARA) => (await service.checkInsDue(profileId, day)).map((due) => due.id).sort()
const ladderOf = (stored: { ladderCode: string | null }) => JSON.parse(stored.ladderCode!) as ScheduleStep[]
const holdOf = (profileId = AMARA) => holds.openFor(profileId)
const escalationWrites = () => world.inboxWrites.filter((write) => write.key.startsWith('escalation:'))
const treat = (profileId = AMARA) => world.routines.get(profileId)!.steps.find((s) => s.step === 'treat')!

const STING: LogInput = { noticing: ['stinging-or-burning'], howBad: 'mild' }
const SWELLING: LogInput = { noticing: ['swelling'], howBad: 'noticeable' }
const STRONG_REDNESS: LogInput = { noticing: ['new-redness'], howBad: 'hard-to-ignore' }
const harm = (who: Actor = AMARA_ACTOR) => log(who, STING)
const swell = (who: Actor = AMARA_ACTOR) => log(who, SWELLING)

/** A harm log pauses the treatment at T0 (checked on dayAt(3)); the person answers Calmer on the check day. Leaves the clock on that day, and the treatment on its first rung. */
const bringBack = async (who: Actor = AMARA_ACTOR) => {
  const made = await harm(who)
  world.now = at(3 * DAY)
  await checkIn(who, made.paused!.id, 'calmer')
  return { id: made.paused!.id, log: made.log }
}
/** The treatment paused by a harm log at T0 and "about the same" three times, on days 3, 6 and 9: the third sends the person to a professional. Leaves the clock on day 9. */
const unchangedForNineDays = async () => {
  const made = await harm()
  for (const day of [3, 6, 9]) {
    world.now = at(day * DAY)
    await checkIn(AMARA_ACTOR, made.paused!.id, 'same')
  }
  return { id: made.paused!.id, log: made.log }
}

beforeEach(() => {
  world = {
    now: T0,
    zones: new Map(),
    routines: new Map([[AMARA, amarasRoutine()], [TOLU, amarasRoutine()]]),
    responses: { paused: { ...PAUSED_TEXT }, 'nothing-to-pause': { ...NOTHING_TEXT }, 'check-calmer': { ...CALMER_TEXT }, 'check-same': { ...SAME_TEXT }, 'check-worse': { ...WORSE_TEXT } },
    escalations: { ...ESCALATIONS },
    ladders: new Map([['default', structuredClone(DEFAULT_LADDER)], ['retinoid', structuredClone(RETINOID_LADDER)]]),
    inboxWrites: [],
    inboxFails: false,
    stepDown: false,
    routineReadFails: false,
    catalogReads: [],
    catalogFails: false,
    safetyMarks: [],
    marked: true,
    safetyFails: false,
    savedFor: [],
    savedForFails: false,
  }
  repository = new FakeSkinCareRepository()
  pauses = new FakeStepPausesRepository()
  holds = new FlakyHolds()
  inboxRows = new InboxService({ repository: new FakeInboxRepository(), now: () => world.now })
  service = makeService()
  errors = []
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => void errors.push(args))
})
afterEach(() => vi.restoreAllMocks())

// --- 1. every professional result opens the hold ---

describe('SkinCareService.log, a professional result opens the hold', () => {
  it.each<[EscalationReason, LogInput]>([
    ['pus-or-hot-patch', { noticing: ['pus-or-hot-patch'], howBad: 'mild' }],
    ['swelling', SWELLING],
    ['near-eyes', { noticing: ['new-breakouts'], where: ['near-eyes'], howBad: 'mild' }],
  ])('opens a hold for %s: the reason, this log and the local day', async (reason, input) => {
    const result = await log(AMARA_ACTOR, input)

    expect(result.outcome).toEqual({ kind: 'professional', reason })
    expect(await holdOf()).toMatchObject({ profileId: AMARA, reason, sourceLogId: result.log.id, openedOn: TODAY, closedAt: null, closedHow: null })
  })

  it('opens a hold for harm-while-two-paused on the third harm log, with that log as its source', async () => {
    await harm()
    await harm()
    expect(await holdOf()).toBeNull()

    const third = await harm()

    expect(third.outcome).toEqual({ kind: 'professional', reason: 'harm-while-two-paused' })
    expect(await holdOf()).toMatchObject({ reason: 'harm-while-two-paused', sourceLogId: third.log.id, openedOn: TODAY })
  })

  it('opens a hold for hard-to-ignore-during-step-down when no other active step can be paused', async () => {
    world.stepDown = true
    treat().activeGroups = []

    const result = await log(AMARA_ACTOR, STRONG_REDNESS)

    expect(result.outcome).toEqual({ kind: 'professional', reason: 'hard-to-ignore-during-step-down' })
    expect(await holdOf()).toMatchObject({ reason: 'hard-to-ignore-during-step-down', sourceLogId: result.log.id, openedOn: TODAY })
  })

  it('opens no hold for a pause, a good day, or nothing to pause', async () => {
    await harm()
    await log(AMARA_ACTOR, { noticing: ['nothing-unusual'] })
    world.routines.set(AMARA, null)
    const nothing = await harm()

    expect(nothing.outcome).toEqual({ kind: 'nothing-to-pause' })
    expect(await holdOf()).toBeNull()
    expect(escalationWrites()).toEqual([])
  })

  it('opens a hold only for the profile that was sent to a professional', async () => {
    await swell(AMARA_ACTOR)

    expect(await holdOf(AMARA)).not.toBeNull()
    expect(await holdOf(TOLU)).toBeNull()
  })

  it.each(ZONE_CASES)('freezes the local day the hold was opened in the person\'s own zone: in %s', async (zone, offset, local) => {
    world.zones.set(AMARA, zone)
    world.now = at(offset)
    // The case is only worth anything while the UTC day is another day.
    expect(world.now.toISOString().slice(0, 10)).not.toBe(local)

    await swell()

    expect((await holdOf())!.openedOn).toBe(local)
  })

  it('keeps the existing hold when a later log is a professional too: the same hold, with its own reason and source log', async () => {
    const first = await swell()
    const opened = (await holdOf())!
    world.now = at(HOUR)

    const later = await log(AMARA_ACTOR, { noticing: ['pus-or-hot-patch'], howBad: 'mild' })

    expect(later.outcome).toEqual({ kind: 'professional', reason: 'pus-or-hot-patch' })
    expect(await holdOf()).toEqual(opened)
    expect(opened).toMatchObject({ reason: 'swelling', sourceLogId: first.log.id })
  })
})

describe('SkinCareService.answerCheckIn, a professional result opens the hold', () => {
  it('opens a hold for worse-after-pause, with the pause\'s source log and the day of the answer', async () => {
    const made = await harm()
    world.now = at(3 * DAY)

    const answered = await checkIn(AMARA_ACTOR, made.paused!.id, 'worse')

    expect(answered.outcome).toEqual({ kind: 'professional', reason: 'worse-after-pause' })
    expect(await holdOf()).toMatchObject({ profileId: AMARA, reason: 'worse-after-pause', sourceLogId: made.log.id, openedOn: dayAt(3), closedAt: null })
  })

  it('opens a hold for unchanged-after-checks on the third "about the same" and not before', async () => {
    const made = await harm()
    for (const day of [3, 6]) {
      world.now = at(day * DAY)
      await checkIn(AMARA_ACTOR, made.paused!.id, 'same')
      expect(await holdOf()).toBeNull()
    }
    world.now = at(9 * DAY)

    const answered = await checkIn(AMARA_ACTOR, made.paused!.id, 'same')

    expect(answered.outcome).toEqual({ kind: 'professional', reason: 'unchanged-after-checks' })
    expect(await holdOf()).toMatchObject({ reason: 'unchanged-after-checks', sourceLogId: made.log.id, openedOn: dayAt(9) })
  })

  it('opens no hold for calmer', async () => {
    await bringBack()

    expect(await holdOf()).toBeNull()
    expect(escalationWrites()).toEqual([])
  })

  it('keeps the hold a log opened when the check-in is a professional result too', async () => {
    const made = await harm()
    const swelled = await swell()
    const opened = (await holdOf())!
    world.now = at(3 * DAY)

    await checkIn(AMARA_ACTOR, made.paused!.id, 'worse')

    expect(await holdOf()).toEqual(opened)
    expect(opened.sourceLogId).toBe(swelled.log.id)
    expect(escalationWrites()).toHaveLength(1)
  })
})

describe('the inbox row of a hold', () => {
  it('is written from the reviewed escalation text for a log: kind, key, link and the local day', async () => {
    await swell()

    const hold = (await holdOf())!
    expect(escalationWrites()).toEqual([
      {
        profileId: AMARA,
        kind: 'escalation',
        day: TODAY,
        title: expect.stringMatching(/\S/),
        body: expect.stringContaining(ESCALATIONS.swelling.whoToSee),
        link: '/routine',
        key: `escalation:${hold.id}`,
      },
    ])
  })

  it('is written from the reviewed escalation text for a check-in too', async () => {
    const made = await harm()
    world.now = at(3 * DAY)

    await checkIn(AMARA_ACTOR, made.paused!.id, 'worse')

    const hold = (await holdOf())!
    expect(escalationWrites()).toEqual([
      expect.objectContaining({ profileId: AMARA, kind: 'escalation', day: dayAt(3), body: expect.stringContaining(ESCALATIONS['worse-after-pause'].whoToSee), link: '/routine', key: `escalation:${hold.id}` }),
    ])
  })

  it.each(ZONE_CASES)('is dated the local day in the person\'s own zone: in %s', async (zone, offset, local) => {
    world.zones.set(AMARA, zone)
    world.now = at(offset)

    await swell()

    expect(escalationWrites().map((write) => write.day)).toEqual([local])
  })

  it('is written once per hold: a second professional result writes none', async () => {
    await swell()
    world.now = at(HOUR)
    await log(AMARA_ACTOR, { noticing: ['pus-or-hot-patch'], howBad: 'mild' })

    expect(escalationWrites()).toHaveLength(1)
  })

  it('is written again for the next hold, once the first is closed, under the new hold\'s own key', async () => {
    await swell()
    const first = (await holdOf())!
    await close()
    world.now = at(DAY)

    await swell()

    const second = (await holdOf())!
    expect(second.id).not.toBe(first.id)
    expect(escalationWrites().map((write) => write.key)).toEqual([`escalation:${first.id}`, `escalation:${second.id}`])
  })

  it('is each profile\'s own', async () => {
    await swell(AMARA_ACTOR)
    await swell(TOLU_ACTOR)

    expect(escalationWrites().map((write) => write.profileId).sort()).toEqual([AMARA, TOLU])
  })
})

describe('when the hold or its inbox row cannot be written', () => {
  it('still answers the log as a professional result, stores it, and logs ids only (the note is never logged)', async () => {
    holds.openFails = true

    const result = await log(AMARA_ACTOR, { ...SWELLING, note: 'It started after the serum.' })

    expect(result.outcome).toEqual({ kind: 'professional', reason: 'swelling' })
    expect(result.response).toMatchObject({ ...ESCALATIONS.swelling, facts: { note: 'It started after the serum.' } })
    expect((await repository.recent(AMARA, 20))[0]).toMatchObject({ id: result.log.id, outcome: 'professional', reason: 'swelling' })
    expect(errors.map((line) => line[0])).toEqual(expect.arrayContaining([expect.objectContaining({ profileId: AMARA })]))
    expect(JSON.stringify(errors)).not.toContain('down')
    expect(JSON.stringify(errors)).not.toContain('It started after the serum.')
  })

  it('still answers the check-in as a professional result with the reviewed text, but leaves the pause paused and due, so the step stays out and the person is asked again', async () => {
    const made = await harm()
    world.now = at(3 * DAY)
    holds.openFails = true
    errors.length = 0

    const answered = await checkIn(AMARA_ACTOR, made.paused!.id, 'worse')

    expect(answered).toEqual({
      outcome: { kind: 'professional', reason: 'worse-after-pause' },
      response: ESCALATIONS['worse-after-pause'],
      pause: { id: made.paused!.id, step: 'treat', state: 'paused', checkDay: dayAt(3) },
    })
    expect(await row(made.paused!.id)).toMatchObject({ state: 'paused', checkDay: dayAt(3), sameCount: 0 })
    expect(await dueIds(dayAt(3))).toEqual([made.paused!.id])
    expect(await service.stateFor(AMARA, dayAt(3))).toMatchObject({ pauses: [{ step: 'treat', state: 'paused' }] })
    expect(errors.map((line) => line[0])).toEqual([{ outcome: 'skin-care-hold-open-failed', profileId: AMARA, pauseId: made.paused!.id }])
    expect(JSON.stringify(errors)).not.toContain('down')
  })

  it('tries the hold again on the next Worse, which then escalates the pause and opens the hold', async () => {
    const made = await harm()
    world.now = at(3 * DAY)
    holds.openFails = true
    await checkIn(AMARA_ACTOR, made.paused!.id, 'worse')
    holds.openFails = false

    const answered = await checkIn(AMARA_ACTOR, made.paused!.id, 'worse')

    expect(answered).toMatchObject({ pause: { id: made.paused!.id, state: 'escalated', checkDay: null } })
    expect(await holdOf()).toMatchObject({ reason: 'worse-after-pause', sourceLogId: made.log.id })
    expect(escalationWrites()).toHaveLength(1)
  })

  it('keeps the hold and the answer when the inbox row cannot be written, and logs the hold by id', async () => {
    world.inboxFails = true

    const result = await swell()

    const hold = await holdOf()
    expect(result.outcome).toEqual({ kind: 'professional', reason: 'swelling' })
    expect(hold).toMatchObject({ reason: 'swelling', sourceLogId: result.log.id })
    expect(errors.map((line) => line[0])).toEqual(expect.arrayContaining([expect.objectContaining({ profileId: AMARA })]))
    expect(JSON.stringify(errors)).not.toContain('inbox write failed')
  })
})

// --- 2. the routine read says whether a hold is open ---

describe('SkinCareService.stateFor, and the hold', () => {
  it('says held: false while no hold is open', async () => {
    await harm()

    expect((await service.stateFor(AMARA, TODAY)).held).toBe(false)
  })

  it('says held: true while a hold is open, with the pauses beside it', async () => {
    const made = await harm()
    await swell()

    expect(await service.stateFor(AMARA, TODAY)).toEqual({ pauses: [{ step: 'treat', productId: 'prod-treat', state: 'paused' }], held: true })
    expect(made.paused).toMatchObject({ step: 'treat' })
  })

  it('says held: false again once the hold is closed', async () => {
    await swell()
    await close()

    expect((await service.stateFor(AMARA, TODAY)).held).toBe(false)
  })

  it('says held: true for a hold a check-in opened', async () => {
    const made = await harm()
    world.now = at(3 * DAY)
    await checkIn(AMARA_ACTOR, made.paused!.id, 'worse')

    expect((await service.stateFor(AMARA, dayAt(3))).held).toBe(true)
  })

  it('says held for the profile that has the hold, and not for another', async () => {
    await swell(AMARA_ACTOR)

    expect((await service.stateFor(TOLU, TODAY)).held).toBe(false)
  })

  it('rejects when the hold cannot be read, so the routine read fails closed instead of answering "no hold"', async () => {
    await swell()
    holds.openForFails = true

    await expect(service.stateFor(AMARA, TODAY)).rejects.toThrow()
  })
})

// --- 3. what a harm log may pause while a hold is open ---

describe('SkinCareService.log, a harm signal while a hold is open', () => {
  it('never pauses a held step: with no other active step it pauses the newest changed basic, never the sunscreen', async () => {
    await swell()

    const result = await harm()

    // Without the hold this is the treatment, the only active step.
    expect(result.paused).toMatchObject({ step: 'moisturise' })
    expect(await openRowOf('treat')).toBeUndefined()
  })

  it('goes on to the next basic by the usual rule, and the cap of two still sends the third harm log to a professional', async () => {
    await swell()
    const opened = (await holdOf())!
    const first = await harm()
    const second = await harm()

    const third = await harm()

    expect([first.paused?.step, second.paused?.step]).toEqual(['moisturise', 'cleanse'])
    expect(third.outcome).toEqual({ kind: 'professional', reason: 'harm-while-two-paused' })
    expect(third.paused).toBeNull()
    expect((await openPauses()).map((open) => open.step).sort()).toEqual(['cleanse', 'moisturise'])
    expect(await holdOf()).toEqual(opened)
    expect(escalationWrites()).toHaveLength(1)
  })

  it('does not pause the held treatment for a strong symptom during a step-down either: no other active step is a professional result', async () => {
    await swell()
    world.stepDown = true

    const result = await log(AMARA_ACTOR, STRONG_REDNESS)

    expect(result.outcome).toEqual({ kind: 'professional', reason: 'hard-to-ignore-during-step-down' })
    expect(result.paused).toBeNull()
    expect(await openPauses()).toEqual([])
  })
})

// --- 4. closing the hold ---

describe('SkinCareService.closeHold, who may close and what is closed', () => {
  it('answers 401 AUTH_REQUIRED with no session and 403 SIGNUP_REQUIRED to a guest, closing nothing', async () => {
    await swell()

    expect(await errorOf(close(PUBLIC))).toMatchObject({ name: 'UnauthorizedError', code: 'AUTH_REQUIRED' })
    expect(await errorOf(close(GUEST))).toMatchObject({ name: 'ForbiddenError', code: 'SIGNUP_REQUIRED' })
    expect(await holdOf()).toMatchObject({ closedAt: null })
  })

  it('answers 404 HOLD_NOT_FOUND when there is no open hold, and writes no check-in', async () => {
    const error = await errorOf(close())

    expect(error).toMatchObject({ name: 'NotFoundError', code: 'HOLD_NOT_FOUND' })
    expect(await openPauses()).toEqual([])
  })

  it('answers 404 HOLD_NOT_FOUND for the second close, which writes nothing more', async () => {
    await swell()
    await close()
    const after = await openPauses()

    const error = await errorOf(close())

    expect(error).toMatchObject({ name: 'NotFoundError', code: 'HOLD_NOT_FOUND' })
    expect(await openPauses()).toEqual(after)
  })

  it('lets one of two closes at once win: the other is 404, and the step gets one check-in', async () => {
    await swell()

    const settled = await Promise.allSettled([close(), close()])

    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    const lost = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected')!
    expect(lost.reason).toMatchObject({ code: 'HOLD_NOT_FOUND' })
    expect((await openPauses()).filter((open) => open.step === 'treat')).toHaveLength(1)
  })

  it('closes only the session profile\'s own hold', async () => {
    await swell(AMARA_ACTOR)

    expect(await errorOf(close(TOLU_ACTOR))).toMatchObject({ code: 'HOLD_NOT_FOUND' })
    expect(await holdOf(AMARA)).toMatchObject({ closedAt: null })
  })

  it.each(['seen', 'settled'] as const)('answers { closed: true } and closes the hold as %s, at the time of the close', async (how) => {
    await swell()
    const hold = (await holdOf())!
    const spy = vi.spyOn(holds, 'close')
    world.now = at(HOUR)

    const result = await close(AMARA_ACTOR, how)

    expect(result).toMatchObject({ closed: true })
    expect(spy).toHaveBeenCalledWith(AMARA, hold.id, how, world.now)
    expect(await holdOf()).toBeNull()
  })
})

describe('SkinCareService.closeHold, the check-ins it makes due the same day', () => {
  it('gives a held step with no row a paused row due today with no source log, so Undo refuses it', async () => {
    await swell()

    const result = await close()

    const created = (await openRowOf('treat'))!
    expect(created).toMatchObject({
      state: 'paused',
      productKey: 'prod-treat',
      productId: 'prod-treat',
      productRef: { kind: 'candidate', code: 'TREAT-1' },
      ingredientGroup: 'retinoid',
      pausedOn: TODAY,
      checkDay: TODAY,
      sameCount: 0,
      sourceLogId: null,
      ladderCode: null,
      ladderStartedOn: null,
    })
    expect(result.closed).toBe(true)
    expect(result.checkInsDue.map((due) => due.id)).toEqual([created.id])
    expect(await dueIds(TODAY)).toEqual([created.id])
    expect(await errorOf(undo(AMARA_ACTOR, created.id))).toMatchObject({ code: 'PAUSE_NOT_FOUND' })
  })

  it('holds back nothing else: the basics and the sunscreen get no row', async () => {
    await swell()

    await close()

    expect((await openPauses()).map((open) => open.step)).toEqual(['treat'])
  })

  it('lets the person answer Calmer the day they close, which starts the ladder of the step\'s own group', async () => {
    await swell()
    await close()
    const due = (await openRowOf('treat'))!

    const answered = await checkIn(AMARA_ACTOR, due.id, 'calmer')

    expect(answered).toMatchObject({ outcome: { kind: 'calmer' }, pause: { id: due.id, step: 'treat', state: 'bringing-back', checkDay: null } })
    const stored = await row(due.id)
    expect(stored).toMatchObject({ state: 'bringing-back', ladderStartedOn: TODAY })
    expect(ladderOf(stored)).toEqual(RETINOID_LADDER)
    expect(await service.stateFor(AMARA, TODAY)).toEqual({ pauses: [{ step: 'treat', productId: 'prod-treat', state: 'bringing-back', frequency: 'weekly', anchor: TODAY }], held: false })
  })

  it('puts an escalated step back to paused, due today with its "about the same" count cleared, and the next "about the same" is only that', async () => {
    const { id } = await unchangedForNineDays()
    expect(await row(id)).toMatchObject({ state: 'escalated', sameCount: 2 })
    world.now = at(11 * DAY)

    const result = await close()

    expect(await row(id)).toMatchObject({ state: 'paused', checkDay: dayAt(11), sameCount: 0 })
    expect(result.checkInsDue.map((due) => due.id)).toEqual([id])
    expect((await openPauses()).filter((open) => open.step === 'treat')).toHaveLength(1)
    // With the count kept at two this answer would send the person to a professional again.
    expect((await checkIn(AMARA_ACTOR, id, 'same')).outcome).toEqual({ kind: 'same' })
    expect(await row(id)).toMatchObject({ state: 'paused', sameCount: 1, checkDay: dayAt(14) })
  })

  it('moves the check day of a held step\'s open paused row to today, and keeps the log that paused it', async () => {
    const made = await harm()
    expect(await row(made.paused!.id)).toMatchObject({ checkDay: dayAt(3) })
    world.now = at(DAY)
    await swell()

    const result = await close()

    expect(await row(made.paused!.id)).toMatchObject({ state: 'paused', checkDay: dayAt(1), sourceLogId: made.log.id })
    expect(result.checkInsDue.map((due) => due.id)).toEqual([made.paused!.id])
    expect((await openPauses()).filter((open) => open.step === 'treat')).toHaveLength(1)
  })

  it('pauses a held step that is being brought back again, in place: due today, its ladder kept, no log of its own, no reaction mark', async () => {
    const { id } = await bringBack()
    const before = await row(id)
    await swell()
    world.now = at(5 * DAY)

    const result = await close()

    expect(await row(id)).toEqual({ ...before, state: 'paused', pausedOn: dayAt(5), checkDay: dayAt(5), sameCount: 0, sourceLogId: null })
    expect(result.checkInsDue.map((due) => due.id)).toEqual([id])
    expect((await openPauses()).filter((open) => open.step === 'treat')).toHaveLength(1)
    expect(await errorOf(undo(AMARA_ACTOR, id))).toMatchObject({ code: 'PAUSE_NOT_FOUND' })
    expect(world.safetyMarks).toEqual([])
    expect(world.catalogReads).toEqual([])
    expect(world.savedFor).toEqual([])
  })

  it('restarts the ladder at its first rung when the person answers Calmer after the close of a step that was being brought back', async () => {
    const { id } = await bringBack()
    await swell()
    world.now = at(5 * DAY)
    await close()

    await checkIn(AMARA_ACTOR, id, 'calmer')

    expect(await row(id)).toMatchObject({ state: 'bringing-back', ladderStartedOn: dayAt(5) })
    expect(await service.stateFor(AMARA, dayAt(5))).toEqual({ pauses: [{ step: 'treat', productId: 'prod-treat', state: 'bringing-back', frequency: 'weekly', anchor: dayAt(5) }], held: false })
  })

  it('leaves a paused row of a step that is not held (a basic) as it was, due when it was due', async () => {
    await swell()
    const basic = await harm()
    expect(basic.paused).toMatchObject({ step: 'moisturise' })

    const result = await close()

    expect(await row(basic.paused!.id)).toMatchObject({ state: 'paused', checkDay: dayAt(3) })
    expect(result.checkInsDue.map((due) => due.step)).toEqual(['treat'])
  })

  it('treats each held step by what it has, whatever order the rows were made in: brought back and escalated are paused due today, a step with no row gets one', async () => {
    const routine = amarasRoutine()
    routine.steps.find((s) => s.step === 'cleanse')!.activeGroups = ['exfoliating-acid']
    routine.steps.find((s) => s.step === 'moisturise')!.activeGroups = ['benzoyl-peroxide']
    // The sunscreen holds an active too, and is never held.
    routine.steps.find((s) => s.step === 'protect')!.activeGroups = ['retinoid']
    world.routines.set(AMARA, routine)
    const treatment = await harm()
    const moisturiser = await harm()
    expect([treatment.paused?.step, moisturiser.paused?.step]).toEqual(['treat', 'moisturise'])
    world.now = at(3 * DAY)
    await checkIn(AMARA_ACTOR, treatment.paused!.id, 'calmer')
    await checkIn(AMARA_ACTOR, moisturiser.paused!.id, 'worse')
    const brought = await row(treatment.paused!.id)
    expect(await holdOf()).not.toBeNull()

    const result = await close()

    expect(await row(treatment.paused!.id)).toEqual({ ...brought, state: 'paused', pausedOn: dayAt(3), checkDay: dayAt(3), sameCount: 0, sourceLogId: null })
    expect(await row(moisturiser.paused!.id)).toMatchObject({ state: 'paused', checkDay: dayAt(3), sameCount: 0 })
    const cleanser = (await openRowOf('cleanse'))!
    expect(cleanser).toMatchObject({ state: 'paused', checkDay: dayAt(3), sourceLogId: null, productKey: 'prod-cleanse' })
    expect(await openRowOf('protect')).toBeUndefined()
    expect(result.checkInsDue.map((due) => due.id).sort()).toEqual([treatment.paused!.id, moisturiser.paused!.id, cleanser.id].sort())
  })

  it('goes on with the other steps when the write for one fails: the hold is closed, the answer stands, and the failure is logged by ids', async () => {
    const routine = amarasRoutine()
    routine.steps.find((s) => s.step === 'cleanse')!.activeGroups = ['exfoliating-acid']
    world.routines.set(AMARA, routine)
    const treatment = await harm()
    expect(treatment.paused).toMatchObject({ step: 'treat' })
    await swell()
    vi.spyOn(pauses, 'update').mockRejectedValueOnce(new Error('down'))
    errors.length = 0

    const result = await close()

    expect(result.closed).toBe(true)
    expect(await holdOf()).toBeNull()
    const cleanser = (await openRowOf('cleanse'))!
    expect(cleanser).toMatchObject({ state: 'paused', checkDay: TODAY, sourceLogId: null })
    expect(result.checkInsDue.map((due) => due.id)).toEqual([cleanser.id])
    expect(errors.map((line) => line[0])).toEqual([{ outcome: 'skin-care-hold-close-step-failed', profileId: AMARA, pauseId: treatment.paused!.id }])
    expect(JSON.stringify(errors)).not.toContain('down')
  })

  it.each(ZONE_CASES)('reads the close day in the person\'s own zone, not the UTC day: in %s', async (zone, offset, local) => {
    world.zones.set(AMARA, zone)
    world.now = at(offset)
    expect(world.now.toISOString().slice(0, 10)).not.toBe(local)
    await swell()

    await close()

    expect(await openRowOf('treat')).toMatchObject({ pausedOn: local, checkDay: local })
    expect(await dueIds(local)).toHaveLength(1)
  })

  it('reads the close day, not the day the hold was opened', async () => {
    await swell()
    world.now = at(2 * DAY)

    await close()

    expect(await openRowOf('treat')).toMatchObject({ checkDay: dayAt(2) })
  })

  it('turns an escalated row back to paused, due today, when there is no routine at all (read fine, none exists)', async () => {
    const made = await harm()
    world.now = at(3 * DAY)
    await checkIn(AMARA_ACTOR, made.paused!.id, 'worse')
    world.routines.set(AMARA, null)
    world.now = at(4 * DAY)

    const result = await close()

    expect(result.closed).toBe(true)
    expect(await holdOf()).toBeNull()
    expect(await row(made.paused!.id)).toMatchObject({ state: 'paused', checkDay: dayAt(4), sameCount: 0 })
    expect(await dueIds(dayAt(4))).toEqual([made.paused!.id])
  })

  it('refuses with 503 and keeps the hold open when the routine cannot be read, so the steps it holds out are not let back blind, and a retry works', async () => {
    const result = await swell()
    world.routineReadFails = true
    const spy = vi.spyOn(holds, 'close')

    const error = await errorOf(close())

    expect(error).toMatchObject({ name: 'UnavailableError', code: 'ROUTINE_UNAVAILABLE' })
    expect(spy).not.toHaveBeenCalled()
    expect(await holdOf()).toMatchObject({ closedAt: null, sourceLogId: result.log.id })
    expect(await openPauses()).toEqual([])
    expect(JSON.stringify(errors)).not.toContain('routine read failed')

    world.routineReadFails = false
    expect(await close()).toMatchObject({ closed: true })
    expect(await holdOf()).toBeNull()
  })

  it.each<[string, (hold: EscalationHold) => EscalationHold | null]>([
    ['closed by another request meanwhile', () => null],
    ['replaced by another hold meanwhile', (hold) => ({ ...hold, id: 'another-hold' })],
  ])('answers 404 HOLD_NOT_FOUND and writes nothing when the hold is %s: the hold is read again just before it is closed', async (_name, then) => {
    await swell()
    const hold = (await holdOf())!
    const real = holds.openFor.bind(holds)
    vi.spyOn(holds, 'openFor').mockImplementationOnce(real).mockResolvedValueOnce(then(hold))
    const spy = vi.spyOn(holds, 'close')

    const error = await errorOf(close())

    expect(error).toMatchObject({ name: 'NotFoundError', code: 'HOLD_NOT_FOUND' })
    expect(spy).not.toHaveBeenCalled()
    expect(await openPauses()).toEqual([])
  })

  it('answers { closed: true, checkInsDue: [] } and logs ids only when the check-ins due cannot be read after the close', async () => {
    await swell()
    const real = pauses.openFor.bind(pauses)
    vi.spyOn(pauses, 'openFor').mockImplementationOnce(real).mockRejectedValueOnce(new Error('down'))
    errors.length = 0

    const result = await close()

    expect(result).toEqual({ closed: true, checkInsDue: [] })
    expect(await holdOf()).toBeNull()
    expect(errors.map((line) => line[0])).toEqual([{ outcome: 'skin-care-hold-close-due-failed', profileId: AMARA }])
    expect(JSON.stringify(errors)).not.toContain('down')
  })
})

// --- 4b. no ladder starts while a hold is open ---

describe('SkinCareService.answerCheckIn, while a hold is open', () => {
  /** A harm log pauses the treatment (due on day 3), a swelling log opens the hold, and the clock is on the check day. */
  const heldAndDue = async () => {
    const made = await harm()
    await swell()
    world.now = at(3 * DAY)
    return made.paused!.id
  }

  it.each(['calmer', 'same'] as const)('answers 409 HOLD_OPEN to %s on a held step and leaves the pause as it was', async (answer) => {
    const id = await heldAndDue()
    const before = await row(id)

    const error = await errorOf(checkIn(AMARA_ACTOR, id, answer))

    expect(error).toMatchObject({ name: 'ConflictError', code: 'HOLD_OPEN' })
    expect(await row(id)).toEqual(before)
    expect(world.inboxWrites.filter((write) => write.key.startsWith('bringing-back:'))).toEqual([])
    expect(await holdOf()).not.toBeNull()
  })

  it('still takes worse on a held step: a professional result, and the hold stays the one it was', async () => {
    const id = await heldAndDue()
    const opened = (await holdOf())!

    const answered = await checkIn(AMARA_ACTOR, id, 'worse')

    expect(answered).toMatchObject({ outcome: { kind: 'professional', reason: 'worse-after-pause' }, pause: { id, state: 'escalated' } })
    expect(await holdOf()).toEqual(opened)
  })

  it('still takes calmer on a pause whose step is not held (a basic)', async () => {
    await swell()
    const basic = await harm()
    expect(basic.paused).toMatchObject({ step: 'moisturise' })
    world.now = at(3 * DAY)

    const answered = await checkIn(AMARA_ACTOR, basic.paused!.id, 'calmer')

    expect(answered.outcome).toEqual({ kind: 'calmer' })
  })

  it('still takes calmer on the check-in with no step', async () => {
    world.routines.set(AMARA, null)
    const nothing = await harm()
    expect(nothing.outcome).toEqual({ kind: 'nothing-to-pause' })
    await swell()
    world.now = at(3 * DAY)
    const [stepless] = await service.checkInsDue(AMARA, dayAt(3))

    const answered = await checkIn(AMARA_ACTOR, stepless!.id, 'calmer')

    expect(answered).toMatchObject({ outcome: { kind: 'calmer' }, pause: { step: null, state: 'ended' } })
  })

  it('refuses with 503 and changes nothing when the routine cannot be read, as it cannot be told which steps are held', async () => {
    const id = await heldAndDue()
    const before = await row(id)
    world.routineReadFails = true

    const error = await errorOf(checkIn(AMARA_ACTOR, id, 'calmer'))

    expect(error).toMatchObject({ name: 'UnavailableError', code: 'ROUTINE_UNAVAILABLE' })
    expect(await row(id)).toEqual(before)
  })

  it('takes Calmer on the day the hold is closed, which starts the ladder at its first rung', async () => {
    const id = await heldAndDue()
    expect(await errorOf(checkIn(AMARA_ACTOR, id, 'calmer'))).toMatchObject({ code: 'HOLD_OPEN' })
    await close()

    const answered = await checkIn(AMARA_ACTOR, id, 'calmer')

    expect(answered).toMatchObject({ outcome: { kind: 'calmer' }, pause: { id, state: 'bringing-back' } })
    expect(await row(id)).toMatchObject({ state: 'bringing-back', ladderStartedOn: dayAt(3) })
    expect(ladderOf(await row(id))).toEqual(RETINOID_LADDER)
  })
})

describe('SkinCareService.checkInsDue, while a hold is open', () => {
  it('leaves out the rows of held steps, and keeps the check-in with no step and the steps that are not held', async () => {
    world.routines.set(AMARA, null)
    const nothing = await harm()
    world.routines.set(AMARA, amarasRoutine())
    const treatment = await harm()
    const basic = await harm()
    expect([treatment.paused?.step, basic.paused?.step]).toEqual(['treat', 'moisturise'])
    const stepless = (await openPauses()).find((open) => open.step === null)!
    expect(nothing.outcome).toEqual({ kind: 'nothing-to-pause' })
    expect(await dueIds(dayAt(3))).toEqual([treatment.paused!.id, basic.paused!.id, stepless.id].sort())
    await swell()

    expect(await dueIds(dayAt(3))).toEqual([basic.paused!.id, stepless.id].sort())

    await close()
    expect(await dueIds(dayAt(3))).toEqual([treatment.paused!.id, basic.paused!.id, stepless.id].sort())
  })

  it('leaves the rows as they are, and logs ids only, when the routine cannot be read: it cannot be told which steps are held', async () => {
    const made = await harm()
    await swell()
    world.routineReadFails = true
    errors.length = 0

    expect(await dueIds(dayAt(3))).toEqual([made.paused!.id])
    expect(errors.map((line) => line[0])).toEqual([{ outcome: 'skin-care-routine-read-failed', profileId: AMARA }])
  })

  it('rejects when the hold cannot be read', async () => {
    await harm()
    holds.openForFails = true

    await expect(service.checkInsDue(AMARA, dayAt(3))).rejects.toThrow()
  })
})

// --- 5. a product that keeps reacting ---

describe('SkinCareService, marking a product that keeps reacting', () => {
  it('marks nothing for one pause followed by Calmer', async () => {
    await bringBack()

    expect(world.safetyMarks).toEqual([])
    expect(world.savedFor).toEqual([])
  })

  it('marks nothing for the first pauses of two different steps', async () => {
    await harm()
    await harm()

    expect(world.safetyMarks).toEqual([])
    expect(world.savedFor).toEqual([])
    expect(world.catalogReads).toEqual([])
  })

  it('marks the pause\'s product with the brand, name and category the catalog gives it (not the routine\'s title) when a step being brought back is paused again, and queues a verdict build', async () => {
    await bringBack()
    world.now = at(3 * DAY + HOUR)

    const result = await harm()

    expect(result.outcome).toEqual({ kind: 'pause', duringStepDown: false })
    expect(world.safetyMarks).toEqual([{ profileId: AMARA, product: TREAT_PRODUCT }])
    expect(world.savedFor).toEqual([AMARA])
  })

  it('does not ask for a verdict build when the product was marked already', async () => {
    world.marked = false
    await bringBack()
    world.now = at(3 * DAY + HOUR)

    await harm()

    expect(world.safetyMarks).toEqual([{ profileId: AMARA, product: TREAT_PRODUCT }])
    expect(world.savedFor).toEqual([])
  })

  it('marks the ladder\'s product when the cap sends a harm log to a professional and pauses it again', async () => {
    const cleanse = world.routines.get(AMARA)!.steps.find((entry) => entry.step === 'cleanse')!
    treat().activeGroups = []
    cleanse.activeGroups = ['exfoliating-acid']
    cleanse.changedOn = dayAt(-1)
    const first = await harm()
    expect(first.paused).toMatchObject({ step: 'cleanse' })
    world.now = at(3 * DAY)
    await checkIn(AMARA_ACTOR, first.paused!.id, 'calmer')
    world.now = at(3 * DAY + HOUR)
    // The cleanser's product is not one the routine can key a pause by for a moment, so the ladder is stale and the next two harm logs pause the other steps.
    const key = [cleanse.productId, cleanse.productRef] as const
    cleanse.productId = null
    cleanse.productRef = { kind: 'none' }
    const second = await harm()
    const third = await harm()
    expect([second.paused?.step, third.paused?.step].sort()).toEqual(['moisturise', 'treat'])
    cleanse.productId = key[0]
    cleanse.productRef = key[1]
    expect(world.safetyMarks).toEqual([])
    world.now = at(3 * DAY + 2 * HOUR)

    const result = await harm()

    expect(result.outcome).toEqual({ kind: 'professional', reason: 'harm-while-two-paused' })
    expect((await row(first.paused!.id)).state).toBe('paused')
    expect(world.safetyMarks).toEqual([{ profileId: AMARA, product: { productId: 'prod-cleanse', brand: 'Kora', name: 'Clear Wash', category: 'body' } }])
    expect(world.savedFor).toEqual([AMARA])
  })

  it('marks the pause\'s product on a worse-after-pause result, and queues a verdict build', async () => {
    const made = await harm()
    world.now = at(3 * DAY)

    const answered = await checkIn(AMARA_ACTOR, made.paused!.id, 'worse')

    expect(answered.outcome).toEqual({ kind: 'professional', reason: 'worse-after-pause' })
    expect(world.safetyMarks).toEqual([{ profileId: AMARA, product: TREAT_PRODUCT }])
    expect(world.savedFor).toEqual([AMARA])
  })

  it('marks nothing on unchanged-after-checks', async () => {
    const { id } = await unchangedForNineDays()

    expect((await row(id)).state).toBe('escalated')
    expect(world.safetyMarks).toEqual([])
    expect(world.savedFor).toEqual([])
    expect(world.catalogReads).toEqual([])
  })

  it('marks nothing for a pause with no catalog product (a product with no label, keyed by its shelf entry), and reads no catalog row', async () => {
    treat().productId = null
    treat().productRef = { kind: 'shelf', id: 'entry-treat' }
    const made = await harm()
    expect(made.paused).toMatchObject({ step: 'treat' })
    expect(await row(made.paused!.id)).toMatchObject({ productKey: 'entry-treat', productId: null })
    world.now = at(3 * DAY)

    const answered = await checkIn(AMARA_ACTOR, made.paused!.id, 'worse')

    expect(answered.outcome).toEqual({ kind: 'professional', reason: 'worse-after-pause' })
    expect(await holdOf()).not.toBeNull()
    expect(world.catalogReads).toEqual([])
    expect(world.safetyMarks).toEqual([])
    expect(world.savedFor).toEqual([])
  })

  it('marks nothing when a no-label step being brought back is paused again', async () => {
    treat().productId = null
    treat().productRef = { kind: 'shelf', id: 'entry-treat' }
    await bringBack()
    world.now = at(3 * DAY + HOUR)

    const result = await harm()

    expect(result.outcome).toEqual({ kind: 'pause', duringStepDown: false })
    expect(world.catalogReads).toEqual([])
    expect(world.safetyMarks).toEqual([])
    expect(world.savedFor).toEqual([])
  })

  it.each([
    ['the catalog read', (w: World) => (w.catalogFails = true)],
    ['the safety mark', (w: World) => (w.safetyFails = true)],
    ['the verdict build', (w: World) => (w.savedForFails = true)],
  ])('answers the worse-after-pause result and opens the hold when %s fails, logging ids only', async (_name, fail) => {
    const made = await harm()
    world.now = at(3 * DAY)
    fail(world)

    const answered = await checkIn(AMARA_ACTOR, made.paused!.id, 'worse')

    expect(answered).toMatchObject({ outcome: { kind: 'professional', reason: 'worse-after-pause' }, pause: { id: made.paused!.id, state: 'escalated' } })
    expect(await holdOf()).toMatchObject({ reason: 'worse-after-pause' })
    expect(errors.map((line) => line[0])).toEqual(expect.arrayContaining([expect.objectContaining({ profileId: AMARA })]))
    expect(JSON.stringify(errors)).not.toContain('down')
    expect(JSON.stringify(errors)).not.toContain('Maison Noire')
  })

  it('answers the worse-after-pause result when the catalog does not hold the product, marking nothing', async () => {
    treat().productId = 'prod-treat-gone'
    const made = await harm()
    world.now = at(3 * DAY)

    const answered = await checkIn(AMARA_ACTOR, made.paused!.id, 'worse')

    expect(answered.outcome).toEqual({ kind: 'professional', reason: 'worse-after-pause' })
    expect(world.safetyMarks).toEqual([])
    expect(errors.map((line) => line[0])).toEqual(expect.arrayContaining([expect.objectContaining({ profileId: AMARA })]))
  })

  it('answers a harm log on a step being brought back as the same pause again when the mark fails: it is not taken for a pause that could not be written', async () => {
    const { id } = await bringBack()
    world.now = at(3 * DAY + HOUR)
    world.safetyFails = true
    errors.length = 0

    const result = await harm()

    expect(result.outcome).toEqual({ kind: 'pause', duringStepDown: false })
    expect(result.paused).toMatchObject({ id, step: 'treat' })
    expect((await repository.recent(AMARA, 20)).find((stored) => stored.id === result.log.id)).toMatchObject({ outcome: 'pause' })
    expect(await row(id)).toMatchObject({ state: 'paused', sourceLogId: result.log.id })
    expect(errors.map((line) => line[0])).toEqual(expect.arrayContaining([expect.objectContaining({ profileId: AMARA })]))
    expect(JSON.stringify(errors)).not.toContain('down')
  })
})

// --- review fixes ---

describe('the inbox row of a hold, when the first professional result could not write it', () => {
  it('is written by the next professional result: exactly one row, under the open hold\'s key', async () => {
    world.escalations = {}
    const refused = await errorOf(log(AMARA_ACTOR, SWELLING))
    expect(refused).toMatchObject({ code: 'CONTENT_UNAVAILABLE' })
    const hold = (await holdOf())!
    expect(escalationWrites()).toEqual([])
    world.escalations = { ...ESCALATIONS }
    world.now = at(HOUR)

    await log(AMARA_ACTOR, { noticing: ['pus-or-hot-patch'], howBad: 'mild' })

    expect(escalationWrites()).toEqual([expect.objectContaining({ profileId: AMARA, kind: 'escalation', key: `escalation:${hold.id}`, body: expect.stringContaining(ESCALATIONS['pus-or-hot-patch'].whoToSee) })])
    expect((await holdOf())!.id).toBe(hold.id)
  })

  it('is written by a professional check-in too, and a third result adds none', async () => {
    world.inboxFails = true
    await swell()
    const hold = (await holdOf())!
    expect(escalationWrites()).toEqual([])
    world.inboxFails = false
    const made = await harm()
    world.now = at(3 * DAY)

    await checkIn(AMARA_ACTOR, made.paused!.id, 'worse')
    await swell()

    expect(escalationWrites().map((write) => write.key)).toEqual([`escalation:${hold.id}`])
  })
})

describe('a reaction mark is for a pause the person\'s own log caused', () => {
  it('marks nothing on Worse for a pause that closing a hold made (it has no log of the person\'s)', async () => {
    await swell()
    await close()
    const made = (await openRowOf('treat'))!
    expect(made.sourceLogId).toBeNull()

    const answered = await checkIn(AMARA_ACTOR, made.id, 'worse')

    expect(answered.outcome).toEqual({ kind: 'professional', reason: 'worse-after-pause' })
    expect(world.catalogReads).toEqual([])
    expect(world.safetyMarks).toEqual([])
    expect(world.savedFor).toEqual([])
    expect(await holdOf()).not.toBeNull()
  })
})

describe('SkinCareService.log, when the hold cannot be read', () => {
  it('answers a harm log as usual, and may pause a step the hold keeps out, which closing the hold then finds already paused', async () => {
    await swell()
    holds.openForFails = true
    errors.length = 0

    const result = await harm()

    expect(result.outcome).toEqual({ kind: 'pause', duringStepDown: false })
    expect(result.paused).toMatchObject({ step: 'treat' })
    expect(errors.map((line) => line[0])).toEqual([{ outcome: 'skin-care-hold-read-failed', profileId: AMARA }])
    expect(JSON.stringify(errors)).not.toContain('down')

    holds.openForFails = false
    await close()
    expect((await openPauses()).filter((open) => open.step === 'treat')).toHaveLength(1)
    expect(await row(result.paused!.id)).toMatchObject({ state: 'paused', checkDay: TODAY })
  })
})

describe('SkinCareService.log, when the verdict build cannot be asked for', () => {
  it('answers a harm log on a step being brought back as the same pause again, with the mark made, and logs ids only', async () => {
    const { id } = await bringBack()
    world.now = at(3 * DAY + HOUR)
    world.savedForFails = true
    errors.length = 0

    const result = await harm()

    expect(result.outcome).toEqual({ kind: 'pause', duringStepDown: false })
    expect(result.paused).toMatchObject({ id, step: 'treat' })
    expect(await row(id)).toMatchObject({ state: 'paused', sourceLogId: result.log.id })
    expect(world.safetyMarks).toEqual([{ profileId: AMARA, product: TREAT_PRODUCT }])
    expect(errors.map((line) => line[0])).toEqual([{ outcome: 'skin-care-reaction-mark-failed', profileId: AMARA, pauseId: id }])
    expect(JSON.stringify(errors)).not.toContain('down')
    expect(JSON.stringify(errors)).not.toContain('Maison Noire')
  })
})
