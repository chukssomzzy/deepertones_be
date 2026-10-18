import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Actor, runAs, runWithContext } from '../../lib/context'
import { GOAL_ANSWERS_VERSION, answerFor } from './goals.answers'
import { FakeGoalsRepository } from './goals.repository.fake'
import { GoalsService } from './goals.service'
import type { GoalRow } from './goals.types'

// The one clock every test hangs off; later times are offsets from it.
const T0 = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs)

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error as Error & { code?: string }
  }
  throw new Error('expected the promise to reject')
}

const actor = (userId: string, profileId: string, status: 'anonymous' | 'verified' = 'anonymous'): Actor => ({ kind: 'user', userId, status, profileId })

// Amara and Tolu are two accounts; Amara has a second profile.
const AMARA = actor('user-amara', 'profile-amara-1')
const AMARA_SECOND_PROFILE = actor('user-amara', 'profile-amara-2')
const TOLU = actor('user-tolu', 'profile-tolu-1', 'verified')
const PUBLIC: Actor = { kind: 'public' }

let clock: Date
let repository: FakeGoalsRepository
let service: GoalsService

const set = (who: Actor, input: Parameters<GoalsService['set']>[0]) => runAs(who, () => service.set(input))
const current = (who: Actor) => runAs(who, () => service.current())
const onboarding = (who: Actor) => runAs(who, () => service.onboarding())
const tick = () => {
  clock = new Date(clock.getTime() + MINUTE)
}

beforeEach(() => {
  clock = T0
  repository = new FakeGoalsRepository()
  let n = 0
  service = new GoalsService({ repository, now: () => clock, newId: () => `goal-${++n}` })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('GoalsService.set with a chip', () => {
  it('answers the view of the goal: its honest answer, no colour note, the current copy version and the time it was set', async () => {
    const view = await set(AMARA, { goal: 'fade-dark-marks' })

    expect(view).toEqual({
      goal: 'fade-dark-marks',
      wantsLighter: false,
      text: null,
      answer: answerFor('fade-dark-marks', false),
      answersVersion: GOAL_ANSWERS_VERSION,
      updatedAt: T0,
    })
    expect(view.answer!.note).toBeNull()
  })

  it('stores the goal for the caller\'s profile, and the same view comes back from current', async () => {
    const set1 = await set(AMARA, { goal: 'glow' })

    expect(await current(AMARA)).toEqual(set1)
    expect(await repository.current('profile-amara-1')).toMatchObject({ goal: 'glow', wantsLighter: false, text: null, profileId: 'profile-amara-1' })
  })

  it('keeps every change with its date, newest first, and the newest is the current goal', async () => {
    await set(AMARA, { goal: 'clear-skin' })
    tick()
    await set(AMARA, { goal: 'even-tone' })
    tick()
    const last = await set(AMARA, { goal: 'glow' })

    const history = await repository.history('profile-amara-1')
    expect(history.map((row: GoalRow) => row.goal)).toEqual(['glow', 'even-tone', 'clear-skin'])
    expect(history.map((row: GoalRow) => row.createdAt)).toEqual([at(2 * MINUTE), at(MINUTE), T0])
    expect((await current(AMARA)).goal).toBe('glow')
    expect(last.updatedAt).toEqual(at(2 * MINUTE))
  })

  it('gives a guest the same as a verified user', async () => {
    const guest = await set(AMARA, { goal: 'brighter' })
    const verified = await set(TOLU, { goal: 'brighter' })

    expect(verified).toEqual(guest)
  })
})

describe('GoalsService.set with typed words', () => {
  it('saves the trimmed words with no goal and no answer, because nothing reads them yet', async () => {
    const view = await set(AMARA, { text: '  make my face clear  ' })

    expect(view).toEqual({ goal: null, wantsLighter: false, text: 'make my face clear', answer: null, answersVersion: GOAL_ANSWERS_VERSION, updatedAt: T0 })
    expect(await repository.current('profile-amara-1')).toMatchObject({ goal: null, wantsLighter: false, text: 'make my face clear' })
  })

  it('keeps the words as typed apart from the trimming, inner spaces and all', async () => {
    const view = await set(AMARA, { text: 'I  want  my skin  to glow' })

    expect(view.text).toBe('I  want  my skin  to glow')
  })

  it.each([
    ['a link', 'see https://evil.example for my goal'],
    ['a link starting www.', 'www.evil.example'],
    ['markup', 'make my <b>face</b> clear'],
    ['a zero-width space', 'make my face\u200Bclear'],
    ['a control character', 'make my face\u0007clear'],
  ])('refuses words with %s as INVALID_GOAL_TEXT and stores nothing', async (_label, text) => {
    const error = await errorOf(set(AMARA, { text }))

    expect(error.code).toBe('INVALID_GOAL_TEXT')
    expect(await repository.history('profile-amara-1')).toEqual([])
  })

  it('takes a plain angle bracket as ordinary text', async () => {
    const view = await set(AMARA, { text: 'spots < 1cm gone' })

    expect(view.text).toBe('spots < 1cm gone')
  })
})

describe('GoalsService.set keeping the words with the pick', () => {
  it('copies the typed words onto the chip picked next, because the pick answers "which is closest?"', async () => {
    await set(AMARA, { text: 'make my face clear' })
    tick()

    const view = await set(AMARA, { goal: 'clear-skin' })

    expect(view).toMatchObject({ goal: 'clear-skin', text: 'make my face clear', wantsLighter: false })
    expect(await repository.current('profile-amara-1')).toMatchObject({ goal: 'clear-skin', text: 'make my face clear' })
  })

  it('copies the latest words when the user typed twice before picking', async () => {
    await set(AMARA, { text: 'first try' })
    tick()
    await set(AMARA, { text: 'second try' })
    tick()

    const view = await set(AMARA, { goal: 'glow' })

    expect(view.text).toBe('second try')
  })

  it('leaves the text empty on a chip after a chip, because the current goal was already set', async () => {
    await set(AMARA, { goal: 'clear-skin' })
    tick()

    const view = await set(AMARA, { goal: 'glow' })

    expect(view.text).toBeNull()
  })

  it('leaves the text empty on a chip after the words were already matched to a goal, so old words do not follow later changes', async () => {
    await set(AMARA, { text: 'make my face clear' })
    tick()
    await set(AMARA, { goal: 'clear-skin' })
    tick()

    const view = await set(AMARA, { goal: 'glow' })

    expect(view).toMatchObject({ goal: 'glow', text: null })
  })

  it('keeps the words of an unsorted text across a chip that follows a chip, then text, then chip', async () => {
    await set(AMARA, { goal: 'even-tone' })
    tick()
    await set(AMARA, { text: 'something about my forehead' })
    tick()

    const view = await set(AMARA, { goal: 'brighter' })

    expect(view.text).toBe('something about my forehead')
  })

  it('does not copy words from another profile', async () => {
    await set(AMARA, { text: 'make my face clear' })
    tick()

    const view = await set(AMARA_SECOND_PROFILE, { goal: 'glow' })

    expect(view.text).toBeNull()
  })
})

describe('GoalsService.current', () => {
  it('throws 404 GOAL_NOT_SET before anything was set', async () => {
    const error = await errorOf(current(AMARA))

    expect(error.code).toBe('GOAL_NOT_SET')
    expect(error.name).toBe('NotFoundError')
  })

  it('answers the view with no goal and no answer after only words were saved, not GOAL_NOT_SET', async () => {
    await set(AMARA, { text: 'make my face clear' })

    expect(await current(AMARA)).toEqual({ goal: null, wantsLighter: false, text: 'make my face clear', answer: null, answersVersion: GOAL_ANSWERS_VERSION, updatedAt: T0 })
  })

  it('shows the newest row\'s time as updatedAt', async () => {
    await set(AMARA, { goal: 'clear-skin' })
    clock = at(7 * MINUTE)
    await set(AMARA, { goal: 'glow' })

    expect((await current(AMARA)).updatedAt).toEqual(at(7 * MINUTE))
  })

  it('keeps one profile\'s goal from another: Tolu and Amara\'s second profile see nothing of Amara\'s first', async () => {
    await set(AMARA, { goal: 'glow' })

    expect((await errorOf(current(TOLU))).code).toBe('GOAL_NOT_SET')
    expect((await errorOf(current(AMARA_SECOND_PROFILE))).code).toBe('GOAL_NOT_SET')
  })

  // The routes in this PR cannot set wantsLighter (nothing reads typed words yet), so this row is written directly, as the goal
  // reader will write it. It pins that the view is computed from the row.
  it('adds the colour note and the current copy version to a row that asked to be lighter, whatever version it was saved under', async () => {
    await repository.append({ id: 'seeded', profileId: 'profile-amara-1', text: 'I want to be lighter', goal: 'brighter', wantsLighter: true, answersVersion: 0, createdAt: T0 })

    const view = await current(AMARA)

    expect(view).toEqual({
      goal: 'brighter',
      wantsLighter: true,
      text: 'I want to be lighter',
      answer: answerFor('brighter', true),
      answersVersion: GOAL_ANSWERS_VERSION,
      updatedAt: T0,
    })
    expect(view.answer!.note).toMatch(/natural colou?r/i)
  })

  it('writes the current copy version on every row it saves', async () => {
    await set(AMARA, { goal: 'glow' })
    await set(AMARA, { text: 'words' })

    const rows = await repository.history('profile-amara-1')
    expect(rows.map((row: GoalRow) => row.answersVersion)).toEqual([GOAL_ANSWERS_VERSION, GOAL_ANSWERS_VERSION])
  })
})

describe('GoalsService.onboarding', () => {
  it('asks for the goal first when nothing was set, with no goal and no safety answer', async () => {
    expect(await onboarding(AMARA)).toEqual({ goal: null, safety: null, next: 'goal' })
  })

  it('asks for the goal again when only unsorted words were saved, and shows those words', async () => {
    const saved = await set(AMARA, { text: 'make my face clear' })

    expect(await onboarding(AMARA)).toEqual({ goal: saved, safety: null, next: 'goal' })
  })

  it('leads to safety once a goal is set, and carries the goal view', async () => {
    const saved = await set(AMARA, { goal: 'even-tone' })

    expect(await onboarding(AMARA)).toEqual({ goal: saved, safety: null, next: 'safety' })
  })

  it('leads to safety once the pick after unclear words is made', async () => {
    await set(AMARA, { text: 'make my face clear' })
    tick()
    const picked = await set(AMARA, { goal: 'clear-skin' })

    expect(await onboarding(AMARA)).toEqual({ goal: picked, safety: null, next: 'safety' })
  })

  it('asks for the goal for a profile that has none, while another profile of the account has one', async () => {
    await set(AMARA, { goal: 'glow' })

    expect(await onboarding(AMARA_SECOND_PROFILE)).toEqual({ goal: null, safety: null, next: 'goal' })
    expect((await onboarding(AMARA)).next).toBe('safety')
  })
})

describe('GoalsService without a session', () => {
  it('answers 401 AUTH_REQUIRED from set, current and onboarding, and stores nothing', async () => {
    const codes = [
      (await errorOf(set(PUBLIC, { goal: 'glow' }))).code,
      (await errorOf(set(PUBLIC, { text: 'make my face clear' }))).code,
      (await errorOf(current(PUBLIC))).code,
      (await errorOf(onboarding(PUBLIC))).code,
    ]

    expect(codes).toEqual(['AUTH_REQUIRED', 'AUTH_REQUIRED', 'AUTH_REQUIRED', 'AUTH_REQUIRED'])
    expect(await repository.history('profile-amara-1')).toEqual([])
  })

  it('answers 401 TOKEN_EXPIRED when the token it was given has expired', async () => {
    const error = await errorOf(runWithContext({ actor: PUBLIC, requestId: 'r', tokenProblem: 'expired' }, () => service.current()))

    expect(error.code).toBe('TOKEN_EXPIRED')
  })
})

describe('GoalsService logging', () => {
  it('never logs what the user typed, whichever way it is saved, read or refused', async () => {
    const SECRET_WORDS = 'make my face clear QZ7'
    const spies = (['log', 'debug', 'info', 'warn', 'error'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}))

    await set(AMARA, { text: SECRET_WORDS })
    tick()
    await set(AMARA, { goal: 'clear-skin' })
    await current(AMARA)
    await onboarding(AMARA)
    await errorOf(set(AMARA, { text: `${SECRET_WORDS} https://evil.example` }))

    const logged = spies.flatMap((spy) => spy.mock.calls.map((call) => JSON.stringify(call)))
    for (const line of logged) expect(line).not.toContain('QZ7')
  })
})
