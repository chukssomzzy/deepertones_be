/*
 * What a person has checked by hand against the page, for values the eval's judge got wrong: calibration data for the judge, applied when a run is scored
 * (`applyHumanChecks` in draft-score.ts), so a value the judge called contradicted that a person found correct is counted as grounded, and the other way
 * round. It is never an input to the drafter or to any prompt: letting the drafter see which values passed would only teach it the eval.
 *
 * A check is about one value of one case, as it was drafted: `value` is the drafted value (a list joined with "; ", a price row as "min-max"), and a run that
 * drafts something else for that column ignores the check. It applies to whichever set holds the case.
 */
import type { Column } from './draft-score'

export type HumanCheck = {
  caseId: string
  /** A Products column, or `price:<country>` for that country's Availability row. */
  column: Column | `price:${string}`
  /** The drafted value that was checked. */
  value: string
  verdict: 'correct' | 'wrong'
  /** Why, for whoever reads this later. */
  note: string
  checkedOn: string
  by: string
}

export const HUMAN_CHECKS: HumanCheck[] = [
  {
    caseId: 'dang-vitamin-c-oil-free-serum',
    column: 'frequency',
    value: 'am-pm',
    verdict: 'correct',
    note: 'The brand page says to use it morning or night (night recommended for dark spots), so am-pm is right; the judge called it contradicted.',
    checkedOn: '2026-10-22',
    by: 'owner',
  },
  {
    caseId: 'dang-vitamin-c-oil-free-serum',
    column: 'price:NG',
    value: '14900-17700',
    verdict: 'correct',
    note: 'danglifestyle.co shows a promotional 10,700 but 17,700 at checkout, so 14,900 to 17,700 is within the prices the page shows; the judge called it contradicted.',
    checkedOn: '2026-10-22',
    by: 'owner',
  },
]
