import { describe, expect, it } from 'vitest'
import { GOALS, type Goal } from '../goals/goals.vocabulary'
import { mayScanNow as askPolicy } from './face-scans.policy'

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
  /** The scan spacing, 30 days, from the issue. */
  const SPACING = 30 * DAY
  const on = (offsetMs: number) => new Date(T0.getTime() + offsetMs)
  /**
   * The due rule as the tests below ask it. `lastDayOneAt` is the profile's latest day-one scan under ANY goal (a non-failed scan that is not a
   * check-in), which the service reads; a profile that never took one has null, and that is what every test outside the spacing section means.
   */
  const mayScanNow = (input: Omit<Parameters<typeof askPolicy>[0], 'lastDayOneAt'> & { lastDayOneAt?: Date | null }) => askPolicy({ lastDayOneAt: null, ...input })

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

  // --- the spacing between day ones, under any goal ---
  // Goals can change at any time; the rule limits only paid scans. A NEW chase's first (day-one) scan needs the profile's last day-one scan, under any
  // goal, to be at least 30 days before `at`. Check-ins are not day ones: they do not count towards the 30 days and are not limited by them.

  it('allows the first scan a profile ever takes: there is no earlier day one to space from', () => {
    expect(mayScanNow({ goal: 'glow', history: history(['glow', 0]), scans: [], at: on(0), lastDayOneAt: null })).toEqual({ allowed: true, checkIn: false })
  })

  it('allows a new chase\'s day one exactly 30 days after the profile\'s last day one, under another goal', () => {
    const rows = history(['glow', -SPACING], ['brighter', 0])

    expect(mayScanNow({ goal: 'brighter', history: rows, scans: [], at: on(0), lastDayOneAt: on(-SPACING) })).toEqual({ allowed: true, checkIn: false })
  })

  it('refuses a new chase\'s day one a millisecond short of 30 days, as scan-limit with the moment it opens', () => {
    const rows = history(['glow', -SPACING], ['brighter', 0])

    expect(mayScanNow({ goal: 'brighter', history: rows, scans: [], at: on(0), lastDayOneAt: on(-SPACING + 1) })).toEqual({
      allowed: false,
      reason: 'scan-limit',
      nextScanAt: on(1),
    })
  })

  it('refuses a switch to a new goal inside 30 days of the last day one, and says it opens 30 days after that day one', () => {
    const rows = history(['glow', 0], ['brighter', 10 * DAY])
    expect(mayScanNow({ goal: 'brighter', history: rows, scans: [], at: on(10 * DAY), lastDayOneAt: on(DAY) })).toEqual({
      allowed: false,
      reason: 'scan-limit',
      nextScanAt: on(DAY + SPACING),
    })
  })

  it('allows the same switch once 30 days have passed since the last day one', () => {
    const rows = history(['glow', 0], ['brighter', 10 * DAY])

    expect(mayScanNow({ goal: 'brighter', history: rows, scans: [], at: on(DAY + SPACING), lastDayOneAt: on(DAY) })).toEqual({ allowed: true, checkIn: false })
  })

  it('refuses a fresh day one for a goal whose earlier scan failed while the spacing is not met: a failed scan is nothing to the chase, the last day one still counts', () => {
    const rows = history(['glow', 0], ['brighter', 10 * DAY])
    const scans = [scan('brighter', 11 * DAY, { state: 'failed' })]

    expect(mayScanNow({ goal: 'brighter', history: rows, scans, at: on(12 * DAY), lastDayOneAt: on(DAY) })).toMatchObject({ allowed: false, reason: 'scan-limit' })
  })

  it('keeps naming already-scanned-for-goal when the chase has a scan still being analysed: the spacing is about a NEW chase, not this one', () => {
    const scans = [scan('glow', DAY, { state: 'analysing' })]

    expect(mayScanNow({ goal: 'glow', history: history(['glow', 0]), scans, at: on(2 * DAY), lastDayOneAt: on(DAY) })).toEqual({
      allowed: false,
      reason: 'already-scanned-for-goal',
    })
  })

  it('keeps naming check-in-not-due before the review point, however recent the last day one: the spacing does not touch a chase that has its day one', () => {
    const scans = [scan('glow', DAY)]

    expect(mayScanNow({ goal: 'glow', history: history(['glow', 0]), scans, at: on(2 * DAY), lastDayOneAt: on(DAY) })).toMatchObject({ allowed: false, reason: 'check-in-not-due' })
  })

  // Glow's day one is at day 1, so its review point is day 43. Brighter was taken up at day 40 and its own day one at day 41 is the profile's latest, two
  // days before the check-in. The check-in is not limited by that.
  it('does not limit a check-in at the review point, even when the profile\'s last day one was only days ago under another goal', () => {
    const rows = history(['glow', 0], ['brighter', 40 * DAY], ['glow', 42 * DAY])
    const scans = [scan('glow', DAY), scan('brighter', 41 * DAY)]

    expect(mayScanNow({ goal: 'glow', history: rows, scans, at: on(DAY + REVIEW), lastDayOneAt: on(41 * DAY) })).toEqual({ allowed: true, checkIn: true })
  })

  it('does not count a check-in towards the 30 days: with the last day one 31 days back and a check-in 5 days back, a new chase\'s day one is allowed', () => {
    const rows = history(['glow', -31 * DAY], ['brighter', 0])
    const scans = [scan('glow', -31 * DAY), scan('glow', -5 * DAY, { checkIn: true })]

    // The caller passes the latest NON-check-in scan (`lastDayOneAt`), so the recent check-in is not what spaces this chase.
    expect(mayScanNow({ goal: 'brighter', history: rows, scans, at: on(0), lastDayOneAt: on(-31 * DAY) })).toEqual({ allowed: true, checkIn: false })
  })
})
