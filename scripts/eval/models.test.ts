import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { AI_JOBS, type AiJob } from '../../src/providers/anthropic/ai-spend.provider'
import { DEFAULT_MODELS } from './models'
import { JOBS, parseArgs } from './score'

const config = ts.parseConfigFileTextToJson('wrangler.jsonc', readFileSync('wrangler.jsonc', 'utf8')).config as { vars: Record<string, string> }

// The same mapping as the container: vision covers image-check, recognize and read-label; recognize-shelf has its own variable so the eval can move it alone; judge covers same-product, split-name, read-goal, read-mentions and judge-draft.
const VAR_OF_JOB: Record<AiJob, string> = {
  research: 'ANTHROPIC_MODEL_RESEARCH',
  analysis: 'ANTHROPIC_MODEL_ANALYSIS',
  'same-product': 'ANTHROPIC_MODEL_JUDGE',
  'image-check': 'ANTHROPIC_MODEL_VISION',
  recognize: 'ANTHROPIC_MODEL_VISION',
  'recognize-shelf': 'ANTHROPIC_MODEL_RECOGNIZE_SHELF',
  'read-label': 'ANTHROPIC_MODEL_VISION',
  'split-name': 'ANTHROPIC_MODEL_JUDGE',
  'read-goal': 'ANTHROPIC_MODEL_JUDGE',
  'read-mentions': 'ANTHROPIC_MODEL_JUDGE',
  'draft-catalog-row': 'ANTHROPIC_MODEL_RESEARCH',
  'judge-draft': 'ANTHROPIC_MODEL_JUDGE',
}

describe('the eval default models', () => {
  it.each(AI_JOBS)('match wrangler.jsonc for the %s job', (job) => {
    expect(DEFAULT_MODELS[job]).toBe(config.vars[VAR_OF_JOB[job]])
  })

  it('run the typed-name split on the cheap judge model', () => {
    expect(AI_JOBS).toContain('split-name')
    expect(DEFAULT_MODELS['split-name']).toBe('claude-haiku-5-5')
  })

  it('run the goal read on the cheap judge model: it sorts words for the app, it is not text the user reads', () => {
    expect(AI_JOBS).toContain('read-goal')
    expect(DEFAULT_MODELS['read-goal']).toBe('claude-haiku-5-5')
  })

  it('run the shelf recognizer on the cheap model by default, like recognize', () => {
    expect(DEFAULT_MODELS['recognize-shelf']).toBe('claude-haiku-5-5')
    expect(DEFAULT_MODELS['recognize-shelf']).toBe(DEFAULT_MODELS.recognize)
  })

  it('run the mention read on the cheap judge model: it names what the person wrote for the app, it is not text the user reads', () => {
    expect(AI_JOBS).toContain('read-mentions')
    expect((DEFAULT_MODELS as Record<string, string>)['read-mentions']).toBe('claude-haiku-5-5')
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
