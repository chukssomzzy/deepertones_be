import { describe, expect, it } from 'vitest'
import { DEFAULT_SNAPSHOT_PATH } from './routine-snapshot'
import { parseLabelsArgs, parseRoutineArgs, parseSheetArgs, requirePricedWriterModel, RoutineUsageError } from './routine-args'

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
      snapshot: DEFAULT_SNAPSHOT_PATH,
      outDir: undefined,
      compare: undefined,
    })
  })

  it('reads every flag together, in any order', () => {
    const argv = ['--compare', 'prev/report.json', '--out-dir', 'out/run-1', '--snapshot', 'snap.xlsx', '--max-usd', '3', '--labels', 'v1', '--model', 'write-routine=claude-opus-5', '--limit', '2', '--set', 'dev']

    expect(parseRoutineArgs(argv)).toEqual({
      set: 'dev',
      limit: 2,
      models: { 'write-routine': 'claude-opus-5' },
      labels: 'v1',
      maxUsd: 3,
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

describe('parseRoutineArgs: refusals, each a RoutineUsageError that shows the usage', () => {
  it.each([
    ['an unknown flag', ['--mode', 'draft']],
    ['a misspelt flag', ['--lable', 'v1']],
    ['a bare word', ['holdout']],
    ['--set with an unknown set', ['--set', 'main']],
    ['--set all, which is for the label sheet and not a run', ['--set', 'all']],
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

  it.each(['--set', '--limit', '--model', '--labels', '--max-usd', '--snapshot', '--out-dir', '--compare'])('refuses %s with no value, followed by a flag, or with an empty value', (flag) => {
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

describe('requirePricedWriterModel', () => {
  it('lets a model with a price through', () => {
    expect(() => requirePricedWriterModel('claude-sonnet-5-5')).not.toThrow()
  })

  it('refuses a model with no price before any case is run, as a usage error that says so (not as a rejected key)', () => {
    expect(() => requirePricedWriterModel('claude-no-such-model')).toThrow(RoutineUsageError)
    expect(() => requirePricedWriterModel('claude-no-such-model')).toThrow(/No price is known for model "claude-no-such-model"/)
  })
})
