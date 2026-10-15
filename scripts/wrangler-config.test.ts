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

const blocks: [string, Block | undefined, { bucket: string; publicUrl: string }][] = [
  ['top level', catalogConfig, { bucket: 'deepertones-catalog-images-local', publicUrl: '' }],
  ['env.staging', catalogConfig.env.staging, { bucket: 'deepertones-catalog-images-staging', publicUrl: 'https://images.staging.deepertones.com' }],
  ['env.production', catalogConfig.env.production, { bucket: 'deepertones-catalog-images-production', publicUrl: 'https://images.deepertones.com' }],
]

describe('wrangler.jsonc product catalog config', () => {
  it.each(blocks)('%s binds the catalog image bucket as CATALOG_IMAGES', (_, block, expected) => {
    expect(block?.r2_buckets?.find((b) => b.binding === 'CATALOG_IMAGES')?.bucket_name).toBe(expected.bucket)
  })

  it.each(blocks)('%s sets the Claude model', (_, block) => {
    expect(block?.vars?.ANTHROPIC_MODEL).toBe('claude-sonnet-5-5')
  })

  it.each(blocks)('%s sets where catalog images are served from', (_, block, expected) => {
    expect(block?.vars?.CATALOG_IMAGES_PUBLIC_URL).toBe(expected.publicUrl)
  })

  it.each(blocks)('%s requires ANTHROPIC_API_KEY as a secret', (_, block) => {
    expect(block?.secrets?.required).toContain('ANTHROPIC_API_KEY')
  })
})
