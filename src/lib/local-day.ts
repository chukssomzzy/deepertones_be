// A person's local day, from an IANA time zone, using Intl alone. A day is not always 24 hours (the day clocks change is 23 or 25), so a day's edges are found by
// asking what calendar day an instant is on, never by adding hours. A null zone is UTC.

const HOUR_MS = 60 * 60 * 1000
// No local day is longer than 25 hours; this reaches a day's start from any instant in it, and its end from any instant before it.
const SEARCH_MS = 48 * HOUR_MS

const formatters = new Map<string, Intl.DateTimeFormat>()

const formatterFor = (zone: string): Intl.DateTimeFormat => {
  let formatter = formatters.get(zone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
    formatters.set(zone, formatter)
  }
  return formatter
}

const hourFormatters = new Map<string, Intl.DateTimeFormat>()

/** The hour of the day (0 to 23) `now` falls in, in `zone`; a null zone is UTC. Throws a RangeError for a zone Intl does not know. */
export const localHour = (now: Date, zone: string | null): number => {
  const key = zone ?? 'UTC'
  let formatter = hourFormatters.get(key)
  if (!formatter) {
    // h23, not hour12: false, which some engines spell "24" at midnight.
    formatter = new Intl.DateTimeFormat('en-US', { timeZone: key, hour: '2-digit', hourCycle: 'h23' })
    hourFormatters.set(key, formatter)
  }
  return Number(formatter.formatToParts(now).find((p) => p.type === 'hour')!.value)
}

/** The calendar day `now` falls on in `zone`, as 'YYYY-MM-DD'. Throws a RangeError for a zone Intl does not know. */
export const localDay = (now: Date, zone: string | null): string => {
  const part = (type: string) => formatterFor(zone ?? 'UTC').formatToParts(now).find((p) => p.type === type)!.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

/** The zone itself when Intl can read days and hours in it, else null (UTC): a stored zone that was valid when saved must not make a read fail. Anything but a RangeError is rethrown. */
export const usableZone = (now: Date, zone: string | null): string | null => {
  if (zone === null) return null
  try {
    localDay(now, zone)
    localHour(now, zone)
    return zone
  } catch (error) {
    if (error instanceof RangeError) return null
    throw error
  }
}

/**
 * The calendar date `now` falls on in `zone`, as the UTC midnight of that date. For a date that is stored and then only ever read as a date: it is fixed when it is set
 * and is not an instant in any zone, so a later change of the person's zone cannot move it.
 */
export const localDate = (now: Date, zone: string | null): Date => new Date(`${localDay(now, zone)}T00:00:00.000Z`)

/** The first millisecond at which `held` is true, given that it is false at `before` and true at `after` and changes once between them. */
const firstInstant = (before: number, after: number, held: (at: Date) => boolean): Date => {
  let low = before
  let high = after
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2)
    if (held(new Date(mid))) high = mid
    else low = mid
  }
  return new Date(high)
}

/** The UTC instant the local day of `now` began: its local midnight, or its first instant where the clocks skipped midnight. */
export const startOfLocalDay = (now: Date, zone: string | null): Date => {
  const today = localDay(now, zone)
  return firstInstant(now.getTime() - SEARCH_MS, now.getTime(), (at) => localDay(at, zone) >= today)
}

/** The UTC instant the local day after the one `now` is on begins. Always after `now`. */
export const nextLocalDay = (now: Date, zone: string | null): Date => {
  const today = localDay(now, zone)
  return firstInstant(now.getTime(), now.getTime() + SEARCH_MS, (at) => localDay(at, zone) > today)
}
