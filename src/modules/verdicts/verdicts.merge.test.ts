import { describe, expect, it } from 'vitest'
import type { Category } from '../catalog/catalog.vocabulary'
import type { FitProductResult, FitResult } from '../../providers/verdict-fitting/verdict-fitter.provider'
import type { NoLabelPurpose } from '../scans/scans.vocabulary'
import type { SafetyChoice } from '../safety/safety.vocabulary'
import { floorVerdicts, type FloorEntry, type FloorInput, type FloorMention, type FloorResult, type FloorRule, type FloorShelfEntry } from './verdicts.floor'
import { mergeVerdict, type VerdictProduct } from './verdicts.merge'

// The merge of the shelf verdict (spec #171, "Decisions for the endpoint"): the rules floor's answer and the fit judge's answer, or no fit answer, become the one
// verdict the endpoint saves. A PURE function. The floor's labels are kept as they are with deterministic copy (never the model's words); the model's labels
// apply only to products the floor left open; a clash is applied only when both its products survive; and no step ever moves a product to a less strict group.
//
// Shapes assumed (the contract this file pins):
//   mergeVerdict({ floor, fit, entries, choices? }) => { fit: 'ready' | 'not-ready', products: VerdictProduct[] }
//   `entries` is the shelf in its order (anything with an `id` and a `category`, so the FloorShelfEntry list the floor was given is passed as it is). The output
//   is the skin products of it, in that order. `choices` is the profile's safety choices (default none), which the stop copy reads (prescription note).
//   VerdictProduct = { entryId, group, verdict, escalate, reason, facts, sameJobAs?, nudge? }; `facts` is the floor's facts for a fixed product and [] for any other.
// Expected values are literals worked out from the spec; the floor is the real one, so every state here is one the product can reach.

const RULES: FloorRule[] = [
  rule({ name: 'mercury', aliases: ['mercuric chloride'], kind: 'banned-substance', group: 'mercury' }),
  rule({ name: 'clobetasol propionate', aliases: ['clobetasol'], kind: 'banned-substance', group: 'steroid' }),
  rule({ name: 'hydroquinone', aliases: ['quinol'], kind: 'restricted-substance', group: 'lightening-agent' }),
  rule({ name: 'retinol', kind: 'pregnancy-caution', group: 'retinoid', clashesWith: ['exfoliating-acid', 'benzoyl-peroxide'] }),
  rule({ name: 'glycolic acid', kind: 'irritation', group: 'exfoliating-acid', clashesWith: ['retinoid', 'benzoyl-peroxide'] }),
  rule({ name: 'lactic acid', kind: 'irritation', group: 'exfoliating-acid', clashesWith: ['retinoid', 'benzoyl-peroxide'] }),
  rule({ name: 'benzoyl peroxide', kind: 'irritation', group: 'benzoyl-peroxide', clashesWith: ['retinoid', 'exfoliating-acid'] }),
  rule({ name: 'parfum', aliases: ['fragrance'], kind: 'allergen' }),
  rule({ name: 'zzyzx musk', kind: 'banned-substance' }),
]
const CLAIMS = ['lightening', 'whitening', 'bleaching']
const TAPERS = { steroid: 'TPR-STEROID-1', 'lightening-agent': 'TPR-LIGHTENING-1' } as const

function rule(over: Partial<FloorRule> & Pick<FloorRule, 'name' | 'kind'>): FloorRule {
  return { aliases: [], rule: `${over.name} (test rule)`, source: null, group: null, clashesWith: [], ...over }
}

const product = (id: string, ingredients: string[], over: Partial<Extract<FloorShelfEntry, { kind: 'product' }>> = {}): FloorShelfEntry => ({
  id,
  kind: 'product',
  brand: 'Orbis',
  name: `Product ${id}`,
  variant: null,
  category: 'skin',
  productId: `prod-${id}`,
  ingredients,
  ...over,
})
const noLabel = (id: string, noLabelPurpose: NoLabelPurpose, category: Category = 'skin'): FloorShelfEntry => ({
  id,
  kind: 'no-label',
  brand: null,
  name: `Tub ${id}`,
  variant: null,
  category,
  noLabelPurpose,
})
const mention = (over: Partial<FloorMention> & Pick<FloorMention, 'source' | 'kind'>): FloorMention => ({ name: 'anything', productId: null, ingredients: null, ...over })
const prescribed = (productId: string): FloorMention => mention({ source: 'prescription', kind: 'product', productId })
const reactedTo = (productId: string): FloorMention => mention({ source: 'reaction', kind: 'product', productId })
const reactedToIngredient = (name: string): FloorMention => mention({ source: 'reaction', kind: 'ingredient', name })

type FloorOver = { pregnant?: boolean; mentions?: FloorMention[]; tapers?: FloorInput['tapers'] }
const floorOf = (shelf: FloorShelfEntry[], over: FloorOver = {}): FloorResult =>
  floorVerdicts({
    shelf,
    rules: RULES,
    claimPhrases: CLAIMS,
    tapers: over.tapers ?? TAPERS,
    safety: { excludesPregnancyCaution: over.pregnant ?? false, mentions: over.mentions ?? [] },
  })

// ---- the fit judge's answers: every reason carries a marker, so a model's words found on a floor-decided product are caught ----

const AI = 'AI-SAID-THIS'
const helping = (id: string): FitProductResult => ({ id, label: 'helping', reason: `${AI} ${id} helps`, sameJobAs: null })
const blocking = (id: string): FitProductResult => ({ id, label: 'blocking', reason: `${AI} ${id} blocks`, sameJobAs: null })
const redundant = (id: string, sameJobAs: string): FitProductResult => ({ id, label: 'redundant', reason: `${AI} ${id} repeats`, sameJobAs })
const fitOf = (products: FitProductResult[], clashes: FitResult['clashes'] = []): FitResult => ({ products, clashes })

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const inner of Object.values(value)) deepFreeze(inner)
  }
  return value
}

type MergeOver = FloorOver & { choices?: SafetyChoice[] }
/** The real floor over the shelf, then the merge of it with `fit`. Everything handed to the merge is frozen, so a merge that edits its input throws. */
const merge = (shelf: FloorShelfEntry[], fit: FitResult | null, over: MergeOver = {}) => {
  const floor = floorOf(shelf, over)
  return mergeVerdict(deepFreeze({ floor, fit, entries: shelf, ...(over.choices ? { choices: over.choices } : {}) }))
}
const entryOf = (result: ReturnType<typeof merge>, id: string): VerdictProduct => {
  const found = result.products.find((p) => p.entryId === id)
  if (!found) throw new Error(`no product ${id}`)
  return found
}

// A shelf whose two active products clash (a retinoid and an exfoliating acid) next to a plain cream. The floor's tie-break reduces the acid first.
const CLASH_SHELF = (): FloorShelfEntry[] => [product('serum', ['Aqua', 'Retinol']), product('toner', ['Aqua', 'Glycolic Acid']), product('cream', ['Aqua', 'Glycerin'])]
const PAIR: [string, string] = ['serum', 'toner']
const REDUCED = { kind: 'reduce', maxFrequency: 'alternate-days' } as const

describe('mergeVerdict: a product the floor decided', () => {
  it('keeps a prescribed product as prescribed and kept, whatever else it holds, with the floor\'s fact and no model words', () => {
    const result = merge([product('rx', ['Aqua', 'Clobetasol']), product('cream', ['Aqua'])], fitOf([helping('cream')]), { mentions: [prescribed('prod-rx')] })

    expect(entryOf(result, 'rx')).toEqual({ entryId: 'rx', group: 'prescribed', verdict: { kind: 'keep' }, escalate: false, facts: [{ kind: 'prescription' }], reason: expect.any(String) })
    expect(entryOf(result, 'rx').reason).not.toContain(AI)
  })

  it('keeps the floor\'s steroid step-down: likely the problem, stop with the approved template, with the floor\'s facts and its own copy', () => {
    const result = merge([product('cream', ['Aqua', 'Clobetasol'])], fitOf([]))

    expect(entryOf(result, 'cream')).toEqual({
      entryId: 'cream',
      group: 'likely-the-problem',
      verdict: { kind: 'stop', taperTemplateId: 'TPR-STEROID-1' },
      escalate: false,
      facts: [{ kind: 'ingredient-group', group: 'steroid', ingredient: 'Clobetasol', ruleName: 'clobetasol propionate' }],
      reason: expect.stringContaining('Clobetasol'),
    })
  })

  it('keeps mercury as a drop with the escalation flag', () => {
    const result = merge([product('cream', ['Aqua', 'Mercuric Chloride'])], fitOf([]))

    expect(entryOf(result, 'cream')).toMatchObject({ group: 'likely-the-problem', verdict: { kind: 'drop' }, escalate: true })
  })

  it('keeps a pregnancy caution as conflicting and dropped', () => {
    const result = merge([product('serum', ['Aqua', 'Retinol'])], fitOf([]), { pregnant: true })

    expect(entryOf(result, 'serum')).toMatchObject({ group: 'conflicting', verdict: { kind: 'drop' }, escalate: false, facts: [{ kind: 'pregnancy-caution', ingredient: 'Retinol' }] })
  })

  it('keeps a no-label cream described as for lightening as likely the problem with the lightening step-down', () => {
    const result = merge([noLabel('tub', 'lighten')], fitOf([]))

    expect(entryOf(result, 'tub')).toMatchObject({ group: 'likely-the-problem', verdict: { kind: 'stop', taperTemplateId: 'TPR-LIGHTENING-1' }, facts: [{ kind: 'no-label-purpose', purpose: 'lighten' }] })
  })

  it('sets a product it cannot read aside as can\'t tell, dropped, with the nudge to photograph the back label', () => {
    const result = merge([product('mystery', []), noLabel('tub', 'moisturise')], fitOf([]))

    for (const id of ['mystery', 'tub']) {
      expect(entryOf(result, id)).toMatchObject({ group: 'cant-tell', verdict: { kind: 'drop' }, escalate: false, facts: [{ kind: 'unknown-contents' }], nudge: 'photograph-back-label' })
    }
  })

  it('gives the nudge to a can\'t-tell product only', () => {
    const result = merge([product('mystery', []), product('cream', ['Aqua']), product('hq', ['Hydroquinone'])], fitOf([helping('cream')]))

    expect(entryOf(result, 'cream')).not.toHaveProperty('nudge')
    expect(entryOf(result, 'hq')).not.toHaveProperty('nudge')
  })

  it('never uses the model\'s words for a product the floor decided', () => {
    const shelf = [product('hg', ['Mercury']), product('st', ['Clobetasol']), product('rx', ['Aqua'], {}), product('mystery', []), product('preg', ['Retinol']), product('open', ['Aqua'])]
    const result = merge(shelf, fitOf([helping('open')]), { pregnant: true, mentions: [prescribed('prod-rx')] })

    for (const id of ['hg', 'st', 'rx', 'mystery', 'preg']) {
      const { reason } = entryOf(result, id)
      expect(reason).not.toContain(AI)
      expect(reason.trim()).not.toBe('')
    }
  })

  it('adds the prescriber note to a step-down reason when the profile ticked prescription, and to nothing the model wrote', () => {
    const shelf = [product('st', ['Clobetasol']), product('open', ['Aqua'])]
    const without = merge(shelf, fitOf([helping('open')]))
    const withRx = merge(shelf, fitOf([helping('open')]), { choices: ['prescription'] })

    expect(entryOf(withRx, 'st').reason).toBe(`${entryOf(without, 'st').reason} If a doctor prescribed this, keep following their instructions.`)
    expect(entryOf(withRx, 'open').reason).toBe(entryOf(without, 'open').reason)
  })

  it('adds the prescriber note to a product it cannot read, and to a no-label cream described as for lightening', () => {
    const shelf = [product('mystery', []), noLabel('tub', 'lighten')]
    const without = merge(shelf, null)
    const withRx = merge(shelf, null, { choices: ['prescription'] })

    for (const id of ['mystery', 'tub']) expect(entryOf(withRx, id).reason).toBe(`${entryOf(without, id).reason} If a doctor prescribed this, keep following their instructions.`)
  })

  it('never adds the prescriber note to a reduction for a clash', () => {
    const without = merge(CLASH_SHELF(), fitOf([helping('serum'), helping('toner'), helping('cream')]))
    const withRx = merge(CLASH_SHELF(), fitOf([helping('serum'), helping('toner'), helping('cream')]), { choices: ['prescription'] })

    expect(entryOf(without, 'toner')).toMatchObject({ group: 'conflicting', verdict: REDUCED })
    expect(entryOf(withRx, 'toner').reason).toBe(entryOf(without, 'toner').reason)
    expect(entryOf(withRx, 'toner').reason).not.toContain('doctor prescribed')
  })

  it('never adds the prescriber note to mercury, a banned ingredient, the product reacted to, a pregnancy caution, a prescribed product or the model\'s words', () => {
    const shelf = [
      product('hg', ['Mercury']),
      product('musk', ['Zzyzx Musk']),
      product('reacted', ['Aqua']),
      product('preg', ['Retinol']),
      product('rx', ['Aqua', 'Glycerin']),
      product('open', ['Aqua', 'Squalane']),
    ]
    const mentions = [reactedTo('prod-reacted'), prescribed('prod-rx')]
    const fit = fitOf([helping('open')])
    const without = merge(shelf, fit, { pregnant: true, mentions })
    const withRx = merge(shelf, fit, { pregnant: true, mentions, choices: ['prescription'] })

    expect(without.products.find((p) => p.entryId === 'preg')).toMatchObject({ group: 'conflicting' })
    for (const { entryId, reason } of withRx.products) {
      expect(reason, entryId).toBe(entryOf(without, entryId).reason)
      expect(reason, entryId).not.toContain('doctor prescribed')
    }
  })
})

describe('mergeVerdict: a product the floor left open', () => {
  it('takes the model\'s label and reason: helping is kept', () => {
    const result = merge([product('cream', ['Aqua'])], fitOf([helping('cream')]))

    expect(entryOf(result, 'cream')).toEqual({ entryId: 'cream', group: 'helping', verdict: { kind: 'keep' }, escalate: false, facts: [], reason: `${AI} cream helps` })
  })

  it('takes the model\'s label and reason: blocking the goal is dropped, never stopped', () => {
    const result = merge([product('toner', ['Aqua'])], fitOf([blocking('toner')]))

    expect(entryOf(result, 'toner')).toEqual({ entryId: 'toner', group: 'blocking', verdict: { kind: 'drop' }, escalate: false, facts: [], reason: `${AI} toner blocks` })
  })

  it('takes the model\'s label and reason: redundant is dropped and names the product that does its job', () => {
    const result = merge([product('a', ['Aqua']), product('b', ['Aqua', 'Glycerin'])], fitOf([helping('a'), redundant('b', 'a')]))

    expect(entryOf(result, 'b')).toEqual({ entryId: 'b', group: 'redundant', verdict: { kind: 'drop' }, escalate: false, facts: [], reason: `${AI} b repeats`, sameJobAs: 'a' })
  })

  it('lets a redundant product name a prescribed product as the one that does its job', () => {
    const result = merge([product('rx', ['Aqua', 'Glycerin']), product('b', ['Aqua'])], fitOf([redundant('b', 'rx')]), { mentions: [prescribed('prod-rx')] })

    expect(entryOf(result, 'b')).toMatchObject({ group: 'redundant', sameJobAs: 'rx' })
  })

  it('refuses a redundant product whose same-job product is blocking, because that product does not stay', () => {
    const shelf = [product('a', ['Aqua']), product('b', ['Aqua', 'Glycerin'])]

    expect(() => merge(shelf, fitOf([blocking('a'), redundant('b', 'a')]))).toThrow()
  })

  it('refuses a redundant product whose same-job product is a fixed drop, a product the floor stops', () => {
    const shelf = [product('hg', ['Mercury']), product('b', ['Aqua'])]

    expect(() => merge(shelf, fitOf([redundant('b', 'hg')]))).toThrow()
  })

  it('refuses a redundant product whose same-job product is not on the shelf', () => {
    expect(() => merge([product('b', ['Aqua'])], fitOf([redundant('b', 'ghost')]))).toThrow()
  })

  it('refuses a redundant product that is redundant to a redundant one (neither stays)', () => {
    const shelf = [product('a', ['Aqua']), product('b', ['Aqua']), product('c', ['Aqua'])]

    expect(() => merge(shelf, fitOf([helping('a'), redundant('b', 'a'), redundant('c', 'b')]))).toThrow()
  })

  it.each([
    ['helping for a mercury product', 'hg', helping('hg')],
    ['helping for a steroid product', 'st', helping('st')],
    ['helping for a product it cannot read', 'mystery', helping('mystery')],
    ['blocking for a prescribed product', 'rx', blocking('rx')],
    ['redundant for a prescribed product', 'rx', redundant('rx', 'open')],
  ])('leaves a product the floor fixed exactly as it was when the model tries to change it: %s', (_name, id, attempt) => {
    const shelf = [product('hg', ['Mercury']), product('st', ['Clobetasol']), product('mystery', []), product('rx', ['Aqua', 'Glycerin']), product('open', ['Aqua', 'Squalane'])]
    const mentions = [prescribed('prod-rx')]
    const asked = merge(shelf, fitOf([helping('open')]), { mentions })

    const tried = merge(shelf, fitOf([helping('open'), attempt]), { mentions })

    expect(entryOf(tried, id)).toEqual(entryOf(asked, id))
    expect(tried).toEqual(asked)
  })

  it('refuses an answer that leaves out an open product, because that product would be left with no label', () => {
    const shelf = [product('a', ['Aqua']), product('b', ['Aqua', 'Glycerin'])]

    expect(() => merge(shelf, fitOf([helping('a')]))).toThrow()
    expect(() => merge(shelf, fitOf([]))).toThrow()
  })

  it('refuses a redundant product that names no product that does its job', () => {
    const shelf = [product('a', ['Aqua']), product('b', ['Aqua', 'Glycerin'])]
    const bad = { id: 'b', label: 'redundant', reason: `${AI} b repeats`, sameJobAs: null } as unknown as FitProductResult

    expect(() => merge(shelf, fitOf([helping('a'), bad]))).toThrow()
  })

  it.each(['neutral', 'harming', 'Blocking', ''])('refuses a label that is not helping, redundant or blocking (%j), and never turns it into a drop', (label) => {
    const bad = { id: 'a', label, reason: `${AI} a ?`, sameJobAs: null } as unknown as FitProductResult

    expect(() => merge([product('a', ['Aqua'])], fitOf([bad]))).toThrow()
  })

  it('says fit is ready when the model answered', () => {
    expect(merge([product('cream', ['Aqua'])], fitOf([helping('cream')])).fit).toBe('ready')
  })
})

describe('mergeVerdict: no fit answer (the judge failed, was refused, or has not run)', () => {
  it('leaves every open product undecided and kept, with a reason of our own, and says fit is not ready', () => {
    const result = merge([product('a', ['Aqua']), product('b', ['Aqua', 'Glycerin'])], null)

    expect(result.fit).toBe('not-ready')
    for (const id of ['a', 'b']) {
      expect(entryOf(result, id)).toEqual({ entryId: id, group: 'undecided', verdict: { kind: 'keep' }, escalate: false, facts: [], reason: expect.any(String) })
      expect(entryOf(result, id).reason.trim()).not.toBe('')
    }
  })

  it('still gives every floor label, because safety never waits on the model', () => {
    const result = merge([product('hg', ['Mercury']), product('st', ['Clobetasol']), product('mystery', []), product('open', ['Aqua'])], null)

    expect(entryOf(result, 'hg')).toMatchObject({ group: 'likely-the-problem', verdict: { kind: 'drop' }, escalate: true })
    expect(entryOf(result, 'st')).toMatchObject({ group: 'likely-the-problem', verdict: { kind: 'stop', taperTemplateId: 'TPR-STEROID-1' } })
    expect(entryOf(result, 'mystery')).toMatchObject({ group: 'cant-tell', nudge: 'photograph-back-label' })
    expect(entryOf(result, 'open')).toMatchObject({ group: 'undecided' })
  })

  it('says fit is ready when no call was needed: no product is open and nothing clashes', () => {
    const result = merge([product('hg', ['Mercury']), product('mystery', [])], null)

    expect(result.fit).toBe('ready')
  })
})

describe('mergeVerdict: a step-down that has no approved template', () => {
  it('throws, so the build aborts and a product that needs a step-down is never shown as a plain drop', () => {
    expect(() => merge([product('st', ['Clobetasol'])], fitOf([]), { tapers: { 'lightening-agent': 'TPR-LIGHTENING-1' } })).toThrow()
  })

  it('throws for a lightening product too, and also when there is no fit answer', () => {
    expect(() => merge([product('hq', ['Hydroquinone'])], null, { tapers: { steroid: 'TPR-STEROID-1' } })).toThrow()
    expect(() => merge([noLabel('tub', 'lighten')], null, { tapers: {} })).toThrow()
  })
})

describe('mergeVerdict: a clashing pair', () => {
  it('reduces the product the model names, to alternate days, as conflicting, with the floor\'s copy and not the model\'s', () => {
    const floor = floorOf(CLASH_SHELF())
    expect(floor.clashes).toHaveLength(1)
    expect(floor.clashes[0]!.ids).toEqual(PAIR)

    const result = merge(CLASH_SHELF(), fitOf([helping('serum'), helping('toner'), helping('cream')], [{ ids: PAIR, reduceId: 'serum' }]))

    expect(entryOf(result, 'serum')).toEqual({ entryId: 'serum', group: 'conflicting', verdict: REDUCED, escalate: false, facts: [], reason: expect.any(String) })
    expect(entryOf(result, 'serum').reason).not.toContain(AI)
    expect(entryOf(result, 'toner')).toMatchObject({ group: 'helping', verdict: { kind: 'keep' } })
    expect(entryOf(result, 'cream')).toMatchObject({ group: 'helping', verdict: { kind: 'keep' } })
  })

  it('reduces the other product when the model names it instead', () => {
    const result = merge(CLASH_SHELF(), fitOf([helping('serum'), helping('toner'), helping('cream')], [{ ids: PAIR, reduceId: 'toner' }]))

    expect(entryOf(result, 'toner')).toMatchObject({ group: 'conflicting', verdict: REDUCED })
    expect(entryOf(result, 'serum')).toMatchObject({ group: 'helping', verdict: { kind: 'keep' } })
  })

  it('reduces the floor\'s fallback when the model names none (the acid before the retinoid)', () => {
    const floor = floorOf(CLASH_SHELF())
    expect(floor.clashes[0]!.fallbackReduceId).toBe('toner')

    const result = merge(CLASH_SHELF(), fitOf([helping('serum'), helping('toner'), helping('cream')], []))

    expect(entryOf(result, 'toner')).toMatchObject({ group: 'conflicting', verdict: REDUCED })
    expect(entryOf(result, 'serum')).toMatchObject({ group: 'helping', verdict: { kind: 'keep' } })
  })

  it('reduces the floor\'s fallback even with no fit answer (a floor decision), and keeps the other undecided', () => {
    const result = merge(CLASH_SHELF(), null)

    expect(entryOf(result, 'toner')).toMatchObject({ group: 'conflicting', verdict: REDUCED })
    expect(entryOf(result, 'serum')).toMatchObject({ group: 'undecided', verdict: { kind: 'keep' } })
    expect(result.fit).toBe('not-ready')
  })

  it('voids the clash when one member is dropped as redundant, and leaves the other member as the model labelled it', () => {
    const toDrop = merge(CLASH_SHELF(), fitOf([helping('serum'), redundant('toner', 'cream'), helping('cream')], [{ ids: PAIR, reduceId: 'serum' }]))

    expect(entryOf(toDrop, 'toner')).toMatchObject({ group: 'redundant', verdict: { kind: 'drop' }, sameJobAs: 'cream' })
    expect(entryOf(toDrop, 'serum')).toMatchObject({ group: 'helping', verdict: { kind: 'keep' } })
  })

  it('voids the clash when the other member is the one dropped, whichever the model named to reduce', () => {
    const result = merge(CLASH_SHELF(), fitOf([blocking('serum'), helping('toner'), helping('cream')], [{ ids: PAIR, reduceId: 'toner' }]))

    expect(entryOf(result, 'serum')).toMatchObject({ group: 'blocking', verdict: { kind: 'drop' } })
    expect(entryOf(result, 'toner')).toMatchObject({ group: 'helping', verdict: { kind: 'keep' } })
  })

  it('never loosens a drop: the product the model named to reduce, if it also blocked it, stays blocking and dropped', () => {
    const result = merge(CLASH_SHELF(), fitOf([helping('serum'), blocking('toner'), helping('cream')], [{ ids: PAIR, reduceId: 'toner' }]))

    expect(entryOf(result, 'toner')).toEqual({ entryId: 'toner', group: 'blocking', verdict: { kind: 'drop' }, escalate: false, facts: [], reason: `${AI} toner blocks` })
  })

  it('does nothing when both members are dropped', () => {
    const result = merge(CLASH_SHELF(), fitOf([blocking('serum'), blocking('toner'), helping('cream')], []))

    expect(result.products.filter((p) => p.group === 'conflicting')).toEqual([])
  })

  it('never reduces a prescribed product: the other member of the pair is reduced', () => {
    const shelf = [product('serum', ['Aqua', 'Retinol']), product('toner', ['Aqua', 'Glycolic Acid'])]
    const result = merge(shelf, fitOf([helping('toner')], []), { mentions: [prescribed('prod-serum')] })

    expect(entryOf(result, 'serum')).toMatchObject({ group: 'prescribed', verdict: { kind: 'keep' } })
    expect(entryOf(result, 'toner')).toMatchObject({ group: 'conflicting', verdict: REDUCED })
  })

  it('lets a redundant product name the reduced product as the one that does its job, because a reduced product stays', () => {
    const shelf = [...CLASH_SHELF(), product('cream2', ['Aqua', 'Glycerin'])]
    const result = merge(shelf, fitOf([helping('serum'), helping('toner'), helping('cream'), redundant('cream2', 'toner')], [{ ids: PAIR, reduceId: 'toner' }]))

    expect(entryOf(result, 'toner')).toMatchObject({ group: 'conflicting', verdict: REDUCED })
    expect(entryOf(result, 'cream2')).toMatchObject({ group: 'redundant', sameJobAs: 'toner' })
  })

  it('reduces a product that is in two clashing pairs once, with one reason, and it stays reduced', () => {
    // The retinoid serum clashes with each of the two acids; the two acids do not clash with one another.
    const shelf = [product('serum', ['Aqua', 'Retinol']), product('toner', ['Aqua', 'Glycolic Acid']), product('peel', ['Aqua', 'Lactic Acid'])]
    const floor = floorOf(shelf)
    expect(floor.clashes.map((c) => c.ids)).toEqual([['serum', 'toner'], ['serum', 'peel']])

    const result = merge(shelf, fitOf([helping('serum'), helping('toner'), helping('peel')], [{ ids: ['serum', 'toner'], reduceId: 'serum' }, { ids: ['serum', 'peel'], reduceId: 'serum' }]))

    expect(result.products.filter((p) => p.verdict.kind === 'reduce').map((p) => p.entryId)).toEqual(['serum'])
    expect(entryOf(result, 'serum')).toEqual({ entryId: 'serum', group: 'conflicting', verdict: REDUCED, escalate: false, facts: [], reason: expect.stringMatching(/alternate days.*retinoid.*exfoliating acid/i) })
    expect(entryOf(result, 'toner')).toMatchObject({ group: 'helping', verdict: { kind: 'keep' } })
    expect(entryOf(result, 'peel')).toMatchObject({ group: 'helping', verdict: { kind: 'keep' } })
  })

  it('reduces the floor\'s fallback of each pair when the model names none, and a product in two pairs is not reduced twice', () => {
    const shelf = [product('serum', ['Aqua', 'Retinol']), product('toner', ['Aqua', 'Glycolic Acid']), product('peel', ['Aqua', 'Lactic Acid'])]

    const result = merge(shelf, fitOf([helping('serum'), helping('toner'), helping('peel')]))

    expect(result.products.map((p) => [p.entryId, p.verdict.kind])).toEqual([['serum', 'keep'], ['toner', 'reduce'], ['peel', 'reduce']])
  })

  it('does not touch a pair that was never a clash on this shelf', () => {
    const result = merge([product('serum', ['Aqua', 'Retinol']), product('cream', ['Aqua'])], fitOf([helping('serum'), helping('cream')]))

    expect(result.products.map((p) => p.group)).toEqual(['helping', 'helping'])
  })
})

describe('mergeVerdict: the order, and what it does not touch', () => {
  it('lists the skin products in the order of the shelf it is given, leaving out what is not skin', () => {
    const shelf = [product('c', ['Aqua']), product('hair', ['Aqua'], { category: 'hair' }), product('a', ['Aqua']), noLabel('tub', 'moisturise'), product('b', ['Aqua'])]

    const result = merge(shelf, fitOf([helping('c'), helping('a'), helping('b')]))

    expect(result.products.map((p) => p.entryId)).toEqual(['c', 'a', 'tub', 'b'])
  })

  it('follows the order of `entries`, not the order the floor listed them in', () => {
    const shelf = [product('a', ['Aqua']), product('b', ['Aqua']), product('c', ['Aqua'])]
    const floor = floorOf(shelf)

    const result = mergeVerdict({ floor, fit: fitOf([helping('a'), helping('b'), helping('c')]), entries: [shelf[2]!, shelf[0]!, shelf[1]!] })

    expect(result.products.map((p) => p.entryId)).toEqual(['c', 'a', 'b'])
  })

  it('gives the same answer for the same input, and an empty shelf is an empty verdict that is ready', () => {
    const shelf = CLASH_SHELF()
    const fit = fitOf([helping('serum'), helping('toner'), helping('cream')], [{ ids: PAIR, reduceId: 'serum' }])

    expect(merge(shelf, fit)).toEqual(merge(shelf, fit))
    expect(merge([], fitOf([]))).toEqual({ fit: 'ready', products: [] })
  })
})

// ---- the invariant: the merge only ever makes a verdict stricter ----

/** Strictness, strictest first (spec #171, owner decision). A prescribed product is outside the order. */
const RANK: Record<Exclude<VerdictProduct['group'], 'prescribed'>, number> = {
  'likely-the-problem': 6,
  conflicting: 5,
  'cant-tell': 4,
  blocking: 3,
  redundant: 2,
  helping: 1,
  undecided: 0,
}

/** A small deterministic generator (a linear congruential one), so a failing case can be rerun from its seed. */
const generator = (seed: number) => {
  let state = seed >>> 0
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
  return {
    chance: (p: number) => next() < p,
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!,
    between: (low: number, high: number) => low + Math.floor(next() * (high - low + 1)),
  }
}

const INGREDIENT_LISTS: string[][] = [
  ['Aqua', 'Glycerin'],
  ['Aqua', 'Squalane', 'Glycerin'],
  ['Aqua', 'Retinol'],
  ['Aqua', 'Glycolic Acid'],
  ['Aqua', 'Benzoyl Peroxide'],
  ['Aqua', 'Clobetasol'],
  ['Aqua', 'Mercury'],
  ['Aqua', 'Hydroquinone'],
  ['Aqua', 'Parfum'],
  ['Aqua', 'Zzyzx Musk'],
  [],
]

describe('mergeVerdict: stricter only (generated shelves, floors and fit answers)', () => {
  const CASES = 400

  it('never ends a product less strict than the floor left it, never changes a fixed label, and always keeps a prescribed product', () => {
    for (let seed = 1; seed <= CASES; seed++) {
      const random = generator(seed)
      const size = random.between(1, 7)
      const shelf: FloorShelfEntry[] = []
      for (let at = 0; at < size; at++) {
        const id = `p${at}`
        if (random.chance(0.12)) shelf.push(noLabel(id, random.pick(['lighten', 'moisturise', 'not-sure'] as const)))
        else if (random.chance(0.08)) shelf.push(product(id, ['Aqua'], { category: 'hair' }))
        else shelf.push(product(id, random.pick(INGREDIENT_LISTS)))
      }
      const mentions: FloorMention[] = []
      if (random.chance(0.3)) mentions.push(prescribed(`prod-p${random.between(0, size - 1)}`))
      if (random.chance(0.3)) mentions.push(reactedTo(`prod-p${random.between(0, size - 1)}`))
      if (random.chance(0.2)) mentions.push(reactedToIngredient('fragrance'))
      const over: FloorOver = { pregnant: random.chance(0.3), mentions }
      const floor = floorOf(shelf, over)
      const fixedKept = new Set(floor.entries.filter((e) => e.status === 'fixed' && e.group === 'prescribed').map((e) => e.id))
      const open = floor.entries.filter((e) => e.status === 'open').map((e) => e.id)

      // A valid answer over the open ids only: redundant names a product that stays (an open one the answer calls helping, or a prescribed one).
      let fit: FitResult | null = null
      if (!random.chance(0.15)) {
        const labels = new Map(open.map((id) => [id, random.pick(['helping', 'blocking', 'redundant'] as const)]))
        const stays = [...open.filter((id) => labels.get(id) === 'helping'), ...fixedKept]
        const products = open.map((id): FitProductResult => {
          const label = labels.get(id)!
          if (label === 'redundant' && stays.length > 0) return redundant(id, random.pick(stays))
          return label === 'blocking' ? blocking(id) : helping(id)
        })
        // A redundant answer that fell back to helping changes who stays; the redundants above only name ids that were helping or prescribed, so it is still valid.
        const clashes = floor.clashes.flatMap(({ ids, fallbackReduceId }) => (random.chance(0.5) ? [{ ids, reduceId: random.chance(0.5) ? fallbackReduceId : ids.find((id) => !fixedKept.has(id) && id !== fallbackReduceId) ?? fallbackReduceId }] : []))
        fit = fitOf(products, clashes)
      }

      const label = `seed ${seed}`
      const result = mergeVerdict({ floor, fit, entries: shelf })
      const skin = shelf.filter((e) => e.category === 'skin').map((e) => e.id)
      expect(result.products.map((p) => p.entryId), label).toEqual(skin)

      const survivors = new Set(result.products.filter((p) => p.verdict.kind === 'keep' || p.verdict.kind === 'reduce').map((p) => p.entryId))
      for (const final of result.products) {
        const before: FloorEntry = floor.entries.find((e) => e.id === final.entryId)!
        if (before.status === 'fixed') {
          // A floor label is never touched.
          expect(final.group, label).toBe(before.group)
          expect(final.verdict, label).toEqual(before.verdict)
          expect(final.escalate, label).toBe(before.escalate)
          if (before.group === 'prescribed') expect(final.verdict, label).toEqual({ kind: 'keep' })
          continue
        }
        if (final.group === 'prescribed') throw new Error(`${label}: ${final.entryId} became prescribed`)
        // Never less strict than what the model said, and a clash is the only thing that may move an open product off its label.
        const said = fit?.products.find((p) => p.id === final.entryId)
        if (fit === null) expect(['undecided', 'conflicting'], label).toContain(final.group)
        else {
          expect(said, `${label} ${final.entryId} has an answer`).toBeDefined()
          expect([said!.label, 'conflicting'], label).toContain(final.group)
          if (final.group === 'conflicting') expect(said!.label, label).toBe('helping')
        }
        expect(RANK[final.group], label).toBeGreaterThanOrEqual(said ? RANK[said.label] : RANK.undecided)
        // The model's drop is never loosened by a clash.
        if (said && said.label !== 'helping') expect(final.verdict, label).toEqual({ kind: 'drop' })
        // A product that is not dropped is kept or reduced, and only a conflicting one is reduced.
        if (final.verdict.kind === 'reduce') expect(final.group, label).toBe('conflicting')
        if (final.group === 'redundant') expect(survivors.has(final.sameJobAs!), label).toBe(true)
      }
      // The model's helping products are at most reduced, never dropped, by the merge.
      for (const said of fit?.products ?? []) {
        if (said.label === 'helping') expect(['helping', 'conflicting'], `${label} ${said.id}`).toContain(entryOf(result, said.id).group)
      }
      // Fit is ready exactly when the judge answered, or had nothing to answer.
      expect(result.fit, label).toBe(fit !== null || (open.length === 0 && floor.clashes.length === 0) ? 'ready' : 'not-ready')
    }
  })
})
