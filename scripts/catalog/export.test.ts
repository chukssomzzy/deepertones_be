import { describe, expect, it } from 'vitest'
import { HttpNetworkError, HttpTimeoutError } from '../../src/lib/http'
import type { RawWorkbook } from '../../src/modules/catalog/catalog.workbook.schema'
import { runExport } from './export'
import { errorReply, fakeOutput, fakeReadText, fakeRequest, okReply, OTHER_SECRET, TOKEN, VARS, type Reply, type Sent } from './script.fixture'
import { validWorkbook } from './workbook.fixture'

// `npm run catalog:export --env local|staging|production [--out file]`: fetch the live catalog from the admin API and write it to an .xlsx stamped
// with the catalog version it was exported at. `runExport(args, deps)` is the whole script with every effect handed in:
//   readText(path)  the vars file (.dev.vars for local, .dev.vars.<env> for a deployed environment), which holds ADMIN_API_TOKEN
//   request(url, init)  one HTTP call (the shell wires requestJson$), answering { status, ok, body }
//   writeWorkbook(path, workbook, catalogVersion)  scripts/catalog/xlsx writeWorkbookFile
//   log / error  stdout and stderr, one line per call
// It returns the process exit code: 0 on success, 1 on anything else.
// The wire shapes are the project's envelopes: a success is { success: true, status, message, data } with the plan's response under `data`; an
// error is { success: false, status, message, error: { code, details, requestId } }.

const EXPORT_PATH = '/api/v1/admin/catalog/export'
const BASES = { local: 'http://localhost:8787', staging: 'https://api.staging.deepertones.com', production: 'https://api.deepertones.com' } as const
const VARS_FILES = { local: '.dev.vars', staging: '.dev.vars.staging', production: '.dev.vars.production' } as const

type Env = keyof typeof BASES
type Written = { path: string; workbook: RawWorkbook; catalogVersion: number; stamp: Stamp | undefined }
type Stamp = { environment?: string; contractVersion?: string }

const live = (catalogVersion = 12, contractVersion = '1.0.0') => ({ catalogVersion, contractVersion, workbook: validWorkbook() })

const VARS_ON_DISK: Record<string, string> = { '.dev.vars': VARS, '.dev.vars.staging': VARS, '.dev.vars.production': VARS }

const setup = (reply: Reply | ((sent: Sent) => Reply) = okReply(live()), files: Record<string, string> = VARS_ON_DISK, existing: string[] = []) => {
  const out = fakeOutput()
  const http = fakeRequest(reply)
  const vars = fakeReadText(files)
  const written: Written[] = []
  const deps = {
    readText: vars.readText,
    request: http.request,
    writeWorkbook: async (path: string, workbook: RawWorkbook, catalogVersion: number | null, stamp?: Stamp) => void written.push({ path, workbook, catalogVersion: catalogVersion!, stamp }),
    exists: async (path: string) => existing.includes(path),
    log: out.log,
    error: out.error,
  }
  return { out, http, vars, written, deps }
}

describe('runExport: asking the admin API', () => {
  it.each(Object.keys(BASES) as Env[])('asks the %s environment for its catalog at its own address, with the admin token in X-Admin-Token', async (env) => {
    const { deps, http } = setup()

    const code = await runExport({ env, out: undefined }, deps)

    expect(code).toBe(0)
    expect(http.sent).toHaveLength(1)
    expect(http.sent[0]!.url).toBe(`${BASES[env]}${EXPORT_PATH}`)
    expect(http.sent[0]!.method).toBe('GET')
    expect(http.sent[0]!.headers.get('X-Admin-Token')).toBe(TOKEN)
  })

  it.each(Object.entries(VARS_FILES) as [Env, string][])('reads the token for %s from %s, and from no other file', async (env, file) => {
    const { deps, vars } = setup()

    await runExport({ env, out: undefined }, deps)

    expect(vars.reads).toEqual([file])
  })

  it('never sends the token anywhere but the header, and sends no other secret from the file', async () => {
    const { deps, http } = setup()

    await runExport({ env: 'staging', out: undefined }, deps)

    const call = http.sent[0]!
    expect(call.url).not.toContain(TOKEN)
    expect(call.body ?? '').not.toContain(TOKEN)
    expect([...call.headers.values()].filter((value) => value.includes(OTHER_SECRET))).toEqual([])
    expect(call.timeoutMs).toBeGreaterThan(0)
  })
})

describe('runExport: the file it writes', () => {
  it('writes the workbook it was given and the catalog version it was exported at', async () => {
    const { deps, written } = setup(okReply(live(12)))

    await runExport({ env: 'staging', out: undefined }, deps)

    expect(written).toHaveLength(1)
    expect(written[0]!.workbook).toEqual(validWorkbook())
    expect(written[0]!.catalogVersion).toBe(12)
  })

  it('names the file after the environment and the catalog version unless told otherwise', async () => {
    const { deps, written } = setup(okReply(live(12)))

    await runExport({ env: 'staging', out: undefined }, deps)

    expect(written[0]!.path).toBe('catalog-staging-v12.xlsx')
  })

  it('names a production export differently from a staging one, and a later version differently from an earlier one', async () => {
    const production = setup(okReply(live(3)))
    const later = setup(okReply(live(4)))

    await runExport({ env: 'production', out: undefined }, production.deps)
    await runExport({ env: 'production', out: undefined }, later.deps)

    expect(production.written[0]!.path).toBe('catalog-production-v3.xlsx')
    expect(later.written[0]!.path).toBe('catalog-production-v4.xlsx')
  })

  it('writes to --out exactly as given', async () => {
    const { deps, written } = setup()

    await runExport({ env: 'staging', out: 'exports/live copy.xlsx' }, deps)

    expect(written.map((w) => w.path)).toEqual(['exports/live copy.xlsx'])
  })

  it('says where the file is and which catalog version it holds', async () => {
    const { deps, out } = setup(okReply(live(12)))

    await runExport({ env: 'staging', out: undefined }, deps)

    expect(out.stdout()).toContain('catalog-staging-v12.xlsx')
    expect(out.stdout()).toMatch(/\b12\b/)
  })
})

describe('runExport: what the file is stamped with', () => {
  it.each(Object.keys(BASES) as Env[])('stamps the environment it was exported from (%s)', async (env) => {
    const { deps, written } = setup()

    await runExport({ env, out: undefined }, deps)

    expect(written[0]!.stamp?.environment).toBe(env)
  })

  it('stamps the contract version the SERVER answered with, not this checkout\'s', async () => {
    const { deps, written } = setup(okReply(live(12, '7.3.1')))

    await runExport({ env: 'staging', out: undefined }, deps)

    expect(written[0]!.stamp?.contractVersion).toBe('7.3.1')
  })

  it.each([
    ['no contract version', { catalogVersion: 12, workbook: validWorkbook() }],
    ['a contract version that is not text', { catalogVersion: 12, contractVersion: 1, workbook: validWorkbook() }],
    ['a workbook that is a list', { catalogVersion: 12, contractVersion: '1.0.0', workbook: [] }],
    ['a tab whose rows are lists, not objects', { catalogVersion: 12, contractVersion: '1.0.0', workbook: { ...validWorkbook(), products: { headers: ['code'], rows: [['PRD-A']] } } }],
  ])('refuses a 200 with %s', async (_label, data) => {
    const { deps, written, out } = setup(okReply(data))

    expect(await runExport({ env: 'staging', out: undefined }, deps)).not.toBe(0)

    expect(written).toEqual([])
    expect(out.stderr()).not.toBe('')
  })
})

describe('runExport: not overwriting a file', () => {
  it('refuses to overwrite the default file name, names it, points at --force, and writes nothing', async () => {
    const { deps, out, written } = setup(okReply(live(12)), VARS_ON_DISK, ['catalog-staging-v12.xlsx'])

    expect(await runExport({ env: 'staging', out: undefined }, deps)).not.toBe(0)

    expect(written).toEqual([])
    expect(out.stderr()).toContain('catalog-staging-v12.xlsx')
    expect(out.stderr()).toContain('--force')
  })

  it('refuses to overwrite a file given with --out', async () => {
    const { deps, out, written } = setup(okReply(live(12)), VARS_ON_DISK, ['mine.xlsx'])

    expect(await runExport({ env: 'staging', out: 'mine.xlsx' }, deps)).not.toBe(0)

    expect(written).toEqual([])
    expect(out.stderr()).toContain('mine.xlsx')
  })

  it('overwrites with --force', async () => {
    const { deps, written } = setup(okReply(live(12)), VARS_ON_DISK, ['mine.xlsx'])

    expect(await runExport({ env: 'staging', out: 'mine.xlsx', force: true }, deps)).toBe(0)

    expect(written.map((w) => w.path)).toEqual(['mine.xlsx'])
  })

  it('writes when the file is not there', async () => {
    const { deps, written } = setup(okReply(live(12)), VARS_ON_DISK, ['another.xlsx'])

    expect(await runExport({ env: 'staging', out: 'mine.xlsx' }, deps)).toBe(0)

    expect(written).toHaveLength(1)
  })
})

describe('runExport: when it cannot export', () => {
  it.each([
    [401, 'ADMIN_TOKEN_INVALID'],
    [429, 'RATE_LIMITED'],
    [500, 'INTERNAL_ERROR'],
  ])('exits non-zero, prints the error code and writes nothing on a %i %s', async (status, code) => {
    const { deps, out, written } = setup(errorReply(status, code))

    expect(await runExport({ env: 'staging', out: undefined }, deps)).not.toBe(0)

    expect(out.stderr()).toContain(code)
    expect(written).toEqual([])
  })

  it('exits non-zero and names the status when the answer is not JSON at all, such as a gateway error page', async () => {
    const { deps, out, written } = setup({ status: 502, body: '<html>Bad gateway</html>' })

    expect(await runExport({ env: 'staging', out: undefined }, deps)).not.toBe(0)

    expect(out.stderr()).toContain('502')
    expect(written).toEqual([])
  })

  it.each([
    ['no workbook', okReply({ catalogVersion: 12, contractVersion: '1.0.0' })],
    ['no catalog version', okReply({ contractVersion: '1.0.0', workbook: validWorkbook() })],
    ['a catalog version that is not a whole number', okReply({ catalogVersion: 'twelve', contractVersion: '1.0.0', workbook: validWorkbook() })],
    ['a tab with no headers', okReply({ catalogVersion: 12, contractVersion: '1.0.0', workbook: { ...validWorkbook(), products: { rows: [] } } })],
    ['no envelope data', { status: 200, body: { success: true, status: 200, message: 'OK' } }],
  ])('refuses a 200 with %s rather than write a file it cannot vouch for', async (_label, reply) => {
    const { deps, out, written } = setup(reply)

    expect(await runExport({ env: 'staging', out: undefined }, deps)).not.toBe(0)

    expect(written).toEqual([])
    expect(out.stderr()).not.toBe('')
  })

  it.each([
    ['the network is down', new HttpNetworkError('Request failed before a response')],
    ['it times out', new HttpTimeoutError('No response within 30000ms')],
  ])('exits non-zero with a message when %s', async (_label, failure) => {
    const { deps, out, written } = setup(failure)

    expect(await runExport({ env: 'staging', out: undefined }, deps)).not.toBe(0)

    expect(out.stderr()).not.toBe('')
    expect(written).toEqual([])
  })

  it('exits non-zero and says what failed when the file cannot be written', async () => {
    const { deps, out } = setup()
    deps.writeWorkbook = async () => {
      throw new Error('EACCES: permission denied')
    }

    expect(await runExport({ env: 'staging', out: undefined }, deps)).not.toBe(0)

    expect(out.stderr()).toContain('EACCES')
  })

  it('stops before any request when the vars file is missing, and names the file', async () => {
    const { deps, http, out } = setup(okReply(live()), {})

    expect(await runExport({ env: 'staging', out: undefined }, deps)).not.toBe(0)

    expect(http.sent).toEqual([])
    expect(out.stderr()).toContain('.dev.vars.staging')
  })

  it.each([
    ['blank', 'ADMIN_API_TOKEN=\nOTP_PEPPER=' + OTHER_SECRET + '\n'],
    ['absent', 'OTP_PEPPER=' + OTHER_SECRET + '\n'],
  ])('stops before any request when ADMIN_API_TOKEN is %s, and names the key', async (_label, contents) => {
    const { deps, http, out } = setup(okReply(live()), { '.dev.vars.staging': contents })

    expect(await runExport({ env: 'staging', out: undefined }, deps)).not.toBe(0)

    expect(http.sent).toEqual([])
    expect(out.stderr()).toContain('ADMIN_API_TOKEN')
    expect(out.text()).not.toContain(OTHER_SECRET)
  })
})

describe('runExport: the token is never printed', () => {
  const failures: [string, Reply][] = [
    ['a success', okReply(live())],
    ['a 401', errorReply(401, 'ADMIN_TOKEN_INVALID')],
    ['a 500 that echoes nothing useful', { status: 500, body: 'Internal Server Error' }],
    ['a body that echoes the request headers back', { status: 400, body: { success: false, error: { code: 'BAD_REQUEST', details: { 'x-admin-token': TOKEN } } } }],
    ['a network failure whose message holds the URL and headers', new HttpNetworkError(`fetch failed: GET http://localhost:8787 x-admin-token=${TOKEN}`)],
  ]

  it.each(failures)('on %s, neither stream holds the token or any other secret from the vars file', async (_label, reply) => {
    const { deps, out } = setup(reply)

    await runExport({ env: 'staging', out: undefined }, deps)

    expect(out.text()).not.toContain(TOKEN)
    expect(out.text()).not.toContain(OTHER_SECRET)
  })
})
