import type { Candidate } from '../recommendations/recommendations.types'
import { concernsForGoal, type ShownConcern } from '../face-scans/face-scans.tables'
import type { Goal } from '../goals/goals.vocabulary'

// DRAFT copy: needs owner review before launch. Every line must pass the wording gate (routines.wording.ts); the viewer test checks them all.
//
// The reasons on the "what to look for" screen are fixed copy, never the AI's: a product works on the concerns of the person's goal that its review lists, said in
// plain seen-words. A concern is never a condition, and a word here is the register of the face scan's own wording.

/** How a concern is said in a reason. */
const CONCERN_WORDS: Record<ShownConcern, string> = {
  hd_acne: 'spots',
  hd_pore: 'open pores',
  hd_oiliness: 'shine',
  hd_age_spot: 'dark marks',
  hd_redness: 'redness',
  hd_radiance: 'dullness',
  hd_texture: 'rough texture',
  hd_dark_circle: 'dark circles',
  hd_moisture: 'dry skin',
}

/** When none of the product's concerns is one of the goal's. It names no concern. */
const GENERIC_WHY = 'A product we have reviewed for this step.'

/** "a", "a and b", "a, b and c". */
const listed = (words: string[]): string => (words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`)

/** Why a product is on the list for this goal: the concerns it works on that the goal has, in the goal's order, or the generic line. */
export const whyFor = (goal: Goal, skinConcerns: readonly ShownConcern[]): string => {
  const works = concernsForGoal(goal).filter((concern) => skinConcerns.includes(concern))
  return works.length === 0 ? GENERIC_WHY : `Works on ${listed(works.map((concern) => CONCERN_WORDS[concern]))}.`
}

/** The most products the screen lists, the routine's pick included. */
export const LOOK_FOR_PRODUCTS = 10

const MOST_COMMON_PLACES = 3

/** Up to three where-sold texts, the most frequent first and a tie in alphabetical order; a candidate with none counts for nothing. */
export const commonlySoldAt = (candidates: readonly Pick<Candidate, 'whereSold'>[]): string[] => {
  const counts = new Map<string, number>()
  for (const { whereSold } of candidates) if (whereSold !== null) counts.set(whereSold, (counts.get(whereSold) ?? 0) + 1)
  return [...counts]
    .sort(([a, countA], [b, countB]) => countB - countA || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, MOST_COMMON_PLACES)
    .map(([place]) => place)
}
