import { describe, expect, it } from 'vitest'
import { GOAL_ANSWERS_VERSION, answerFor } from './goals.answers'
import { GOALS, type Goal } from './goals.vocabulary'

// The copy is a DRAFT that will change before launch, so no test pins a sentence. They pin the shape and the rules the product
// never breaks (CONTEXT.md): plain, gender-neutral, no diagnosing, and no promise to lighten.
const FIELDS = ['title', 'howLong', 'helps', 'inTheWay'] as const

const GENDERED = /\b(she|her|he|his|women|men|ladies|girl)\b/i
// Word-start matches, so "fairer" and "cured" are caught but "secure" and "affair" are not.
const FORBIDDEN = [/diagnos/i, /\bcure/i, /\bfair/i, /whiten/i, /bleach/i]

const textOf = (goal: Goal, wantsLighter: boolean) => {
  const answer = answerFor(goal, wantsLighter)
  return [answer.title, answer.howLong, answer.helps, answer.inTheWay, answer.note ?? ''].join('\n')
}

describe('GOAL_ANSWERS_VERSION', () => {
  it('is a positive whole number, so a client can compare versions', () => {
    expect(Number.isInteger(GOAL_ANSWERS_VERSION)).toBe(true)
    expect(GOAL_ANSWERS_VERSION).toBeGreaterThan(0)
  })

  // Bump it deliberately, in the same change as any copy edit that alters what an answer means. This test is the reminder.
  it('is exactly 1 until a copy change that alters meaning bumps it', () => {
    expect(GOAL_ANSWERS_VERSION).toBe(1)
  })
})

describe('answerFor', () => {
  it('gives each goal its own title, so every chip leads to a different answer', () => {
    const titles = new Set(GOALS.map((goal: Goal) => answerFor(goal, false).title))

    expect(titles.size).toBe(GOALS.length)
  })

  it.each(GOALS.map((goal: Goal): [Goal] => [goal]))('gives %s a title, how long it takes, what helps and what gets in the way', (goal: Goal) => {
    const answer = answerFor(goal, false)

    for (const field of FIELDS) {
      expect(typeof answer[field]).toBe('string')
      expect(answer[field].trim().length).toBeGreaterThan(0)
    }
  })

  it.each(GOALS.map((goal: Goal): [Goal] => [goal]))('gives %s no note for someone who did not ask to be lighter', (goal: Goal) => {
    expect(answerFor(goal, false).note).toBeNull()
  })

  it('gives the plain brighter chip no colour note, since Tolu never asked about colour', () => {
    expect(answerFor('brighter', false).note).toBeNull()
  })

  it.each(GOALS.map((goal: Goal): [Goal] => [goal]))('gives %s a note about natural colour to someone who asked to be lighter', (goal: Goal) => {
    const { note } = answerFor(goal, true)

    expect(note).not.toBeNull()
    expect(note).toMatch(/natural colou?r/i)
  })

  it('says the same colour note whichever goal the person who asked to be lighter was sorted into', () => {
    const notes = new Set(GOALS.map((goal: Goal) => answerFor(goal, true).note))

    expect(notes.size).toBe(1)
  })

  it.each(GOALS.map((goal: Goal): [Goal] => [goal]))('keeps the plan for %s the same whether or not the colour note is added', (goal: Goal) => {
    const { note: _plain, ...plain } = answerFor(goal, false)
    const { note: _lighter, ...lighter } = answerFor(goal, true)

    expect(lighter).toEqual(plain)
  })

  it.each(GOALS.flatMap((goal: Goal): [Goal, boolean][] => [[goal, false], [goal, true]]))('keeps %s (wants lighter: %s) free of gendered words, so Chidi feels the app is for him too', (goal: Goal, wantsLighter: boolean) => {
    expect(textOf(goal, wantsLighter)).not.toMatch(GENDERED)
  })

  it.each(GOALS.flatMap((goal: Goal): [Goal, boolean][] => [[goal, false], [goal, true]]))('keeps %s (wants lighter: %s) free of diagnosing, curing and any promise or name for lightening', (goal: Goal, wantsLighter: boolean) => {
    for (const forbidden of FORBIDDEN) expect(textOf(goal, wantsLighter)).not.toMatch(forbidden)
  })

  it.each(GOALS.flatMap((goal: Goal): [Goal, boolean][] => [[goal, false], [goal, true]]))('never tells the user of %s (wants lighter: %s) to slow down or push through when something stings or burns', (goal: Goal, wantsLighter: boolean) => {
    expect(textOf(goal, wantsLighter)).not.toMatch(/slow down|push through/i)
  })

  it.each(GOALS.flatMap((goal: Goal): [Goal, boolean][] => [[goal, false], [goal, true]]))('never says in %s (wants lighter: %s) that stopping and starting a product keeps skin unsettled', (goal: Goal, wantsLighter: boolean) => {
    expect(textOf(goal, wantsLighter)).not.toMatch(/stopping and starting/i)
  })
})

// calm-repair is for skin made reactive by a lightening, bleaching, toning or steroid cream (CONTEXT.md, the primary user). Stopping such a
// cream suddenly causes a rebound, which is what sent Amara back to it, so the product plans a dated step-down and says up front that a
// flare can happen. Its copy must never tell her to simply stop.
describe('answerFor calm-repair', () => {
  const text = () => textOf('calm-repair', false)

  it('is called "Calm, healthy skin again"', () => {
    expect(answerFor('calm-repair', false).title).toBe('Calm, healthy skin again')
  })

  it('never tells the user to stop a product outright, because stopping a steroid or lightening cream suddenly causes a rebound', () => {
    expect(text().trim()).not.toBe('')
    expect(text()).not.toMatch(/\bstop (using|it|them)\b/i)
  })

  it('mentions a step-down, a taper or going step by step', () => {
    expect(text()).toMatch(/step[- ]down|taper|step by step/i)
  })

  it('says a flare, or skin getting worse before it gets better, can be expected', () => {
    expect(text()).toMatch(/flare|worse before/i)
  })
})
