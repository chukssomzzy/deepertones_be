import { describe, expect, it } from 'vitest'
import { dueReminders } from './reminders.slot'

// The one place that says which reminder times fall in a 15-minute slot: the cron's pre-filter and the consumer's send both call it, so they cannot disagree.
// reminders.sends.service.test.ts pins the window at length through the send; here the function on its own.
const MIDNIGHT = Date.UTC(2030, 5, 15)
const at = (hour: number, minute = 0) => new Date(MIDNIGHT + (hour * 60 + minute) * 60 * 1000)
const CLOCK = { morning: '07:00', evening: '21:00', timeZone: null as string | null }

describe('dueReminders', () => {
  it('answers the times whose local time was reached in the 15 minutes up to the slot, with their local day', () => {
    expect(dueReminders(CLOCK, at(7))).toEqual([{ time: 'morning', day: '2030-06-15' }])
    expect(dueReminders(CLOCK, at(21, 14))).toEqual([{ time: 'evening', day: '2030-06-15' }])
    expect(dueReminders(CLOCK, at(7, 15))).toEqual([])
    expect(dueReminders(CLOCK, at(6, 59))).toEqual([])
  })

  it('reads a time in the stored zone, and in UTC with none', () => {
    expect(dueReminders({ ...CLOCK, timeZone: 'Africa/Lagos' }, at(6))).toEqual([{ time: 'morning', day: '2030-06-15' }])
    expect(dueReminders({ ...CLOCK, timeZone: 'Africa/Lagos' }, at(7))).toEqual([])
    expect(dueReminders({ ...CLOCK, timeZone: 'America/New_York' }, at(11))).toEqual([{ time: 'morning', day: '2030-06-15' }])
  })

  it('answers both times when both fall in the slot, morning first', () => {
    expect(dueReminders({ morning: '06:10', evening: '06:15', timeZone: null }, at(6, 15))).toEqual([
      { time: 'morning', day: '2030-06-15' },
      { time: 'evening', day: '2030-06-15' },
    ])
  })

  it('keeps a time just before midnight on the day it belongs to', () => {
    expect(dueReminders({ morning: '23:55', evening: '21:00', timeZone: null }, new Date(MIDNIGHT + 5 * 60 * 1000))).toEqual([{ time: 'morning', day: '2030-06-14' }])
  })

  it('throws a RangeError for a zone that is not one', () => {
    expect(() => dueReminders({ ...CLOCK, timeZone: 'Not/AZone' }, at(7))).toThrow(RangeError)
  })

  it('gives the same answer with a shared reading cache as without', () => {
    const walls = new Map()

    expect(dueReminders(CLOCK, at(7), walls)).toEqual(dueReminders(CLOCK, at(7)))
    expect(dueReminders({ ...CLOCK, morning: '08:00' }, at(7), walls)).toEqual([])
  })
})
