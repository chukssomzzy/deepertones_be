import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { NOT_SECRETS, SECRETS, parseEnvFile, planSecretPush, wranglerBulkArgs } from './plan'

const root = resolve(__dirname, '../..')
const read = (file: string) => readFileSync(resolve(root, file), 'utf8')
const map = (entries: Record<string, string>) => new Map(Object.entries(entries))

describe('parseEnvFile', () => {
  it('reads KEY=VALUE lines and skips blanks, comments and lines without =', () => {
    const parsed = parseEnvFile('# comment\n\nA=1\nnot a pair\n  # indented comment\nB=2\n')
    expect([...parsed]).toEqual([
      ['A', '1'],
      ['B', '2'],
    ])
  })

  it('trims keys and values', () => {
    expect(parseEnvFile('  KEY  =  value  \n').get('KEY')).toBe('value')
  })

  it('strips one pair of matching surrounding quotes', () => {
    const parsed = parseEnvFile(`D="double"\nS='single'\nM="mismatch'\nN="'nested'"\n`)
    expect(parsed.get('D')).toBe('double')
    expect(parsed.get('S')).toBe('single')
    expect(parsed.get('M')).toBe(`"mismatch'`)
    expect(parsed.get('N')).toBe(`'nested'`)
  })

  it('splits on the first = so a value may contain =', () => {
    expect(parseEnvFile('TOKEN=abc==def=\n').get('TOKEN')).toBe('abc==def=')
  })

  it('does not interpolate variables', () => {
    expect(parseEnvFile('A=1\nB=$A${A}\n').get('B')).toBe('$A${A}')
  })

  it('parses an export prefix literally, as part of the key', () => {
    const parsed = parseEnvFile('export X=1\n')
    expect(parsed.get('export X')).toBe('1')
    expect(parsed.has('X')).toBe(false)
  })

  it('keeps an empty value as an empty string', () => {
    expect(parseEnvFile('OTP_PEPPER=\n').get('OTP_PEPPER')).toBe('')
  })
})

describe('SECRETS', () => {
  it('lists exactly the three known secrets, two of them required', () => {
    expect(Object.keys(SECRETS).sort()).toEqual(['OTP_PEPPER', 'WHATSAPP_ACCESS_TOKEN', 'ZEPTOMAIL_API_KEY'])
    expect(SECRETS.ZEPTOMAIL_API_KEY!.required).toBe(true)
    expect(SECRETS.OTP_PEPPER!.required).toBe(true)
    expect(SECRETS.WHATSAPP_ACCESS_TOKEN!.required).toBe(false)
  })
})

describe('planSecretPush', () => {
  const good = { ZEPTOMAIL_API_KEY: 'zk', OTP_PEPPER: 'pepper-a' }

  it('sends known secrets that have a value', () => {
    const plan = planSecretPush({ values: map({ ...good, WHATSAPP_ACCESS_TOKEN: 'wa' }) })
    expect(plan.send).toEqual({ ZEPTOMAIL_API_KEY: 'zk', OTP_PEPPER: 'pepper-a', WHATSAPP_ACCESS_TOKEN: 'wa' })
    expect(plan.blank).toEqual([])
    expect(plan.unknown).toEqual([])
    expect(plan.errors).toEqual([])
  })

  it('never sends a known secret with an empty value, and lists it as blank', () => {
    const plan = planSecretPush({ values: map({ ...good, WHATSAPP_ACCESS_TOKEN: '' }) })
    expect(plan.send).not.toHaveProperty('WHATSAPP_ACCESS_TOKEN')
    expect(plan.blank).toEqual(['WHATSAPP_ACCESS_TOKEN'])
  })

  it('skips a name that is Worker config, with its reason', () => {
    const plan = planSecretPush({ values: map({ ...good, ENVIRONMENT: 'staging' }) })
    expect(plan.send).not.toHaveProperty('ENVIRONMENT')
    expect(plan.skipped).toEqual([{ name: 'ENVIRONMENT', reason: NOT_SECRETS.ENVIRONMENT }])
    expect(plan.unknown).toEqual([])
    expect(plan.errors).toEqual([])
  })

  it('reports an unrecognised name as unknown, never sends it, and errors naming it', () => {
    const plan = planSecretPush({ values: map({ ...good, ZZZ_NEW: 'x', AAA_NEW: 'y' }) })
    expect(plan.send).not.toHaveProperty('ZZZ_NEW')
    expect(plan.unknown).toEqual(['AAA_NEW', 'ZZZ_NEW'])
    expect(plan.errors).toHaveLength(1)
    expect(plan.errors[0]).toContain('AAA_NEW')
    expect(plan.errors[0]).toContain('ZZZ_NEW')
    expect(plan.errors[0]).toContain('SECRETS')
  })

  it('treats an export-prefixed key as unknown', () => {
    const plan = planSecretPush({ values: parseEnvFile('export OTP_PEPPER=1\n') })
    expect(plan.unknown).toEqual(['export OTP_PEPPER'])
  })

  it('warns, without erroring, about required secrets that are absent or blank (sorted)', () => {
    expect(planSecretPush({ values: map({}) }).missingRequired).toEqual(['OTP_PEPPER', 'ZEPTOMAIL_API_KEY'])
    const blankOne = planSecretPush({ values: map({ ZEPTOMAIL_API_KEY: 'zk', OTP_PEPPER: '' }) })
    expect(blankOne.missingRequired).toEqual(['OTP_PEPPER'])
    expect(blankOne.errors).toEqual([])
  })

  it('does not report an absent optional secret as missing', () => {
    expect(planSecretPush({ values: map(good) }).missingRequired).toEqual([])
  })

  it('errors, without leaking the value, when OTP_PEPPER equals the other environment\'s', () => {
    const plan = planSecretPush({ values: map(good), otherEnvironment: map({ OTP_PEPPER: 'pepper-a' }) })
    expect(plan.errors).toHaveLength(1)
    expect(plan.errors[0]).toContain('different')
    expect(plan.errors[0]).not.toContain('pepper-a')
  })

  it('accepts differing peppers and ignores a blank pepper matching a blank one', () => {
    expect(planSecretPush({ values: map(good), otherEnvironment: map({ OTP_PEPPER: 'pepper-b' }) }).errors).toEqual([])
    const blank = planSecretPush({ values: map({ ...good, OTP_PEPPER: '' }), otherEnvironment: map({ OTP_PEPPER: '' }) })
    expect(blank.errors).toEqual([])
  })

  it('sorts skipped and blank entries', () => {
    const plan = planSecretPush({
      values: map({ ...good, WHATSAPP_ACCESS_TOKEN: '', OTP_CHANNELS: 'email', DOCS_ENABLED: 'true' }),
    })
    expect(plan.skipped.map((s) => s.name)).toEqual(['DOCS_ENABLED', 'OTP_CHANNELS'])
  })
})

describe('wranglerBulkArgs', () => {
  it.each(['staging', 'production'] as const)('targets the %s Worker', (environment) => {
    expect(wranglerBulkArgs(environment)).toEqual(['wrangler', 'secret', 'bulk', '--env', environment])
  })
})

describe('drift between wrangler.jsonc and the secrets table', () => {
  const config = ts.parseConfigFileTextToJson('wrangler.jsonc', read('wrangler.jsonc')).config as {
    env: Record<string, { vars: Record<string, string>; secrets: { required: string[] } }>
  }

  describe.each(['staging', 'production'] as const)('env.%s', (environment) => {
    const env = config.env[environment]!

    it('requires exactly the secrets SECRETS marks required', () => {
      const required = Object.entries(SECRETS)
        .filter(([, s]) => s.required)
        .map(([name]) => name)
        .sort()
      expect([...env.secrets.required].sort()).toEqual(required)
    })

    it('lists every vars key in NOT_SECRETS', () => {
      for (const name of Object.keys(env.vars)) expect(NOT_SECRETS, name).toHaveProperty(name)
    })
  })

  it('never lists a name as both a secret and config', () => {
    for (const name of Object.keys(NOT_SECRETS)) expect(SECRETS, name).not.toHaveProperty(name)
  })
})

describe('example files', () => {
  const lines = (file: string) => read(file).split('\n')

  it('.dev.vars.deployed.example has an empty NAME= line for every secret', () => {
    const present = lines('.dev.vars.deployed.example')
    for (const name of Object.keys(SECRETS)) expect(present, name).toContain(`${name}=`)
  })

  it('.dev.vars.example mentions every secret', () => {
    const present = lines('.dev.vars.example')
    for (const name of Object.keys(SECRETS)) expect(present.some((l) => l.startsWith(`${name}=`)), name).toBe(true)
  })
})

describe('.gitignore', () => {
  const ignored = (path: string) => {
    try {
      execFileSync('git', ['check-ignore', '-q', path], { cwd: root })
      return true
    } catch (error) {
      if ((error as { status?: number }).status === 1) return false
      throw error
    }
  }

  it.each(['.dev.vars', '.dev.vars.staging', '.dev.vars.production'])('ignores %s', (path) => {
    expect(ignored(path)).toBe(true)
  })

  it.each(['.dev.vars.example', '.dev.vars.deployed.example'])('does not ignore %s', (path) => {
    expect(ignored(path)).toBe(false)
  })
})
