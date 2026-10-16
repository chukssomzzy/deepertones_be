/*
 * The pure parts of `npm run ai:spend`: reading the command line, the query for the ai_usage table, and the report.
 * Nothing here runs wrangler or prints, so all of it is tested (spend.test.ts).
 */

export type SpendEnv = 'local' | 'staging' | 'production'
export type SpendArgs = { env: SpendEnv; days: number }

/**
 * One call, in the table's own column names. A settled row carries its cost; a reserved one (not settled or released yet,
 * possibly stuck after a crash) carries only its estimate, which the cap is still holding.
 */
export type SpendRow = {
  created_at: number
  job: string
  model: string
  status: 'settled' | 'reserved'
  cost_micros: number | null
  estimate_micros: number
}

const ENVS: readonly SpendEnv[] = ['local', 'staging', 'production']
export const SPEND_USAGE = 'Usage: npm run ai:spend -- [--env local|staging|production] [--days N]'

const DAY = 24 * 60 * 60 * 1000

/** Strict on purpose, like the other scripts. Accepts `--flag value` and `--flag=value`. */
export const parseSpendArgs = (argv: string[]): SpendArgs => {
  let env: SpendEnv = 'local'
  let days = 30
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const equals = arg.startsWith('--') ? arg.indexOf('=') : -1
    const flag = equals === -1 ? arg : arg.slice(0, equals)
    if (flag !== '--env' && flag !== '--days') throw new Error(`Unrecognised argument "${arg}". ${SPEND_USAGE}`)

    const value = equals === -1 ? argv[++i] : arg.slice(equals + 1)
    if (value === undefined || value === '' || value.startsWith('-')) throw new Error(`${flag} needs a value. ${SPEND_USAGE}`)

    if (flag === '--env') {
      if (!ENVS.includes(value as SpendEnv)) throw new Error(`Unknown environment "${value}". ${SPEND_USAGE}`)
      env = value as SpendEnv
    } else {
      if (!/^\d+$/.test(value) || Number(value) < 1) throw new Error(`--days must be a whole number of at least 1. ${SPEND_USAGE}`)
      days = Number(value)
    }
  }
  return { env, days }
}

/**
 * The one statement the runner sends: settled and still-reserved calls reserved at or after `sinceMs`. `wrangler d1 execute --command`
 * takes SQL text with no parameter binding, so the number is written into the statement, and anything that is not
 * an integer is refused so a bad value can never become SQL.
 */
export const buildQuery = (sinceMs: number): string => {
  if (typeof sinceMs !== 'number' || !Number.isInteger(sinceMs)) throw new Error('The cutoff must be an integer number of milliseconds')
  return `select created_at, job, model, status, cost_micros, estimate_micros from ai_usage where status in ('settled', 'reserved') and created_at >= ${sinceMs} order by created_at`
}

/** Dollars to the nearest cent. Micros are millionths of a dollar. */
const dollars = (micros: number): string => `$${(Math.round(micros / 10_000) / 100).toFixed(2)}`

const total = (rows: SpendRow[], since: number): number =>
  rows.reduce((sum, row) => sum + (row.created_at >= since ? (row.cost_micros ?? 0) : 0), 0)

/**
 * What the settled calls cost: today (since midnight UTC), the last 7 days and the last `days`, then each job and model.
 * The totals are settled cost only; money still held by unsettled reservations is shown on its own line.
 */
export const formatSpend = (allRows: SpendRow[], now: Date, days = 30): string => {
  const rows = allRows.filter((row) => row.status === 'settled')
  const held = allRows.filter((row) => row.status === 'reserved')
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const periods: [string, number][] = [['today', midnight], ['last 7 days', now.getTime() - 7 * DAY]]
  if (days !== 7) periods.push([`last ${days} days`, now.getTime() - days * DAY])

  const lines = ['AI spend (days are UTC)']
  for (const [label, since] of periods) lines.push(`  ${label.padEnd(14)} ${dollars(total(rows, since))}`)

  lines.push(`  held by unsettled reservations: ${dollars(held.reduce((sum, row) => sum + row.estimate_micros, 0))} (${held.length})`)

  const groups = new Map<string, { job: string; model: string; calls: number; micros: number }>()
  for (const row of rows) {
    const key = `${row.job}\u0000${row.model}`
    const group = groups.get(key) ?? { job: row.job, model: row.model, calls: 0, micros: 0 }
    group.calls += 1
    group.micros += row.cost_micros ?? 0
    groups.set(key, group)
  }
  lines.push('', 'By job and model')
  if (groups.size === 0) lines.push('  no calls recorded')
  const width = Math.max(0, ...[...groups.values()].map((g) => g.job.length))
  for (const { job, model, calls, micros } of [...groups.values()].sort((a, b) => b.micros - a.micros)) {
    lines.push(`  ${job.padEnd(width)}  ${model}  ${String(calls).padStart(5)} calls  ${dollars(micros)}`)
  }
  return lines.join('\n')
}
