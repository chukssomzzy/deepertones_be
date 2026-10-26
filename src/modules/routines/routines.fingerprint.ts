import { sha256Hex } from '../../lib/crypto'
import { stableJson } from '../../lib/stable-json'
import type { RoutineStep } from '../catalog/catalog.vocabulary'
import type { Goal } from '../goals/goals.vocabulary'
import type { CautionState, ShelfVerdict } from './routines.types'

// What a routine's skeleton depends on, as one hash: a change to any input queues a rebuild, no change leaves the routine alone. Every input is picked by name,
// never spread, so nothing else can leak in; a verdict is hashed whole. The face scan's bands are deliberately not an input: a rescan alone must not rebuild a routine.

export type RoutineFingerprintInput = {
  goal: Goal
  cautions: readonly CautionState[]
  /** Each shelf entry the skeleton is built from, with the rules' verdict for it and the step it fills. */
  products: readonly { entryId: string; verdict: ShelfVerdict; step: RoutineStep | null }[]
  rulesVersion: string
}

const byText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

export const routineFingerprint = ({ goal, cautions, products, rulesVersion }: RoutineFingerprintInput): Promise<string> =>
  sha256Hex(
    stableJson({
      rulesVersion,
      goal,
      cautions: [...cautions].sort(byText),
      products: products.map(({ entryId, verdict, step }) => ({ entryId, verdict, step })).sort((a, b) => byText(a.entryId, b.entryId)),
    }),
  )
