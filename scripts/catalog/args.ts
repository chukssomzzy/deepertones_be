/**
 * The command lines of `npm run catalog:export` and `npm run catalog:upload`, kept apart from the shells so they can be tested without a process.
 * Strict on purpose, like scripts/secrets/plan parseArgs: a typo must stop the run, never be guessed at, because an upload changes what users are
 * recommended.
 */
import { ENVIRONMENTS, type Environment } from './admin-api'

const EXPORT_USAGE = 'Usage: npm run catalog:export -- --env local|staging|production [--out file.xlsx] [--force]'
const UPLOAD_USAGE = 'Usage: npm run catalog:upload -- file.xlsx --env local|staging|production --by "Name" [--apply]'

/** The server's limit on `uploadedBy`. */
const BY_MAX_LENGTH = 80

type Parsed = { values: Map<string, string>; flags: Set<string>; positionals: string[] }

/** Splits argv into `--name value` / `--name=value` options, bare `--flag`s and bare words, refusing anything not listed or given twice. */
function parseFlags(argv: string[], spec: { valued: string[]; bare: string[] }, usage: string): Parsed {
  const parsed: Parsed = { values: new Map(), flags: new Set(), positionals: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (!arg.startsWith('--')) {
      parsed.positionals.push(arg)
      continue
    }
    const equals = arg.indexOf('=')
    const name = equals === -1 ? arg : arg.slice(0, equals)
    if (spec.bare.includes(name) && equals === -1) {
      parsed.flags.add(name)
    } else if (spec.valued.includes(name)) {
      let value: string | undefined
      if (equals === -1) {
        value = argv[++i]
        if (value === undefined || value.startsWith('-')) throw new Error(`${name} needs a value. ${usage}`)
      } else {
        value = arg.slice(equals + 1)
      }
      if (parsed.values.has(name)) throw new Error(`${name} given more than once. ${usage}`)
      parsed.values.set(name, value)
    } else {
      throw new Error(`Unrecognised argument "${arg}". ${usage}`)
    }
  }
  return parsed
}

function environmentOf(parsed: Parsed, usage: string): Environment {
  const env = parsed.values.get('--env')
  if (env === undefined) throw new Error(`--env is required. ${usage}`)
  if (!(ENVIRONMENTS as readonly string[]).includes(env)) throw new Error(`Unknown environment "${env}". ${usage}`)
  return env as Environment
}

export function parseExportArgs(argv: string[]): { env: Environment; out: string | undefined; force: boolean } {
  const parsed = parseFlags(argv, { valued: ['--env', '--out'], bare: ['--force'] }, EXPORT_USAGE)
  if (parsed.positionals.length > 0) throw new Error(`Unrecognised argument "${parsed.positionals[0]}". ${EXPORT_USAGE}`)
  const env = environmentOf(parsed, EXPORT_USAGE)
  const out = parsed.values.get('--out')
  if (out === '') throw new Error(`--out needs a value. ${EXPORT_USAGE}`)
  return { env, out, force: parsed.flags.has('--force') }
}

export function parseUploadArgs(argv: string[]): { file: string; env: Environment; by: string; apply: boolean } {
  const parsed = parseFlags(argv, { valued: ['--env', '--by'], bare: ['--apply'] }, UPLOAD_USAGE)
  if (parsed.positionals.length !== 1) throw new Error(`Give exactly one workbook file. ${UPLOAD_USAGE}`)
  const env = environmentOf(parsed, UPLOAD_USAGE)
  const by = parsed.values.get('--by')?.trim()
  if (by === undefined) throw new Error(`--by is required. ${UPLOAD_USAGE}`)
  if (by === '' || by.length > BY_MAX_LENGTH) throw new Error(`--by must be 1 to ${BY_MAX_LENGTH} characters. ${UPLOAD_USAGE}`)
  return { file: parsed.positionals[0]!, env, by, apply: parsed.flags.has('--apply') }
}
