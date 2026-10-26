import { describe, expect, it } from 'vitest'
import { GOALS } from '../goals/goals.vocabulary'
import type { SkeletonCandidate, SkeletonGap } from './routines.types'
import { FREQUENCY_RANK, maxNewProductsFor, reducedFrequencyFor, ROUTINE_ALLOWED_FREQUENCIES, ROUTINE_RULES_VERSION, routineStepsFor } from './routines.rules'

// The production routine rules (spec #189): the steps a goal uses, the frequencies each step allows and the new-product limit. The eval builds its skeleton
// from the same rules, so what is measured is what ships. Expected values are written out here, not read back from the rules.

const candidate = (code: string): SkeletonCandidate => ({
  code,
  brand: 'Brand',
  name: `Product ${code}`,
  form: 'cream',
  ingredients: ['Aqua', 'Glycerin'],
  skinConcerns: ['hd_moisture'],
  frequency: 'am-pm',
  priceMin: 5,
  priceMax: 10,
  evidenceUrls: [],
  ingredientsSourceUrl: null,
  outcomeHint: null,
})

const gap = (step: SkeletonGap['step'], codes: string[]): SkeletonGap => ({ step, candidates: codes.map(candidate) })

describe('ROUTINE_RULES_VERSION', () => {
  it('is the version a routine records, the string "1" to start with', () => {
    expect(ROUTINE_RULES_VERSION).toBe('1')
  })
})

describe('routineStepsFor', () => {
  it('knows six goals, so the test below covers every one', () => {
    expect(GOALS).toHaveLength(6)
  })

  it.each(GOALS)('gives %s all four steps, in routine order', (goal) => {
    expect(routineStepsFor(goal)).toEqual(['cleanse', 'treat', 'moisturise', 'protect'])
  })

  it('gives a fresh list each time, so a caller changing it cannot change the next routine', () => {
    const first = routineStepsFor(GOALS[0])
    first.pop()

    expect(routineStepsFor(GOALS[0])).toEqual(['cleanse', 'treat', 'moisturise', 'protect'])
  })
})

describe('ROUTINE_ALLOWED_FREQUENCIES', () => {
  it('lists, for each step, the frequencies a routine may use it with, the most usual first', () => {
    expect(ROUTINE_ALLOWED_FREQUENCIES).toEqual({
      cleanse: ['am', 'pm', 'am-pm'],
      treat: ['pm', 'alternate-days', 'weekly', 'am', 'am-pm'],
      moisturise: ['am', 'pm', 'am-pm'],
      protect: ['am'],
    })
  })
})

describe('maxNewProductsFor', () => {
  it('is 0 when there are no gaps', () => {
    expect(maxNewProductsFor([])).toBe(0)
  })

  it('is 0 when no gap has a candidate: every gap is filled with "use what you have"', () => {
    expect(maxNewProductsFor([gap('cleanse', []), gap('treat', []), gap('moisturise', []), gap('protect', [])])).toBe(0)
  })

  it('counts only the gaps that have a candidate', () => {
    expect(maxNewProductsFor([gap('cleanse', ['CLEANSER']), gap('treat', []), gap('moisturise', ['CREAM']), gap('protect', [])])).toBe(2)
  })

  it('counts every gap when each has a candidate', () => {
    expect(maxNewProductsFor([gap('cleanse', ['A']), gap('treat', ['B']), gap('moisturise', ['C']), gap('protect', ['D'])])).toBe(4)
  })

  it('counts a gap once however many candidates it has, because the routine buys one product per gap', () => {
    expect(maxNewProductsFor([gap('cleanse', ['A', 'B', 'C']), gap('treat', [])])).toBe(1)
  })
})

describe('reducedFrequencyFor', () => {
  it('picks the most frequent allowed frequency within the cap', () => {
    expect(reducedFrequencyFor(ROUTINE_ALLOWED_FREQUENCIES.treat, 'alternate-days')).toBe('alternate-days')
    expect(reducedFrequencyFor(ROUTINE_ALLOWED_FREQUENCIES.treat, 'weekly')).toBe('weekly')
    expect(reducedFrequencyFor(ROUTINE_ALLOWED_FREQUENCIES.treat, 'am-pm')).toBe('am-pm')
    // pm comes first in the list but alternate-days is more frequent than weekly, and both are within the cap.
    expect(reducedFrequencyFor(['weekly', 'alternate-days', 'as-needed'], 'am')).toBe('alternate-days')
  })

  it('gives the first in the allowed order when two frequencies tie on rank', () => {
    // am and pm are the same rank: whichever the step lists first wins, in either order.
    expect(reducedFrequencyFor(['am', 'pm', 'am-pm'], 'pm')).toBe('am')
    expect(reducedFrequencyFor(['pm', 'am', 'am-pm'], 'am')).toBe('pm')
  })

  it('is null when every allowed frequency is more often than the cap', () => {
    expect(reducedFrequencyFor(ROUTINE_ALLOWED_FREQUENCIES.cleanse, 'weekly')).toBeNull()
    expect(reducedFrequencyFor(ROUTINE_ALLOWED_FREQUENCIES.cleanse, 'alternate-days')).toBeNull()
    expect(reducedFrequencyFor(ROUTINE_ALLOWED_FREQUENCIES.protect, 'alternate-days')).toBeNull()
  })

  it('is null for nothing allowed', () => {
    expect(reducedFrequencyFor([], 'am-pm')).toBeNull()
  })
})

describe('FREQUENCY_RANK', () => {
  it('ranks how often from least to most, am and pm level', () => {
    expect(FREQUENCY_RANK['as-needed']).toBe(0)
    expect(FREQUENCY_RANK.weekly).toBe(1)
    expect(FREQUENCY_RANK['alternate-days']).toBe(2)
    expect(FREQUENCY_RANK.am).toBe(3)
    expect(FREQUENCY_RANK.pm).toBe(3)
    expect(FREQUENCY_RANK['am-pm']).toBe(4)
  })
})
