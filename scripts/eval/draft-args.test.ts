import { describe, expect, it } from 'vitest'
import { AI_JOBS } from '../../src/providers/anthropic/ai-spend.provider'
import { parseArgs } from './score'

// `--mode draft` of `npm run eval:catalog`. The older modes' arguments are pinned in score.test.ts; this adds the draft mode and the one flag only it takes.

describe('parseArgs: --mode draft', () => {
  it('accepts --mode draft, and --mode=draft', () => {
    expect(parseArgs(['--mode', 'draft']).mode).toBe('draft')
    expect(parseArgs(['--mode=draft']).mode).toBe('draft')
  })

  it('caps spend at 10 dollars unless told otherwise, since a draft run drafts and then judges every value on a page', () => {
    expect(parseArgs(['--mode', 'draft']).maxUsd).toBe(10)
  })

  it.each([
    [['--mode', 'draft', '--max-usd', '1'], 1],
    [['--max-usd', '1', '--mode', 'draft'], 1],
    [['--max-usd=0.5', '--mode=draft'], 0.5],
    [['--mode', 'draft', '--max-usd', '12'], 12],
  ])('takes an explicit --max-usd over the default, in any order (%j)', (argv, maxUsd) => {
    expect(parseArgs(argv).maxUsd).toBe(maxUsd)
  })

  it('keeps the 2 dollar default for every other mode', () => {
    expect(parseArgs([]).maxUsd).toBe(2)
    for (const mode of ['analysis', 'research', 'goals', 'mentions', 'all']) expect(parseArgs(['--mode', mode]).maxUsd, mode).toBe(2)
  })

  it('applies --limit to the draft mode', () => {
    expect(parseArgs(['--mode', 'draft', '--limit', '3'])).toMatchObject({ mode: 'draft', limit: 3 })
  })

  it('takes --model overrides, including for the judge job', () => {
    expect(parseArgs(['--mode', 'draft', '--model', 'judge-draft=claude-sonnet-5-5', '--model', 'draft-catalog-row=claude-haiku-5-5']).models).toEqual({
      'judge-draft': 'claude-sonnet-5-5',
      'draft-catalog-row': 'claude-haiku-5-5',
    })
    expect(AI_JOBS).toContain('judge-draft')
  })

  it('reads --out-dir, as --out-dir DIR and --out-dir=DIR', () => {
    expect(parseArgs(['--mode', 'draft', '--out-dir', 'out/run-1']).outDir).toBe('out/run-1')
    expect(parseArgs(['--mode=draft', '--out-dir=out/run-2']).outDir).toBe('out/run-2')
  })

  it('leaves outDir undefined when it is not given: the run picks .eval/draft-<timestamp>', () => {
    expect(parseArgs(['--mode', 'draft']).outDir).toBeUndefined()
  })

  it('reads every flag together, in any order', () => {
    expect(parseArgs(['--out-dir', 'o', '--limit', '2', '--max-usd', '3', '--mode', 'draft'])).toEqual({ mode: 'draft', limit: 2, maxUsd: 3, models: {}, set: 'main', outDir: 'o' })
  })

  it('measures the main set unless told otherwise, and takes --set main|holdout|dev as --set X and --set=X', () => {
    expect(parseArgs(['--mode', 'draft']).set).toBe('main')
    expect(parseArgs(['--mode', 'draft', '--set', 'main']).set).toBe('main')
    expect(parseArgs(['--mode', 'draft', '--set', 'holdout']).set).toBe('holdout')
    expect(parseArgs(['--set=holdout', '--mode=draft']).set).toBe('holdout')
    expect(parseArgs(['--mode', 'draft', '--set', 'dev']).set).toBe('dev')
    expect(parseArgs(['--set=dev', '--mode=draft']).set).toBe('dev')
  })

  it('has no set for the other modes, which have no draft set to choose', () => {
    expect(parseArgs([]).set).toBeUndefined()
    expect(parseArgs(['--mode', 'research']).set).toBeUndefined()
  })

  it.each([
    ['--set without a value', ['--mode', 'draft', '--set']],
    ['--set followed by a flag', ['--mode', 'draft', '--set', '--limit', '2']],
    ['--set with an unknown set', ['--mode', 'draft', '--set', 'other']],
    ['--set with an empty value', ['--mode', 'draft', '--set=']],
    ['--set without --mode draft: it would be silently ignored', ['--set', 'holdout']],
    ['--set with another mode', ['--mode', 'research', '--set', 'holdout']],
    ['--set dev without --mode draft', ['--set', 'dev']],
  ])('throws for %s', (_label, argv) => {
    expect(() => parseArgs(argv)).toThrow()
  })

  it.each([
    ['--out-dir without a value', ['--mode', 'draft', '--out-dir']],
    ['--out-dir followed by a flag', ['--mode', 'draft', '--out-dir', '--limit', '2']],
    ['--out-dir with an empty value', ['--mode', 'draft', '--out-dir=']],
    ['--out-dir without --mode draft: it would be silently ignored', ['--out-dir', 'out']],
    ['--out-dir with another mode', ['--mode', 'research', '--out-dir', 'out']],
  ])('throws for %s', (_label, argv) => {
    expect(() => parseArgs(argv)).toThrow()
  })
})
