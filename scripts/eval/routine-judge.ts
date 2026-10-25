/*
 * The rubric judge of `npm run eval:routine`: one Claude call per routine that was written. It is shown the skeleton (the person, the shelf with its verdicts, each
 * gap's candidates) and the routine, and never the labels. It answers with its own class for the product picked in each gap, three 1 to 5 scores and problem
 * codes from a fixed list. judgeResultOf then sets its classes against the labels'. It lives with the eval, not in src/providers, because nothing in the product asks it anything.
 */
import { z } from 'zod'
import { ROUTINE_STEPS } from '../../src/modules/catalog/catalog.vocabulary'
import type { Routine, RoutineProduct, RoutineSkeleton } from '../../src/modules/routines/routines.types'
import { routineJudgeJudgeRoutinePrompt } from '../../src/prompts/prompts.generated'
import type { AnthropicClient } from '../../src/providers/anthropic/anthropic.client'
import { AnthropicRequestError } from '../../src/providers/anthropic/anthropic.provider'
import type { GapLabel } from './routine-labels'
import { type JudgeResult, type RoutineCaseInput, scoredGapsOf } from './routine-score'

/** What the judge may say is wrong with a routine: fixed codes, never free text, so a report can be counted and the console can print nothing of a model's. */
export const PROBLEM_CODES = [
  'ignored-caution',
  'leaned-on-low-confidence',
  'also-noticed-justified-product',
  'poor-fit',
  'too-many-actives',
  'harsh-during-taper',
  'vague-reason',
  'overstated-claim',
  'timing-dishonest',
  'unexplained-term',
] as const

export const PICK_CLASSES = ['best', 'acceptable', 'not'] as const
export type PickClass = (typeof PICK_CLASSES)[number]

// The scores are whole numbers from 1 to 5, written as literals: structured outputs do not support the minimum and maximum a bounded integer would send.
const ScoreSchema = z.literal([1, 2, 3, 4, 5])

// Closed in the schema sent (zod emits additionalProperties false), and an extra field the model wrote anyway is dropped by the parse, so its text goes no further. A missing or off-schema field is a throw: a judgement is never partial.
const JudgementSchema = z.object({
  picks: z.array(z.object({ step: z.enum(ROUTINE_STEPS), pickClass: z.enum(PICK_CLASSES) })),
  fit: ScoreSchema,
  simplicity: ScoreSchema,
  words: ScoreSchema,
  problems: z.array(z.enum(PROBLEM_CODES)),
})
// The scores are 1 to 5 in the schema (the parse holds the model to it), and plain numbers in the type, so a judgement can be built and averaged without literal types.
export type RoutineJudgement = Omit<z.infer<typeof JudgementSchema>, 'fit' | 'simplicity' | 'words'> & { fit: number; simplicity: number; words: number }

export type RoutineJudgeInput = { skeleton: RoutineSkeleton; routine: Routine }

export interface RoutineJudge {
  /** Throws the client's errors (a refusal, a cut-off or unreadable answer, an unavailable model, AiBudgetExceededError, AnthropicConfigError); the run decides what each means. Never returns a partial judgement. */
  judge(input: RoutineJudgeInput): Promise<RoutineJudgement>
}

/** Judges a written routine with Claude. It has no tools and no labels: it sees only what the writer saw and what the writer wrote. */
export class AnthropicRoutineJudge implements RoutineJudge {
  // Room for the answer and for the model's thinking, which counts against max_tokens.
  private static readonly MAX_TOKENS = 4096
  private static readonly LEAD_IN = 'Judge this routine:'

  private readonly client: AnthropicClient

  constructor(client: AnthropicClient) {
    this.client = client
  }

  async judge({ skeleton, routine }: RoutineJudgeInput): Promise<RoutineJudgement> {
    return this.client.structured(
      {
        max_tokens: AnthropicRoutineJudge.MAX_TOKENS,
        system: routineJudgeJudgeRoutinePrompt.text,
        messages: [{ role: 'user', content: [{ type: 'text', text: `${AnthropicRoutineJudge.LEAD_IN}\n${JSON.stringify({ skeleton, routine })}` }] }],
      },
      JudgementSchema,
      { job: routineJudgeJudgeRoutinePrompt.job },
    )
  }
}

/**
 * Asks the judge, and once more with the same input when its answer was invalid (an AnthropicRequestError: off-schema JSON, not JSON, or out of tokens), because a
 * case with a routine and no judgement blocks the bar. Any other error is thrown at once, and so is whatever the retry fails with, as it is. `onRetry` is called
 * just before the second call, so a caller can record the retry even when it fails too.
 */
export const judgeOnce = async (judge: RoutineJudge, input: RoutineJudgeInput, onRetry?: () => void): Promise<{ judgement: RoutineJudgement; retried: boolean }> => {
  try {
    return { judgement: await judge.judge(input), retried: false }
  } catch (error) {
    if (!(error instanceof AnthropicRequestError)) throw error
    onRetry?.()
    return { judgement: await judge.judge(input), retried: true }
  }
}

// --- agreement ---------------------------------------------------------------------------------------------------------------------------------

/** The class the labels give a routine's pick: best, acceptable, or not (which is also what a pick that is no candidate of the gap, a shelf product or "use what you have" is). */
export const classOfPick = (label: GapLabel, product: RoutineProduct): PickClass => {
  if (product.kind !== 'candidate') return 'not'
  if (product.code === label.best) return 'best'
  return label.acceptable.includes(product.code) ? 'acceptable' : 'not'
}

/**
 * The judge's judgement as the score takes it. A pick is judged on each scored gap (the scorer's own rule: labelled, 2 or more candidates, labels current), and
 * agreed when the judge's class and the label's class for the pick are on the same side (best and acceptable are right, not is not), and agreed exactly when they are the
 * same class. The line between best and acceptable is unstable even between two labelling passes, and the writer's own score counts both as right. A scored gap the judge gave no class for is judged and not agreed, so leaving a gap out
 * cannot raise the agreement. Without labels nothing is judged, but the three scores still count.
 */
export const judgeResultOf = (judgement: RoutineJudgement, { routine, gapCodes, labels }: { routine: Routine; gapCodes: RoutineCaseInput['gapCodes']; labels: RoutineCaseInput['labels'] }): JudgeResult => {
  const scored = scoredGapsOf({ gapCodes, labels })
  let picksAgreed = 0
  let picksAgreedExactly = 0
  for (const [step, label] of scored) {
    const product = routine.steps.find((entry) => entry.step === step)?.product ?? { kind: 'none' as const }
    const judged = judgement.picks.find((pick) => pick.step === step)?.pickClass
    if (judged === undefined) continue
    const labelled = classOfPick(label, product)
    if (judged === labelled) picksAgreedExactly++
    if ((judged === 'not') === (labelled === 'not')) picksAgreed++
  }
  return { picksAgreed, picksAgreedExactly, picksJudged: scored.length, fit: judgement.fit, simplicity: judgement.simplicity, words: judgement.words }
}
