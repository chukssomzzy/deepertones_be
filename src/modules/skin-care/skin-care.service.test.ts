import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type Actor, runAs } from '../../lib/context'
import type { CatalogWorkbookService, Escalation, Response } from '../catalog/catalog.workbook.service'
import type { SkinCareRoutine } from './skin-care.types'
import type { EscalationReason, ResponseOutcome } from '../catalog/catalog.vocabulary'
import { FORBIDDEN_WORDING } from '../routines/routines.wording'
import { SKIN_OUTCOME_RULES_VERSION } from './skin-care.outcomes'
import { FakeSkinCareRepository } from './skin-care.repository.fake'
import { FakeEscalationHoldsRepository } from './skin-care.holds.repository.fake'
import { FakeStepPausesRepository } from './skin-care.pauses.repository.fake'
import { SkinCareService } from './skin-care.service'

// Logging how the skin feels (spec #233, PR 2): what the routes of PR 4b will call. The service is tested at its own seam with a world fake: one mutable clock, the
// stored time zones, the reviewed text of the workbook, and whether a step-down is running. The repository is the real fake.
//
// THE CONTRACT THIS FILE PINS (assumed: the brief names the behaviour, not the constructor or the shapes; they follow RemindersService):
//   new SkinCareService({ repository, workbook, reminders, routine, now? })
//     repository  SkinCareRepository (append, recent, markOverridden; see skin-care.repository.contract.ts)
//     workbook    Pick<CatalogWorkbookService, 'responseFor' | 'escalationFor'>   the reviewed text; null where the team has not written a row yet
//     reminders   Pick<RemindersService, 'zoneFor'>                                the profile's stored zone, null for none (the day is then UTC)
//     routine     { stepDownRunning(profileId, today): Promise<boolean> }          today is the person's local day 'YYYY-MM-DD'; the container's stub answers false until PR 4a/4b
//     now         () => Date                                                      the clock; the log's createdAt and its local day come from it
//   log(input: { noticing: Noticing[]; where?: Where[]; howBad?: HowBad | null; note?: string | null }): Promise<LogResult>
//     LogResult = { log: { id, day, noticing, where, howBad, outcome }, outcome: SkinOutcome, response }
//     log.outcome is the outcome's kind (what is stored); `outcome` is the whole SkinOutcome; `where` is [] when none was given; `howBad` is null for a log of only nothing-unusual.
//     response, by the outcome's kind:
//       advice        Response[]    one { title, body, whatToDoNow } per code, in the order of outcome.codes
//       expected-flare Response     the reviewed `expected-flare` row
//       professional  Escalation & { facts: { noticing, where, howBad, note } }   the reviewed row of the reason, and what the person logged (note null when none)
//       pause         null          PR 4b fills it
//       logged        null
//   recent(): Promise<{ id, day, noticing, where, howBad, outcome }[]>      the session profile's last 20 logs, newest first, without the note
//   PR 4b (see skin-care.service.pauses.test.ts for the pauses themselves): the constructor also takes `pauses` (StepPausesRepository) and `inbox` ({ write }), `routine` also answers
//     skinCareRoutineFor(profileId), and every LogResult has `paused` (null unless a step was paused). A `pause` outcome is turned into an action: the paused step, a professional
//     (cap, or hard to ignore during a step-down with no other active step) or `nothing-to-pause`; so `pause` now has the reviewed `paused` text, and needs a started routine.
//   Gates, in order: 401 AUTH_REQUIRED (no session), 403 SIGNUP_REQUIRED for a guest (before the input is looked at), then validation. Allowed before Start and with no routine.
//   Validation (ValidationError, code VALIDATION_FAILED, nothing stored): at least one noticing; nothing-unusual only alone; howBad required unless the log is only nothing-unusual
//     (given, it is accepted and the log is still `logged`); a note of at most 500 characters. Duplicates in a list collapse.
//   A missing approved row (advice, expected-flare, professional) is UnavailableError CONTENT_UNAVAILABLE (503) AFTER the log is stored. pause and logged never need a row in this PR.
//   The note is stored and echoed in a professional response's facts, never read by the rules and never written to a log line.

const T0 = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs)

const AMARA_USER = 'user-amara'
const AMARA = 'profile-amara'
const TOLU_USER = 'user-tolu'
const TOLU = 'profile-tolu'

const actor = (userId: string, profileId: string, status: 'anonymous' | 'verified' = 'verified'): Actor => ({ kind: 'user', userId, status, profileId })
const AMARA_ACTOR = actor(AMARA_USER, AMARA)
const TOLU_ACTOR = actor(TOLU_USER, TOLU)
const GUEST = actor('user-guest', 'profile-guest', 'anonymous')
const PUBLIC: Actor = { kind: 'public' }

// Reviewed text of the shape the workbook holds; each line says which row it is, so a test can tell which one it was given.
const RESPONSES: Partial<Record<ResponseOutcome, Response>> = {
  'advice-tightness': { title: 'Tight or dry skin', body: 'Tightness is common in the first weeks while your skin settles.', whatToDoNow: 'Use a gentle cleanser and a plain moisturiser, a little more often.' },
  'advice-itching': { title: 'Itchy skin', body: 'Mild itching is common while your skin gets used to a change.', whatToDoNow: 'Skip anything scented and keep your moisturiser plain.' },
  'advice-breakouts': { title: 'New breakouts', body: 'A few new spots can show up in the first weeks and often settle.', whatToDoNow: 'Keep your routine as it is and do not pick at them.' },
  'expected-flare': { title: 'This is the expected flare', body: 'Redness and stinging are common while you step down a cream, and they pass.', whatToDoNow: null },
  paused: { title: 'We paused your {step}', body: 'Your skin needs a rest from your {step}. We will ask how it feels in three days.', whatToDoNow: 'Skip anything that stings. Keep sunscreen if it does not sting.' },
  'nothing-to-pause': { title: 'Nothing to pause yet', body: 'Skip anything that stings and rinse with water.', whatToDoNow: 'Keep sunscreen if it does not sting.' },
}
const STARTED_ROUTINE: SkinCareRoutine = {
  dayOne: '2030-06-10',
  steps: [{ step: 'treat', title: 'Retinol Serum', productRef: { kind: 'candidate', code: 'TREAT-1' }, productId: 'prod-treat', changedOn: '2030-06-12', activeGroups: ['retinoid'] }],
  stepDownRunning: false,
}
const ESCALATIONS: Partial<Record<EscalationReason, Escalation>> = {
  'pus-or-hot-patch': { whoToSee: 'A doctor or pharmacist about pus or a hot patch.', howSoon: 'Today.', whatToTellThem: 'Where it is, since when, and the products you have used this week.' },
  swelling: { whoToSee: 'A doctor or pharmacist about swelling.', howSoon: 'Today, and straight away if it spreads.', whatToTellThem: 'Where it swelled, since when, and what you used before.' },
  'near-eyes': { whoToSee: 'A doctor or pharmacist about skin near your eyes.', howSoon: 'Within a day.', whatToTellThem: 'What you noticed near your eyes and what you used.' },
}

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error as Error & { code?: string }
  }
  throw new Error('expected the promise to reject')
}
// A professional response repeats the note in its facts; everything else in a response is reviewed text, which no note may change.
const withoutNote = (response: unknown) =>
  response !== null && typeof response === 'object' && 'facts' in response ? { ...response, facts: { ...(response.facts as object), note: null } } : response
const sameMembers = <T>(actual: T[], expected: T[]) => expect([...actual].sort()).toEqual([...expected].sort())

type World = {
  now: Date
  zones: Map<string, string | null>
  stepDown: boolean
  stepDownFails: boolean
  zoneFails: boolean
  responses: Partial<Record<ResponseOutcome, Response>>
  escalations: Partial<Record<EscalationReason, Escalation>>
  stepDownAsked: [string, string][]
  /** The routine in force: by default one started step, a treat step with a retinoid, so a pause has a step to pause. */
  routine: SkinCareRoutine | null
}
let world: World
let repository: FakeSkinCareRepository
let pauses: FakeStepPausesRepository
let service: SkinCareService

const makeService = () =>
  new SkinCareService({
    repository,
    pauses,
    holds: new FakeEscalationHoldsRepository(),
    safety: { markReactionProduct: async () => ({ marked: false }) },
    verdicts: { savedFor: async () => null },
    catalog: { namedProduct: async () => Promise.reject(new Error('unused')) },
    inbox: { write: async () => ({ id: 'inbox-row', created: true }) },
    workbook: {
      responseFor: async (outcome) => world.responses[outcome] ?? null,
      escalationFor: async (reason) => world.escalations[reason] ?? null,
      reintroductionFor: async () => [],
    } satisfies Pick<CatalogWorkbookService, 'responseFor' | 'escalationFor' | 'reintroductionFor'>,
    reminders: {
      zoneFor: async (profileId: string) => {
        if (world.zoneFails) throw new Error('zone read failed')
        return world.zones.get(profileId) ?? null
      },
    },
    routine: {
      stepDownRunning: async (profileId: string, today: string) => {
        world.stepDownAsked.push([profileId, today])
        if (world.stepDownFails) throw new Error('step-down read failed')
        return world.stepDown
      },
      skinCareRoutineFor: async () => (world.routine === null ? null : { ...structuredClone(world.routine), stepDownRunning: world.stepDown }),
    },
    now: () => world.now,
  })

type LogInput = Parameters<SkinCareService['log']>[0]
const log = (who: Actor, input: LogInput) => runAs(who, () => service.log(input))
const recent = (who: Actor) => runAs(who, () => service.recent())
const stored = (profileId: string) => repository.recent(profileId, 100)

beforeEach(() => {
  world = { now: T0, zones: new Map(), stepDown: false, stepDownFails: false, zoneFails: false, responses: { ...RESPONSES }, escalations: { ...ESCALATIONS }, stepDownAsked: [], routine: structuredClone(STARTED_ROUTINE) }
  repository = new FakeSkinCareRepository()
  pauses = new FakeStepPausesRepository()
  service = makeService()
})

describe('SkinCareService.log, what the rules decide', () => {
  it('answers plain advice for mild tightness: the log, the outcome and the reviewed line', async () => {
    const result = await log(AMARA_ACTOR, { noticing: ['tightness-or-dryness'], howBad: 'mild' })

    expect(result).toEqual({
      log: { id: expect.any(String), day: '2030-06-15', noticing: ['tightness-or-dryness'], where: [], howBad: 'mild', outcome: 'advice' },
      outcome: { kind: 'advice', codes: ['advice-tightness'] },
      response: [RESPONSES['advice-tightness']],
      paused: null,
    })
  })

  it('answers one reviewed line for each advice code, in the order of the outcome\'s codes', async () => {
    const result = await log(AMARA_ACTOR, { noticing: ['new-breakouts', 'itching', 'tightness-or-dryness'], howBad: 'noticeable' })

    expect(result.outcome).toEqual({ kind: 'advice', codes: ['advice-tightness', 'advice-itching', 'advice-breakouts'] })
    expect(result.response).toEqual([RESPONSES['advice-tightness'], RESPONSES['advice-itching'], RESPONSES['advice-breakouts']])
  })

  // PR 4b: a pause outcome is acted on, so the answer is the reviewed `paused` text with {step} filled, for the step the routine's rules chose (the treat step of this world).
  it('pauses for stinging, and answers the reviewed paused text for the step it paused', async () => {
    const result = await log(AMARA_ACTOR, { noticing: ['stinging-or-burning'], where: ['cheeks'], howBad: 'mild' })

    expect(result.outcome).toEqual({ kind: 'pause', duringStepDown: false })
    expect(result.response).toMatchObject({ title: 'We paused your Treatment' })
    expect(result.paused).toMatchObject({ step: 'treat' })
    expect(result.log).toMatchObject({ outcome: 'pause', where: ['cheeks'], howBad: 'mild' })
  })

  it('pauses for any symptom at hard-to-ignore', async () => {
    const result = await log(AMARA_ACTOR, { noticing: ['itching'], howBad: 'hard-to-ignore' })

    expect(result.outcome).toEqual({ kind: 'pause', duringStepDown: false })
  })

  it('reads whether a step-down is running for this profile on the person\'s local day, and explains mild redness as the expected flare', async () => {
    world.stepDown = true
    world.zones.set(AMARA, 'Africa/Lagos')

    const result = await log(AMARA_ACTOR, { noticing: ['new-redness'], howBad: 'noticeable' })

    expect(world.stepDownAsked).toEqual([[AMARA, '2030-06-15']])
    expect(result.outcome).toEqual({ kind: 'expected-flare' })
    expect(result.response).toEqual(RESPONSES['expected-flare'])
    expect(result.log.outcome).toBe('expected-flare')
  })

  it('keeps a hard-to-ignore pause during a step-down, marked, when another active step can be paused', async () => {
    world.stepDown = true

    const result = await log(AMARA_ACTOR, { noticing: ['new-redness'], howBad: 'hard-to-ignore' })

    expect(result.outcome).toEqual({ kind: 'pause', duringStepDown: true })
    expect(result.response).toMatchObject({ title: 'We paused your Treatment' })
  })

  it('does not take a step-down into account for a profile whose step-down is not running (the answer is per profile)', async () => {
    const result = await log(TOLU_ACTOR, { noticing: ['stinging-or-burning'], howBad: 'mild' })

    expect(result.outcome).toEqual({ kind: 'pause', duringStepDown: false })
    expect(world.stepDownAsked).toEqual([[TOLU, '2030-06-15']])
  })

  it.each([
    ['pus-or-hot-patch', { noticing: ['pus-or-hot-patch'], howBad: 'mild' }],
    ['swelling', { noticing: ['swelling'], howBad: 'noticeable' }],
    ['near-eyes', { noticing: ['itching'], where: ['near-eyes'], howBad: 'mild' }],
  ] as [EscalationReason, LogInput][])('sends %s to a professional with the reviewed row of that reason and what the person logged', async (reason, input) => {
    const result = await log(AMARA_ACTOR, { ...input, note: 'Started after the new serum.' })

    expect(result.outcome).toEqual({ kind: 'professional', reason })
    expect(result.log.outcome).toBe('professional')
    expect(result.response).toEqual({
      ...ESCALATIONS[reason],
      facts: { noticing: input.noticing, where: input.where ?? [], howBad: input.howBad, note: 'Started after the new serum.' },
    })
  })

  it('gives the facts a null note when none was written, and an empty list of places when none was given', async () => {
    const result = await log(AMARA_ACTOR, { noticing: ['swelling'], howBad: 'hard-to-ignore' })

    expect(result.response).toEqual({ ...ESCALATIONS.swelling, facts: { noticing: ['swelling'], where: [], howBad: 'hard-to-ignore', note: null } })
  })

  it('sends a red flag to a professional before any routine exists, a step-down running or not (story 8)', async () => {
    world.stepDown = true

    const result = await log(AMARA_ACTOR, { noticing: ['swelling', 'new-redness'], howBad: 'mild' })

    expect(result.outcome).toEqual({ kind: 'professional', reason: 'swelling' })
  })

  it('records a good day: logged, no level, no reviewed line', async () => {
    const result = await log(AMARA_ACTOR, { noticing: ['nothing-unusual'] })

    expect(result).toEqual({
      log: { id: expect.any(String), day: '2030-06-15', noticing: ['nothing-unusual'], where: [], howBad: null, outcome: 'logged' },
      outcome: { kind: 'logged' },
      response: null,
      paused: null,
    })
  })

  it('accepts a level with nothing-unusual alone, and it is still a good day', async () => {
    const result = await log(AMARA_ACTOR, { noticing: ['nothing-unusual'], howBad: 'hard-to-ignore' })

    expect(result.outcome).toEqual({ kind: 'logged' })
  })

  it('lets a person log more than once a day, each its own log', async () => {
    const morning = await log(AMARA_ACTOR, { noticing: ['nothing-unusual'] })
    world.now = at(8 * HOUR)
    const evening = await log(AMARA_ACTOR, { noticing: ['itching'], howBad: 'mild' })

    expect(morning.log.id).not.toBe(evening.log.id)
    expect(morning.log.day).toBe(evening.log.day)
    expect(await stored(AMARA)).toHaveLength(2)
  })

  it('never lets the note change the outcome or the reviewed lines', async () => {
    const notes = [null, 'I think my skin is swelling and there is pus near my eyes.', 'All fine, nothing unusual at all.', 'a'.repeat(500)]
    for (const input of [
      { noticing: ['stinging-or-burning'], howBad: 'mild' },
      { noticing: ['itching'], howBad: 'noticeable' },
      { noticing: ['swelling'], howBad: 'mild' },
      { noticing: ['nothing-unusual'] },
    ] as LogInput[]) {
      // A pause is a state: each log starts with none, so the same input comes to the same outcome.
      const fresh = () => {
        pauses = new FakeStepPausesRepository()
        service = makeService()
      }
      fresh()
      const bare = await log(AMARA_ACTOR, input)
      for (const note of notes) {
        fresh()
        const withNote = await log(AMARA_ACTOR, { ...input, note })
        expect(withNote.outcome).toEqual(bare.outcome)
        expect(withNote.log.outcome).toBe(bare.log.outcome)
        // A professional response repeats the note in its facts, and nowhere else.
        expect(withoutNote(withNote.response)).toEqual(withoutNote(bare.response))
      }
    }
  })
})

describe('SkinCareService.log, what is stored', () => {
  it('stores the log as the rules decided it, with the note, the local day, the rules version and the time it was made', async () => {
    world.now = at(5 * MINUTE)
    const result = await log(AMARA_ACTOR, { noticing: ['swelling'], where: ['nose'], howBad: 'noticeable', note: 'Since Tuesday.' })

    const [row, ...rest] = await stored(AMARA)
    expect(rest).toEqual([])
    expect(row).toMatchObject({
      id: result.log.id,
      profileId: AMARA,
      noticing: ['swelling'],
      where: ['nose'],
      howBad: 'noticeable',
      note: 'Since Tuesday.',
      localDay: '2030-06-15',
      outcome: 'professional',
      reason: 'swelling',
      rulesVersion: SKIN_OUTCOME_RULES_VERSION,
      overridden: false,
    })
    expect(row!.createdAt.getTime()).toBe(at(5 * MINUTE).getTime())
  })

  it('stores no reason for an outcome that is not a professional one, and a null note when none was written', async () => {
    await log(AMARA_ACTOR, { noticing: ['new-redness'], howBad: 'mild' })

    expect((await stored(AMARA))[0]).toMatchObject({ outcome: 'pause', reason: null, note: null })
  })

  it('stores the note exactly as written, and does not store it twice or anywhere it was not given', async () => {
    await log(AMARA_ACTOR, { noticing: ['itching'], howBad: 'mild', note: 'Line one\nLine two "quoted"' })
    await log(AMARA_ACTOR, { noticing: ['itching'], howBad: 'mild' })

    const notes = (await stored(AMARA)).map((row) => row.note)
    sameMembers(notes, ['Line one\nLine two "quoted"', null])
  })

  it('stores each profile\'s logs under its own profile', async () => {
    await log(AMARA_ACTOR, { noticing: ['itching'], howBad: 'mild' })
    await log(TOLU_ACTOR, { noticing: ['nothing-unusual'] })

    expect((await stored(AMARA)).map((row) => row.outcome)).toEqual(['advice'])
    expect((await stored(TOLU)).map((row) => row.outcome)).toEqual(['logged'])
  })

  it('collapses a symptom or a place named twice, in what it answers, what it stores and the one advice line', async () => {
    const result = await log(AMARA_ACTOR, { noticing: ['itching', 'itching'], where: ['cheeks', 'cheeks', 'nose'], howBad: 'mild' })

    expect(result.log.noticing).toEqual(['itching'])
    sameMembers(result.log.where, ['cheeks', 'nose'])
    expect(result.outcome).toEqual({ kind: 'advice', codes: ['advice-itching'] })
    expect(result.response).toEqual([RESPONSES['advice-itching']])
    const [row] = await stored(AMARA)
    expect(row!.noticing).toEqual(['itching'])
    sameMembers(row!.where, ['cheeks', 'nose'])
  })

  it('collapses nothing-unusual named twice to the one good day', async () => {
    const result = await log(AMARA_ACTOR, { noticing: ['nothing-unusual', 'nothing-unusual'] })

    expect(result.log.noticing).toEqual(['nothing-unusual'])
    expect(result.outcome).toEqual({ kind: 'logged' })
  })
})

describe('SkinCareService.log, the local day', () => {
  // 2030-06-15T12:00Z. Lagos is UTC+1 all year, so its midnight is 23:00Z (T0 + 11h). New York is on summer time, UTC-4, so its midnight is 04:00Z the next day (T0 + 16h).
  // With no stored zone the day is UTC, which turns over at 00:00Z (T0 + 12h).
  it.each([
    ['Africa/Lagos', 11 * HOUR - 1, '2030-06-15'],
    ['Africa/Lagos', 11 * HOUR, '2030-06-16'],
    ['America/New_York', 16 * HOUR - 1, '2030-06-15'],
    ['America/New_York', 16 * HOUR, '2030-06-16'],
    ['America/New_York', 12 * HOUR, '2030-06-15'],
    [null, 12 * HOUR - 1, '2030-06-15'],
    [null, 12 * HOUR, '2030-06-16'],
  ] as [string | null, number, string][])('puts a log made in %s at T0 + %i ms on the day %s', async (zone, offset, day) => {
    world.zones.set(AMARA, zone)
    world.now = at(offset)

    const result = await log(AMARA_ACTOR, { noticing: ['itching'], howBad: 'mild' })

    expect(result.log.day).toBe(day)
    expect((await stored(AMARA))[0]!.localDay).toBe(day)
    // Advice does not depend on a step-down, so none is asked about.
    expect(world.stepDownAsked).toEqual([])
  })

  it('uses each profile\'s own zone at the same instant', async () => {
    world.zones.set(AMARA, 'Africa/Lagos')
    world.zones.set(TOLU, 'America/New_York')
    world.now = at(14 * HOUR)

    const amara = await log(AMARA_ACTOR, { noticing: ['nothing-unusual'] })
    const tolu = await log(TOLU_ACTOR, { noticing: ['nothing-unusual'] })

    expect(amara.log.day).toBe('2030-06-16')
    expect(tolu.log.day).toBe('2030-06-15')
  })

  it('shows the same day when it is read back', async () => {
    world.zones.set(AMARA, 'Africa/Lagos')
    world.now = at(11 * HOUR)
    await log(AMARA_ACTOR, { noticing: ['nothing-unusual'] })

    expect((await recent(AMARA_ACTOR))[0]).toMatchObject({ day: '2030-06-16' })
  })
})

describe('SkinCareService.log, validation', () => {
  const refused = async (input: LogInput) => {
    const error = await errorOf(log(AMARA_ACTOR, input))
    expect(error).toMatchObject({ name: 'ValidationError', code: 'VALIDATION_FAILED' })
    expect(await stored(AMARA)).toEqual([])
    expect(world.stepDownAsked).toEqual([])
  }

  it('refuses a log that notices nothing at all', async () => {
    await refused({ noticing: [], howBad: 'mild' })
  })

  it('refuses nothing-unusual together with any other symptom, whatever the level', async () => {
    await refused({ noticing: ['nothing-unusual', 'itching'], howBad: 'mild' })
    await refused({ noticing: ['stinging-or-burning', 'nothing-unusual'], howBad: 'hard-to-ignore' })
    await refused({ noticing: ['nothing-unusual', 'swelling'] })
  })

  // Owner decision (#233): a place with nothing unusual is a mistake in the request, never a red flag, so the pure rules never see it.
  it('refuses nothing-unusual together with a place, near the eyes or not', async () => {
    await refused({ noticing: ['nothing-unusual'], where: ['near-eyes'] })
    await refused({ noticing: ['nothing-unusual'], where: ['cheeks'] })
    await refused({ noticing: ['nothing-unusual'], where: ['everywhere', 'nose'], howBad: 'mild' })
  })

  it('refuses a symptom, a place or a level that is not in the lists, and stores nothing', async () => {
    await refused({ noticing: ['itching', 'rash'], howBad: 'mild' } as unknown as LogInput)
    await refused({ noticing: ['itching'], where: ['cheeks', 'ankle'], howBad: 'mild' } as unknown as LogInput)
    await refused({ noticing: ['itching'], howBad: 'severe' } as unknown as LogInput)
    await refused({ noticing: ['nothing-unusual'], howBad: 'severe' } as unknown as LogInput)
    await refused({ noticing: 'itching', howBad: 'mild' } as unknown as LogInput)
    await refused({ noticing: ['itching'], where: 'cheeks', howBad: 'mild' } as unknown as LogInput)
  })

  it('refuses a note that is not text', async () => {
    await refused({ noticing: ['itching'], howBad: 'mild', note: 42 } as unknown as LogInput)
    await refused({ noticing: ['itching'], howBad: 'mild', note: { text: 'hello' } } as unknown as LogInput)
    await refused({ noticing: ['itching'], howBad: 'mild', note: ['hello'] } as unknown as LogInput)
  })

  it('counts a note in characters, not UTF-16 units: 300 emoji pass and 501 characters fail', async () => {
    const accepted = await log(AMARA_ACTOR, { noticing: ['itching'], howBad: 'mild', note: '😀'.repeat(300) })
    expect(accepted.outcome.kind).toBe('advice')
    expect((await stored(AMARA))[0]!.note).toBe('😀'.repeat(300))
    await log(AMARA_ACTOR, { noticing: ['itching'], howBad: 'mild', note: '😀'.repeat(500) })

    const error = await errorOf(log(AMARA_ACTOR, { noticing: ['itching'], howBad: 'mild', note: '😀'.repeat(501) }))

    expect(error).toMatchObject({ name: 'ValidationError', code: 'VALIDATION_FAILED' })
    expect(await stored(AMARA)).toHaveLength(2)
  })

  it('refuses a symptom with no level, missing or null', async () => {
    await refused({ noticing: ['itching'] })
    await refused({ noticing: ['swelling'], howBad: null })
    await refused({ noticing: ['stinging-or-burning', 'itching'], where: ['cheeks'], howBad: null })
  })

  it('accepts a note of exactly 500 characters', async () => {
    const accepted = await log(AMARA_ACTOR, { noticing: ['itching'], howBad: 'mild', note: 'a'.repeat(500) })

    expect(accepted.outcome.kind).toBe('advice')
    expect((await stored(AMARA))[0]!.note).toBe('a'.repeat(500))
  })

  it('refuses a note of 501 characters', async () => {
    await refused({ noticing: ['itching'], howBad: 'mild', note: 'a'.repeat(501) })
  })

  it('counts a note\'s length in characters, not bytes', async () => {
    await log(AMARA_ACTOR, { noticing: ['itching'], howBad: 'mild', note: 'é'.repeat(500) })

    expect((await stored(AMARA))[0]!.note).toBe('é'.repeat(500))
  })

  it('accepts a null note and no note', async () => {
    await log(AMARA_ACTOR, { noticing: ['itching'], howBad: 'mild', note: null })
    await log(AMARA_ACTOR, { noticing: ['itching'], howBad: 'mild' })

    expect(await stored(AMARA)).toHaveLength(2)
  })
})

describe('SkinCareService.log, the {step} in reviewed text', () => {
  it('fills {step} with "your routine" in the title, body and what to do now of advice and the expected flare', async () => {
    world.responses = {
      'advice-itching': { title: 'Itching and {step}', body: 'Go gently with {step}. {step} will settle.', whatToDoNow: 'Keep {step} plain.' },
      'advice-breakouts': { title: 'Spots', body: 'No placeholder here.', whatToDoNow: null },
      'expected-flare': { title: 'The flare and {step}', body: 'It passes with {step}.', whatToDoNow: 'Rest {step}.' },
    }

    const advice = await log(AMARA_ACTOR, { noticing: ['itching', 'new-breakouts'], howBad: 'mild' })
    world.stepDown = true
    const flare = await log(AMARA_ACTOR, { noticing: ['new-redness'], howBad: 'mild' })

    expect(advice.response).toEqual([
      { title: 'Itching and your routine', body: 'Go gently with your routine. your routine will settle.', whatToDoNow: 'Keep your routine plain.' },
      { title: 'Spots', body: 'No placeholder here.', whatToDoNow: null },
    ])
    expect(flare.response).toEqual({ title: 'The flare and your routine', body: 'It passes with your routine.', whatToDoNow: 'Rest your routine.' })
  })

  it('leaves an escalation row as it is written', async () => {
    const result = await log(AMARA_ACTOR, { noticing: ['swelling'], howBad: 'mild' })

    expect(result.response).toMatchObject(ESCALATIONS.swelling!)
  })
})

describe('SkinCareService.log, when a read fails', () => {
  it('never reads the step-down for a red flag, so it cannot fail on it', async () => {
    world.stepDownFails = true

    const flags = [
      await log(AMARA_ACTOR, { noticing: ['swelling'], howBad: 'mild' }),
      await log(AMARA_ACTOR, { noticing: ['pus-or-hot-patch', 'new-redness'], howBad: 'hard-to-ignore' }),
      await log(AMARA_ACTOR, { noticing: ['itching'], where: ['near-eyes'], howBad: 'mild' }),
    ]

    expect(flags.map((flag) => flag.outcome.kind)).toEqual(['professional', 'professional', 'professional'])
    expect(world.stepDownAsked).toEqual([])
    expect(await stored(AMARA)).toHaveLength(3)
  })

  it('treats a step-down read that fails as no step-down: a harm signal pauses, and the log is stored', async () => {
    world.stepDownFails = true
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const result = await log(AMARA_ACTOR, { noticing: ['new-redness'], howBad: 'noticeable' })

      expect(result.outcome).toEqual({ kind: 'pause', duringStepDown: false })
      expect((await stored(AMARA))[0]).toMatchObject({ outcome: 'pause' })
      expect(spy.mock.calls).toEqual([[{ outcome: 'step-down-read-failed', profileId: AMARA }]])
    } finally {
      spy.mockRestore()
    }
  })

  it('still answers advice and a good day when the step-down read fails', async () => {
    world.stepDownFails = true
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect((await log(AMARA_ACTOR, { noticing: ['itching'], howBad: 'mild' })).outcome.kind).toBe('advice')
      expect((await log(AMARA_ACTOR, { noticing: ['nothing-unusual'] })).outcome.kind).toBe('logged')
      expect(await stored(AMARA)).toHaveLength(2)
    } finally {
      spy.mockRestore()
    }
  })

  it('falls back to the UTC day when the zone cannot be read, and stores the log', async () => {
    world.zoneFails = true
    world.now = at(11 * HOUR)

    const result = await log(AMARA_ACTOR, { noticing: ['swelling'], howBad: 'mild' })

    expect(result.log.day).toBe('2030-06-15')
    expect(result.outcome.kind).toBe('professional')
    expect((await stored(AMARA))[0]).toMatchObject({ localDay: '2030-06-15' })
  })

  it('falls back to the UTC day when the stored zone is not one Intl knows, and stores the log', async () => {
    world.zones.set(AMARA, 'Not/AZone')
    world.now = at(11 * HOUR)

    const result = await log(AMARA_ACTOR, { noticing: ['itching'], howBad: 'mild' })

    expect(result.log.day).toBe('2030-06-15')
    expect(world.stepDownAsked).toEqual([])
    expect(await stored(AMARA)).toHaveLength(1)
  })
})

describe('SkinCareService, who may log and read', () => {
  it('answers 401 AUTH_REQUIRED to a caller with no session, to log and to read', async () => {
    expect(await errorOf(log(PUBLIC, { noticing: ['itching'], howBad: 'mild' }))).toMatchObject({ name: 'UnauthorizedError', code: 'AUTH_REQUIRED' })
    expect(await errorOf(recent(PUBLIC))).toMatchObject({ name: 'UnauthorizedError', code: 'AUTH_REQUIRED' })
  })

  it('refuses a guest with 403 SIGNUP_REQUIRED, to log and to read, and stores nothing', async () => {
    const write = await errorOf(log(GUEST, { noticing: ['itching'], howBad: 'mild' }))
    const read = await errorOf(recent(GUEST))

    expect(write).toMatchObject({ name: 'ForbiddenError', code: 'SIGNUP_REQUIRED' })
    expect(read).toMatchObject({ name: 'ForbiddenError', code: 'SIGNUP_REQUIRED' })
    expect(await stored('profile-guest')).toEqual([])
    expect(world.stepDownAsked).toEqual([])
  })

  it('refuses a guest before it looks at the input: an invalid log from a guest is still SIGNUP_REQUIRED', async () => {
    expect(await errorOf(log(GUEST, { noticing: [] }))).toMatchObject({ code: 'SIGNUP_REQUIRED' })
    expect(await errorOf(log(GUEST, { noticing: ['itching'], howBad: 'mild', note: 'a'.repeat(501) }))).toMatchObject({ code: 'SIGNUP_REQUIRED' })
  })
})

describe('SkinCareService.log, reviewed text that is not written yet', () => {
  // `log` stores first and then looks the text up: the person's record of how their skin was is never lost to a gap in the workbook.
  const unavailable = async (input: LogInput, outcome: string) => {
    const error = await errorOf(log(AMARA_ACTOR, input))
    expect(error).toMatchObject({ name: 'UnavailableError', code: 'CONTENT_UNAVAILABLE' })
    const rows = await stored(AMARA)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ outcome, noticing: input.noticing, howBad: input.howBad ?? null, note: input.note ?? null })
  }

  it('answers 503 CONTENT_UNAVAILABLE for advice with no approved row, and still stores the log', async () => {
    world.responses = {}
    await unavailable({ noticing: ['itching'], howBad: 'mild', note: 'Since the weekend.' }, 'advice')
  })

  it('answers 503 for advice when just one of its codes has no approved row, and gives no half answer', async () => {
    delete world.responses['advice-itching']
    await unavailable({ noticing: ['tightness-or-dryness', 'itching'], howBad: 'noticeable' }, 'advice')
  })

  it('answers 503 for the expected flare with no approved row, and still stores the log', async () => {
    world.stepDown = true
    delete world.responses['expected-flare']
    await unavailable({ noticing: ['stinging-or-burning'], howBad: 'mild' }, 'expected-flare')
  })

  it.each(['pus-or-hot-patch', 'swelling', 'near-eyes'] as EscalationReason[])('answers 503 for a professional outcome (%s) with no approved escalation, and still stores the log with its reason', async (reason) => {
    delete world.escalations[reason]
    const input: LogInput = reason === 'near-eyes' ? { noticing: ['itching'], where: ['near-eyes'], howBad: 'mild' } : { noticing: [reason as 'swelling' | 'pus-or-hot-patch'], howBad: 'mild' }

    await unavailable(input, 'professional')
    expect((await stored(AMARA))[0]!.reason).toBe(reason)
  })

  // PR 4b: a pause now has reviewed text (`paused`, and `nothing-to-pause`), so its missing row is 503 like the others; see skin-care.service.pauses.test.ts.
  it('does not need any reviewed row for a good day', async () => {
    world.responses = {}
    world.escalations = {}

    expect((await log(AMARA_ACTOR, { noticing: ['nothing-unusual'] })).outcome).toEqual({ kind: 'logged' })
    expect(await stored(AMARA)).toHaveLength(1)
  })

  it('does not ask for an escalation row that another reason needs', async () => {
    delete world.escalations.swelling

    const result = await log(AMARA_ACTOR, { noticing: ['pus-or-hot-patch'], howBad: 'mild' })

    expect(result.outcome).toEqual({ kind: 'professional', reason: 'pus-or-hot-patch' })
  })
})

describe('SkinCareService.recent', () => {
  it('answers nothing for a profile that never logged', async () => {
    expect(await recent(AMARA_ACTOR)).toEqual([])
  })

  it('answers the session profile\'s logs newest first, each as the log was answered, without the note', async () => {
    const first = await log(AMARA_ACTOR, { noticing: ['itching'], howBad: 'mild', note: 'A private note.' })
    world.now = at(MINUTE)
    const second = await log(AMARA_ACTOR, { noticing: ['nothing-unusual'] })
    await log(TOLU_ACTOR, { noticing: ['swelling'], howBad: 'mild' })

    const logs = await recent(AMARA_ACTOR)

    expect(logs).toEqual([second.log, first.log])
    for (const entry of logs) {
      expect(entry).not.toHaveProperty('note')
      expect(entry).not.toHaveProperty('profileId')
      expect(JSON.stringify(entry)).not.toContain('A private note.')
    }
  })

  it('answers the last 20 logs, the newest first, when there are more', async () => {
    const ids: string[] = []
    for (let index = 0; index < 21; index++) {
      world.now = at(index * MINUTE)
      ids.push((await log(AMARA_ACTOR, { noticing: ['nothing-unusual'] })).log.id)
    }

    const logs = await recent(AMARA_ACTOR)

    expect(logs.map((entry) => entry.id)).toEqual(ids.slice(1).reverse())
  })

  it('answers all 20 logs when there are exactly 20', async () => {
    for (let index = 0; index < 20; index++) {
      world.now = at(index * MINUTE)
      await log(AMARA_ACTOR, { noticing: ['nothing-unusual'] })
    }

    expect(await recent(AMARA_ACTOR)).toHaveLength(20)
  })
})

describe('SkinCareService, the note stays private', () => {
  const SECRET = 'SECRET-NOTE-9f3b my face hurts near my left eye'

  it('writes the note to no console line, whether the log works, is refused or has no reviewed text', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}))
    const text = (value: unknown): string => (value instanceof Error ? `${value.name} ${value.message} ${value.stack ?? ''} ${text((value as Error & { details?: unknown }).details)}` : typeof value === 'string' ? value : JSON.stringify(value))
    try {
      await log(AMARA_ACTOR, { noticing: ['itching'], howBad: 'mild', note: SECRET })
      await log(AMARA_ACTOR, { noticing: ['stinging-or-burning'], howBad: 'noticeable', note: SECRET })
      await log(AMARA_ACTOR, { noticing: ['swelling'], howBad: 'hard-to-ignore', note: SECRET })
      await log(AMARA_ACTOR, { noticing: ['nothing-unusual'], note: SECRET })
      await errorOf(log(AMARA_ACTOR, { noticing: ['nothing-unusual', 'itching'], howBad: 'mild', note: SECRET }))
      await errorOf(log(AMARA_ACTOR, { noticing: ['itching'], howBad: 'mild', note: SECRET + 'a'.repeat(500) }))
      world.responses = {}
      world.escalations = {}
      await errorOf(log(AMARA_ACTOR, { noticing: ['itching'], howBad: 'mild', note: SECRET }))
      await errorOf(log(AMARA_ACTOR, { noticing: ['swelling'], howBad: 'mild', note: SECRET }))
      await recent(AMARA_ACTOR)

      for (const spy of spies) for (const call of spy.mock.calls) expect(call.map(text).join(' ')).not.toContain('SECRET-NOTE')
    } finally {
      for (const spy of spies) spy.mockRestore()
    }
  })

  it('puts the note in no error a refused or unavailable log throws', async () => {
    const refused = await errorOf(log(AMARA_ACTOR, { noticing: ['nothing-unusual', 'itching'], howBad: 'mild', note: SECRET }))
    world.responses = {}
    const unavailable = await errorOf(log(AMARA_ACTOR, { noticing: ['itching'], howBad: 'mild', note: SECRET }))

    for (const error of [refused, unavailable]) expect(`${error.message} ${JSON.stringify((error as { details?: unknown }).details ?? null)}`).not.toContain('SECRET-NOTE')
  })
})

describe('SkinCareService, the words it says', () => {
  const strings = (value: unknown): string[] => (typeof value === 'string' ? [value] : Array.isArray(value) ? value.flatMap(strings) : value !== null && typeof value === 'object' ? Object.values(value).flatMap(strings) : [])

  it('says nothing that breaks the wording rules, on any outcome that has a reviewed line, and in its own errors', async () => {
    world.stepDown = true
    const lines: string[] = []
    const collect = async (input: LogInput) => {
      const { response } = await log(AMARA_ACTOR, input)
      // The facts repeat what the person logged: their words, not ours.
      const reviewed = response !== null && typeof response === 'object' && !Array.isArray(response) && 'facts' in response ? { ...response, facts: undefined } : response
      lines.push(...strings(reviewed))
    }
    await collect({ noticing: ['tightness-or-dryness', 'itching', 'new-breakouts'], howBad: 'mild' })
    await collect({ noticing: ['new-redness'], howBad: 'mild' })
    await collect({ noticing: ['pus-or-hot-patch'], howBad: 'mild' })
    await collect({ noticing: ['swelling'], howBad: 'mild' })
    await collect({ noticing: ['itching'], where: ['near-eyes'], howBad: 'mild' })
    world.responses = {}
    world.escalations = {}
    for (const input of [{ noticing: ['itching'], howBad: 'mild' }, { noticing: ['swelling'], howBad: 'mild' }, { noticing: ['nothing-unusual', 'itching'], howBad: 'mild' }, { noticing: [] }] as LogInput[]) {
      lines.push((await errorOf(log(AMARA_ACTOR, input))).message)
    }

    expect(lines.length).toBeGreaterThanOrEqual(20)
    for (const line of lines) for (const { code, pattern } of FORBIDDEN_WORDING) expect(pattern.test(line), `"${line}" trips ${code}`).toBe(false)
  })
})
