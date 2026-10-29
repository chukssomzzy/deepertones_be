import type { ReminderSettings } from './reminders.types'

/** What decides when a profile is reminded: its two times ('HH:MM', local) and its zone (an IANA name, UTC while none is stored). */
export type ReminderClock = Pick<ReminderSettings, 'morning' | 'evening' | 'timeZone'>

/** The times a profile with no settings row, or with reminders off, is counted by (its inbox lines are written at these times, though it is sent no push). */
export const DEFAULT_TIMES = { morning: '07:00', evening: '21:00' }

export type DueReminder = { time: 'morning' | 'evening'; day: string }

/** A wall-clock reading as 'YYYY-MM-DDTHH:MM', which sorts as text. */
type Wall = string

/** Both ends of a slot's window read on one zone's wall clock; callers working through many profiles keep one per zone, so a zone is read once per run. */
export type SlotReadings = Map<string, { now: Wall; before: Wall }>

const WINDOW_MS = 15 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const formatters = new Map<string, Intl.DateTimeFormat>()

/**
 * Which of the profile's reminder times were reached in the 15 minutes up to and including `slot`, in its own zone, with the local day each belongs to. The one definition of "due"
 * that the cron (which queues only profiles with something due) and the send (which sends it) share, so they cannot disagree about a slot.
 *
 * A time is due when `slot` is in [time, time + 15 minutes) of the profile's local time (so the slot is the END of the quarter hour it looks back over): a time the clocks skip is due at the first instant after the gap, and one that
 * happens twice is due once (the second pass is refused by the send's claim). Throws a RangeError for a zone Intl does not know.
 */
export const dueReminders = (clock: ReminderClock, slot: Date, readings: SlotReadings = new Map()): DueReminder[] => {
  const zone = clock.timeZone ?? 'UTC'
  let reading = readings.get(zone)
  if (!reading) {
    reading = { now: wallOf(slot, zone), before: wallOf(new Date(slot.getTime() - WINDOW_MS), zone) }
    readings.set(zone, reading)
  }
  return (['morning', 'evening'] as const).flatMap((time) => {
    const day = dueDay(reading, clock[time])
    return day === null ? [] : [{ time, day }]
  })
}

/** The calendar day before `day` ('YYYY-MM-DD'). */
export const dayBefore = (day: string): string => new Date(Date.parse(`${day}T00:00:00.000Z`) - DAY_MS).toISOString().slice(0, 10)

/** The calendar day after `day` ('YYYY-MM-DD'). */
export const dayAfter = (day: string): string => new Date(Date.parse(`${day}T00:00:00.000Z`) + DAY_MS).toISOString().slice(0, 10)

/**
 * The local day whose `time` ('HH:MM') was reached within the last 15 minutes, or null. The wall clock is compared on both ends of the window, so a time the clocks skip
 * is caught by the first reading past it, and one just before midnight is still due on the day it belongs to.
 */
const dueDay = (reading: { now: Wall; before: Wall }, time: string): string | null => {
  const today = reading.now.slice(0, 10)
  for (const day of [today, dayBefore(today)]) {
    const target = `${day}T${time}`
    if (reading.now >= target && reading.before < target) return day
  }
  return null
}

/** The wall clock in `zone` at `at`, to the minute. Throws a RangeError for a zone Intl does not know. */
const wallOf = (at: Date, zone: string): Wall => {
  let formatter = formatters.get(zone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    formatters.set(zone, formatter)
  }
  const parts = formatter.formatToParts(at)
  const part = (type: string) => parts.find((p) => p.type === type)!.value
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`
}
