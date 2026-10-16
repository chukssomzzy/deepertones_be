import { describe, expect, it } from 'vitest'
import { buildQuery, formatSpend, parseSpendArgs, type SpendRow } from './spend'

/*
 * `npm run ai:spend` reads the ai_usage table (through wrangler d1 execute) and prints what the AI calls cost.
 * These are the pure parts. A row is what the query returns for one settled call, in the table's own column names.
 */

// Every date is an offset from this one, so nothing rots as the calendar moves on.
const NOW = new Date('2030-06-15T12:00:00.000Z')
const MIDNIGHT = new Date('2030-06-15T00:00:00.000Z')
const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const ago = (ms: number) => NOW.getTime() - ms

const row = (createdAt: number, over: Partial<SpendRow> = {}): SpendRow => ({
  created_at: createdAt,
  job: 'research',
  model: 'claude-haiku-5-5',
  status: 'settled',
  cost_micros: 1_000_000,
  estimate_micros: 1_500_000,
  ...over,
})

/** A reservation that was never settled or released: it has an estimate and no cost. */
const held = (createdAt: number, estimateMicros: number, over: Partial<SpendRow> = {}): SpendRow =>
  row(createdAt, { status: 'reserved', cost_micros: null, estimate_micros: estimateMicros, ...over })

/** The one line of the output that matches, so an assertion is about that line and not the whole report. */
const lineMatching = (output: string, pattern: RegExp): string => {
  const lines = output.split('\n').filter((line) => pattern.test(line))
  expect(lines, `lines matching ${pattern}`).toHaveLength(1)
  return lines[0]!
}

describe('parseSpendArgs', () => {
  it('defaults to the local database and 30 days', () => {
    expect(parseSpendArgs([])).toEqual({ env: 'local', days: 30 })
  })

  it.each(['local', 'staging', 'production'] as const)('accepts --env %s', (env) => {
    expect(parseSpendArgs(['--env', env]).env).toBe(env)
  })

  it('reads --days as a whole number of days', () => {
    expect(parseSpendArgs(['--days', '7']).days).toBe(7)
    expect(parseSpendArgs(['--days', '1']).days).toBe(1)
  })

  it('accepts --flag=value as well as --flag value, in any order', () => {
    expect(parseSpendArgs(['--days=14', '--env=staging'])).toEqual({ env: 'staging', days: 14 })
  })

  it.each([
    ['an unknown flag', ['--verbose']],
    ['a bare word', ['staging']],
    ['an unknown environment', ['--env', 'prod']],
    ['an environment in capitals', ['--env', 'Production']],
    ['--env without a value', ['--env']],
    ['--days without a value', ['--days']],
    ['0 days', ['--days', '0']],
    ['a negative number of days', ['--days', '-3']],
    ['a fractional number of days', ['--days', '1.5']],
    ['a non-numeric number of days', ['--days', 'week']],
  ])('throws for %s', (_label, argv) => {
    expect(() => parseSpendArgs(argv)).toThrow()
  })
})

describe('formatSpend', () => {
  const rows = [
    row(ago(HOUR), { job: 'research', model: 'claude-haiku-5-5', cost_micros: 1_000_000 }),
    row(ago(2 * HOUR), { job: 'analysis', model: 'claude-sonnet-5-5', cost_micros: 239_999 }),
    row(ago(3 * DAY), { job: 'research', model: 'claude-haiku-5-5', cost_micros: 2_500_000 }),
    row(ago(10 * DAY), { job: 'analysis', model: 'claude-sonnet-5-5', cost_micros: 4_000_000 }),
  ]

  describe('totals', () => {
    it('gives today, the last 7 days and the last 30 days in dollars with 2 decimals', () => {
      const output = formatSpend(rows, NOW)

      expect(lineMatching(output, /today/i)).toContain('$1.24')
      expect(lineMatching(output, /\b7[- ]day/i)).toContain('$3.74')
      expect(lineMatching(output, /\b30[- ]day/i)).toContain('$7.74')
    })

    it('names the length of the last period when it is not 30 days', () => {
      const output = formatSpend(rows, NOW, 14)

      expect(lineMatching(output, /\b14[- ]day/i)).toContain('$7.74')
      expect(output).not.toMatch(/\b30[- ]day/i)
    })

    it.each([
      [1_234_999, '$1.23'],
      [1_235_001, '$1.24'],
      [1_239_999, '$1.24'],
      [4_999, '$0.00'],
      [5_001, '$0.01'],
    ])('rounds %i micros to the nearest cent: %s', (micros, dollars) => {
      const output = formatSpend([row(ago(HOUR), { cost_micros: micros })], NOW)

      expect(lineMatching(output, /today/i)).toContain(dollars)
    })

    it('counts a call made exactly at midnight UTC as today, and one a millisecond before as yesterday', () => {
      const atMidnight = formatSpend([row(MIDNIGHT.getTime())], NOW)
      const justBefore = formatSpend([row(MIDNIGHT.getTime() - 1)], NOW)

      expect(lineMatching(atMidnight, /today/i)).toContain('$1.00')
      expect(lineMatching(justBefore, /today/i)).toContain('$0.00')
      expect(lineMatching(justBefore, /\b7[- ]day/i)).toContain('$1.00')
    })

    it('shows $0.00 everywhere, and does not fail, when nothing was spent', () => {
      const output = formatSpend([], NOW)

      for (const pattern of [/today/i, /\b7[- ]day/i, /\b30[- ]day/i]) expect(lineMatching(output, pattern)).toContain('$0.00')
    })
  })

  describe('unsettled reservations', () => {
    it('shows what they are holding and how many there are, without adding them to the totals', () => {
      const output = formatSpend([row(ago(HOUR), { cost_micros: 1_000_000 }), held(ago(2 * HOUR), 2_500_000), held(ago(3 * HOUR), 400_000)], NOW)

      expect(lineMatching(output, /held by unsettled reservations/i)).toContain('$2.90 (2)')
      expect(lineMatching(output, /today/i)).toContain('$1.00')
      expect(lineMatching(output, /\b7[- ]day/i)).toContain('$1.00')
      expect(lineMatching(output, /\b30[- ]day/i)).toContain('$1.00')
    })

    it('keeps them out of the job and model lines', () => {
      const output = formatSpend([held(ago(HOUR), 9_000_000, { job: 'analysis', model: 'claude-opus-5-5' })], NOW)

      expect(output).not.toMatch(/claude-opus-5-5/)
    })

    it('shows $0.00 (0) when nothing is held', () => {
      expect(lineMatching(formatSpend([row(ago(HOUR))], NOW), /held by unsettled reservations/i)).toContain('$0.00 (0)')
    })
  })

  describe('by job and model', () => {
    it('has one line per job and model with the cost of all the rows given, in dollars', () => {
      const output = formatSpend(rows, NOW)

      expect(lineMatching(output, /research.*claude-haiku-5-5|claude-haiku-5-5.*research/)).toContain('$3.50')
      expect(lineMatching(output, /analysis.*claude-sonnet-5-5|claude-sonnet-5-5.*analysis/)).toContain('$4.24')
    })

    it('keeps one job on two models apart', () => {
      const output = formatSpend(
        [row(ago(HOUR), { cost_micros: 100_000 }), row(ago(HOUR), { model: 'claude-opus-5-5', cost_micros: 3_000_000 })],
        NOW,
      )

      expect(lineMatching(output, /research.*claude-haiku-5-5|claude-haiku-5-5.*research/)).toContain('$0.10')
      expect(lineMatching(output, /research.*claude-opus-5-5|claude-opus-5-5.*research/)).toContain('$3.00')
    })
  })
})

describe('buildQuery', () => {
  const SINCE = 1_900_000_000_000

  it('is one SELECT of the settled and still-reserved calls from ai_usage created at or after the cutoff, with the columns formatSpend reads', () => {
    const query = buildQuery(SINCE)

    expect(query).toMatch(/^\s*select\b/i)
    expect(query).toMatch(/\bfrom\s+ai_usage\b/i)
    expect(query).toMatch(/status\s+in\s*\(\s*'settled'\s*,\s*'reserved'\s*\)/i)
    expect(query).not.toMatch(/'released'/i)
    expect(query).toMatch(new RegExp(`created_at\\s*>=\\s*${SINCE}\\b`))
    for (const column of ['created_at', 'job', 'model', 'status', 'cost_micros', 'estimate_micros']) expect(query).toContain(column)
  })

  it('changes nothing: no statement other than SELECT, and no second statement', () => {
    const query = buildQuery(SINCE)

    expect(query).not.toMatch(/\b(insert|update|delete|drop|alter|create|replace|pragma|attach)\b/i)
    expect(query.replace(/;\s*$/, '')).not.toContain(';')
  })

  it('writes the cutoff as the plain integer it was given', () => {
    expect(buildQuery(0)).toMatch(/created_at\s*>=\s*0\b/)
    expect(buildQuery(1_900_000_000_123)).toContain('1900000000123')
  })

  // wrangler d1 execute --command takes SQL text with no parameter binding, so the number is written into the
  // statement. Refusing anything that is not an integer is what keeps a bad value from becoming SQL.
  it.each([
    ['a fraction', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['text that would be SQL', "0; DROP TABLE ai_usage; --" as unknown as number],
    ['a numeric string', '1900000000000' as unknown as number],
    ['undefined', undefined as unknown as number],
  ])('refuses %s as the cutoff, because it is written into the SQL text', (_label, value) => {
    expect(() => buildQuery(value)).toThrow()
  })
})
