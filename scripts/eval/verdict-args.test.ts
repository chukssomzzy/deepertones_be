import { describe, expect, it } from 'vitest'
import { DEFAULT_MODELS } from './models'
import { DEFAULT_VERDICT_SNAPSHOT_PATH } from './verdict-reference'
import { parseVerdictArgs, parseVerdictRescoreArgs, resolveVerdictModels, VERDICT_RESCORE_USAGE, VERDICT_USAGE, VerdictUsageError } from './verdict-args'

// The arguments of `npm run eval:verdict` and `npm run eval:verdict:rescore`. Strict on purpose, as eval:routine's are: a misspelt flag must stop the run before it
// spends money. Every refusal is a VerdictUsageError whose message ends with the usage, which the CLI prints before it exits 2. `--flag value` and `--flag=value` both work.
//
// Shapes assumed (the contract this file pins):
//   parseVerdictArgs(argv): { set: 'main' | 'holdout'; limit: number | undefined; labels: string | undefined; snapshot: string; root: string; maxUsd: number;
//                             models: { 'fit-verdict'?: string }; outDir: string; floorOnly: boolean }
//   --model takes ONLY the fit-verdict job (the one AI job this eval runs), and only a model that has a known price, so the spend cap can count its calls: the parser
//   itself refuses an unpriced one (message names the model and says "price").
//   resolveVerdictModels(overrides): Record<AiJob, string>   the eval defaults, then the overrides (fit-verdict is on Sonnet by default)
//   parseVerdictRescoreArgs(argv): { report: string; labels: string; root: string; outDir: string }   (--report and --labels are needed; --root and --out-dir have the
//   same defaults as the run's; nothing else is accepted: a rescore makes no call, so it takes no --max-usd, --model or --floor-only)
//   VERDICT_USAGE and VERDICT_RESCORE_USAGE are strings starting "Usage: npm run eval:verdict" and "Usage: npm run eval:verdict:rescore".

const refusal = (argv: string[]): VerdictUsageError => {
  try {
    parseVerdictArgs(argv)
  } catch (error) {
    expect(error).toBeInstanceOf(VerdictUsageError)
    return error as VerdictUsageError
  }
  throw new Error(`parseVerdictArgs(${JSON.stringify(argv)}) should have been refused`)
}

describe('parseVerdictArgs: defaults', () => {
  it('measures the main set with a 3 dollar cap, the default root, snapshot and out directory, no labels, and a real fit run', () => {
    expect(parseVerdictArgs([])).toEqual({
      set: 'main',
      limit: undefined,
      labels: undefined,
      snapshot: DEFAULT_VERDICT_SNAPSHOT_PATH,
      root: 'eval-data/verdict',
      maxUsd: 3,
      models: {},
      outDir: '.eval',
      floorOnly: false,
    })
  })

  it('reads every flag together, in any order', () => {
    const argv = ['--floor-only', '--out-dir', 'out/run-1', '--root', 'elsewhere/verdict', '--snapshot', 'snap.xlsx', '--max-usd', '1.5', '--labels', 'v2', '--limit', '4', '--model', 'fit-verdict=claude-opus-5-5', '--set', 'holdout']

    expect(parseVerdictArgs(argv)).toEqual({
      set: 'holdout',
      limit: 4,
      labels: 'v2',
      snapshot: 'snap.xlsx',
      root: 'elsewhere/verdict',
      maxUsd: 1.5,
      models: { 'fit-verdict': 'claude-opus-5-5' },
      outDir: 'out/run-1',
      floorOnly: true,
    })
  })
})

describe('parseVerdictArgs: the flags', () => {
  it('takes --set main and --set holdout, as --set X and --set=X', () => {
    expect(parseVerdictArgs(['--set', 'main']).set).toBe('main')
    expect(parseVerdictArgs(['--set=main']).set).toBe('main')
    expect(parseVerdictArgs(['--set', 'holdout']).set).toBe('holdout')
    expect(parseVerdictArgs(['--set=holdout']).set).toBe('holdout')
  })

  it('takes --limit as a whole number of at least 1', () => {
    expect(parseVerdictArgs(['--limit', '3']).limit).toBe(3)
    expect(parseVerdictArgs(['--limit=1']).limit).toBe(1)
  })

  it.each([
    [['--max-usd', '1'], 1],
    [['--max-usd=0.5'], 0.5],
    [['--max-usd', '12'], 12],
  ])('takes an explicit --max-usd over the default (%j)', (argv, maxUsd) => {
    expect(parseVerdictArgs(argv).maxUsd).toBe(maxUsd)
  })

  it('takes --labels as a label version', () => {
    expect(parseVerdictArgs(['--labels', 'v1']).labels).toBe('v1')
    expect(parseVerdictArgs(['--labels=v2-derm']).labels).toBe('v2-derm')
  })

  it('takes --snapshot, --root and --out-dir as paths', () => {
    expect(parseVerdictArgs(['--snapshot', 'elsewhere/snap.xlsx']).snapshot).toBe('elsewhere/snap.xlsx')
    expect(parseVerdictArgs(['--root=elsewhere/verdict']).root).toBe('elsewhere/verdict')
    expect(parseVerdictArgs(['--out-dir=out/run-2']).outDir).toBe('out/run-2')
  })

  it('takes --floor-only as a switch with no value, and it can sit before another flag', () => {
    expect(parseVerdictArgs(['--floor-only']).floorOnly).toBe(true)
    expect(parseVerdictArgs(['--floor-only', '--set', 'holdout'])).toMatchObject({ floorOnly: true, set: 'holdout' })
  })

  it.each(['claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-opus-5-5'])('takes --model fit-verdict=%s, a model with a price', (model) => {
    expect(parseVerdictArgs(['--model', `fit-verdict=${model}`]).models).toEqual({ 'fit-verdict': model })
    expect(parseVerdictArgs([`--model=fit-verdict=${model}`]).models).toEqual({ 'fit-verdict': model })
  })
})

describe('parseVerdictArgs: refusals', () => {
  it.each([
    ['an unknown flag', ['--sett', 'main']],
    ['a flag of eval:routine that this eval does not have', ['--judges', 'haiku']],
    ['a word that is not a flag', ['main']],
    ['a flag with no value', ['--set']],
    ['a flag whose value is another flag', ['--set', '--limit']],
    ['an empty value', ['--labels=']],
    ['a flag given twice', ['--limit', '1', '--limit', '2']],
    ['a switch given twice', ['--floor-only', '--floor-only']],
    ['a switch given a value', ['--floor-only=true']],
    ['an unknown set', ['--set', 'dev']],
    ['the other eval\'s set name', ['--set', 'hints']],
    ['a limit of 0', ['--limit', '0']],
    ['a limit that is not whole', ['--limit', '1.5']],
    ['a limit that is not a number', ['--limit', 'many']],
    ['a labels version that is not a plain name', ['--labels', '../v1']],
    ['a cap of 0 dollars', ['--max-usd', '0']],
    ['a negative cap', ['--max-usd', '-1']],
    ['a cap that is not a number', ['--max-usd', 'lots']],
    ['a --model with no job', ['--model', 'claude-opus-5-5']],
    ['a --model with an empty model', ['--model', 'fit-verdict=']],
    ['a --model for a job that is not the fit judge', ['--model', 'write-routine=claude-sonnet-5-5']],
    ['a --model for a job that does not exist', ['--model', 'nonsense=claude-sonnet-5-5']],
  ])('refuses %s, and says the usage', (_what, argv) => {
    const error = refusal(argv)

    expect(error.message).toContain(VERDICT_USAGE)
  })

  it('refuses a fit model that has no known price, before any money is spent, naming the model', () => {
    const error = refusal(['--model', 'fit-verdict=claude-no-such-model'])

    expect(error.message).toContain('claude-no-such-model')
    expect(error.message).toMatch(/price/i)
    expect(error.message).toContain(VERDICT_USAGE)
  })

  it('says in the usage every flag the command takes', () => {
    for (const flag of ['--set', '--limit', '--labels', '--snapshot', '--root', '--max-usd', '--model', '--out-dir', '--floor-only']) expect(VERDICT_USAGE, flag).toContain(flag)
    expect(VERDICT_USAGE.startsWith('Usage: npm run eval:verdict')).toBe(true)
  })
})

describe('resolveVerdictModels', () => {
  it('runs the fit judge on Sonnet unless told otherwise, and leaves every other job on its default', () => {
    expect(resolveVerdictModels({})).toEqual(DEFAULT_MODELS)
    expect(resolveVerdictModels({})['fit-verdict']).toBe('claude-sonnet-5-5')
  })

  it('takes the override for the fit judge', () => {
    expect(resolveVerdictModels({ 'fit-verdict': 'claude-opus-5-5' })['fit-verdict']).toBe('claude-opus-5-5')
    expect(resolveVerdictModels({ 'fit-verdict': 'claude-opus-5-5' }).research).toBe(DEFAULT_MODELS.research)
  })
})

describe('parseVerdictRescoreArgs', () => {
  it('needs the report and the labels, and has the run\'s defaults for the root and the out directory', () => {
    expect(parseVerdictRescoreArgs(['--report', 'out/verdict-x/report.json', '--labels', 'v2'])).toEqual({ report: 'out/verdict-x/report.json', labels: 'v2', root: 'eval-data/verdict', outDir: '.eval' })
  })

  it('takes --root and --out-dir, as --flag value and --flag=value', () => {
    expect(parseVerdictRescoreArgs(['--report=r.json', '--labels=v1', '--root', 'elsewhere', '--out-dir=o'])).toEqual({ report: 'r.json', labels: 'v1', root: 'elsewhere', outDir: 'o' })
  })

  it.each([
    ['no report', ['--labels', 'v1']],
    ['no labels', ['--report', 'r.json']],
    ['nothing', []],
    ['a labels version that is not a plain name', ['--report', 'r.json', '--labels', '../v1']],
    ['a spend cap, since a rescore spends nothing', ['--report', 'r.json', '--labels', 'v1', '--max-usd', '1']],
    ['a model, since a rescore calls none', ['--report', 'r.json', '--labels', 'v1', '--model', 'fit-verdict=claude-opus-5-5']],
    ['--floor-only, which is a property of the saved run', ['--report', 'r.json', '--labels', 'v1', '--floor-only']],
    ['a set, which is the saved run\'s', ['--report', 'r.json', '--labels', 'v1', '--set', 'holdout']],
    ['a flag twice', ['--report', 'a.json', '--report', 'b.json', '--labels', 'v1']],
    ['an unknown flag', ['--report', 'r.json', '--labels', 'v1', '--verbose', 'yes']],
  ])('refuses %s, and says the rescore usage', (_what, argv) => {
    let error: unknown
    try {
      parseVerdictRescoreArgs(argv)
    } catch (e) {
      error = e
    }

    expect(error).toBeInstanceOf(VerdictUsageError)
    expect((error as VerdictUsageError).message).toContain(VERDICT_RESCORE_USAGE)
    expect(VERDICT_RESCORE_USAGE.startsWith('Usage: npm run eval:verdict:rescore')).toBe(true)
  })
})
