import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type Actor, runAs } from '../../lib/context'
import { ConflictError, ForbiddenError, UnauthorizedError, ValidationError } from '../../lib/errors'
import { FakeInboxRepository } from '../inbox/inbox.repository.fake'
import { InboxService, type InboxWrite } from '../inbox/inbox.service'
import type { RemindersService } from '../reminders/reminders.service'
import type { ReminderRoutinePlan } from '../reminders/reminders.types'
import { FakeRoutineCheckInsRepository } from './routines.check-ins.repository.fake'
import { RoutineCheckInsService } from './routines.check-ins.service'
import type { RoutineVersionRow } from './routines.repository'
import { FakeRoutinesRepository } from './routines.repository.fake'

// Check-ins and missed days (spec #217, PR 4a). The person says "I did my morning (or evening) routine" for a local day, and the app can later ask how many days in a
// row they have missed. Collaborators: the check-ins repository (the real fake), the routines repository (the real fake: day 1 is read from the routine in force), and
// `reminders: Pick<RemindersService, 'zoneFor'>` answering from one mutable `zone`.
//
// THE CONTRACT THIS FILE PINS (assumed: the brief names the behaviour and the gates, not the class or its constructor; the method names are the brief's):
//   new RoutineCheckInsService({ repository, versions, reminders, now? })
//     repository   RoutineCheckInsRepository   (record, list; see routines.check-ins.repository.contract.ts)
//     versions     Pick<RoutinesRepository, 'current'>   the routine in force; its `startedOn` (the UTC midnight of day 1's calendar date) says whether and when it started
//     reminders    Pick<RemindersService, 'zoneFor'>      the profile's stored zone, null while none (the UTC day applies)
//   checkIn(day: 'YYYY-MM-DD', time: 'morning' | 'evening'): Promise<{ day, time }>     the session profile's own check-in, answering exactly what was recorded
//   missedStreak(profileId: string, today: 'YYYY-MM-DD'): Promise<{ days: number; since: string | null }>     by profile id, no session (PR 4b's job reads it)
//
// checkIn gates, in order: 401 (no session, from requireUser), 403 SIGNUP_REQUIRED for a guest, 409 ROUTINE_NOT_STARTED when the routine in force has no startedOn
// (none at all, or ready but not Started), then 400 VALIDATION_FAILED unless `day` is today or yesterday in the person's local day ("today" = localDay(now, stored zone),
// UTC with none) and is not before day 1. A refused call stores nothing. A repeat of a stored (day, time) is the same answer and stores nothing more.
//
// missedStreak(profileId, today): the consecutive missed local days ending YESTERDAY (the day before `today`). A missed day is a day on or after day 1 with no check-in at
// either time of day. Today never counts (it is not over), and neither does a check-in made today change the count. `days` is the length of the streak and `since` its
// first day: the dedup key for "one nudge per streak". { days: 0, since: null } when the routine has not started, on day 1, and on day 2 with day 1 done.
// It is pure calendar-date arithmetic on the stored dates: it never reads the clock or the zone, so a later change of zone moves no earlier day.

const T0 = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** The calendar day `n` days from T0's UTC day (the 15th), as 'YYYY-MM-DD'. Plain date arithmetic, worked out by hand against the comments below. */
const day = (n: number) => new Date(T0.getTime() + n * DAY).toISOString().slice(0, 10)
/** The same day as the UTC midnight that routine_versions.started_on stores. */
const midnightOf = (n: number) => new Date(`${day(n)}T00:00:00.000Z`)

const LAGOS = 'Africa/Lagos' // UTC+1 all year
const NEW_YORK = 'America/New_York' // UTC-4 in June

const AMARA_USER = 'user-amara'
const AMARA = 'profile-amara-1'
const TOLU_USER = 'user-tolu'
const TOLU = 'profile-tolu-1'
const actor = (userId: string, profileId: string, status: 'anonymous' | 'verified' = 'verified'): Actor => ({ kind: 'user', userId, status, profileId })
const AMARA_ACTOR = actor(AMARA_USER, AMARA)
const TOLU_ACTOR = actor(TOLU_USER, TOLU)
const GUEST = actor('user-guest', 'profile-guest', 'anonymous')
const PUBLIC: Actor = { kind: 'public' }

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error as Error & { code?: string }
  }
  throw new Error('expected the promise to reject')
}

let clock: Date
let zone: string | null
let checkIns: FakeRoutineCheckInsRepository
let versions: FakeRoutinesRepository
let service: RoutineCheckInsService
/** The routine as the all-done rule reads it (reminderPlanFor): a morning and an evening of daily entries until a test says otherwise. Day 1 is 10 days before T0. */
let routinePlan: Pick<ReminderRoutinePlan, 'dayOne' | 'morning' | 'evening'> | null
const DAILY_PLAN: NonNullable<typeof routinePlan> = {
  dayOne: '2030-06-05',
  morning: [{ step: 'cleanse', title: 'Cleanser', frequency: 'am' }],
  evening: [{ step: 'cleanse', title: 'Cleanser', frequency: 'pm' }],
}
/** A no-op inbox for the tests that are not about the all-done row. */
const noInbox = { write: async () => ({ id: 'unused', created: true }) }

const setClock = (offsetMs: number) => {
  clock = new Date(T0.getTime() + offsetMs)
}

beforeEach(() => {
  clock = T0
  zone = null
  routinePlan = DAILY_PLAN
  checkIns = new FakeRoutineCheckInsRepository()
  versions = new FakeRoutinesRepository()
  service = new RoutineCheckInsService({
    repository: checkIns,
    versions,
    reminders: { zoneFor: async () => zone } satisfies Pick<RemindersService, 'zoneFor'>,
    inbox: noInbox,
    routine: { reminderPlanFor: async () => routinePlan },
    now: () => clock,
  })
})

let versionCount = 0
/** A routine in force for the profile, as a build leaves it: ready, and not Started. */
const readyRoutine = async (profileId: string) => {
  const row: RoutineVersionRow = {
    id: `version-${++versionCount}`,
    profileId,
    status: 'ready',
    createdAt: new Date(T0.getTime() - DAY),
    steps: [],
    tapers: [],
    expectation: 'Give it 8 to 12 weeks before judging.',
    cautions: [],
    goal: 'glow',
    shelfCounts: { keep: 0, reduce: 0, drop: 0, stop: 0 },
    notInRoutine: [],
    readyAt: new Date(T0.getTime() - DAY),
    startedOn: null,
    servedAt: null,
    model: null,
    promptHash: null,
    catalogVersion: 1,
    rulesVersion: 'rules-1',
    hintsShown: false,
    verdictFingerprint: 'verdict-fp',
    routineFingerprint: 'routine-fp',
    source: 'rules',
    reason: 'first',
    writerRetryDueAt: null,
    writerCalls: 0,
  }
  await versions.append(row)
}
/** A routine in force that has been Started the way Start does it (markStarted) with day 1 on calendar day `dayOne`. */
const startedRoutine = async (profileId: string, dayOne: number) => {
  await readyRoutine(profileId)
  await versions.markStarted(profileId, midnightOf(dayOne))
}

/** Checks in as Amara. */
const checkIn = (calendarDay: string, time: 'morning' | 'evening' = 'morning', who: Actor = AMARA_ACTOR) => runAs(who, () => service.checkIn(calendarDay, time))
/** Amara checking in for calendar day `n` the way life does it: at noon UTC of that day (the same day in any zone from Lagos to New York), for the day the clock is on. */
const checkInOn = async (n: number, time: 'morning' | 'evening' = 'morning') => {
  setClock(n * DAY)
  await checkIn(day(n), time)
}
const streak = (today: number, profileId = AMARA) => service.missedStreak(profileId, day(today))
const stored = async (profileId = AMARA) => (await checkIns.list(profileId, day(-30), day(30))).map((row) => `${row.day} ${row.time}`).sort()

describe('RoutineCheckInsService.checkIn: recording', () => {
  beforeEach(() => startedRoutine(AMARA, -3))

  it('answers the day and time it recorded, and records them for the session profile', async () => {
    const answer = await checkIn(day(0), 'morning')

    expect(answer).toEqual({ day: day(0), time: 'morning' })
    expect(await stored()).toEqual([`${day(0)} morning`])
    expect(await stored(TOLU)).toEqual([])
  })

  it('records the evening of a day apart from its morning', async () => {
    await checkIn(day(0), 'morning')
    await checkIn(day(0), 'evening')

    expect(await stored()).toEqual([`${day(0)} evening`, `${day(0)} morning`])
  })

  it('records yesterday too, as its own day', async () => {
    await checkIn(day(-1), 'evening')

    expect(await stored()).toEqual([`${day(-1)} evening`])
  })

  it('is idempotent: the same (day, time) twice answers the same and is stored once', async () => {
    const first = await checkIn(day(0), 'morning')
    const again = await checkIn(day(0), 'morning')

    expect(again).toEqual(first)
    expect(await stored()).toEqual([`${day(0)} morning`])
  })

  it('keeps the first moment of a check-in when it is made again', async () => {
    await checkIn(day(0), 'morning')
    setClock(HOUR)
    await checkIn(day(0), 'morning')

    const [row] = await checkIns.list(AMARA, day(0), day(0))
    expect(row!.at.getTime()).toBe(T0.getTime())
  })

  it('keeps one profile\'s check-in from another\'s', async () => {
    await startedRoutine(TOLU, -3)

    await checkIn(day(0), 'morning', TOLU_ACTOR)

    expect(await stored(TOLU)).toEqual([`${day(0)} morning`])
    expect(await stored(AMARA)).toEqual([])
  })
})

describe('RoutineCheckInsService.checkIn: the gates', () => {
  it('refuses a caller with no session (401, from requireUser)', async () => {
    await startedRoutine(AMARA, -3)

    const error = await errorOf(checkIn(day(0), 'morning', PUBLIC))

    expect(error).toBeInstanceOf(UnauthorizedError)
    expect(error.code).toBe('AUTH_REQUIRED')
    expect(await stored()).toEqual([])
  })

  it('refuses a guest with 403 SIGNUP_REQUIRED, before it looks for a routine, and stores nothing', async () => {
    const error = await errorOf(checkIn(day(0), 'morning', GUEST))

    expect(error).toBeInstanceOf(ForbiddenError)
    expect(error.code).toBe('SIGNUP_REQUIRED')
    expect(await stored('profile-guest')).toEqual([])
  })

  it('refuses with 409 ROUTINE_NOT_STARTED when the profile has no routine at all', async () => {
    const error = await errorOf(checkIn(day(0), 'morning'))

    expect(error).toBeInstanceOf(ConflictError)
    expect(error.code).toBe('ROUTINE_NOT_STARTED')
    expect(await stored()).toEqual([])
  })

  it('refuses with 409 ROUTINE_NOT_STARTED when the routine is ready but not Started', async () => {
    await readyRoutine(AMARA)

    const error = await errorOf(checkIn(day(0), 'morning'))

    expect(error).toBeInstanceOf(ConflictError)
    expect(error.code).toBe('ROUTINE_NOT_STARTED')
    expect(await stored()).toEqual([])
  })

  it('answers 409 ROUTINE_NOT_STARTED, not 400, for a day that is out of range when the routine has not Started: the gate comes first', async () => {
    await readyRoutine(AMARA)

    const error = await errorOf(checkIn(day(5), 'morning'))

    expect(error.code).toBe('ROUTINE_NOT_STARTED')
  })

  it('does not confuse another profile\'s Started routine with the caller\'s own', async () => {
    await startedRoutine(TOLU, -3)

    const error = await errorOf(checkIn(day(0), 'morning'))

    expect(error.code).toBe('ROUTINE_NOT_STARTED')
  })
})

describe('RoutineCheckInsService.checkIn: which days are accepted', () => {
  // Day 1 is far back, so only today and yesterday bound the answer here.
  beforeEach(() => startedRoutine(AMARA, -10))

  const outcome = async (calendarDay: string) => {
    try {
      await checkIn(calendarDay, 'morning')
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError)
      expect((error as ValidationError).code).toBe('VALIDATION_FAILED')
      return 'refused'
    }
    return 'accepted'
  }

  it('accepts today and yesterday, and refuses tomorrow and the day before yesterday (no stored zone: the UTC day)', async () => {
    expect(await outcome(day(0))).toBe('accepted')
    expect(await outcome(day(-1))).toBe('accepted')
    expect(await outcome(day(1))).toBe('refused')
    expect(await outcome(day(-2))).toBe('refused')
  })

  it('stores nothing for a refused day', async () => {
    await outcome(day(1))
    await outcome(day(-2))

    expect(await stored()).toEqual([])
  })

  it('refuses a day that is not a calendar date, whatever it looks like', async () => {
    for (const bad of ['', 'today', '2030-6-15', '2030-06-15T00:00:00Z', '15/06/2030', '2030-02-30', '2030-13-01']) {
      expect(await outcome(bad), bad).toBe('refused')
    }
    expect(await stored()).toEqual([])
  })

  // Where each local day begins. Lagos is UTC+1 (its midnight ending the 15th is 23:00 UTC), New York UTC-4 (its midnight ending the 15th is 04:00 UTC on the 16th), and
  // with no zone the day is the UTC one. One millisecond either side of that midnight moves "today" by a whole day, and so moves both bounds.
  describe.each([
    ['no stored zone', null, 12 * HOUR],
    ['Lagos', LAGOS, 11 * HOUR],
    ['New York', NEW_YORK, 16 * HOUR],
  ])('with %s', (_name, storedZone, midnight) => {
    beforeEach(() => {
      zone = storedZone
    })

    it('is still the 15th in the last millisecond of the local 15th: accepts the 15th and the 14th, refuses the 16th and the 13th', async () => {
      setClock(midnight - 1)

      expect(await outcome(day(0))).toBe('accepted')
      expect(await outcome(day(-1))).toBe('accepted')
      expect(await outcome(day(1))).toBe('refused')
      expect(await outcome(day(-2))).toBe('refused')
    })

    it('is the 16th from the first millisecond of the local 16th: accepts the 16th and the 15th, refuses the 17th and the 14th', async () => {
      setClock(midnight)

      expect(await outcome(day(1))).toBe('accepted')
      expect(await outcome(day(0))).toBe('accepted')
      expect(await outcome(day(2))).toBe('refused')
      expect(await outcome(day(-1))).toBe('refused')
    })
  })

  it('reads the zone as it is now: a zone stored later moves the bounds, not the check-ins already made', async () => {
    zone = LAGOS
    setClock(11 * HOUR) // the 16th in Lagos, still the 15th in UTC
    await checkIn(day(0), 'evening')
    zone = NEW_YORK
    setClock(11 * HOUR) // the 15th in New York

    expect(await outcome(day(1))).toBe('refused')
    expect(await outcome(day(-1))).toBe('accepted')
    // The refused day stored nothing; the accepted yesterday stored its morning, beside the Lagos evening made before the zone changed.
    expect(await stored()).toEqual([`${day(-1)} morning`, `${day(0)} evening`])
  })
})

describe('RoutineCheckInsService.checkIn: not before day 1', () => {
  const outcome = async (calendarDay: string) => {
    try {
      await checkIn(calendarDay, 'morning')
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError)
      expect((error as ValidationError).code).toBe('VALIDATION_FAILED')
      return 'refused'
    }
    return 'accepted'
  }

  it('accepts day 1 itself, and yesterday when day 1 is yesterday', async () => {
    await startedRoutine(AMARA, -1)

    expect(await outcome(day(-1))).toBe('accepted')
    expect(await outcome(day(0))).toBe('accepted')
  })

  it('refuses yesterday when day 1 is today, though yesterday is otherwise in range', async () => {
    await startedRoutine(AMARA, 0)

    expect(await outcome(day(-1))).toBe('refused')
    expect(await outcome(day(0))).toBe('accepted')
    expect(await stored()).toEqual([`${day(0)} morning`])
  })

  it('refuses every day while day 1 is still tomorrow (Start was tapped today): 400, not 409', async () => {
    await startedRoutine(AMARA, 1)

    expect(await outcome(day(-1))).toBe('refused')
    expect(await outcome(day(0))).toBe('refused')
    expect(await outcome(day(1))).toBe('refused')
    expect(await stored()).toEqual([])
  })

  it('measures day 1 in calendar dates, whatever the zone: Lagos at 00:30 on the 16th, with day 1 the 16th, refuses the 15th and accepts the 16th', async () => {
    zone = LAGOS
    await startedRoutine(AMARA, 1)
    setClock(11 * HOUR + 30 * MINUTE) // 23:30 UTC on the 15th = 00:30 on the 16th in Lagos

    expect(await outcome(day(0))).toBe('refused')
    expect(await outcome(day(1))).toBe('accepted')
  })
})

describe('RoutineCheckInsService.missedStreak', () => {
  // Day 1 is day(0) (the 15th), unless a test says otherwise. "Today" is the day asked about.
  beforeEach(() => startedRoutine(AMARA, 0))

  it('is 0 with no streak before the routine has Started: no routine at all, and a ready routine not Started', async () => {
    expect(await streak(5, TOLU)).toEqual({ days: 0, since: null })
    await readyRoutine(TOLU)

    expect(await streak(5, TOLU)).toEqual({ days: 0, since: null })
  })

  it('is 0 on day 1 itself, and while day 1 is still ahead', async () => {
    expect(await streak(0)).toEqual({ days: 0, since: null })
    expect(await streak(-1)).toEqual({ days: 0, since: null })
    expect(await streak(-5)).toEqual({ days: 0, since: null })
  })

  it('is 0 on day 2 with day 1 done', async () => {
    await checkInOn(0)

    expect(await streak(1)).toEqual({ days: 0, since: null })
  })

  it('is 1 on day 2 with day 1 missed, since day 1', async () => {
    expect(await streak(1)).toEqual({ days: 1, since: day(0) })
  })

  it('counts every missed day since day 1 when nothing was ever checked in, and not today', async () => {
    // Today is the 5th day; days 1 to 4 were missed.
    expect(await streak(4)).toEqual({ days: 4, since: day(0) })
  })

  it('starts the streak at day 1 even when the person has been away for a long while (the length is the number of days)', async () => {
    expect(await streak(30)).toEqual({ days: 30, since: day(0) })
  })

  it('counts days across a month boundary as calendar days (June 30 then July 1)', async () => {
    // Day 1 is 2030-06-15 and today is 2030-07-02, so the missed days run from 06-15 to 07-01: seventeen of them, across the end of June.
    expect(day(16).slice(5)).toBe('07-01')

    expect(await streak(17)).toEqual({ days: 17, since: day(0) })
  })

  it('is 0 when yesterday was checked in, however many days were missed before it', async () => {
    await checkInOn(4)

    expect(await streak(5)).toEqual({ days: 0, since: null })
  })

  it('counts only the days since the last check-in: an earlier gap ended by a check-in is not part of it', async () => {
    // Day 1 (the 15th) missed, day 2 done, day 3 missed, today is day 4.
    await checkInOn(1)

    expect(await streak(3)).toEqual({ days: 1, since: day(2) })
  })

  it('does not join two gaps that a check-in separates', async () => {
    // Missed 0 and 1, done 2, missed 3 and 4, done 5, missed 6, today is 7.
    await checkInOn(2)
    await checkInOn(5)

    expect(await streak(7)).toEqual({ days: 1, since: day(6) })
    expect(await streak(6)).toEqual({ days: 0, since: null })
    expect(await streak(5)).toEqual({ days: 2, since: day(3) })
  })

  it('treats the morning alone as a day done', async () => {
    await checkInOn(1, 'morning')

    // Day 1 is missed and day 2 is done: asked on day 3 the streak is over, so one time of day ends it.
    expect(await streak(2)).toEqual({ days: 0, since: null })
    expect(await streak(3)).toEqual({ days: 1, since: day(2) })
  })

  it('treats the evening alone as a day done', async () => {
    await checkInOn(1, 'evening')

    // Day 1 is missed and day 2 is done: asked on day 3 the streak is over, so one time of day ends it.
    expect(await streak(2)).toEqual({ days: 0, since: null })
    expect(await streak(3)).toEqual({ days: 1, since: day(2) })
  })

  it('gives the same answer for a day done at both times as for one done at one', async () => {
    await checkInOn(1, 'morning')
    await checkInOn(1, 'evening')

    expect(await streak(3)).toEqual({ days: 1, since: day(2) })
  })

  it('never counts today as missed: the streak ends yesterday', async () => {
    await checkInOn(1)

    // Day 3 not over yet: day 2 (the 17th) is the only missed day, then.
    expect(await streak(3)).toEqual({ days: 1, since: day(2) })
    // Asked the next day, it is two.
    expect(await streak(4)).toEqual({ days: 2, since: day(2) })
  })

  it('does not let a check-in made today change the streak: today is not part of it either way', async () => {
    await checkInOn(2)

    // Days 0 and 1 are missed; today (day 2) is done, and the count is as it was before the check-in.
    expect(await streak(2)).toEqual({ days: 2, since: day(0) })
  })

  it('keeps the first missed day of the streak as its start while the streak grows', async () => {
    await checkInOn(0)

    expect((await streak(2)).since).toBe(day(1))
    expect((await streak(3)).since).toBe(day(1))
    expect((await streak(6)).since).toBe(day(1))
  })

  it('moves the start to a new day once a check-in ends the streak and a new one begins', async () => {
    await checkInOn(0)
    const before = await streak(3)
    await checkInOn(3)

    expect(before).toEqual({ days: 2, since: day(1) })
    expect(await streak(4)).toEqual({ days: 0, since: null })
    expect(await streak(6)).toEqual({ days: 2, since: day(4) })
  })

  it('does not count days before day 1: a routine Started on the 3rd day counts from there', async () => {
    await startedRoutine(TOLU, 2)

    expect(await streak(2, TOLU)).toEqual({ days: 0, since: null })
    expect(await streak(3, TOLU)).toEqual({ days: 1, since: day(2) })
    expect(await streak(5, TOLU)).toEqual({ days: 3, since: day(2) })
  })

  it('reads only the profile asked about', async () => {
    await startedRoutine(TOLU, 0)
    await checkInOn(0)
    await checkInOn(1)
    await runAs(TOLU_ACTOR, () => service.checkIn(day(1), 'morning'))

    // Amara did day 1 and Tolu did not: the same question about the same day has two answers.
    expect(await streak(1)).toEqual({ days: 0, since: null })
    expect(await streak(1, TOLU)).toEqual({ days: 1, since: day(0) })
    // Tolu's day 2 is done and Amara's too, and neither did day 3.
    expect(await streak(3)).toEqual({ days: 1, since: day(2) })
    expect(await streak(3, TOLU)).toEqual({ days: 1, since: day(2) })
  })

  it('needs no session: a job reads it by profile id', async () => {
    const result = await runAs({ kind: 'system', job: 'send-reminders' }, () => service.missedStreak(AMARA, day(2)))

    expect(result).toEqual({ days: 2, since: day(0) })
  })

  it('does not move an earlier day when the zone changes: check-ins made in Lagos stay on the Lagos days they were made for', async () => {
    zone = LAGOS
    await checkInOn(0)
    await checkInOn(1)
    const inLagos = await streak(4)

    zone = NEW_YORK
    const inNewYork = await streak(4)
    zone = 'Pacific/Auckland'
    const inAuckland = await streak(4)

    expect(inLagos).toEqual({ days: 2, since: day(2) })
    expect(inNewYork).toEqual(inLagos)
    expect(inAuckland).toEqual(inLagos)
  })

  it('does not move day 1 when the zone changes: the stored calendar date is what it is', async () => {
    zone = LAGOS
    const inLagos = await streak(3)
    zone = 'Pacific/Kiritimati' // UTC+14
    const inKiritimati = await streak(3)

    expect(inLagos).toEqual({ days: 3, since: day(0) })
    expect(inKiritimati).toEqual(inLagos)
  })
})

// The all-done row (spec #233, PR 8b). The check-in that makes a day hold both its morning and its evening writes one inbox row, key `all-done:<day>`, kind 'all-done', for the day checked in
// (so yesterday's, when yesterday is what is checked in). One half alone writes nothing; neither does a repeat. A row that cannot be written is logged by the profile id alone and never fails the
// check-in.
//
// THE CONTRACT THIS FILE PINS (assumed: the brief names the key and the behaviour, not the constructor):
//   new RoutineCheckInsService({ ..., inbox })   inbox: Pick<InboxService, 'write'>   the test hands it a recorder around the real InboxService over its real fake
describe('RoutineCheckInsService.checkIn: the all-done row', () => {
  let inbox: InboxService
  let attempted: InboxWrite[]
  let inboxFails: boolean

  beforeEach(async () => {
    inboxFails = false
    attempted = []
    inbox = new InboxService({ repository: new FakeInboxRepository(), now: () => clock })
    service = new RoutineCheckInsService({
      repository: checkIns,
      versions,
      reminders: { zoneFor: async () => zone } satisfies Pick<RemindersService, 'zoneFor'>,
      routine: { reminderPlanFor: async () => routinePlan },
      now: () => clock,
      inbox: {
        write: async (input: InboxWrite) => {
          attempted.push(input)
          if (inboxFails) throw new Error('the inbox is down for ExponentPushToken[abc] All done')
          return inbox.write(input)
        },
      },
    })
    await startedRoutine(AMARA, -3)
  })

  const keys = () => attempted.map(({ key }) => key)
  const rows = (who: Actor = AMARA_ACTOR) => runAs(who, async () => (await inbox.list({ limit: 50 })).items)

  it('writes one row, for the day, with the check-in that completes it, the evening after the morning', async () => {
    await checkIn(day(0), 'morning')
    expect(keys()).toEqual([])

    await checkIn(day(0), 'evening')

    expect(keys()).toEqual([`all-done:${day(0)}`])
    expect(attempted[0]).toMatchObject({ profileId: AMARA, kind: 'all-done', day: day(0) })
    expect(attempted[0]!.title.length).toBeGreaterThan(0)
    expect(attempted[0]!.body.length).toBeGreaterThan(0)
    expect(attempted[0]!.link).toMatch(/^\/(?!\/)/)
    expect(await rows()).toHaveLength(1)
  })

  it('writes it the same when the morning completes a day whose evening was done first', async () => {
    await checkIn(day(0), 'evening')
    expect(keys()).toEqual([])

    await checkIn(day(0), 'morning')

    expect(keys()).toEqual([`all-done:${day(0)}`])
  })

  it('writes a row only for a day that holds both halves: a day with an evening alone gets none', async () => {
    await checkIn(day(0), 'morning')
    setClock(DAY)
    await checkIn(day(0), 'evening')
    await checkIn(day(1), 'evening')

    // day(0) holds both (its evening was made late, the next day); day(1) holds an evening alone.
    expect(keys()).toEqual([`all-done:${day(0)}`])
  })

  it('writes the row for yesterday when yesterday is what the check-in is for', async () => {
    setClock(DAY)
    await checkIn(day(0), 'morning')

    await checkIn(day(0), 'evening')

    expect((await rows()).map((row) => row.day)).toEqual([day(0)])
  })

  it('writes it once: a repeat of either check-in makes no second row', async () => {
    await checkIn(day(0), 'morning')
    await checkIn(day(0), 'evening')

    await checkIn(day(0), 'evening')
    await checkIn(day(0), 'morning')

    expect([...new Set(keys())]).toEqual([`all-done:${day(0)}`])
    expect(await rows()).toHaveLength(1)
  })

  it('writes the row into the profile that checked in and no other', async () => {
    await startedRoutine(TOLU, -3)
    await checkIn(day(0), 'morning', TOLU_ACTOR)

    await checkIn(day(0), 'morning')
    await checkIn(day(0), 'evening')

    expect(await rows(AMARA_ACTOR)).toHaveLength(1)
    expect(await rows(TOLU_ACTOR)).toEqual([])
  })

  it('writes nothing for a check-in that is refused', async () => {
    await checkIn(day(0), 'morning')

    await errorOf(checkIn(day(-9), 'evening'))

    expect(keys()).toEqual([])
    expect(await stored()).toEqual([`${day(0)} morning`])
  })

  it('records the check-in, answers it and logs the failure by the profile id alone, when the row cannot be written', async () => {
    await checkIn(day(0), 'morning')
    inboxFails = true
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(checkIn(day(0), 'evening')).resolves.toEqual({ day: day(0), time: 'evening' })

    expect(await stored()).toEqual([`${day(0)} evening`, `${day(0)} morning`])
    const text = JSON.stringify(logged.mock.calls)
    expect(text).toContain(AMARA)
    expect(text).not.toContain('ExponentPushToken')
    expect(text).not.toContain('All done')
    vi.restoreAllMocks()
  })
})

// The all-done row when a half has nothing to do (spec #233, PR 8b, review). A half with no entries due that day counts as done: the row is written when every half that has due entries is
// checked in and at least one half is checked in. The entries are read from the routine (reminderPlanFor): the morning lists every entry, the evening only those due on the day.
describe('RoutineCheckInsService.checkIn: the all-done row when a half has nothing to do', () => {
  let inbox: InboxService
  let attempted: InboxWrite[]
  const entry = (frequency: 'am' | 'pm' | 'alternate-days') => ({ step: 'treat' as const, title: 'Retinoid', frequency })

  beforeEach(async () => {
    attempted = []
    inbox = new InboxService({ repository: new FakeInboxRepository(), now: () => clock })
    service = new RoutineCheckInsService({
      repository: checkIns,
      versions,
      reminders: { zoneFor: async () => zone } satisfies Pick<RemindersService, 'zoneFor'>,
      routine: { reminderPlanFor: async () => routinePlan },
      now: () => clock,
      inbox: {
        write: async (input: InboxWrite) => {
          attempted.push(input)
          return inbox.write(input)
        },
      },
    })
    await startedRoutine(AMARA, -3)
  })

  const keys = () => [...new Set(attempted.map(({ key }) => key))]
  const rows = () => runAs(AMARA_ACTOR, async () => (await inbox.list({ limit: 50 })).items)

  // Day 1 is 2030-06-05 (10 days before T0): an alternate-days entry counts from it, so it is due on even offsets. 2030-06-15 is offset 10 (due), 2030-06-14 offset 9 (a rest night).
  it('writes one row for a rest night on which only the morning is checked in', async () => {
    routinePlan = { ...DAILY_PLAN, evening: [entry('alternate-days')] }
    setClock(-DAY)

    await checkIn(day(-1), 'morning')

    expect(keys()).toEqual([`all-done:${day(-1)}`])
    expect(await rows()).toHaveLength(1)
  })

  it('writes one row for a day with no morning entries on which only the evening is checked in', async () => {
    routinePlan = { ...DAILY_PLAN, morning: [] }

    await checkIn(day(0), 'evening')

    expect(keys()).toEqual([`all-done:${day(0)}`])
  })

  it('still needs both halves on a day on which both have entries due', async () => {
    routinePlan = { ...DAILY_PLAN, evening: [entry('alternate-days')] }

    await checkIn(day(0), 'morning')
    expect(keys()).toEqual([])

    await checkIn(day(0), 'evening')
    expect(keys()).toEqual([`all-done:${day(0)}`])
  })

  it('asks for both halves when the routine cannot be read, and the check-in still stands', async () => {
    const down = new Error('the routine could not be read')
    service = new RoutineCheckInsService({
      repository: checkIns,
      versions,
      reminders: { zoneFor: async () => zone } satisfies Pick<RemindersService, 'zoneFor'>,
      routine: { reminderPlanFor: async () => Promise.reject(down) },
      now: () => clock,
      inbox: { write: async (input: InboxWrite) => (attempted.push(input), inbox.write(input)) },
    })

    await checkIn(day(0), 'morning')
    expect(keys()).toEqual([])

    await checkIn(day(0), 'evening')
    expect(keys()).toEqual([`all-done:${day(0)}`])
  })

  it('writes one row, and only one, for a repeat of the morning when the evening lists nothing', async () => {
    routinePlan = { ...DAILY_PLAN, evening: [] }

    await checkIn(day(0), 'morning')
    await checkIn(day(0), 'morning')

    expect(await rows()).toHaveLength(1)
  })
})
