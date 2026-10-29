import { describe, expect, it } from 'vitest'
import type { IngredientGroup, RoutineStep } from '../catalog/catalog.vocabulary'
import { heldSteps } from './skin-care.holds'
import type { SkinCareRoutine, SkinCareRoutineStep } from './skin-care.types'

// What an open escalation hold keeps out of the routine (spec #233, PR 6b-i): the steps with an active ingredient. Pure: it reads the routine and a flag, nothing else.
//
// THE CONTRACT THIS FILE PINS (assumed: the brief names the function, its two arguments and "the steps a hold keeps out", not the element type of the answer):
//   src/modules/skin-care/skin-care.holds.ts exports
//     heldSteps(routine: SkinCareRoutine, held: boolean): RoutineStep[]
//   The answer is the step names, in the routine's order, and is [] when `held` is false. With a hold open, a step is kept out when its product has an active ingredient group
//   (activeGroups is non-empty), except `protect`: sunscreen is never held, whatever its groups. The basics (a plain cleanser, a plain moisturiser) and sunscreen carry on, and a step-down
//   carries on too: step-down products are never in `routine.steps`, so `stepDownRunning` changes nothing here.

const DAY_ONE = '2030-06-15'

const step = (name: RoutineStep, activeGroups: IngredientGroup[] = []): SkinCareRoutineStep => ({
  step: name,
  title: `${name} step`,
  productRef: { kind: 'shelf', id: `entry-${name}` },
  productId: `prod-${name}`,
  changedOn: DAY_ONE,
  activeGroups,
})

const routineOf = (steps: SkinCareRoutineStep[], over: Partial<SkinCareRoutine> = {}): SkinCareRoutine => ({ dayOne: DAY_ONE, steps, stepDownRunning: false, ...over })

describe('heldSteps', () => {
  it('keeps out a step whose product has an active group, and carries on the basics and sunscreen', () => {
    const routine = routineOf([step('cleanse'), step('treat', ['retinoid']), step('moisturise'), step('protect')])

    expect(heldSteps(routine, true)).toEqual(['treat'])
  })

  it.each<IngredientGroup>(['retinoid', 'exfoliating-acid', 'benzoyl-peroxide'])('keeps out a step holding %s', (group) => {
    expect(heldSteps(routineOf([step('treat', [group])]), true)).toEqual(['treat'])
  })

  it('keeps out an active step whichever step it is: a benzoyl peroxide cleanser, an acid moisturiser', () => {
    const routine = routineOf([step('cleanse', ['benzoyl-peroxide']), step('treat'), step('moisturise', ['exfoliating-acid']), step('protect')])

    expect(heldSteps(routine, true)).toEqual(['cleanse', 'moisturise'])
  })

  it('keeps out a step with several active groups once', () => {
    expect(heldSteps(routineOf([step('treat', ['retinoid', 'exfoliating-acid'])]), true)).toEqual(['treat'])
  })

  it('answers the held steps in the routine\'s order', () => {
    const routine = routineOf([step('moisturise', ['exfoliating-acid']), step('cleanse', ['benzoyl-peroxide']), step('treat', ['retinoid'])])

    expect(heldSteps(routine, true)).toEqual(['moisturise', 'cleanse', 'treat'])
  })

  it('never holds sunscreen, even when the protect step names an active group', () => {
    expect(heldSteps(routineOf([step('protect', ['retinoid']), step('treat', ['retinoid'])]), true)).toEqual(['treat'])
    expect(heldSteps(routineOf([step('protect', ['exfoliating-acid'])]), true)).toEqual([])
  })

  it('holds nothing when no step has an active group', () => {
    expect(heldSteps(routineOf([step('cleanse'), step('treat'), step('moisturise'), step('protect')]), true)).toEqual([])
  })

  it('holds nothing when there is no hold, however active the routine is', () => {
    const routine = routineOf([step('cleanse', ['benzoyl-peroxide']), step('treat', ['retinoid']), step('moisturise', ['exfoliating-acid'])])

    expect(heldSteps(routine, false)).toEqual([])
  })

  it('holds nothing for a routine with no steps', () => {
    expect(heldSteps(routineOf([]), true)).toEqual([])
  })

  it('answers the same while a step-down is running: the step-down is not a routine step and carries on', () => {
    const steps = [step('cleanse'), step('treat', ['retinoid']), step('moisturise'), step('protect')]

    expect(heldSteps(routineOf(steps, { stepDownRunning: true }), true)).toEqual(heldSteps(routineOf(steps, { stepDownRunning: false }), true))
    expect(heldSteps(routineOf(steps, { stepDownRunning: true }), true)).toEqual(['treat'])
  })

  it('answers the same before Start, when the routine has no day one', () => {
    expect(heldSteps(routineOf([step('treat', ['retinoid'])], { dayOne: null }), true)).toEqual(['treat'])
  })

  it('leaves the routine it was given as it was', () => {
    const routine = routineOf([step('treat', ['retinoid']), step('protect')])
    const before = structuredClone(routine)

    heldSteps(routine, true)

    expect(routine).toEqual(before)
  })
})
