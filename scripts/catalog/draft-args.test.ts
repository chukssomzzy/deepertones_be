import { describe, expect, it } from 'vitest'
import { parseArgs } from './draft-args'
import { DraftInputError } from './draft-input-error'

// `npm run catalog:draft -- in.xlsx --out out.xlsx --max-usd 2 [--countries NG,GB]`. Strict on purpose, like the eval's: a misspelt flag must stop the
// run before it spends money, and a draft never overwrites the file it was made from, so there is no default for --out.
const USAGE = /Usage: npm run catalog:draft/

describe('catalog:draft parseArgs', () => {
  it.each([
    [['in.xlsx', '--out', 'out.xlsx', '--max-usd', '2'], { input: 'in.xlsx', out: 'out.xlsx', maxUsd: 2, countries: undefined }],
    [['in.xlsx', '--out', 'out.xlsx', '--max-usd', '2', '--countries', 'NG,GB'], { input: 'in.xlsx', out: 'out.xlsx', maxUsd: 2, countries: ['NG', 'GB'] }],
    [['in.xlsx', '--out=out.xlsx', '--max-usd=0.5', '--countries=NG'], { input: 'in.xlsx', out: 'out.xlsx', maxUsd: 0.5, countries: ['NG'] }],
    [['--out', 'out.xlsx', '--max-usd', '1.25', 'in.xlsx'], { input: 'in.xlsx', out: 'out.xlsx', maxUsd: 1.25, countries: undefined }],
    [['in.xlsx', '--countries', 'NG,GB,GH', '--out', 'out.xlsx'], { input: 'in.xlsx', out: 'out.xlsx', maxUsd: 2, countries: ['NG', 'GB', 'GH'] }],
    [['/tmp/some dir/in.xlsx', '--out', '/tmp/other/out.xlsx'], { input: '/tmp/some dir/in.xlsx', out: '/tmp/other/out.xlsx', maxUsd: 2, countries: undefined }],
  ])('accepts %j', (argv, expected) => {
    expect(parseArgs(argv)).toEqual(expected)
  })

  it('caps the spend at 2 dollars when --max-usd is not given, as the catalog eval does', () => {
    expect(parseArgs(['in.xlsx', '--out', 'out.xlsx']).maxUsd).toBe(2)
  })

  it('has no country filter when --countries is not given, so every active country is drafted', () => {
    expect(parseArgs(['in.xlsx', '--out', 'out.xlsx']).countries).toBeUndefined()
  })

  it.each([
    ['no arguments', []],
    ['no input file', ['--out', 'out.xlsx']],
    ['no --out', ['in.xlsx']],
    ['two input files', ['a.xlsx', 'b.xlsx', '--out', 'out.xlsx']],
    ['--out equal to the input, which would overwrite it', ['in.xlsx', '--out', 'in.xlsx']],
    ['--out that is the input written another way', ['in.xlsx', '--out', './in.xlsx']],
    ['--out that is the input under another folder name', ['dir/in.xlsx', '--out', 'dir/../dir/in.xlsx']],
    ['--out without a value', ['in.xlsx', '--out']],
    ['--out followed by a flag', ['in.xlsx', '--out', '--max-usd', '2']],
    ['an empty --out=', ['in.xlsx', '--out=']],
    ['a repeated --out', ['in.xlsx', '--out', 'a.xlsx', '--out', 'b.xlsx']],
    ['an unknown flag', ['in.xlsx', '--out', 'out.xlsx', '--force']],
    ['a misspelt flag', ['in.xlsx', '--out', 'out.xlsx', '--max-usd-per-row', '2']],
    ['--max-usd of 0', ['in.xlsx', '--out', 'out.xlsx', '--max-usd', '0']],
    ['a negative --max-usd', ['in.xlsx', '--out', 'out.xlsx', '--max-usd', '-1']],
    ['a --max-usd that is not a number', ['in.xlsx', '--out', 'out.xlsx', '--max-usd', 'two']],
    ['a --max-usd with a unit', ['in.xlsx', '--out', 'out.xlsx', '--max-usd', '$2']],
    ['--max-usd without a value', ['in.xlsx', '--out', 'out.xlsx', '--max-usd']],
    ['a lower-case country code', ['in.xlsx', '--out', 'out.xlsx', '--countries', 'ng']],
    ['a three-letter country code', ['in.xlsx', '--out', 'out.xlsx', '--countries', 'NGA']],
    ['a trailing comma in --countries', ['in.xlsx', '--out', 'out.xlsx', '--countries', 'NG,']],
    ['an empty item in --countries', ['in.xlsx', '--out', 'out.xlsx', '--countries', 'NG,,GB']],
    ['a country listed twice', ['in.xlsx', '--out', 'out.xlsx', '--countries', 'NG,NG']],
    ['--countries without a value', ['in.xlsx', '--out', 'out.xlsx', '--countries']],
  ])('throws a usage message for %s', (_label, argv) => {
    expect(() => parseArgs(argv)).toThrow(USAGE)
  })

  it('throws a DraftInputError, so the shell may print its message', () => {
    expect(() => parseArgs(['in.xlsx'])).toThrow(DraftInputError)
    expect(() => parseArgs(['in.xlsx', '--out', 'out.xlsx', '--force'])).toThrow(DraftInputError)
  })
})
