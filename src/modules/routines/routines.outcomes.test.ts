import { describe, expect, it } from 'vitest'
import {
  FLARE_FLAG_RATE,
  MIN_LIFT,
  MIN_USERS,
  fnv1a32,
  flareFlag,
  hintsShown,
  labelChange,
  outcomeHint,
  type OutcomeCounts,
} from './routines.outcomes'

// Builds counts for one product in one group. Unset fields default to "nobody", and
// `flaredOrStopped` defaults to `flared` (the smallest value the validation allows).
function counts(c: {
  n: number
  fainter?: number
  flared?: number
  flaredOrStopped?: number
  both?: number
}): OutcomeCounts {
  const flared = c.flared ?? 0
  return {
    n: c.n,
    fainter: c.fainter ?? 0,
    flared,
    flaredOrStopped: c.flaredOrStopped ?? flared,
    fainterAndFlaredOrStopped: c.both ?? 0,
  }
}

describe('thresholds the owner set (2026-10-23, #152)', () => {
  it('uses 30 users, a 10-point lift and a 15% flare rate', () => {
    expect(MIN_USERS).toBe(30)
    expect(MIN_LIFT).toBe(0.1)
    expect(FLARE_FLAG_RATE).toBe(0.15)
  })
})

describe('outcomeHint', () => {
  it('gives no hint for 29 users', () => {
    expect(outcomeHint(counts({ n: 29, fainter: 20 }))).toBeNull()
  })

  it('gives a hint for exactly 30 users', () => {
    // n = 30, fainter = 12, nobody flared or stopped: (12 - 0) / 30 = 0.4
    const hint = outcomeHint(counts({ n: 30, fainter: 12 }))
    expect(hint?.n).toBe(30)
    expect(hint?.netFainter).toBeCloseTo(0.4, 12)
  })

  it('gives no hint, and does not divide by zero, for an empty group', () => {
    expect(outcomeHint(counts({ n: 0 }))).toBeNull()
  })

  it('subtracts users who stopped as well as users who flared', () => {
    // n = 40, fainter = 10, flaredOrStopped = 18 (of whom 8 flared), both = 4.
    // Per user: 4 are in both (0), 10 - 4 = 6 fainter only (+1), 18 - 4 = 14 flared/stopped only (-1),
    // the other 16 are 0. Sum = 6 - 14 = -8, so netFainter = -8 / 40 = -0.2.
    const hint = outcomeHint(counts({ n: 40, fainter: 10, flared: 8, flaredOrStopped: 18, both: 4 }))
    expect(hint?.n).toBe(40)
    expect(hint?.netFainter).toBeCloseTo(-0.2, 12)
  })

  it('does not subtract twice a user who is both fainter and flared-or-stopped', () => {
    // n = 30, fainter = 12, flaredOrStopped = 6 (2 of them flared), both = 3.
    // Per user: 3 in both (+1 - 1 = 0), 12 - 3 = 9 fainter only (+1), 6 - 3 = 3 flared/stopped only (-1),
    // the other 15 are 0. Sum = 9 - 3 = 6, so netFainter = 6 / 30 = 0.2.
    // Counting the 3 "both" users a second time would give (9 - 3 - 3) / 30 = 0.1.
    const hint = outcomeHint(counts({ n: 30, fainter: 12, flared: 2, flaredOrStopped: 6, both: 3 }))
    expect(hint?.netFainter).toBeCloseTo(0.2, 12)
  })
})

describe('fnv1a32', () => {
  // Published FNV-1a 32-bit test vectors.
  it.each([
    ['', 0x811c9dc5],
    ['a', 0xe40c292c],
    ['foobar', 0xbf9cf968],
    // Non-ASCII input is hashed over its UTF-8 bytes: 2 for 'é', 3 each for the two characters of '日本', 4 for the emoji.
    ['é', 0x1e9de8c1],
    ['日本', 0x9f26ee51],
    ['😀', 0x33a29608],
  ])('hashes %j to the published value', (input, expected) => {
    expect(fnv1a32(input)).toBe(expected)
  })
})

describe('hintsShown', () => {
  it('answers the same for the same routine id', () => {
    expect(hintsShown('routine-42')).toBe(hintsShown('routine-42'))
    expect(hintsShown('routine-7')).toBe(hintsShown('routine-7'))
  })

  // Decimal values worked by hand from the published vectors:
  //   fnv1a32('a')      = 0xe40c292c = 3826002220, and 3826002220 % 10 = 0, so hints are hidden
  //   fnv1a32('foobar') = 0xbf9cf968 = 3214735720, and 3214735720 % 10 = 0, so hints are hidden
  //   fnv1a32('')       = 0x811c9dc5 = 2166136261, and 2166136261 % 10 = 1, so hints are shown
  it('hides hints for ids whose hash is a multiple of 10', () => {
    expect(hintsShown('a')).toBe(false)
    expect(hintsShown('foobar')).toBe(false)
  })

  it('shows hints for ids whose hash is not a multiple of 10', () => {
    expect(hintsShown('')).toBe(true)
  })

  it('agrees with fnv1a32(id) % 10 !== 0 for every generated id', () => {
    for (let i = 0; i < 10_000; i++) {
      const id = `routine-${i}`
      expect(hintsShown(id), id).toBe(fnv1a32(id) % 10 !== 0)
    }
  })

  it('hides hints for about 1 in 10 routines', () => {
    let hidden = 0
    for (let i = 0; i < 10_000; i++) {
      if (!hintsShown(`routine-${i}`)) hidden++
    }
    const share = hidden / 10_000
    expect(share).toBeGreaterThanOrEqual(0.08)
    expect(share).toBeLessThanOrEqual(0.12)
  })
})

describe('labelChange', () => {
  // Every case below: v is +1 (fainter only), -1 (flared/stopped only) or 0 per user, so
  //   netFainter = (fainter - flaredOrStopped) / n
  //   mean(v^2)  = (fainter + flaredOrStopped - 2 * both) / n
  //   var        = mean(v^2) - netFainter^2
  //   se         = sqrt(var(a)/a.n + var(b)/b.n)
  //   lower      = diff - 1.959963984540054 * se      (the lift counts only if lower > 0)

  // Group A for the 200- and 2000-user cases: fainter 40% of n, flaredOrStopped 10% of n, nobody in both.
  //   n = 200:  fainter = 80,  flaredOrStopped = 20  -> net = 60 / 200 = 0.30
  //   n = 2000: fainter = 800, flaredOrStopped = 200 -> net = 600 / 2000 = 0.30
  //   mean(v^2) = (80 + 20) / 200 = 0.5 (same at 2000), var = 0.5 - 0.30^2 = 0.5 - 0.09 = 0.41
  const bigA = counts({ n: 2000, fainter: 800, flaredOrStopped: 200, flared: 100 })
  const midA = counts({ n: 200, fainter: 80, flaredOrStopped: 20, flared: 10 })

  it('refuses a 9-point lift even when the interval clearly excludes 0', () => {
    // B: n = 2000, fainter = 600, flaredOrStopped = 180 -> net = 420 / 2000 = 0.21.
    // diff = 0.30 - 0.21 = 0.09 < 0.10.
    // var(b) = (600 + 180) / 2000 - 0.21^2 = 0.39 - 0.0441 = 0.3459.
    // se = sqrt(0.41/2000 + 0.3459/2000) = sqrt(0.00037795) = 0.019441.
    // lower = 0.09 - 1.96 * 0.019441 = 0.09 - 0.0381 = 0.0519 > 0, so only the 10-point floor blocks it.
    const b = counts({ n: 2000, fainter: 600, flaredOrStopped: 180, flared: 90 })
    expect(labelChange(bigA, b)).toBe(false)
  })

  it('refuses a 10.5-point lift whose interval includes 0 (200 users each)', () => {
    // B: n = 200, fainter = 60, flaredOrStopped = 21 -> net = 39 / 200 = 0.195.
    // diff = 0.30 - 0.195 = 0.105 >= 0.10.
    // var(b) = (60 + 21) / 200 - 0.195^2 = 0.405 - 0.038025 = 0.366975.
    // se = sqrt(0.41/200 + 0.366975/200) = sqrt(0.003884875) = 0.062329.
    // lower = 0.105 - 1.96 * 0.062329 = 0.105 - 0.12216 = -0.0172 < 0.
    const b = counts({ n: 200, fainter: 60, flaredOrStopped: 21, flared: 10 })
    expect(labelChange(midA, b)).toBe(false)
  })

  it('refuses a 20-point lift between two groups of exactly 30, where the interval includes 0', () => {
    // A: n = 30, fainter = 12, flaredOrStopped = 3 -> net = 9 / 30 = 0.3; mean(v^2) = 15 / 30 = 0.5; var = 0.5 - 0.09 = 0.41.
    // B: n = 30, fainter = 6,  flaredOrStopped = 3 -> net = 3 / 30 = 0.1; mean(v^2) = 9 / 30 = 0.3;  var = 0.3 - 0.01 = 0.29.
    // diff = 0.2. se = sqrt(0.41/30 + 0.29/30) = sqrt(0.023333) = 0.15275.
    // lower = 0.2 - 1.96 * 0.15275 = 0.2 - 0.2994 = -0.0994 < 0.
    const a = counts({ n: 30, fainter: 12, flaredOrStopped: 3, flared: 1 })
    const b = counts({ n: 30, fainter: 6, flaredOrStopped: 3, flared: 1 })
    expect(labelChange(a, b)).toBe(false)
  })

  it('accepts a 10.5-point lift whose interval excludes 0 (2000 users each)', () => {
    // Same rates as the 200-user case, ten times the users: B = 2000 users, fainter 600, flaredOrStopped 210.
    // diff = 0.30 - 0.195 = 0.105. The variances are unchanged (0.41 and 0.366975).
    // se = sqrt(0.41/2000 + 0.366975/2000) = sqrt(0.0003884875) = 0.019710.
    // lower = 0.105 - 1.96 * 0.019710 = 0.105 - 0.03863 = 0.0664 > 0.
    const b = counts({ n: 2000, fainter: 600, flaredOrStopped: 210, flared: 100 })
    expect(labelChange(bigA, b)).toBe(true)
  })

  it('uses the overlap of fainter and flared-or-stopped when working out the spread', () => {
    // A: n = 30, fainter = 6, nobody flared or stopped -> net = 6 / 30 = 0.2; mean(v^2) = 6 / 30 = 0.2; var = 0.2 - 0.04 = 0.16.
    // B: n = 30, fainter = 15, flaredOrStopped = 15, all 15 of them in both -> every user is 0.
    //    net = 0; mean(v^2) = (15 + 15 - 2 * 15) / 30 = 0; var = 0.
    // diff = 0.2. se = sqrt(0.16/30 + 0) = sqrt(0.0053333) = 0.07303.
    // lower = 0.2 - 1.96 * 0.07303 = 0.2 - 0.14313 = 0.0569 > 0, so A wins.
    // Mistakes that read B as noisy flip this: counting "both" users once instead of cancelling them
    // gives mean(v^2) = 15/30 = 0.5, se = sqrt(0.0053333 + 0.5/30) = 0.14832, lower = 0.2 - 0.2907 < 0.
    const a = counts({ n: 30, fainter: 6 })
    const b = counts({ n: 30, fainter: 15, flared: 15, flaredOrStopped: 15, both: 15 })
    expect(labelChange(a, b)).toBe(true)
  })

  it('accepts a lead of exactly 10 points that floating point reads as a hair under', () => {
    // A: n = 2000, fainter = 600, nobody flared or stopped -> net = 600 / 2000 = 0.3; mean(v^2) = 600 / 2000 = 0.3; var = 0.3 - 0.09 = 0.21.
    // B: n = 2000, fainter = 400 -> net = 400 / 2000 = 0.2; mean(v^2) = 0.2; var = 0.2 - 0.04 = 0.16.
    // diff = 0.3 - 0.2 = 0.1 exactly, but in floating point 0.3 - 0.2 = 0.09999999999999998, which is under 0.1.
    // se = sqrt(0.21/2000 + 0.16/2000) = sqrt(0.000185) = 0.013601; lower = 0.1 - 1.96 * 0.013601 = 0.1 - 0.02666 = 0.0733 > 0.
    const a = counts({ n: 2000, fainter: 600 })
    const b = counts({ n: 2000, fainter: 400 })
    expect(labelChange(a, b)).toBe(true)
  })

  it('refuses a lead of 9.5 points, the neighbour of the exact 10-point case', () => {
    // B: n = 2000, fainter = 410 -> net = 410 / 2000 = 0.205. diff = 0.3 - 0.205 = 0.095 < 0.10.
    // The interval is not what blocks it: var(b) = 0.205 - 0.042025 = 0.162975, se = sqrt(0.21/2000 + 0.162975/2000) = 0.013656,
    // lower = 0.095 - 1.96 * 0.013656 = 0.0682 > 0, so only the 10-point floor refuses.
    const a = counts({ n: 2000, fainter: 600 })
    const b = counts({ n: 2000, fainter: 410 })
    expect(labelChange(a, b)).toBe(false)
  })

  it('refuses when A has fewer than 30 users, however large its lead', () => {
    // A: 29 users, all fainter -> net = 1, var = 1 - 1 = 0. B: 30 users, nobody -> net = 0, var = 0.
    // diff = 1, se = 0, so every rule except the user floor would say yes.
    const a = counts({ n: 29, fainter: 29 })
    const b = counts({ n: 30 })
    expect(labelChange(a, b)).toBe(false)
  })

  it('refuses when B has fewer than 30 users, however large A\'s lead', () => {
    const a = counts({ n: 30, fainter: 30 })
    const b = counts({ n: 29 })
    expect(labelChange(a, b)).toBe(false)
  })

  it('refuses a negative lift', () => {
    // The accepted 2000-user pair, swapped: diff = 0.195 - 0.30 = -0.105.
    const b = counts({ n: 2000, fainter: 600, flaredOrStopped: 210, flared: 100 })
    expect(labelChange(b, bigA)).toBe(false)
  })

  it('refuses two identical groups', () => {
    // diff = 0, below the 10-point floor.
    expect(labelChange(bigA, bigA)).toBe(false)
  })

  describe('when neither group has any spread (se is 0)', () => {
    // A group where every user is the same has var = 0:
    //   all fainter   : fainter = n, flaredOrStopped = 0 -> net = 1, mean(v^2) = n / n = 1, var = 1 - 1 = 0
    //   nobody at all : fainter = 0, flaredOrStopped = 0 -> net = 0, mean(v^2) = 0,         var = 0
    //   all stopped   : fainter = 0, flaredOrStopped = n -> net = -1, mean(v^2) = 1,        var = 1 - 1 = 0
    const allFainter = counts({ n: 30, fainter: 30 })
    const nobody = counts({ n: 30 })
    const allStopped = counts({ n: 30, flared: 30, flaredOrStopped: 30 })

    it('lets a positive difference decide: net 1 versus net 0 is a lift of 1', () => {
      expect(labelChange(allFainter, nobody)).toBe(true)
    })

    it('lets a positive difference decide: net 0 versus net -1 is a lift of 1', () => {
      expect(labelChange(nobody, allStopped)).toBe(true)
    })

    it('refuses the reverse, a difference of -1', () => {
      expect(labelChange(nobody, allFainter)).toBe(false)
    })

    it('refuses a difference of 0', () => {
      expect(labelChange(allFainter, allFainter)).toBe(false)
      expect(labelChange(nobody, nobody)).toBe(false)
    })
  })
})

describe('flareFlag', () => {
  it('flags a product at exactly the flare rate', () => {
    // 15 / 100 = 0.15, which is the rate.
    expect(flareFlag(counts({ n: 100, flared: 15 }))).toBe(true)
    // 6 / 40 = 0.15.
    expect(flareFlag(counts({ n: 40, flared: 6 }))).toBe(true)
  })

  it('does not flag a product just under the flare rate', () => {
    // 14 / 100 = 0.14 and 5 / 40 = 0.125, both under 0.15.
    expect(flareFlag(counts({ n: 100, flared: 14 }))).toBe(false)
    expect(flareFlag(counts({ n: 40, flared: 5 }))).toBe(false)
  })

  it('judges a group of exactly 30 users', () => {
    // 5 / 30 = 0.1667 is over the rate, 4 / 30 = 0.1333 is under it.
    expect(flareFlag(counts({ n: 30, flared: 5 }))).toBe(true)
    expect(flareFlag(counts({ n: 30, flared: 4 }))).toBe(false)
  })

  it('does not flag a group of 29 users, however many flared', () => {
    // 29 / 29 = 1.0, well over the rate; only the user floor says no.
    expect(flareFlag(counts({ n: 29, flared: 29 }))).toBe(false)
  })

  it('counts flares, not stops', () => {
    // 30 of 100 stopped but only 14 flared: 14 / 100 = 0.14 is under the rate.
    expect(flareFlag(counts({ n: 100, flared: 14, flaredOrStopped: 30 }))).toBe(false)
  })
})

describe('count validation', () => {
  // A valid base for 40 users, varied one field at a time so each case breaks exactly one rule.
  const valid = { n: 40, fainter: 10, flared: 4, flaredOrStopped: 10, both: 5 }

  it('accepts counts at every limit', () => {
    // Everyone fainter, everyone flared and stopped: fainter = flared = flaredOrStopped = both = n.
    expect(() => outcomeHint(counts({ n: 40, fainter: 40, flared: 40, flaredOrStopped: 40, both: 40 }))).not.toThrow()
    // both = min(fainter, flaredOrStopped) = 4, flared = flaredOrStopped = 10.
    expect(() => outcomeHint(counts({ n: 40, fainter: 4, flared: 10, flaredOrStopped: 10, both: 4 }))).not.toThrow()
    // An empty group with all zeros.
    expect(() => outcomeHint(counts({ n: 0 }))).not.toThrow()
  })

  const badCounts: Array<[string, OutcomeCounts]> = [
    ['n is not an integer', counts({ ...valid, n: 40.5 })],
    ['fainter is not an integer', counts({ ...valid, fainter: 10.5 })],
    ['flared is not an integer', counts({ ...valid, flared: 3.5 })],
    ['flaredOrStopped is not an integer', counts({ ...valid, flaredOrStopped: 10.5 })],
    ['both is not an integer', counts({ ...valid, both: 4.5 })],
    ['a count is NaN', counts({ ...valid, fainter: Number.NaN })],
    ['a count is Infinity', counts({ ...valid, n: Number.POSITIVE_INFINITY })],
    ['n is negative', counts({ ...valid, n: -1 })],
    ['fainter is negative', counts({ ...valid, fainter: -1 })],
    ['flared is negative', counts({ ...valid, flared: -1 })],
    ['flaredOrStopped is negative', counts({ ...valid, flaredOrStopped: -1, flared: 0, both: 0 })],
    ['both is negative', counts({ ...valid, both: -1 })],
    ['fainter is more than n', counts({ ...valid, fainter: 41 })],
    ['flaredOrStopped is more than n', counts({ ...valid, flaredOrStopped: 41 })],
    ['both is more than fainter', counts({ ...valid, fainter: 4, both: 5 })],
    ['both is more than flaredOrStopped', counts({ ...valid, flaredOrStopped: 4, flared: 4, both: 5 })],
    ['flared is more than flaredOrStopped', counts({ ...valid, flared: 11 })],
    // 30 + 20 - 5 = 45 distinct users counted in a group of 40.
    ['fainter and flaredOrStopped cover more distinct users than n', counts({ ...valid, fainter: 30, flaredOrStopped: 20, flared: 4, both: 5 })],
  ]

  it.each(badCounts)('outcomeHint throws a RangeError when %s', (_rule, bad) => {
    expect(() => outcomeHint(bad)).toThrow(RangeError)
  })

  it('throws the same fixed message whichever rule is broken and whatever the numbers', () => {
    const messages = new Set<string>()
    for (const [, bad] of badCounts) {
      try {
        outcomeHint(bad)
      } catch (error) {
        messages.add((error as Error).message)
      }
    }
    expect(messages.size).toBe(1)
  })

  it('labelChange rejects bad counts on either side', () => {
    const good = counts({ n: 40, fainter: 10 })
    const bad = counts({ ...valid, fainter: 41 })
    expect(() => labelChange(bad, good)).toThrow(RangeError)
    expect(() => labelChange(good, bad)).toThrow(RangeError)
  })

  it('flareFlag rejects bad counts', () => {
    expect(() => flareFlag(counts({ ...valid, flared: 11 }))).toThrow(RangeError)
  })
})
