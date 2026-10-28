import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { REFERENCE, REFERENCE_VERSION } from '../../src/modules/catalog/catalog.reference'
import { validateWorkbook } from '../../src/modules/catalog/catalog.workbook.schema'

// The migration that adds `ingredient_rules` and `catalog_versions` also seeds them from REFERENCE, so the day it ships nothing changes:
// the same rules apply, and no formulation analysed at `seed-2026-10` is analysed again. This file reads the tables a freshly migrated
// database holds (setup.ts applies every migration) and never writes to them.

/** The one day the guides and the other reviewed rows this file stands in for were approved on. */
const BASE = new Date('2030-06-15T00:00:00.000Z')

type RuleRow = {
  code: string
  name: string
  aliases: string
  kind: string
  strength_limit: string | null
  statement: string
  source_url: string | null
  helps: string
  status: string
  approved_by: string | null
  approved_on: string | null
  audited_by: string | null
  audited_on: string | null
  updated_in_version: number
}

const rules = async (): Promise<RuleRow[]> => (await env.DB.prepare('SELECT * FROM ingredient_rules').all<RuleRow>()).results

// The code rule from spec #115: ING-<NAME SLUG>-<KIND SLUG>, upper case, a run of anything but a letter or digit as one hyphen, at most 40 characters.
const slug = (text: string) => text.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '')
const CODE_LIMIT = 40

describe('the seeded ingredient rules', () => {
  it('holds exactly one approved rule for each REFERENCE entry, with its name, aliases, kind, statement and source', async () => {
    const rows = await rules()

    expect(rows).toHaveLength(REFERENCE.length)
    for (const entry of REFERENCE) {
      const found = rows.filter((r) => r.name === entry.name && r.kind === entry.kind)
      expect(found, `${entry.name} / ${entry.kind}`).toHaveLength(1)
      expect(
        { aliases: JSON.parse(found[0]!.aliases), statement: found[0]!.statement, source_url: found[0]!.source_url },
        `${entry.name} / ${entry.kind}`,
      ).toEqual({ aliases: entry.aliases, statement: entry.rule, source_url: entry.source })
    }
  })

  it('has no rule that is not in REFERENCE', async () => {
    const wanted = new Set(REFERENCE.map((e) => `${e.name}|${e.kind}`))

    for (const row of await rules()) expect(wanted.has(`${row.name}|${row.kind}`), `${row.name} / ${row.kind}`).toBe(true)
  })

  // The seed has no author to name, so it says so. 2026-10-21 is the day the seed shipped, a fact about the seed and not a date to keep fresh.
  it('approves every rule as the reference seed, on the day it shipped, with no audit, no strength limit and no skin concern it helps', async () => {
    for (const row of await rules()) {
      expect(row, row.code).toMatchObject({
        status: 'approved',
        approved_by: 'reference seed',
        approved_on: '2026-10-21',
        audited_by: null,
        audited_on: null,
        strength_limit: null,
        updated_in_version: 1,
      })
      expect(JSON.parse(row.helps), row.code).toEqual([])
    }
  })

  it('gives every rule a unique code of at most 40 characters, made of capital letters, digits and hyphens, starting ING-', async () => {
    const codes = (await rules()).map((r) => r.code)

    expect(new Set(codes).size).toBe(codes.length)
    for (const code of codes) {
      expect(code.length, code).toBeLessThanOrEqual(CODE_LIMIT)
      expect(code, code).toMatch(/^ING-[A-Z0-9][A-Z0-9-]*$/)
    }
  })

  it('names a rule ING-<name>-<kind> in capitals, exactly, when that fits in 40 characters', async () => {
    const rows = await rules()

    const known = rows.find((r) => r.name === 'mercury' && r.kind === 'banned-substance')
    expect(known?.code).toBe('ING-MERCURY-BANNED-SUBSTANCE')
    expect(rows.find((r) => r.name === 'retinol' && r.kind === 'sun-sensitivity')?.code).toBe('ING-RETINOL-SUN-SENSITIVITY')
    for (const row of rows) {
      const whole = `ING-${slug(row.name)}-${slug(row.kind)}`
      if (whole.length <= CODE_LIMIT) expect(row.code, `${row.name} / ${row.kind}`).toBe(whole)
    }
  })

  it('shortens a name too long for its code from the end, so the code still starts with the name', async () => {
    const long = (await rules()).find((r) => r.name === 'hydroxyisohexyl 3-cyclohexene carboxaldehyde')

    expect(long?.code.length).toBeLessThanOrEqual(CODE_LIMIT)
    expect(long?.code.startsWith('ING-HYDROXYISOHEXYL-3-CYCLOHEXENE-')).toBe(true)
  })

  // The seed is the first real use of the contract: if the Ingredients tab would refuse it, the seed would never survive a round trip
  // through a workbook (export, edit, upload).
  it('would pass the workbook contract as an Ingredients tab, so an export of the seed uploads back with no problem', async () => {
    const ingredients = (await rules()).map((r) => ({
      code: r.code,
      name: r.name,
      aliases: (JSON.parse(r.aliases) as string[]).join(';'),
      kind: r.kind,
      strength_limit: r.strength_limit,
      statement: r.statement,
      source_url: r.source_url,
      helps: (JSON.parse(r.helps) as string[]).join(';'),
      status: r.status,
      approved_by: r.approved_by,
      approved_on: r.approved_on,
      audited_by: r.audited_by,
      audited_on: r.audited_on,
    }))

    const tab = (headers: string[], rows: Record<string, string | null>[] = []) => ({ headers, rows })
    const headers = ['code', 'name', 'aliases', 'kind', 'strength_limit', 'statement', 'source_url', 'helps', 'group', 'clashes_with', 'status', 'approved_by', 'approved_on', 'audited_by', 'audited_on']

    expect(
      validateWorkbook({
        products: tab(['code', 'brand', 'name', 'variant', 'form', 'category', 'ingredients', 'ingredients_source_url', 'key_ingredient', 'strength', 'skin_concerns', 'skin_types', 'steps', 'frequency', 'own_cautions', 'evidence_urls', 'origin', 'status', 'approved_by', 'approved_on', 'audited_by', 'audited_on', 'draft_cells']),
        availability: tab(['product_code', 'country', 'price_min', 'price_max', 'where_sold', 'source_url']),
        ingredients: tab(headers, ingredients),
        countries: tab(['code', 'currency', 'low_max', 'mid_max', 'status']),
        claimWords: tab(['code', 'phrase', 'claim', 'status', 'approved_by', 'approved_on', 'audited_by', 'audited_on']),
        tapers: tab(['code', 'kind', 'schedule', 'what_to_expect', 'see_a_professional_if', 'status', 'approved_by', 'approved_on', 'audited_by', 'audited_on']),
        // The contract needs a base guide for each step, which the seed does not have: the team writes them, so this stands in for those four rows.
        guides: tab(
          ['step', 'goal', 'what_it_does', 'look_for', 'for_deeper_skin', 'look_for_when_pregnant', 'status', 'approved_by', 'approved_on', 'audited_by', 'audited_on'],
          ['cleanse', 'treat', 'moisturise', 'protect'].map((step) => ({
            step,
            goal: null,
            what_it_does: 'What the step does.',
            look_for: 'What to look for.',
            for_deeper_skin: 'What suits deeper skin.',
            look_for_when_pregnant: null,
            status: 'approved',
            approved_by: 'Dr A. Reviewer',
            approved_on: BASE.toISOString().slice(0, 10),
            audited_by: null,
            audited_on: null,
          })),
        ),
        // The same for the four reviewed tabs of contract 2.3.0: the default ladder, a row for each reason and each outcome, and a base card for each band.
        reintroductions: tab(
          ['group', 'schedule', 'status', 'approved_by', 'approved_on', 'audited_by', 'audited_on'],
          [{ group: null, schedule: '1: weekly; 2: back', status: 'approved', approved_by: 'Dr A. Reviewer', approved_on: BASE.toISOString().slice(0, 10), audited_by: null, audited_on: null }],
        ),
        escalations: tab(
          ['reason', 'who_to_see', 'how_soon', 'what_to_tell_them', 'status', 'approved_by', 'approved_on', 'audited_by', 'audited_on'],
          ['pus-or-hot-patch', 'swelling', 'near-eyes', 'worse-after-pause', 'unchanged-after-checks', 'harm-while-two-paused', 'hard-to-ignore-during-step-down'].map((reason) => ({
            reason,
            who_to_see: 'A doctor.',
            how_soon: 'Today.',
            what_to_tell_them: 'What you noticed.',
            status: 'approved',
            approved_by: 'Dr A. Reviewer',
            approved_on: BASE.toISOString().slice(0, 10),
            audited_by: null,
            audited_on: null,
          })),
        ),
        responses: tab(
          ['outcome', 'title', 'body', 'what_to_do_now', 'status', 'approved_by', 'approved_on', 'audited_by', 'audited_on'],
          ['paused', 'advice-tightness', 'advice-itching', 'advice-breakouts', 'expected-flare', 'check-calmer', 'check-same', 'check-worse', 'nothing-to-pause'].map((outcome) => ({
            outcome,
            title: 'A title',
            body: 'A body for your {step}.',
            what_to_do_now: null,
            status: 'approved',
            approved_by: 'Dr A. Reviewer',
            approved_on: BASE.toISOString().slice(0, 10),
            audited_by: null,
            audited_on: null,
          })),
        ),
        weeks: tab(
          ['band', 'goal', 'step_down', 'title', 'text', 'status', 'approved_by', 'approved_on', 'audited_by', 'audited_on'],
          ['1', '2', '3-4', '5-8', '9-12'].map((band) => ({
            band,
            goal: null,
            step_down: 'no',
            title: 'A title',
            text: 'A text.',
            status: 'approved',
            approved_by: 'Dr A. Reviewer',
            approved_on: BASE.toISOString().slice(0, 10),
            audited_by: null,
            audited_on: null,
          })),
        ),
      }),
    ).toMatchObject({ ok: true })
  })
})

describe('the seeded catalog version', () => {
  type VersionRow = { version: number; rules_version: string; contract_version: string; uploaded_by: string; archive_key: string | null; created_at: number }
  const versions = async () => (await env.DB.prepare('SELECT * FROM catalog_versions ORDER BY version').all<VersionRow>()).results

  it('is catalog version 1, carrying the rules version the analyses already stored were made at', async () => {
    const [first, ...others] = await versions()

    expect(others).toEqual([])
    expect(first).toMatchObject({ version: 1, rules_version: 'seed-2026-10', uploaded_by: 'reference seed', archive_key: null })
    // The literal and the constant are both written so neither can drift from what analysed formulations hold in reference_version.
    expect(REFERENCE_VERSION).toBe('seed-2026-10')
  })

  // The seed is frozen SQL: it says the contract it was written under, and a later contract version never rewrites a migration.
  it('records contract version 1.0.0, the literal, and a creation time', async () => {
    const [first] = await versions()

    expect(first?.contract_version).toBe('1.0.0')
    expect(first?.created_at).toEqual(expect.any(Number))
  })
})
