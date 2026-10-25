import { describe, expect, it } from 'vitest'
import { parseArgs } from './draft-args'
import { DraftInputError } from './draft-input-error'

// `npm run catalog:draft -- in.xlsx --out out.xlsx --max-usd 2 [--countries NG,GB] [--passes N]`. Strict on purpose, like the eval's: a misspelt flag must stop the
// run before it spends money, and a draft never overwrites the file it was made from, so there is no default for --out.
const USAGE = /Usage: npm run catalog:draft/

describe('catalog:draft parseArgs', () => {
  it.each([
    [['in.xlsx', '--out', 'out.xlsx', '--max-usd', '2'], { input: 'in.xlsx', out: 'out.xlsx', maxUsd: 2, countries: undefined, passes: 3 }],
    [['in.xlsx', '--out', 'out.xlsx', '--max-usd', '2', '--countries', 'NG,GB'], { input: 'in.xlsx', out: 'out.xlsx', maxUsd: 2, countries: ['NG', 'GB'], passes: 3 }],
    [['in.xlsx', '--out=out.xlsx', '--max-usd=0.5', '--countries=NG'], { input: 'in.xlsx', out: 'out.xlsx', maxUsd: 0.5, countries: ['NG'], passes: 3 }],
    [['--out', 'out.xlsx', '--max-usd', '1.25', 'in.xlsx'], { input: 'in.xlsx', out: 'out.xlsx', maxUsd: 1.25, countries: undefined, passes: 3 }],
    [['in.xlsx', '--countries', 'NG,GB,GH', '--out', 'out.xlsx'], { input: 'in.xlsx', out: 'out.xlsx', maxUsd: 2, countries: ['NG', 'GB', 'GH'], passes: 3 }],
    [['/tmp/some dir/in.xlsx', '--out', '/tmp/other/out.xlsx'], { input: '/tmp/some dir/in.xlsx', out: '/tmp/other/out.xlsx', maxUsd: 2, countries: undefined, passes: 3 }],
  ])('accepts %j', (argv, expected) => {
    expect(parseArgs(argv)).toEqual(expected)
  })

  it('caps the spend at 2 dollars when --max-usd is not given, as the catalog eval does', () => {
    expect(parseArgs(['in.xlsx', '--out', 'out.xlsx']).maxUsd).toBe(2)
  })

  it.each([
    [['in.xlsx', '--out', 'out.xlsx', '--passes', '2'], 2],
    [['in.xlsx', '--out', 'out.xlsx', '--passes=4'], 4],
    [['--passes', '1', 'in.xlsx', '--out', 'out.xlsx'], 1],
    [['in.xlsx', '--out', 'out.xlsx', '--passes', '5', '--max-usd', '1', '--countries', 'NG'], 5],
  ])('reads --passes from %j as %d, the lowest and highest being 1 and 5', (argv, passes) => {
    expect(parseArgs(argv).passes).toBe(passes)
  })

  it('makes 3 passes when --passes is not given', () => {
    expect(parseArgs(['in.xlsx', '--out', 'out.xlsx']).passes).toBe(3)
  })

  it('names --passes in its usage message, so a person can find the flag', () => {
    expect(() => parseArgs([])).toThrow(/--passes/)
  })

  it.each([
    ['0, below the lowest', ['in.xlsx', '--out', 'out.xlsx', '--passes', '0']],
    ['6, above the highest', ['in.xlsx', '--out', 'out.xlsx', '--passes', '6']],
    ['a large number', ['in.xlsx', '--out', 'out.xlsx', '--passes', '100']],
    ['a negative number', ['in.xlsx', '--out', 'out.xlsx', '--passes', '-1']],
    ['a fraction', ['in.xlsx', '--out', 'out.xlsx', '--passes', '2.5']],
    ['text', ['in.xlsx', '--out', 'out.xlsx', '--passes', 'three']],
    ['a number with a unit', ['in.xlsx', '--out', 'out.xlsx', '--passes', '3x']],
    ['an exponent', ['in.xlsx', '--out', 'out.xlsx', '--passes', '1e1']],
    ['no value', ['in.xlsx', '--out', 'out.xlsx', '--passes']],
    ['an empty --passes=', ['in.xlsx', '--out', 'out.xlsx', '--passes=']],
    ['a value that is a flag', ['in.xlsx', '--out', 'out.xlsx', '--passes', '--max-usd', '2']],
  ])('refuses --passes of %s, naming the flag', (_label, argv) => {
    expect(() => parseArgs(argv)).toThrow(/--passes/)
    expect(() => parseArgs(argv)).toThrow(USAGE)
    // ...as a flag it knows with a value it refuses, not as one it has never heard of.
    expect(() => parseArgs(argv)).not.toThrow(/Unrecognised/)
  })

  it('refuses --passes given twice', () => {
    expect(() => parseArgs(['in.xlsx', '--out', 'out.xlsx', '--passes', '2', '--passes', '3'])).toThrow(/--passes/)
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
