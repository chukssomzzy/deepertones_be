import { describe, expect, it } from 'vitest'
import { parseExportArgs, parseUploadArgs } from './args'

// The command lines of `npm run catalog:export` and `npm run catalog:upload`, as pure functions (the way scripts/secrets/args is tested).
// Both are strict on purpose: a typo must stop the run, never be guessed at, because an upload changes what users are recommended.

describe('parseExportArgs', () => {
  it.each([
    [['--env', 'local'], { env: 'local', out: undefined, force: false }],
    [['--env=staging'], { env: 'staging', out: undefined, force: false }],
    [['--env', 'production', '--out', 'live.xlsx'], { env: 'production', out: 'live.xlsx', force: false }],
    [['--out=exports/live.xlsx', '--env=staging'], { env: 'staging', out: 'exports/live.xlsx', force: false }],
    [['--env', 'staging', '--force'], { env: 'staging', out: undefined, force: true }],
    [['--force', '--out', 'live.xlsx', '--env=production'], { env: 'production', out: 'live.xlsx', force: true }],
  ])('accepts %j', (argv, expected) => {
    expect(parseExportArgs(argv)).toEqual(expected)
  })

  it.each([
    ['no --env', []],
    ['only --out', ['--out', 'live.xlsx']],
    ['--env without a value', ['--env']],
    ['--env followed by a flag', ['--env', '--out', 'live.xlsx']],
    ['an empty --env=', ['--env=']],
    ['an unknown environment', ['--env', 'prod']],
    ['--out without a value', ['--env', 'staging', '--out']],
    ['an empty --out=', ['--env', 'staging', '--out=']],
    ['a misspelled flag', ['--env', 'staging', '--outt', 'live.xlsx']],
    ['--apply, which only an upload has', ['--env', 'staging', '--apply']],
    ['a bare word', ['staging']],
    ['a repeated --env', ['--env', 'staging', '--env', 'production']],
    ['--force given a value', ['--env', 'staging', '--force=yes']],
    ['a repeated --out', ['--env', 'staging', '--out', 'a.xlsx', '--out', 'b.xlsx']],
  ])('throws a usage message for %s', (_label, argv) => {
    expect(() => parseExportArgs(argv)).toThrow(/Usage: npm run catalog:export/)
  })
})

describe('parseUploadArgs', () => {
  it.each([
    [['edited.xlsx', '--env', 'staging', '--by', 'Tolu'], { file: 'edited.xlsx', env: 'staging', by: 'Tolu', apply: false }],
    [['--env=local', '--by=Tolu Adeyemi', 'edited.xlsx'], { file: 'edited.xlsx', env: 'local', by: 'Tolu Adeyemi', apply: false }],
    [['edited.xlsx', '--env', 'production', '--by', 'Tolu', '--apply'], { file: 'edited.xlsx', env: 'production', by: 'Tolu', apply: true }],
    [['--apply', '--by', 'Tolu', '--env', 'staging', 'exports/edited.xlsx'], { file: 'exports/edited.xlsx', env: 'staging', by: 'Tolu', apply: true }],
  ])('accepts %j', (argv, expected) => {
    expect(parseUploadArgs(argv)).toEqual(expected)
  })

  it('is a dry run unless --apply is given', () => {
    expect(parseUploadArgs(['edited.xlsx', '--env', 'staging', '--by', 'Tolu']).apply).toBe(false)
  })

  it.each([
    ['no file', ['--env', 'staging', '--by', 'Tolu']],
    ['two files', ['a.xlsx', 'b.xlsx', '--env', 'staging', '--by', 'Tolu']],
    ['no --env', ['edited.xlsx', '--by', 'Tolu']],
    ['an unknown environment', ['edited.xlsx', '--env', 'prod', '--by', 'Tolu']],
    ['--env without a value', ['edited.xlsx', '--by', 'Tolu', '--env']],
    ['no --by', ['edited.xlsx', '--env', 'staging']],
    ['--by without a value', ['edited.xlsx', '--env', 'staging', '--by']],
    ['--by followed by a flag', ['edited.xlsx', '--env', 'staging', '--by', '--apply']],
    ['an empty --by=', ['edited.xlsx', '--env', 'staging', '--by=']],
    ['a --by of only spaces', ['edited.xlsx', '--env', 'staging', '--by', '   ']],
    ['a --by of 81 characters', ['edited.xlsx', '--env', 'staging', '--by', 'x'.repeat(81)]],
    ['a misspelled flag', ['edited.xlsx', '--env', 'staging', '--by', 'Tolu', '--aply']],
    ['--apply given a value', ['edited.xlsx', '--env', 'staging', '--by', 'Tolu', '--apply=true']],
    ['a repeated --env', ['edited.xlsx', '--env', 'staging', '--env', 'production', '--by', 'Tolu']],
    ['a repeated --by', ['edited.xlsx', '--env', 'staging', '--by', 'Tolu', '--by', 'Chidi']],
  ])('throws a usage message for %s', (_label, argv) => {
    expect(() => parseUploadArgs(argv)).toThrow(/Usage: npm run catalog:upload/)
  })

  it('accepts a --by of exactly 1 character and of exactly 80, the limits the server enforces on uploadedBy', () => {
    expect(parseUploadArgs(['edited.xlsx', '--env', 'staging', '--by', 'T']).by).toBe('T')
    expect(parseUploadArgs(['edited.xlsx', '--env', 'staging', '--by', 'x'.repeat(80)]).by).toBe('x'.repeat(80))
  })
})
