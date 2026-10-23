import { describe, expect, it } from 'vitest'
import { HttpNetworkError, HttpTimeoutError } from '../../src/lib/http'
import { CONTRACT_VERSION, type RawWorkbook } from '../../src/modules/catalog/catalog.workbook.schema'
import { runUpload } from './upload'
import { WorkbookFileError } from './xlsx'
import { errorReply, fakeOutput, fakeReadText, fakeRequest, okReply, OTHER_SECRET, TOKEN, VARS, type Reply, type Sent } from './script.fixture'
import { availability, country, ingredient, product, validWorkbook } from './workbook.fixture'

// `npm run catalog:upload file.xlsx --env … --by "Name" [--apply]`: read an edited workbook, check it locally against the contract, then send it to
// the admin API, as a dry run unless --apply is given. `runUpload(args, deps)` is the whole script with every effect handed in:
//   readText(path)   the vars file holding ADMIN_API_TOKEN (.dev.vars for local, .dev.vars.<env> otherwise)
//   readBytes(path)  the .xlsx file's bytes, read once: parsed, and sent along on --apply so the server can archive the original
//   readWorkbook(bytes)  scripts/catalog/xlsx readWorkbookBytes: { workbook, catalogVersion, environment, contractVersion }, parsed from the same bytes that
//                    readBytes gave, so what is checked is what is sent
//   request(url, init)  one HTTP call (the shell wires requestJson$), answering { status, ok, body }
//   log / error  stdout and stderr, one line per call
// It returns the process exit code: 0 when the dry run or the apply went through, 1 on anything else.
// The wire shapes are the project's envelopes: a success is { success: true, status, message, data } with the plan's response under `data`; an
// error is { success: false, status, message, error: { code, details, requestId } }, with a CATALOG_INVALID's problems in error.details.problems.
// The point of the order: everything that can be known without the server is checked first, so a wrong file never costs a request.

const IMPORT_PATH = '/api/v1/admin/catalog/import'
const BASES = { local: 'http://localhost:8787', staging: 'https://api.staging.deepertones.com', production: 'https://api.deepertones.com' } as const
const VARS_FILES = { local: '.dev.vars', staging: '.dev.vars.staging', production: '.dev.vars.production' } as const
const XLSX_MEDIA_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

type Env = keyof typeof BASES
type Args = { file: string; env: Env; by: string; apply: boolean }

const args = (over: Partial<Args> = {}): Args => ({ file: 'edited.xlsx', env: 'staging', by: 'Tolu Adeyemi', apply: false, ...over })

/** The bytes of the file on disk: an arbitrary, recognisable run, since the script must send them as they are. */
const XLSX_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 255])

const emptyTab = { added: [], updated: [], retired: [], reactivated: [] }
const EMPTY_DIFF = { products: emptyTab, availability: emptyTab, ingredients: emptyTab, countries: emptyTab, newProducts: [] }
const DIFF = {
  products: { added: ['PRD-NEW-A', 'PRD-NEW-B'], updated: ['PRD-CERAVE-CLEANSER'], retired: [], reactivated: [] },
  availability: { added: ['PRD-NEW-A:NG'], updated: [], retired: ['PRD-OLD:GH'], reactivated: [] },
  ingredients: { added: [], updated: [], retired: [], reactivated: ['ING-OLD-RULE'] },
  countries: emptyTab,
  newProducts: [
    { code: 'PRD-NEW-A', brand: 'La Roche-Posay', name: 'Anthelios Mineral', variant: null, form: null },
    { code: 'PRD-NEW-B', brand: 'Bioderma', name: 'Sensibio Gel', variant: 'Fragrance free', form: 'gel' },
  ],
}

type Setup = {
  workbook?: RawWorkbook
  catalogVersion?: number | null
  environment?: string | null
  contractVersion?: string | null
  reply?: Reply | ((sent: Sent) => Reply)
  files?: Record<string, string>
}

const setup = ({ workbook = validWorkbook(), catalogVersion = 7, environment = 'staging', contractVersion = CONTRACT_VERSION, reply = okReply({ applied: false, catalogVersion: 7, diff: DIFF }), files }: Setup = {}) => {
  const out = fakeOutput()
  const http = fakeRequest(reply)
  const vars = fakeReadText(files ?? { '.dev.vars': VARS, '.dev.vars.staging': VARS, '.dev.vars.production': VARS })
  const reads = { parsed: [] as Uint8Array[], bytes: [] as string[] }
  const deps = {
    readText: vars.readText,
    readBytes: async (path: string) => {
      reads.bytes.push(path)
      return XLSX_BYTES
    },
    readWorkbook: async (bytes: Uint8Array) => {
      reads.parsed.push(bytes)
      return { workbook, catalogVersion, environment, contractVersion }
    },
    request: http.request,
    log: out.log,
    error: out.error,
  }
  return { out, http, vars, reads, deps }
}

/** True when one line of `text` holds every needle: a line is how the script reports one thing. */
const hasLine = (text: string, ...needles: (string | RegExp)[]): boolean =>
  text.split('\n').some((line) => needles.every((needle) => (typeof needle === 'string' ? line.includes(needle) : needle.test(line))))

const formOf = (sent: Sent): FormData => {
  expect(sent.body).toBeInstanceOf(FormData)
  return sent.body as FormData
}

// The same example the contract's own tests use for "lists every problem, across rows, columns and tabs, not only the first".
const INVALID_WORKBOOK = (): RawWorkbook =>
  validWorkbook({
    products: [product({ code: 'prd-a', name: 'A', category: 'face' }), product({ code: 'PRD-B', name: 'B', frequency: 'daily' })],
    availability: [availability({ product_code: 'PRD-NOPE' }), availability({ product_code: 'PRD-B', country: 'GH', price_min: -1 })],
    ingredients: [ingredient({ name: 'Retinol.' })],
    countries: [country({ currency: 'ngn' })],
  })
const INVALID_PROBLEMS: [string, number, string, string][] = [
  ['products', 2, 'code', 'BAD_CODE'],
  ['products', 2, 'category', 'NOT_IN_VOCABULARY'],
  ['products', 3, 'frequency', 'NOT_IN_VOCABULARY'],
  ['availability', 2, 'product_code', 'UNKNOWN_PRODUCT'],
  ['availability', 3, 'country', 'UNKNOWN_COUNTRY'],
  ['availability', 3, 'price_min', 'NOT_A_WHOLE_NUMBER'],
  ['ingredients', 2, 'name', 'NOT_NORMALISED'],
  ['countries', 2, 'currency', 'BAD_CURRENCY'],
]

describe('runUpload: checking the file before asking the server', () => {
  it('reads the file once, and parses the workbook from those same bytes, so nothing can change between the check and the upload', async () => {
    const { deps, reads } = setup()

    await runUpload(args({ file: 'exports/edited.xlsx' }), deps)

    expect(reads.bytes).toEqual(['exports/edited.xlsx'])
    expect(reads.parsed).toHaveLength(1)
    expect(reads.parsed[0]).toBe(XLSX_BYTES)
  })

  it('tells the workbook reader the file name, so its message can name the file', async () => {
    const { deps } = setup()
    const names: (string | undefined)[] = []
    const read = deps.readWorkbook
    deps.readWorkbook = async (bytes: Uint8Array, name?: string) => {
      names.push(name)
      return read(bytes)
    }

    await runUpload(args({ file: 'exports/edited.xlsx' }), deps)

    expect(names).toEqual(['exports/edited.xlsx'])
  })

  it('shows the message of a file that is not there or not a workbook, as the reader words it', async () => {
    for (const message of ['No file at nope.xlsx', 'nope.xlsx could not be read as an .xlsx workbook (not one, or damaged): save it from Excel or LibreOffice as .xlsx.']) {
      const { deps, http, out } = setup()
      deps.readBytes = async () => {
        throw new WorkbookFileError(message)
      }

      expect(await runUpload(args({ file: 'nope.xlsx' }), deps)).toBe(1)

      expect(http.sent).toEqual([])
      expect(out.stderr()).toBe(`Upload failed: ${message}`)
    }
  })

  it('says the file cannot be read, and sends nothing, when it is not there', async () => {
    const { deps, http, out } = setup()
    deps.readBytes = async (path: string) => {
      throw new Error(`ENOENT: no such file or directory, open '${path}'`)
    }

    expect(await runUpload(args({ file: 'nope.xlsx' }), deps)).not.toBe(0)

    expect(http.sent).toEqual([])
    expect(out.stderr()).toContain('nope.xlsx')
  })

  it.each([[false], [true]])('lists every problem with its tab, row, column and rule, and sends nothing, when the contract rejects the workbook (apply=%s)', async (apply) => {
    const { deps, http, out } = setup({ workbook: INVALID_WORKBOOK() })

    const code = await runUpload(args({ apply }), deps)

    expect(code).not.toBe(0)
    expect(http.sent).toEqual([])
    for (const [tab, row, column, rule] of INVALID_PROBLEMS) {
      expect(hasLine(out.text(), new RegExp(tab, 'i'), new RegExp(`\\b${row}\\b`), column, rule), `${tab} row ${row} ${column} ${rule}`).toBe(true)
    }
  })

  it('reports a missing column on the header row, from the headers and not from the rows', async () => {
    const workbook = validWorkbook()
    workbook.products.headers = workbook.products.headers.filter((header) => header !== 'variant')
    for (const row of workbook.products.rows) delete row.variant
    const { deps, http, out } = setup({ workbook })

    expect(await runUpload(args(), deps)).not.toBe(0)

    expect(http.sent).toEqual([])
    expect(hasLine(out.text(), /products/i, /\b1\b/, 'variant', 'MISSING_COLUMN')).toBe(true)
  })

  it('never prints what a cell held, only where the problem is', async () => {
    const { deps, out } = setup({ workbook: validWorkbook({ products: [product({ category: 'CELL-VALUE-XYZ', brand: 'BRAND-VALUE-XYZ' })] }) })

    await runUpload(args(), deps)

    expect(out.text()).not.toContain('CELL-VALUE-XYZ')
    expect(out.text()).not.toContain('BRAND-VALUE-XYZ')
    expect(hasLine(out.text(), 'category', 'NOT_IN_VOCABULARY')).toBe(true)
  })

  it.each([[false], [true]])('refuses a workbook with no catalog version, since it cannot know which export it was edited from, and sends nothing (apply=%s)', async (apply) => {
    const { deps, http, out } = setup({ catalogVersion: null })

    const code = await runUpload(args({ apply }), deps)

    expect(code).not.toBe(0)
    expect(http.sent).toEqual([])
    expect(out.stderr()).toMatch(/catalog:export/)
  })

  it('says what is wrong with the file, and sends nothing, when the workbook cannot be read', async () => {
    const { deps, http, out } = setup()
    deps.readWorkbook = async () => {
      throw new Error('The Countries tab is missing from the workbook')
    }

    expect(await runUpload(args(), deps)).not.toBe(0)

    expect(http.sent).toEqual([])
    expect(out.stderr()).toContain('Countries')
  })

  it('stops before any request when the vars file is missing, and names the file', async () => {
    const { deps, http, out } = setup({ files: {} })

    expect(await runUpload(args({ env: 'staging' }), deps)).not.toBe(0)

    expect(http.sent).toEqual([])
    expect(out.stderr()).toContain('.dev.vars.staging')
  })

  it.each([
    ['blank', `ADMIN_API_TOKEN=\nOTP_PEPPER=${OTHER_SECRET}\n`],
    ['absent', `OTP_PEPPER=${OTHER_SECRET}\n`],
  ])('stops before any request when ADMIN_API_TOKEN is %s, and names the key', async (_label, contents) => {
    const { deps, http, out } = setup({ files: { '.dev.vars.staging': contents } })

    expect(await runUpload(args({ env: 'staging' }), deps)).not.toBe(0)

    expect(http.sent).toEqual([])
    expect(out.stderr()).toContain('ADMIN_API_TOKEN')
    expect(out.text()).not.toContain(OTHER_SECRET)
  })
})

describe('runUpload: refusing a file that is not for this environment or this contract', () => {
  it.each([[false], [true]])('names both environments, and sends nothing, when the file was exported from another one (apply=%s)', async (apply) => {
    const { deps, http, out } = setup({ environment: 'staging' })

    expect(await runUpload(args({ env: 'production', apply }), deps)).not.toBe(0)

    expect(http.sent).toEqual([])
    expect(out.stderr()).toContain('staging')
    expect(out.stderr()).toContain('production')
    expect(out.stderr()).toMatch(/catalog:export/)
  })

  it.each([[false], [true]])('tells the person to export again, and sends nothing, when the file has no environment stamp (apply=%s)', async (apply) => {
    const { deps, http, out } = setup({ environment: null })

    expect(await runUpload(args({ apply }), deps)).not.toBe(0)

    expect(http.sent).toEqual([])
    expect(out.stderr()).toMatch(/environment/i)
    expect(out.stderr()).toMatch(/catalog:export/)
  })

  it.each([[false], [true]])('names both contract versions, and sends nothing, when the file was made for another one (apply=%s)', async (apply) => {
    const { deps, http, out } = setup({ contractVersion: '0.9.0' })

    expect(await runUpload(args({ apply }), deps)).not.toBe(0)

    expect(http.sent).toEqual([])
    expect(out.stderr()).toContain('0.9.0')
    expect(out.stderr()).toContain(CONTRACT_VERSION)
    expect(out.stderr()).toMatch(/catalog:export/)
  })

  it('refuses a file with no contract version stamp, and sends nothing', async () => {
    const { deps, http, out } = setup({ contractVersion: null })

    expect(await runUpload(args(), deps)).not.toBe(0)

    expect(http.sent).toEqual([])
    expect(out.stderr()).toMatch(/contract/i)
  })
})

describe('runUpload: the request', () => {
  it.each(Object.keys(BASES) as Env[])('posts to the %s environment at its own address, with the admin token in X-Admin-Token', async (env) => {
    const { deps, http, vars } = setup({ environment: env })

    expect(await runUpload(args({ env }), deps)).toBe(0)

    expect(http.sent).toHaveLength(1)
    expect(http.sent[0]!.url).toBe(`${BASES[env]}${IMPORT_PATH}`)
    expect(http.sent[0]!.method).toBe('POST')
    expect(http.sent[0]!.headers.get('X-Admin-Token')).toBe(TOKEN)
    expect(vars.reads).toEqual([VARS_FILES[env]])
    expect(http.sent[0]!.timeoutMs).toBeGreaterThan(0)
  })

  it('sends the workbook as read, the version it was exported at, the uploader and a dry run, as multipart form fields', async () => {
    const workbook = validWorkbook()
    const { deps, http } = setup({ workbook, catalogVersion: 7 })

    await runUpload(args({ by: 'Tolu Adeyemi' }), deps)

    const form = formOf(http.sent[0]!)
    expect(JSON.parse(form.get('workbook') as string)).toEqual(workbook)
    expect(form.get('baseVersion')).toBe('7')
    expect(form.get('dryRun')).toBe('true')
    expect(form.get('uploadedBy')).toBe('Tolu Adeyemi')
  })

  it('takes baseVersion from the file, whatever version the server is at now', async () => {
    const { deps, http } = setup({ catalogVersion: 3, reply: okReply({ applied: false, catalogVersion: 9, diff: EMPTY_DIFF }) })

    await runUpload(args(), deps)

    expect(formOf(http.sent[0]!).get('baseVersion')).toBe('3')
  })

  it('sends the file itself, byte for byte and as an xlsx, when --apply is given, and says dryRun is false', async () => {
    const { deps, http, reads } = setup({ reply: okReply({ applied: true, catalogVersion: 8, diff: DIFF }) })

    await runUpload(args({ apply: true, file: 'exports/edited.xlsx' }), deps)

    const form = formOf(http.sent[0]!)
    const file = form.get('file') as File
    expect(form.get('dryRun')).toBe('false')
    expect(file).toBeInstanceOf(Blob)
    expect(file.type).toBe(XLSX_MEDIA_TYPE)
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(XLSX_BYTES)
    expect(reads.bytes).toEqual(['exports/edited.xlsx'])
  })

  it('makes exactly one request, and it is a dry run unless --apply is given', async () => {
    const dry = setup()
    const applied = setup({ reply: okReply({ applied: true, catalogVersion: 8, diff: DIFF }) })

    await runUpload(args({ apply: false }), dry.deps)
    await runUpload(args({ apply: true }), applied.deps)

    expect(dry.http.sent).toHaveLength(1)
    expect(formOf(dry.http.sent[0]!).get('dryRun')).toBe('true')
    expect(applied.http.sent).toHaveLength(1)
    expect(formOf(applied.http.sent[0]!).get('dryRun')).toBe('false')
  })

  it('never puts the token in the URL or the body', async () => {
    const { deps, http } = setup()

    await runUpload(args({ apply: true }), deps)

    const call = http.sent[0]!
    expect(call.url).not.toContain(TOKEN)
    const form = formOf(call)
    for (const [, value] of form.entries()) expect(typeof value === 'string' ? value : '').not.toContain(TOKEN)
  })
})

describe('runUpload: what it prints when the server answers', () => {
  it('prints, for each tab and kind of change, how many rows and which codes, and exits 0', async () => {
    const { deps, out } = setup()

    expect(await runUpload(args(), deps)).toBe(0)

    const text = out.stdout()
    expect(hasLine(text, /products/i, /added/i, /\b2\b/, 'PRD-NEW-A', 'PRD-NEW-B')).toBe(true)
    expect(hasLine(text, /products/i, /updated/i, /\b1\b/, 'PRD-CERAVE-CLEANSER')).toBe(true)
    expect(hasLine(text, /availability/i, /added/i, /\b1\b/, 'PRD-NEW-A:NG')).toBe(true)
    expect(hasLine(text, /availability/i, /retired/i, /\b1\b/, 'PRD-OLD:GH')).toBe(true)
    expect(hasLine(text, /ingredients/i, /reactivated/i, /\b1\b/, 'ING-OLD-RULE')).toBe(true)
  })

  it('shows each product the workbook would create as new, with its brand and name, so a different spelling is seen before it is applied', async () => {
    const { deps, out } = setup()

    await runUpload(args(), deps)

    expect(out.stdout()).toMatch(/new products?/i)
    expect(hasLine(out.stdout(), 'PRD-NEW-A', 'La Roche-Posay', 'Anthelios Mineral')).toBe(true)
    expect(hasLine(out.stdout(), 'PRD-NEW-B', 'Bioderma', 'Sensibio Gel')).toBe(true)
  })

  it('says a dry run changed nothing, and how to apply it', async () => {
    const { deps, out } = setup()

    await runUpload(args({ apply: false }), deps)

    expect(out.stdout()).toMatch(/dry run/i)
    expect(out.stdout()).toContain('--apply')
  })

  it('says the upload was applied, and at which new catalog version', async () => {
    const { deps, out } = setup({ reply: okReply({ applied: true, catalogVersion: 13, diff: DIFF }) })

    expect(await runUpload(args({ apply: true }), deps)).toBe(0)

    expect(out.stdout()).toMatch(/applied/i)
    expect(out.stdout()).toMatch(/\b13\b/)
  })

  it('says there are no changes, rather than printing empty sections, when the workbook matches the live catalog', async () => {
    const { deps, out } = setup({ reply: okReply({ applied: false, catalogVersion: 7, diff: EMPTY_DIFF }) })

    expect(await runUpload(args(), deps)).toBe(0)

    expect(out.stdout()).toMatch(/no changes/i)
  })

  it('does not tell the person to run again with --apply when a dry run has no changes, since there is nothing to apply', async () => {
    const { deps, out } = setup({ reply: okReply({ applied: false, catalogVersion: 7, diff: EMPTY_DIFF }) })

    expect(await runUpload(args({ apply: false }), deps)).toBe(0)

    expect(out.stdout()).toMatch(/dry run/i)
    expect(out.stdout()).not.toContain('--apply')
  })

  it('exits non-zero rather than claim success when a 200 holds no diff', async () => {
    const { deps, out } = setup({ reply: okReply({ applied: false, catalogVersion: 7 }) })

    expect(await runUpload(args(), deps)).not.toBe(0)

    expect(out.stderr()).not.toBe('')
  })
})

describe('runUpload: when the server refuses', () => {
  it('tells the person to export again, and does not retry, on 409 CATALOG_STALE', async () => {
    const { deps, http, out } = setup({ reply: errorReply(409, 'CATALOG_STALE') })

    expect(await runUpload(args({ apply: true }), deps)).not.toBe(0)

    expect(http.sent).toHaveLength(1)
    expect(out.stderr()).toContain('CATALOG_STALE')
    expect(out.stderr()).toMatch(/catalog:export/)
  })

  it('lists every problem the server found, with tab, row, column and rule, on 400 CATALOG_INVALID', async () => {
    const problems = [
      { tab: 'availability', row: 3, column: 'price_max', rule: 'PRICE_RANGE' },
      { tab: 'products', row: 5, column: 'code', rule: 'DUPLICATE_CODE' },
      { tab: 'ingredients', row: 2, column: 'source_url', rule: 'NOT_HTTPS_URL' },
    ]
    const { deps, out } = setup({ reply: errorReply(400, 'CATALOG_INVALID', { problems }) })

    expect(await runUpload(args(), deps)).not.toBe(0)

    expect(out.stderr()).toContain('CATALOG_INVALID')
    for (const { tab, row, column, rule } of problems) {
      expect(hasLine(out.text(), new RegExp(tab, 'i'), new RegExp(`\\b${row}\\b`), column, rule), `${tab} row ${row} ${column} ${rule}`).toBe(true)
    }
  })

  it.each([
    [401, 'ADMIN_TOKEN_INVALID'],
    [413, 'CATALOG_TOO_LARGE'],
    [429, 'RATE_LIMITED'],
    [500, 'INTERNAL_ERROR'],
  ])('exits non-zero and prints the error code on a %i %s', async (status, code) => {
    const { deps, out } = setup({ reply: errorReply(status, code) })

    expect(await runUpload(args({ apply: true }), deps)).not.toBe(0)

    expect(out.stderr()).toContain(code)
  })

  it('exits non-zero and names the status when the answer is not JSON, such as a gateway error page', async () => {
    const { deps, out } = setup({ reply: { status: 502, body: '<html>Bad gateway</html>' } })

    expect(await runUpload(args(), deps)).not.toBe(0)

    expect(out.stderr()).toContain('502')
  })

  it.each([
    ['the network is down', new HttpNetworkError('Request failed before a response')],
    ['it times out', new HttpTimeoutError('No response within 30000ms')],
  ])('exits non-zero with a message when %s', async (_label, failure) => {
    const { deps, out } = setup({ reply: failure })

    expect(await runUpload(args({ apply: true }), deps)).not.toBe(0)

    expect(out.stderr()).not.toBe('')
  })
})

// A request that went out may have been applied even when no usable answer came back. `--apply` then says so; a dry run changes nothing, so never.
describe('runUpload: when an apply may have gone through', () => {
  const UNSURE = /may or may not have been applied/i

  it.each([
    ['the network is down', new HttpNetworkError('Request failed before a response')],
    ['it times out', new HttpTimeoutError('No response within 60000ms')],
  ])('says so when --apply sent the request and %s', async (_label, failure) => {
    const { deps, out } = setup({ reply: failure })

    expect(await runUpload(args({ apply: true }), deps)).not.toBe(0)

    expect(out.stderr()).toMatch(UNSURE)
    expect(out.stderr()).toMatch(/catalog:export/)
  })

  it('never says so on a dry run, whatever failed', async () => {
    for (const reply of [new HttpNetworkError('down'), new HttpTimeoutError('slow'), errorReply(500, 'INTERNAL_ERROR'), { status: 502, body: '<html>Bad gateway</html>' }, okReply({ applied: false })] as Reply[]) {
      const { deps, out } = setup({ reply })

      expect(await runUpload(args({ apply: false }), deps)).not.toBe(0)

      expect(out.text(), JSON.stringify(reply)).not.toMatch(UNSURE)
    }
  })

  it.each([
    ['a 502 gateway page', { status: 502, body: '<html>Bad gateway</html>' } as Reply],
    ['a 500 error envelope', errorReply(500, 'INTERNAL_ERROR')],
    ['a 503 with no body', { status: 503, body: '' } as Reply],
    ['a redirect', { status: 302, body: '' } as Reply],
    ['a 200 that is not JSON', { status: 200, body: 'OK' } as Reply],
    ['a 200 with no diff', okReply({ applied: true, catalogVersion: 8 })],
  ])('says so when --apply got %s', async (_label, reply) => {
    const { deps, out } = setup({ reply })

    expect(await runUpload(args({ apply: true }), deps)).not.toBe(0)

    expect(out.stderr()).toMatch(UNSURE)
  })

  it.each([
    [401, 'ADMIN_TOKEN_INVALID'],
    [409, 'CATALOG_STALE'],
    [413, 'CATALOG_TOO_LARGE'],
    [429, 'RATE_LIMITED'],
  ])('does not say so when the server refused with a %i %s, which changed nothing', async (status, code) => {
    const { deps, out } = setup({ reply: errorReply(status, code) })

    await runUpload(args({ apply: true }), deps)

    expect(out.stderr()).not.toMatch(UNSURE)
  })

  it('does not say so when the workbook is refused locally, since nothing was sent', async () => {
    const { deps, out } = setup({ workbook: INVALID_WORKBOOK() })

    await runUpload(args({ apply: true }), deps)

    expect(out.text()).not.toMatch(UNSURE)
  })

  it('exits non-zero and says what the server did when asked to apply and it answers that it did not', async () => {
    const { deps, out } = setup({ reply: okReply({ applied: false, catalogVersion: 7, diff: DIFF }) })

    expect(await runUpload(args({ apply: true }), deps)).not.toBe(0)

    expect(out.stderr()).toMatch(/asked to apply/i)
    expect(out.stdout()).not.toMatch(/^Applied/m)
  })

  it('exits non-zero and says so when asked for a dry run and the server answers that it applied', async () => {
    const { deps, out } = setup({ reply: okReply({ applied: true, catalogVersion: 8, diff: DIFF }) })

    expect(await runUpload(args({ apply: false }), deps)).not.toBe(0)

    expect(out.stderr()).toMatch(/asked for a dry run/i)
  })
})

describe('runUpload: the token is never printed', () => {
  const answers: [string, Reply][] = [
    ['a dry run', okReply({ applied: false, catalogVersion: 7, diff: DIFF })],
    ['a stale refusal', errorReply(409, 'CATALOG_STALE')],
    ['a 401', errorReply(401, 'ADMIN_TOKEN_INVALID')],
    ['a 500 page', { status: 500, body: 'Internal Server Error' }],
    ['a body that echoes the request headers back', { status: 400, body: { success: false, error: { code: 'BAD_REQUEST', details: { 'x-admin-token': TOKEN } } } }],
    ['a network failure whose message holds the headers', new HttpNetworkError(`fetch failed: POST x-admin-token=${TOKEN}`)],
  ]

  it.each(answers)('on %s, neither stream holds the token or any other secret from the vars file', async (_label, reply) => {
    const { deps, out } = setup({ reply })

    await runUpload(args({ apply: true }), deps)

    expect(out.text()).not.toContain(TOKEN)
    expect(out.text()).not.toContain(OTHER_SECRET)
  })

  it('and not when the workbook is refused locally either', async () => {
    const { deps, out } = setup({ workbook: INVALID_WORKBOOK() })

    await runUpload(args(), deps)

    expect(out.text()).not.toContain(TOKEN)
    expect(out.text()).not.toContain(OTHER_SECRET)
  })
})
