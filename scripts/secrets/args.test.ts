import { describe, expect, it } from 'vitest'
import { findDuplicateKeys, parseArgs, parseEnvFile, planSecretPush } from './plan'

describe('parseArgs', () => {
  it.each([
    [['--env', 'staging'], { environment: 'staging', apply: false }],
    [['--env=production'], { environment: 'production', apply: false }],
    [['--env', 'production', '--apply'], { environment: 'production', apply: true }],
    [['--apply', '--env', 'staging'], { environment: 'staging', apply: true }],
  ])('accepts %j', (argv, expected) => {
    expect(parseArgs(argv)).toEqual(expected)
  })

  it.each([
    ['no --env', []],
    ['only --apply', ['--apply']],
    ['a bare environment name', ['production', '--apply']],
    ['--env without a value', ['--env']],
    ['--env followed by a flag', ['--env', '--apply']],
    ['an empty --env=', ['--env=']],
    ['an unknown environment', ['--env', 'prod']],
    ['a misspelled flag', ['--env', 'staging', '--aply']],
    ['a repeated --env', ['--env', 'staging', '--env', 'production']],
    ['a repeated mixed --env', ['--env=staging', '--env', 'staging']],
  ])('throws a usage message for %s', (_label, argv) => {
    expect(() => parseArgs(argv)).toThrow(/Usage: npm run secrets:push/)
  })
})

describe('parseEnvFile inline comments', () => {
  const get = (line: string) => parseEnvFile(`K=${line}\n`).get('K')

  it('strips an unquoted inline comment', () => {
    expect(get('abc # note')).toBe('abc')
    expect(get('abc\t#note')).toBe('abc')
  })

  it('keeps a # with no whitespace before it', () => {
    expect(get('abc#def')).toBe('abc#def')
  })

  it('keeps a # inside quotes, and strips a comment after the closing quote', () => {
    expect(get('"abc # note"')).toBe('abc # note')
    expect(get("'abc # note'")).toBe('abc # note')
    expect(get('"abc" # note')).toBe('abc')
  })
})

describe('duplicate keys', () => {
  it('finds names defined twice, ignoring comments', () => {
    expect(findDuplicateKeys('A=1\n# A=2\nB=1\nA=3\nB=4\n')).toEqual(['A', 'B'])
    expect(findDuplicateKeys('A=1\nB=2\n')).toEqual([])
  })

  it('plans an error naming the key and never the value', () => {
    const contents = 'OTP_PEPPER=first-secret\nOTP_PEPPER=second-secret\n'
    const plan = planSecretPush({ values: parseEnvFile(contents), duplicates: findDuplicateKeys(contents) })
    expect(plan.errors).toHaveLength(1)
    expect(plan.errors[0]).toContain('OTP_PEPPER')
    expect(plan.errors[0]).not.toContain('secret')
  })
})
