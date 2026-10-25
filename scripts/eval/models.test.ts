import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { AI_JOBS, type AiJob } from '../../src/providers/anthropic/ai-spend.provider'
import { DEFAULT_MODELS } from './models'
import { JOBS, parseArgs } from './score'

const config = ts.parseConfigFileTextToJson('wrangler.jsonc', readFileSync('wrangler.jsonc', 'utf8')).config as { vars: Record<string, string> }

// The same mapping as the container: vision covers image-check, recognize and read-label; recognize-shelf has its own variable so the eval can move it alone; judge covers same-product, split-name, read-goal, read-mentions, judge-draft, judge-routine, judge-grounding and label-routine; write-routine has its own variable, because the routine's words reach users.
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
  'judge-routine': 'ANTHROPIC_MODEL_JUDGE',
  'label-routine': 'ANTHROPIC_MODEL_JUDGE',
  'judge-grounding': 'ANTHROPIC_MODEL_JUDGE',
  'write-routine': 'ANTHROPIC_MODEL_ROUTINE',
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

  it('run the routine writer on Sonnet: its words reach users, so it is not on the cheap model', () => {
    expect(AI_JOBS).toContain('write-routine')
    expect((DEFAULT_MODELS as Record<string, string>)['write-routine']).toBe('claude-sonnet-5-5')
  })

  // judge-routine and judge-grounding are eval-only jobs on the shared judge variable. The eval:routine RUN moves judge-routine to Opus by itself
  // (see resolveRoutineModels in routine-args.test.ts); this table is the default that must match wrangler.jsonc.
  it('run the routine rubric judge and the page-support judge on the cheap judge model here, as wrangler.jsonc has them', () => {
    expect(AI_JOBS).toContain('judge-routine')
    expect(AI_JOBS).toContain('judge-grounding')
    expect((DEFAULT_MODELS as Record<string, string>)['judge-routine']).toBe('claude-haiku-5-5')
    expect((DEFAULT_MODELS as Record<string, string>)['judge-grounding']).toBe('claude-haiku-5-5')
  })

  // label-routine is the eval-only job that labels the routine eval's cases as a dermatologist would. Like judge-routine it sits on the shared judge variable, so this table
  // (held to wrangler.jsonc) has it on Haiku; `npm run eval:routine:auto-label` moves it to Opus at run level (see parseAutoLabelArgs in routine-args.test.ts).
  it('run the routine labeller on the cheap judge model here, as wrangler.jsonc has it: the labelling command moves it to Opus by itself', () => {
    expect(AI_JOBS).toContain('label-routine')
    expect((DEFAULT_MODELS as Record<string, string>)['label-routine']).toBe('claude-haiku-5-5')
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
