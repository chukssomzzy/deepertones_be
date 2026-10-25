import path from 'node:path'
import { DEFAULT_PASSES } from './draft'
import { DraftInputError } from './draft-input-error'

export type Args = { input: string; out: string; maxUsd: number; countries: string[] | undefined; passes: number }

const DEFAULT_MAX_USD = 2
const MAX_PASSES = 5
const USAGE = 'Usage: npm run catalog:draft -- <in.xlsx> --out <out.xlsx> [--max-usd N] [--countries NG,GB] [--passes N]'

/**
 * Strict on purpose: a misspelt flag must stop the run before it spends money, and a draft never overwrites the file it was made from, so
 * --out has no default. Accepts `--flag value` and `--flag=value`.
 */
export const parseArgs = (argv: string[]): Args => {
  const fail = (reason: string): never => {
    throw new DraftInputError(`${reason}. ${USAGE}`)
  }
  let input: string | undefined
  let out: string | undefined
  let maxUsd = DEFAULT_MAX_USD
  let countries: string[] | undefined
  let passes = DEFAULT_PASSES
  const seen = new Set<string>()

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (!arg.startsWith('--')) {
      if (input !== undefined) fail(`Unexpected second input file "${arg}"`)
      input = arg
      continue
    }
    const equals = arg.indexOf('=')
    const flag = equals === -1 ? arg : arg.slice(0, equals)
    if (flag !== '--out' && flag !== '--max-usd' && flag !== '--countries' && flag !== '--passes') fail(`Unrecognised argument "${arg}"`)
    if (seen.has(flag)) fail(`${flag} was given twice`)
    seen.add(flag)

    const value = equals === -1 ? argv[++i] : arg.slice(equals + 1)
    if (value === undefined || value === '' || value.startsWith('-')) fail(`${flag} needs a value`)

    if (flag === '--out') out = value
    else if (flag === '--max-usd') {
      if (!/^\d+(\.\d+)?$/.test(value!) || !(Number(value) > 0) || !Number.isFinite(Number(value))) fail('--max-usd must be a number of dollars above 0')
      maxUsd = Number(value)
    } else if (flag === '--passes') {
      if (!/^\d+$/.test(value!) || Number(value) < 1 || Number(value) > MAX_PASSES) fail(`--passes must be a whole number from 1 to ${MAX_PASSES}`)
      passes = Number(value)
    } else {
      countries = value!.split(',')
      if (!countries.every((code) => /^[A-Z]{2}$/.test(code)) || new Set(countries).size !== countries.length) {
        fail('--countries must be distinct two-letter capital country codes separated by commas')
      }
    }
  }

  if (input === undefined) fail('An input file is needed')
  if (out === undefined) fail('--out is needed')
  if (path.resolve(input!) === path.resolve(out!)) fail('--out must not be the input file')
  return { input: input!, out: out!, maxUsd, countries, passes }
}
