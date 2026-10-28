import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SHOWN_CONCERNS, SKIN_TYPE_LABELS } from '../src/modules/face-scans/face-scans.tables'
import { CONTRACT_VERSION, contractFingerprint } from '../src/modules/catalog/catalog.workbook.schema'
import { BUDGET_BANDS, FREQUENCIES, ORIGINS, ROUTINE_STEPS } from '../src/modules/catalog/catalog.vocabulary'
import { renderContractDoc } from './catalog-contract-doc'

// docs/catalog-workbook-contract.md is what the people who fill the workbook read: it is written by `npm run catalog:contract-doc` from the
// contract itself and never by hand, so a contract change that forgets to regenerate it fails here, the way a stale docs/openapi.json fails CI.
const DOC_PATH = 'docs/catalog-workbook-contract.md'

describe('docs/catalog-workbook-contract.md', () => {
  it('is exactly what the generator writes from the contract today, so a stale document fails (run `npm run catalog:contract-doc`)', async () => {
    expect(readFileSync(DOC_PATH, 'utf8')).toBe(await renderContractDoc())
  })

  it('is written the same way every time', async () => {
    expect(await renderContractDoc()).toBe(await renderContractDoc())
  })

  it('says which contract version and fingerprint it describes', async () => {
    const doc = await renderContractDoc()

    expect(doc).toContain(CONTRACT_VERSION)
    expect(doc).toContain(await contractFingerprint())
  })

  it('names the eleven tabs and every column the contract checks', async () => {
    const doc = await renderContractDoc()

    for (const tab of ['Products', 'Availability', 'Ingredients', 'Countries', 'Claim words', 'Tapers', 'Guides', 'Reintroductions', 'Escalations', 'Responses', 'Weeks']) expect(doc, tab).toContain(tab)
    for (const column of [
      'code', 'brand', 'variant', 'ingredients_source_url', 'key_ingredient', 'strength', 'skin_concerns', 'skin_types', 'steps', 'frequency', 'own_cautions', 'evidence_urls', 'origin',
      'approved_by', 'approved_on', 'audited_by', 'audited_on', 'draft_cells', 'product_code', 'price_min', 'price_max', 'where_sold', 'aliases',
      'strength_limit', 'statement', 'source_url', 'helps', 'currency', 'low_max', 'mid_max',
      'group', 'clashes_with', 'phrase', 'claim', 'kind', 'schedule', 'what_to_expect', 'see_a_professional_if',
      'goal', 'what_it_does', 'look_for', 'for_deeper_skin', 'look_for_when_pregnant',
      'reason', 'who_to_see', 'how_soon', 'what_to_tell_them', 'outcome', 'body', 'what_to_do_now', 'band', 'step_down', 'title', 'text',
    ]) {
      expect(doc, column).toContain(column)
    }
  })

  it('lists every value a vocabulary column accepts, so nobody has to read the code to learn them', async () => {
    const doc = await renderContractDoc()

    for (const value of [...SHOWN_CONCERNS, ...SKIN_TYPE_LABELS, 'all', ...ROUTINE_STEPS, ...FREQUENCIES, ...BUDGET_BANDS, ...ORIGINS]) expect(doc, value).toContain(value)
  })

  it('lists every ingredient group and taper kind, and the claim, so nobody has to read the code to learn them', async () => {
    const doc = await renderContractDoc()

    for (const value of ['mercury', 'steroid', 'lightening-agent', 'retinoid', 'exfoliating-acid', 'benzoyl-peroxide', 'lightening']) expect(doc, value).toContain(value)
  })

  it('lists the goals a guide may be written for, and tells the people who write guides what the pregnancy column asks of them', async () => {
    const doc = await renderContractDoc()

    for (const goal of ['clear-skin', 'even-tone', 'fade-dark-marks', 'brighter', 'glow', 'calm-repair']) expect(doc, goal).toContain(goal)
    const guides = doc.slice(doc.indexOf('Guides'))
    expect(guides).toMatch(/pregnan/i)
  })

  it('lists the reasons, outcomes, week bands and ladder steps the new tabs accept, so nobody has to read the code to learn them', async () => {
    const doc = await renderContractDoc()

    for (const value of [
      'pus-or-hot-patch', 'swelling', 'near-eyes', 'worse-after-pause', 'unchanged-after-checks', 'harm-while-two-paused', 'hard-to-ignore-during-step-down',
      'paused', 'advice-tightness', 'advice-itching', 'advice-breakouts', 'expected-flare', 'check-calmer', 'check-same', 'check-worse', 'nothing-to-pause',
      '3-4', '5-8', '9-12',
    ]) {
      expect(doc, value).toContain(value)
    }
  })

  it('tells the people who write responses about {step}, the one placeholder, and shows a ladder that climbs and ends with back', async () => {
    const doc = await renderContractDoc()

    expect(doc).toContain('{step}')
    expect(doc).toContain('1: weekly; 2: alternate-days; 3: back')
  })

  it.each([
    ['Escalations', 'ESCALATION_WORDING'],
    ['Responses', 'RESPONSE_WORDING'],
    ['Weeks', 'WEEK_WORDING'],
  ])('names the wording rule of the %s tab on its own text columns, and not the Guides rule', async (tab, rule) => {
    const doc = await renderContractDoc()
    // A tab's section runs to the next "### " heading, so the tab's own text may mention another tab by name.
    const start = doc.indexOf(`### ${tab}\n`)
    const section = doc.slice(start, doc.indexOf('\n### ', start + 1))

    expect(start).toBeGreaterThan(-1)
    expect(section).toContain(`\`${rule}\``)
    expect(section).not.toContain('GUIDE_WORDING')
  })

  it('tells the people who write responses how {step} is shown, and that every other brace is refused', async () => {
    const doc = await renderContractDoc()
    const start = doc.indexOf('### Responses\n')
    const section = doc.slice(start, doc.indexOf('\n### ', start + 1))

    for (const noun of ['Cleanser', 'Treatment', 'Moisturiser', 'Sunscreen', 'your routine']) expect(section, noun).toContain(noun)
    expect(section).toContain('never a product title')
    expect(section).toContain('{step}}')
  })

  it('tells the people who fill in the Weeks tab to keep the band column text, and the Reintroductions tab that a step comes before back', async () => {
    const doc = await renderContractDoc()
    const section = (tab: string) => doc.slice(doc.indexOf(`### ${tab}\n`), doc.indexOf('\n### ', doc.indexOf(`### ${tab}\n`) + 1))

    expect(section('Weeks')).toMatch(/formatted as text/)
    expect(section('Reintroductions')).toContain('REINTRO_BACK_ONLY')
  })

  it('explains the schedule format with an example that is valid, so a person can copy its shape', async () => {
    expect(await renderContractDoc()).toContain('1-2: alternate-days; 3-4: weekly; 5: stop')
  })

  it('lists every rule code a problem can carry', async () => {
    const doc = await renderContractDoc()

    for (const rule of [
      'UNKNOWN_COLUMN', 'MISSING_COLUMN', 'REQUIRED', 'REQUIRED_WHEN_APPROVED', 'NOT_IN_VOCABULARY', 'BAD_CODE', 'BAD_CURRENCY', 'BAD_DATE', 'NOT_HTTPS_URL',
      'NOT_A_WHOLE_NUMBER', 'TOO_LONG', 'ITEM_TOO_LONG', 'TOO_MANY_ITEMS', 'HAS_LINK_OR_MARKUP', 'NOT_NORMALISED', 'ALL_MIXED_WITH_OTHERS', 'AUDIT_INCOMPLETE',
      'APPROVED_WITH_DRAFT_CELLS', 'INVALID_DRAFT_CELL', 'DRAFT_CELL_COLUMN', 'PRICE_RANGE', 'LOW_NOT_BELOW_MID', 'UNKNOWN_PRODUCT', 'UNKNOWN_COUNTRY',
      'DUPLICATE_CODE', 'DUPLICATE_IDENTITY', 'DUPLICATE_AVAILABILITY', 'DUPLICATE_RULE',
      'CLASH_NOT_SYMMETRIC', 'CLASH_WITHOUT_GROUP', 'SELF_CLASH', 'STRENGTH_WITHOUT_INGREDIENT', 'DUPLICATE_PHRASE', 'NOT_LOWER_CASE', 'NOT_A_LIGHTENING_CLAIM',
      'BAD_SCHEDULE', 'SCHEDULE_NOT_CONTIGUOUS', 'SCHEDULE_MISSING_STOP', 'SCHEDULE_STOP_NOT_LAST', 'SCHEDULE_FREQUENCY_INCREASES',
      'UNQUALIFIED_APPROVER', 'GUIDE_BASE_MISSING', 'GUIDE_DUPLICATE', 'GUIDE_WORDING',
      'REINTRO_DEFAULT_MISSING', 'REINTRO_DUPLICATE', 'REINTRO_GROUP_NEVER_BACK', 'REINTRO_MISSING_BACK', 'REINTRO_BACK_NOT_LAST', 'REINTRO_FREQUENCY_DECREASES',
      'ESCALATION_MISSING', 'ESCALATION_DUPLICATE', 'ESCALATION_WORDING', 'RESPONSE_MISSING', 'RESPONSE_DUPLICATE', 'RESPONSE_PLACEHOLDER', 'RESPONSE_WORDING',
      'WEEK_BASE_MISSING', 'WEEK_DUPLICATE', 'WEEK_WORDING',
    ]) {
      expect(doc, rule).toContain(rule)
    }
  })

  it('is regenerated by npm run catalog:contract-doc', () => {
    const scripts = (JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> }).scripts

    expect(scripts['catalog:contract-doc']).toContain('scripts/catalog-contract-doc.ts')
  })
})
