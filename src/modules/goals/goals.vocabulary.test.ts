import { describe, expect, it } from 'vitest'
import { TRAITS } from '../catalog/catalog.vocabulary'
import { GOALS } from './goals.vocabulary'

describe('GOALS', () => {
  it('is the five goals Amara can tap, in the order the chips show them', () => {
    expect([...GOALS]).toEqual(['clear-skin', 'even-tone', 'fade-dark-marks', 'brighter', 'glow'])
  })

  it('has a catalog "goal:" trait for every goal, so a product can be tagged with any goal a user can pick', () => {
    for (const goal of GOALS) expect(TRAITS).toContain(`goal:${goal}`)
  })

  it('leaves no catalog "goal:" trait without a goal, so the two lists cannot drift apart', () => {
    const traitGoals = TRAITS.filter((trait) => trait.startsWith('goal:')).map((trait) => trait.slice('goal:'.length))

    expect([...GOALS]).toEqual(traitGoals)
  })
})
