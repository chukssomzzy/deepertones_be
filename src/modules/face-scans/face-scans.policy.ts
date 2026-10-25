import type { Goal } from '../goals/goals.vocabulary'
import { SCAN_SPACING_DAYS, chaseStartFor, reviewPointFor } from './face-scans.tables'

export type ScanState = 'analysing' | 'needs-retake' | 'ready' | 'failed'

export type ScanVerdict =
  | { allowed: true; checkIn: boolean }
  | { allowed: false; reason: 'already-scanned-for-goal' | 'check-in-taken' }
  // `due` is the chase's review point, for the service to show as `checkInDueAt`.
  | { allowed: false; reason: 'check-in-not-due'; due: Date }
  // `nextScanAt` is the profile's last day-one scan plus the spacing, for the service to show.
  | { allowed: false; reason: 'scan-limit'; nextScanAt: Date }

/**
 * Whether a profile may start a face scan now (issue #145). Pure: the service reads the profile's goal, its goal history and its scans, and
 * asks. A goal gets ONE scan per chase, plus ONE wider check-in scan once the chase reaches its review point, so switching away and back can
 * never unlock a paid scan.
 *
 * Only scans inside the current chase count (`chaseStartFor`, read from `history`): those stamped at or after the chase start, with no upper
 * bound, so a scan stamped later than `at` (clock skew between isolates, or a rival stored while the caller was reading) still counts. `at` only
 * decides the chase start and whether the review point has been reached. A scan that failed gave the profile nothing, so it never
 * counts: not as the chase's scan, not as its day one, not as its check-in. Day one is the chase's first `ready` scan; the review point is
 * day one plus the goal's review week.
 */
export const mayScanNow = ({
  goal,
  history,
  scans,
  at,
  lastDayOneAt,
}: {
  goal: Goal
  history: readonly { goal: Goal | null; createdAt: Date }[]
  scans: readonly { goalAtScan: Goal; createdAt: Date; state: ScanState; checkIn: boolean }[]
  at: Date
  lastDayOneAt: Date | null
}): ScanVerdict => {
  const chaseStart = chaseStartFor(history, goal, at)
  const chaseScans = chaseStart
    ? scans.filter((scan) => scan.goalAtScan === goal && scan.createdAt.getTime() >= chaseStart.getTime())
    : []
  const notFailed = chaseScans.filter((scan) => scan.state !== 'failed')
  if (notFailed.length === 0) {
    // A new chase's first scan waits SCAN_SPACING_DAYS after the profile's last day-one scan under any goal, so changing goal never unlocks a paid
    // scan. Check-ins are not day ones and neither count towards it nor are limited by it (they take the branches below).
    if (lastDayOneAt) {
      const nextScanAt = new Date(lastDayOneAt.getTime() + SCAN_SPACING_DAYS * 24 * 60 * 60 * 1000)
      if (at.getTime() < nextScanAt.getTime()) return { allowed: false, reason: 'scan-limit', nextScanAt }
    }
    return { allowed: true, checkIn: false }
  }

  const dayOne = notFailed.filter((scan) => scan.state === 'ready').sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0]
  if (!dayOne) return { allowed: false, reason: 'already-scanned-for-goal' }

  if (notFailed.some((scan) => scan.checkIn)) return { allowed: false, reason: 'check-in-taken' }

  const due = reviewPointFor(dayOne.createdAt, goal)
  if (at.getTime() >= due.getTime()) return { allowed: true, checkIn: true }
  return { allowed: false, reason: 'check-in-not-due', due }
}
