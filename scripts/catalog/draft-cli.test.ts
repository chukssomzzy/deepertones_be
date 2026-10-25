import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RawWorkbook } from '../../src/modules/catalog/catalog.workbook.schema'
import { AiBudgetExceededError } from '../../src/providers/anthropic/ai-spend.provider'
import { AnthropicConfigError } from '../../src/providers/anthropic/anthropic.provider'
import { BIG_CAP_MICROS } from '../../src/providers/anthropic/messages-api.fake'
import { MemoryAiSpendLedger } from '../../src/providers/anthropic/memory.ai-spend-ledger'
import { MemoryCatalogDrafter } from '../../src/providers/catalog-drafting/memory.catalog-drafter'
import { MemoryProductResearcher } from '../../src/providers/product-research/memory.product-researcher'
import { draftCli, type DraftCliDeps } from './draft-cli'
import { NOTHING_TO_DRAFT, NO_ACTIVE_COUNTRIES } from './draft'
import { DraftInputError } from './draft-input-error'
import { country, product, validWorkbook } from './workbook.fixture'
import { readWorkbookFile, WorkbookFileError } from './xlsx'
import { fakeOutput } from './script.fixture'

// The shell of `npm run catalog:draft` without the process: argv in, the lines it printed and the exit code out. What is pinned: the message of a
// mistake in the person's own input is printed (a bad flag, a country that is not active, a tab or a header or a formula in the file), exit 2; every
// other error prints its name only, because its message may hold a key, a path, a cell or what Claude said; and an empty workbook is not a failure.

const SECRET = 'sk-ant-secret-0123456789'
const ARGV = ['in.xlsx', '--out', 'out.xlsx']
const OK_SOURCE = 'https://www.cerave.example/page'

/** A draft row with only its identity: everything the tool can fill is empty. */
const draftRow = (code = 'PRD-DRAFT') =>
  product({ code, status: 'draft', ingredients: null, ingredients_source_url: null, skin_concerns: null, skin_types: null, steps: null, frequency: null, approved_by: null, approved_on: null })

const withDraft = (over: Partial<Record<'countries' | 'products', ReturnType<typeof product>[]>> = {}): RawWorkbook => validWorkbook({ products: [draftRow()], availability: [], countries: [country()], ...over })

const setup = (over: Partial<DraftCliDeps> & { workbook?: RawWorkbook } = {}) => {
  const out = fakeOutput()
  const researcher = new MemoryProductResearcher()
  researcher.respondWith(() => ({ found: true, ingredients: ['Aqua', 'Glycerin'], sourceUrl: OK_SOURCE }))
  const drafter = new MemoryCatalogDrafter()
  drafter.respondWith((request) => ({
    cells: { skin_concerns: { value: ['hd_acne'], sourceUrl: OK_SOURCE }, skin_types: { value: ['oily'], sourceUrl: OK_SOURCE }, steps: { value: ['cleanse'], sourceUrl: OK_SOURCE }, frequency: { value: 'am-pm', sourceUrl: OK_SOURCE } },
    availability: request.countries.map(({ code }) => ({ country: code, priceMin: 4000, priceMax: 6500, whereSold: 'Pharmacies', sourceUrl: OK_SOURCE })),
  }))
  const ledger = new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS })
  const writes: string[] = []
  const settings: { apiKey: string; maxUsd: number }[] = []
  const deps: DraftCliDeps = {
    loadApiKey: async () => SECRET,
    clients: (given) => {
      settings.push(given)
      return { researcher, drafter, ledger }
    },
    io: {
      readWorkbook: async () => ({ workbook: over.workbook ?? withDraft(), catalogVersion: 7, environment: 'staging', contractVersion: '1.0.0' }),
      writeWorkbook: async (path) => void writes.push(path),
    },
    log: out.log,
    error: out.error,
    ...over,
  }
  return { deps, out, researcher, drafter, writes, settings }
}

describe('draftCli: a run that works', () => {
  it('drafts, writes the file, prints the report and where it wrote, and exits 0 when nothing is left to fix', async () => {
    const { deps, out, writes } = setup()

    const code = await draftCli(ARGV, deps)

    expect(code).toBe(0)
    expect(writes).toEqual(['out.xlsx'])
    expect(out.stdout()).toContain('Wrote out.xlsx')
    expect(out.stdout()).toContain('No problems')
    expect(out.stderr()).toBe('')
  })

  it('hands the key and the cap in dollars to the code that builds the clients', async () => {
    const { deps, settings } = setup()

    await draftCli([...ARGV, '--max-usd', '0.5'], deps)

    expect(settings).toEqual([{ apiKey: SECRET, maxUsd: 0.5 }])
  })

  it('never prints the key', async () => {
    const { deps, out } = setup()

    await draftCli(ARGV, deps)

    expect(out.text()).not.toContain(SECRET)
  })

  it('exits 1 when a problem remains, and still writes the file', async () => {
    const { deps, out, writes, researcher } = setup()
    researcher.respondWith(() => ({ found: false }))

    expect(await draftCli(ARGV, deps)).toBe(1)
    expect(writes).toEqual(['out.xlsx'])
    expect(out.stdout()).toContain('Problems still in the workbook')
  })

  it('exits 1 when a product failed, naming its code and a fixed reason, never the message', async () => {
    const { deps, out, drafter } = setup()
    drafter.failNextWith(new Error(`rate limited for ${SECRET}`))

    expect(await draftCli(ARGV, deps)).toBe(1)
    expect(out.stdout()).toContain('PRD-DRAFT: drafter-error')
    expect(out.text()).not.toContain(SECRET)
  })

  it('exits 1 at the spend cap, and 2 when Claude refused our setup, writing the file both times', async () => {
    const cap = setup()
    cap.researcher.failNextWith(new AiBudgetExceededError('The AI spend cap would be exceeded'))
    expect(await draftCli(ARGV, cap.deps)).toBe(1)
    expect(cap.writes).toEqual(['out.xlsx'])

    const config = setup()
    config.researcher.failNextWith(new AnthropicConfigError(SECRET))
    expect(await draftCli(ARGV, config.deps)).toBe(2)
    expect(config.writes).toEqual(['out.xlsx'])
    expect(config.out.text()).not.toContain(SECRET)
  })
})

describe('draftCli: a mistake in the person\'s own input is told, exit 2', () => {
  it('prints the usage message for a bad flag, and builds nothing', async () => {
    const { deps, out, settings } = setup()

    const code = await draftCli(['in.xlsx', '--out', 'out.xlsx', '--force'], deps)

    expect(code).toBe(2)
    expect(out.stderr()).toMatch(/Unrecognised argument "--force".*Usage: npm run catalog:draft/)
    expect(settings).toEqual([])
  })

  it('prints why there is no key, which is also a setup mistake of the person', async () => {
    const { deps, out } = setup({ loadApiKey: async () => Promise.reject(new DraftInputError('ANTHROPIC_API_KEY is not set: export it, or put it in .dev.vars.')) })

    expect(await draftCli(ARGV, deps)).toBe(2)
    expect(out.stderr()).toBe('ANTHROPIC_API_KEY is not set: export it, or put it in .dev.vars.')
  })

  it('names the country and says how to add one, for a fresh export with an empty Countries tab (the owner\'s run)', async () => {
    const { deps, out, writes, researcher, drafter } = setup({ workbook: withDraft({ countries: [] }) })

    const code = await draftCli([...ARGV, '--countries', 'NG'], deps)

    expect(code).toBe(2)
    expect(out.stderr()).toBe('Not an active country in the Countries tab: NG. The Countries tab has no active country: add a row with code, currency, low_max, mid_max, status active, and run again.')
    expect(out.stderr()).not.toMatch(/unexpected/i)
    expect(writes).toEqual([])
    expect(researcher.calls).toEqual([])
    expect(drafter.calls).toEqual([])
  })

  it('lists the active countries when the code is not one of them', async () => {
    const { deps, out } = setup()

    expect(await draftCli([...ARGV, '--countries', 'GB'], deps)).toBe(2)
    expect(out.stderr()).toBe('Not an active country in the Countries tab: GB. Active countries: NG.')
  })

  it.each([
    ['a missing tab', new WorkbookFileError('The workbook is missing the Countries tab, named exactly so.')],
    ['a repeated header', new WorkbookFileError('The Products tab has the header "code" twice, in columns A and D. Each column name may appear once.')],
    ['a formula with no result', new WorkbookFileError('Availability row 2, column price_min holds a formula with no saved result. Open the file in Excel, save it, and upload that copy.')],
    ['an error of its own kind', new DraftInputError('Something about the input.')],
  ])('prints the message of %s as it is', async (_label, failure) => {
    const { deps, out, writes } = setup()
    deps.io.readWorkbook = async () => {
      throw failure
    }

    expect(await draftCli(ARGV, deps)).toBe(2)
    expect(out.stderr()).toBe(failure.message)
    expect(writes).toEqual([])
  })
})

describe('draftCli: any other error prints its name only, exit 2', () => {
  it.each([
    ['a read', 'Error'],
    ['a type error', 'TypeError'],
  ])('hides the message of %s that holds a key', async (_label, name) => {
    const { deps, out } = setup()
    const failure = name === 'TypeError' ? new TypeError(`bad ${SECRET}`) : new Error(`ENOENT ${SECRET} /home/person/in.xlsx`)
    deps.io.readWorkbook = async () => {
      throw failure
    }

    const code = await draftCli(ARGV, deps)

    expect(code).toBe(2)
    expect(out.stderr()).toBe(`The draft stopped on an unexpected ${name}. Nothing was written unless the line above says so.`)
    expect(out.text()).not.toContain(SECRET)
  })

  it('hides the message of a failed write', async () => {
    const { deps, out } = setup()
    deps.io.writeWorkbook = async () => {
      throw new Error(`EACCES ${SECRET}`)
    }

    expect(await draftCli(ARGV, deps)).toBe(2)
    expect(out.stderr()).toMatch(/unexpected Error\./)
    expect(out.text()).not.toContain(SECRET)
  })

  it('hides the message of a class that merely looks like an input error, and a value that is not an Error at all', async () => {
    const lookalike = setup()
    lookalike.deps.io.readWorkbook = async () => {
      throw Object.assign(new Error(`not ours ${SECRET}`), { name: 'DraftInputError' })
    }
    expect(await draftCli(ARGV, lookalike.deps)).toBe(2)
    expect(lookalike.out.text()).not.toContain(SECRET)

    const thrown = setup()
    thrown.deps.io.readWorkbook = async () => {
      throw SECRET
    }
    expect(await draftCli(ARGV, thrown.deps)).toBe(2)
    expect(thrown.out.stderr()).toMatch(/unexpected UnknownError\./)
    expect(thrown.out.text()).not.toContain(SECRET)
  })

  it.each([
    ['an Error that holds a key', new Error(`cannot read .dev.vars: ${SECRET}`), 'Error'],
    ['a TypeError', new TypeError(`bad ${SECRET}`), 'TypeError'],
    ['a string', SECRET, 'UnknownError'],
    ['null', null, 'UnknownError'],
    ['undefined', undefined, 'UnknownError'],
  ])('hides the same way when the key cannot be loaded: %s', async (_label, failure, name) => {
    const { deps, out, settings } = setup({ loadApiKey: () => Promise.reject(failure) })

    expect(await draftCli(ARGV, deps)).toBe(2)
    expect(out.stderr()).toBe(`The draft stopped on an unexpected ${name}. Nothing was written unless the line above says so.`)
    expect(out.text()).not.toContain(SECRET)
    expect(settings).toEqual([])
  })

  it('does not fail on null or undefined thrown while drafting', async () => {
    for (const failure of [null, undefined]) {
      const { deps, out } = setup()
      deps.io.readWorkbook = () => Promise.reject(failure)

      expect(await draftCli(ARGV, deps)).toBe(2)
      expect(out.stderr()).toMatch(/unexpected UnknownError\./)
    }
  })

  it('hides the message of a client that cannot be built', async () => {
    const { deps, out } = setup({
      clients: () => {
        throw new Error(`bad key ${SECRET}`)
      },
    })

    expect(await draftCli(ARGV, deps)).toBe(2)
    expect(out.text()).not.toContain(SECRET)
  })
})

describe('draftCli: a workbook with nothing to draft', () => {
  it('says so plainly and exits 0, without writing a file, naming the file, or printing a report', async () => {
    const { deps, out, writes, researcher, drafter } = setup({ workbook: withDraft({ products: [], countries: [] }) })

    const code = await draftCli(ARGV, deps)

    expect(code).toBe(0)
    expect(out.stdout()).toBe(NOTHING_TO_DRAFT)
    expect(out.stderr()).toBe('')
    expect(writes).toEqual([])
    expect(researcher.calls).toEqual([])
    expect(drafter.calls).toEqual([])
  })

  it('does the same when every product is already approved', async () => {
    const { deps, out, writes } = setup({ workbook: withDraft({ products: [product()] }) })

    expect(await draftCli(ARGV, deps)).toBe(0)
    expect(out.stdout()).toBe(NOTHING_TO_DRAFT)
    expect(writes).toEqual([])
  })

  it('keeps the report when there are draft rows and every one was skipped, and exits 0 with a file written', async () => {
    const { deps, out, writes } = setup({ workbook: withDraft({ products: [{ ...draftRow('PRD-NAMELESS'), name: null, ingredients: 'Aqua', ingredients_source_url: OK_SOURCE, skin_concerns: 'hd_acne', skin_types: 'oily', steps: 'cleanse', frequency: 'am-pm' }] }) })

    await draftCli(ARGV, deps)

    expect(out.stdout()).toContain('Skipped')
    expect(out.stdout()).toContain('PRD-NAMELESS')
    expect(out.stdout()).toContain('Wrote out.xlsx')
    expect(writes).toEqual(['out.xlsx'])
    expect(out.stdout()).not.toContain(NOTHING_TO_DRAFT)
  })
})

describe('draftCli: no active countries and no --countries', () => {
  it('says so first, drafts the product cells without prices, and carries on', async () => {
    const { deps, out, writes, drafter } = setup({ workbook: withDraft({ countries: [] }) })

    const code = await draftCli(ARGV, deps)

    expect(out.stdout().split('\n')[0]).toBe(NO_ACTIVE_COUNTRIES)
    expect(drafter.calls[0]!.countries).toEqual([])
    expect(writes).toEqual(['out.xlsx'])
    expect(out.stdout()).toContain('Wrote out.xlsx')
    expect(code).toBe(0)
  })
})

describe('draftCli: the input file itself, read for real', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'catalog-draft-cli-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('says there is no file at the path as typed, exit 2, and writes nothing', async () => {
    const { deps, out, writes } = setup()
    deps.io.readWorkbook = readWorkbookFile
    const typed = join(dir, 'catalog-staging-v1.xlsx')

    expect(await draftCli([typed, '--out', 'out.xlsx'], deps)).toBe(2)
    expect(out.stderr()).toBe(`No file at ${typed}`)
    expect(writes).toEqual([])
  })

  it('says the file is not an .xlsx workbook, in fixed words and not the library\'s, exit 2', async () => {
    const { deps, out, writes } = setup()
    deps.io.readWorkbook = readWorkbookFile
    const typed = join(dir, 'export.xlsx')
    await writeFile(typed, `this is not a zip file ${SECRET}`)

    expect(await draftCli([typed, '--out', 'out.xlsx'], deps)).toBe(2)
    expect(out.stderr()).toBe(`${typed} could not be read as an .xlsx workbook (not one, or damaged): save it from Excel or LibreOffice as .xlsx.`)
    expect(out.text()).not.toContain(SECRET)
    expect(writes).toEqual([])
  })
})
