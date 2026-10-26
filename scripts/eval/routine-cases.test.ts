import { describe, expect, it } from 'vitest'
import { BUDGET_BANDS, FREQUENCIES, ROUTINE_STEPS } from '../../src/modules/catalog/catalog.vocabulary'
import { concernsForGoal, SKIN_TYPE_LABELS } from '../../src/modules/face-scans/face-scans.tables'
import { GOALS } from '../../src/modules/goals/goals.vocabulary'
import { ingredientParts } from '../../src/modules/catalog/catalog.ingredients'
import { checkRoutine, FREQUENCY_RANK } from '../../src/modules/routines/routines.gates'
import type { Routine, RoutineEntry } from '../../src/modules/routines/routines.types'
import { SAFETY_CHOICES } from '../../src/modules/safety/safety.vocabulary'
import { ROUTINE_ALLOWED_FREQUENCIES } from '../../src/modules/routines/routines.rules'
import { buildSkeleton } from './routine-skeleton'
import { snapshotOf } from './routine.fixture'
import { ROUTINE_DEV, ROUTINE_HOLDOUT, type RoutineCase } from './routine-cases'

// ROUTINE_DEV and ROUTINE_HOLDOUT are the measurement sets for `npm run eval:routine`: 30 synthetic people each, written from the personas in CONTEXT.md.
// They are data, but data that must stay valid: a case that describes a person the face scan, the safety question or the shelf could never produce would
// make the eval's verdict the case's fault. The rules are written out here, not read from the cases, and each loops inside one test.

const ALL: RoutineCase[] = [...ROUTINE_DEV, ...ROUTINE_HOLDOUT]
const SETS = [
  ['ROUTINE_DEV', ROUTINE_DEV],
  ['ROUTINE_HOLDOUT', ROUTINE_HOLDOUT],
] as [string, RoutineCase[]][]

const BANDS = ['faint', 'a-little', 'some', 'clear']
// The concerns every goal also measures (face-scans.tables CORE_CONCERNS), which a person may be told about without having chosen them.
const CORE = ['hd_age_spot', 'hd_acne', 'hd_pore', 'hd_oiliness']
const PERSONAS = ['amara', 'tolu', 'ngozi', 'chidi']
const numbered = (prefix: string) => Array.from({ length: 30 }, (_, i) => `${prefix}-${String(i + 1).padStart(2, '0')}`)

const hasStop = (c: RoutineCase) => c.shelf.some((p) => p.verdict.kind === 'stop')
const picks = (cases: RoutineCase[], test: (c: RoutineCase) => boolean) => cases.filter(test)

describe('the routine eval case sets', () => {
  it('holds 30 dev and 30 holdout cases, numbered dev-01..dev-30 and hold-01..hold-30 in order', () => {
    expect(ROUTINE_DEV.map((c) => c.id)).toEqual(numbered('dev'))
    expect(ROUTINE_HOLDOUT.map((c) => c.id)).toEqual(numbered('hold'))
  })

  it('has ids that are unique across both sets', () => {
    const ids = ALL.map((c) => c.id)
    expect(new Set(ids).size).toBe(60)
  })

  it('has no person who is in both sets, or twice in one (the same case under another id)', () => {
    const withoutId = ALL.map(({ id: _id, ...rest }) => JSON.stringify(rest))
    expect(new Set(withoutId).size).toBe(60)
  })

  it('anchors each of Amara, Tolu, Ngozi and Chidi with at least 3 cases', () => {
    for (const persona of PERSONAS) expect(picks(ALL, (c) => c.persona === persona).length, persona).toBeGreaterThanOrEqual(3)
    for (const c of ALL) expect([...PERSONAS, null], c.id).toContain(c.persona)
  })

  it('covers all 6 goals and both countries over the 60', () => {
    expect([...new Set(ALL.map((c) => c.goal))].sort()).toEqual([...GOALS].sort())
    expect([...new Set(ALL.map((c) => c.country))].sort()).toEqual(['GB', 'NG'])
  })

  it('covers the skin types oily, dry, combination and normal, and unknown (null)', () => {
    const types = new Set(ALL.map((c) => c.skinType))
    for (const type of [...SKIN_TYPE_LABELS, null]) expect(types.has(type), String(type)).toBe(true)
  })

  it('covers every budget: none, low, mid and high', () => {
    const budgets = new Set(ALL.map((c) => c.budgetBand))
    for (const band of [null, ...BUDGET_BANDS]) expect(budgets.has(band), String(band)).toBe(true)
  })

  it('covers every safety and caution state over the 60: none, pregnant, breastfeeding, a fragrance reaction, a prescription, and tapering off a stopped product', () => {
    expect(picks(ALL, (c) => c.safety.choices.includes('none')).length, 'none').toBeGreaterThan(0)
    expect(picks(ALL, (c) => c.safety.choices.includes('pregnant')).length, 'pregnant').toBeGreaterThan(0)
    expect(picks(ALL, (c) => c.safety.choices.includes('breastfeeding')).length, 'breastfeeding').toBeGreaterThan(0)
    expect(picks(ALL, (c) => c.safety.choices.includes('reaction') && c.safety.reactionIngredients.includes('fragrance')).length, 'fragrance reaction').toBeGreaterThan(0)
    expect(picks(ALL, (c) => c.safety.choices.includes('prescription')).length, 'prescription').toBeGreaterThan(0)
    expect(picks(ALL, (c) => c.cautions.includes('tapering') && hasStop(c)).length, 'tapering').toBeGreaterThan(0)
  })

  it('covers every shelf size over the 60: empty, typical (2 to 4 products) and Tolu\'s overloaded shelf of 9', () => {
    expect(picks(ALL, (c) => c.shelf.length === 0).length, 'empty').toBeGreaterThan(0)
    expect(picks(ALL, (c) => c.shelf.length >= 2 && c.shelf.length <= 4).length, 'typical').toBeGreaterThan(0)
    expect(picks(ALL, (c) => c.shelf.length === 9 && c.persona === 'tolu').length, 'overloaded').toBeGreaterThan(0)
  })

  it.each(SETS)('%s covers every goal, both countries, all four personas and every safety state on its own, so it is a spread and not a slice', (_name, cases) => {
    expect([...new Set(cases.map((c) => c.goal))].sort()).toEqual([...GOALS].sort())
    expect([...new Set(cases.map((c) => c.country))].sort()).toEqual(['GB', 'NG'])
    for (const persona of PERSONAS) expect(picks(cases, (c) => c.persona === persona).length, persona).toBeGreaterThan(0)
    expect(picks(cases, (c) => c.safety.choices.includes('pregnant') || c.safety.choices.includes('breastfeeding')).length, 'pregnant or breastfeeding').toBeGreaterThan(0)
    expect(picks(cases, (c) => c.safety.choices.includes('reaction')).length, 'reaction').toBeGreaterThan(0)
    expect(picks(cases, (c) => c.safety.choices.includes('prescription')).length, 'prescription').toBeGreaterThan(0)
    expect(picks(cases, hasStop).length, 'a stopped product').toBeGreaterThan(0)
    expect(picks(cases, (c) => c.shelf.length === 0).length, 'empty shelf').toBeGreaterThan(0)
  })

  it.each(SETS)('%s is not a sorted list cut in two: its goal changes from one case to the next at least 10 times', (_name, cases) => {
    // A list sorted by goal changes goal only 5 times in 30 cases.
    const changes = cases.filter((c, i) => i > 0 && c.goal !== cases[i - 1]!.goal).length
    expect(changes).toBeGreaterThanOrEqual(10)
  })

  it('shows the face scan\'s four levels, faint, a-little, some and clear, somewhere in the 60', () => {
    const levels = new Set(ALL.flatMap((c) => c.seen.map((s) => s.level)))
    for (const level of BANDS) expect(levels.has(level as never), level).toBe(true)
  })

  it('has `seen` hold only the goal\'s own concerns, each once, at a level the scan can give, with at least one and at most three', () => {
    for (const c of ALL) {
      const own = concernsForGoal(c.goal)
      expect(c.seen.length, c.id).toBeGreaterThanOrEqual(1)
      expect(c.seen.length, c.id).toBeLessThanOrEqual(3)
      for (const { concern, level } of c.seen) {
        expect(own, `${c.id} ${concern}`).toContain(concern)
        expect(BANDS, `${c.id} ${concern} level`).toContain(level)
      }
      expect(new Set(c.seen.map((s) => s.concern)).size, `${c.id} repeats a concern`).toBe(c.seen.length)
    }
  })

  it('has `alsoNoticed` hold only visible core extras the goal does not already cover, each once', () => {
    for (const c of ALL) {
      const own = concernsForGoal(c.goal)
      for (const { concern, level } of c.alsoNoticed) {
        expect(CORE, `${c.id} ${concern} is not a core concern`).toContain(concern)
        expect(own, `${c.id} ${concern} is the goal's own`).not.toContain(concern)
        // Faint means hardly there: the scan does not call it noticed.
        expect(['a-little', 'some', 'clear'], `${c.id} ${concern} level`).toContain(level)
      }
      expect(new Set(c.alsoNoticed.map((s) => s.concern)).size, `${c.id} repeats a concern`).toBe(c.alsoNoticed.length)
    }
  })

  it('has safety answers the question can produce: known choices, "none" alone, and reaction ingredients only with the reaction choice', () => {
    for (const c of ALL) {
      for (const choice of c.safety.choices) expect(SAFETY_CHOICES, `${c.id} choice`).toContain(choice)
      expect(c.safety.choices.length, `${c.id} answers nothing`).toBeGreaterThan(0)
      if (c.safety.choices.includes('none')) expect(c.safety.choices, `${c.id} none must stand alone`).toEqual(['none'])
      if (c.safety.reactionIngredients.length > 0) expect(c.safety.choices, `${c.id} names a reaction`).toContain('reaction')
      for (const name of c.safety.reactionIngredients) expect(name.trim(), `${c.id} reaction ingredient`).not.toBe('')
    }
  })

  it('states its cautions from its safety answers and its shelf: pregnant, breastfeeding, prescription and recent-reaction from the choices, tapering from a stopped product', () => {
    for (const c of ALL) {
      expect(c.cautions.includes('pregnant'), `${c.id} pregnant`).toBe(c.safety.choices.includes('pregnant'))
      expect(c.cautions.includes('breastfeeding'), `${c.id} breastfeeding`).toBe(c.safety.choices.includes('breastfeeding'))
      expect(c.cautions.includes('prescription'), `${c.id} prescription`).toBe(c.safety.choices.includes('prescription'))
      expect(c.cautions.includes('recent-reaction'), `${c.id} recent-reaction`).toBe(c.safety.choices.includes('reaction'))
      expect(c.cautions.includes('tapering'), `${c.id} tapering`).toBe(hasStop(c))
      expect(new Set(c.cautions).size, `${c.id} repeats a caution`).toBe(c.cautions.length)
    }
  })

  it('has well-formed shelf products: a unique id, a name, a step of the routine or none, and a verdict whose extra field is there (stop has a taper template id, reduce a frequency)', () => {
    for (const c of ALL) {
      expect(new Set(c.shelf.map((p) => p.id)).size, `${c.id} shelf ids`).toBe(c.shelf.length)
      for (const p of c.shelf) {
        const at = `${c.id} ${p.id}`
        expect(p.id.trim(), `${at} id`).not.toBe('')
        expect(p.name.trim(), `${at} name`).not.toBe('')
        if (p.brand !== null) expect(p.brand.trim(), `${at} brand`).not.toBe('')
        for (const ingredient of p.ingredients) expect(ingredient.trim(), `${at} ingredient`).not.toBe('')
        if (p.step !== null) expect(ROUTINE_STEPS, `${at} step`).toContain(p.step)
        for (const url of p.sourceUrls) expect(url, `${at} source`).toMatch(/^https:\/\//)
        expect(['keep', 'reduce', 'stop', 'drop'], `${at} verdict`).toContain(p.verdict.kind)
        if (p.verdict.kind === 'stop') expect(p.verdict.taperTemplateId.trim(), `${at} taper template`).not.toBe('')
        if (p.verdict.kind === 'reduce') expect(FREQUENCIES, `${at} reduce cap`).toContain(p.verdict.maxFrequency)
      }
    }
  })

  it('gives every case a country of NG or GB, a goal of the vocabulary and a known skin type or null', () => {
    for (const c of ALL) {
      expect(['NG', 'GB'], c.id).toContain(c.country)
      expect(GOALS, c.id).toContain(c.goal)
      if (c.skinType !== null) expect(SKIN_TYPE_LABELS, c.id).toContain(c.skinType)
      if (c.budgetBand !== null) expect(BUDGET_BANDS, c.id).toContain(c.budgetBand)
    }
  })

  it('carries no maxNewProducts: the skeleton derives it from the gaps that have candidates', () => {
    for (const c of ALL) expect(c, c.id).not.toHaveProperty('maxNewProducts')
  })

  it('has `seen` hold all three of the goal\'s concerns, in goal order: a real scan shows every concern it measured, faint included', () => {
    for (const c of ALL) expect(c.seen.map((s) => s.concern), c.id).toEqual(concernsForGoal(c.goal))
  })

  it('has prescription ingredients only with the prescription choice, each named, and some case that names one', () => {
    for (const c of ALL) {
      if (c.safety.prescriptionIngredients.length > 0) expect(c.safety.choices, `${c.id} names a prescription`).toContain('prescription')
      for (const name of c.safety.prescriptionIngredients) expect(name.trim(), `${c.id} prescription ingredient`).not.toBe('')
    }
    expect(picks(ALL, (c) => c.safety.prescriptionIngredients.length > 0).length).toBeGreaterThan(0)
  })

  it('names what each prescription case uses', () => {
    for (const c of ALL.filter((c) => c.safety.choices.includes('prescription'))) expect(c.safety.prescriptionIngredients.length, c.id).toBeGreaterThan(0)
  })

  // Labels the live rules give the same ingredient, for the names the cases use. A name the table lacks is matched as written.
  const SAME: Record<string, string[]> = { fragrance: ['parfum'], tretinoin: ['retinoic acid'], clobetasol: ['clobetasol propionate'], 'clobetasol propionate': ['clobetasol'] }
  const wholeWords = (text: string) => ` ${text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join(' ')} `
  /** An ingredient on a label holds a named one when the named one's words are whole words of it, case ignored, through the labels above. */
  const lists = (ingredient: string, named: string) => [named, ...(SAME[named.toLowerCase()] ?? [])].some((label) => ingredientParts(ingredient).concat(ingredient).some((part) => wholeWords(part).includes(wholeWords(label))))

  /** The shelf product that IS a prescription is named so ("Prescribed tretinoin 0.025% cream"). */
  const isPrescribed = (p: RoutineCase['shelf'][number]) => /^Prescribed /.test(p.name)

  it('keeps or reduces no shelf product that lists an ingredient the case reacted to, and none but the prescribed product lists one it is prescribed: the rest are stopped (with a taper) or dropped', () => {
    for (const c of ALL) {
      for (const p of c.shelf.filter((p) => p.verdict.kind === 'keep' || p.verdict.kind === 'reduce')) {
        for (const name of c.safety.reactionIngredients) expect(p.ingredients.some((ingredient) => lists(ingredient, name)), `${c.id} ${p.id} lists reaction ${name}`).toBe(false)
        if (!isPrescribed(p)) for (const name of c.safety.prescriptionIngredients) expect(p.ingredients.some((ingredient) => lists(ingredient, name)), `${c.id} ${p.id} lists prescription ${name}`).toBe(false)
      }
    }
  })

  it('never drops or stops a product the case names as its prescription: the app never says to stop a prescription', () => {
    for (const c of ALL) {
      for (const p of c.shelf.filter((p) => p.ingredients.some((ingredient) => c.safety.prescriptionIngredients.some((name) => lists(ingredient, name))))) expect(p.verdict.kind, `${c.id} ${p.id}`).toBe('keep')
    }
    // The prescribed products are there, in the prescription cases only, and each lists what its case is prescribed.
    const prescribed = ALL.filter((c) => c.shelf.some(isPrescribed))
    expect(prescribed.length).toBeGreaterThan(0)
    for (const c of prescribed) {
      expect(c.safety.choices, c.id).toContain('prescription')
      for (const p of c.shelf.filter(isPrescribed)) {
        expect(p.verdict.kind, `${c.id} ${p.id}`).toBe('keep')
        expect(c.safety.prescriptionIngredients.some((name) => p.ingredients.some((ingredient) => lists(ingredient, name))), `${c.id} ${p.id} is what the case is prescribed`).toBe(true)
      }
    }
  })

  it('matches the check above the way it should: whole words, case ignored, through the rules\' labels', () => {
    expect(lists('Parfum', 'fragrance')).toBe(true)
    expect(lists('Alcohol Denat', 'alcohol')).toBe(true)
    expect(lists('Cetyl Alcohol', 'alcohol')).toBe(true)
    expect(lists('Glycolic Acid', 'GLYCOLIC ACID')).toBe(true)
    expect(lists('Aqua', 'fragrance')).toBe(false)
    expect(lists('Retinol', 'tretinoin')).toBe(false)
  })

  it.each(SETS)('%s uses the drop verdict somewhere, and the stop verdict', (_name, cases) => {
    const kinds = new Set(cases.flatMap((c) => c.shelf.map((p) => p.verdict.kind)))
    expect(kinds.has('drop')).toBe(true)
    expect(kinds.has('stop')).toBe(true)
  })

  it('gives every kept or reduced product a step it can be used at: the step allows a frequency no more often than its cap', () => {
    for (const c of ALL) {
      for (const p of c.shelf.filter((p) => (p.verdict.kind === 'keep' || p.verdict.kind === 'reduce') && p.step !== null)) {
        const cap = p.verdict.kind === 'reduce' ? FREQUENCY_RANK[p.verdict.maxFrequency] : Infinity
        expect(ROUTINE_ALLOWED_FREQUENCIES[p.step!].some((f) => FREQUENCY_RANK[f] <= cap), `${c.id} ${p.id}`).toBe(true)
      }
    }
  })

  it('can be written without breaking a gate: over an empty catalog, a routine that uses every kept product, tapers every stopped one and leaves out the rest passes checkRoutine for all 60', async () => {
    for (const c of ALL) {
      const { skeleton } = await buildSkeleton(c, snapshotOf([]), { hintsShown: false })
      const entries: RoutineEntry[] = skeleton.steps.flatMap((step): RoutineEntry[] => {
        const allowed = ROUTINE_ALLOWED_FREQUENCIES[step]
        const used = c.shelf.filter((p) => p.step === step && (p.verdict.kind === 'keep' || p.verdict.kind === 'reduce'))
        if (used.length === 0) return [{ step, product: { kind: 'none' as const }, frequency: allowed[0]!, reason: 'Use what you have for now.', grounding: [] }]
        return used.map((p): RoutineEntry => {
          const cap = p.verdict.kind === 'reduce' ? FREQUENCY_RANK[p.verdict.maxFrequency] : Infinity
          return { step, product: { kind: 'shelf' as const, id: p.id }, frequency: allowed.find((f) => FREQUENCY_RANK[f] <= cap)!, reason: 'You already use this and it suits your goal.', grounding: [] }
        })
      })
      const routine: Routine = {
        steps: entries,
        tapers: c.shelf.flatMap((p) => (p.verdict.kind === 'stop' ? [{ shelfProductId: p.id, templateId: p.verdict.taperTemplateId }] : [])),
        expectation: 'Give it 8 to 12 weeks.',
      }
      expect(checkRoutine(skeleton, routine), c.id).toEqual([])
    }
  })
})
