import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Actor, runAs, runWithContext } from '../../lib/context'
import { AiBudgetExceededError } from '../../providers/anthropic/ai-spend.provider'
import { AnthropicConfigError, AnthropicRefusalError, AnthropicRequestError, AnthropicUnavailableError } from '../../providers/anthropic/anthropic.provider'
import { MemoryGoalReader } from '../../providers/goal-reading/memory.goal-reader'
import { MemoryJobQueue } from '../../providers/job-queue/memory.job-queue'
import { MemoryMentionReader } from '../../providers/mention-reading/memory.mention-reader'
import { FakeSafetyRepository } from '../safety/safety.repository.fake'
import { SafetyService } from '../safety/safety.service'
import { GOAL_ANSWERS_VERSION, answerFor } from './goals.answers'
import { FakeGoalsRepository } from './goals.repository.fake'
import { GoalsService } from './goals.service'
import type { GoalRow } from './goals.types'
import { GOALS } from './goals.vocabulary'

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

// Onboarding asks the safety service for the answer and nothing else, so what it parses with is never reached here.
const NO_CATALOG = {
  resolve: async () => {
    throw new Error('the goals tests never reach the catalog')
  },
  research: async () => {
    throw new Error('the goals tests never reach the catalog')
  },
}

let clock: Date
let repository: FakeGoalsRepository
let reader: MemoryGoalReader
let safety: SafetyService
let service: GoalsService

const set = (who: Actor, input: Parameters<GoalsService['set']>[0]) => runAs(who, () => service.set(input))
const current = (who: Actor) => runAs(who, () => service.current())
const history = (who: Actor) => runAs(who, () => service.history())
const onboarding = (who: Actor) => runAs(who, () => service.onboarding())
const requireGoal = (who: Actor) => runAs(who, () => service.requireGoal())
const setSafety = (who: Actor, input: Parameters<SafetyService['set']>[0]) => runAs(who, () => safety.set(input))
const tick = () => {
  clock = new Date(clock.getTime() + MINUTE)
}

beforeEach(() => {
  clock = T0
  repository = new FakeGoalsRepository()
  reader = new MemoryGoalReader()
  let n = 0
  // The real SafetyService over its fake repository, as the AuthService tests use the real NotificationsService: onboarding asks it, never its repository.
  safety = new SafetyService({
    repository: new FakeSafetyRepository(),
    reader: new MemoryMentionReader(),
    catalog: NO_CATALOG,
    jobs: new MemoryJobQueue(),
    now: () => clock,
    newId: () => `safety-${crypto.randomUUID()}`,
  })
  service = new GoalsService({ repository, reader, safety, now: () => clock, newId: () => `goal-${++n}` })
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
  it('saves the trimmed words with no goal and no answer when the reader finds no goal in them', async () => {
    const view = await set(AMARA, { text: '  what is the weather  ' })

    expect(view).toEqual({ goal: null, wantsLighter: false, text: 'what is the weather', answer: null, answersVersion: GOAL_ANSWERS_VERSION, updatedAt: T0 })
    expect(await repository.current('profile-amara-1')).toMatchObject({ goal: null, wantsLighter: false, text: 'what is the weather' })
  })

  it('keeps the words as typed apart from the trimming, inner spaces and all', async () => {
    const view = await set(AMARA, { text: 'I  want  my skin  to glow' })

    expect(view.text).toBe('I  want  my skin  to glow')
  })

  it('asks the reader about the trimmed words, once', async () => {
    await set(AMARA, { text: '  make my face clear  ' })

    expect(reader.calls).toEqual(['make my face clear'])
  })

  it('saves the goal the reader found with the trimmed words, and answers with that goal\'s honest answer and no colour note', async () => {
    reader.respondWith(() => ({ goal: 'clear-skin', wantsLighter: false }))

    const view = await set(AMARA, { text: '  make my face clear  ' })

    expect(view).toEqual({
      goal: 'clear-skin',
      wantsLighter: false,
      text: 'make my face clear',
      answer: answerFor('clear-skin', false),
      answersVersion: GOAL_ANSWERS_VERSION,
      updatedAt: T0,
    })
    expect(view.answer!.note).toBeNull()
    expect(await repository.current('profile-amara-1')).toMatchObject({ goal: 'clear-skin', wantsLighter: false, text: 'make my face clear', profileId: 'profile-amara-1' })
  })

  it('saves wantsLighter with the goal and answers with the colour note when the reader says the user asked to be lighter', async () => {
    reader.respondWith(() => ({ goal: 'brighter', wantsLighter: true }))

    const view = await set(AMARA, { text: 'I want to be fairer' })

    expect(view).toEqual({
      goal: 'brighter',
      wantsLighter: true,
      text: 'I want to be fairer',
      answer: answerFor('brighter', true),
      answersVersion: GOAL_ANSWERS_VERSION,
      updatedAt: T0,
    })
    expect(view.answer!.note).not.toBeNull()
    expect(await repository.current('profile-amara-1')).toMatchObject({ goal: 'brighter', wantsLighter: true })
  })

  it('gives the colour note to no goal the reader sorted without wantsLighter', async () => {
    for (const goal of GOALS) {
      reader.respondWith(() => ({ goal, wantsLighter: false }))
      tick()

      expect((await set(AMARA, { text: `words for ${goal}` })).answer!.note, goal).toBeNull()
    }
  })

  it.each([
    ['a link', 'see https://evil.example for my goal'],
    ['a link starting www.', 'www.evil.example'],
    ['markup', 'make my <b>face</b> clear'],
    ['a zero-width space', 'make my face\u200Bclear'],
    ['a control character', 'make my face\u0007clear'],
  ])('refuses words with %s as INVALID_GOAL_TEXT, stores nothing and never asks the reader', async (_label, text) => {
    const error = await errorOf(set(AMARA, { text }))

    expect(error.code).toBe('INVALID_GOAL_TEXT')
    expect(await repository.history('profile-amara-1')).toEqual([])
    expect(reader.calls).toEqual([])
  })

  it('takes a plain angle bracket as ordinary text', async () => {
    const view = await set(AMARA, { text: 'spots < 1cm gone' })

    expect(view.text).toBe('spots < 1cm gone')
  })
})

describe('GoalsService.set when the reader cannot read the words', () => {
  const SECRET_WORDS = 'make my face clear QZ7'
  // The reason codes are the ones architecture.md promises.
  const failures: [string, () => Error, string][] = [
    ['AiBudgetExceededError', () => new AiBudgetExceededError('cap'), 'budget-exceeded'],
    ['AnthropicUnavailableError', () => new AnthropicUnavailableError('overloaded'), 'unavailable'],
    ['AnthropicRequestError', () => new AnthropicRequestError('bad request'), 'request-rejected'],
    ['AnthropicRefusalError', () => new AnthropicRefusalError('refused'), 'refused'],
  ]

  it.each(failures)('still saves the words with no goal and no answer when the reader throws %s, so the app falls back to the chips', async (_name, error) => {
    reader.failNextWith(error())
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const view = await set(AMARA, { text: `  ${SECRET_WORDS}  ` })

    expect(view).toEqual({ goal: null, wantsLighter: false, text: SECRET_WORDS, answer: null, answersVersion: GOAL_ANSWERS_VERSION, updatedAt: T0 })
    expect(await repository.current('profile-amara-1')).toMatchObject({ goal: null, wantsLighter: false, text: SECRET_WORDS })
    expect((await onboarding(AMARA)).next).toBe('goal')
  })

  it.each(failures)('logs one { outcome: "goal-read-failed", reason } for %s with its own reason code, and not a word the user typed', async (_name, error, reason) => {
    reader.failNextWith(error())
    const spies = (['log', 'debug', 'info', 'warn', 'error'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}))
    const errorSpy = spies[4]!

    await set(AMARA, { text: SECRET_WORDS })

    const logged = spies.flatMap((spy) => spy.mock.calls)
    expect(logged).toHaveLength(1)
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(logged[0]).toEqual([{ outcome: 'goal-read-failed', reason }])
    expect(JSON.stringify(logged)).not.toContain('QZ7')
  })

  it('lets the next typed words be read again once the outage is over', async () => {
    reader.failNextWith(new AnthropicUnavailableError('overloaded'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await set(AMARA, { text: 'make my face clear' })
    tick()
    reader.respondWith(() => ({ goal: 'clear-skin', wantsLighter: false }))

    const view = await set(AMARA, { text: 'make my face clear' })

    expect(view.goal).toBe('clear-skin')
  })

  it.each([
    ['a plain Error', () => new Error('boom')],
    ['AnthropicConfigError, a setup problem for us to fix rather than an outage to hide', () => new AnthropicConfigError('bad key')],
  ])('lets %s through, and stores nothing', async (_name, error) => {
    const failure = error()
    reader.failNextWith(failure)

    await expect(set(AMARA, { text: 'make my face clear' })).rejects.toBe(failure)
    expect(await repository.history('profile-amara-1')).toEqual([])
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

  it('leaves the text empty on a chip after words the reader sorted into a goal, so old words do not follow later changes', async () => {
    reader.respondWith(() => ({ goal: 'clear-skin', wantsLighter: false }))
    await set(AMARA, { text: 'make my face clear' })
    tick()

    const view = await set(AMARA, { goal: 'glow' })

    expect(view).toMatchObject({ goal: 'glow', text: null, wantsLighter: false })
    expect(await repository.current('profile-amara-1')).toMatchObject({ goal: 'glow', text: null })
  })

  it('copies the words onto the chip picked after the reader found no goal in them', async () => {
    await set(AMARA, { text: 'something about my forehead' })
    tick()

    const view = await set(AMARA, { goal: 'even-tone' })

    expect(view).toMatchObject({ goal: 'even-tone', text: 'something about my forehead' })
  })

  it('copies the words onto the chip picked after the reader failed, because the app fell back to the chips for those words', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    reader.failNextWith(new AnthropicUnavailableError('overloaded'))
    await set(AMARA, { text: 'make my face clear' })
    tick()

    const view = await set(AMARA, { goal: 'clear-skin' })

    expect(view).toMatchObject({ goal: 'clear-skin', text: 'make my face clear' })
  })

  it('never asks the reader about a chip', async () => {
    await set(AMARA, { goal: 'glow' })
    tick()
    await set(AMARA, { goal: 'brighter' })

    expect(reader.calls).toEqual([])
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

  it('adds the colour note to a goal saved from words that asked to be lighter', async () => {
    reader.respondWith(() => ({ goal: 'brighter', wantsLighter: true }))
    await set(AMARA, { text: 'I want to be lighter' })

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

  it('carries the current copy version and the note for a row saved under an older version, so new copy reaches goals saved earlier', async () => {
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
    expect(view.answersVersion).not.toBe(0)
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

  it('leads to safety once the reader sorted the typed words into a goal', async () => {
    reader.respondWith(() => ({ goal: 'clear-skin', wantsLighter: false }))
    const saved = await set(AMARA, { text: 'make my face clear' })

    expect(await onboarding(AMARA)).toEqual({ goal: saved, safety: null, next: 'safety' })
  })

  it('keeps asking for the goal when the reader failed, and shows the saved words', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    reader.failNextWith(new AnthropicUnavailableError('overloaded'))
    const saved = await set(AMARA, { text: 'make my face clear' })

    expect(await onboarding(AMARA)).toEqual({ goal: saved, safety: null, next: 'goal' })
  })

  it('asks for the goal for a profile that has none, while another profile of the account has one', async () => {
    await set(AMARA, { goal: 'glow' })

    expect(await onboarding(AMARA_SECOND_PROFILE)).toEqual({ goal: null, safety: null, next: 'goal' })
    expect((await onboarding(AMARA)).next).toBe('safety')
  })

  it('stays on the goal step when only the safety question was answered, but carries the safety answer', async () => {
    const answered = await setSafety(AMARA, { choices: ['pregnant'] })

    expect(await onboarding(AMARA)).toEqual({ goal: null, safety: answered, next: 'goal' })
  })

  it('stays on the goal step when the safety question was answered and the goal is only unsorted words', async () => {
    const answered = await setSafety(AMARA, { choices: ['none'] })
    const saved = await set(AMARA, { text: 'make my face clear' })

    expect(await onboarding(AMARA)).toEqual({ goal: saved, safety: answered, next: 'goal' })
  })

  it('leads to the shelf once the goal is set and the safety question is answered, carrying both views', async () => {
    const saved = await set(AMARA, { goal: 'even-tone' })
    const answered = await setSafety(AMARA, { choices: ['breastfeeding', 'pregnant'] })

    expect(await onboarding(AMARA)).toEqual({ goal: saved, safety: answered, next: 'shelf' })
  })

  it('leads to the shelf when the answer is "none", which is an answer', async () => {
    await set(AMARA, { goal: 'glow' })
    await setSafety(AMARA, { choices: ['none'] })

    expect((await onboarding(AMARA)).next).toBe('shelf')
  })

  it('leads to the shelf in either order of answering', async () => {
    await setSafety(TOLU, { choices: ['reaction'], reactionText: 'fragrance' })
    expect((await onboarding(TOLU)).next).toBe('goal')

    await set(TOLU, { goal: 'brighter' })

    expect((await onboarding(TOLU)).next).toBe('shelf')
  })

  it('shows the newest safety answer once it was changed', async () => {
    await set(AMARA, { goal: 'glow' })
    await setSafety(AMARA, { choices: ['pregnant'] })
    tick()
    const changed = await setSafety(AMARA, { choices: ['none'] })

    expect((await onboarding(AMARA)).safety).toEqual(changed)
  })

  it('asks for safety on a profile that has a goal and no safety answer, while another profile of the account has answered', async () => {
    await set(AMARA, { goal: 'glow' })
    await set(AMARA_SECOND_PROFILE, { goal: 'glow' })
    await setSafety(AMARA, { choices: ['none'] })

    expect((await onboarding(AMARA)).next).toBe('shelf')
    expect(await onboarding(AMARA_SECOND_PROFILE)).toMatchObject({ safety: null, next: 'safety' })
  })
})

// The caller's own goal history, oldest first, which is the order the chase rule reads it in (face-scans.tables.ts, issue #145): a run of one
// goal, a detour, a row with no goal. The repository answers newest first, so the order here is the service's own promise.
describe('GoalsService.history', () => {
  it('answers the caller\'s rows oldest first, each with the goal it set and when', async () => {
    await set(AMARA, { goal: 'clear-skin' })
    tick()
    await set(AMARA, { goal: 'even-tone' })
    tick()
    await set(AMARA, { goal: 'glow' })

    const rows = await history(AMARA)

    expect(rows.map((row: GoalRow) => row.goal)).toEqual(['clear-skin', 'even-tone', 'glow'])
    expect(rows.map((row: GoalRow) => row.createdAt)).toEqual([T0, at(MINUTE), at(2 * MINUTE)])
  })

  it('keeps a row for every change, including picking the same goal again and words nobody sorted into a goal', async () => {
    await set(AMARA, { goal: 'glow' })
    tick()
    await set(AMARA, { goal: 'glow' })
    tick()
    await set(AMARA, { text: 'something the reader finds no goal in' })

    expect((await history(AMARA)).map((row: GoalRow) => row.goal)).toEqual(['glow', 'glow', null])
  })

  it('answers nothing for a profile that never set a goal, even when another profile of the account has one', async () => {
    await set(AMARA, { goal: 'glow' })

    expect(await history(AMARA_SECOND_PROFILE)).toEqual([])
  })

  it('is the caller\'s own history: another account\'s rows are not in it', async () => {
    await set(AMARA, { goal: 'glow' })
    tick()
    await set(TOLU, { goal: 'brighter' })

    expect((await history(AMARA)).map((row: GoalRow) => row.goal)).toEqual(['glow'])
    expect((await history(TOLU)).map((row: GoalRow) => row.goal)).toEqual(['brighter'])
  })

  it('answers 401 AUTH_REQUIRED without a session', async () => {
    expect((await errorOf(history(PUBLIC))).code).toBe('AUTH_REQUIRED')
  })
})

describe('GoalsService.requireGoal', () => {
  it('answers the current goal view once a goal is set', async () => {
    const saved = await set(AMARA, { goal: 'fade-dark-marks' })

    expect(await requireGoal(AMARA)).toEqual(saved)
  })

  it('answers 409 GOAL_REQUIRED before anything was set', async () => {
    const error = await errorOf(requireGoal(AMARA))

    expect(error.name).toBe('ConflictError')
    expect(error.code).toBe('GOAL_REQUIRED')
  })

  it('answers 409 GOAL_REQUIRED when only words nobody sorted into a goal were saved', async () => {
    await set(AMARA, { text: 'make my face clear' })

    expect((await errorOf(requireGoal(AMARA))).code).toBe('GOAL_REQUIRED')
  })

  it('answers the goal once the pick after unclear words is made', async () => {
    await set(AMARA, { text: 'make my face clear' })
    tick()
    const picked = await set(AMARA, { goal: 'clear-skin' })

    expect(await requireGoal(AMARA)).toEqual(picked)
  })

  it('answers 409 GOAL_REQUIRED for a profile with no goal while another profile of the account has one', async () => {
    await set(AMARA, { goal: 'glow' })

    expect((await errorOf(requireGoal(AMARA_SECOND_PROFILE))).code).toBe('GOAL_REQUIRED')
  })

  it('answers 401 AUTH_REQUIRED, not 409, without a session', async () => {
    expect((await errorOf(requireGoal(PUBLIC))).code).toBe('AUTH_REQUIRED')
  })
})

// The goal as the shelf verdict reads it (spec #171, slice D1): the profile's current goal id, by profile id with no session because the build is a job, and null
// when there is no goal to judge a shelf against (never set, or only words nobody sorted into a goal), where `requireGoal` would refuse.
describe('GoalsService.goalFor', () => {
  it('is the goal the profile picked', async () => {
    await set(AMARA, { goal: 'fade-dark-marks' })

    expect(await service.goalFor('profile-amara-1')).toBe('fade-dark-marks')
  })

  it('is the newest goal once the profile has changed it', async () => {
    await set(AMARA, { goal: 'fade-dark-marks' })
    tick()
    await set(AMARA, { goal: 'glow' })

    expect(await service.goalFor('profile-amara-1')).toBe('glow')
  })

  it('is the goal the reader found in typed words', async () => {
    reader.respondWith(() => ({ goal: 'clear-skin', wantsLighter: false }))
    await set(AMARA, { text: 'make my face clear' })

    expect(await service.goalFor('profile-amara-1')).toBe('clear-skin')
  })

  it('is null for a profile that never set a goal, and for words nobody sorted into a goal', async () => {
    expect(await service.goalFor('profile-amara-1')).toBeNull()

    await set(AMARA, { text: 'what is the weather' })

    expect(await service.goalFor('profile-amara-1')).toBeNull()
  })

  it('answers for the profile it is asked about and never for a caller: it needs no session, and a session of another profile changes nothing', async () => {
    await set(AMARA, { goal: 'glow' })
    await set(TOLU, { goal: 'even-tone' })

    expect(await service.goalFor('profile-amara-1')).toBe('glow')
    expect(await runAs(TOLU, () => service.goalFor('profile-amara-1'))).toBe('glow')
    expect(await service.goalFor('profile-amara-2')).toBeNull()
  })
})

describe('GoalsService without a session', () => {
  it('answers 401 AUTH_REQUIRED from set, current and onboarding, stores nothing and never asks the reader', async () => {
    const codes = [
      (await errorOf(set(PUBLIC, { goal: 'glow' }))).code,
      (await errorOf(set(PUBLIC, { text: 'make my face clear' }))).code,
      (await errorOf(current(PUBLIC))).code,
      (await errorOf(onboarding(PUBLIC))).code,
    ]

    expect(codes).toEqual(['AUTH_REQUIRED', 'AUTH_REQUIRED', 'AUTH_REQUIRED', 'AUTH_REQUIRED'])
    expect(await repository.history('profile-amara-1')).toEqual([])
    expect(reader.calls).toEqual([])
  })

  it('answers 401 TOKEN_EXPIRED when the token it was given has expired', async () => {
    const error = await errorOf(runWithContext({ actor: PUBLIC, requestId: 'r', tokenProblem: 'expired' }, () => service.current()))

    expect(error.code).toBe('TOKEN_EXPIRED')
  })
})

describe('GoalsService logging', () => {
  it('never logs what the user typed, whichever way it is saved, read, failed or refused', async () => {
    const SECRET_WORDS = 'make my face clear QZ7'
    const spies = (['log', 'debug', 'info', 'warn', 'error'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}))

    await set(AMARA, { text: SECRET_WORDS })
    tick()
    reader.respondWith(() => ({ goal: 'brighter', wantsLighter: true }))
    await set(AMARA, { text: SECRET_WORDS })
    tick()
    reader.failNextWith(new AnthropicUnavailableError('overloaded'))
    await set(AMARA, { text: SECRET_WORDS })
    tick()
    await set(AMARA, { goal: 'clear-skin' })
    await current(AMARA)
    await onboarding(AMARA)
    await errorOf(set(AMARA, { text: `${SECRET_WORDS} https://evil.example` }))

    const logged = spies.flatMap((spy) => spy.mock.calls.map((call) => JSON.stringify(call)))
    for (const line of logged) expect(line).not.toContain('QZ7')
  })

  it('logs nothing when the reader reads the words, or when a chip is picked', async () => {
    const spies = (['log', 'debug', 'info', 'warn', 'error'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}))
    reader.respondWith(() => ({ goal: 'clear-skin', wantsLighter: false }))

    await set(AMARA, { text: 'make my face clear' })
    await set(AMARA, { goal: 'glow' })

    expect(spies.flatMap((spy) => spy.mock.calls)).toEqual([])
  })
})
