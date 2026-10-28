import type { Frequency } from './catalog.vocabulary'

const DAY_MS = 24 * 60 * 60 * 1000
const daysBetween = (from: string, to: string): number => Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / DAY_MS)

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
