import { describe, expect, it } from 'vitest'
import { DEFAULT_SNAPSHOT_PATH } from './routine-snapshot'
import { DEFAULT_MODELS } from './models'
import { parseLabelsArgs, parseOutcomesArgs, parseRoutineArgs, parseSheetArgs, requirePricedModel, resolveRoutineJudges, resolveRoutineModels, RoutineUsageError, USAGE } from './routine-args'

// The arguments of `npm run eval:routine`. Strict on purpose, as `eval:catalog`'s are: a misspelt flag must stop the run before it spends money. Every
// refusal is a RoutineUsageError, which the CLI turns into exit 2. Accepts `--flag value` and `--flag=value`.

describe('parseRoutineArgs: defaults', () => {
  it('measures the holdout with a 5 dollar cap, the default snapshot, no labels, and the run picks its own out directory', () => {
    expect(parseRoutineArgs([])).toEqual({
      set: 'holdout',
      limit: undefined,
      models: {},
      labels: undefined,
      maxUsd: 5,
      maxGrounding: 40,
      judges: ['haiku', 'opus'],
      snapshot: DEFAULT_SNAPSHOT_PATH,
      outDir: undefined,
      compare: undefined,
    })
  })

  it('reads every flag together, in any order', () => {
    const argv = ['--compare', 'prev/report.json', '--out-dir', 'out/run-1', '--snapshot', 'snap.xlsx', '--max-usd', '3', '--labels', 'v1', '--model', 'write-routine=claude-opus-5', '--limit', '2', '--set', 'dev', '--max-grounding', '12', '--judges', 'haiku']

    expect(parseRoutineArgs(argv)).toEqual({
      set: 'dev',
      limit: 2,
      models: { 'write-routine': 'claude-opus-5' },
      labels: 'v1',
      maxUsd: 3,
      maxGrounding: 12,
      judges: ['haiku'],
      snapshot: 'snap.xlsx',
      outDir: 'out/run-1',
      compare: 'prev/report.json',
    })
  })
})

describe('parseRoutineArgs: the flags', () => {
  it('takes --set dev and --set holdout, as --set X and --set=X', () => {
    expect(parseRoutineArgs(['--set', 'dev']).set).toBe('dev')
    expect(parseRoutineArgs(['--set=dev']).set).toBe('dev')
    expect(parseRoutineArgs(['--set', 'holdout']).set).toBe('holdout')
    expect(parseRoutineArgs(['--set=holdout']).set).toBe('holdout')
  })

  it('takes --limit as a whole number of at least 1', () => {
    expect(parseRoutineArgs(['--limit', '3']).limit).toBe(3)
    expect(parseRoutineArgs(['--limit=1']).limit).toBe(1)
  })

  it.each([
    [['--max-usd', '1'], 1],
    [['--max-usd=0.5'], 0.5],
    [['--max-usd', '12'], 12],
  ])('takes an explicit --max-usd over the default (%j)', (argv, maxUsd) => {
    expect(parseRoutineArgs(argv).maxUsd).toBe(maxUsd)
  })

  it('takes --model JOB=MODEL, repeatable, for any job the Claude client knows', () => {
    expect(parseRoutineArgs(['--model', 'write-routine=claude-opus-5', '--model', 'judge-draft=claude-sonnet-5-5']).models).toEqual({
      'write-routine': 'claude-opus-5',
      'judge-draft': 'claude-sonnet-5-5',
    })
    expect(parseRoutineArgs(['--model=write-routine=claude-opus-5']).models).toEqual({ 'write-routine': 'claude-opus-5' })
  })

  it('takes --labels as a label set version', () => {
    expect(parseRoutineArgs(['--labels', 'v1']).labels).toBe('v1')
    expect(parseRoutineArgs(['--labels=v2-derm']).labels).toBe('v2-derm')
  })

  it('takes --snapshot, --out-dir and --compare as paths', () => {
    expect(parseRoutineArgs(['--snapshot', 'elsewhere/snap.xlsx']).snapshot).toBe('elsewhere/snap.xlsx')
    expect(parseRoutineArgs(['--out-dir=out/run-2']).outDir).toBe('out/run-2')
    expect(parseRoutineArgs(['--compare=prev.json']).compare).toBe('prev.json')
  })
})

describe('parseRoutineArgs: the hint set, the grounding cap and the judge models (D2)', () => {
  it('takes --set hints, as --set hints and --set=hints, when a label set is given', () => {
    expect(parseRoutineArgs(['--set', 'hints', '--labels', 'v1']).set).toBe('hints')
    expect(parseRoutineArgs(['--set=hints', '--labels=v1']).set).toBe('hints')
  })

  it('refuses --set hints with no --labels: the hint set is built from a label set, so there is nothing to run without one (the CLI turns this into exit 2 and the message)', () => {
    expect(() => parseRoutineArgs(['--set', 'hints'])).toThrow(RoutineUsageError)
    expect(() => parseRoutineArgs(['--set', 'hints'])).toThrow(/labels/i)
    expect(() => parseRoutineArgs(['--set', 'hints', '--limit', '2'])).toThrow(RoutineUsageError)
  })

  it('still needs no labels for dev and holdout', () => {
    expect(() => parseRoutineArgs(['--set', 'dev'])).not.toThrow()
    expect(() => parseRoutineArgs(['--set', 'holdout'])).not.toThrow()
  })

  // 0 is allowed on purpose: it runs the whole eval without the page-support checks.
  it.each([
    ['--max-grounding', '1', 1],
    ['--max-grounding=40', undefined, 40],
    ['--max-grounding', '0', 0],
    ['--max-grounding', '200', 200],
  ] as const)('takes %s %s as a whole number of fetch calls, 0 included', (flag, value, expected) => {
    expect(parseRoutineArgs(value === undefined ? [flag] : [flag, value]).maxGrounding).toBe(expected)
  })

  it.each([['1.5'], ['-1'], ['many'], ['1e2']])('refuses --max-grounding %s', (value) => {
    expect(() => parseRoutineArgs(['--max-grounding', value])).toThrow(RoutineUsageError)
  })

  it('refuses --max-grounding given twice, or with no value', () => {
    expect(() => parseRoutineArgs(['--max-grounding', '1', '--max-grounding', '2'])).toThrow(RoutineUsageError)
    expect(() => parseRoutineArgs(['--max-grounding'])).toThrow(RoutineUsageError)
  })

  it('takes --model for the page-support judge (the rubric judges are chosen with --judges, not --model)', () => {
    expect(parseRoutineArgs(['--model=judge-grounding=claude-haiku-5-5']).models).toEqual({ 'judge-grounding': 'claude-haiku-5-5' })
  })

  it('names the hint set, the grounding cap and the rubric judges in the usage, so a refusal shows them', () => {
    expect(USAGE).toContain('hints')
    expect(USAGE).toContain('--max-grounding')
    expect(USAGE).toContain('--judges')
    expect(() => parseRoutineArgs(['--set', 'main'])).toThrow(/--max-grounding/)
  })
})

describe('resolveRoutineModels: the models an eval:routine run uses', () => {
  it('keeps the page-support judge on Haiku, like the catalog eval\'s page judge', () => {
    expect(resolveRoutineModels({})['judge-grounding']).toBe('claude-haiku-5-5')
  })

  it('leaves every other job at the eval default, and lets --model move any of them', () => {
    const models = resolveRoutineModels({ 'write-routine': 'claude-opus-5-5' })

    expect(models['write-routine']).toBe('claude-opus-5-5')
    for (const job of Object.keys(DEFAULT_MODELS) as (keyof typeof DEFAULT_MODELS)[]) {
      // judge-routine is left out on purpose: the rubric judges now come from --judges, and what this table holds for that job is not specified.
      if (job !== 'judge-routine' && job !== 'write-routine') expect(models[job], job).toBe(DEFAULT_MODELS[job])
    }
    expect(Object.keys(models).sort()).toEqual(Object.keys(DEFAULT_MODELS).sort())
  })

  it('does not move the shared default: the product\'s own table (which models.test.ts holds to wrangler.jsonc) stays on Haiku for the judge', () => {
    resolveRoutineModels({})

    expect(DEFAULT_MODELS['judge-routine']).toBe('claude-haiku-5-5')
  })
})

// --judges (#152, PR 4c): the rubric judge is Haiku or Opus and nothing else, both by default, and a model never judges its own routines. The writer is the
// model `--model write-routine=...` names, else the eval default (Sonnet), so parseRoutineArgs resolves it to make the check. A hint run (--set hints) does not
// judge, so the check does not apply to it.

describe('parseRoutineArgs: --judges', () => {
  it('judges with haiku and then opus by default', () => {
    expect(parseRoutineArgs([]).judges).toEqual(['haiku', 'opus'])
  })

  it.each([
    [['--judges', 'opus'], ['opus']],
    [['--judges', 'haiku'], ['haiku']],
    [['--judges', 'haiku,opus'], ['haiku', 'opus']],
    [['--judges=haiku,opus'], ['haiku', 'opus']],
    [['--judges=opus,haiku'], ['opus', 'haiku']],
  ])('takes %j as the judges %j, in the order given', (argv, judges) => {
    expect(parseRoutineArgs(argv).judges).toEqual(judges)
  })

  it.each([
    ['an unknown name', 'sonnet'],
    ['a model id instead of a name', 'claude-haiku-5-5'],
    ['a name in capitals', 'Opus'],
    ['a known name beside an unknown one', 'haiku,sonnet'],
    ['a trailing comma, which is an empty name', 'haiku,'],
    ['a leading comma', ',opus'],
    ['an empty name between two', 'haiku,,opus'],
    ['a list that is only a comma', ','],
    ['a duplicate', 'haiku,haiku'],
    ['a duplicate after another name', 'haiku,opus,haiku'],
  ])('refuses %s (--judges %s)', (_label, list) => {
    expect(() => parseRoutineArgs(['--judges', list])).toThrow(RoutineUsageError)
    expect(() => parseRoutineArgs(['--judges', list])).toThrow(/npm run eval:routine/)
  })

  it('refuses an empty list, given as --judges= or as an empty word', () => {
    expect(() => parseRoutineArgs(['--judges='])).toThrow(RoutineUsageError)
    expect(() => parseRoutineArgs(['--judges', ''])).toThrow(RoutineUsageError)
  })

  it('refuses --judges given twice', () => {
    expect(() => parseRoutineArgs(['--judges', 'haiku', '--judges', 'opus'])).toThrow(RoutineUsageError)
  })

  it('names the two judges in the usage, so a refusal shows them', () => {
    expect(USAGE).toMatch(/haiku/)
    expect(USAGE).toMatch(/opus/)
  })
})

describe('parseRoutineArgs: a model never judges its own routines', () => {
  it('lets the default Sonnet writer be judged by both judges', () => {
    expect(() => parseRoutineArgs([])).not.toThrow()
    expect(parseRoutineArgs(['--model', 'write-routine=claude-sonnet-5-5']).judges).toEqual(['haiku', 'opus'])
  })

  it('refuses the Opus writer with the default list, with the fixed message, and says to pass --judges haiku', () => {
    const argv = ['--model', 'write-routine=claude-opus-5-5']

    expect(() => parseRoutineArgs(argv)).toThrow(RoutineUsageError)
    expect(() => parseRoutineArgs(argv)).toThrow(/a model never judges its own routines/)
    expect(() => parseRoutineArgs(argv)).toThrow(/--judges haiku/)
  })

  it('refuses the Opus writer with --judges opus, and with --judges haiku,opus', () => {
    expect(() => parseRoutineArgs(['--model', 'write-routine=claude-opus-5-5', '--judges', 'opus'])).toThrow(/a model never judges its own routines/)
    expect(() => parseRoutineArgs(['--judges', 'haiku,opus', '--model=write-routine=claude-opus-5-5'])).toThrow(RoutineUsageError)
  })

  it('lets the Opus writer be judged by Haiku: the other side of the line', () => {
    expect(parseRoutineArgs(['--model', 'write-routine=claude-opus-5-5', '--judges', 'haiku']).judges).toEqual(['haiku'])
  })

  it('refuses the Haiku writer with --judges haiku, and with the default list', () => {
    expect(() => parseRoutineArgs(['--model', 'write-routine=claude-haiku-5-5', '--judges', 'haiku'])).toThrow(RoutineUsageError)
    expect(() => parseRoutineArgs(['--model', 'write-routine=claude-haiku-5-5', '--judges', 'haiku'])).toThrow(/a model never judges its own routines/)
    expect(() => parseRoutineArgs(['--model', 'write-routine=claude-haiku-5-5'])).toThrow(/a model never judges its own routines/)
  })

  it('lets the Haiku writer be judged by Opus: a bigger model judging a smaller one is fine', () => {
    expect(parseRoutineArgs(['--model', 'write-routine=claude-haiku-5-5', '--judges', 'opus']).judges).toEqual(['opus'])
  })

  it('lets a writer that is neither judge (any other model id) be judged by both', () => {
    expect(parseRoutineArgs(['--model', 'write-routine=claude-sonnet-5-5', '--judges', 'haiku,opus']).judges).toEqual(['haiku', 'opus'])
  })

  it('does not apply to a hint run, which asks the writer alone and judges nothing', () => {
    expect(() => parseRoutineArgs(['--set', 'hints', '--labels', 'v1', '--model', 'write-routine=claude-opus-5-5'])).not.toThrow()
  })
})

describe('parseRoutineArgs: --model judge-routine is no longer accepted', () => {
  it.each([['judge-routine=claude-sonnet-5-5'], ['judge-routine=x'], ['judge-routine=claude-opus-5-5']])('refuses --model %s and points to --judges', (value) => {
    expect(() => parseRoutineArgs(['--model', value])).toThrow(RoutineUsageError)
    expect(() => parseRoutineArgs(['--model', value])).toThrow(/--judges/)
  })

  it('refuses it beside other --model flags, and in the --model=JOB=MODEL form', () => {
    expect(() => parseRoutineArgs(['--model', 'write-routine=claude-sonnet-5-5', '--model', 'judge-routine=x'])).toThrow(/--judges/)
    expect(() => parseRoutineArgs(['--model=judge-routine=x'])).toThrow(/--judges/)
  })
})

describe('resolveRoutineJudges: the judges of a run, with their models', () => {
  it('maps haiku to claude-haiku-5-5 and opus to claude-opus-5-5, in the order given', () => {
    expect(resolveRoutineJudges(['haiku', 'opus'])).toEqual([
      { name: 'haiku', model: 'claude-haiku-5-5' },
      { name: 'opus', model: 'claude-opus-5-5' },
    ])
    expect(resolveRoutineJudges(['opus'])).toEqual([{ name: 'opus', model: 'claude-opus-5-5' }])
    expect(resolveRoutineJudges(['opus', 'haiku']).map((j) => j.name)).toEqual(['opus', 'haiku'])
  })

  it('gives the judges of the default args', () => {
    expect(resolveRoutineJudges(parseRoutineArgs([]).judges).map((j) => j.model)).toEqual(['claude-haiku-5-5', 'claude-opus-5-5'])
  })
})

describe('parseRoutineArgs: refusals, each a RoutineUsageError that shows the usage', () => {
  it.each([
    ['an unknown flag', ['--mode', 'draft']],
    ['a misspelt flag', ['--lable', 'v1']],
    ['a bare word', ['holdout']],
    ['--set with an unknown set', ['--set', 'main']],
    ['--set all, which is for the label sheet and not a run', ['--set', 'all']],
    ['--max-grounding that is not a whole number', ['--max-grounding', '2.5']],
    ['--limit of zero', ['--limit', '0']],
    ['--limit that is not a whole number', ['--limit', '1.5']],
    ['--limit that is not a number', ['--limit', 'many']],
    ['a negative --limit', ['--limit=-2']],
    ['--max-usd of zero', ['--max-usd', '0']],
    ['--max-usd that is not a number', ['--max-usd', 'lots']],
    ['a negative --max-usd', ['--max-usd=-1']],
    ['--model with no job', ['--model', 'claude-opus-5']],
    ['--model with an unknown job', ['--model', 'no-such-job=claude-opus-5']],
    ['--model with no model', ['--model', 'write-routine=']],
    ['--labels that would leave the labels folder', ['--labels', '../v1']],
    ['--labels with a path in it', ['--labels', 'a/b']],
    ['--labels with a file extension', ['--labels', 'v1.json']],
    ['--set given twice', ['--set', 'dev', '--set', 'holdout']],
    ['--limit given twice', ['--limit', '1', '--limit', '2']],
    ['--labels given twice', ['--labels', 'v1', '--labels', 'v2']],
  ])('refuses %s', (_label, argv) => {
    expect(() => parseRoutineArgs(argv)).toThrow(RoutineUsageError)
    expect(() => parseRoutineArgs(argv)).toThrow(/npm run eval:routine/)
  })

  it.each(['--set', '--limit', '--model', '--labels', '--max-usd', '--snapshot', '--out-dir', '--compare', '--judges'])('refuses %s with no value, followed by a flag, or with an empty value', (flag) => {
    expect(() => parseRoutineArgs([flag])).toThrow(RoutineUsageError)
    expect(() => parseRoutineArgs([flag, '--limit', '2'])).toThrow(RoutineUsageError)
    expect(() => parseRoutineArgs([`${flag}=`])).toThrow(RoutineUsageError)
  })
})

// The two helpers around `eval:routine`: `eval:routine:sheet` (writes the label sheet) and `eval:routine:labels` (reads the filled sheet).

describe('parseSheetArgs', () => {
  it('makes the sheet of all the cases from the default snapshot, into the gitignored folder', () => {
    expect(parseSheetArgs([])).toEqual({ set: 'all', snapshot: DEFAULT_SNAPSHOT_PATH, out: 'eval-data/routine/label-sheet-all.xlsx' })
  })

  it('takes --set, --snapshot and --out, as --flag value or --flag=value, and names the default sheet after the set', () => {
    expect(parseSheetArgs(['--set', 'dev'])).toMatchObject({ set: 'dev', out: 'eval-data/routine/label-sheet-dev.xlsx' })
    expect(parseSheetArgs(['--set=holdout', '--snapshot', 's.xlsx', '--out=o.xlsx'])).toEqual({ set: 'holdout', snapshot: 's.xlsx', out: 'o.xlsx' })
  })

  it.each([['--set', 'main'], ['--mode', 'dev'], ['--out'], ['--out', '--set']])('refuses %j', (...argv) => {
    expect(() => parseSheetArgs(argv)).toThrow(RoutineUsageError)
  })

  it('refuses a flag given twice', () => {
    expect(() => parseSheetArgs(['--set', 'dev', '--set', 'all'])).toThrow(RoutineUsageError)
  })
})

describe('parseLabelsArgs', () => {
  it('needs the sheet and the version, and makes the status provisional unless told otherwise', () => {
    expect(parseLabelsArgs(['--sheet', 'filled.xlsx', '--version', 'v1'])).toEqual({ sheet: 'filled.xlsx', version: 'v1', status: 'provisional' })
    expect(parseLabelsArgs(['--version=v2', '--sheet=f.xlsx', '--status=clinical'])).toEqual({ sheet: 'f.xlsx', version: 'v2', status: 'clinical' })
  })

  it.each([
    [['--version', 'v1']],
    [['--sheet', 'f.xlsx']],
    [['--sheet', 'f.xlsx', '--version', '../v1']],
    [['--sheet', 'f.xlsx', '--version', 'v1', '--status', 'final']],
    [['--sheet', 'f.xlsx', '--version', 'v1', 'extra']],
  ])('refuses %j', (argv) => {
    expect(() => parseLabelsArgs(argv)).toThrow(RoutineUsageError)
  })
})

describe('requirePricedModel for the write-routine job', () => {
  it('lets a model with a price through', () => {
    expect(() => requirePricedModel('write-routine', 'claude-sonnet-5-5')).not.toThrow()
  })

  it('refuses a model with no price before any case is run, as a usage error that says so (not as a rejected key)', () => {
    expect(() => requirePricedModel('write-routine', 'claude-no-such-model')).toThrow(RoutineUsageError)
    expect(() => requirePricedModel('write-routine', 'claude-no-such-model')).toThrow(/No price is known for model "claude-no-such-model"/)
  })
})

describe('parseOutcomesArgs', () => {
  it('needs the counts file, the label set to start from and the version to write', () => {
    expect(parseOutcomesArgs(['--counts', 'counts.json', '--labels', 'v1', '--out', 'v2'])).toEqual({ counts: 'counts.json', labels: 'v1', out: 'v2' })
    expect(parseOutcomesArgs(['--out=v2', '--labels=v1', '--counts=c.json'])).toEqual({ counts: 'c.json', labels: 'v1', out: 'v2' })
  })

  it.each([
    [['--labels', 'v1', '--out', 'v2']],
    [['--counts', 'c.json', '--out', 'v2']],
    [['--counts', 'c.json', '--labels', 'v1']],
    [['--counts', 'c.json', '--labels', 'v1', '--out', '../v2']],
    [['--counts', 'c.json', '--labels', 'a/b', '--out', 'v2']],
    [['--counts', 'c.json', '--labels', 'v1', '--out', 'v1']],
    [['--counts', 'c.json', '--labels', 'v1', '--out', 'v2', '--status', 'clinical']],
    [['--counts', 'c.json', '--counts', 'd.json', '--labels', 'v1', '--out', 'v2']],
  ])('refuses %j', (argv) => {
    expect(() => parseOutcomesArgs(argv)).toThrow(RoutineUsageError)
    expect(() => parseOutcomesArgs(argv)).toThrow(/eval:routine:outcomes/)
  })
})
