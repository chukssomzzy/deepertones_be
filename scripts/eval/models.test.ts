import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { AI_JOBS, type AiJob } from '../../src/providers/anthropic/ai-spend.provider'
import { DEFAULT_MODELS } from './models'
import { JOBS, parseArgs } from './score'

const config = ts.parseConfigFileTextToJson('wrangler.jsonc', readFileSync('wrangler.jsonc', 'utf8')).config as { vars: Record<string, string> }

// The same mapping as the container: vision covers image-check, recognize and read-label; judge covers same-product.
const VAR_OF_JOB: Record<AiJob, string> = {
  research: 'ANTHROPIC_MODEL_RESEARCH',
  analysis: 'ANTHROPIC_MODEL_ANALYSIS',
  'same-product': 'ANTHROPIC_MODEL_JUDGE',
  'image-check': 'ANTHROPIC_MODEL_VISION',
  recognize: 'ANTHROPIC_MODEL_VISION',
  'read-label': 'ANTHROPIC_MODEL_VISION',
}

describe('the eval default models', () => {
  it.each(AI_JOBS)('match wrangler.jsonc for the %s job', (job) => {
    expect(DEFAULT_MODELS[job]).toBe(config.vars[VAR_OF_JOB[job]])
  })

  it('cover exactly the jobs there are', () => {
    expect(Object.keys(DEFAULT_MODELS).sort()).toEqual([...AI_JOBS].sort())
  })
})

describe('the eval jobs', () => {
  it('are the AiJob list', () => {
    expect([...JOBS]).toEqual([...AI_JOBS])
  })

  it.each(AI_JOBS)('accept --model for the %s job', (job) => {
    expect(parseArgs(['--model', `${job}=x`]).models).toEqual({ [job]: 'x' })
  })
})
