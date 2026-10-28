import { describe, expect, it } from 'vitest'
import { FREQUENCIES, type Frequency } from './catalog.vocabulary'
import { dueOnDay } from './catalog.frequency'

// Whether an entry of a given frequency is due on a given local day, counted from an anchor day (spec #233, PR 4a). It moved out of the reminder send job (which counted from
// day 1 alone) into a pure file the reminders module and the routines module can both import. The anchor is the day the count starts: day 1 of the routine, or, for a product
// that is being brought back after a pause, the day the rung began.
//
// THE SIGNATURE ASSUMED (the brief names the function and the file's purpose, not its name or place):
//   dueOnDay(frequency: Frequency, anchor: 'YYYY-MM-DD', day: 'YYYY-MM-DD'): boolean       in src/modules/catalog/catalog.frequency.ts (a module both can import without a cycle)
// The anchor day itself is the first day of a count (0 days on), and the evening lists use it for pm, am-pm, alternate-days and weekly entries only.

// One anchor: every day below is an offset from it. It is in June so that a count over a month's end is in the tests.
const ANCHOR_DAY = Date.UTC(2030, 5, 29)
const DAY = 24 * 60 * 60 * 1000
const dayAt = (offset: number) => new Date(ANCHOR_DAY + offset * DAY).toISOString().slice(0, 10)
const ANCHOR = dayAt(0)

describe('dueOnDay: every other day, counted from the anchor', () => {
  it.each([
    [0, true],
    [1, false],
    [2, true],
    [3, false],
    [4, true],
    [5, false],
    [6, true],
    [7, false],
    [20, true],
    [21, false],
  ])('is due %i days after the anchor: %s', (offset, due) => {
    expect(dueOnDay('alternate-days', ANCHOR, dayAt(offset))).toBe(due)
  })

  it('counts calendar days across the end of a month and a year, not days of the month', () => {
    const lastOfJune = '2030-06-30'
    const firstOfJuly = '2030-07-01'
    expect(dueOnDay('alternate-days', lastOfJune, firstOfJuly)).toBe(false)
    expect(dueOnDay('alternate-days', ANCHOR, firstOfJuly)).toBe(true)
    expect(dueOnDay('alternate-days', '2030-12-31', '2031-01-02')).toBe(true)
    expect(dueOnDay('alternate-days', '2030-12-31', '2031-01-01')).toBe(false)
  })

  it('starts the count again from another anchor: the same day is due from one and not from the next', () => {
    expect(dueOnDay('alternate-days', dayAt(0), dayAt(4))).toBe(true)
    expect(dueOnDay('alternate-days', dayAt(1), dayAt(4))).toBe(false)
    expect(dueOnDay('alternate-days', dayAt(3), dayAt(4))).toBe(false)
    expect(dueOnDay('alternate-days', dayAt(2), dayAt(4))).toBe(true)
  })
})

describe('dueOnDay: weekly, counted from the anchor', () => {
  it.each([
    [0, true],
    [1, false],
    [6, false],
    [7, true],
    [8, false],
    [13, false],
    [14, true],
    [21, true],
  ])('is due %i days after the anchor: %s', (offset, due) => {
    expect(dueOnDay('weekly', ANCHOR, dayAt(offset))).toBe(due)
  })
})

describe('dueOnDay: the frequencies that do not depend on the anchor', () => {
  it.each(['pm', 'am-pm'] as const)('is due every day for %s', (frequency) => {
    for (const offset of [0, 1, 2, 3, 7, 30]) expect(dueOnDay(frequency, ANCHOR, dayAt(offset))).toBe(true)
  })

  it.each(['am', 'as-needed'] as const)('is never due in the evening for %s', (frequency) => {
    for (const offset of [0, 1, 2, 3, 7, 30]) expect(dueOnDay(frequency, ANCHOR, dayAt(offset))).toBe(false)
  })

  it('answers for every frequency the catalog has', () => {
    const due = (frequency: Frequency) => dueOnDay(frequency, ANCHOR, dayAt(0))

    // On the anchor day itself: the evening frequencies are due, the morning-only and as-needed ones never.
    expect(FREQUENCIES.filter(due)).toEqual(['pm', 'am-pm', 'alternate-days', 'weekly'])
  })
})
