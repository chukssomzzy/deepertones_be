/**
 * What `catalog:export` and `catalog:upload` share: where each environment's admin API is, how the admin token is found, how an answer from the
 * server is told apart, and a terminal that can never print the token. The only effect in this file is `httpRequest`, the real network call the
 * shells wire in; the file system and the console are always handed in.
 */
import { firstValueFrom } from 'rxjs'
import { requestJson$ } from '../../src/lib/http'
import { parseEnvFile } from '../secrets/plan'

export const ENVIRONMENTS = ['local', 'staging', 'production'] as const
export type Environment = (typeof ENVIRONMENTS)[number]

const BASES: Record<Environment, string> = {
  local: 'http://localhost:8787',
  staging: 'https://api.staging.deepertones.com',
  production: 'https://api.deepertones.com',
}
const VARS_FILES: Record<Environment, string> = { local: '.dev.vars', staging: '.dev.vars.staging', production: '.dev.vars.production' }

export const adminUrl = (env: Environment, path: string): string => `${BASES[env]}${path}`

/** One HTTP call: the shells wire requestJson$, the tests a fake. */
export type AdminRequest = (
  url: string,
  init: { method?: string; headers?: HeadersInit; body?: BodyInit | null; timeoutMs: number },
) => Promise<{ status: number; ok: boolean; body: unknown }>

// A redirect is never followed: the token would go to wherever it points. The 3xx comes back as the answer, and `readAnswer` calls it unexpected.
export const httpRequest: AdminRequest = (url, init) => firstValueFrom(requestJson$(url, { ...init, redirect: 'manual' }))

/** The admin token of `env`, from its own vars file and no other. Only that one value is taken from the file. */
export async function readAdminToken(env: Environment, readText: (path: string) => Promise<string>): Promise<string> {
  const file = VARS_FILES[env]
  let contents: string
  try {
    contents = await readText(file)
  } catch {
    throw new Error(`Cannot read ${file}. It holds ADMIN_API_TOKEN, is gitignored, and is set up as in README → Catalog workbook.`)
  }
  const token = parseEnvFile(contents).get('ADMIN_API_TOKEN')
  if (token === undefined || token === '') throw new Error(`ADMIN_API_TOKEN is not set in ${file}.`)
  return token
}

/** Everything the script says goes through here. Once the token is known, any line that holds it has it replaced, whatever the server echoed back. */
export function createTerminal(out: { log: (line: string) => void; error: (line: string) => void }) {
  let secret: string | undefined
  const clean = (line: string) => (secret === undefined ? line : line.replaceAll(secret, '[redacted]'))
  return {
    log: (line: string) => out.log(clean(line)),
    error: (line: string) => out.error(clean(line)),
    hide: (token: string) => {
      secret = token
    },
  }
}

export type Answer =
  | { kind: 'data'; data: Record<string, unknown> }
  | { kind: 'refused'; status: number; code: string; message: string | null; details: unknown }
  | { kind: 'unexpected'; status: number }

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** Sorts a response into the project's two envelopes (`{ success, data }` and `{ success: false, error: { code } }`) or neither. */
export function readAnswer(res: { status: number; ok: boolean; body: unknown }): Answer {
  const body = res.body
  if (res.ok) return isRecord(body) && body.success === true && isRecord(body.data) ? { kind: 'data', data: body.data } : { kind: 'unexpected', status: res.status }
  if (isRecord(body) && isRecord(body.error) && typeof body.error.code === 'string') {
    return { kind: 'refused', status: res.status, code: body.error.code, message: typeof body.message === 'string' ? body.message : null, details: body.error.details }
  }
  return { kind: 'unexpected', status: res.status }
}

/** One line for an answer that is not data. Never the body of an unexpected one: nothing in it is known to be safe to print. */
export const describeFailure = (answer: Exclude<Answer, { kind: 'data' }>): string =>
  answer.kind === 'refused'
    ? `${answer.status} ${answer.code}${answer.message === null ? '' : `: ${answer.message}`}`
    : `The server answered ${answer.status}, which is not in the API's usual JSON format.`
