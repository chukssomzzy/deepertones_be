import { describe, expect, expectTypeOf, it } from 'vitest'
import { GOALS } from '../goals/goals.vocabulary'
import {
  CHANGE_VERSION,
  GOAL_CONCERNS_VERSION,
  SKIN_TYPE_VERSION,
  VISIBILITY_VERSION,
  WORDING,
  WORDING_VERSION,
  type ShownConcern,
  type SkinTypeLabel,
  bandFor,
  concernChange,
  concernsForGoal,
  hdActionsForGoal,
  isVisible,
  SHOWN_CONCERNS as EXPORTED_SHOWN_CONCERNS,
  SKIN_TYPE_LABELS,
  seenWords,
  skinAgeChange,
  skinAgeWords,
  skinTypeLabel,
} from './face-scans.tables'

// The face-scan rules: pure, versioned tables over what Perfect Corp measures (no I/O, no clock, no model), so the same results always
// give the same words. Nothing here is recomputed from the module's own tables: every expectation is a literal written from issue #112
// and its design notes. The exact words are the module's to choose; what is pinned is what they may never say.
//
// Perfect Corp scores run 1 to 100 and HIGHER IS HEALTHIER. Everything below reads `raw_score`, never `ui_score`.

// The 16 names on Perfect Corp's HD list.
const HD_NAMES = [
  'hd_wrinkle',
  'hd_droopy_upper_eyelid',
  'hd_droopy_lower_eyelid',
  'hd_firmness',
  'hd_acne',
  'hd_moisture',
  'hd_eye_bag',
  'hd_dark_circle',
  'hd_age_spot',
  'hd_radiance',
  'hd_redness',
  'hd_oiliness',
  'hd_pore',
  'hd_texture',
  'hd_tear_trough',
  'hd_skin_type',
]

// Written out from the issue, not read from the module.
const GOAL_CONCERNS = {
  'clear-skin': ['hd_acne', 'hd_pore', 'hd_oiliness'],
  'even-tone': ['hd_age_spot', 'hd_redness', 'hd_radiance'],
  'fade-dark-marks': ['hd_age_spot', 'hd_acne', 'hd_texture'],
  brighter: ['hd_radiance', 'hd_dark_circle', 'hd_age_spot'],
  glow: ['hd_radiance', 'hd_moisture', 'hd_texture'],
  'calm-repair': ['hd_redness', 'hd_moisture', 'hd_texture'],
} as const

/** Every concern some goal can show (hd_skin_type is read for the skin type, never shown as a concern). */
const SHOWN_CONCERNS = ['hd_acne', 'hd_pore', 'hd_oiliness', 'hd_age_spot', 'hd_redness', 'hd_radiance', 'hd_texture', 'hd_dark_circle', 'hd_moisture'] as const
const BANDS = ['a-little', 'some', 'clear'] as const

describe('the version constants', () => {
  it.each([
    ['GOAL_CONCERNS_VERSION', GOAL_CONCERNS_VERSION],
    ['VISIBILITY_VERSION', VISIBILITY_VERSION],
    ['WORDING_VERSION', WORDING_VERSION],
    ['SKIN_TYPE_VERSION', SKIN_TYPE_VERSION],
    ['CHANGE_VERSION', CHANGE_VERSION],
  ])('%s is 1, the number a result carries so a client can tell which rules wrote what it shows', (_name, version) => {
    expect(version).toBe(1)
  })
})

describe('goal to concerns', () => {
  it('has the six goals the vocabulary has, so the literal table below cannot fall behind it', () => {
    expect([...GOALS]).toEqual(Object.keys(GOAL_CONCERNS))
  })

  it.each([...GOALS])('gives %s exactly its three concerns, in order', (goal) => {
    expect(concernsForGoal(goal)).toEqual(GOAL_CONCERNS[goal])
  })

  it('covers every goal in the vocabulary and nothing else', () => {
    const table = Object.fromEntries(GOALS.map((goal) => [goal, concernsForGoal(goal)]))

    expect(table).toEqual(GOAL_CONCERNS)
  })

  it.each([...GOALS])('asks Perfect Corp for %s as its three concerns plus hd_skin_type: four actions, the 1 to 4 tier', (goal) => {
    const actions = hdActionsForGoal(goal)

    expect(actions).toEqual([...GOAL_CONCERNS[goal], 'hd_skin_type'])
    expect(actions).toHaveLength(4)
  })

  it.each([...GOALS])('uses only names on Perfect Corp\'s HD list for %s, every one prefixed hd_', (goal) => {
    for (const name of hdActionsForGoal(goal)) {
      expect(name.startsWith('hd_')).toBe(true)
      expect(HD_NAMES).toContain(name)
    }
  })

  it.each([...GOALS])('never repeats an action for %s', (goal) => {
    const actions = hdActionsForGoal(goal)

    expect(new Set(actions).size).toBe(actions.length)
  })

  // A string that is not a goal is refused with a throw, never answered with an empty or a default list: a typo must not quietly
  // cost a different analysis. The inherited names are the trap, since a plain object lookup finds them.
  it.each(['not-a-goal', '', 'Clear-Skin', 'toString', 'constructor', '__proto__', 'hasOwnProperty'])('refuses "%s", which is not a goal', (name) => {
    expect(() => concernsForGoal(name as never)).toThrow()
    expect(() => hdActionsForGoal(name as never)).toThrow()
  })

  it('hands out a fresh list each time, so a caller that edits one cannot change the next result', () => {
    const first = hdActionsForGoal('glow') as string[]
    first.push('hd_wrinkle')
    ;(concernsForGoal('glow') as string[]).length = 0

    expect(hdActionsForGoal('glow')).toEqual(['hd_radiance', 'hd_moisture', 'hd_texture', 'hd_skin_type'])
    expect(concernsForGoal('glow')).toEqual(['hd_radiance', 'hd_moisture', 'hd_texture'])
  })
})

// "To calibrate with real staging results": every threshold below is a starting value. A visible concern is one whose raw_score is AT
// OR BELOW its threshold (higher is healthier). Bands: a-little is (45, 60], some is (30, 45], clear is 30 or less.
describe('when a concern is visible, and how much', () => {
  it.each(SHOWN_CONCERNS)('treats %s as visible at exactly a raw_score of 60, the a-little band', (concern) => {
    expect(isVisible(concern, 60)).toBe(true)
    expect(bandFor(concern, 60)).toBe('a-little')
  })

  it.each(SHOWN_CONCERNS)('treats %s as not visible just above 60, with no band', (concern) => {
    expect(isVisible(concern, 60.1)).toBe(false)
    expect(bandFor(concern, 60.1)).toBeNull()
  })

  it.each([
    [100, null],
    [87.5, null],
    [60.1, null],
    [60, 'a-little'],
    [57.33, 'a-little'],
    [45.1, 'a-little'],
    [45, 'some'],
    [37.5, 'some'],
    [30.1, 'some'],
    [30, 'clear'],
    [29.9, 'clear'],
    [12, 'clear'],
    [1, 'clear'],
  ])('puts a raw_score of %s in band %s', (score, band) => {
    for (const concern of SHOWN_CONCERNS) {
      expect(bandFor(concern, score)).toBe(band)
      expect(isVisible(concern, score)).toBe(band !== null)
    }
  })

  it('gives every visible score exactly one of the three bands, and no band to a score that is not visible', () => {
    for (let score = 1; score <= 100; score += 0.5) {
      const band = bandFor('hd_redness', score)

      expect(band === null ? score > 60 : BANDS.includes(band)).toBe(true)
      expect(isVisible('hd_redness', score)).toBe(score <= 60)
    }
  })

  it('gives a clearer band as the score falls: a lower score never gives a fainter band', () => {
    const rank = (band: string | null) => (band === null ? 0 : BANDS.indexOf(band as (typeof BANDS)[number]) + 1)
    let last = 0
    for (let score = 100; score >= 1; score -= 0.5) {
      const now = rank(bandFor('hd_pore', score))
      expect(now).toBeGreaterThanOrEqual(last)
      last = now
    }
  })
})

describe('seen-words wording', () => {
  // Names a condition, speaks to the person as having something, or talks about lightness. Case-insensitive.
  const BANNED: [string, RegExp][] = [
    ['acne vulgaris', /acne vulgaris/i],
    ['melasma', /melasma/i],
    ['rosacea', /rosacea/i],
    ['eczema', /eczema/i],
    ['dermatitis', /dermatitis/i],
    ['psoriasis', /psoriasis/i],
    ['hyperpigmentation disorder', /hyperpigmentation disorder/i],
    ['you have', /you have/i],
    ['diagnos', /diagnos/i],
    ['disease', /disease/i],
    ['condition', /condition/i],
    ['lighter', /lighter/i],
    ['lighten', /lighten/i],
    ['fairer', /fairer/i],
    ['whiter', /whiter/i],
    ['bleach', /bleach/i],
    // Words that judge the skin or talk about its colour. "Less glow" says what can be seen; "dull" grades it.
    ['dull', /\bdull/i],
    ['bright', /\bbright/i],
    ['fair', /\bfair\b/i],
    ['pale', /\bpale\b/i],
    ['hyperpigment', /hyperpigment/i],
    ['pigmentation disorder', /pigmentation disorder/i],
    // "acne" is the concern's own name. The words say "spots" or "breakouts" instead, which is what can be seen.
    ['acne', /\bacne\b/i],
    // Never a score or a number: Amara's face is not graded.
    ['a digit', /\d/],
    ['score', /score/i],
  ]
  const MAX_LENGTH = 80

  /** Every text the table holds: each shown concern, each band, each region it names. */
  const allTexts = () =>
    Object.entries(WORDING).flatMap(([concern, bands]) =>
      Object.entries(bands).flatMap(([band, regions]) =>
        Object.entries(regions as Record<string, string>).map(([region, text]) => ({ concern, band, region, text })),
      ),
    )

  it('has a ban list that catches what it is meant to (so a typo in it cannot pass everything)', () => {
    const caught = (text: string) => BANNED.filter(([, pattern]) => pattern.test(text)).map(([name]) => name)

    expect(caught('You HAVE Melasma')).toEqual(expect.arrayContaining(['melasma', 'you have']))
    expect(caught('Some acne on your cheeks')).toEqual(['acne'])
    expect(caught('Skin looks LIGHTER')).toEqual(['lighter'])
    expect(caught('A Dull patch')).toEqual(['dull'])
    expect(caught('Skin looks brighter')).toEqual(['bright'])
    expect(caught('Fair skin, pale skin')).toEqual(['fair', 'pale'])
    expect(caught('Some hyperpigmentation')).toEqual(['hyperpigment'])
    expect(caught('A pigmentation disorder')).toEqual(['pigmentation disorder'])
    expect(caught('A fairly even tone')).toEqual([])
    expect(caught('Some spots on your cheeks')).toEqual([])
  })

  it.each(SHOWN_CONCERNS)('has text for %s in every band', (concern) => {
    for (const band of BANDS) {
      expect(WORDING[concern]?.[band], `${concern} / ${band}`).toBeDefined()
    }
  })

  it.each(SHOWN_CONCERNS)('has a whole-face fallback for %s in every band', (concern) => {
    for (const band of BANDS) {
      expect(WORDING[concern]![band]!.whole, `${concern} / ${band}`).toEqual(expect.any(String))
      expect(WORDING[concern]![band]!.whole.trim(), `${concern} / ${band}`).not.toBe('')
    }
  })

  it('gives every goal concern text (reading the goals, not only the literal list)', () => {
    for (const goal of GOALS) {
      for (const concern of concernsForGoal(goal)) {
        for (const band of BANDS) expect(seenWords(concern, band, 'whole'), `${goal} / ${concern} / ${band}`).toEqual(expect.any(String))
      }
    }
  })

  it('answers a region the table has no words for with the whole-face text', () => {
    for (const concern of SHOWN_CONCERNS) {
      for (const band of BANDS) {
        expect(seenWords(concern, band, 'not-a-region')).toBe(WORDING[concern]![band]!.whole)
        expect(seenWords(concern, band, 'whole')).toBe(WORDING[concern]![band]!.whole)
      }
    }
  })

  it('answers a region the table does have words for with those words', () => {
    for (const { concern, band, region, text } of allTexts()) {
      expect(seenWords(concern as never, band as never, region)).toBe(text)
    }
  })

  it('names no condition, never says "you have", never talks of lightness, never says "acne", and carries no number: in any text the table holds', () => {
    const texts = allTexts()
    expect(texts.length).toBeGreaterThanOrEqual(SHOWN_CONCERNS.length * BANDS.length)

    for (const { concern, band, region, text } of texts) {
      for (const [name, pattern] of BANNED) {
        expect(pattern.test(text), `"${text}" (${concern} / ${band} / ${region}) must not contain ${name}`).toBe(false)
      }
    }
  })

  it('is plain and calm: short, non-empty, and with no exclamation mark, in any text the table holds', () => {
    for (const { concern, band, region, text } of allTexts()) {
      const where = `"${text}" (${concern} / ${band} / ${region})`
      expect(text.trim().length, where).toBeGreaterThan(0)
      expect(text.length, where).toBeLessThanOrEqual(MAX_LENGTH)
      expect(text, where).not.toMatch(/!/)
    }
  })

  it('holds no text for a concern that no goal shows (hd_skin_type is the skin type label, not a seen-words concern)', () => {
    expect(Object.keys(WORDING).sort()).toEqual([...SHOWN_CONCERNS].sort())
  })

  it('gives the same words every time for the same input', () => {
    for (const concern of SHOWN_CONCERNS) {
      for (const band of BANDS) {
        expect(seenWords(concern, band, 'whole')).toBe(seenWords(concern, band, 'whole'))
      }
    }
  })

  it('says something different for each band of a concern, so a clearer mark reads as clearer', () => {
    for (const concern of SHOWN_CONCERNS) {
      const texts = BANDS.map((band) => seenWords(concern, band, 'whole'))

      expect(new Set(texts).size, concern).toBe(BANDS.length)
    }
  })
})

describe('skin type label', () => {
  const whole = (skinType: string | undefined) => [{ region: 'whole', skinType: skinType as string }]

  it.each([
    ['Combination', 'combination'],
    ['Oily', 'oily'],
    ['Dry', 'dry'],
    ['Normal', 'normal'],
  ])('reads "%s" as %s', (skinType, label) => {
    expect(skinTypeLabel(whole(skinType))).toBe(label)
  })

  it.each([
    ['Dry & Redness', 'dry'],
    ['Oily and Redness', 'oily'],
    ['Combination & Redness', 'combination'],
    ['Dry and Redness', 'dry'],
    ['Oily & Redness', 'oily'],
    ['Combination and Redness', 'combination'],
  ])('drops the Redness part of "%s": %s', (skinType, label) => {
    expect(skinTypeLabel(whole(skinType))).toBe(label)
  })

  it('reads plain "Redness" as normal', () => {
    expect(skinTypeLabel(whole('Redness'))).toBe('normal')
  })

  it.each([
    ['DRY', 'dry'],
    ['dry', 'dry'],
    ['oily', 'oily'],
    ['COMBINATION', 'combination'],
    ['nOrMaL', 'normal'],
    ['REDNESS', 'normal'],
    ['dry & redness', 'dry'],
    ['DRY AND REDNESS', 'dry'],
    ['Oily AND redness', 'oily'],
    ['combination & REDNESS', 'combination'],
  ])('ignores casing: "%s" is %s', (skinType, label) => {
    expect(skinTypeLabel(whole(skinType))).toBe(label)
  })

  it('ignores spaces around the text', () => {
    expect(skinTypeLabel(whole('  Dry & Redness '))).toBe('dry')
  })

  it.each(['Sensitive', 'Oily and Dry', '', '   ', 'Normal & Sensitive'])('gives null for "%s", which is not a type it knows', (skinType) => {
    expect(skinTypeLabel(whole(skinType))).toBeNull()
  })

  it('gives null when there is nothing to read', () => {
    expect(skinTypeLabel([])).toBeNull()
    expect(skinTypeLabel(whole(undefined))).toBeNull()
    expect(skinTypeLabel([{ region: 'whole' } as never])).toBeNull()
  })

  it('reads the whole-face item and ignores the t_zone and u_zone items', () => {
    const items = [
      { region: 't_zone', skinType: 'Oily' },
      { region: 'u_zone', skinType: 'Dry' },
      { region: 'whole', skinType: 'Combination' },
    ]

    expect(skinTypeLabel(items)).toBe('combination')
    expect(skinTypeLabel([...items].reverse())).toBe('combination')
  })

  it('gives null when only the zones are present, rather than guessing a whole-face type from them', () => {
    expect(
      skinTypeLabel([
        { region: 't_zone', skinType: 'Oily' },
        { region: 'u_zone', skinType: 'Dry' },
      ]),
    ).toBeNull()
  })
})

// Higher raw_score is healthier, so a RISE is "fainter". A change counts only when it is bigger than the noise: 5 points for a
// concern, 2 years for skin age (to calibrate). A change of exactly the noise is still noise.
describe('change since day one', () => {
  describe('a goal concern', () => {
    it.each([
      // [baseline, current, result]
      [50, 55, 'no clear change'], // exactly +5
      [55, 50, 'no clear change'], // exactly -5
      [50.5, 55.5, 'no clear change'],
      [50, 55.01, 'fainter'], // just past +5
      [50, 45, 'no clear change'], // exactly -5 again, from a whole number
      [50, 45.01, 'no clear change'], // just inside -5
      [50, 44.99, 'more visible'], // just past -5
      [50, 44.5, 'more visible'], // -5.5
      [50, 55.5, 'fainter'], // +5.5
      [50, 60, 'fainter'],
      [50, 40, 'more visible'],
      [50, 50, 'no clear change'],
      [50, 52, 'no clear change'],
      [50, 48, 'no clear change'],
    ])('reads a raw_score of %s then %s as "%s"', (baseline, current, expected) => {
      expect(concernChange(baseline, current)).toBe(expected)
    })

    it('reads a fall of just over 5 as more visible, and a rise of just over 5 as fainter', () => {
      expect(concernChange(55, 49.99)).toBe('more visible')
      expect(concernChange(50, 55.01)).toBe('fainter')
    })

    it('says fainter for a higher score, because a higher score is healthier', () => {
      expect(concernChange(40, 70)).toBe('fainter')
      expect(concernChange(70, 40)).toBe('more visible')
    })

    it('depends on the change only, not on where in the range it happens', () => {
      expect(concernChange(10, 15)).toBe('no clear change')
      expect(concernChange(10, 15.5)).toBe('fainter')
      expect(concernChange(90, 85)).toBe('no clear change')
      expect(concernChange(90, 84.5)).toBe('more visible')
    })
  })

  describe('skin age', () => {
    it.each([
      // [baseline, current, result]
      [30, 28, 'no clear change'], // exactly -2
      [30, 32, 'no clear change'], // exactly +2
      [30, 27, 'younger'], // -3
      [30, 33, 'older'], // +3
      [30, 27.5, 'younger'], // -2.5
      [30, 32.5, 'older'], // +2.5
      [30, 30, 'no clear change'],
      [30, 29, 'no clear change'],
      [30, 31, 'no clear change'],
      [41, 35, 'younger'],
      [35, 41, 'older'],
    ])('reads a skin age of %s then %s as "%s"', (baseline, current, expected) => {
      expect(skinAgeChange(baseline, current)).toBe(expected)
    })
  })

  it('never says lighter or darker, whatever the numbers: every answer is one of the fixed phrases', () => {
    const concernWords = new Set<string>()
    const ageWords = new Set<string>()
    for (let baseline = 1; baseline <= 100; baseline += 3.5) {
      for (let current = 1; current <= 100; current += 2.5) concernWords.add(concernChange(baseline, current))
    }
    for (let baseline = 15; baseline <= 80; baseline += 1.5) {
      for (let current = 15; current <= 80; current += 1) ageWords.add(skinAgeChange(baseline, current))
    }

    expect([...concernWords].sort()).toEqual(['fainter', 'more visible', 'no clear change'])
    expect([...ageWords].sort()).toEqual(['no clear change', 'older', 'younger'])
    for (const word of [...concernWords, ...ageWords]) expect(word).not.toMatch(/lighter|darker|light|dark|fairer|whiter/i)
  })
})

describe('skin age wording', () => {
  it('states the skin age as a plain fact', () => {
    expect(skinAgeWords(29)).toBe('Your skin looks about 29')
  })

  it('rounds to a whole number, half up: 28.49 is 28 and 28.5 is 29', () => {
    expect(skinAgeWords(28.49)).toBe('Your skin looks about 28')
    expect(skinAgeWords(28.5)).toBe('Your skin looks about 29')
    expect(skinAgeWords(29.4)).toBe('Your skin looks about 29')
    expect(skinAgeWords(29.51)).toBe('Your skin looks about 30')
  })

  it('shows only a whole number, never a decimal', () => {
    for (let age = 16; age <= 85; age += 0.37) {
      expect(skinAgeWords(age)).toMatch(/^[^.\d]*\d+[^.\d]*$/)
    }
  })

  it('takes the skin age alone: it has no real age to compare with, so it never compares', () => {
    expect(skinAgeWords.length).toBe(1)
  })

  it('never judges: no old, older, younger, young, "than", and no mention of the person\'s own age, at any age', () => {
    for (let age = 14; age <= 90; age += 1) {
      const text = skinAgeWords(age)

      expect(text, text).not.toMatch(/\bold\b|older|younger|\byoung\b|young for|older than|than|your age|real age|actual|years/i)
      expect(text, text).not.toMatch(/!/)
      expect(text.length).toBeLessThanOrEqual(80)
    }
  })

  it('names no condition and talks of no lightness', () => {
    expect(skinAgeWords(29)).not.toMatch(/you have|diagnos|disease|condition|lighter|fairer|whiter/i)
  })

  it('gives the same words every time for the same age', () => {
    expect(skinAgeWords(41)).toBe(skinAgeWords(41))
  })
})

// The recommendation catalog (spec #115) is written in these two vocabularies, so they are runtime lists here and the types come from them.
describe('the shown concerns and skin type labels as runtime lists', () => {
  it('lists the nine concerns a goal can show, by their Perfect Corp names', () => {
    // SHOWN_CONCERNS above is this file's own literal list, so the exported one is compared with an independent source.
    expect([...EXPORTED_SHOWN_CONCERNS].sort()).toEqual([...SHOWN_CONCERNS].sort())
    expect(new Set(EXPORTED_SHOWN_CONCERNS).size).toBe(EXPORTED_SHOWN_CONCERNS.length)
  })

  it('holds every concern any goal shows, so a goal can never show one the catalog cannot name', () => {
    for (const goal of GOALS) for (const concern of concernsForGoal(goal)) expect(EXPORTED_SHOWN_CONCERNS, `${goal}: ${concern}`).toContain(concern)
  })

  it('lists the four skin type labels', () => {
    expect([...SKIN_TYPE_LABELS]).toEqual(['oily', 'dry', 'combination', 'normal'])
  })

  it('is the same set as the types, so a label added to one list is added to the other', () => {
    expectTypeOf<(typeof EXPORTED_SHOWN_CONCERNS)[number]>().toEqualTypeOf<ShownConcern>()
    expectTypeOf<(typeof SKIN_TYPE_LABELS)[number]>().toEqualTypeOf<SkinTypeLabel>()
  })

  it('reads every label the skin type table can produce from this list', () => {
    for (const label of SKIN_TYPE_LABELS) expect(skinTypeLabel([{ region: 'whole', skinType: label }]), label).toBe(label)
  })
})
