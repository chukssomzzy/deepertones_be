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

// Env blocks do not inherit bindings, vars or secrets either, so each block restates the catalog's.
type Block = {
  r2_buckets?: { binding: string; bucket_name: string }[]
  vars?: Record<string, string>
  secrets?: { required?: string[] }
}
const catalogConfig = config as unknown as Block & { env: Record<string, Block> }

const blocks: [string, Block | undefined, { bucket: string; publicUrl: string; dailyBudgetUsd: string }][] = [
  ['top level', catalogConfig, { bucket: 'deepertones-assets', publicUrl: '', dailyBudgetUsd: '1' }],
  ['env.staging', catalogConfig.env.staging, { bucket: 'deepertones-assets', publicUrl: 'https://assets.deepertones.com', dailyBudgetUsd: '5' }],
  ['env.production', catalogConfig.env.production, { bucket: 'deepertones-assets', publicUrl: 'https://assets.deepertones.com', dailyBudgetUsd: '30' }],
]

describe('wrangler.jsonc product catalog config', () => {
  it.each(blocks)('%s binds the catalog image bucket as CATALOG_IMAGES', (_, block, expected) => {
    expect(block?.r2_buckets?.find((b) => b.binding === 'CATALOG_IMAGES')?.bucket_name).toBe(expected.bucket)
  })

  // Cost-effective by default (Haiku for research, vision and judging), a better model for the text users read.
  it.each(blocks)('%s sets the cheap model for research, vision and the same-product judge, and the better one for the analysis', (_, block) => {
    expect(block?.vars?.ANTHROPIC_MODEL_RESEARCH).toBe('claude-haiku-5-5')
    expect(block?.vars?.ANTHROPIC_MODEL_VISION).toBe('claude-haiku-5-5')
    expect(block?.vars?.ANTHROPIC_MODEL_JUDGE).toBe('claude-haiku-5-5')
    expect(block?.vars?.ANTHROPIC_MODEL_ANALYSIS).toBe('claude-sonnet-5-5')
  })

  it.each(blocks)('%s no longer sets the single ANTHROPIC_MODEL', (_, block) => {
    expect(block?.vars).not.toHaveProperty('ANTHROPIC_MODEL')
  })

  it.each(blocks)('%s sets the daily AI spend cap in USD', (_, block, expected) => {
    expect(block?.vars?.AI_DAILY_BUDGET_USD).toBe(expected.dailyBudgetUsd)
  })

  it.each(blocks)('%s sets where catalog images are served from', (_, block, expected) => {
    expect(block?.vars?.CATALOG_IMAGES_PUBLIC_URL).toBe(expected.publicUrl)
  })

  it.each(blocks)('%s requires ANTHROPIC_API_KEY as a secret', (_, block) => {
    expect(block?.secrets?.required).toContain('ANTHROPIC_API_KEY')
  })
})
