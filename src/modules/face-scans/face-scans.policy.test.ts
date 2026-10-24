import { describe, expect, it } from 'vitest'
import { GOALS, type Goal } from '../goals/goals.vocabulary'
import { mayScanNow } from './face-scans.policy'

// Whether a profile may start a face scan now (issue #145). Pure: the service reads the profile's goal, its goal history and its scans under that
// goal, and asks. A goal gets ONE scan per chase, plus ONE wider check-in scan once the chase reaches its review point, so switching away and
// back can never unlock a paid scan.
//
// - A chase is a continuous run of working on one goal, read from the goal history: leaving it and coming back within 90 days continues the
//   same chase, a longer gap starts a new one. Only the scans inside the current chase count.
// - A scan that FAILED gave the profile nothing, so it never counts: not as the chase's scan, not as its day one, not as its check-in.
// - Day one is the chase's first READY scan. The review point is day one plus six weeks.
//
// Every number and every expectation below is a literal written from the issue, never read from the module.
describe('mayScanNow', () => {
  const T0 = new Date('2030-06-15T12:00:00.000Z')
  const DAY = 24 * 60 * 60 * 1000
  /** The resume window, 90 days, from the issue. */
  const WINDOW = 90 * DAY
  /** The review point, six weeks after day one, from the issue. */
  const REVIEW = 42 * DAY
  const on = (offsetMs: number) => new Date(T0.getTime() + offsetMs)

  type Scan = { goalAtScan: Goal; createdAt: Date; state: 'analysing' | 'needs-retake' | 'ready' | 'failed'; checkIn: boolean }
  /** The profile's goal history, oldest first: each row is the goal that became current at that offset from T0. */
  const history = (...rows: [Goal | null, number][]) => rows.map(([goal, offset]) => ({ goal, createdAt: on(offset) }))
  /** A scan of the profile under `goal`, taken at that offset. Ready and not a check-in unless a test says otherwise. */
  const scan = (goal: Goal, offset: number, over: Partial<Pick<Scan, 'state' | 'checkIn'>> = {}): Scan => ({
    goalAtScan: goal,
    createdAt: on(offset),
    state: 'ready',
    checkIn: false,
    ...over,
  })

  // --- the one scan a chase is due ---

  it('allows the first scan of a goal: a profile that has never scanned under it', () => {
    expect(mayScanNow({ goal: 'glow', history: history(['glow', 0]), scans: [], at: on(0) })).toEqual({ allowed: true, checkIn: false })
  })

  it('allows a scan again when the chase\'s only scan failed: a failed scan gave the profile nothing to look at', () => {
    const scans = [scan('glow', DAY, { state: 'failed' })]

    expect(mayScanNow({ goal: 'glow', history: history(['glow', 0]), scans, at: on(2 * DAY) })).toEqual({ allowed: true, checkIn: false })
  })

  it('refuses a second scan while the chase\'s scan is still being analysed, and says why', () => {
    const scans = [scan('glow', DAY, { state: 'analysing' })]

    expect(mayScanNow({ goal: 'glow', history: history(['glow', 0]), scans, at: on(2 * DAY) })).toEqual({ allowed: false, reason: 'already-scanned-for-goal' })
  })

  it('refuses a second scan while the chase\'s scan is waiting for a retake: the retake is on that scan, not a new one', () => {
    const scans = [scan('glow', DAY, { state: 'needs-retake' })]

    expect(mayScanNow({ goal: 'glow', history: history(['glow', 0]), scans, at: on(2 * DAY) })).toEqual({ allowed: false, reason: 'already-scanned-for-goal' })
  })

  it.each([...GOALS])('gives %s the same one scan per chase: the first is allowed and the next is refused', (goal) => {
    expect(mayScanNow({ goal, history: history([goal, 0]), scans: [], at: on(0) })).toEqual({ allowed: true, checkIn: false })
    expect(mayScanNow({ goal, history: history([goal, 0]), scans: [scan(goal, DAY, { state: 'analysing' })], at: on(2 * DAY) })).toEqual({
      allowed: false,
      reason: 'already-scanned-for-goal',
    })
  })

  // --- the check-in at the review point ---

  it('allows the check-in exactly at the review point, six weeks after day one', () => {
    const scans = [scan('glow', DAY)]

    expect(mayScanNow({ goal: 'glow', history: history(['glow', 0]), scans, at: on(DAY + REVIEW) })).toEqual({ allowed: true, checkIn: true })
  })

  it('refuses a scan a millisecond before the review point, and says the check-in is not due', () => {
    const scans = [scan('glow', DAY)]

    expect(mayScanNow({ goal: 'glow', history: history(['glow', 0]), scans, at: on(DAY + REVIEW - 1) })).toMatchObject({ allowed: false, reason: 'check-in-not-due' })
  })

  it('still allows the check-in long after the review point: nothing closes the window', () => {
    const scans = [scan('glow', DAY)]

    expect(mayScanNow({ goal: 'glow', history: history(['glow', 0]), scans, at: on(DAY + 5 * REVIEW) })).toEqual({ allowed: true, checkIn: true })
  })

  // The clock starts at the chase's first READY scan: a scan that failed is not a day one, so it does not bring the review point forward or push it back.
  it('measures the review point from the chase\'s day one, not from the latest scan it holds', () => {
    const scans = [scan('glow', DAY), scan('glow', 30 * DAY, { state: 'failed' })]

    expect(mayScanNow({ goal: 'glow', history: history(['glow', 0]), scans, at: on(DAY + REVIEW) })).toEqual({ allowed: true, checkIn: true })
    expect(mayScanNow({ goal: 'glow', history: history(['glow', 0]), scans, at: on(DAY + REVIEW - 1) })).toMatchObject({ allowed: false, reason: 'check-in-not-due' })
  })

  it.each(['analysing', 'needs-retake', 'ready'] as const)('counts a check-in that is %s as taken, so the chase is never charged for two wide scans', (state) => {
    const scans = [scan('glow', DAY), scan('glow', DAY + REVIEW, { state, checkIn: true })]

    expect(mayScanNow({ goal: 'glow', history: history(['glow', 0]), scans, at: on(DAY + REVIEW + DAY) })).toEqual({ allowed: false, reason: 'check-in-taken' })
  })

  it('refuses the check-in as taken however long after the review point it is asked for', () => {
    const scans = [scan('glow', DAY), scan('glow', DAY + REVIEW, { checkIn: true })]

    expect(mayScanNow({ goal: 'glow', history: history(['glow', 0]), scans, at: on(200 * DAY) })).toEqual({ allowed: false, reason: 'check-in-taken' })
  })

  it('does not count a check-in that failed: the user may take their check-in again', () => {
    const scans = [scan('glow', DAY), scan('glow', DAY + REVIEW, { state: 'failed', checkIn: true })]

    expect(mayScanNow({ goal: 'glow', history: history(['glow', 0]), scans, at: on(DAY + REVIEW + DAY) })).toEqual({ allowed: true, checkIn: true })
  })

  // --- only the current chase counts ---

  it('does not make a scan due just because the user switched back inside the window: the chase already had its scan', () => {
    const rows = history(['glow', 0], ['brighter', 10 * DAY], ['glow', 20 * DAY])
    const scans = [scan('glow', DAY)]

    expect(mayScanNow({ goal: 'glow', history: rows, scans, at: on(20 * DAY) })).toMatchObject({ allowed: false, reason: 'check-in-not-due' })
  })

  it('does not make a scan due on a switch back while the chase\'s scan is still being analysed either', () => {
    const rows = history(['glow', 0], ['brighter', 10 * DAY], ['glow', 20 * DAY])
    const scans = [scan('glow', DAY, { state: 'analysing' })]

    expect(mayScanNow({ goal: 'glow', history: rows, scans, at: on(20 * DAY) })).toEqual({ allowed: false, reason: 'already-scanned-for-goal' })
  })

  // 90 days is the last moment of the resume window, so the chase and its day one survive; a millisecond more starts a fresh chase, which is due
  // a day one of its own and so a plain scan, not a check-in.
  it('keeps the chase for a return exactly 90 days after leaving, so what is due is still the check-in', () => {
    const rows = history(['glow', 0], ['brighter', 10 * DAY], ['glow', 10 * DAY + WINDOW])
    const scans = [scan('glow', DAY)]

    expect(mayScanNow({ goal: 'glow', history: rows, scans, at: on(10 * DAY + WINDOW) })).toEqual({ allowed: true, checkIn: true })
  })

  it('starts the goal fresh for a return a millisecond after the window closes, so a plain scan is due again', () => {
    const back = 10 * DAY + WINDOW + 1
    const rows = history(['glow', 0], ['brighter', 10 * DAY], ['glow', back])
    const scans = [scan('glow', DAY)]

    expect(mayScanNow({ goal: 'glow', history: rows, scans, at: on(back) })).toEqual({ allowed: true, checkIn: false })
  })

  it('leaves a chase whose check-in was taken with nothing due, and gives the fresh chase after the window a plain scan', () => {
    const back = 10 * DAY + WINDOW + 1
    const scans = [scan('glow', DAY), scan('glow', DAY + REVIEW, { checkIn: true })]

    expect(mayScanNow({ goal: 'glow', history: history(['glow', 0], ['brighter', 10 * DAY], ['glow', 10 * DAY + WINDOW]), scans, at: on(10 * DAY + WINDOW) })).toEqual({
      allowed: false,
      reason: 'check-in-taken',
    })
    expect(mayScanNow({ goal: 'glow', history: history(['glow', 0], ['brighter', 10 * DAY], ['glow', back]), scans, at: on(back) })).toEqual({ allowed: true, checkIn: false })
  })

  it('does not inherit the review point of the chase before: a fresh chase is due its own day one, not a check-in', () => {
    const back = 10 * DAY + WINDOW + 1
    const rows = history(['glow', 0], ['brighter', 10 * DAY], ['glow', back])
    const scans = [scan('glow', DAY)]

    // The old day one's review point passed long ago, and still what is due is a plain scan.
    expect(mayScanNow({ goal: 'glow', history: rows, scans, at: on(back + 10 * DAY) })).toEqual({ allowed: true, checkIn: false })
  })

  it('counts no scan taken under another goal: a scan under brighter is not glow\'s', () => {
    const rows = history(['brighter', 0], ['glow', 10 * DAY])

    expect(mayScanNow({ goal: 'glow', history: rows, scans: [scan('brighter', DAY)], at: on(10 * DAY) })).toEqual({ allowed: true, checkIn: false })
  })

  // Brighter is taken up first and gets its own day one and, six weeks on, its own check-in; glow is taken up ten days in, left and resumed, and
  // reaches its own review point later. Brighter's check-in is nothing to do with glow's.
  it('counts no check-in taken under another goal: each goal has its own review point', () => {
    const rows = history(['brighter', 0], ['glow', 10 * DAY], ['brighter', 20 * DAY], ['glow', 50 * DAY])
    const scans = [scan('brighter', DAY), scan('glow', 11 * DAY), scan('brighter', DAY + REVIEW + DAY, { checkIn: true })]

    expect(mayScanNow({ goal: 'glow', history: rows, scans, at: on(11 * DAY + REVIEW) })).toEqual({ allowed: true, checkIn: true })
  })

  // Requests race, and clocks differ a little: a scan stamped after this one's `at` is still a scan of the chase. The rule counts from the chase
  // start onward, with no upper bound.
  it('counts a scan stamped after `at`: a second scan is refused as already scanned for the goal', () => {
    const scans = [scan('glow', 1, { state: 'analysing' })]

    expect(mayScanNow({ goal: 'glow', history: history(['glow', 0]), scans, at: on(0) })).toEqual({ allowed: false, reason: 'already-scanned-for-goal' })
  })

  it('counts a check-in stamped after `at`: a second check-in is refused as taken', () => {
    const scans = [scan('glow', 0), scan('glow', REVIEW + 1, { checkIn: true, state: 'analysing' })]

    expect(mayScanNow({ goal: 'glow', history: history(['glow', 0]), scans, at: on(REVIEW) })).toEqual({ allowed: false, reason: 'check-in-taken' })
  })
})
