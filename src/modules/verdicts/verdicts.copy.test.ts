import { describe, expect, it } from 'vitest'
import { clashReason, floorReason } from './verdicts.copy'
import type { FloorEntry, FloorFact, FloorGroup } from './verdicts.floor'

// The words of a floor-decided verdict (spec #171): one plain sentence for each kind of fact, about the PRODUCT and never the person, worked out by fixed rules
// and never by a model. Tone rules are CONTEXT.md's: no "you are / you have", no scores, never lightness, and an ingredient or phrase named from the fact.
//
// Shapes assumed (the contract this file pins):
//   floorReason(entry, choices?) => string, where `entry` is a fixed floor entry and `choices` the profile's safety choices (default none).
//   An ingredient-group or banned-substance fact carries `ruleName`, the rule's canonical ingredient name, and the reason names that rather than the raw label
//   string (a long label such as "Ethylhexyl Methoxycinnamate/Hydroquinone" must never hide the flagged ingredient). A reaction-ingredient reason names the
//   user's own word (`named`), not the label's.
//   clashReason([groupA, groupB]) => string, the words for the one product of a clashing pair that is reduced to alternate days.
// "Lightening" is a word the copy MAY use (it names a claim phrase or says what a product is sold for); "lighter" and "lightness" it may not (CONTEXT: "lighter
// after" is the thing the product exists to undo). The guard-rail below is therefore on those two words, not on "light".

type Fixed = Extract<FloorEntry, { status: 'fixed' }>

const PRESCRIBER_NOTE = 'If a doctor prescribed this, keep following their instructions.'

const fixed = (group: FloorGroup, verdict: Fixed['verdict'], facts: FloorFact[], escalate = false): Fixed => ({ id: 'entry-1', status: 'fixed', group, verdict, escalate, facts })

const entryNamed = (name: string): Fixed => {
  const found = CASES.find((candidate) => candidate.name === name)
  if (!found) throw new Error(`no case ${name}`)
  return found.entry
}

const stop = { kind: 'stop', taperTemplateId: 'TPR-ANY-1' } as const
const drop = { kind: 'drop' } as const

// One entry of every kind the floor makes, with the words each must carry.
type Case = { name: string; entry: Fixed; names: RegExp[]; says: RegExp[] }
const CASES: Case[] = [
  {
    name: 'mercury',
    entry: fixed('likely-the-problem', drop, [{ kind: 'ingredient-group', group: 'mercury', ingredient: 'Mercuric Chloride', ruleName: 'mercury' }], true),
    names: [/mercury/i],
    says: [/\bstop\b/i, /\b(now|at once|straight away)\b/i, /professional/i],
  },
  {
    name: 'a steroid',
    entry: fixed('likely-the-problem', stop, [{ kind: 'ingredient-group', group: 'steroid', ingredient: 'Clobetasol Propionate', ruleName: 'Clobetasol Propionate' }]),
    names: [/Clobetasol Propionate/i],
    says: [/all at once|suddenly|gradual|step(ped)?[- ]down|step it down/i],
  },
  {
    name: 'a steroid named with its strength on the label',
    entry: fixed('likely-the-problem', stop, [{ kind: 'ingredient-group', group: 'steroid', ingredient: 'Clobetasol Propionate 0.05%', ruleName: 'clobetasol propionate' }]),
    names: [/clobetasol propionate/i],
    says: [/all at once|suddenly|gradual|step(ped)?[- ]down|step it down/i],
  },
  {
    name: 'a lightening agent',
    entry: fixed('likely-the-problem', stop, [{ kind: 'ingredient-group', group: 'lightening-agent', ingredient: 'Hydroquinone', ruleName: 'Hydroquinone' }]),
    names: [/Hydroquinone/i],
    says: [/all at once|suddenly|gradual|step(ped)?[- ]down|step it down/i],
  },
  {
    name: 'a lightening claim phrase',
    entry: fixed('likely-the-problem', stop, [{ kind: 'claim-phrase', phrase: 'whitening' }]),
    names: [/whitening/i],
    says: [/all at once|suddenly|gradual|step(ped)?[- ]down|step it down/i],
  },
  {
    name: 'a no-label cream described as for lightening',
    entry: fixed('likely-the-problem', stop, [{ kind: 'no-label-purpose', purpose: 'lighten' }]),
    names: [/lighten/i],
    says: [/all at once|suddenly|gradual|step(ped)?[- ]down|step it down/i],
  },
  {
    name: 'a banned ingredient that belongs to no group',
    entry: fixed('likely-the-problem', drop, [{ kind: 'banned-substance', ingredient: 'Zzyzx Musk', ruleName: 'zzyzx musk' }]),
    names: [/zzyzx musk/i],
    says: [/\bstop\b/i, /not allowed|banned|prohibited/i],
  },
  {
    name: 'the product the user reacted to',
    entry: fixed('likely-the-problem', drop, [{ kind: 'reaction-product' }]),
    names: [],
    says: [/\bstop\b/i, /react/i],
  },
  {
    name: 'an ingredient the user reacted to',
    entry: fixed('conflicting', drop, [{ kind: 'reaction-ingredient', ingredient: 'Parfum', named: 'fragrance' }]),
    // The user's own word, not the label's.
    names: [/fragrance/],
    says: [/react/i],
  },
  {
    name: 'a pregnancy caution',
    entry: fixed('conflicting', drop, [{ kind: 'pregnancy-caution', ingredient: 'Retinol' }]),
    names: [/Retinol/],
    says: [/pregnan|breastfeed/i],
  },
  {
    name: 'a product it cannot read',
    entry: fixed('cant-tell', drop, [{ kind: 'unknown-contents' }]),
    names: [],
    says: [/back/i, /label/i, /photo/i],
  },
  {
    name: 'a prescribed product',
    entry: fixed('prescribed', { kind: 'keep' }, [{ kind: 'prescription' }]),
    names: [],
    says: [/prescriber/i, /\bkeep\b/i],
  },
]

describe('floorReason', () => {
  describe.each(CASES)('for $name', ({ entry, names, says }) => {
    it('names what the fact names, and says what to do', () => {
      const reason = floorReason(entry)
      for (const pattern of names) expect(reason).toMatch(pattern)
      for (const pattern of says) expect(reason).toMatch(pattern)
    })

    it('is one plain sentence of at most 200 characters, the same every time', () => {
      const reason = floorReason(entry)
      expect(reason.length).toBeGreaterThan(0)
      expect(reason.length).toBeLessThanOrEqual(200)
      expect(reason.trim().split(/(?<=[.!?])\s+/)).toHaveLength(1)
      expect(reason).toBe(floorReason(entry))
    })

    it('is about the product and not the person: no "you are", "you\'re", "you have" or "you\'ve", no score, and never "lighter" or "lightness"', () => {
      const reason = floorReason(entry)
      expect(reason).not.toMatch(/\byou(\s+are|'re|\s+have|'ve)\b/i)
      // A strength on a label (0.05%, 2%) is a fact about the product and may be named; a score or a grade of anyone is not.
      expect(reason).not.toMatch(/\b\d+\s*(\/\s*\d+|out of|points?)\b/i)
      expect(reason).not.toMatch(/\bscore\b/i)
      expect(reason).not.toMatch(/\blight(er|ness)\b/i)
    })
  })

  describe('a step-down and a stop at once', () => {
    it('never tells the user to stop a step-down product now or at once, while mercury, which has no step-down, says to stop now', () => {
      for (const name of ['a steroid', 'a lightening agent', 'a lightening claim phrase', 'a no-label cream described as for lightening']) {
        expect(floorReason(entryNamed(name)), name).not.toMatch(/\bstop\b( using)?( it| this)?\s+(now|at once|straight away|immediately)\b/i)
      }
      expect(floorReason(entryNamed('mercury'))).toMatch(/\bstop\b[^.]*\b(now|at once|straight away|immediately)\b/i)
    })

    it('names the first fact when a product holds several', () => {
      const reason = floorReason(
        fixed('likely-the-problem', stop, [
          { kind: 'ingredient-group', group: 'lightening-agent', ingredient: 'Hydroquinone', ruleName: 'Hydroquinone' },
          { kind: 'claim-phrase', phrase: 'whitening' },
        ]),
      )

      expect(reason).toMatch(/Hydroquinone/)
    })
  })

  describe('the words for each kind of fact', () => {
    it('names the rule\'s canonical ingredient for an ingredient group, so a long label never hides the flagged ingredient', () => {
      const LABEL = 'Ethylhexyl Methoxycinnamate/Hydroquinone'
      expect(LABEL.length).toBeGreaterThanOrEqual(40)

      const reason = floorReason(fixed('likely-the-problem', stop, [{ kind: 'ingredient-group', group: 'lightening-agent', ingredient: LABEL, ruleName: 'Hydroquinone' }]))

      expect(reason.toLowerCase()).toContain('hydroquinone')
      expect(reason).not.toContain('Ethylhexyl')
    })

    it.each([
      ['mercury', 'mercury', 'Mercurius Solubilis Complex Of Cosmetic Grade Bases'],
      ['steroid', 'clobetasol propionate', 'Clobetasol Propionate Micronised Powder 0.05% In A Cream Base'],
    ] as const)('names the rule\'s canonical ingredient for %s, not the label it was found in', (group, ruleName, label) => {
      const verdict = group === 'mercury' ? drop : stop

      const reason = floorReason(fixed('likely-the-problem', verdict, [{ kind: 'ingredient-group', group, ingredient: label, ruleName }], group === 'mercury'))

      expect(reason.toLowerCase()).toContain(ruleName)
      expect(reason).not.toContain(label)
    })

    it('names the rule\'s canonical ingredient for a banned substance, so a long label never hides it', () => {
      const LABEL = 'Ethylhexyl Methoxycinnamate/Zzyzx Musk Fragrance Base'

      const reason = floorReason(fixed('likely-the-problem', drop, [{ kind: 'banned-substance', ingredient: LABEL, ruleName: 'zzyzx musk' }]))

      expect(reason.toLowerCase()).toContain('zzyzx musk')
      expect(reason).not.toContain('Ethylhexyl')
    })

    it('names the user\'s own word for an ingredient they reacted to, and not the label\'s word', () => {
      const reason = floorReason(fixed('conflicting', drop, [{ kind: 'reaction-ingredient', ingredient: 'Parfum', named: 'fragrance' }]))

      expect(reason).toContain('fragrance')
      expect(reason).not.toContain('Parfum')
    })

    it('does not say flatly that a banned substance is "banned in cosmetics": it is not allowed in cosmetics in many countries', () => {
      const reason = floorReason(entryNamed('a banned ingredient that belongs to no group'))

      expect(reason).not.toMatch(/\bis banned in cosmetics\b/i)
      expect(reason).toMatch(/many (countries|places)/i)
      expect(reason).toMatch(/not allowed/i)
    })
  })

  // The whole reason, note included, is at most 200 characters whatever length a name or phrase from a label or from the user has.
  describe('at its limit of 200 characters', () => {
    const WITH = ['pregnant', 'prescription'] as const
    const long = (length: number, word = 'Zorbex') => `${word} `.repeat(Math.ceil(length / (word.length + 1))).slice(0, length).trim()
    const LENGTHS = [40, 100] as const

    type Build = (text: string) => Fixed
    // A fact built around a name or phrase of the given length, for every kind of fact that holds one. `canonical` is the rule name that must survive whole.
    const WITH_TEXT: { name: string; build: Build; canonical?: string }[] = [
      { name: 'mercury', build: (t) => fixed('likely-the-problem', drop, [{ kind: 'ingredient-group', group: 'mercury', ingredient: t, ruleName: 'mercury' }], true), canonical: 'mercury' },
      { name: 'a steroid', build: (t) => fixed('likely-the-problem', stop, [{ kind: 'ingredient-group', group: 'steroid', ingredient: t, ruleName: 'clobetasol propionate' }]), canonical: 'clobetasol propionate' },
      { name: 'a lightening agent', build: (t) => fixed('likely-the-problem', stop, [{ kind: 'ingredient-group', group: 'lightening-agent', ingredient: t, ruleName: 'hydroquinone' }]), canonical: 'hydroquinone' },
      { name: 'a banned ingredient', build: (t) => fixed('likely-the-problem', drop, [{ kind: 'banned-substance', ingredient: t, ruleName: 'zzyzx musk' }]), canonical: 'zzyzx musk' },
      { name: 'a claim phrase', build: (t) => fixed('likely-the-problem', stop, [{ kind: 'claim-phrase', phrase: t }]) },
      { name: 'an ingredient reacted to', build: (t) => fixed('conflicting', drop, [{ kind: 'reaction-ingredient', ingredient: 'Parfum', named: t }]) },
      { name: 'a pregnancy caution', build: (t) => fixed('conflicting', drop, [{ kind: 'pregnancy-caution', ingredient: t }]) },
    ]

    describe.each(WITH_TEXT)('for $name', ({ build, canonical }) => {
      it.each(LENGTHS)('keeps the reason within 200 characters for a name of %i characters, with and without the prescriber note', (length) => {
        const text = long(length)
        expect(text.length).toBe(length)

        for (const choices of [[], ['pregnant'], WITH] as const) {
          const reason = floorReason(build(text), choices)
          expect(reason.length, `${choices.join('+')}: ${reason}`).toBeLessThanOrEqual(200)
          expect(reason.trim().split(/(?<=[.!?])\s+/).length).toBe(reason.includes(PRESCRIBER_NOTE) ? 2 : 1)
          if (canonical) expect(reason.toLowerCase()).toContain(canonical)
          // A name that was cut still starts the reason's name, so the reader can tell what it was.
          else expect(reason).toContain(text.slice(0, 15))
        }
      })
    })

    it.each(LENGTHS)('keeps the reason for the lightening step-down within 200 characters with a long canonical name (a rule name of 24 characters) beside a label of %i characters', (length) => {
      const reason = floorReason(
        fixed('likely-the-problem', stop, [{ kind: 'ingredient-group', group: 'lightening-agent', ingredient: long(length), ruleName: 'methylhydroquinone ether' }]),
        WITH,
      )

      expect(reason.length).toBeLessThanOrEqual(200)
      expect(reason.toLowerCase()).toContain('methylhydroquinone ether')
      expect(reason).toContain(PRESCRIBER_NOTE)
    })
  })

  describe('when the profile ticked "I use a prescription"', () => {
    const WITH = ['pregnant', 'prescription'] as const

    // The note is for a step-down or a set-aside, where the product could be the user's own prescribed cream (the floor cannot match a no-label tub or an
    // unreadable list to a prescription). Where the product is known to be dangerous or unwanted whoever prescribed it, the note would soften the stop.
    const NOTED: [string, Fixed][] = [
      ['a steroid step-down', entryNamed('a steroid')],
      ['a steroid named with its strength', entryNamed('a steroid named with its strength on the label')],
      ['a lightening-agent step-down', entryNamed('a lightening agent')],
      ['a lightening claim phrase step-down', entryNamed('a lightening claim phrase')],
      ['a no-label cream described as for lightening', entryNamed('a no-label cream described as for lightening')],
      ['a product it cannot read', entryNamed('a product it cannot read')],
    ]
    const NEVER_NOTED: [string, Fixed][] = [
      ['mercury', entryNamed('mercury')],
      ['a banned ingredient', entryNamed('a banned ingredient that belongs to no group')],
      ['the product reacted to', entryNamed('the product the user reacted to')],
      ['an ingredient reacted to', entryNamed('an ingredient the user reacted to')],
      ['a pregnancy caution', entryNamed('a pregnancy caution')],
      ['a prescribed product, whose reason already says to keep following the prescriber', entryNamed('a prescribed product')],
    ]

    it.each(NOTED)('adds the prescriber note after the reason for %s, and the whole is still at most 200 characters', (_name, entry) => {
      const plain = floorReason(entry, ['pregnant'])
      const withNote = floorReason(entry, WITH)

      expect(withNote).toBe(`${plain} ${PRESCRIBER_NOTE}`)
      expect(withNote.length).toBeLessThanOrEqual(200)
    })

    it.each(NEVER_NOTED)('never adds the prescriber note to %s', (_name, entry) => {
      const withRx = floorReason(entry, WITH)

      expect(withRx).toBe(floorReason(entry, ['pregnant']))
      expect(withRx).toBe(floorReason(entry))
      expect(withRx).not.toContain(PRESCRIBER_NOTE)
    })

    it('adds nothing when prescription is not among the choices, and nothing when there are no choices', () => {
      for (const [, entry] of NOTED) {
        expect(floorReason(entry, ['reaction'])).toBe(floorReason(entry))
        expect(floorReason(entry, [])).toBe(floorReason(entry))
        expect(floorReason(entry)).not.toContain(PRESCRIBER_NOTE)
      }
    })
  })
})

describe('clashReason', () => {
  it('says the product is best used on alternate days because it works against another, naming both kinds of ingredient', () => {
    const reason = clashReason(['retinoid', 'exfoliating-acid'])

    expect(reason).toMatch(/alternate days/i)
    expect(reason).toMatch(/retinoid/i)
    expect(reason).toMatch(/exfoliating acid/i)
  })

  it('is one plain sentence of at most 200 characters and about the product, whichever pair of groups it is', () => {
    for (const groups of [['retinoid', 'exfoliating-acid'], ['exfoliating-acid', 'retinoid'], ['retinoid', 'benzoyl-peroxide'], ['benzoyl-peroxide', 'exfoliating-acid']] as const) {
      const reason = clashReason([...groups])

      expect(reason.length).toBeLessThanOrEqual(200)
      expect(reason.trim().split(/(?<=[.!?])\s+/)).toHaveLength(1)
      expect(reason).not.toMatch(/\byou(\s+are|'re|\s+have|'ve)\b/i)
      expect(reason).not.toMatch(/\blight(er|ness)\b/i)
    }
  })
})
