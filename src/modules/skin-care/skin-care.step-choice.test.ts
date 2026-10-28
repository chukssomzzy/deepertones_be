import { describe, expect, it } from 'vitest'
import type { RoutineStep } from '../catalog/catalog.vocabulary'
import { stepToPause } from './skin-care.step-choice'
import type { SkinCareRoutine, SkinCareRoutineStep } from './skin-care.types'

// Choosing the step a pause is for (spec #233, owner rules for PR 4b). Pure: a routine and the pauses already open in, a step (or "nothing to pause") out.
//
// THE CONTRACT THIS FILE PINS (assumed: the brief names the function and its arguments, not the module or the return type):
//   src/modules/skin-care/skin-care.step-choice.ts
//   stepToPause(routine: SkinCareRoutine, openPauses: readonly { step: RoutineStep | null }[]): SkinCareRoutineStep | null
//     The step of `routine.steps` to pause, or null for "nothing to pause".
//     openPauses is matched by STEP ALONE: a step with any open pause is already paused, whatever product the pause names. (A pause whose product has since changed is ended
//     by reconcile before a log reads the routine, so by step and by (step, product) never differ in life.) A stepless pause (step null) excludes nothing.
//     Only the pauses with state 'paused' are passed; the function does not look at a state.
//   Rules, in order:
//     1. Never `protect` (sunscreen). A step-down product never appears in `steps`, so it can never be chosen.
//     2. Never a step that is already paused.
//     3. Among the active steps (activeGroups non-empty) the most recently changed (`changedOn`, null meaning day 1).
//     4. With no active step left, the most recently changed non-sunscreen step.
//     5. A tie in either: treat, then cleanse, then moisturise.
//     6. Nothing left: null.

// Every date hangs off day 1 of the routine; `changedOn` is an offset from it.
const DAY_ONE = '2030-06-10'
const DAY = 24 * 60 * 60 * 1000
const dayAt = (offsetDays: number) => new Date(new Date(`${DAY_ONE}T00:00:00.000Z`).getTime() + offsetDays * DAY).toISOString().slice(0, 10)

type Over = Partial<SkinCareRoutineStep>
const step = (name: RoutineStep, over: Over = {}): SkinCareRoutineStep => ({
  step: name,
  title: `${name} title`,
  productRef: { kind: 'shelf', id: `entry-${name}` },
  productId: `prod-${name}`,
  changedOn: DAY_ONE,
  activeGroups: [],
  ...over,
})
const routineOf = (...steps: SkinCareRoutineStep[]): SkinCareRoutine => ({ dayOne: DAY_ONE, steps, stepDownRunning: false })
const chosen = (routine: SkinCareRoutine, paused: RoutineStep[] = []) => stepToPause(routine, paused.map((name) => ({ step: name })))?.step ?? null

const ACTIVE = ['retinoid'] as const

describe('stepToPause: among the active steps', () => {
  it('picks the active step that changed most recently', () => {
    const routine = routineOf(
      step('cleanse', { changedOn: dayAt(9) }),
      step('treat', { changedOn: dayAt(2), activeGroups: [...ACTIVE] }),
      step('moisturise', { changedOn: dayAt(5), activeGroups: ['exfoliating-acid'] }),
    )

    expect(chosen(routine)).toBe('moisturise')
  })

  it('prefers an older active step to a newer step that is not active', () => {
    const routine = routineOf(step('treat', { changedOn: dayAt(1), activeGroups: [...ACTIVE] }), step('cleanse', { changedOn: dayAt(20) }), step('moisturise', { changedOn: dayAt(30) }))

    expect(chosen(routine)).toBe('treat')
  })

  it('takes a null changedOn as day 1: it loses to a later change and ties with a change on day 1', () => {
    const later = routineOf(step('treat', { changedOn: null, activeGroups: [...ACTIVE] }), step('cleanse', { changedOn: dayAt(1), activeGroups: [...ACTIVE] }))
    const same = routineOf(step('cleanse', { changedOn: DAY_ONE, activeGroups: [...ACTIVE] }), step('moisturise', { changedOn: null, activeGroups: [...ACTIVE] }))

    expect(chosen(later)).toBe('cleanse')
    // Both are day 1: a tie, so cleanse comes before moisturise.
    expect(chosen(same)).toBe('cleanse')
  })

  it.each([
    ['treat before cleanse', ['cleanse', 'treat'], 'treat'],
    ['treat before moisturise', ['moisturise', 'treat'], 'treat'],
    ['cleanse before moisturise', ['moisturise', 'cleanse'], 'cleanse'],
    ['treat before the other two', ['moisturise', 'cleanse', 'treat'], 'treat'],
  ] as [string, RoutineStep[], RoutineStep][])('breaks a tie on the day by the fixed order: %s', (_why, present, expected) => {
    const routine = routineOf(...present.map((name) => step(name, { changedOn: dayAt(4), activeGroups: [...ACTIVE] })))

    expect(chosen(routine)).toBe(expected)
  })

  it('breaks the tie the same way whatever order the steps are listed in', () => {
    const routine = routineOf(
      step('moisturise', { changedOn: dayAt(4), activeGroups: [...ACTIVE] }),
      step('treat', { changedOn: dayAt(4), activeGroups: [...ACTIVE] }),
      step('cleanse', { changedOn: dayAt(4), activeGroups: [...ACTIVE] }),
    )

    expect(chosen(routine)).toBe('treat')
  })

  it('does not let the tie order beat a later change', () => {
    const routine = routineOf(step('treat', { changedOn: dayAt(3), activeGroups: [...ACTIVE] }), step('moisturise', { changedOn: dayAt(4), activeGroups: [...ACTIVE] }))

    expect(chosen(routine)).toBe('moisturise')
  })
})

describe('stepToPause: never the sunscreen', () => {
  it('skips an active sunscreen however recently it changed', () => {
    const routine = routineOf(step('protect', { changedOn: dayAt(30), activeGroups: [...ACTIVE] }), step('treat', { changedOn: dayAt(1), activeGroups: [...ACTIVE] }))

    expect(chosen(routine)).toBe('treat')
  })

  it('skips a sunscreen that changed after every other step when none is active', () => {
    const routine = routineOf(step('cleanse', { changedOn: dayAt(1) }), step('protect', { changedOn: dayAt(30) }), step('moisturise', { changedOn: dayAt(2) }))

    expect(chosen(routine)).toBe('moisturise')
  })

  it('has nothing to pause when the sunscreen is the only step, active or not', () => {
    expect(stepToPause(routineOf(step('protect')), [])).toBeNull()
    expect(stepToPause(routineOf(step('protect', { activeGroups: [...ACTIVE] })), [])).toBeNull()
  })
})

describe('stepToPause: a step that is already paused', () => {
  it('skips it and takes the next active step', () => {
    const routine = routineOf(step('treat', { changedOn: dayAt(8), activeGroups: [...ACTIVE] }), step('cleanse', { changedOn: dayAt(3), activeGroups: ['benzoyl-peroxide'] }))

    expect(chosen(routine, ['treat'])).toBe('cleanse')
  })

  it('falls through to the steps that are not active once every active step is paused', () => {
    const routine = routineOf(step('treat', { changedOn: dayAt(8), activeGroups: [...ACTIVE] }), step('cleanse', { changedOn: dayAt(3) }), step('moisturise', { changedOn: dayAt(5) }))

    expect(chosen(routine, ['treat'])).toBe('moisturise')
  })

  it('has nothing to pause once every non-sunscreen step is paused', () => {
    const routine = routineOf(step('cleanse'), step('treat'), step('moisturise'), step('protect'))

    expect(chosen(routine, ['cleanse', 'treat', 'moisturise'])).toBeNull()
  })

  it('does not count a stepless pause as a paused step', () => {
    const routine = routineOf(step('cleanse', { changedOn: dayAt(1) }), step('treat', { changedOn: dayAt(2) }))

    expect(stepToPause(routine, [{ step: null }])?.step).toBe('treat')
  })
})

describe('stepToPause: with no active step', () => {
  it('picks the step that changed most recently', () => {
    const routine = routineOf(step('cleanse', { changedOn: dayAt(2) }), step('treat', { changedOn: dayAt(1) }), step('moisturise', { changedOn: dayAt(6) }))

    expect(chosen(routine)).toBe('moisturise')
  })

  it.each([
    ['treat before cleanse', ['cleanse', 'treat'], 'treat'],
    ['treat before moisturise', ['moisturise', 'treat'], 'treat'],
    ['cleanse before moisturise', ['moisturise', 'cleanse'], 'cleanse'],
    ['treat first of all three', ['moisturise', 'cleanse', 'treat'], 'treat'],
  ] as [string, RoutineStep[], RoutineStep][])('breaks a tie by the fixed order: %s', (_why, present, expected) => {
    const routine = routineOf(...present.map((name) => step(name, { changedOn: dayAt(3) })))

    expect(chosen(routine)).toBe(expected)
  })

  it('treats every step with a null changedOn as day 1, so a routine nothing has changed since Start pauses the treat step', () => {
    const routine = routineOf(step('cleanse', { changedOn: null }), step('moisturise', { changedOn: null }), step('treat', { changedOn: null }), step('protect', { changedOn: null }))

    expect(chosen(routine)).toBe('treat')
  })

  it('picks the one step there is', () => {
    expect(chosen(routineOf(step('moisturise')))).toBe('moisturise')
  })
})

describe('stepToPause: nothing to pause', () => {
  it('answers null for a routine with no steps', () => {
    expect(stepToPause(routineOf(), [])).toBeNull()
  })

  it('does not mutate the routine or the pauses it is given', () => {
    const routine = routineOf(step('treat', { changedOn: dayAt(2) }), step('cleanse', { changedOn: dayAt(1) }))
    const before = structuredClone(routine)
    const pauses = [{ step: 'treat' as const }]

    stepToPause(routine, pauses)

    expect(routine).toEqual(before)
    expect(pauses).toEqual([{ step: 'treat' }])
  })
})
