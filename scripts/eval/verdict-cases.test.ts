import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { caseOf, FIXTURE, FIXTURE_CASES, FIXTURE_HOLDOUT, FIXTURE_MAIN, noLabel, product } from './verdict.fixture'
import { DEFAULT_VERDICT_ROOT, loadVerdictCases, VerdictCaseError, type VerdictCase } from './verdict-cases'

// The verdict eval's cases: one JSON file per synthetic shelf at <root>/cases/{main,holdout}/<id>.json, in the gitignored eval-data/verdict folder. The loader
// checks each file against a closed schema and then the whole set against the rules a hand-written file most easily breaks: ids that clash, ids that point at
// nothing, a skin product with no expectation, and two cases that are the same shelf. Everything here is pure and costs nothing; the files are written to a
// temp folder by the test and the owner's folder is never read.

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'verdict-cases-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

type SetName = 'main' | 'holdout'
/** A file to write: the case, and the name of the file when it is not `<id>.json`. */
type Put = VerdictCase | { json: unknown; file: string }
const asFile = (put: Put): { json: unknown; file: string } => ('file' in put ? put : { json: put, file: `${put.id}.json` })

/** Writes the folders the loader reads. A set left out is not created, so a missing folder is a test of its own. */
const seed = async (sets: Partial<Record<SetName, Put[]>>) => {
  for (const [name, puts] of Object.entries(sets)) {
    const folder = join(root, 'cases', name)
    await mkdir(folder, { recursive: true })
    for (const put of puts) {
      const { json, file } = asFile(put)
      await writeFile(join(folder, file), typeof json === 'string' ? json : JSON.stringify(json))
    }
  }
}
const seedAll = (main: Put[], holdout: Put[] = []) => seed({ main, holdout })

/** The text of the error the loader throws, or fails the test when it loads. */
const refusal = async (): Promise<string> => {
  const error = await loadVerdictCases(root).then(
    () => null,
    (e: unknown) => e,
  )
  expect(error, 'the loader should have refused these cases').toBeInstanceOf(VerdictCaseError)
  return (error as VerdictCaseError).message
}

/** A case that passes every rule on its own shelf, so a test breaks the one rule it is about. */
const valid = (id: string, over: Partial<VerdictCase> = {}): VerdictCase => {
  const mark = id.replace(/\W/g, '')
  return caseOf(id, {
    shelf: [product('a', { brand: `Brand${mark}`, name: `Name ${mark}` })],
    expect: { entries: { a: { outcome: 'open' } }, clashes: [] },
    ...over,
  })
}

describe('loadVerdictCases', () => {
  it('reads every case of both folders, each exactly as written, in id order', async () => {
    await seedAll([...FIXTURE_MAIN].reverse(), [...FIXTURE_HOLDOUT].reverse())

    const loaded = await loadVerdictCases(root)

    expect(loaded.main).toEqual([...FIXTURE_MAIN].sort((a, b) => (a.id < b.id ? -1 : 1)))
    expect(loaded.holdout).toEqual([...FIXTURE_HOLDOUT].sort((a, b) => (a.id < b.id ? -1 : 1)))
  })

  it('keeps a persona, a scan, a variant and a catalog code, which the fixture cases mostly leave out', async () => {
    const rich = valid('main-20', {
      persona: 'amara',
      scan: { skinType: 'oily', concerns: [{ concern: 'hd_age_spot', band: 'clear' }] },
      shelf: [product('a', { brand: 'BrandRich', name: 'Name Rich', variant: 'Night', source: { catalogCode: 'PRD-ONE' } })],
    })
    await seedAll([rich])

    expect((await loadVerdictCases(root)).main).toEqual([rich])
  })

  it('has the gitignored folder the owner keeps the cases in as its default root', () => {
    expect(DEFAULT_VERDICT_ROOT).toBe('eval-data/verdict')
  })

  it('accepts the fixture cases as a whole: they are the example of a valid set', async () => {
    await seedAll(FIXTURE_MAIN, FIXTURE_HOLDOUT)

    await expect(loadVerdictCases(root)).resolves.toBeDefined()
    expect(FIXTURE_CASES.length).toBe(FIXTURE_MAIN.length + FIXTURE_HOLDOUT.length)
  })

  it('lets two different cases use the same entry id: entry ids are only unique inside a case', async () => {
    await seedAll([valid('main-01'), valid('main-02')])

    const { main } = await loadVerdictCases(root)

    expect(main.map((c) => c.shelf[0]!.id)).toEqual(['a', 'a'])
  })

  it('accepts a non-skin product with no expectation at all', async () => {
    await seedAll([valid('main-01', { shelf: [product('a', { brand: 'BrandX', name: 'Name X' }), product('b', { brand: 'BrandY', name: 'Name Y', category: 'hair' })] })])

    await expect(loadVerdictCases(root)).resolves.toBeDefined()
  })

  describe('a folder that is missing', () => {
    it('is refused with the path of the folder, for the main set', async () => {
      await seed({ holdout: [valid('hold-01')] })

      expect(await refusal()).toContain(join(root, 'cases', 'main'))
    })

    it('is refused with the path of the folder, for the holdout set', async () => {
      await seed({ main: [valid('main-01')] })

      expect(await refusal()).toContain(join(root, 'cases', 'holdout'))
    })

    it('is refused with both paths when neither exists', async () => {
      const message = await refusal()

      expect(message).toContain(join(root, 'cases', 'main'))
      expect(message).toContain(join(root, 'cases', 'holdout'))
    })
  })

  describe('a file that cannot be read as a case', () => {
    it('is refused when it is not JSON, naming the file', async () => {
      await seedAll([{ json: '{ not json', file: 'main-01.json' }])

      expect(await refusal()).toContain('main-01.json')
    })

    it.each([
      ['a goal that is null', { goal: null }, 'goal'],
      ['a goal that is not one of the six', { goal: 'glowy' }, 'goal'],
      ['a country that is not NG or GB', { country: 'US' }, 'country'],
      ['a persona that is none of the four', { persona: 'bola' }, 'persona'],
      ['a key the schema does not know', { mood: 'sad' }, 'mood'],
      ['a safety choice that is not one', { safety: { choices: ['allergic'], mentions: [] } }, 'choices'],
      ['a scan band that is not one', { scan: { skinType: null, concerns: [{ concern: 'hd_age_spot', band: 'huge' }] } }, 'band'],
      ['a scan skin type that is not one', { scan: { skinType: 'scaly', concerns: [] } }, 'skinType'],
      ['an expectation that is not an outcome', { expect: { entries: { a: { outcome: 'maybe' } }, clashes: [] } }, 'expect'],
      ['an expected taper that is not a kind', { expect: { entries: { a: { outcome: 'fixed', group: 'likely-the-problem', verdict: 'stop', taper: 'retinoid' } }, clashes: [] } }, 'taper'],
      ['an expected group that is not one', { expect: { entries: { a: { outcome: 'fixed', group: 'bad', verdict: 'drop' } }, clashes: [] } }, 'group'],
    ] as [string, Record<string, unknown>, string][])('is refused for %s, naming the case and where the fault is', async (_label, change, where) => {
      await seedAll([{ json: { ...valid('main-01'), ...change }, file: 'main-01.json' }])

      const message = await refusal()

      expect(message).toContain('main-01')
      expect(message).toContain(where)
    })

    it.each([
      ['a form that is not one', { form: 'foam' }, 'form'],
      ['a category that is not one', { category: 'scalp' }, 'category'],
      ['a step that is not one', { steps: ['exfoliate'] }, 'steps'],
      ['a source that is neither a catalog code nor made up', { source: { found: 'online' } }, 'source'],
      ['a field the entry does not have', { price: 4 }, 'price'],
    ] as [string, Record<string, unknown>, string][])('is refused for a shelf product with %s', async (_label, change, where) => {
      const entry = { ...product('a', { brand: 'BrandX', name: 'Name X' }), ...change }
      await seedAll([{ json: { ...valid('main-01'), shelf: [entry] }, file: 'main-01.json' }])

      const message = await refusal()

      expect(message).toContain('main-01')
      expect(message).toContain(where)
    })

    it('is refused for a no-label item whose purpose is not one', async () => {
      await seedAll([{ json: { ...valid('main-01'), shelf: [{ ...noLabel('a', 'lighten'), purpose: 'whiten' }] }, file: 'main-01.json' }])

      const message = await refusal()

      expect(message).toContain('main-01')
      expect(message).toContain('purpose')
    })
  })

  describe('ids', () => {
    it('refuses a main case whose id carries the holdout prefix, and a holdout case whose id carries the main prefix', async () => {
      await seedAll([valid('hold-05')], [valid('main-05')])

      const message = await refusal()

      expect(message).toContain('hold-05')
      expect(message).toContain('main-05')
    })

    it('refuses a file whose name is not its case id', async () => {
      await seedAll([{ json: valid('main-01'), file: 'main-02.json' }])

      expect(await refusal()).toContain('main-02.json')
    })

    it('refuses a case id that two files in a set both claim, naming the id', async () => {
      await seedAll([valid('main-01'), { json: valid('main-01', { shelf: [product('a', { brand: 'BrandOther', name: 'Name Other' })] }), file: 'main-01-copy.json' }])

      expect(await refusal()).toContain('main-01')
    })

    it('refuses a case id that is in both sets, naming the id', async () => {
      await seedAll([valid('main-01')], [valid('main-01', { shelf: [product('a', { brand: 'BrandOther', name: 'Name Other' })] })])

      expect(await refusal()).toContain('main-01')
    })

    it('refuses an entry id that is used twice on one shelf, naming the case and the id', async () => {
      await seedAll([valid('main-01', { shelf: [product('twin', { brand: 'BrandX', name: 'Name X' }), product('twin', { brand: 'BrandY', name: 'Name Y' })], expect: { entries: { twin: { outcome: 'open' } }, clashes: [] } })])

      const message = await refusal()

      expect(message).toContain('main-01')
      expect(message).toContain('twin')
    })
  })

  describe('references', () => {
    const mention = (resolvesTo: string | null) => ({ source: 'reaction' as const, kind: 'product' as const, name: 'Some Cream', resolvesTo })

    it('refuses a mention that resolves to an entry the shelf does not have, naming the case and the id', async () => {
      await seedAll([valid('main-01', { safety: { choices: ['reaction'], mentions: [mention('ghost')] } })])

      const message = await refusal()

      expect(message).toContain('main-01')
      expect(message).toContain('ghost')
    })

    it('accepts a mention that resolves to an entry of the shelf, and one that resolves to nothing', async () => {
      await seedAll([valid('main-01', { safety: { choices: ['reaction'], mentions: [mention('a'), mention(null)] } })])

      await expect(loadVerdictCases(root)).resolves.toBeDefined()
    })

    it('refuses an expectation for an entry the shelf does not have, naming the case and the id', async () => {
      await seedAll([valid('main-01', { expect: { entries: { a: { outcome: 'open' }, ghost: { outcome: 'open' } }, clashes: [] } })])

      const message = await refusal()

      expect(message).toContain('main-01')
      expect(message).toContain('ghost')
    })

    it.each([
      ['first', [['ghost', 'b']]],
      ['second', [['a', 'ghost']]],
    ] as const)('refuses an expected clash whose %s id is not on the shelf', async (_which, clashes) => {
      const shelf = [product('a', { brand: 'BrandX', name: 'Name X' }), product('b', { brand: 'BrandY', name: 'Name Y' })]
      await seedAll([valid('main-01', { shelf, expect: { entries: { a: { outcome: 'open' }, b: { outcome: 'open' } }, clashes: clashes.map(([x, y]) => [x!, y!]) } })])

      const message = await refusal()

      expect(message).toContain('main-01')
      expect(message).toContain('ghost')
    })

    it('accepts an expected clash between two entries of the shelf', async () => {
      await seedAll([FIXTURE.retinoidAcidClash].map((c) => ({ ...c, id: 'main-01' })))

      await expect(loadVerdictCases(root)).resolves.toBeDefined()
    })
  })

  describe('expectations', () => {
    it('refuses a skin product with no expectation, naming the case and the entry', async () => {
      await seedAll([valid('main-01', { shelf: [product('lonely', { brand: 'BrandX', name: 'Name X' })], expect: { entries: {}, clashes: [] } })])

      const message = await refusal()

      expect(message).toContain('main-01')
      expect(message).toContain('lonely')
    })

    it('refuses a no-label item with no expectation: it is a skin entry to the floor', async () => {
      await seedAll([valid('main-01', { shelf: [noLabel('jar', 'lighten')], expect: { entries: {}, clashes: [] } })])

      const message = await refusal()

      expect(message).toContain('main-01')
      expect(message).toContain('jar')
    })

    it('names the second skin product when only the first has an expectation', async () => {
      const shelf = [product('first', { brand: 'BrandX', name: 'Name X' }), product('second', { brand: 'BrandY', name: 'Name Y' })]
      await seedAll([valid('main-01', { shelf, expect: { entries: { first: { outcome: 'open' } }, clashes: [] } })])

      expect(await refusal()).toContain('second')
    })
  })

  describe('two cases that are the same shelf', () => {
    const shelfOf = (...names: string[]) => names.map((name, i) => product(`p${i}`, { brand: 'Zenvi', name }))
    const expects = (count: number) => ({ entries: Object.fromEntries(Array.from({ length: count }, (_, i) => [`p${i}`, { outcome: 'open' as const }])), clashes: [] })

    it('refuses two cases in one set with the same products, naming both', async () => {
      await seedAll([valid('main-01', { shelf: shelfOf('Alpha', 'Beta'), expect: expects(2) }), valid('main-02', { goal: 'glow', shelf: shelfOf('Alpha', 'Beta'), expect: expects(2) })])

      const message = await refusal()

      expect(message).toContain('main-01')
      expect(message).toContain('main-02')
    })

    it('refuses a holdout case that has the shelf of a main case, naming both', async () => {
      await seedAll([valid('main-01', { shelf: shelfOf('Alpha', 'Beta'), expect: expects(2) })], [valid('hold-01', { shelf: shelfOf('Alpha', 'Beta'), expect: expects(2) })])

      const message = await refusal()

      expect(message).toContain('main-01')
      expect(message).toContain('hold-01')
    })

    it('counts the shelf as the same whatever order its products are in and whatever the entries are called', async () => {
      const reordered = [product('x', { brand: 'Zenvi', name: 'Beta' }), product('y', { brand: 'Zenvi', name: 'Alpha' })]
      await seedAll([
        valid('main-01', { shelf: shelfOf('Alpha', 'Beta'), expect: expects(2) }),
        valid('main-02', { shelf: reordered, expect: { entries: { x: { outcome: 'open' }, y: { outcome: 'open' } }, clashes: [] } }),
      ])

      const message = await refusal()

      expect(message).toContain('main-01')
      expect(message).toContain('main-02')
    })

    it('counts a product as the same product when only the capitals or the spacing of its brand and name differ', async () => {
      await seedAll([
        valid('main-01', { shelf: [product('a', { brand: 'Zenvi', name: 'Alpha Glow' })] }),
        valid('main-02', { shelf: [product('a', { brand: ' ZENVI ', name: 'alpha  glow' })] }),
      ])

      expect(await refusal()).toContain('main-02')
    })

    it('counts a catalog product as the same product by its code, whatever it is called', async () => {
      await seedAll([
        valid('main-01', { shelf: [product('a', { brand: 'Zenvi', name: 'Alpha', source: { catalogCode: 'PRD-ONE' } })] }),
        valid('main-02', { shelf: [product('a', { brand: 'Zenvi', name: 'Alpha Renamed', source: { catalogCode: 'PRD-ONE' } })] }),
      ])

      expect(await refusal()).toContain('main-02')
    })

    it('counts two shelves of the same no-label items as the same shelf', async () => {
      await seedAll([
        valid('main-01', { shelf: [noLabel('a', 'lighten')], expect: expects(1) }),
        valid('main-02', { shelf: [noLabel('z', 'lighten')], expect: { entries: { z: { outcome: 'open' } }, clashes: [] } }),
      ])

      expect(await refusal()).toContain('main-02')
    })

    it('accepts shelves that differ by one product, a variant or a no-label purpose', async () => {
      await seedAll([
        valid('main-01', { shelf: shelfOf('Alpha', 'Beta'), expect: expects(2) }),
        valid('main-02', { shelf: shelfOf('Alpha', 'Gamma'), expect: expects(2) }),
        valid('main-03', { shelf: shelfOf('Alpha'), expect: expects(1) }),
        valid('main-04', { shelf: [product('p0', { brand: 'Zenvi', name: 'Alpha', variant: 'Night' })], expect: expects(1) }),
        valid('main-05', { shelf: [noLabel('p0', 'lighten')], expect: expects(1) }),
        valid('main-06', { shelf: [noLabel('p0', 'moisturise')], expect: expects(1) }),
      ])

      await expect(loadVerdictCases(root)).resolves.toBeDefined()
    })
  })

  it('lists every problem it finds, not only the first: two broken cases are both named', async () => {
    await seedAll([valid('main-01', { expect: { entries: {}, clashes: [] } }), valid('main-02', { safety: { choices: ['reaction'], mentions: [{ source: 'reaction', kind: 'product', name: 'X', resolvesTo: 'ghost' }] } })])

    const message = await refusal()

    expect(message).toContain('main-01')
    expect(message).toContain('main-02')
    expect(message).toContain('ghost')
  })
})

// --- the no-overfitting guard --------------------------------------------------------------------------------------------------------------------------

// A prompt that names a product from the eval's own cases would make the eval agree with itself. So no brand and no product name of any case may appear in
// the fit judge's prompt. The helper takes any list of cases, so the same guard can read the real cases (which only exist on the owner's machine) with the
// same lines the committed fixture is read with here.

const PROMPT_PATH = join(import.meta.dirname, '../../src/prompts/verdict-fitter.fit-verdict.md')

const squash = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').trim()

/** Every brand and name of the cases' shelf products that the text contains as a whole word or phrase (case and spacing aside). */
const namedInText = (cases: readonly VerdictCase[], text: string): string[] => {
  const haystack = ` ${squash(text).replace(/[^\p{L}\p{N}]+/gu, ' ')} `
  const found = cases.flatMap((c) => c.shelf.flatMap((entry) => (entry.kind === 'product' ? [entry.brand, entry.name] : [])))
  return [...new Set(found)].filter((name) => haystack.includes(` ${squash(name).replace(/[^\p{L}\p{N}]+/gu, ' ')} `))
}

describe('the fit-verdict prompt names no product of the cases', () => {
  const prompt = readFileSync(PROMPT_PATH, 'utf8')

  it('names no brand and no product name of the fixture cases', () => {
    expect(namedInText(FIXTURE_CASES, prompt)).toEqual([])
  })

  it('does name a product when a case has one the prompt contains: the guard can fail', () => {
    const planted = valid('main-90', { shelf: [product('a', { brand: 'Brand90', name: 'Deeper Tones' })] })

    expect(namedInText([planted], prompt)).toEqual(['Deeper Tones'])
  })

  it('finds a brand whatever its capitals and spacing, and only as whole words', () => {
    const cases = [valid('main-91', { shelf: [product('a', { brand: 'Soft  CERAMIDE', name: 'Soft Ceramide Cream' }), product('b', { brand: 'Cer', name: 'Clar' })] })]

    expect(namedInText(cases, 'A soft ceramide serum, clarity and ceramide.')).toEqual(['Soft  CERAMIDE'])
  })
})
