/**
 * Outcome rules for the routine eval: pure functions over counts of what happened to users who had a product in
 * their routine at the review point. One product in one group (same goal, skin type and shopping country) at a time;
 * the caller does the grouping. No I/O, no clock, no randomness.
 */

/**
 * Counts for one product in one group. Each user is worth +1 (goal concerns read fainter), -1 (flared on the product
 * or stopped it) or 0 (neither, or both: a user who is fainter and flared-or-stopped cancels out).
 */
export type OutcomeCounts = {
  /** Users who reached the review point with this product in their routine. */
  n: number
  /** Of them, how many had their goal concerns read "fainter" since day one. */
  fainter: number
  /** How many logged a flare with it. */
  flared: number
  /** How many flared on it or stopped it (a user who did both counts once). */
  flaredOrStopped: number
  /** How many are in both `fainter` and `flaredOrStopped`. */
  fainterAndFlaredOrStopped: number
}

/**
 * Why every bad count is refused with one message: counts come from our own records, so a bad one is a bug upstream,
 * and the message never carries the numbers (they can describe a real group of users).
 */
const BAD_COUNTS = 'Outcome counts are inconsistent'

// "At least 10 points" must hold at exactly 10 points, but the difference of two rates can land a hair under it in floating point
// (0.3 - 0.2 is 0.09999999999999998). Counts are whole users, so real leads sit far apart and 1e-9 only rescues a lead that is exactly MIN_LIFT.
const LIFT_TOLERANCE = 1e-9

/** Z for a two-sided 95% interval under the normal approximation. */
const Z95 = 1.959963984540054

/**
 * A group this small says nothing, so no hint, no label change and no flare flag below it.
 * The owner's decision (2026-10-23, #152).
 */
export const MIN_USERS = 30

/**
 * The least lead, in net-fainter points, that lets one product replace another as the labelled best. A lead that
 * is statistically real but tiny is not worth changing a label for.
 * The owner's decision (2026-10-23, #152).
 */
export const MIN_LIFT = 0.1

/**
 * The share of users who logged a flare at which a product is flagged. A placeholder: the owner will set the real
 * rate.
 * The owner's decision (2026-10-23, #152) to flag at a rate; the number is still theirs to set.
 */
export const FLARE_FLAG_RATE = 0.15

// Every rule the counts must obey; a count that breaks one cannot have come from real users.
const assertValid = (c: OutcomeCounts): void => {
  const { n, fainter, flared, flaredOrStopped, fainterAndFlaredOrStopped: both } = c
  const all = [n, fainter, flared, flaredOrStopped, both]
  if (!all.every((v) => Number.isInteger(v) && v >= 0 && v <= n)) throw new RangeError(BAD_COUNTS)
  if (both > Math.min(fainter, flaredOrStopped)) throw new RangeError(BAD_COUNTS)
  if (flared > flaredOrStopped) throw new RangeError(BAD_COUNTS)
  // fainter and flaredOrStopped overlap in `both` users, so together they cover this many distinct users, and the group has only n.
  if (fainter + flaredOrStopped - both > n) throw new RangeError(BAD_COUNTS)
}

// mean(v) over the group; an empty group has no mean, so callers check n first.
const netFainterOf = (c: OutcomeCounts): number => (c.fainter - c.flaredOrStopped) / c.n

// var(v) = mean(v^2) - mean(v)^2. v is 0 for a user in both, so the overlap is taken out of mean(v^2) twice.
const varianceOf = (c: OutcomeCounts): number => {
  const meanSquare = (c.fainter + c.flaredOrStopped - 2 * c.fainterAndFlaredOrStopped) / c.n
  const mean = netFainterOf(c)
  return meanSquare - mean * mean
}

/**
 * What the app may say about a product's outcomes for a group: how many users, and their net fainter score (fainter
 * minus flared-or-stopped, per user). Null under MIN_USERS, so a small group never produces a number to quote.
 * The owner's decision (2026-10-23, #152).
 */
export const outcomeHint = (counts: OutcomeCounts): { n: number; netFainter: number } | null => {
  assertValid(counts)
  if (counts.n < MIN_USERS) return null
  return { n: counts.n, netFainter: netFainterOf(counts) }
}

/**
 * FNV-1a, 32 bit, over the UTF-8 bytes. Here and not a library so the answer is the same on every runtime and for ever:
 * hintsShown must not move a routine between shown and hidden. `Math.imul` and `>>> 0` keep it unsigned 32-bit.
 * The owner's decision (2026-10-23, #152).
 */
export const fnv1a32 = (input: string): number => {
  let hash = 0x811c9dc5
  for (const byte of new TextEncoder().encode(input)) {
    hash = Math.imul(hash ^ byte, 0x01000193) >>> 0
  }
  return hash
}

/**
 * Whether this routine shows outcome hints: false for about 1 in 10 routine ids, chosen by hash so the same routine
 * always answers the same and the hidden tenth can be compared against the rest.
 * The owner's decision (2026-10-23, #152).
 */
export const hintsShown = (routineId: string): boolean => fnv1a32(routineId) % 10 !== 0

/**
 * Whether A should replace B as the labelled best for a group. A label that flips on noise is worse than a stale one,
 * so it needs both groups at MIN_USERS, a lead of at least MIN_LIFT, and a 95% interval on the lead that excludes 0
 * (normal approximation for a difference of means). With no spread in either group the lead itself decides.
 * The owner's decision (2026-10-23, #152).
 */
export const labelChange = (a: OutcomeCounts, b: OutcomeCounts): boolean => {
  assertValid(a)
  assertValid(b)
  if (a.n < MIN_USERS || b.n < MIN_USERS) return false
  const diff = netFainterOf(a) - netFainterOf(b)
  if (diff < MIN_LIFT - LIFT_TOLERANCE) return false
  const se = Math.sqrt(varianceOf(a) / a.n + varianceOf(b) / b.n)
  if (se === 0) return diff > 0
  return diff - Z95 * se > 0
}

/**
 * Whether a product is flagged for flares in a group: at least FLARE_FLAG_RATE of its users logged one. Flares only,
 * not stops; a user who stopped without a flare is not a flare. Under MIN_USERS it is never flagged.
 * The owner's decision (2026-10-23, #152).
 */
export const flareFlag = (counts: OutcomeCounts): boolean => {
  assertValid(counts)
  return counts.n >= MIN_USERS && counts.flared / counts.n >= FLARE_FLAG_RATE
}
