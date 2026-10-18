import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Actor, runAs, runWithContext } from '../../lib/context'
import { FakeSafetyRepository } from './safety.repository.fake'
import { SafetyService } from './safety.service'
import type { SafetyRow } from './safety.types'
import { SAFETY_CHOICES, type SafetyChoice } from './safety.vocabulary'

// The one clock every test hangs off; later times are offsets from it.
const T0 = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs)

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error as Error & { code?: string; details?: unknown }
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
let repository: FakeSafetyRepository
let service: SafetyService

type SetInput = Parameters<SafetyService['set']>[0]
const set = (who: Actor, input: SetInput) => runAs(who, () => service.set(input))
const current = (who: Actor) => runAs(who, () => service.current())
const currentOrNull = (who: Actor) => runAs(who, () => service.currentOrNull())
const requireAnswered = (who: Actor) => runAs(who, () => service.requireAnswered())
const tick = () => {
  clock = new Date(clock.getTime() + MINUTE)
}

beforeEach(() => {
  clock = T0
  repository = new FakeSafetyRepository()
  let n = 0
  service = new SafetyService({ repository, now: () => clock, newId: () => `safety-${++n}` })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the safety vocabulary', () => {
  it('offers exactly these five choices, in this order', () => {
    expect([...SAFETY_CHOICES]).toEqual(['pregnant', 'breastfeeding', 'reaction', 'prescription', 'none'])
  })
})

describe('SafetyService.set', () => {
  it('answers the view of what was saved: the choices, no texts, the caution flag and the time it was saved', async () => {
    const view = await set(AMARA, { choices: ['pregnant'] })

    expect(view).toEqual({ choices: ['pregnant'], reactionText: null, prescriptionText: null, excludesPregnancyCaution: true, updatedAt: T0 })
  })

  it('stores the answer for the caller\'s profile, and the same view comes back from current', async () => {
    const saved = await set(AMARA, { choices: ['reaction'], reactionText: 'Caro White' })

    expect(await current(AMARA)).toEqual(saved)
    expect(await repository.current('profile-amara-1')).toMatchObject({ profileId: 'profile-amara-1', choices: ['reaction'], reactionText: 'Caro White', prescriptionText: null, createdAt: T0 })
  })

  it('accepts "none" on its own, with both texts empty and no pregnancy caution', async () => {
    const view = await set(AMARA, { choices: ['none'] })

    expect(view).toEqual({ choices: ['none'], reactionText: null, prescriptionText: null, excludesPregnancyCaution: false, updatedAt: T0 })
  })

  it('accepts every choice together except none', async () => {
    const view = await set(AMARA, { choices: ['pregnant', 'breastfeeding', 'reaction', 'prescription'], reactionText: 'fragrance', prescriptionText: 'clobetasol' })

    expect(view).toMatchObject({ choices: ['pregnant', 'breastfeeding', 'reaction', 'prescription'], reactionText: 'fragrance', prescriptionText: 'clobetasol' })
  })

  it('keeps both texts when both are given with their choices', async () => {
    const view = await set(TOLU, { choices: ['reaction', 'prescription'], reactionText: 'Caro White and fragrance', prescriptionText: 'hydroquinone cream' })

    expect(view).toMatchObject({ reactionText: 'Caro White and fragrance', prescriptionText: 'hydroquinone cream' })
  })

  it('gives a guest the same as a verified user', async () => {
    const guest = await set(AMARA, { choices: ['breastfeeding'] })
    const verified = await set(TOLU, { choices: ['breastfeeding'] })

    expect(verified).toEqual(guest)
  })
})

describe('SafetyService.set canonical choices', () => {
  it('stores and returns the choices in the vocabulary\'s order, whatever order they were sent in', async () => {
    const view = await set(AMARA, { choices: ['prescription', 'reaction', 'breastfeeding', 'pregnant'], reactionText: 'x', prescriptionText: 'y' })

    expect(view.choices).toEqual(['pregnant', 'breastfeeding', 'reaction', 'prescription'])
    expect((await repository.current('profile-amara-1'))!.choices).toEqual(['pregnant', 'breastfeeding', 'reaction', 'prescription'])
  })

  it('collapses a choice sent twice', async () => {
    const view = await set(AMARA, { choices: ['pregnant', 'pregnant', 'reaction', 'pregnant'] })

    expect(view.choices).toEqual(['pregnant', 'reaction'])
  })

  it('treats the same set sent in a different order as the same answer', async () => {
    const one = await set(AMARA, { choices: ['reaction', 'pregnant'] })
    const other = await set(TOLU, { choices: ['pregnant', 'reaction'] })

    expect(one.choices).toEqual(other.choices)
  })

  it('collapses a choice repeated many times to one', async () => {
    const view = await set(AMARA, { choices: ['pregnant', 'pregnant', 'pregnant', 'pregnant', 'pregnant', 'pregnant'] })

    expect(view.choices).toEqual(['pregnant'])
  })

  it('keeps "none" as the only choice, once, even if it was sent twice', async () => {
    const view = await set(AMARA, { choices: ['none', 'none'] })

    expect(view.choices).toEqual(['none'])
  })
})

describe('SafetyService.set refusing a contradictory answer', () => {
  it.each(SAFETY_CHOICES.filter((choice) => choice !== 'none').map((choice): [SafetyChoice] => [choice]))(
    'refuses "none" together with %s as INVALID_SAFETY_ANSWER naming the choices, and stores nothing',
    async (other) => {
      const error = await errorOf(set(AMARA, { choices: ['none', other] }))

      expect(error.name).toBe('ValidationError')
      expect(error.code).toBe('INVALID_SAFETY_ANSWER')
      expect(error.details).toEqual({ field: 'choices' })
      expect(await repository.history('profile-amara-1')).toEqual([])
    },
  )

  it('refuses "none" with the other choice listed first, too', async () => {
    const error = await errorOf(set(AMARA, { choices: ['pregnant', 'none'] }))

    expect(error.code).toBe('INVALID_SAFETY_ANSWER')
  })

  it('refuses reaction words when "a product gave me a reaction" was not ticked', async () => {
    const error = await errorOf(set(AMARA, { choices: ['pregnant'], reactionText: 'Caro White' }))

    expect(error.name).toBe('ValidationError')
    expect(error.code).toBe('INVALID_SAFETY_ANSWER')
    expect(error.details).toEqual({ field: 'reactionText' })
    expect(await repository.history('profile-amara-1')).toEqual([])
  })

  it('refuses prescription words when "I use a prescription" was not ticked', async () => {
    const error = await errorOf(set(AMARA, { choices: ['reaction'], reactionText: 'x', prescriptionText: 'clobetasol' }))

    expect(error.code).toBe('INVALID_SAFETY_ANSWER')
    expect(error.details).toEqual({ field: 'prescriptionText' })
    expect(await repository.history('profile-amara-1')).toEqual([])
  })

  it('refuses each text with "none", which is a statement that none of it applies', async () => {
    const reaction = await errorOf(set(AMARA, { choices: ['none'], reactionText: 'Caro White' }))
    const prescription = await errorOf(set(AMARA, { choices: ['none'], prescriptionText: 'clobetasol' }))

    expect([reaction.code, reaction.details]).toEqual(['INVALID_SAFETY_ANSWER', { field: 'reactionText' }])
    expect([prescription.code, prescription.details]).toEqual(['INVALID_SAFETY_ANSWER', { field: 'prescriptionText' }])
  })

  it('leaves the answer already saved as it was when a later one is refused', async () => {
    const saved = await set(AMARA, { choices: ['pregnant'] })
    tick()

    await errorOf(set(AMARA, { choices: ['none', 'pregnant'] }))

    expect(await current(AMARA)).toEqual(saved)
    expect(await repository.history('profile-amara-1')).toHaveLength(1)
  })
})

describe('SafetyService.set texts', () => {
  it('saves a text trimmed, with every run of spaces inside it made one space', async () => {
    const view = await set(AMARA, { choices: ['reaction', 'prescription'], reactionText: '  Caro  White   and fragrance  ', prescriptionText: '\n clobetasol \t' })

    expect(view.reactionText).toBe('Caro White and fragrance')
    expect(view.prescriptionText).toBe('clobetasol')
  })

  it.each([
    ['a line break', 'Caro White\nshea butter'],
    ['a Windows line break', 'Caro White\r\nshea butter'],
    ['a tab', 'Caro White\tshea butter'],
    ['a blank line and indent', 'Caro White\n\n   shea butter'],
    ['line breaks and tabs at the edges', '\n\tCaro White\r\nshea butter\t\n'],
  ])('accepts a list written over several lines (%s) and saves it with every run of whitespace as one space', async (_label, text) => {
    const view = await set(AMARA, { choices: ['reaction', 'prescription'], reactionText: text, prescriptionText: text })

    expect(view.reactionText).toBe('Caro White shea butter')
    expect(view.prescriptionText).toBe('Caro White shea butter')
    expect(await repository.current('profile-amara-1')).toMatchObject({ reactionText: 'Caro White shea butter', prescriptionText: 'Caro White shea butter' })
  })

  it('still refuses another control character next to a line break', async () => {
    const error = await errorOf(set(AMARA, { choices: ['reaction'], reactionText: 'Caro White\n\u0007shea butter' }))

    expect(error.code).toBe('INVALID_SAFETY_TEXT')
    expect(error.details).toEqual({ field: 'reactionText' })
  })

  it('still refuses a link on the second line', async () => {
    const error = await errorOf(set(AMARA, { choices: ['reaction'], reactionText: 'Caro White\nhttps://evil.example' }))

    expect(error.code).toBe('INVALID_SAFETY_TEXT')
  })

  it.each([
    ['an empty string', ''],
    ['only spaces', '   \n\t '],
  ])('saves %s as no text (null) when the choice is ticked, because naming nothing still counts', async (_label, text) => {
    const view = await set(AMARA, { choices: ['reaction', 'prescription'], reactionText: text, prescriptionText: text })

    expect(view.choices).toEqual(['reaction', 'prescription'])
    expect(view.reactionText).toBeNull()
    expect(view.prescriptionText).toBeNull()
    expect(await repository.current('profile-amara-1')).toMatchObject({ reactionText: null, prescriptionText: null })
  })

  it('saves no text (null) when the choice is ticked and the text is left out', async () => {
    const view = await set(AMARA, { choices: ['reaction'] })

    expect(view.reactionText).toBeNull()
  })

  it.each([
    ['an empty string', ''],
    ['only spaces', '   \n\t '],
  ])('accepts %s for a text whose choice is not ticked, as no text (null), because an empty field says nothing', async (_label, text) => {
    const view = await set(AMARA, { choices: ['pregnant'], reactionText: text, prescriptionText: text })

    expect(view).toEqual({ choices: ['pregnant'], reactionText: null, prescriptionText: null, excludesPregnancyCaution: true, updatedAt: T0 })
    expect(await repository.current('profile-amara-1')).toMatchObject({ choices: ['pregnant'], reactionText: null, prescriptionText: null })
  })

  it('accepts an empty text with "none", as no text', async () => {
    const view = await set(AMARA, { choices: ['none'], reactionText: '  ', prescriptionText: '' })

    expect(view).toMatchObject({ choices: ['none'], reactionText: null, prescriptionText: null })
  })

  it('still refuses a text with something in it when its choice is not ticked, even beside an empty one', async () => {
    const error = await errorOf(set(AMARA, { choices: ['pregnant'], reactionText: '  ', prescriptionText: ' clobetasol ' }))

    expect(error.code).toBe('INVALID_SAFETY_ANSWER')
    expect(error.details).toEqual({ field: 'prescriptionText' })
    expect(await repository.history('profile-amara-1')).toEqual([])
  })

  it('names the answer rule, not the text rule, when a text with a link has no choice ticked for it', async () => {
    const error = await errorOf(set(AMARA, { choices: ['pregnant'], reactionText: 'https://x.example' }))

    expect(error.code).toBe('INVALID_SAFETY_ANSWER')
    expect(error.details).toEqual({ field: 'reactionText' })
  })

  it('names the choices rule first when "none" is combined with another choice and a text carries a link', async () => {
    const error = await errorOf(set(AMARA, { choices: ['none', 'pregnant'], reactionText: 'https://x.example' }))

    expect(error.code).toBe('INVALID_SAFETY_ANSWER')
    expect(error.details).toEqual({ field: 'choices' })
  })

  it('takes a plain angle bracket as ordinary text', async () => {
    const view = await set(AMARA, { choices: ['reaction'], reactionText: 'stung when pH < 5' })

    expect(view.reactionText).toBe('stung when pH < 5')
  })

  it.each([
    ['a link', 'see https://evil.example'],
    ['a link starting www.', 'www.evil.example'],
    ['markup', 'Caro <b>White</b>'],
    ['a zero-width space', 'Caro​White'],
    ['a control character', 'Caro\u0007White'],
  ])('refuses reaction words with %s as INVALID_SAFETY_TEXT naming the field, and stores nothing', async (_label, text) => {
    const error = await errorOf(set(AMARA, { choices: ['reaction'], reactionText: text }))

    expect(error.name).toBe('ValidationError')
    expect(error.code).toBe('INVALID_SAFETY_TEXT')
    expect(error.details).toEqual({ field: 'reactionText' })
    expect(await repository.history('profile-amara-1')).toEqual([])
  })

  it.each([
    ['a link', 'see https://evil.example'],
    ['markup', 'clobetasol <script>'],
    ['a zero-width space', 'cloba​etasol'],
    ['a control character', 'cloba\u0007etasol'],
  ])('refuses prescription words with %s as INVALID_SAFETY_TEXT naming the field, and stores nothing', async (_label, text) => {
    const error = await errorOf(set(AMARA, { choices: ['prescription'], prescriptionText: text }))

    expect(error.code).toBe('INVALID_SAFETY_TEXT')
    expect(error.details).toEqual({ field: 'prescriptionText' })
    expect(await repository.history('profile-amara-1')).toEqual([])
  })

  it('judges the text after trimming: an invisible character is refused even when it is at the edge', async () => {
    const error = await errorOf(set(AMARA, { choices: ['reaction'], reactionText: 'Caro White​' }))

    expect(error.code).toBe('INVALID_SAFETY_TEXT')
  })
})

describe('SafetyService.set and the pregnancy caution', () => {
  it.each([
    [['pregnant'] as SafetyChoice[], true],
    [['breastfeeding'] as SafetyChoice[], true],
    [['pregnant', 'breastfeeding'] as SafetyChoice[], true],
    [['reaction', 'pregnant'] as SafetyChoice[], true],
    [['reaction'] as SafetyChoice[], false],
    [['prescription'] as SafetyChoice[], false],
    [['reaction', 'prescription'] as SafetyChoice[], false],
    [['none'] as SafetyChoice[], false],
  ])('answers excludesPregnancyCaution for %j as %s', async (choices, expected) => {
    const view = await set(AMARA, { choices })

    expect(view.excludesPregnancyCaution).toBe(expected)
    expect((await current(AMARA)).excludesPregnancyCaution).toBe(expected)
  })
})

describe('SafetyService history', () => {
  it('keeps every change with its date, newest first, and the newest is the current answer', async () => {
    await set(AMARA, { choices: ['pregnant'] })
    tick()
    await set(AMARA, { choices: ['none'] })
    tick()
    const last = await set(AMARA, { choices: ['breastfeeding', 'reaction'], reactionText: 'fragrance' })

    const history = await repository.history('profile-amara-1')
    expect(history.map((row: SafetyRow) => row.choices)).toEqual([['breastfeeding', 'reaction'], ['none'], ['pregnant']])
    expect(history.map((row: SafetyRow) => row.createdAt)).toEqual([at(2 * MINUTE), at(MINUTE), T0])
    expect(await current(AMARA)).toEqual(last)
    expect(last.updatedAt).toEqual(at(2 * MINUTE))
  })

  it('does not carry a text over to the next answer: each answer stands on what it says', async () => {
    await set(AMARA, { choices: ['reaction'], reactionText: 'Caro White' })
    tick()

    const view = await set(AMARA, { choices: ['reaction'] })

    expect(view.reactionText).toBeNull()
  })

  it('lets a later answer undo a pregnancy caution: the current answer is the newest, not the strictest', async () => {
    await set(AMARA, { choices: ['pregnant'] })
    tick()

    const view = await set(AMARA, { choices: ['none'] })

    expect(view.excludesPregnancyCaution).toBe(false)
    expect((await current(AMARA)).excludesPregnancyCaution).toBe(false)
  })

  it('writes each row with a different id', async () => {
    await set(AMARA, { choices: ['pregnant'] })
    await set(AMARA, { choices: ['none'] })

    const ids = (await repository.history('profile-amara-1')).map((row: SafetyRow) => row.id)
    expect(new Set(ids).size).toBe(2)
  })
})

describe('SafetyService.current and currentOrNull', () => {
  it('throws 404 SAFETY_NOT_SET before anything was set', async () => {
    const error = await errorOf(current(AMARA))

    expect(error.code).toBe('SAFETY_NOT_SET')
    expect(error.name).toBe('NotFoundError')
  })

  it('answers null from currentOrNull before anything was set, and the view afterwards', async () => {
    expect(await currentOrNull(AMARA)).toBeNull()

    const saved = await set(AMARA, { choices: ['prescription'], prescriptionText: 'clobetasol' })

    expect(await currentOrNull(AMARA)).toEqual(saved)
  })

  it('keeps one profile\'s answer from another: Tolu and Amara\'s second profile see nothing of Amara\'s first', async () => {
    await set(AMARA, { choices: ['pregnant'] })

    expect((await errorOf(current(TOLU))).code).toBe('SAFETY_NOT_SET')
    expect((await errorOf(current(AMARA_SECOND_PROFILE))).code).toBe('SAFETY_NOT_SET')
    expect(await currentOrNull(TOLU)).toBeNull()
    expect(await currentOrNull(AMARA_SECOND_PROFILE)).toBeNull()
  })

  it('keeps an answer set on a second profile on that profile', async () => {
    await set(AMARA_SECOND_PROFILE, { choices: ['breastfeeding'] })

    expect(await currentOrNull(AMARA)).toBeNull()
    expect((await current(AMARA_SECOND_PROFILE)).choices).toEqual(['breastfeeding'])
  })

  it('shows the newest row\'s time as updatedAt', async () => {
    await set(AMARA, { choices: ['pregnant'] })
    clock = at(7 * MINUTE)
    await set(AMARA, { choices: ['none'] })

    expect((await current(AMARA)).updatedAt).toEqual(at(7 * MINUTE))
  })

  it('picks the answer saved later when two were saved in the same millisecond', async () => {
    await set(AMARA, { choices: ['pregnant'] })
    const later = await set(AMARA, { choices: ['none'] })

    expect(await current(AMARA)).toEqual(later)
  })
})

describe('SafetyService.requireAnswered', () => {
  it('answers the current view once the profile has answered, "none" included', async () => {
    const saved = await set(AMARA, { choices: ['none'] })

    expect(await requireAnswered(AMARA)).toEqual(saved)
  })

  it('answers 409 SAFETY_ANSWERS_REQUIRED before anything was set', async () => {
    const error = await errorOf(requireAnswered(AMARA))

    expect(error.name).toBe('ConflictError')
    expect(error.code).toBe('SAFETY_ANSWERS_REQUIRED')
  })

  it('answers 409 for a profile that has not answered while another profile of the account has', async () => {
    await set(AMARA, { choices: ['pregnant'] })

    expect((await errorOf(requireAnswered(AMARA_SECOND_PROFILE))).code).toBe('SAFETY_ANSWERS_REQUIRED')
  })

  it('answers 401 AUTH_REQUIRED, not 409, without a session', async () => {
    expect((await errorOf(requireAnswered(PUBLIC))).code).toBe('AUTH_REQUIRED')
  })
})

describe('SafetyService without a session', () => {
  it('answers 401 AUTH_REQUIRED from set, current and currentOrNull, and stores nothing', async () => {
    const codes = [
      (await errorOf(set(PUBLIC, { choices: ['pregnant'] }))).code,
      (await errorOf(current(PUBLIC))).code,
      (await errorOf(currentOrNull(PUBLIC))).code,
    ]

    expect(codes).toEqual(['AUTH_REQUIRED', 'AUTH_REQUIRED', 'AUTH_REQUIRED'])
    expect(await repository.history('profile-amara-1')).toEqual([])
  })

  it('answers 401 TOKEN_EXPIRED when the token it was given has expired', async () => {
    const error = await errorOf(runWithContext({ actor: PUBLIC, requestId: 'r', tokenProblem: 'expired' }, () => service.current()))

    expect(error.code).toBe('TOKEN_EXPIRED')
  })
})

describe('SafetyService logging', () => {
  it('never logs what the user typed, whichever way it is saved, read or refused', async () => {
    const SECRET_WORDS = 'Caro White QZ7'
    const spies = (['log', 'debug', 'info', 'warn', 'error'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}))

    await set(AMARA, { choices: ['reaction', 'prescription'], reactionText: SECRET_WORDS, prescriptionText: SECRET_WORDS })
    await current(AMARA)
    await currentOrNull(AMARA)
    await requireAnswered(AMARA)
    await errorOf(set(AMARA, { choices: ['reaction'], reactionText: `${SECRET_WORDS} https://evil.example` }))
    await errorOf(set(AMARA, { choices: ['pregnant'], reactionText: SECRET_WORDS }))
    await errorOf(set(AMARA, { choices: ['none', 'prescription'], prescriptionText: SECRET_WORDS }))

    const logged = spies.flatMap((spy) => spy.mock.calls.map((call) => JSON.stringify(call)))
    for (const line of logged) expect(line).not.toContain('QZ7')
  })

  it('logs nothing when an answer is saved or read', async () => {
    const spies = (['log', 'debug', 'info', 'warn', 'error'] as const).map((method) => vi.spyOn(console, method).mockImplementation(() => {}))

    await set(AMARA, { choices: ['reaction'], reactionText: 'Caro White' })
    await current(AMARA)

    expect(spies.flatMap((spy) => spy.mock.calls)).toEqual([])
  })
})
