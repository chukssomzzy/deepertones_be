import { describe, expect, it } from 'vitest'
import type { RoutineStep } from '../../src/modules/catalog/catalog.vocabulary'
import { ROUTINE_ALLOWED_FREQUENCIES } from '../../src/modules/routines/routines.rules'
import { buildSkeleton } from './routine-skeleton'
import { caseOf, GB, NG, offer, type Recommendation, row, RULES, rule, shelfProduct, snapshotOf } from './routine.fixture'

// buildSkeleton runs the REAL RecommendationService.candidatesFor (under runAs) for each gap step, over the snapshot's FakeCatalogWorkbook and small
// stubs for the goal, safety answers, skin type and product reads, so a candidate is in a skeleton for exactly the reason it would be in the app.
// The snapshot here is a handful of rows built in the test. Expected values are worked out from the spec's rules, not from the code under test.
// Rows default to a glow-goal person with no skin type and no budget (see routine.fixture.ts), so a test changes the one thing it is about.

const stock = (rows: Recommendation[], country = 'NG') => snapshotOf(rows.map((r) => offer(country, r)))
const build = (c = caseOf(), rows: Recommendation[] = [], hintsShown = false) => buildSkeleton(c, stock(rows), { hintsShown })
const codes = async (c = caseOf(), rows: Recommendation[] = [], step: RoutineStep = 'moisturise') => {
  const { skeleton } = await build(c, rows)
  return skeleton.gaps.find((gap) => gap.step === step)?.candidates.map((candidate) => candidate.code)
}

describe('buildSkeleton: the steps and the gaps', () => {
  it('lists all four routine steps, in routine order, whatever the shelf holds', async () => {
    const { skeleton } = await build(caseOf({ shelf: [shelfProduct('moist', { step: 'moisturise' })] }))

    expect(skeleton.steps).toEqual(['cleanse', 'treat', 'moisturise', 'protect'])
  })

  it('makes a gap of every step when the shelf is empty, each with an empty candidate list when the catalog has nothing for it', async () => {
    const { skeleton } = await build()

    expect(skeleton.gaps).toEqual([
      { step: 'cleanse', candidates: [] },
      { step: 'treat', candidates: [] },
      { step: 'moisturise', candidates: [] },
      { step: 'protect', candidates: [] },
    ])
  })

  it('does not make a gap of a step a kept or a reduced shelf product fills', async () => {
    const shelf = [
      shelfProduct('cleanser', { step: 'cleanse', verdict: { kind: 'keep' } }),
      shelfProduct('cream', { step: 'moisturise', verdict: { kind: 'reduce', maxFrequency: 'pm' } }),
    ]

    const { skeleton } = await build(caseOf({ shelf }))

    expect(skeleton.gaps.map((gap) => gap.step)).toEqual(['treat', 'protect'])
  })

  it('leaves a step a gap when the only shelf product for it is dropped: a dropped product is left out of the routine and fills nothing', async () => {
    const shelf = [shelfProduct('toner', { step: 'treat', verdict: { kind: 'drop' } }), shelfProduct('cleanser', { step: 'cleanse', verdict: { kind: 'keep' } })]

    const { skeleton } = await build(caseOf({ shelf }))

    expect(skeleton.gaps.map((gap) => gap.step)).toEqual(['treat', 'moisturise', 'protect'])
    expect(skeleton.shelf).toEqual(shelf)
  })

  it('leaves a step a gap when the only shelf product for it is stopped', async () => {
    const shelf = [shelfProduct('steroid', { step: 'treat', verdict: { kind: 'stop', taperTemplateId: 'tpl-steroid' } })]

    const { skeleton } = await build(caseOf({ shelf }))

    expect(skeleton.gaps.map((gap) => gap.step)).toEqual(['cleanse', 'treat', 'moisturise', 'protect'])
  })

  it('does not make a gap of a step that a stopped product shares with a kept one', async () => {
    const shelf = [
      shelfProduct('old-cleanser', { step: 'cleanse', verdict: { kind: 'stop', taperTemplateId: 'tpl-x' } }),
      shelfProduct('good-cleanser', { step: 'cleanse', verdict: { kind: 'keep' } }),
    ]

    const { skeleton } = await build(caseOf({ shelf }))

    expect(skeleton.gaps.map((gap) => gap.step)).toEqual(['treat', 'moisturise', 'protect'])
  })

  it('leaves every step a gap for a shelf product that fills none of the four', async () => {
    const { skeleton } = await build(caseOf({ shelf: [shelfProduct('body-butter', { step: null })] }))

    expect(skeleton.gaps.map((gap) => gap.step)).toEqual(['cleanse', 'treat', 'moisturise', 'protect'])
  })

  it('carries the case\'s shelf into the skeleton unchanged', async () => {
    const shelf = [shelfProduct('a', { step: 'cleanse' }), shelfProduct('b', { step: 'treat', verdict: { kind: 'stop', taperTemplateId: 'tpl-b' }, sourceUrls: ['https://rules.example/b'] })]

    const { skeleton } = await build(caseOf({ shelf }))

    expect(skeleton.shelf).toEqual(shelf)
  })

  it('carries the goal and the person: what was seen, the skin type, the cautions and the budget band, with the scan\'s three low-confidence concerns', async () => {
    const c = caseOf({
      goal: 'even-tone',
      budgetBand: 'mid',
      skinType: 'dry',
      seen: [{ concern: 'hd_age_spot', level: 'clear' }],
      alsoNoticed: [{ concern: 'hd_acne', level: 'a-little' }],
      cautions: ['recent-reaction'],
      safety: { choices: ['reaction'], reactionIngredients: ['fragrance'], prescriptionIngredients: [] },
    })

    const { skeleton } = await build(c)

    expect(skeleton.goal).toBe('even-tone')
    expect(skeleton.person).toEqual({
      seen: [{ concern: 'hd_age_spot', level: 'clear' }],
      alsoNoticed: [{ concern: 'hd_acne', level: 'a-little' }],
      skinType: 'dry',
      lowConfidence: ['hd_redness', 'hd_texture', 'hd_moisture'],
      cautions: ['recent-reaction'],
      budgetBand: 'mid',
    })
  })

  it('says whether outcome hints were shown, as asked', async () => {
    expect((await build(caseOf(), [], true)).skeleton.hintsShown).toBe(true)
    expect((await build(caseOf(), [], false)).skeleton.hintsShown).toBe(false)
  })
})

describe('buildSkeleton: the candidates come from the real rules', () => {
  it('offers a row sold in the case\'s country that fills the step and works on one of the goal\'s concerns', async () => {
    expect(await codes(caseOf(), [row('FIT')])).toEqual(['FIT'])
  })

  it('leaves out a row that works on none of the goal\'s concerns (glow: radiance, moisture, texture)', async () => {
    expect(await codes(caseOf(), [row('ACNE-ONLY', { skinConcerns: ['hd_acne'] }), row('FIT')])).toEqual(['FIT'])
  })

  it('offers only what is sold in the case\'s own country', async () => {
    const snapshot = snapshotOf([offer('GB', row('UK-ONLY')), offer('NG', row('NG-ONLY'))])

    const gb = await buildSkeleton(caseOf({ country: 'GB' }), snapshot, { hintsShown: false })
    const ng = await buildSkeleton(caseOf({ country: 'NG' }), snapshot, { hintsShown: false })

    expect(gb.skeleton.gaps.find((g) => g.step === 'moisturise')!.candidates.map((c) => c.code)).toEqual(['UK-ONLY'])
    expect(ng.skeleton.gaps.find((g) => g.step === 'moisturise')!.candidates.map((c) => c.code)).toEqual(['NG-ONLY'])
  })

  it('files a row under every step it fills', async () => {
    const both = row('TWO-STEPS', { steps: ['cleanse', 'moisturise'] })

    expect(await codes(caseOf(), [both], 'cleanse')).toEqual(['TWO-STEPS'])
    expect(await codes(caseOf(), [both], 'moisturise')).toEqual(['TWO-STEPS'])
    expect(await codes(caseOf(), [both], 'protect')).toEqual([])
  })

  it.each(['pregnant', 'breastfeeding'] as const)('never gives a %s case a row with a pregnancy-caution ingredient, and does give it to someone who is neither', async (choice) => {
    const rows = [row('RETINOL-CREAM', { ingredients: ['Aqua', 'Retinol'] }), row('PLAIN-CREAM')]

    const careful = await codes(caseOf({ safety: { choices: [choice], reactionIngredients: [], prescriptionIngredients: [] }, cautions: [choice] }), rows)
    const other = await codes(caseOf(), rows)

    expect(careful).toEqual(['PLAIN-CREAM'])
    expect(other?.sort()).toEqual(['PLAIN-CREAM', 'RETINOL-CREAM'])
  })

  it('takes a row with a banned ingredient out for everyone', async () => {
    expect(await codes(caseOf(), [row('HQ-CREAM', { ingredients: ['Aqua', 'Hydroquinone'] }), row('PLAIN-CREAM')])).toEqual(['PLAIN-CREAM'])
  })

  it('takes a row out when it lists an ingredient the case reacted to, under either spelling the rules know', async () => {
    const c = caseOf({ safety: { choices: ['reaction'], reactionIngredients: ['fragrance'], prescriptionIngredients: [] }, cautions: ['recent-reaction'] })
    const rows = [row('PARFUM-CREAM', { ingredients: ['Aqua', 'Parfum'] }), row('FRAGRANCE-CREAM', { ingredients: ['Aqua', 'Fragrance'] }), row('PLAIN-CREAM')]

    expect(await codes(c, rows)).toEqual(['PLAIN-CREAM'])
    // The same rows are all offered to someone who did not react.
    expect((await codes(caseOf(), rows))?.sort()).toEqual(['FRAGRANCE-CREAM', 'PARFUM-CREAM', 'PLAIN-CREAM'])
  })

  it('takes a row out when it lists an ingredient the case is prescribed, through the labels the live rules give it ("retinoic acid" is "tretinoin")', async () => {
    const c = caseOf({ safety: { choices: ['prescription'], reactionIngredients: [], prescriptionIngredients: ['retinoic acid'] }, cautions: ['prescription'] })
    const snapshot = snapshotOf([offer('NG', row('TRETINOIN-CREAM', { ingredients: ['Aqua', 'Tretinoin'] })), offer('NG', row('PLAIN-CREAM'))], { rules: [...RULES, rule('tretinoin', 'pregnancy-caution', ['retinoic acid'])] })

    const { skeleton } = await buildSkeleton(c, snapshot, { hintsShown: false })
    const other = await buildSkeleton(caseOf(), snapshot, { hintsShown: false })

    expect(skeleton.gaps.find((g) => g.step === 'moisturise')!.candidates.map((x) => x.code)).toEqual(['PLAIN-CREAM'])
    expect(other.skeleton.gaps.find((g) => g.step === 'moisturise')!.candidates.map((x) => x.code).sort()).toEqual(['PLAIN-CREAM', 'TRETINOIN-CREAM'])
  })

  describe('the budget band, in the country\'s own money (NG: low up to 5000, mid up to 15000)', () => {
    const rows = [
      row('AT-LOW-TOP', { priceMin: 5000, priceMax: 5000 }),
      row('OVER-LOW-TOP', { priceMin: 5001, priceMax: 5001 }),
      row('AT-MID-TOP', { priceMin: 15000, priceMax: 15000 }),
      row('OVER-MID-TOP', { priceMin: 15001, priceMax: 15001 }),
    ]

    it('keeps a row at the top of the low band and drops one a naira over it', async () => {
      expect(await codes(caseOf({ budgetBand: 'low' }), rows)).toEqual(['AT-LOW-TOP'])
    })

    it('keeps a row at the top of the mid band and drops one a naira over it', async () => {
      expect((await codes(caseOf({ budgetBand: 'mid' }), rows))?.sort()).toEqual(['AT-LOW-TOP', 'AT-MID-TOP', 'OVER-LOW-TOP'])
    })

    it('has no ceiling for the high band or for no band', async () => {
      const all = ['AT-LOW-TOP', 'AT-MID-TOP', 'OVER-LOW-TOP', 'OVER-MID-TOP']
      expect((await codes(caseOf({ budgetBand: 'high' }), rows))?.sort()).toEqual(all)
      expect((await codes(caseOf({ budgetBand: null }), rows))?.sort()).toEqual(all)
    })

    it('reads the band in the case\'s own country (GB: low up to 15)', async () => {
      const snapshot = snapshotOf([offer('GB', row('AT', { priceMin: 15, priceMax: 15 })), offer('GB', row('OVER', { priceMin: 16, priceMax: 16 }))], { countries: [NG, GB] })

      const { skeleton } = await buildSkeleton(caseOf({ country: 'GB', budgetBand: 'low' }), snapshot, { hintsShown: false })

      expect(skeleton.gaps.find((g) => g.step === 'moisturise')!.candidates.map((c) => c.code)).toEqual(['AT'])
    })
  })

  it('gives an unknown skin type only the rows for all skin types, and a known one those and its own', async () => {
    const rows = [row('ALL'), row('DRY-ONLY', { skinTypes: ['dry'] }), row('OILY-ONLY', { skinTypes: ['oily'] })]

    expect(await codes(caseOf({ skinType: null }), rows)).toEqual(['ALL'])
    expect((await codes(caseOf({ skinType: 'dry' }), rows))?.sort()).toEqual(['ALL', 'DRY-ONLY'])
  })

  it('orders each gap\'s candidates cheapest first, and lists the same codes sorted by code in gapCodes', async () => {
    const rows = [row('B-CHEAP', { priceMin: 1000 }), row('A-DEAR', { priceMin: 3000 }), row('C-MID', { priceMin: 2000 })]

    const { skeleton, gapCodes } = await build(caseOf(), rows)

    expect(skeleton.gaps.find((g) => g.step === 'moisturise')!.candidates.map((c) => c.code)).toEqual(['B-CHEAP', 'C-MID', 'A-DEAR'])
    expect(gapCodes.moisturise).toEqual(['A-DEAR', 'B-CHEAP', 'C-MID'])
  })

  it('lists gapCodes for the gaps only: a step the shelf fills is not in it, and a gap with no candidates has an empty list', async () => {
    const c = caseOf({ shelf: [shelfProduct('cleanser', { step: 'cleanse' })] })

    const { gapCodes } = await build(c, [row('MOIST')])

    expect(gapCodes).toEqual({ treat: [], moisturise: ['MOIST'], protect: [] })
  })
})

describe('buildSkeleton: what a candidate carries', () => {
  const full = row('FULL', {
    ingredients: ['Aqua', 'Glycerin', 'Niacinamide'],
    skinConcerns: ['hd_radiance', 'hd_texture'],
    frequency: 'pm',
    priceMin: 2500,
    priceMax: 4000,
    origin: 'brand-submitted',
    evidenceUrls: ['https://evidence.example/full/a', 'https://evidence.example/full/b'],
    ingredientsSourceUrl: 'https://ingredients.example/full',
    // Shown to users by the routine stage, never to the writer: the skeleton below must not carry them, or what the eval measured would change.
    keyIngredient: 'Niacinamide',
    strength: '4%',
  })

  it('maps a candidate to the fields the writer sees, with the evidence links and no outcome hint, and without the key ingredient or strength', async () => {
    const snapshot = snapshotOf([offer('NG', full, { brand: 'Glow Co', name: 'Night Cream', form: 'cream' })])

    const { skeleton } = await buildSkeleton(caseOf(), snapshot, { hintsShown: false })

    expect(skeleton.gaps.find((g) => g.step === 'moisturise')!.candidates).toEqual([
      {
        code: 'FULL',
        brand: 'Glow Co',
        name: 'Night Cream',
        form: 'cream',
        ingredients: ['Aqua', 'Glycerin', 'Niacinamide'],
        skinConcerns: ['hd_radiance', 'hd_texture'],
        frequency: 'pm',
        priceMin: 2500,
        priceMax: 4000,
        evidenceUrls: ['https://evidence.example/full/a', 'https://evidence.example/full/b'],
        ingredientsSourceUrl: 'https://ingredients.example/full',
        outcomeHint: null,
      },
    ])
  })

  it('never shows who put a product forward: no origin on a candidate, and the word nowhere in the skeleton', async () => {
    const { skeleton } = await build(caseOf(), [full, row('SOURCED', { origin: 'sourced' })])

    const candidates = skeleton.gaps.flatMap((g) => g.candidates)
    expect(candidates).toHaveLength(2)
    for (const candidate of candidates) expect(candidate).not.toHaveProperty('origin')
    expect(JSON.stringify(skeleton)).not.toContain('brand-submitted')
  })

  it('leaves the outcome hint null even when hints are said to be shown (there are none to show in this eval yet)', async () => {
    const { skeleton } = await build(caseOf(), [full], true)

    for (const candidate of skeleton.gaps.flatMap((g) => g.candidates)) expect(candidate.outcomeHint).toBeNull()
  })

  it('carries a missing ingredient source as null and a product with no form as null', async () => {
    const snapshot = snapshotOf([offer('NG', row('BARE', { ingredientsSourceUrl: null, evidenceUrls: [] }), { form: null })])

    const { skeleton } = await buildSkeleton(caseOf(), snapshot, { hintsShown: false })

    expect(skeleton.gaps.find((g) => g.step === 'moisturise')!.candidates[0]).toMatchObject({ code: 'BARE', form: null, ingredientsSourceUrl: null, evidenceUrls: [] })
  })
})

describe('buildSkeleton: the limits', () => {
  const ALLOWED = {
    cleanse: ['am', 'pm', 'am-pm'],
    treat: ['pm', 'alternate-days', 'weekly', 'am', 'am-pm'],
    moisturise: ['am', 'pm', 'am-pm'],
    protect: ['am'],
  }

  it('allows the frequencies the production routine rules allow', async () => {
    const { skeleton } = await build()

    expect(skeleton.limits.allowed).toEqual(ALLOWED)
  })

  it('exports that table as a constant', () => {
    expect(ROUTINE_ALLOWED_FREQUENCIES).toEqual(ALLOWED)
  })

  it('lets the writer buy as many new products as there are gaps with candidates', async () => {
    // Two gaps have candidates (cleanse, moisturise); treat and protect have none and are filled with "use what you have".
    const rows = [row('CLEANSER', { steps: ['cleanse'] }), row('CREAM-A'), row('CREAM-B')]

    const { skeleton } = await build(caseOf(), rows)

    expect(skeleton.gaps.filter((g) => g.candidates.length > 0).map((g) => g.step)).toEqual(['cleanse', 'moisturise'])
    expect(skeleton.limits.maxNewProducts).toBe(2)
  })

  it('allows no new products when no gap has a candidate', async () => {
    expect((await build()).skeleton.limits.maxNewProducts).toBe(0)
  })

  it('does not count a step the shelf fills', async () => {
    const c = caseOf({ shelf: [shelfProduct('cream', { step: 'moisturise' })] })

    const { skeleton } = await build(c, [row('CLEANSER', { steps: ['cleanse'] }), row('CREAM')])

    expect(skeleton.limits.maxNewProducts).toBe(1)
  })
})
