import { describe, expect, it } from 'vitest'
import { localDate, localDay, localHour, nextLocalDay, startOfLocalDay } from './local-day'

// Local days (spec #217): which calendar day a person is on, and the UTC instant their local day begins, in their IANA time zone. A person with no stored zone is
// on the UTC day. These are the instants the routine stamps day 1 and step-down dates with, so every one is checked at the edge on both sides.
//
// THE CONTRACT THIS FILE PINS (assumed: the brief gives the names and the shapes, not the module's exports):
//   localDay(now: Date, zone: string | null): string        'YYYY-MM-DD', the calendar day `now` falls on in `zone`
//   startOfLocalDay(now: Date, zone: string | null): Date   the UTC instant that day began (its local midnight)
//   nextLocalDay(now: Date, zone: string | null): Date      the UTC instant the following local day begins; always after `now`
//   A null zone is UTC. A day is not always 24 hours: the day a zone's clocks change is 23 or 25 hours long.
// Every expected instant below is worked out by hand from the zone's offset, never by asking Intl.

const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000
const DAY = 24 * HOUR

// The anchors. Everything else is an offset from one of them. A zone's clock change happens at a fixed UTC instant.
const MIDSUMMER = Date.UTC(2030, 5, 15) // 2030-06-15T00:00Z: no zone below changes its clocks near it
const MIDWINTER = Date.UTC(2030, 0, 15) // 2030-01-15T00:00Z
// Europe/London: clocks go forward at 01:00 UTC (GMT -> BST, +0 -> +1), and back at 01:00 UTC (BST -> GMT).
const LONDON_FORWARD = Date.UTC(2030, 2, 31, 1)
const LONDON_BACK = Date.UTC(2030, 9, 27, 1)
// America/New_York: forward at 07:00 UTC (EST -> EDT, -5 -> -4), back at 06:00 UTC (EDT -> EST).
const NEW_YORK_FORWARD = Date.UTC(2030, 2, 10, 7)
const NEW_YORK_BACK = Date.UTC(2030, 10, 3, 6)

const at = (anchor: number, offsetMs: number) => new Date(anchor + offsetMs)
const iso = (date: Date) => date.toISOString()

describe('localDay', () => {
  // Africa/Lagos is UTC+1 all year. Local midnight is 23:00 UTC the evening before.
  it.each([
    ['the last millisecond of the Lagos day', 23 * HOUR - 1, '2030-06-15'],
    ['the first millisecond of the next Lagos day', 23 * HOUR, '2030-06-16'],
  ])('puts %s on the right side of the Lagos midnight', (_when, offsetMs, day) => {
    expect(localDay(at(MIDSUMMER, offsetMs), 'Africa/Lagos')).toBe(day)
  })

  it('is a day ahead of UTC for a Lagos morning that is still the evening before in UTC', () => {
    // 23:30 UTC on the 15th is 00:30 on the 16th in Lagos.
    expect(localDay(at(MIDSUMMER, 23 * HOUR + 30 * MINUTE), 'Africa/Lagos')).toBe('2030-06-16')
    expect(localDay(at(MIDSUMMER, 23 * HOUR + 30 * MINUTE), null)).toBe('2030-06-15')
  })

  // America/New_York in June is UTC-4. Local midnight is 04:00 UTC.
  it.each([
    ['the last millisecond of the New York day', 4 * HOUR - 1, '2030-06-14'],
    ['the first millisecond of the next New York day', 4 * HOUR, '2030-06-15'],
  ])('puts %s on the right side of the New York midnight (west of UTC, the day is behind)', (_when, offsetMs, day) => {
    expect(localDay(at(MIDSUMMER, offsetMs), 'America/New_York')).toBe(day)
  })

  it('uses the zone\'s winter offset in winter: New York at 04:59 UTC in January is still the evening before', () => {
    expect(localDay(at(MIDWINTER, 5 * HOUR - 1), 'America/New_York')).toBe('2030-01-14')
    expect(localDay(at(MIDWINTER, 5 * HOUR), 'America/New_York')).toBe('2030-01-15')
  })

  it('reads London in summer as BST: 23:00 UTC is already midnight', () => {
    expect(localDay(at(MIDSUMMER, 23 * HOUR - 1), 'Europe/London')).toBe('2030-06-15')
    expect(localDay(at(MIDSUMMER, 23 * HOUR), 'Europe/London')).toBe('2030-06-16')
  })

  it('reads London in winter as GMT: 23:30 UTC is still the same day', () => {
    expect(localDay(at(MIDWINTER, 23 * HOUR + 30 * MINUTE), 'Europe/London')).toBe('2030-01-15')
  })

  it('crosses the year at the zone\'s own midnight', () => {
    const NEW_YEAR_EVE = Date.UTC(2030, 11, 31)
    expect(localDay(at(NEW_YEAR_EVE, 23 * HOUR - 1), 'Africa/Lagos')).toBe('2030-12-31')
    expect(localDay(at(NEW_YEAR_EVE, 23 * HOUR), 'Africa/Lagos')).toBe('2031-01-01')
  })

  it('is the UTC day with no zone, at its edges', () => {
    expect(localDay(at(MIDSUMMER, DAY - 1), null)).toBe('2030-06-15')
    expect(localDay(at(MIDSUMMER, DAY), null)).toBe('2030-06-16')
    expect(localDay(at(MIDSUMMER, 0), null)).toBe('2030-06-15')
  })
})

describe('startOfLocalDay and nextLocalDay: a zone with no clock changes', () => {
  it('Lagos: a day runs from 23:00 UTC to 23:00 UTC', () => {
    const now = at(MIDSUMMER, 12 * HOUR)

    expect(iso(startOfLocalDay(now, 'Africa/Lagos'))).toBe(iso(at(MIDSUMMER, -HOUR)))
    expect(iso(nextLocalDay(now, 'Africa/Lagos'))).toBe(iso(at(MIDSUMMER, 23 * HOUR)))
  })

  it('Lagos: the first instant of a day starts it, and the next day is 24 hours on', () => {
    const midnight = at(MIDSUMMER, -HOUR)

    expect(iso(startOfLocalDay(midnight, 'Africa/Lagos'))).toBe(iso(midnight))
    expect(iso(nextLocalDay(midnight, 'Africa/Lagos'))).toBe(iso(at(MIDSUMMER, 23 * HOUR)))
  })

  it('Lagos: the last millisecond of a day still belongs to it, and the next day begins one millisecond on', () => {
    const lastMs = at(MIDSUMMER, 23 * HOUR - 1)

    expect(iso(startOfLocalDay(lastMs, 'Africa/Lagos'))).toBe(iso(at(MIDSUMMER, -HOUR)))
    expect(iso(nextLocalDay(lastMs, 'Africa/Lagos'))).toBe(iso(at(MIDSUMMER, 23 * HOUR)))
  })

  it('Lagos at 23:30 local (22:30 UTC) is still the same Lagos day; the next one begins in half an hour', () => {
    const now = at(MIDSUMMER, 22 * HOUR + 30 * MINUTE)

    expect(iso(startOfLocalDay(now, 'Africa/Lagos'))).toBe(iso(at(MIDSUMMER, -HOUR)))
    expect(iso(nextLocalDay(now, 'Africa/Lagos'))).toBe(iso(at(MIDSUMMER, 23 * HOUR)))
  })

  it('Lagos at 00:30 local (23:30 UTC) is already the next Lagos day, which began half an hour ago', () => {
    const now = at(MIDSUMMER, 23 * HOUR + 30 * MINUTE)

    expect(iso(startOfLocalDay(now, 'Africa/Lagos'))).toBe(iso(at(MIDSUMMER, 23 * HOUR)))
    expect(iso(nextLocalDay(now, 'Africa/Lagos'))).toBe(iso(at(MIDSUMMER, 47 * HOUR)))
  })

  it('New York in summer: a day runs from 04:00 UTC to 04:00 UTC, and 02:00 UTC is still the evening before', () => {
    const evening = at(MIDSUMMER, 2 * HOUR)

    expect(iso(startOfLocalDay(evening, 'America/New_York'))).toBe(iso(at(MIDSUMMER, -20 * HOUR)))
    expect(iso(nextLocalDay(evening, 'America/New_York'))).toBe(iso(at(MIDSUMMER, 4 * HOUR)))
  })

  it('New York in winter: a day runs from 05:00 UTC to 05:00 UTC', () => {
    const now = at(MIDWINTER, 12 * HOUR)

    expect(iso(startOfLocalDay(now, 'America/New_York'))).toBe(iso(at(MIDWINTER, 5 * HOUR)))
    expect(iso(nextLocalDay(now, 'America/New_York'))).toBe(iso(at(MIDWINTER, 29 * HOUR)))
  })

  it('treats no zone as UTC: the day starts at 00:00 UTC and the next at the 00:00 after', () => {
    const now = at(MIDSUMMER, 12 * HOUR)

    expect(iso(startOfLocalDay(now, null))).toBe(iso(at(MIDSUMMER, 0)))
    expect(iso(nextLocalDay(now, null))).toBe(iso(at(MIDSUMMER, DAY)))
  })

  it('UTC: the last millisecond of a day belongs to it and the first of the next is the next day', () => {
    expect(iso(nextLocalDay(at(MIDSUMMER, DAY - 1), null))).toBe(iso(at(MIDSUMMER, DAY)))
    expect(iso(startOfLocalDay(at(MIDSUMMER, DAY), null))).toBe(iso(at(MIDSUMMER, DAY)))
    expect(iso(nextLocalDay(at(MIDSUMMER, DAY), null))).toBe(iso(at(MIDSUMMER, 2 * DAY)))
  })
})

describe('startOfLocalDay and nextLocalDay: Europe/London across the clock changes', () => {
  // Spring forward, 2030-03-31 at 01:00 UTC: the local day of the 31st runs 00:00 UTC to 23:00 UTC, a 23-hour day.
  it('the day before the spring change is a normal GMT day', () => {
    const now = at(LONDON_FORWARD, -13 * HOUR) // 12:00 UTC on the 30th

    expect(iso(startOfLocalDay(now, 'Europe/London'))).toBe(iso(at(LONDON_FORWARD, -25 * HOUR)))
    expect(iso(nextLocalDay(now, 'Europe/London'))).toBe(iso(at(LONDON_FORWARD, -HOUR)))
  })

  it('the day of the spring change is 23 hours long: the next day begins at 23:00 UTC, not 00:00', () => {
    const now = at(LONDON_FORWARD, 11 * HOUR) // 12:00 UTC on the 31st, 13:00 BST

    expect(iso(startOfLocalDay(now, 'Europe/London'))).toBe(iso(at(LONDON_FORWARD, -HOUR)))
    expect(iso(nextLocalDay(now, 'Europe/London'))).toBe(iso(at(LONDON_FORWARD, 22 * HOUR)))
  })

  it('the day after the spring change starts at 23:00 UTC the evening before, and the one after that 24 hours later', () => {
    const now = at(LONDON_FORWARD, 35 * HOUR) // 12:00 UTC on 1 April, 13:00 BST

    expect(iso(startOfLocalDay(now, 'Europe/London'))).toBe(iso(at(LONDON_FORWARD, 22 * HOUR)))
    expect(iso(nextLocalDay(now, 'Europe/London'))).toBe(iso(at(LONDON_FORWARD, 46 * HOUR)))
  })

  it('one minute either side of the spring jump is the same London day', () => {
    expect(localDay(at(LONDON_FORWARD, -MINUTE), 'Europe/London')).toBe('2030-03-31')
    expect(localDay(at(LONDON_FORWARD, 0), 'Europe/London')).toBe('2030-03-31')
    expect(iso(nextLocalDay(at(LONDON_FORWARD, -MINUTE), 'Europe/London'))).toBe(iso(at(LONDON_FORWARD, 22 * HOUR)))
    expect(iso(nextLocalDay(at(LONDON_FORWARD, 0), 'Europe/London'))).toBe(iso(at(LONDON_FORWARD, 22 * HOUR)))
  })

  // Fall back, 2030-10-27 at 01:00 UTC: the local day of the 27th runs 23:00 UTC on the 26th to 00:00 UTC on the 28th, a 25-hour day.
  it('the day before the autumn change is a normal BST day', () => {
    const now = at(LONDON_BACK, -13 * HOUR) // 12:00 UTC on the 26th

    expect(iso(startOfLocalDay(now, 'Europe/London'))).toBe(iso(at(LONDON_BACK, -26 * HOUR)))
    expect(iso(nextLocalDay(now, 'Europe/London'))).toBe(iso(at(LONDON_BACK, -2 * HOUR)))
  })

  it('the day of the autumn change is 25 hours long: the next day begins at 00:00 UTC, not 23:00', () => {
    const now = at(LONDON_BACK, 11 * HOUR) // 12:00 UTC on the 27th, 12:00 GMT

    expect(iso(startOfLocalDay(now, 'Europe/London'))).toBe(iso(at(LONDON_BACK, -2 * HOUR)))
    expect(iso(nextLocalDay(now, 'Europe/London'))).toBe(iso(at(LONDON_BACK, 23 * HOUR)))
  })

  it('the repeated hour is one local day: 00:30 UTC (01:30 BST) and 01:30 UTC (01:30 GMT) both start at 23:00 UTC on the 26th', () => {
    for (const offsetMs of [-30 * MINUTE, 30 * MINUTE]) {
      const now = at(LONDON_BACK, offsetMs)
      expect(localDay(now, 'Europe/London')).toBe('2030-10-27')
      expect(iso(startOfLocalDay(now, 'Europe/London'))).toBe(iso(at(LONDON_BACK, -2 * HOUR)))
      expect(iso(nextLocalDay(now, 'Europe/London'))).toBe(iso(at(LONDON_BACK, 23 * HOUR)))
    }
  })

  it('the day after the autumn change begins at 00:00 UTC (GMT) and ends 24 hours later', () => {
    const now = at(LONDON_BACK, 35 * HOUR) // 12:00 UTC on the 28th

    expect(iso(startOfLocalDay(now, 'Europe/London'))).toBe(iso(at(LONDON_BACK, 23 * HOUR)))
    expect(iso(nextLocalDay(now, 'Europe/London'))).toBe(iso(at(LONDON_BACK, 47 * HOUR)))
  })
})

describe('startOfLocalDay and nextLocalDay: America/New_York across the clock changes', () => {
  // Spring forward, 2030-03-10 at 07:00 UTC (02:00 EST -> 03:00 EDT): the 10th runs 05:00 UTC to 04:00 UTC on the 11th, 23 hours.
  it('the day of the spring change is 23 hours long, starting on EST and ending on EDT', () => {
    const now = at(NEW_YORK_FORWARD, 5 * HOUR) // 12:00 UTC on the 10th, 08:00 EDT

    expect(localDay(now, 'America/New_York')).toBe('2030-03-10')
    expect(iso(startOfLocalDay(now, 'America/New_York'))).toBe(iso(at(NEW_YORK_FORWARD, -2 * HOUR)))
    expect(iso(nextLocalDay(now, 'America/New_York'))).toBe(iso(at(NEW_YORK_FORWARD, 21 * HOUR)))
  })

  // Fall back, 2030-11-03 at 06:00 UTC (02:00 EDT -> 01:00 EST): the 3rd runs 04:00 UTC to 05:00 UTC on the 4th, 25 hours.
  it('the day of the autumn change is 25 hours long, starting on EDT and ending on EST', () => {
    const now = at(NEW_YORK_BACK, 6 * HOUR) // 12:00 UTC on the 3rd, 07:00 EST

    expect(localDay(now, 'America/New_York')).toBe('2030-11-03')
    expect(iso(startOfLocalDay(now, 'America/New_York'))).toBe(iso(at(NEW_YORK_BACK, -2 * HOUR)))
    expect(iso(nextLocalDay(now, 'America/New_York'))).toBe(iso(at(NEW_YORK_BACK, 23 * HOUR)))
  })
})

describe('localDate', () => {
  // The calendar date a person is on, as the UTC midnight of that date. This is what the routine stores for day 1 and for a step-down's start: a date fixed when it is
  // set, which a later change of zone does not move (it is not an instant in any zone).
  it.each([
    ['the last millisecond of the Lagos day', MIDSUMMER + 23 * HOUR - 1, 'Africa/Lagos', '2030-06-15T00:00:00.000Z'],
    ['the first millisecond of the next Lagos day', MIDSUMMER + 23 * HOUR, 'Africa/Lagos', '2030-06-16T00:00:00.000Z'],
    ['the last millisecond of the New York day (UTC-4)', MIDSUMMER + 4 * HOUR - 1, 'America/New_York', '2030-06-14T00:00:00.000Z'],
    ['the first millisecond of the next New York day', MIDSUMMER + 4 * HOUR, 'America/New_York', '2030-06-15T00:00:00.000Z'],
    ['New York in winter (UTC-5), still the evening before at 04:59 UTC', MIDWINTER + 5 * HOUR - 1, 'America/New_York', '2030-01-14T00:00:00.000Z'],
  ])('is the UTC midnight of the local date at %s', (_when, instant, zone, expected) => {
    expect(iso(localDate(new Date(instant), zone))).toBe(expected)
  })

  it('is the UTC day with no zone, at its edges', () => {
    expect(iso(localDate(at(MIDSUMMER, DAY - 1), null))).toBe('2030-06-15T00:00:00.000Z')
    expect(iso(localDate(at(MIDSUMMER, DAY), null))).toBe('2030-06-16T00:00:00.000Z')
    expect(iso(localDate(at(MIDSUMMER, 12 * HOUR), 'UTC'))).toBe('2030-06-15T00:00:00.000Z')
  })

  it('follows London\'s clock changes: 00:30 BST on 1 April is the 1st although it is still the 31st in UTC', () => {
    expect(iso(localDate(at(LONDON_FORWARD, 22 * HOUR + 30 * MINUTE), 'Europe/London'))).toBe('2030-04-01T00:00:00.000Z')
    expect(iso(localDate(at(LONDON_FORWARD, 22 * HOUR + 30 * MINUTE - HOUR), 'Europe/London'))).toBe('2030-03-31T00:00:00.000Z')
  })

  it('keeps the repeated hour of the autumn change on one date', () => {
    for (const offsetMs of [-90 * MINUTE, -30 * MINUTE, 30 * MINUTE, 23 * HOUR - MINUTE]) {
      expect(iso(localDate(at(LONDON_BACK, offsetMs), 'Europe/London'))).toBe('2030-10-27T00:00:00.000Z')
    }
    expect(iso(localDate(at(LONDON_BACK, 23 * HOUR), 'Europe/London'))).toBe('2030-10-28T00:00:00.000Z')
  })

  it('crosses the year at the zone\'s own midnight', () => {
    const NEW_YEAR_EVE = Date.UTC(2030, 11, 31)
    expect(iso(localDate(at(NEW_YEAR_EVE, 23 * HOUR - 1), 'Africa/Lagos'))).toBe('2030-12-31T00:00:00.000Z')
    expect(iso(localDate(at(NEW_YEAR_EVE, 23 * HOUR), 'Africa/Lagos'))).toBe('2031-01-01T00:00:00.000Z')
  })
})

// The hour Today splits the day at (spec #233): 0 to 23 on the person's own clock, hand-worked from each zone's offset.
describe('localHour', () => {
  it.each([
    ['UTC for a null zone', null, MIDSUMMER + 14 * HOUR + 59 * MINUTE, 14],
    ['midnight is 0, never 24', null, MIDSUMMER, 0],
    ['Africa/Lagos (UTC+1)', 'Africa/Lagos', MIDSUMMER + 14 * HOUR, 15],
    ['Europe/London in BST (UTC+1)', 'Europe/London', MIDSUMMER + 23 * HOUR, 0],
    ['Europe/London in GMT (UTC+0)', 'Europe/London', MIDWINTER + 23 * HOUR, 23],
    ['America/New_York in EDT (UTC-4)', 'America/New_York', MIDSUMMER + 19 * HOUR, 15],
  ])('is the hour in %s', (_label, zone, at, hour) => {
    expect(localHour(new Date(at), zone)).toBe(hour)
  })

  // The day's hours are not 0 to 23 once each on a day the clocks change: the spring one skips an hour and the autumn one repeats one. The instants are the zone's clock changes, worked out by hand.
  it.each([
    ['London, the minute before the clocks go forward', 'Europe/London', LONDON_FORWARD - MINUTE, 0],
    ['London, when they go forward (01:00 becomes 02:00)', 'Europe/London', LONDON_FORWARD, 2],
    ['London, the minute before they go back (01:59 BST)', 'Europe/London', LONDON_BACK - MINUTE, 1],
    ['London, when they go back (01:00 GMT)', 'Europe/London', LONDON_BACK, 1],
    ['London, an hour after they go back', 'Europe/London', LONDON_BACK + HOUR, 2],
    ['New York, the minute before the clocks go forward', 'America/New_York', NEW_YORK_FORWARD - MINUTE, 1],
    ['New York, when they go forward (02:00 becomes 03:00)', 'America/New_York', NEW_YORK_FORWARD, 3],
  ])('is right on a day the clocks change: %s', (_label, zone, at, hour) => {
    expect(localHour(new Date(at), zone)).toBe(hour)
  })

  it('throws a RangeError for a zone Intl does not know', () => {
    expect(() => localHour(new Date(MIDSUMMER), 'Mars/Olympus_Mons')).toThrow(RangeError)
  })
})
