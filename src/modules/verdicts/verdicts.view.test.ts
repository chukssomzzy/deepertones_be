import { describe, expect, it } from 'vitest'
import { FREQUENCIES, TAPER_KINDS, type TaperKind } from '../catalog/catalog.vocabulary'
import type { TaperRow } from '../catalog/catalog.workbook.schema'
import { FORBIDDEN_WORDING } from '../routines/routines.wording'
import type { ShelfVerdict } from '../routines/routines.types'
import type { VerdictGroup } from './verdicts.merge'
import type { SavedVerdictProduct, ShownVerdictProduct } from './verdicts.types'
import { previewOf, toShelfVerdictResponse, type VerdictView } from './verdicts.view'

// The verdict screen's `groups` and each product's `suggest` (spec #259, PR A2): FIXED copy, worked out by rules and never by a model, so these are pure mappings.
// Both are tested through the seam that already exists: `toShelfVerdictResponse` turns a view (the locked preview `previewOf` builds, or the full verdict) into
// the body GET /me/verdict answers and the event stream sends. No new function is assumed.
//
// WHAT IS PINNED
//   groups   on both ready shapes (the locked preview and the full verdict), never on `pending`: { group, title, subtitle, intro, count }[] in the owner's order,
//            every group always present with count 0 where empty. The locked preview keeps `counts`, and groups[].count equals it. On the full verdict, count is
//            the number of products in that group.
//   suggest  on every product of the full verdict: 1 to 3 fixed lines from the verdict alone (plus two flags: `escalate` on a drop, and the can't-tell group).
//            keep / reduce (one line per frequency) / stop (names the taper's kind, never stop suddenly) / drop (stop now; plus see a professional when escalate).
// WHAT IS NOT PINNED: the exact words. The titles and subtitles are the owner's screen 7.1 (quoted in the brief), so those are exact; everything else is
// pinned by shape, non-emptiness, meaning and the wording gate (FORBIDDEN_WORDING). The copy awaits the owner's sign-off, so the words may change.

// The owner's order of the screen, and the headings of screen 7.1 (the last three titles are the brief's; their subtitles are not fixed yet).
const GROUP_ORDER: VerdictGroup[] = ['likely-the-problem', 'conflicting', 'cant-tell', 'blocking', 'redundant', 'helping', 'prescribed', 'undecided']
const OWNER_TITLES: Record<VerdictGroup, string> = {
  'likely-the-problem': 'Likely the problem',
  conflicting: 'Conflicting',
  'cant-tell': "Can't tell what's in it",
  blocking: 'Blocking your goal',
  redundant: 'Redundant',
  helping: 'Helping',
  prescribed: 'Prescribed',
  undecided: 'Still checking',
}
const OWNER_SUBTITLES: Partial<Record<VerdictGroup, string>> = {
  helping: 'Working toward your goal',
  redundant: 'Doing the same job as another',
  blocking: 'Holding your goal back',
  conflicting: "Don't work well together",
  'likely-the-problem': "What's causing trouble",
}

const EVERY_GROUP_ZERO: Record<VerdictGroup, number> = { helping: 0, redundant: 0, blocking: 0, conflicting: 0, 'likely-the-problem': 0, 'cant-tell': 0, prescribed: 0, undecided: 0 }

const trips = (text: string): string[] => FORBIDDEN_WORDING.filter(({ pattern }) => pattern.test(text)).map(({ code }) => code)
const expectPassesTheGate = (text: string, where: string) => expect(trips(text), `${where}: "${text}"`).toEqual([])

let entries = 0
const product = (group: VerdictGroup, verdict: ShelfVerdict, over: Partial<SavedVerdictProduct> = {}): ShownVerdictProduct => ({
  entryId: `entry-${entries++}`,
  group,
  verdict,
  escalate: false,
  reason: 'A reason the rules wrote.',
  facts: [],
  basis: [],
  step: null,
  sourceUrls: [],
  ...over,
})

const taper = (code: string, kind: TaperKind): TaperRow => ({
  code,
  kind,
  schedule: [
    { fromWeek: 1, toWeek: 2, frequency: 'alternate-days' },
    { fromWeek: 3, toWeek: 3, frequency: 'stop' },
  ],
  whatToExpect: 'Skin may flare for a few days.',
  seeAProfessionalIf: 'The redness spreads.',
  status: 'approved',
  approvedBy: null,
  approvedOn: null,
  auditedBy: null,
  auditedOn: null,
})
const TAPERS = [taper('TPR-STEROID', 'steroid'), taper('TPR-LIGHTENING', 'lightening-agent')]
const TAPER_CODE: Record<TaperKind, string> = { steroid: 'TPR-STEROID', 'lightening-agent': 'TPR-LIGHTENING' }

type Professional = { whoToSee: string; howSoon: string; whatToTellThem: string }
const full = (products: ShownVerdictProduct[], professional: Professional | null = null): VerdictView => ({ status: 'ready', locked: false, fit: 'ready', products, tapers: TAPERS, professional })

type FullBody = Extract<ReturnType<typeof toShelfVerdictResponse>, { locked: false }>
type LockedBody = Extract<ReturnType<typeof toShelfVerdictResponse>, { locked: true }>
const fullBody = (products: ShownVerdictProduct[], professional: Professional | null = null): FullBody => toShelfVerdictResponse(full(products, professional)) as FullBody
const lockedBody = (products: ShownVerdictProduct[]): LockedBody => toShelfVerdictResponse(previewOf('ready', products)) as LockedBody

/** The lines shown for one product. */
const suggestFor = (item: ShownVerdictProduct): string[] => {
  const [shown] = fullBody([item]).products
  const lines = (shown as { suggest?: string[] }).suggest
  // A product with no `suggest` fails here, so a test that looks for a line's absence cannot pass on a body that has none at all.
  if (lines === undefined) throw new Error(`the ${shown!.group} ${shown!.verdict.kind} product has no suggest`)
  return lines
}

// Nine products across the groups: the independent source for the counts (written out, not derived from the code under test).
const SHELF = (): ShownVerdictProduct[] => [
  product('likely-the-problem', { kind: 'stop', taperTemplateId: 'TPR-STEROID' }),
  product('likely-the-problem', { kind: 'drop' }, { escalate: true }),
  product('helping', { kind: 'keep' }),
  product('helping', { kind: 'keep' }),
  product('helping', { kind: 'keep' }),
  product('redundant', { kind: 'drop' }, { sameJobAs: 'entry-x' }),
  product('cant-tell', { kind: 'drop' }, { nudge: 'photograph-back-label' }),
  product('conflicting', { kind: 'reduce', maxFrequency: 'alternate-days' }),
  product('undecided', { kind: 'keep' }),
]
const SHELF_COUNTS: Record<VerdictGroup, number> = { ...EVERY_GROUP_ZERO, 'likely-the-problem': 2, helping: 3, redundant: 1, 'cant-tell': 1, conflicting: 1, undecided: 1 }

describe('toShelfVerdictResponse: groups', () => {
  describe('on the locked preview', () => {
    it('lists every group in the owner\'s order, with the counts of the preview, so the app reads all eight and hides the zeros', () => {
      const body = lockedBody(SHELF())

      expect((body as { groups?: unknown }).groups).toBeDefined()
      const groups = (body as unknown as { groups: { group: VerdictGroup; count: number }[] }).groups
      expect(groups.map(({ group }) => group)).toEqual(GROUP_ORDER)
      expect(groups.map(({ count }) => count)).toEqual(GROUP_ORDER.map((group) => SHELF_COUNTS[group]))
    })

    it('keeps `counts` for compatibility, and groups[].count equals it for every group', () => {
      const body = lockedBody(SHELF()) as LockedBody & { groups: { group: VerdictGroup; count: number }[] }

      expect(body.counts).toEqual(SHELF_COUNTS)
      expect(Object.fromEntries(body.groups.map(({ group, count }) => [group, count]))).toEqual(body.counts)
    })

    it('still lists all eight groups, each with count 0, for a shelf with no skin-care product', () => {
      const body = lockedBody([]) as LockedBody & { groups: { group: VerdictGroup; count: number }[] }

      expect(body.groups.map(({ group }) => group)).toEqual(GROUP_ORDER)
      expect(body.groups.every(({ count }) => count === 0)).toBe(true)
      expect(body.counts).toEqual(EVERY_GROUP_ZERO)
    })

    it('keeps the rest of the preview as it was: nothing of the products and nothing but the groups added', () => {
      const body = lockedBody(SHELF())

      expect(Object.keys(body).sort()).toEqual(['counts', 'escalates', 'fit', 'groups', 'locked', 'status', 'total'])
      expect(body).toMatchObject({ status: 'ready', locked: true, fit: 'ready', total: 9, escalates: 1 })
    })
  })

  describe('on the full verdict', () => {
    it('lists every group in the owner\'s order, with the number of products in each as its count', () => {
      const body = fullBody(SHELF()) as FullBody & { groups?: { group: VerdictGroup; count: number }[] }

      expect(body.groups).toBeDefined()
      expect(body.groups!.map(({ group }) => group)).toEqual(GROUP_ORDER)
      expect(Object.fromEntries(body.groups!.map(({ group, count }) => [group, count]))).toEqual(SHELF_COUNTS)
    })

    it('counts the same as the locked preview of the same shelf, since both are one saved verdict', () => {
      const shelf = SHELF()

      const countsOf = (body: unknown) => (body as { groups: { group: string; count: number }[] }).groups.map(({ group, count }) => [group, count])

      expect(countsOf(fullBody(shelf))).toEqual(countsOf(lockedBody(shelf)))
    })

    it('lists all eight groups, each with count 0, for an empty verdict', () => {
      const body = fullBody([]) as FullBody & { groups?: { group: VerdictGroup; count: number }[] }

      expect(body.groups!.map(({ group }) => group)).toEqual(GROUP_ORDER)
      expect(body.groups!.every(({ count }) => count === 0)).toBe(true)
    })

    it('adds only `groups` to the body that was there: the status, lock, fit, products and step-downs', () => {
      expect(Object.keys(fullBody(SHELF())).sort()).toEqual(['fit', 'groups', 'locked', 'products', 'professional', 'status', 'tapers'])
    })

    it('gives the same fixed words on the full verdict as on the preview, whatever the shelf holds', () => {
      const words = (body: unknown) => (body as { groups: { group: string; title: string; subtitle: string; intro: string }[] }).groups.map(({ count: _count, ...fixed }: any) => fixed)

      expect(words(fullBody(SHELF()))).toEqual(words(lockedBody([])))
    })
  })

  describe('on pending', () => {
    it('is not there: a build that has not finished has no groups to show', () => {
      const body = toShelfVerdictResponse({ status: 'pending' })

      expect(body).toEqual({ status: 'pending' })
      expect(body).not.toHaveProperty('groups')
    })
  })

  describe('the fixed copy of each group', () => {
    const groups = (): { group: VerdictGroup; title: string; subtitle: string; intro: string; count: number }[] => (lockedBody([]) as any).groups

    it('gives each group exactly the fields group, title, subtitle, intro and count', () => {
      for (const entry of groups()) expect(Object.keys(entry).sort()).toEqual(['count', 'group', 'intro', 'subtitle', 'title'])
    })

    it('titles each group as the owner\'s screen does (and the brief\'s three), and subtitles the five the owner wrote', () => {
      const shown = groups()

      expect(Object.fromEntries(shown.map(({ group, title }) => [group, title]))).toEqual(OWNER_TITLES)
      for (const [group, subtitle] of Object.entries(OWNER_SUBTITLES)) expect(shown.find((entry) => entry.group === group)!.subtitle).toBe(subtitle)
    })

    it('has a non-empty title, subtitle and intro for every group, none of them the same as another group\'s', () => {
      const shown = groups()

      for (const { group, title, subtitle, intro } of shown) {
        for (const text of [title, subtitle, intro]) expect(text.trim().length, `${group} has an empty line`).toBeGreaterThan(0)
      }
      for (const field of ['title', 'subtitle', 'intro'] as const) expect(new Set(shown.map((entry) => entry[field])).size, `two groups share a ${field}`).toBe(shown.length)
    })

    it('writes each intro as one or two plain sentences about the products, never about the person: no "you are", "you\'re" or "you have", no digits', () => {
      for (const { group, intro } of groups()) {
        const sentences = intro.split(/[.!?]+(?:\s+|$)/).filter((sentence) => sentence.trim().length > 0)
        expect(sentences.length, `${group}: "${intro}"`).toBeGreaterThanOrEqual(1)
        expect(sentences.length, `${group}: "${intro}"`).toBeLessThanOrEqual(2)
        expect(intro, `${group}: "${intro}"`).not.toMatch(/\byou(?:\s+are|\s+have|'re|'ve)\b/i)
        expect(intro, `${group}: "${intro}"`).not.toMatch(/\d/)
      }
    })

    it('passes the wording gate on every title, subtitle and intro: no diagnosis, no condition name, no lightness, no score', () => {
      for (const { group, title, subtitle, intro } of groups()) {
        for (const [field, text] of Object.entries({ title, subtitle, intro })) expectPassesTheGate(text, `${group} ${field}`)
      }
    })
  })
})

describe('toShelfVerdictResponse: suggest', () => {
  const KINDS: TaperKind[] = [...TAPER_KINDS]

  it('is on every product of the full verdict, as one to three non-empty lines', () => {
    const { products } = fullBody(SHELF())

    expect(products).toHaveLength(9)
    for (const shown of products) {
      const lines = (shown as { suggest?: string[] }).suggest
      expect(lines, `${shown.group} ${shown.verdict.kind}`).toBeDefined()
      expect(lines!.length).toBeGreaterThanOrEqual(1)
      expect(lines!.length).toBeLessThanOrEqual(3)
      for (const line of lines!) expect(line.trim().length).toBeGreaterThan(0)
    }
  })

  it('is never on the locked preview: a guest is told how many products, never what to do with one', () => {
    expect(JSON.stringify(lockedBody(SHELF()))).not.toContain('suggest')
  })

  describe('keep', () => {
    it('is one line, and the same for a keep in any group, whatever reason was written: it comes from the verdict alone', () => {
      const lines = (['helping', 'prescribed', 'undecided', 'conflicting'] as const).map((group) => suggestFor(product(group, { kind: 'keep' }, { reason: `A different reason for ${group}.` })))

      expect(lines[0]).toHaveLength(1)
      for (const each of lines) expect(each).toEqual(lines[0])
    })
  })

  describe('reduce', () => {
    const reduced = (maxFrequency: (typeof FREQUENCIES)[number]) => suggestFor(product('conflicting', { kind: 'reduce', maxFrequency }))

    it.each(FREQUENCIES)('words the frequency %s in plain words: one to three lines, none of them the raw code', (frequency) => {
      const lines = reduced(frequency)

      expect(lines.length).toBeGreaterThanOrEqual(1)
      expect(lines.length).toBeLessThanOrEqual(3)
      for (const line of lines) {
        expect(line.trim().length).toBeGreaterThan(0)
        expect(line.toLowerCase()).not.toContain(frequency)
      }
    })

    it('words every frequency differently, and none like a keep', () => {
      const wordings = FREQUENCIES.map((frequency) => reduced(frequency).join(' '))

      expect(new Set(wordings).size).toBe(FREQUENCIES.length)
      expect(wordings).not.toContain(suggestFor(product('helping', { kind: 'keep' })).join(' '))
    })

    it('says morning for am, evening for pm and a week for weekly', () => {
      expect(reduced('am').join(' ')).toMatch(/morning/i)
      expect(reduced('pm').join(' ')).toMatch(/evening|night/i)
      expect(reduced('weekly').join(' ')).toMatch(/week/i)
    })

    it('is the same for a reduce in any group: the frequency, not the group, decides', () => {
      expect(suggestFor(product('helping', { kind: 'reduce', maxFrequency: 'weekly' }))).toEqual(reduced('weekly'))
    })
  })

  describe('stop', () => {
    const stopped = (kind: TaperKind, over: Partial<SavedVerdictProduct> = {}) => suggestFor(product('likely-the-problem', { kind: 'stop', taperTemplateId: TAPER_CODE[kind] }, over))

    it.each(KINDS)('steps a %s product down by its schedule, and says never to stop suddenly', (kind) => {
      const text = stopped(kind).join(' ')

      expect(text).toMatch(/step(?:ping|ped)?[\s-]+(?:it\s+)?down|gradual|taper|schedule/i)
      expect(text).toMatch(/\b(?:never|don't|do not)\b[^.]*\b(?:suddenly|abruptly|all at once)\b/i)
    })

    it('names the kind of step-down: steroid for a steroid one, lightening for a lightening one, and the two differ', () => {
      expect(stopped('steroid').join(' ')).toMatch(/steroid/i)
      expect(stopped('lightening-agent').join(' ')).toMatch(/lighten/i)
      expect(stopped('steroid')).not.toEqual(stopped('lightening-agent'))
    })

    it('does not tell the person to stop at once: a step-down is never "stop now"', () => {
      for (const kind of KINDS) expect(stopped(kind).join(' ')).not.toMatch(/\bstop\b[^.]*\b(?:now|at once|straight away|immediately)\b/i)
    })
  })

  describe('drop', () => {
    it('says to stop using it now, in one line, when there is nothing more to say', () => {
      const lines = suggestFor(product('blocking', { kind: 'drop' }))

      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatch(/\bstop\b/i)
      expect(lines[0]).toMatch(/\b(?:now|at once|straight away|immediately)\b/i)
    })

    it('adds a line to see a professional when the product escalates, and keeps the stop-now line', () => {
      const plain = suggestFor(product('likely-the-problem', { kind: 'drop' }))
      const escalated = suggestFor(product('likely-the-problem', { kind: 'drop' }, { escalate: true }))

      expect(escalated.length).toBe(plain.length + 1)
      expect(escalated).toEqual(expect.arrayContaining(plain))
      expect(escalated.join(' ')).toMatch(/professional/i)
    })

    it('does not send a drop that does not escalate to a professional', () => {
      expect(suggestFor(product('redundant', { kind: 'drop' }, { sameJobAs: 'entry-x' })).join(' ')).not.toMatch(/professional/i)
    })
  })

  describe('the can\'t-tell group', () => {
    it('adds the line to photograph the back label to its stop-now line', () => {
      const plain = suggestFor(product('blocking', { kind: 'drop' }))
      const cantTell = suggestFor(product('cant-tell', { kind: 'drop' }, { nudge: 'photograph-back-label' }))

      expect(cantTell.length).toBe(plain.length + 1)
      expect(cantTell).toEqual(expect.arrayContaining(plain))
      expect(cantTell.join(' ')).toMatch(/photograph/i)
      expect(cantTell.join(' ')).toMatch(/back label/i)
    })

    it('is the only group that is asked to photograph a label', () => {
      for (const group of GROUP_ORDER.filter((each) => each !== 'cant-tell')) {
        expect(suggestFor(product(group, { kind: 'drop' })).join(' '), group).not.toMatch(/photograph/i)
      }
    })

    it('stays within three lines even when it also escalates', () => {
      const lines = suggestFor(product('cant-tell', { kind: 'drop' }, { escalate: true, nudge: 'photograph-back-label' }))

      expect(lines.length).toBe(3)
      expect(lines.join(' ')).toMatch(/professional/i)
      expect(lines.join(' ')).toMatch(/photograph/i)
    })
  })

  describe('the wording gate', () => {
    // Every line a product can be given: each verdict kind, every frequency, both step-down kinds, with and without escalation, in the can't-tell group and out of it.
    const everyLine = (): { where: string; line: string }[] => {
      const verdicts: ShelfVerdict[] = [
        { kind: 'keep' },
        ...FREQUENCIES.map((maxFrequency) => ({ kind: 'reduce', maxFrequency }) as const),
        ...TAPER_KINDS.map((kind) => ({ kind: 'stop', taperTemplateId: TAPER_CODE[kind] }) as const),
        { kind: 'drop' },
      ]
      const found: { where: string; line: string }[] = []
      for (const verdict of verdicts) {
        for (const escalate of [false, true]) {
          for (const group of ['helping', 'cant-tell'] as const) {
            const lines = suggestFor(product(group, verdict, { escalate, ...(group === 'cant-tell' ? { nudge: 'photograph-back-label' as const } : {}) }))
            for (const line of lines) found.push({ where: `${JSON.stringify(verdict)} escalate=${escalate} ${group}`, line })
          }
        }
      }
      return found
    }

    it('enumerates a line for every verdict kind, every frequency and both step-down kinds', () => {
      const lines = everyLine()

      expect(lines.length).toBeGreaterThanOrEqual(1 + FREQUENCIES.length + TAPER_KINDS.length + 1)
      expect(new Set(lines.map(({ line }) => line)).size).toBeGreaterThanOrEqual(1 + FREQUENCIES.length + TAPER_KINDS.length + 2)
    })

    it('passes FORBIDDEN_WORDING on every suggest line there can be', () => {
      for (const { where, line } of everyLine()) expectPassesTheGate(line, where)
    })
  })
})

// ---- #259 A3: `basis` on each product of the full verdict, and `professional` ----
// `basis` is saved with the product when the verdict is built and is passed on as it was saved, in the same order; `professional` is the approved about-a-product row
// (who to see, how soon, what to tell them), or null while the workbook has none. NEITHER is ever on the locked preview. How a basis is made is pinned in
// verdicts.basis.test.ts; the words of a basis are fixed copy or the workbook's, so they are checked there and not here.

const ONE_OF_EACH = [
  { kind: 'rule', source: 'ingredient-rule', statement: 'A strong steroid.', sourceUrl: 'https://example.org/rule', reviewerRole: 'a pharmacist', line: 'A strong steroid.' },
  { kind: 'rule', source: 'claim-word', statement: 'Its name says "x", a claim.', sourceUrl: null, reviewerRole: null, line: 'Its name says "x", a claim.' },
  { kind: 'told-us', about: 'reaction', line: 'You told us your skin reacted to this product.' },
  { kind: 'no-label', about: 'unknown-contents', line: 'We cannot see what is in it.' },
  { kind: 'fit', line: 'Matched against your goal by our checker.' },
] as const
const PROFESSIONAL = { whoToSee: 'A pharmacist or a doctor.', howSoon: 'Within a few days.', whatToTellThem: 'The product, how long you used it, and what changed.' }

describe('toShelfVerdictResponse: basis', () => {
  const basisOfBody = (item: ShownVerdictProduct): unknown => (fullBody([item]).products[0] as { basis?: unknown }).basis

  it('gives each product of the full verdict the basis it was saved with, every kind exactly as saved and in the order saved', () => {
    const item = product('likely-the-problem', { kind: 'drop' }, { basis: [...ONE_OF_EACH] as never })

    expect(basisOfBody(item)).toEqual(ONE_OF_EACH)
  })

  it('keeps a null source link and a null reviewer role as null, so the app shows no link and no "Reviewed by" line', () => {
    const item = product('likely-the-problem', { kind: 'drop' }, { basis: [ONE_OF_EACH[1]] as never })

    const [basis] = basisOfBody(item) as Record<string, unknown>[]
    expect(basis).toHaveProperty('sourceUrl', null)
    expect(basis).toHaveProperty('reviewerRole', null)
  })

  it('gives a product with no basis (the judge has not decided it) an empty list, present, and not a missing field', () => {
    const item = product('undecided', { kind: 'keep' }, { basis: [] })

    expect(basisOfBody(item)).toEqual([])
    expect(fullBody([item]).products[0]).toHaveProperty('basis')
  })

  it('gives each product its own basis, not the first one\'s', () => {
    const [a, b] = [product('helping', { kind: 'keep' }, { basis: [ONE_OF_EACH[4]] as never }), product('likely-the-problem', { kind: 'drop' }, { basis: [ONE_OF_EACH[0]] as never })]

    expect(fullBody([a, b]).products.map((p) => (p as { basis?: unknown }).basis)).toEqual([[ONE_OF_EACH[4]], [ONE_OF_EACH[0]]])
  })

  it('is not on the locked preview, which has no products, and none of the words of a basis is in it', () => {
    const body = lockedBody([product('likely-the-problem', { kind: 'drop' }, { basis: [...ONE_OF_EACH] as never })])

    expect(JSON.stringify(body)).not.toMatch(/basis|reviewerRole|A strong steroid|Matched against your goal|You told us/)
    expect(body).not.toHaveProperty('products')
  })
})

describe('toShelfVerdictResponse: professional', () => {
  it('is null on the full verdict when the workbook has no approved about-a-product row, present as null and not left out', () => {
    const body = fullBody(SHELF(), null)

    expect(body).toHaveProperty('professional', null)
  })

  it('is who to see, how soon and what to tell them when the row is there, and those three fields only', () => {
    const body = fullBody(SHELF(), { ...PROFESSIONAL })

    expect((body as { professional?: unknown }).professional).toEqual(PROFESSIONAL)
    expect(Object.keys((body as unknown as { professional: object }).professional).sort()).toEqual(['howSoon', 'whatToTellThem', 'whoToSee'])
  })

  it('is on a full verdict with no products too', () => {
    expect(fullBody([], { ...PROFESSIONAL })).toMatchObject({ professional: PROFESSIONAL, products: [] })
  })

  it('is not on the locked preview, and none of its words is in it', () => {
    const body = lockedBody(SHELF())

    expect(body).not.toHaveProperty('professional')
    expect(JSON.stringify(body)).not.toMatch(/whoToSee|howSoon|whatToTellThem/)
  })

  it('is not on a pending verdict', () => {
    expect(toShelfVerdictResponse({ status: 'pending' })).toEqual({ status: 'pending' })
  })
})
