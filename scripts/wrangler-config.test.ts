import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// Env blocks do not inherit `triggers`, so each deployed environment must restate the cron.
const config = ts.parseConfigFileTextToJson('wrangler.jsonc', readFileSync('wrangler.jsonc', 'utf8')).config as {
  triggers?: { crons?: string[] }
  env: Record<string, { triggers?: { crons?: string[] } }>
}

// minute hour * * *  (fixed time, every day)
const DAILY = /^\d{1,2} \d{1,2} \* \* \*$/

describe('wrangler.jsonc cron triggers', () => {
  const places: [string, string[] | undefined][] = [
    ['top level', config.triggers?.crons],
    ['env.staging', config.env.staging?.triggers?.crons],
    ['env.production', config.env.production?.triggers?.crons],
  ]

  it.each(places)('%s has exactly one daily schedule', (_, crons) => {
    expect(crons).toHaveLength(1)
    expect(crons![0]).toMatch(DAILY)
  })
})
