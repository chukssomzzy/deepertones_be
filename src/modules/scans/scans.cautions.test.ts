import { afterEach, describe, expect, it, vi } from 'vitest'
import { hasLink, hasMarkup } from '../../lib/text-safety'
import { MAX_WHO_LENGTH, MAX_WHY_LENGTH } from '../catalog/catalog.analysis'
import { CONCERN_KINDS, SEVERITIES, TRAITS } from '../catalog/catalog.vocabulary'
import { CAUTION_RULES_VERSION, cautionFor } from './scans.cautions'

// The caution for an item with no label to read: a pure table of rules over the three answers the user gives. Nothing here is
// recomputed from the module's own tables; every expectation is a literal written from the rules in issue #55.
//
// The concerns are checked against the analysis path's vocabulary and size limits directly, not through checkAnalysis: that
// function drops a concern that names nothing on a label, and an item with no label has none to name.

const SOURCES = ['market-vendor', 'pharmacy', 'online', 'gift', 'not-sure'] as const
const PURPOSES = ['lighten', 'moisturise', 'treat-spots', 'not-sure'] as const
const USED_FOR = ['under-1-month', '1-6-months', '6-months-2-years', 'over-2-years'] as const

type Source = (typeof SOURCES)[number]
type Purpose = (typeof PURPOSES)[number]
type UsedFor = (typeof USED_FOR)[number]
type Answers = { source: Source; purpose: Purpose; usedFor: UsedFor }

const LONG_USE: readonly UsedFor[] = ['6-months-2-years', 'over-2-years']
const STRONG_SOURCES: readonly Source[] = ['market-vendor', 'not-sure']
const WEAK_SOURCES: readonly Source[] = ['pharmacy', 'online', 'gift']

/** The kinds, in order, a set of answers must give: the substances first, then long use, then the general caution last. */
const expectedKinds = ({ purpose, usedFor }: Answers): string[] => [
  ...(purpose === 'lighten' ? ['banned-substance'] : []),
  ...((purpose === 'lighten' || purpose === 'treat-spots') && LONG_USE.includes(usedFor) ? ['hyperpigmentation-risk'] : []),
  'irritation',
]

const MATRIX: Answers[] = SOURCES.flatMap((source) => PURPOSES.flatMap((purpose) => USED_FOR.map((usedFor) => ({ source, purpose, usedFor }))))
const label = (a: Answers) => `${a.source} / ${a.purpose} / ${a.usedFor}`
const MATRIX_CASES = MATRIX.map((answers) => [label(answers), answers] as const)

const textOf = (concerns: ReturnType<typeof cautionFor>) => concerns.map((c) => `${c.why} ${c.whoShouldTakeCare} ${c.ingredients.join(' ')}`).join(' ')
const answers = (over: Partial<Answers> = {}): Answers => ({ source: 'pharmacy', purpose: 'moisturise', usedFor: 'under-1-month', ...over })

afterEach(() => vi.useRealTimers())

describe('CAUTION_RULES_VERSION', () => {
  it('is 1, the number an item view carries so a client can tell which rules wrote a caution', () => {
    expect(CAUTION_RULES_VERSION).toBe(1)
  })
})

describe('cautionFor: which concerns, in which order', () => {
  it.each(MATRIX_CASES)('gives the expected kinds in a fixed order for %s', (_label, a) => {
    expect(cautionFor(a).map((c) => c.kind)).toEqual(expectedKinds(a))
  })

  it('puts the general caution last and the substances first, whatever else is added', () => {
    const concerns = cautionFor(answers({ source: 'market-vendor', purpose: 'lighten', usedFor: 'over-2-years' }))

    expect(concerns.map((c) => [c.kind, c.severity])).toEqual([
      ['banned-substance', 'high'],
      ['hyperpigmentation-risk', 'medium'],
      ['irritation', 'medium'],
    ])
  })

  it('gives only the general caution to a product used to moisturise, even for over 2 years', () => {
    expect(cautionFor(answers({ purpose: 'moisturise', usedFor: 'over-2-years' })).map((c) => c.kind)).toEqual(['irritation'])
  })

  it('gives only the general caution when the purpose is not known, even for over 2 years', () => {
    expect(cautionFor(answers({ purpose: 'not-sure', usedFor: 'over-2-years' })).map((c) => c.kind)).toEqual(['irritation'])
  })
})

describe('cautionFor: a product used to lighten the skin', () => {
  it.each(SOURCES)('warns of a banned substance, high severity, from %s', (source) => {
    const [first] = cautionFor(answers({ source, purpose: 'lighten' }))

    expect(first).toMatchObject({ kind: 'banned-substance', severity: 'high' })
  })

  it.each(SOURCES)('names mercury, hydroquinone and corticosteroids, from %s', (source) => {
    const [first] = cautionFor(answers({ source, purpose: 'lighten' }))
    const text = textOf([first!]).toLowerCase()

    expect(text).toContain('mercury')
    expect(text).toContain('hydroquinone')
    expect(text).toMatch(/corticosteroid|steroid/)
  })

  it('does not warn of those substances for a product used for anything else', () => {
    for (const purpose of ['moisturise', 'treat-spots', 'not-sure'] as const) {
      const concerns = cautionFor(answers({ purpose, source: 'market-vendor', usedFor: 'over-2-years' }))

      expect(concerns.map((c) => c.kind), purpose).not.toContain('banned-substance')
      expect(textOf(concerns).toLowerCase(), purpose).not.toContain('mercury')
    }
  })

  describe('the wording is stronger from a market vendor or when the source is not known', () => {
    const first = (source: Source) => cautionFor(answers({ source, purpose: 'lighten' }))[0]!

    it('uses one text for a market vendor and for not knowing the source', () => {
      expect(first('not-sure')).toEqual(first('market-vendor'))
    })

    it('uses one, other text for a pharmacy, an online shop and a gift', () => {
      expect(first('online')).toEqual(first('pharmacy'))
      expect(first('gift')).toEqual(first('pharmacy'))
    })

    it('makes the two texts differ', () => {
      expect(first('market-vendor').why).not.toBe(first('pharmacy').why)
    })

    it.each(STRONG_SOURCES)('uses the stronger text for %s, which the weaker sources never get', (source) => {
      for (const weak of WEAK_SOURCES) expect(first(source).why).not.toBe(first(weak).why)
    })

    it('keeps the same kind and severity in both, so only the wording changes', () => {
      expect(first('market-vendor')).toMatchObject({ kind: first('pharmacy').kind, severity: first('pharmacy').severity })
    })
  })
})

describe('cautionFor: long use', () => {
  const longUseConcern = (a: Answers) => cautionFor(a).find((c) => c.kind === 'hyperpigmentation-risk')

  it.each(
    (['lighten', 'treat-spots'] as const).flatMap((purpose) =>
      LONG_USE.map((usedFor) => [`${purpose} for ${usedFor}`, answers({ purpose, usedFor, source: 'online' })] as const),
    ),
  )('adds a skin-thinning concern for %s', (_label, a) => {
    const concern = longUseConcern(a)

    expect(concern).toMatchObject({ severity: 'medium' })
    expect(`${concern!.why} ${concern!.whoShouldTakeCare}`).toMatch(/thin/i)
  })

  it.each(
    (['lighten', 'treat-spots'] as const).flatMap((purpose) =>
      (['under-1-month', '1-6-months'] as const).map((usedFor) => [`${purpose} for ${usedFor}`, answers({ purpose, usedFor })] as const),
    ),
  )('adds no long-use concern for %s: 6 months is the boundary', (_label, a) => {
    expect(longUseConcern(a)).toBeUndefined()
  })

  it('does not add the long-use concern for moisturising or an unknown purpose, however long', () => {
    for (const purpose of ['moisturise', 'not-sure'] as const) {
      expect(longUseConcern(answers({ purpose, usedFor: 'over-2-years' })), purpose).toBeUndefined()
    }
  })
})

describe('cautionFor: the general caution', () => {
  it.each(MATRIX_CASES)('is always the last concern, for %s: contents unknown, patch-test, treat with caution', (_label, a) => {
    const concerns = cautionFor(a)
    const last = concerns.at(-1)!

    expect(last).toMatchObject({ kind: 'irritation', severity: 'medium' })
    const text = `${last.why} ${last.whoShouldTakeCare}`
    expect(text).toMatch(/unknown/i)
    expect(text).toMatch(/patch/i)
    expect(text).toMatch(/caution/i)
  })
})

describe('cautionFor: every concern is one the analysis path would accept', () => {
  it.each(MATRIX_CASES)('has a known kind, severity and traits, and clean text of an allowed length, for %s', (_label, a) => {
    const concerns = cautionFor(a)

    expect(concerns.length).toBeGreaterThan(0)
    for (const concern of concerns) {
      expect(CONCERN_KINDS).toContain(concern.kind)
      expect(SEVERITIES).toContain(concern.severity)
      for (const trait of concern.traits) expect(TRAITS).toContain(trait)
      expect(Array.isArray(concern.ingredients)).toBe(true)
      expect(Array.isArray(concern.sources)).toBe(true)
      for (const source of concern.sources) expect(source).toMatch(/^https:\/\//)
      for (const [text, max] of [[concern.why, MAX_WHY_LENGTH], [concern.whoShouldTakeCare, MAX_WHO_LENGTH]] as const) {
        expect(text.trim()).not.toBe('')
        expect(text.length).toBeLessThanOrEqual(max)
        expect(hasLink(text)).toBe(false)
        expect(hasMarkup(text)).toBe(false)
      }
    }
  })

  it.each(MATRIX_CASES)('is about the product, never blaming the user, for %s', (_label, a) => {
    expect(textOf(cautionFor(a))).not.toMatch(/you should have|should have known|your fault|you were (?:wrong|careless|foolish)|you shouldn'?t have/i)
  })
})

describe('cautionFor: deterministic and pure', () => {
  it.each(MATRIX_CASES)('gives deep-equal output for the same answers twice, for %s', (_label, a) => {
    expect(cautionFor({ ...a })).toEqual(cautionFor({ ...a }))
  })

  it('ignores a description if one is passed along: it never changes, or appears in, the caution', () => {
    const base = answers({ purpose: 'lighten', source: 'market-vendor', usedFor: 'over-2-years' })
    const withDescription = { ...base, description: 'bought it from <b>Mama Ngozi</b> at https://evil.example' }

    const concerns = cautionFor(withDescription)

    expect(concerns).toEqual(cautionFor(base))
    expect(JSON.stringify(concerns)).not.toContain('Mama Ngozi')
  })

  it('does not read the clock', () => {
    const a = answers({ purpose: 'lighten', source: 'gift', usedFor: '6-months-2-years' })
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2001-01-01T00:00:00Z'))
    const early = cautionFor(a)
    vi.setSystemTime(new Date('2099-12-31T23:59:59Z'))

    expect(cautionFor(a)).toEqual(early)
  })

  it('does not change the answers it is given', () => {
    const a = answers({ purpose: 'lighten' })
    const copy = { ...a }

    cautionFor(a)

    expect(a).toEqual(copy)
  })

  it('hands out its own arrays each time, so a caller editing one result cannot change the next', () => {
    const a = answers({ purpose: 'lighten', usedFor: 'over-2-years' })
    const first = cautionFor(a)
    const reference = structuredClone(first)

    first[0]!.why = 'edited'
    first[0]!.ingredients.push('edited')
    first[0]!.traits.push('edited')
    first.pop()

    expect(cautionFor(a)).toEqual(reference)
  })
})
