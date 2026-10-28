import type { Frequency } from './catalog.vocabulary'

const DAY_MS = 24 * 60 * 60 * 1000
/** The whole days from `from` to `to`, both calendar days as 'YYYY-MM-DD' (negative when `to` is earlier). */
export const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS)

/**
 * Whether an entry of this frequency is due in the evening on the local calendar day `day`, counting its days from `anchor` (the first day of the count, due itself for an
 * every-other-day or weekly entry): day 1 of the routine, or the day a rung began for an entry being brought back. `pm` and `am-pm` are due every day; `am` and `as-needed` never.
 */
export const dueOnDay = (frequency: Frequency, anchor: string, day: string): boolean => {
  const since = daysBetween(anchor, day)
  switch (frequency) {
    case 'pm':
    case 'am-pm':
      return true
    case 'alternate-days':
      return since % 2 === 0
    case 'weekly':
      return since % 7 === 0
    case 'am':
    case 'as-needed':
      return false
  }
}
