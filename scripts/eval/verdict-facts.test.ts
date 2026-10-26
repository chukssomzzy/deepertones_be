import { describe, expect, it } from 'vitest'
import { assembleVerdictInputs } from '../../src/modules/verdicts/verdicts.inputs'
import { floorVerdicts, type FloorEntry, type FloorResult } from '../../src/modules/verdicts/verdicts.floor'
import type { VerdictCase, ExpectedFloor } from './verdict-cases'
import { caseOf, FIXTURE, FIXTURE_CASES, FIXTURE_FITTER, FIXTURE_REFERENCE, noLabel, product } from './verdict.fixture'
import { factsOf } from './verdict-facts'

// factsOf turns a case into the exact facts a real build reads (VerdictFacts), so the eval runs the REAL assembly and the REAL rules floor on it and never a copy
// of either. These tests pin both halves: the shape of the facts (the ids, the maps and the safety rows the accessors would have loaded) and, by running the real
// assembleVerdictInputs and floorVerdicts over one fixture case of each kind, that each kind ends where the rules say it does. The expected values below are
// worked out by hand from the fixture reference's rules (see verdict.fixture.ts), not computed by the code under test.

const factsFor = (c: VerdictCase) => factsOf(c, FIXTURE_REFERENCE, FIXTURE_FITTER)

/** The floor for a case, through the same two functions a build uses. */
const floorFor = (c: VerdictCase): FloorResult => floorVerdicts(assembleVerdictInputs(factsFor(c)).floorInput)

const entryFor = (floor: FloorResult, id: string): FloorEntry => {
  const found = floor.entries.find((entry) => entry.id === id)
  if (!found) throw new Error(`The floor has no entry ${id}: it has ${floor.entries.map((e) => e.id).join(', ') || 'none'}`)
  return found
}

describe('factsOf: the facts a build reads', () => {
  const shelfCase = caseOf('main-01', {
    goal: 'glow',
    scan: { skinType: 'dry', concerns: [{ concern: 'hd_radiance', band: 'some' }, { concern: 'hd_moisture', band: 'clear' }] },
    shelf: [
      product('first', { brand: 'Zenvi', name: 'First Cream', variant: 'Night', form: 'cream', ingredients: ['Aqua', 'Glycerin'], steps: ['cleanse', 'treat'] }),
      noLabel('jar', 'treat-spots'),
      product('third', { brand: 'Quillon', name: 'Third Gel', form: 'gel', category: 'body', ingredients: ['Aqua'], steps: [] }),
    ],
  })

  it('passes the reference, the goal, the scan and the fit judge\'s identity through unchanged', () => {
    const facts = factsFor(shelfCase)

    expect(facts.reference).toBe(FIXTURE_REFERENCE)
    expect(facts.goal).toBe('glow')
    expect(facts.scan).toEqual(shelfCase.scan)
    expect(facts.fitter).toEqual(FIXTURE_FITTER)
  })

  it('has no scan when the case has none', () => {
    expect(factsFor(caseOf('main-01')).scan).toBeNull()
  })

  it('makes one shelf entry per case entry, in shelf order, each called by the case\'s id for it', () => {
    const { entries } = factsFor(shelfCase)

    expect(entries.map((e) => [e.id, e.kind])).toEqual([
      ['first', 'product'],
      ['jar', 'no-label'],
      ['third', 'product'],
    ])
  })

  it('gives the entries strictly ascending added times, so the shelf order is the order the shelf lists them', () => {
    const times = factsFor(shelfCase).entries.map((e) => e.addedAt.getTime())

    expect(times.every((time, at) => at === 0 || time > times[at - 1]!)).toBe(true)
  })

  it('gives every product its own product id and formulation id, and each no-label item its own item id', () => {
    const { entries } = factsFor(caseOf('main-01', { shelf: [product('a', { name: 'A' }), product('b', { name: 'B' }), noLabel('c', 'lighten'), noLabel('d', 'lighten')] }))
    const products = entries.flatMap((e) => (e.kind === 'product' ? [e] : []))
    const items = entries.flatMap((e) => (e.kind === 'no-label' ? [e] : []))

    expect(new Set(products.map((p) => p.productId)).size).toBe(2)
    expect(new Set(products.map((p) => p.formulationId)).size).toBe(2)
    expect(new Set(items.map((i) => i.itemId)).size).toBe(2)
  })

  it('gives each product\'s facts under its formulation id: who it is, its catalog product id and its ingredient list', () => {
    const facts = factsFor(shelfCase)
    const first = facts.entries.find((e) => e.id === 'first')!
    if (first.kind !== 'product') throw new Error('first is a product')

    expect(facts.shelfFacts.get(first.formulationId)).toEqual({
      productId: first.productId,
      brand: 'Zenvi',
      name: 'First Cream',
      variant: 'Night',
      form: 'cream',
      category: 'skin',
      ingredients: ['Aqua', 'Glycerin'],
    })
  })

  it('keeps the category of a product that is not for the skin', () => {
    const facts = factsFor(shelfCase)
    const third = facts.entries.find((e) => e.id === 'third')!
    if (third.kind !== 'product') throw new Error('third is a product')

    expect(facts.shelfFacts.get(third.formulationId)?.category).toBe('body')
  })

  it('gives a no-label item\'s purpose under its item id, as a skin item', () => {
    const facts = factsFor(shelfCase)
    const jar = facts.entries.find((e) => e.id === 'jar')!
    if (jar.kind !== 'no-label') throw new Error('jar is a no-label item')

    expect(facts.noLabelFacts.get(jar.itemId)).toEqual({ purpose: 'treat-spots', category: 'skin' })
  })

  it('gives each product\'s routine steps under its catalog product id, in the order the case lists them', () => {
    const facts = factsFor(shelfCase)
    const first = facts.entries.find((e) => e.id === 'first')!
    if (first.kind !== 'product') throw new Error('first is a product')

    expect(facts.steps.get(first.productId)).toEqual(['cleanse', 'treat'])
  })

  it('gives the same facts every time it is asked, and leaves the case as it was', () => {
    const before = structuredClone(shelfCase)

    expect(factsFor(shelfCase)).toEqual(factsFor(shelfCase))
    expect(shelfCase).toEqual(before)
  })

  describe('the pregnancy flag, as the safety service derives it from the ticked choices', () => {
    it.each([
      [['pregnant'], true],
      [['breastfeeding'], true],
      [['pregnant', 'reaction'], true],
      [['breastfeeding', 'prescription'], true],
      [['reaction'], false],
      [['prescription'], false],
      [['reaction', 'prescription'], false],
      [['none'], false],
    ] as const)('is %j -> excludes the pregnancy caution: %s', (choices, excludes) => {
      const view = factsFor(caseOf('main-01', { safety: { choices: [...choices], mentions: [] } })).safety.view

      expect(view?.excludesPregnancyCaution).toBe(excludes)
      expect(view?.choices).toEqual(choices)
    })
  })

  describe('the safety mentions, as the rows the parse saves', () => {
    const mentionCase = caseOf('main-01', {
      safety: {
        choices: ['reaction', 'prescription'],
        mentions: [
          { source: 'reaction', kind: 'product', name: 'First Cream', resolvesTo: 'first' },
          { source: 'prescription', kind: 'product', name: 'Some Gel I Lost', resolvesTo: null },
          { source: 'reaction', kind: 'ingredient', name: 'fragrance', resolvesTo: null },
          { source: 'prescription', kind: 'ingredient', name: 'tretinoin', resolvesTo: null },
        ],
      },
      shelf: [product('first', { brand: 'Zenvi', name: 'First Cream', ingredients: ['Aqua', 'Squalane'] })],
    })

    it('keeps each mention\'s source, kind and name, in the order the case lists them', () => {
      const { mentions } = factsFor(mentionCase).safety

      expect(mentions.map((m) => [m.source, m.kind, m.name])).toEqual([
        ['reaction', 'product', 'First Cream'],
        ['prescription', 'product', 'Some Gel I Lost'],
        ['reaction', 'ingredient', 'fragrance'],
        ['prescription', 'ingredient', 'tretinoin'],
      ])
    })

    it('points a resolved product mention at the catalog product id of the entry it resolves to, and marks it resolved', () => {
      const facts = factsFor(mentionCase)
      const first = facts.entries.find((e) => e.id === 'first')!
      if (first.kind !== 'product') throw new Error('first is a product')

      expect(facts.safety.mentions[0]).toMatchObject({ productId: first.productId, resolution: 'resolved' })
    })

    it('leaves a product mention that resolves to nothing without a product id, marked unresolved', () => {
      expect(factsOf(mentionCase, FIXTURE_REFERENCE, FIXTURE_FITTER).safety.mentions[1]).toMatchObject({ productId: null, resolution: 'unresolved' })
    })

    it('gives an ingredient mention no product id and no resolution', () => {
      const { mentions } = factsFor(mentionCase).safety

      expect(mentions[2]).toMatchObject({ productId: null, resolution: null })
      expect(mentions[3]).toMatchObject({ productId: null, resolution: null })
    })

    it('gives the resolved product\'s ingredient list under its catalog product id, and nothing for a product that resolved to nothing', () => {
      const facts = factsFor(mentionCase)
      const first = facts.entries.find((e) => e.id === 'first')!
      if (first.kind !== 'product') throw new Error('first is a product')

      expect(facts.mentionIngredients.get(first.productId)).toEqual(['Aqua', 'Squalane'])
      expect(facts.mentionIngredients.size).toBe(1)
    })

    it('has no mentions when the case names none', () => {
      expect(factsFor(caseOf('main-01')).safety.mentions).toEqual([])
    })
  })
})

// --- the real assembly and the real floor ---------------------------------------------------------------------------------------------------------------

describe('factsOf through the real assembleVerdictInputs and floorVerdicts', () => {
  it('drops a product with a mercury ingredient at once and escalates: likely the problem, with a professional to see', () => {
    const floor = floorFor(FIXTURE.mercury)

    expect(entryFor(floor, 'mercury-cream')).toMatchObject({ status: 'fixed', group: 'likely-the-problem', verdict: { kind: 'drop' }, escalate: true })
  })

  it('steps a steroid down with the approved steroid template', () => {
    const floor = floorFor(FIXTURE.steroid)

    expect(entryFor(floor, 'steroid-gel')).toMatchObject({ status: 'fixed', group: 'likely-the-problem', verdict: { kind: 'stop', taperTemplateId: 'TPR-STEROID-1' }, escalate: false })
  })

  it('steps hydroquinone down with the approved lightening template, though the label writes a strength after it', () => {
    const floor = floorFor(FIXTURE.hydroquinone)

    expect(entryFor(floor, 'spot-cream')).toMatchObject({ status: 'fixed', group: 'likely-the-problem', verdict: { kind: 'stop', taperTemplateId: 'TPR-LIGHTENING-1' } })
  })

  it('steps down a product whose only fault is a lightening claim in its name', () => {
    const floor = floorFor(FIXTURE.claimWord)

    expect(entryFor(floor, 'claim-lotion')).toMatchObject({ status: 'fixed', group: 'likely-the-problem', verdict: { kind: 'stop', taperTemplateId: 'TPR-LIGHTENING-1' }, facts: [{ kind: 'claim-phrase', phrase: 'whitening' }] })
  })

  it('steps down a jar with no label that the person uses to lighten', () => {
    const floor = floorFor(FIXTURE.noLabelLighten)

    expect(entryFor(floor, 'jar-lighten')).toMatchObject({ status: 'fixed', group: 'likely-the-problem', verdict: { kind: 'stop', taperTemplateId: 'TPR-LIGHTENING-1' } })
  })

  it('sets aside a jar with no label used for anything else: it cannot be told', () => {
    const floor = floorFor(FIXTURE.noLabelOther)

    expect(entryFor(floor, 'jar-other')).toMatchObject({ status: 'fixed', group: 'cant-tell', verdict: { kind: 'drop' } })
  })

  it('sets aside a product with an empty ingredient list instead of leaving it open', () => {
    const floor = floorFor(FIXTURE.emptyIngredients)

    expect(entryFor(floor, 'empty-tube')).toMatchObject({ status: 'fixed', group: 'cant-tell', verdict: { kind: 'drop' } })
  })

  it('drops a banned ingredient that belongs to no group, without escalating', () => {
    const floor = floorFor(FIXTURE.bannedNoGroup)

    expect(entryFor(floor, 'banned-balm')).toMatchObject({ status: 'fixed', group: 'likely-the-problem', verdict: { kind: 'drop' }, escalate: false })
  })

  it('drops the shelf product the person reacted to, and leaves the other product open', () => {
    const floor = floorFor(FIXTURE.reactionProduct)

    expect(entryFor(floor, 'calm-cream')).toMatchObject({ status: 'fixed', group: 'likely-the-problem', verdict: { kind: 'drop' }, facts: [{ kind: 'reaction-product' }] })
    expect(entryFor(floor, 'other-cream')).toEqual({ id: 'other-cream', status: 'open' })
  })

  it('holds nothing against a product when the person\'s reaction product did not resolve to anything on the shelf', () => {
    const floor = floorFor(FIXTURE.unresolvedMention)

    expect(entryFor(floor, 'fine-cream')).toEqual({ id: 'fine-cream', status: 'open' })
  })

  it('makes a product that lists an ingredient the person reacted to conflict, and leaves one that does not open', () => {
    const floor = floorFor(FIXTURE.reactionIngredient)

    expect(entryFor(floor, 'scented-wash')).toMatchObject({ status: 'fixed', group: 'conflicting', verdict: { kind: 'drop' }, facts: [{ kind: 'reaction-ingredient', ingredient: 'Parfum', named: 'fragrance' }] })
    expect(entryFor(floor, 'plain-wash')).toEqual({ id: 'plain-wash', status: 'open' })
  })

  it('drops a retinol product for a pregnant person', () => {
    const floor = floorFor(FIXTURE.pregnancyRetinol)

    expect(entryFor(floor, 'night-serum')).toMatchObject({ status: 'fixed', group: 'conflicting', verdict: { kind: 'drop' }, facts: [{ kind: 'pregnancy-caution', ingredient: 'Retinol' }] })
  })

  it.each([
    ['pregnant', true],
    ['breastfeeding', true],
    ['reaction', false],
    ['none', false],
  ] as const)('judges the same retinol product by the ticked choice %s: a pregnancy caution applies %s', (choice, applies) => {
    const floor = floorFor({ ...FIXTURE.pregnancyRetinol, safety: { choices: [choice], mentions: [] } })

    if (applies) expect(entryFor(floor, 'night-serum')).toMatchObject({ status: 'fixed', group: 'conflicting' })
    else expect(entryFor(floor, 'night-serum')).toEqual({ id: 'night-serum', status: 'open' })
  })

  it('keeps a steroid the person is prescribed, and does not stop it', () => {
    const floor = floorFor(FIXTURE.prescribedSteroid)

    expect(entryFor(floor, 'rx-gel')).toMatchObject({ status: 'fixed', group: 'prescribed', verdict: { kind: 'keep' }, facts: [{ kind: 'prescription' }] })
  })

  it('stops the very same steroid when the person does not say it is prescribed', () => {
    const floor = floorFor({ ...FIXTURE.prescribedSteroid, safety: { choices: ['none'], mentions: [] } })

    expect(entryFor(floor, 'rx-gel')).toMatchObject({ status: 'fixed', group: 'likely-the-problem', verdict: { kind: 'stop', taperTemplateId: 'TPR-STEROID-1' } })
  })

  it('does not answer for a product that is not for the skin, and judges the skin product beside it', () => {
    const floor = floorFor(FIXTURE.nonSkin)

    expect(floor.entries.map((e) => e.id)).toEqual(['face-cream'])
  })

  it('reports a retinoid and an exfoliating acid as a clash when both stay open, in shelf order', () => {
    const floor = floorFor(FIXTURE.retinoidAcidClash)

    expect(floor.entries.map((e) => e.status)).toEqual(['open', 'open'])
    expect(floor.clashes).toHaveLength(1)
    expect(floor.clashes[0]).toMatchObject({ ids: ['retinol-serum', 'acid-toner'], groups: ['retinoid', 'exfoliating-acid'], fallbackReduceId: 'acid-toner' })
  })

  it('reports no clash for the same two products when the person is pregnant, because the retinol product is dropped and so is out of the pair', () => {
    const floor = floorFor({ ...FIXTURE.retinoidAcidClash, safety: { choices: ['pregnant'], mentions: [] } })

    expect(entryFor(floor, 'retinol-serum')).toMatchObject({ status: 'fixed', group: 'conflicting' })
    expect(entryFor(floor, 'acid-toner')).toEqual({ id: 'acid-toner', status: 'open' })
    expect(floor.clashes).toEqual([])
  })

  it('refers to a step-down by the approved template code of the reference it was given, not by one of its own', () => {
    const reference = { ...FIXTURE_REFERENCE, tapers: { steroid: 'TPR-OTHER-9', 'lightening-agent': 'TPR-OTHER-8' } }

    const floor = floorVerdicts(assembleVerdictInputs(factsOf(FIXTURE.steroid, reference, FIXTURE_FITTER)).floorInput)

    expect(entryFor(floor, 'steroid-gel')).toMatchObject({ verdict: { kind: 'stop', taperTemplateId: 'TPR-OTHER-9' } })
  })
})

// --- the cases' own expectations ----------------------------------------------------------------------------------------------------------------------

// Each fixture case carries what a person would expect of its floor (the shape the real cases use). This reads the floor back into that shape and checks the two
// agree, so a case written like the fixtures is known to say what the rules do. The reading is the test's own: scoring a run is a later module's job.

const expectedOf = (entry: FloorEntry, tapers: Record<string, string>): ExpectedFloor => {
  if (entry.status === 'open') return { outcome: 'open' }
  if (entry.status === 'taper-missing') throw new Error(`${entry.id} needs a ${entry.missingTaper} template and the reference has none`)
  const { verdict } = entry
  const taper = verdict.kind === 'stop' ? Object.keys(tapers).find((kind) => tapers[kind] === verdict.taperTemplateId) : undefined
  return {
    outcome: 'fixed',
    group: entry.group,
    verdict: verdict.kind,
    ...(taper === undefined ? {} : { taper: taper as 'steroid' | 'lightening-agent' }),
    ...(entry.escalate ? { escalate: true as const } : {}),
  }
}

describe('the fixture cases\' expectations', () => {
  it.each(FIXTURE_CASES.map((c) => [c.id, c] as const))('%s: the real floor agrees with what the case expects of each skin entry and of the clashes', (_id, c) => {
    const floor = floorFor(c)

    const got = Object.fromEntries(floor.entries.map((entry) => [entry.id, expectedOf(entry, FIXTURE_REFERENCE.tapers)]))
    const wanted = Object.fromEntries(Object.entries(c.expect.entries).filter(([, expected]) => expected.outcome !== 'ignored'))
    expect(got).toEqual(wanted)
    expect(floor.clashes.map((clash) => [...clash.ids].sort())).toEqual(c.expect.clashes.map((pair) => [...pair].sort()))
  })

  it('expects "ignored" of exactly the entries the floor does not answer for', () => {
    const ignored = FIXTURE_CASES.flatMap((c) => Object.entries(c.expect.entries).filter(([, expected]) => expected.outcome === 'ignored').map(([id]) => `${c.id}/${id}`))

    expect(ignored).toEqual(['hold-02/edge-pomade'])
  })
})
