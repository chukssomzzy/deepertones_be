import { describe, expect, expectTypeOf, it } from 'vitest'
import { GOALS, type Goal } from '../goals/goals.vocabulary'
import {
  CHANGE_VERSION,
  CHASE_VERSION,
  CONCERN_IDS,
  GOAL_CONCERNS_VERSION,
  NEXT_GOAL_VERSION,
  NOTHING_STANDS_OUT,
  RESUME_DAYS,
  REVIEW_VERSION,
  REVIEW_WEEKS,
  SKIN_TYPE_VERSION,
  TABLES_VERSION,
  VISIBILITY_VERSION,
  WORDING,
  WORDING_VERSION,
  type ShownConcern,
  type SkinTypeLabel,
  bandFor,
  changeWords,
  chaseStartFor,
  concernChange,
  concernsForGoal,
  hdActionsForCheckIn,
  hdActionsForGoal,
  isVisible,
  measuredConcernsForGoal,
  nextGoalFor,
  resultView,
  reviewPointFor,
  SHOWN_CONCERNS as EXPORTED_SHOWN_CONCERNS,
  SKIN_TYPE_LABELS,
  seenWords,
  skinAgeChange,
  skinAgeChangeWords,
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

// Written out from the brief: the goal's own three, then the core concerns (age spot, acne, pore, oiliness) the goal lacks, in that order.
const MEASURED = {
  'clear-skin': ['hd_acne', 'hd_pore', 'hd_oiliness', 'hd_age_spot'],
  'even-tone': ['hd_age_spot', 'hd_redness', 'hd_radiance', 'hd_acne', 'hd_pore', 'hd_oiliness'],
  'fade-dark-marks': ['hd_age_spot', 'hd_acne', 'hd_texture', 'hd_pore', 'hd_oiliness'],
  brighter: ['hd_radiance', 'hd_dark_circle', 'hd_age_spot', 'hd_acne', 'hd_pore', 'hd_oiliness'],
  glow: ['hd_radiance', 'hd_moisture', 'hd_texture', 'hd_age_spot', 'hd_acne', 'hd_pore', 'hd_oiliness'],
  'calm-repair': ['hd_redness', 'hd_moisture', 'hd_texture', 'hd_age_spot', 'hd_acne', 'hd_pore', 'hd_oiliness'],
} as const

/** Every concern some goal can show (hd_skin_type is read for the skin type, never shown as a concern). */
const SHOWN_CONCERNS = ['hd_acne', 'hd_pore', 'hd_oiliness', 'hd_age_spot', 'hd_redness', 'hd_radiance', 'hd_texture', 'hd_dark_circle', 'hd_moisture'] as const
const BANDS = ['a-little', 'some', 'clear'] as const
/** A score above the visible cut-off: not claimed to be clearly there. */
const FAINT = 'faint'

// Written out from the brief: the whole-face words for a faint concern.
const FAINT_WORDS = [
  ['hd_acne', 'Hardly any spots'],
  ['hd_pore', 'Hardly any open pores'],
  ['hd_oiliness', 'Hardly any shine'],
  ['hd_age_spot', 'Hardly any dark marks'],
  ['hd_redness', 'Hardly any redness'],
  ['hd_radiance', 'An even glow across the face'],
  ['hd_texture', 'Skin looks smooth'],
  ['hd_dark_circle', 'Hardly any darkness under the eyes'],
  ['hd_moisture', 'Hardly any dry patches'],
] as const

describe('the version constants', () => {
  it.each([
    ['GOAL_CONCERNS_VERSION', GOAL_CONCERNS_VERSION, 2],
    ['VISIBILITY_VERSION', VISIBILITY_VERSION, 3],
    ['WORDING_VERSION', WORDING_VERSION, 2],
    ['SKIN_TYPE_VERSION', SKIN_TYPE_VERSION, 1],
    ['CHANGE_VERSION', CHANGE_VERSION, 1],
    ['CHASE_VERSION', CHASE_VERSION, 1],
    ['REVIEW_VERSION', REVIEW_VERSION, 1],
    ['NEXT_GOAL_VERSION', NEXT_GOAL_VERSION, 1],
  ])('%s is %s, the number a result carries so a client can tell which rules wrote what it shows', (_name, version, expected) => {
    expect(version).toBe(expected)
  })

  // Visibility v3 gives each concern its own cut-offs (v2 showed every goal concern with one shared set) and wording v2 adds the faint words.
  // Concerns v2 measures the core set on every scan. The chase rule and the review weeks (issue #145) join the others, so a stored result says
  // which resume window worked out its day one and which review weeks were in force.
  it('puts every version in TABLES_VERSION, with concerns:2, visibility:3 and wording:2, then the chase rule, the review weeks and the next-goal rule last', () => {
    expect(TABLES_VERSION).toBe('concerns:2,visibility:3,wording:2,skin-type:1,change:1,chase:1,review:1,next-goal:1')
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

  it.each([...GOALS])('asks Perfect Corp for %s as everything measured plus hd_skin_type: 5 to 8 actions, the 16-unit tier', (goal) => {
    const actions = hdActionsForGoal(goal)

    expect(actions).toEqual([...MEASURED[goal], 'hd_skin_type'])
    expect(actions.length).toBeGreaterThanOrEqual(5)
    expect(actions.length).toBeLessThanOrEqual(8)
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

    expect(hdActionsForGoal('glow')).toEqual([...MEASURED.glow, 'hd_skin_type'])
    expect(concernsForGoal('glow')).toEqual(['hd_radiance', 'hd_moisture', 'hd_texture'])
    ;(measuredConcernsForGoal('glow') as string[]).length = 0
    expect(measuredConcernsForGoal('glow')).toEqual(MEASURED.glow)
  })
})

// The check-in scan, taken at a goal's review point, looks a little wider than a normal one: behind the scenes it reads every concern the app can
// ever show, so the next-goal rule has something to read, even though the result still shows only the goal's own three (issue #145). Ten actions,
// the 9 to 12 tier, against the four of a normal scan. Written out from the issue, never read from the module.
describe('what a check-in scan asks Perfect Corp for', () => {
  const CHECK_IN_ACTIONS = [...SHOWN_CONCERNS, 'hd_skin_type']

  it('asks for all nine concerns the app can show, plus the skin type: ten actions, the 9 to 12 tier', () => {
    expect(hdActionsForCheckIn()).toEqual(CHECK_IN_ACTIONS)
    expect(hdActionsForCheckIn()).toHaveLength(10)
  })

  it('asks for no name that is not on Perfect Corp\'s HD list, and never repeats one', () => {
    const actions = hdActionsForCheckIn()

    for (const name of actions) {
      expect(name.startsWith('hd_')).toBe(true)
      expect(HD_NAMES).toContain(name)
    }
    expect(new Set(actions).size).toBe(actions.length)
  })

  it('covers what every goal asks for, so one check-in can be read for whichever goal it was taken under', () => {
    for (const goal of GOALS) {
      for (const action of hdActionsForGoal(goal)) expect(hdActionsForCheckIn()).toContain(action)
    }
  })

  it('asks for more than a normal scan does, which is what the extra units pay for', () => {
    expect(hdActionsForCheckIn().length).toBeGreaterThan(hdActionsForGoal('glow').length)
  })

  it('hands out a fresh list each time, so a caller that edits one cannot change the next scan\'s actions', () => {
    const first = hdActionsForCheckIn() as string[]
    first.push('hd_wrinkle')
    first.length = 0

    expect(hdActionsForCheckIn()).toEqual(CHECK_IN_ACTIONS)
  })
})

describe('the concerns measured for a goal', () => {
  it.each([...GOALS])('measures %s as its own three, in goal order, then the core concerns it lacks, in core order', (goal) => {
    expect(measuredConcernsForGoal(goal)).toEqual(MEASURED[goal])
  })

  it.each([...GOALS])('measures 4 to 7 concerns for %s, none twice, and starts with the goal\'s own', (goal) => {
    const measured = measuredConcernsForGoal(goal)

    expect(measured.length).toBeGreaterThanOrEqual(4)
    expect(measured.length).toBeLessThanOrEqual(7)
    expect(new Set(measured).size).toBe(measured.length)
    expect(measured.slice(0, 3)).toEqual(GOAL_CONCERNS[goal])
  })

  it.each([...GOALS])('always measures the four core concerns for %s', (goal) => {
    expect(measuredConcernsForGoal(goal)).toEqual(expect.arrayContaining(['hd_age_spot', 'hd_acne', 'hd_pore', 'hd_oiliness']))
  })

  it.each(['not-a-goal', '', 'toString', '__proto__'])('refuses "%s", which is not a goal', (name) => {
    expect(() => measuredConcernsForGoal(name as never)).toThrow()
  })
})

// Visibility v3: each concern has its own cut-offs (calibrated on 40 photos, a first pass; see face-scans.tables.ts). A visible concern is one whose
// raw_score is AT OR BELOW its `visible` cut-off (higher is healthier). Bands: a-little is (some, visible], some is (clear, some], clear is `clear` or
// less. Above `visible` is `faint`: still a band, so it is shown, but worded as hardly there and never claimed to be clearly seen.
// Written out from the brief, not read from the table.
const CUT_OFFS = {
  hd_acne: { visible: 68, some: 60, clear: 55 },
  hd_age_spot: { visible: 86, some: 81, clear: 76 },
  hd_pore: { visible: 60, some: 43, clear: 25 },
  hd_oiliness: { visible: 82, some: 72, clear: 62 },
  hd_redness: { visible: 95, some: 80, clear: 65 },
  hd_radiance: { visible: 75, some: 68, clear: 62 },
  hd_texture: { visible: 40, some: 30, clear: 20 },
  hd_dark_circle: { visible: 60, some: 54, clear: 48 },
  hd_moisture: { visible: 33, some: 30, clear: 28 },
} as const

describe('when a concern is visible, and how much', () => {
  it('has cut-offs written out here for exactly the nine shown concerns', () => {
    expect(Object.keys(CUT_OFFS).sort()).toEqual([...SHOWN_CONCERNS].sort())
  })

  it.each(SHOWN_CONCERNS)('orders the cut-offs of %s strictly: visible above some above clear', (concern) => {
    const { visible, some, clear } = CUT_OFFS[concern]
    expect(visible).toBeGreaterThan(some)
    expect(some).toBeGreaterThan(clear)
    expect(clear).toBeGreaterThan(0)
  })

  // Each cut-off is inclusive: a score equal to it is in that band, and 0.1 more is the next fainter band.
  it.each(SHOWN_CONCERNS)('puts %s in the band of its own cut-offs at every boundary, and above visible in faint', (concern) => {
    const { visible, some, clear } = CUT_OFFS[concern]

    expect(bandFor(concern, clear)).toBe('clear')
    expect(bandFor(concern, clear + 0.1)).toBe('some')
    expect(bandFor(concern, some)).toBe('some')
    expect(bandFor(concern, some + 0.1)).toBe('a-little')
    expect(bandFor(concern, visible)).toBe('a-little')
    expect(bandFor(concern, visible + 0.1)).toBe(FAINT)
    expect(bandFor(concern, 100)).toBe(FAINT)
    expect(bandFor(concern, 1)).toBe('clear')
  })

  it.each(SHOWN_CONCERNS)('treats %s as visible at exactly its visible cut-off, the a-little band', (concern) => {
    const { visible } = CUT_OFFS[concern]
    expect(isVisible(concern, visible)).toBe(true)
    expect(bandFor(concern, visible)).toBe('a-little')
  })

  it.each(SHOWN_CONCERNS)('treats %s as faint, and not visible, just above its visible cut-off', (concern) => {
    const { visible } = CUT_OFFS[concern]
    expect(isVisible(concern, visible + 0.1)).toBe(false)
    expect(bandFor(concern, visible + 0.1)).toBe(FAINT)
  })

  it('does not share one set of cut-offs: the same score is a different band for different concerns', () => {
    expect(bandFor('hd_age_spot', 80)).toBe('some')
    expect(bandFor('hd_moisture', 80)).toBe(FAINT)
    expect(bandFor('hd_texture', 50)).toBe(FAINT)
    expect(bandFor('hd_acne', 50)).toBe('clear')
  })

  // Scores that mean the same band for every concern: above the highest visible cut-off (95) and at or below the lowest clear cut-off (20).
  it.each([
    [100, FAINT],
    [95.1, FAINT],
    [20, 'clear'],
    [12, 'clear'],
    [1, 'clear'],
  ])('puts a raw_score of %s in band %s, for every concern', (score, band) => {
    for (const concern of SHOWN_CONCERNS) {
      expect(bandFor(concern, score)).toBe(band)
      expect(isVisible(concern, score)).toBe(band !== FAINT)
    }
  })

  it.each(SHOWN_CONCERNS)('gives every score exactly one band for %s: one of the three visible ones up to its visible cut-off, and faint above it', (concern) => {
    const { visible } = CUT_OFFS[concern]
    for (let score = 1; score <= 100; score += 0.5) {
      const band = bandFor(concern, score)

      expect(band === FAINT ? score > visible : BANDS.includes(band as (typeof BANDS)[number])).toBe(true)
      expect(isVisible(concern, score)).toBe(score <= visible)
    }
  })

  it.each(SHOWN_CONCERNS)('gives a clearer band as the score of %s falls: a lower score never gives a fainter band', (concern) => {
    const rank = (band: string) => (band === FAINT ? 0 : BANDS.indexOf(band as (typeof BANDS)[number]) + 1)
    let last = 0
    for (let score = 100; score >= 1; score -= 0.5) {
      const now = rank(bandFor(concern, score))
      expect(now).toBeGreaterThanOrEqual(last)
      last = now
    }
  })
})

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

describe('seen-words wording', () => {
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

  it('has the nine faint words exactly as written, for the whole face', () => {
    expect(FAINT_WORDS).toHaveLength(9)
    for (const [concern, words] of FAINT_WORDS) {
      expect(WORDING[concern][FAINT].whole, concern).toBe(words)
      expect(seenWords(concern, FAINT, 'whole'), concern).toBe(words)
    }
  })

  it('answers a region with no words of its own, for a faint concern, with the whole-face faint words', () => {
    for (const [concern, words] of FAINT_WORDS) expect(seenWords(concern, FAINT, 'left_cheek'), concern).toBe(words)
  })

  it('has a faint row for every concern, and the ban scan above reads it (it is one of the texts the table holds)', () => {
    const faintTexts = allTexts().filter(({ band }) => band === FAINT)

    expect(faintTexts.map(({ concern }) => concern).sort()).toEqual([...SHOWN_CONCERNS].sort())
    for (const { concern, text } of faintTexts) {
      for (const [name, pattern] of BANNED) expect(pattern.test(text), `"${text}" (${concern} / faint) must not contain ${name}`).toBe(false)
    }
  })

  it('says something different in the faint band than in any of the three visible ones, and never claims to see it clearly', () => {
    for (const concern of SHOWN_CONCERNS) {
      const texts = ([...BANDS, FAINT] as const).map((band) => seenWords(concern, band, 'whole'))

      expect(new Set(texts).size, concern).toBe(4)
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

// --- PR 4: the result view ---
//
// The public face of a scan: stable ids for the concerns (never Perfect Corp's names), the words for a change since day one, and the pure
// builder that turns stored rows into what the app shows. Signatures the implementation owes, fixed by these tests:
//   CONCERN_IDS: Record<ShownConcern, ConcernId>
//   changeWords(concern: ShownConcern, change: ConcernChange): string          (keyed by the tables' own 'fainter' | 'more visible' | 'no clear change')
//   skinAgeChangeWords(change: SkinAgeChange, years: number): string           (years is the whole number of years apart, at least 1)
//   NOTHING_STANDS_OUT: string
//   resultView({ goal, results, overlays, skinType, skinAge, dayOne }): the `result` of the view, with `dayOneAt` a Date and `tablesVersion` TABLES_VERSION
//     results:  { concern: string; region: string; rawScore: number }[]        the scan's stored rows
//     overlays: Partial<Record<string, { url: string }>>                         by Perfect Corp concern, already signed
//     dayOne:   null | { id: string; createdAt: Date; results: (same rows)[]; skinAge: number | null }
// The change values in the VIEW use hyphens (`more-visible`, `no-clear-change`); the tables' own values keep their spaces.

const CONCERN_ID_LITERAL = {
  hd_acne: 'spots',
  hd_pore: 'pores',
  hd_oiliness: 'shine',
  hd_age_spot: 'marks',
  hd_redness: 'redness',
  hd_radiance: 'glow',
  hd_texture: 'texture',
  hd_dark_circle: 'under-eyes',
  hd_moisture: 'dryness',
} as const

// Written out from the brief: [concern, fainter, more visible, no clear change].
const CHANGE_WORDS_LITERAL = [
  ['hd_acne', 'Spots look fainter than on day one', 'Spots look more visible than on day one', 'No clear change in spots since day one'],
  ['hd_pore', 'Pores look less open than on day one', 'Pores look more open than on day one', 'No clear change in pores since day one'],
  ['hd_oiliness', 'Less shine than on day one', 'More shine than on day one', 'No clear change in shine since day one'],
  ['hd_age_spot', 'Marks look fainter than on day one', 'Marks look more visible than on day one', 'No clear change in marks since day one'],
  ['hd_redness', 'Redness looks fainter than on day one', 'Redness looks more visible than on day one', 'No clear change in redness since day one'],
  ['hd_radiance', 'More glow than on day one', 'Less glow than on day one', 'No clear change in glow since day one'],
  ['hd_texture', 'Skin looks smoother than on day one', 'Skin looks rougher than on day one', 'No clear change in smoothness since day one'],
  ['hd_dark_circle', 'Under-eye shadows look fainter than on day one', 'Under-eye shadows look more visible than on day one', 'No clear change under the eyes since day one'],
  ['hd_moisture', 'Skin looks less dry than on day one', 'Skin looks drier than on day one', 'No clear change in dryness since day one'],
] as const

const CHANGES = ['fainter', 'more visible', 'no clear change'] as const
const LIGHTNESS = /lighter|darker|light|dark|fairer|whiter/i

describe('public concern ids', () => {
  it('names all 9 shown concerns with the public id the app sees, and nothing else', () => {
    expect(CONCERN_IDS).toEqual(CONCERN_ID_LITERAL)
  })

  it('never gives the app one of Perfect Corp\'s names, and gives each concern an id of its own', () => {
    const ids = Object.values(CONCERN_IDS)

    expect(new Set(ids).size).toBe(9)
    for (const id of ids) expect(id).not.toMatch(/^hd_|_/)
  })
})

describe('change wording', () => {
  it.each(CHANGE_WORDS_LITERAL)('words a change in %s as: fainter "%s", more visible "%s", no clear change "%s"', (concern, fainter, moreVisible, noChange) => {
    expect(changeWords(concern, 'fainter')).toBe(fainter)
    expect(changeWords(concern, 'more visible')).toBe(moreVisible)
    expect(changeWords(concern, 'no clear change')).toBe(noChange)
  })

  it('is complete: 9 concerns by 3 changes is 27 different texts', () => {
    const texts = SHOWN_CONCERNS.flatMap((concern) => CHANGES.map((change) => changeWords(concern, change)))

    expect(texts).toHaveLength(27)
    expect(new Set(texts).size).toBe(27)
    for (const text of texts) expect(text).toEqual(expect.any(String))
  })

  it('says a rise in a healthy score is "fainter" and a fall is "more visible", for radiance as for the rest: more glow is the good direction', () => {
    expect(changeWords('hd_radiance', concernChange(40, 50))).toBe('More glow than on day one')
    expect(changeWords('hd_radiance', concernChange(50, 40))).toBe('Less glow than on day one')
    expect(changeWords('hd_acne', concernChange(40, 50))).toBe('Spots look fainter than on day one')
  })
})

describe('skin age change wording', () => {
  it.each([
    ['younger', 1, 'Your skin looks about 1 year younger than on day one'],
    ['younger', 3, 'Your skin looks about 3 years younger than on day one'],
    ['older', 1, 'Your skin looks about 1 year older than on day one'],
    ['older', 4, 'Your skin looks about 4 years older than on day one'],
    ['older', 12, 'Your skin looks about 12 years older than on day one'],
  ] as const)('says "%s" for %s year(s) as: %s', (change, years, expected) => {
    expect(skinAgeChangeWords(change, years)).toBe(expected)
  })

  it('says "year" only for exactly one, and "years" for any other number', () => {
    expect(skinAgeChangeWords('younger', 1)).toMatch(/\b1 year younger/)
    expect(skinAgeChangeWords('younger', 2)).toMatch(/\b2 years younger/)
    expect(skinAgeChangeWords('older', 1)).not.toMatch(/years/)
  })

  it('has no number and no direction for no clear change, whatever the gap', () => {
    expect(skinAgeChangeWords('no clear change', 1)).toBe('No clear change in skin age since day one')
    expect(skinAgeChangeWords('no clear change', 2)).toBe('No clear change in skin age since day one')
  })
})

describe('nothing stands out', () => {
  it('is one calm sentence', () => {
    expect(NOTHING_STANDS_OUT).toBe('Nothing stands out for your goal right now')
  })
})

// The same scan as every other string the product shows: nothing that diagnoses, nothing that grades, nothing about lightness.
describe('every new string passes the same ban list as the seen-words', () => {
  // A skin age change has to carry the number of years (a plain fact, as "Your skin looks about 29" does), so it is the one place a digit is allowed.
  const withoutDigitRule = BANNED.filter(([name]) => name !== 'a digit')

  const changeTexts = () => SHOWN_CONCERNS.flatMap((concern) => CHANGES.map((change) => ({ where: `${concern} / ${change}`, text: changeWords(concern, change) })))
  const skinAgeTexts = () =>
    [1, 2, 3, 10].flatMap((years) => (['younger', 'older'] as const).map((change) => ({ where: `skin age ${change} ${years}`, text: skinAgeChangeWords(change, years) }))).concat({
      where: 'skin age no clear change',
      text: skinAgeChangeWords('no clear change', 2),
    })

  it('names no condition, never says "you have", never grades, and carries no digit, in any change text or the nothing-stands-out text', () => {
    for (const { where, text } of [...changeTexts(), { where: 'nothing stands out', text: NOTHING_STANDS_OUT }]) {
      for (const [name, pattern] of BANNED) expect(pattern.test(text), `"${text}" (${where}) must not contain ${name}`).toBe(false)
    }
  })

  it('does the same for the skin age change texts, which alone may hold a digit', () => {
    for (const { where, text } of skinAgeTexts()) {
      for (const [name, pattern] of withoutDigitRule) expect(pattern.test(text), `"${text}" (${where}) must not contain ${name}`).toBe(false)
    }
  })

  it('never talks of lightness, in any new string: not "lighter", "darker", "light", "dark", "fairer" or "whiter"', () => {
    for (const { where, text } of [...changeTexts(), ...skinAgeTexts(), { where: 'nothing stands out', text: NOTHING_STANDS_OUT }]) {
      expect(LIGHTNESS.test(text), `"${text}" (${where})`).toBe(false)
    }
  })

  it('is plain and calm: short, with no exclamation mark', () => {
    for (const { where, text } of [...changeTexts(), ...skinAgeTexts(), { where: 'nothing stands out', text: NOTHING_STANDS_OUT }]) {
      expect(text.length, where).toBeLessThanOrEqual(80)
      expect(text, where).not.toMatch(/!/)
    }
  })

  it('has a lightness check that catches what it is meant to', () => {
    for (const text of ['Skin looks lighter', 'Skin looks DARKER', 'More light', 'Dark marks', 'Looks fairer', 'Looks whiter']) expect(LIGHTNESS.test(text), text).toBe(true)
    expect(LIGHTNESS.test('Skin looks smoother than on day one')).toBe(false)
  })
})

describe('resultView: the seen concerns', () => {
  const row = (concern: string, region: string, rawScore: number) => ({ concern, region, rawScore })
  const build = (over: Partial<Parameters<typeof resultView>[0]> = {}) => resultView({ goal: 'glow', results: [], overlays: {}, skinType: null, skinAge: null, dayOne: null, ...over })
  // glow shows hd_radiance (public id glow), hd_moisture (dryness), hd_texture (texture), in that order.

  it('shows every one of the goal\'s concerns that has a row, faint ones too, in the goal\'s order, each with its level', () => {
    const result = build({ results: [row('hd_texture', 'whole', 35), row('hd_moisture', 'whole', 62), row('hd_radiance', 'whole', 65)] })

    expect(result.seen).toEqual([
      { concern: 'glow', region: 'whole', level: 'some', words: 'Less glow across the face', overlay: null },
      { concern: 'dryness', region: 'whole', level: 'faint', words: 'Hardly any dry patches', overlay: null },
      { concern: 'texture', region: 'whole', level: 'a-little', words: 'A little roughness in places', overlay: null },
    ])
    expect(result.nothingStandsOut).toBeNull()
  })

  it('lists all three goal concerns, mixing faint and visible, with the right level and words, in goal order', () => {
    // Under brighter: radiance, dark circle, age spot.
    const result = build({ goal: 'brighter', results: [row('hd_age_spot', 'whole', 20), row('hd_dark_circle', 'whole', 75), row('hd_radiance', 'whole', 95)] })

    expect(result.seen).toEqual([
      { concern: 'glow', region: 'whole', level: 'faint', words: 'An even glow across the face', overlay: null },
      { concern: 'under-eyes', region: 'whole', level: 'faint', words: 'Hardly any darkness under the eyes', overlay: null },
      { concern: 'marks', region: 'whole', level: 'clear', words: 'Many dark marks across the face', overlay: null },
    ])
    expect(result.nothingStandsOut).toBeNull()
  })

  it.each([
    [62, 'clear'],
    [62.1, 'some'],
    [68, 'some'],
    [68.1, 'a-little'],
    [75, 'a-little'],
    [75.1, 'faint'],
    [100, 'faint'],
  ])('gives a raw_score of %s the level %s (hd_radiance: clear 62, some 68, visible 75)', (score, level) => {
    expect(build({ results: [row('hd_radiance', 'whole', score)] }).seen.map((seen) => seen.level)).toEqual([level])
  })

  it('words each concern\'s faint row as written, for every goal', () => {
    for (const goal of GOALS) {
      const concerns = concernsForGoal(goal)
      const result = build({ goal, results: concerns.map((concern) => row(concern, 'whole', 100)) })

      expect(result.seen.map((seen) => seen.words)).toEqual(concerns.map((concern) => FAINT_WORDS.find(([name]) => name === concern)![1]))
      expect(result.seen.every((seen) => seen.level === 'faint')).toBe(true)
    }
  })

  it('words each of the three visible bands with the seen-words for that band', () => {
    const result = build({ results: [row('hd_radiance', 'whole', 75), row('hd_moisture', 'whole', 30), row('hd_texture', 'whole', 20)] })

    expect(result.seen.map((seen) => seen.words)).toEqual(['A little less glow in places', 'Some dry patches', 'Rough, uneven skin across much of the face'])
    expect(result.seen.map((seen) => seen.concern)).toEqual(['glow', 'dryness', 'texture'])
  })

  it('calls a score of exactly 75 a-little and one of 75.1 faint for radiance: the visible threshold is inclusive', () => {
    expect(build({ results: [row('hd_radiance', 'whole', 75)] }).seen.map((seen) => seen.level)).toEqual(['a-little'])
    expect(build({ results: [row('hd_radiance', 'whole', 75.1)] }).seen.map((seen) => seen.level)).toEqual(['faint'])
  })

  it('reads the whole-face row in preference to another region, whatever the order of the rows', () => {
    // The left cheek is clear (20); the whole face is only a-little (70). The whole face is the one that is read.
    const rows = [row('hd_radiance', 'left_cheek', 20), row('hd_radiance', 'whole', 70)]

    for (const results of [rows, [...rows].reverse()]) {
      expect(build({ results }).seen).toEqual([{ concern: 'glow', region: 'whole', level: 'a-little', words: 'A little less glow in places', overlay: null }])
    }
  })

  it('words a concern by its whole-face row even when another region is clearer: it is faint, not clear', () => {
    const result = build({ results: [row('hd_radiance', 'left_cheek', 20), row('hd_radiance', 'whole', 80)] })

    expect(result.seen).toEqual([{ concern: 'glow', region: 'whole', level: 'faint', words: 'An even glow across the face', overlay: null }])
    expect(result.nothingStandsOut).toBe(NOTHING_STANDS_OUT)
  })

  it('with no whole-face row, reads the first region by name and says which region it read', () => {
    // 'forehead' sorts before 'left_cheek'; the rows arrive the other way round.
    const result = build({ results: [row('hd_radiance', 'left_cheek', 20), row('hd_radiance', 'forehead', 65)] })

    expect(result.seen).toEqual([{ concern: 'glow', region: 'forehead', level: 'some', words: 'Less glow across the face', overlay: null }])
  })

  it('leaves out a concern that has no row at all, and does not fail', () => {
    const result = build({ results: [row('hd_radiance', 'whole', 41.5), row('hd_texture', 'whole', 55)] })

    expect(result.seen.map((seen) => seen.concern)).toEqual(['glow', 'texture'])
  })

  it('ignores rows for concerns the goal does not show, and the overall score', () => {
    const result = build({ results: [row('hd_acne', 'whole', 10), row('all', 'whole', 5), row('hd_pore', 'whole', 5)] })

    expect(result.seen).toEqual([])
    expect(result.nothingStandsOut).toBe(NOTHING_STANDS_OUT)
  })

  it('says nothing stands out when all three concerns are faint, and still shows all three as faint', () => {
    const result = build({ results: [row('hd_radiance', 'whole', 76), row('hd_moisture', 'whole', 90), row('hd_texture', 'whole', 100)] })

    expect(result.seen.map((seen) => seen.level)).toEqual(['faint', 'faint', 'faint'])
    expect(result.seen.map((seen) => seen.words)).toEqual(['An even glow across the face', 'Hardly any dry patches', 'Skin looks smooth'])
    expect(result.nothingStandsOut).toBe('Nothing stands out for your goal right now')
  })

  it('says nothing stands out when only some concerns came back and every one of them is faint', () => {
    const result = build({ results: [row('hd_radiance', 'whole', 80)] })

    expect(result.seen).toHaveLength(1)
    expect(result.nothingStandsOut).toBe(NOTHING_STANDS_OUT)
  })

  it('does not say nothing stands out when even one concern is not faint', () => {
    const result = build({ results: [row('hd_radiance', 'whole', 76), row('hd_moisture', 'whole', 90), row('hd_texture', 'whole', 40)] })

    expect(result.seen.map((seen) => seen.level)).toEqual(['faint', 'faint', 'a-little'])
    expect(result.nothingStandsOut).toBeNull()
  })

  it('says nothing stands out, and shows nothing, for a scan with no rows at all', () => {
    const result = build()

    expect(result.seen).toEqual([])
    expect(result.nothingStandsOut).toBe(NOTHING_STANDS_OUT)
  })

  it('follows the goal: the same rows read under another goal show that goal\'s concerns', () => {
    const result = build({ goal: 'clear-skin', results: [row('hd_acne', 'whole', 58), row('hd_radiance', 'whole', 58)] })

    expect(result.seen).toEqual([{ concern: 'spots', region: 'whole', level: 'some', words: 'Some spots and breakouts across the face', overlay: null }])
  })
})

describe('resultView: overlays', () => {
  const row = (concern: string, region: string, rawScore: number) => ({ concern, region, rawScore })
  const results = [row('hd_radiance', 'whole', 65), row('hd_moisture', 'whole', 62), row('hd_texture', 'whole', 35)]

  it('gives a shown concern the link it was signed with, and null when there is none', () => {
    const result = resultView({ goal: 'glow', results, overlays: { hd_radiance: { url: '/link/radiance' } }, skinType: null, skinAge: null, dayOne: null })

    expect(result.seen.map((seen) => seen.overlay)).toEqual([{ url: '/link/radiance' }, null, null])
  })

  it('gives a faint concern its link too: hd_moisture at 62 is faint and is shown', () => {
    const result = resultView({ goal: 'glow', results, overlays: { hd_radiance: { url: '/link/radiance' }, hd_moisture: { url: '/link/moisture' } }, skinType: null, skinAge: null, dayOne: null })

    expect(result.seen.map((seen) => [seen.level, seen.overlay])).toEqual([
      ['some', { url: '/link/radiance' }],
      ['faint', { url: '/link/moisture' }],
      ['a-little', null],
    ])
  })

  it('gives no overlay to a concern outside the goal, even when it has a mask', () => {
    const result = resultView({ goal: 'glow', results, overlays: { hd_radiance: { url: '/link/radiance' }, hd_moisture: { url: '/link/moisture' }, hd_acne: { url: '/link/acne' } }, skinType: null, skinAge: null, dayOne: null })

    expect(JSON.stringify(result)).not.toContain('/link/acne')
    expect(JSON.stringify(result)).toContain('/link/radiance')
    expect(JSON.stringify(result)).toContain('/link/moisture')
  })

  it('gives no overlay to a goal concern Perfect Corp did not return, even when it has a mask', () => {
    const result = resultView({ goal: 'glow', results: [row('hd_radiance', 'whole', 41.5)], overlays: { hd_radiance: { url: '/link/radiance' }, hd_moisture: { url: '/link/moisture' } }, skinType: null, skinAge: null, dayOne: null })

    expect(JSON.stringify(result)).not.toContain('/link/moisture')
  })
})

describe('resultView: also noticed', () => {
  const row = (concern: string, region: string, rawScore: number) => ({ concern, region, rawScore })
  const build = (over: Partial<Parameters<typeof resultView>[0]> = {}) => resultView({ goal: 'glow', results: [], overlays: {}, skinType: null, skinAge: null, dayOne: null, ...over })
  // glow measures radiance, moisture, texture, then the core extras age_spot (marks), acne (spots), pore (pores), oiliness (shine).
  // Visible: age_spot <= 86, acne <= 68, pore <= 60, oiliness <= 82 (a-little above `some`, some above `clear`).

  it('lists the visible extras in core order, whatever the order of the rows, each shaped like a seen item', () => {
    const result = build({ results: [row('hd_oiliness', 'whole', 70), row('hd_pore', 'whole', 50), row('hd_acne', 'whole', 50), row('hd_age_spot', 'whole', 84)] })

    expect(result.alsoNoticed).toEqual([
      { concern: 'marks', region: 'whole', level: 'a-little', words: 'A few faint dark marks', overlay: null },
      { concern: 'spots', region: 'whole', level: 'clear', words: 'Many spots and breakouts across the face', overlay: null },
      { concern: 'pores', region: 'whole', level: 'a-little', words: 'Pores a little more open in places', overlay: null },
      { concern: 'shine', region: 'whole', level: 'some', words: 'Some shine across the face', overlay: null },
    ])
    expect(Object.keys(result.alsoNoticed[0]!).sort()).toEqual(['concern', 'level', 'overlay', 'region', 'words'])
  })

  it('leaves out a faint extra: it is stored for the routine stage but not shown', () => {
    const result = build({ results: [row('hd_age_spot', 'whole', 90), row('hd_acne', 'whole', 58), row('hd_pore', 'whole', 70), row('hd_oiliness', 'whole', 95)] })

    expect(result.alsoNoticed.map((item) => item.concern)).toEqual(['spots'])
    expect(JSON.stringify(result.alsoNoticed)).not.toContain('faint')
  })

  it('counts an extra at exactly its visible cut-off as visible and just above it as faint', () => {
    expect(build({ results: [row('hd_acne', 'whole', 68)] }).alsoNoticed.map((item) => item.level)).toEqual(['a-little'])
    expect(build({ results: [row('hd_acne', 'whole', 68.1)] }).alsoNoticed).toEqual([])
  })

  it('never lists one of the goal\'s own concerns, visible or not, and never lists the skin type or the overall score', () => {
    const result = build({
      goal: 'clear-skin',
      results: [row('hd_acne', 'whole', 50), row('hd_pore', 'whole', 20), row('hd_oiliness', 'whole', 50), row('hd_skin_type', 'whole', 10), row('all', 'whole', 5), row('hd_radiance', 'whole', 10)],
    })

    expect(result.seen.map((item) => item.concern)).toEqual(['spots', 'pores', 'shine'])
    expect(result.alsoNoticed).toEqual([])
  })

  it('lists, under another goal, the extras of that goal: acne is a goal concern for clear-skin and an extra for glow', () => {
    const results = [row('hd_acne', 'whole', 50), row('hd_age_spot', 'whole', 70)]

    expect(build({ goal: 'clear-skin', results }).alsoNoticed.map((item) => item.concern)).toEqual(['marks'])
    expect(build({ goal: 'glow', results }).alsoNoticed.map((item) => item.concern)).toEqual(['marks', 'spots'])
    expect(build({ goal: 'fade-dark-marks', results }).alsoNoticed.map((item) => item.concern)).toEqual([])
  })

  it('leaves out a measured extra that has no row, and is [] when there are no extras at all', () => {
    expect(build({ results: [row('hd_acne', 'whole', 50)] }).alsoNoticed.map((item) => item.concern)).toEqual(['spots'])
    expect(build({ results: [] }).alsoNoticed).toEqual([])
    expect(build({ results: [row('hd_radiance', 'whole', 41.5), row('hd_moisture', 'whole', 20), row('hd_texture', 'whole', 10)] }).alsoNoticed).toEqual([])
  })

  it('does not list a concern that is not measured for the goal, even when it has a row (a non-core concern outside the goal)', () => {
    const result = build({ goal: 'clear-skin', results: [row('hd_redness', 'whole', 10), row('hd_texture', 'whole', 5), row('hd_dark_circle', 'whole', 5)] })

    expect(result.alsoNoticed).toEqual([])
  })

  it('gives a listed extra the link it was signed with, and null when there is none; a faint extra gets no link', () => {
    const result = build({
      results: [row('hd_age_spot', 'whole', 84), row('hd_acne', 'whole', 58), row('hd_pore', 'whole', 70), row('hd_oiliness', 'whole', 70)],
      overlays: { hd_age_spot: { url: '/link/age-spot' }, hd_pore: { url: '/link/pore' }, hd_radiance: { url: '/link/radiance' } },
    })

    expect(result.alsoNoticed.map((item) => [item.concern, item.overlay])).toEqual([
      ['marks', { url: '/link/age-spot' }],
      ['spots', null],
      ['shine', null],
    ])
    expect(JSON.stringify(result.alsoNoticed)).not.toContain('/link/pore')
  })

  it('takes no part in nothingStandsOut or sinceDayOne', () => {
    const faintGoal = [row('hd_radiance', 'whole', 90), row('hd_moisture', 'whole', 90), row('hd_texture', 'whole', 90)]
    const extras = [row('hd_acne', 'whole', 50), row('hd_age_spot', 'whole', 70)]
    const result = build({ results: [...faintGoal, ...extras], dayOne: { id: 'd', createdAt: new Date('2030-06-15T12:00:00.000Z'), results: [...faintGoal, row('hd_acne', 'whole', 20), row('hd_age_spot', 'whole', 20)], skinAge: null } })

    expect(result.alsoNoticed).toHaveLength(2)
    expect(result.nothingStandsOut).toBe(NOTHING_STANDS_OUT)
    expect(result.sinceDayOne!.concerns.map((change) => change.concern)).toEqual(['glow', 'dryness', 'texture'])
  })
})

describe('resultView: skin type, skin age and the rest of the shape', () => {
  const build = (over: Partial<Parameters<typeof resultView>[0]> = {}) => resultView({ goal: 'glow', results: [], overlays: {}, skinType: null, skinAge: null, dayOne: null, ...over })

  it.each(['oily', 'dry', 'combination', 'normal'] as const)('passes the skin type %s through', (skinType) => {
    expect(build({ skinType }).skinType).toBe(skinType)
  })

  it('has no skin type when there is none', () => {
    expect(build({ skinType: null }).skinType).toBeNull()
  })

  it('states the skin age as a whole number of years with its plain-fact words', () => {
    expect(build({ skinAge: 31 }).skinAge).toEqual({ years: 31, words: 'Your skin looks about 31' })
    expect(build({ skinAge: 28.5 }).skinAge).toEqual({ years: 29, words: 'Your skin looks about 29' })
    expect(build({ skinAge: 28.49 }).skinAge).toEqual({ years: 28, words: 'Your skin looks about 28' })
  })

  it('has no skin age when there is none', () => {
    expect(build({ skinAge: null }).skinAge).toBeNull()
  })

  it('carries the version of the tables in force, and exactly the fields of the contract', () => {
    const result = build({ results: [{ concern: 'hd_radiance', region: 'whole', rawScore: 41.5 }] })

    expect(result.tablesVersion).toBe(TABLES_VERSION)
    expect(Object.keys(result).sort()).toEqual(['alsoNoticed', 'nothingStandsOut', 'seen', 'sinceDayOne', 'skinAge', 'skinType', 'tablesVersion'])
    expect(Object.keys(result.seen[0]!).sort()).toEqual(['concern', 'level', 'overlay', 'region', 'words'])
  })

  it('has no day one when it was given none', () => {
    expect(build().sinceDayOne).toBeNull()
  })
})

describe('resultView: change since day one', () => {
  const row = (concern: string, region: string, rawScore: number) => ({ concern, region, rawScore })
  const DAY_ONE_AT = new Date('2030-06-15T12:00:00.000Z')
  const dayOne = (results: ReturnType<typeof row>[], skinAge: number | null = null) => ({ id: 'day-one-scan', createdAt: DAY_ONE_AT, results, skinAge })
  const since = (current: ReturnType<typeof row>[], base: ReturnType<typeof row>[], skinAges: [number | null, number | null] = [null, null]) =>
    resultView({ goal: 'glow', results: current, overlays: {}, skinType: null, skinAge: skinAges[0], dayOne: dayOne(base, skinAges[1]) }).sinceDayOne

  it('names the day-one scan and when it was taken', () => {
    const result = since([], [])

    expect(result).toMatchObject({ dayOneScanId: 'day-one-scan', dayOneAt: DAY_ONE_AT })
    expect(Object.keys(result!).sort()).toEqual(['concerns', 'dayOneAt', 'dayOneScanId', 'skinAge'])
  })

  it('reads all three goal concerns, in goal order, each as fainter, more visible or no clear change, in the API\'s hyphenated words', () => {
    const result = since(
      [row('hd_radiance', 'whole', 46), row('hd_moisture', 'whole', 44), row('hd_texture', 'whole', 55)],
      [row('hd_radiance', 'whole', 40), row('hd_moisture', 'whole', 50), row('hd_texture', 'whole', 55)],
    )

    expect(result!.concerns).toEqual([
      { concern: 'glow', change: 'fainter', words: 'More glow than on day one' },
      { concern: 'dryness', change: 'more-visible', words: 'Skin looks drier than on day one' },
      { concern: 'texture', change: 'no-clear-change', words: 'No clear change in smoothness since day one' },
    ])
  })

  it('counts a change of exactly 5 as no clear change, in either direction, and anything bigger as a change', () => {
    const at = (current: number) => since([row('hd_texture', 'whole', current)], [row('hd_texture', 'whole', 50)])!.concerns[0]!.change

    expect(at(55)).toBe('no-clear-change')
    expect(at(45)).toBe('no-clear-change')
    expect(at(55.5)).toBe('fainter')
    expect(at(44.5)).toBe('more-visible')
  })

  it('reads a concern that is no longer visible too: the change is about the score, not about what is shown now', () => {
    const result = since([row('hd_radiance', 'whole', 80)], [row('hd_radiance', 'whole', 50)])

    expect(result!.concerns).toEqual([{ concern: 'glow', change: 'fainter', words: 'More glow than on day one' }])
  })

  it('compares the whole-face score on both scans, not another region', () => {
    const result = since(
      [row('hd_radiance', 'whole', 46), row('hd_radiance', 'left_cheek', 10)],
      [row('hd_radiance', 'whole', 40), row('hd_radiance', 'left_cheek', 90)],
    )

    expect(result!.concerns).toEqual([{ concern: 'glow', change: 'fainter', words: 'More glow than on day one' }])
  })

  it('leaves out a concern that is missing on the day-one scan, and one that is missing on this scan', () => {
    const result = since(
      [row('hd_radiance', 'whole', 46), row('hd_moisture', 'whole', 44)],
      [row('hd_radiance', 'whole', 40), row('hd_texture', 'whole', 40)],
    )

    expect(result!.concerns.map((concern) => concern.concern)).toEqual(['glow'])
  })

  it('leaves out a concern whose rows are for different regions on the two scans: a cheek is not compared with the whole face', () => {
    const result = since(
      [row('hd_radiance', 'whole', 46), row('hd_moisture', 'whole', 44)],
      [row('hd_radiance', 'left_cheek', 40), row('hd_moisture', 'whole', 50)],
    )

    expect(result!.concerns.map((concern) => concern.concern)).toEqual(['dryness'])
  })

  it('still compares a concern that only has the same other region on both scans', () => {
    const result = since([row('hd_radiance', 'left_cheek', 46)], [row('hd_radiance', 'left_cheek', 40)])

    expect(result!.concerns).toEqual([{ concern: 'glow', change: 'fainter', words: 'More glow than on day one' }])
  })

  it('has an empty list, not a missing day one, when no concern is on both scans', () => {
    expect(since([row('hd_radiance', 'whole', 46)], [])!.concerns).toEqual([])
  })

  it('says how the skin age moved: older by more than 2 years, younger by more than 2, and no clear change inside it', () => {
    const age = (current: number, base: number) => since([], [], [current, base])!.skinAge

    expect(age(34, 31)).toEqual({ change: 'older', words: 'Your skin looks about 3 years older than on day one' })
    expect(age(28, 31)).toEqual({ change: 'younger', words: 'Your skin looks about 3 years younger than on day one' })
    expect(age(33, 31)).toEqual({ change: 'no-clear-change', words: 'No clear change in skin age since day one' })
    expect(age(29, 31)).toEqual({ change: 'no-clear-change', words: 'No clear change in skin age since day one' })
    expect(age(31, 31)).toEqual({ change: 'no-clear-change', words: 'No clear change in skin age since day one' })
  })

  it('has no skin age change when either scan has no skin age, and still has the concerns', () => {
    expect(since([row('hd_radiance', 'whole', 46)], [row('hd_radiance', 'whole', 40)], [null, 31])!.skinAge).toBeNull()
    expect(since([row('hd_radiance', 'whole', 46)], [row('hd_radiance', 'whole', 40)], [31, null])!.skinAge).toBeNull()
    expect(since([row('hd_radiance', 'whole', 46)], [row('hd_radiance', 'whole', 40)], [null, null])!.concerns).toHaveLength(1)
  })

  it('never says a word about lightness or a number of points, whatever the scores', () => {
    const result = since(
      [row('hd_radiance', 'whole', 90), row('hd_moisture', 'whole', 10), row('hd_texture', 'whole', 50)],
      [row('hd_radiance', 'whole', 10), row('hd_moisture', 'whole', 90), row('hd_texture', 'whole', 50)],
      [20, 40],
    )

    const text = JSON.stringify(result!.concerns)
    expect(text).not.toMatch(LIGHTNESS)
    expect(text).not.toMatch(/\d/)
  })
})

// A chase is one continuous run of working on a goal, read from the profile's goal history alone and never from scan dates. Leaving a goal
// and taking it up again within RESUME_DAYS of leaving continues the same chase; coming back later starts a new one. The chase start is when
// the goal first became current in that chain. Every expectation below is a literal written from issue #145 ("Chases and day one"), never
// read from the module: the history is the rows the goals service appends, oldest first.
describe('chaseStartFor: which chase of a goal a time falls in', () => {
  const CHASE_T0 = new Date('2030-06-15T12:00:00.000Z')
  const DAY = 24 * 60 * 60 * 1000
  const on = (offsetMs: number) => new Date(CHASE_T0.getTime() + offsetMs)
  /** The profile's goal history, oldest first: each row is the goal that became current at that offset from CHASE_T0. */
  const history = (...rows: [Goal | null, number][]) => rows.map(([goal, offset]) => ({ goal, createdAt: on(offset) }))
  // The window is 90 days, from the spec; RESUME_DAYS is pinned to it separately, so these fixtures never read it.
  const WINDOW = 90 * DAY

  it('resumes a goal left no more than 90 days ago', () => {
    expect(RESUME_DAYS).toBe(90)
  })

  it('starts the chase when the goal became current, and the goal is current from that moment on', () => {
    const rows = history(['glow', 0])

    expect(chaseStartFor(rows, 'glow', on(0))).toEqual(on(0))
    expect(chaseStartFor(rows, 'glow', on(30 * DAY))).toEqual(on(0))
  })

  it('has no chase for a time a millisecond before the goal became current', () => {
    expect(chaseStartFor(history(['glow', 10 * DAY]), 'glow', on(10 * DAY - 1))).toBeNull()
  })

  it('has no chase for a goal the profile never had, nor for a profile with no history at all', () => {
    expect(chaseStartFor(history(['glow', 0], ['brighter', DAY]), 'even-tone', on(5 * DAY))).toBeNull()
    expect(chaseStartFor([], 'glow', on(0))).toBeNull()
  })

  it('merges a run of the same goal: picking it again does not restart the chase', () => {
    const rows = history(['glow', 0], ['glow', 3 * DAY], ['glow', 9 * DAY])

    expect(chaseStartFor(rows, 'glow', on(10 * DAY))).toEqual(on(0))
    expect(chaseStartFor(rows, 'glow', on(5 * DAY))).toEqual(on(0))
  })

  it('has no chase for a goal while another one is current, however short the detour', () => {
    const rows = history(['glow', 0], ['brighter', 10 * DAY], ['glow', 12 * DAY])

    expect(chaseStartFor(rows, 'glow', on(11 * DAY))).toBeNull()
    expect(chaseStartFor(rows, 'brighter', on(11 * DAY))).toEqual(on(10 * DAY))
  })

  it('continues the chase across a detour, so a short break keeps the first day one', () => {
    const rows = history(['glow', 0], ['brighter', 10 * DAY], ['glow', 12 * DAY])

    expect(chaseStartFor(rows, 'glow', on(12 * DAY))).toEqual(on(0))
    expect(chaseStartFor(rows, 'glow', on(40 * DAY))).toEqual(on(0))
  })

  it('continues the chase for a return exactly 90 days after leaving, the last moment of the window', () => {
    const rows = history(['glow', 0], ['brighter', 10 * DAY], ['glow', 10 * DAY + WINDOW])

    expect(chaseStartFor(rows, 'glow', on(10 * DAY + WINDOW))).toEqual(on(0))
  })

  it('starts a new chase for a return a millisecond after the window closes', () => {
    const back = 10 * DAY + WINDOW + 1
    const rows = history(['glow', 0], ['brighter', 10 * DAY], ['glow', back])

    expect(chaseStartFor(rows, 'glow', on(back))).toEqual(on(back))
    expect(chaseStartFor(rows, 'glow', on(back + 50 * DAY))).toEqual(on(back))
  })

  it('measures the window from when the goal was left, not from when the chase started', () => {
    // Glow was current for 200 days, left, and taken up again 90 days later: one chase, still starting on day 0.
    const rows = history(['glow', 0], ['brighter', 200 * DAY], ['glow', 200 * DAY + WINDOW])

    expect(chaseStartFor(rows, 'glow', on(200 * DAY + WINDOW))).toEqual(on(0))
  })

  it('counts a row with no goal as leaving the goal: words nobody sorted into a goal are not the goal', () => {
    const rows = history(['glow', 0], [null, 10 * DAY], ['glow', 12 * DAY])

    expect(chaseStartFor(rows, 'glow', on(11 * DAY))).toBeNull()
    expect(chaseStartFor(rows, 'glow', on(12 * DAY))).toEqual(on(0))
  })

  it('starts a new chase when a row with no goal stood for longer than the window', () => {
    const back = 10 * DAY + WINDOW + 1
    const rows = history(['glow', 0], [null, 10 * DAY], ['glow', back])

    expect(chaseStartFor(rows, 'glow', on(back))).toEqual(on(back))
  })

  it('chains across several short detours and keeps the start of the first', () => {
    const rows = history(['glow', 0], ['brighter', 10 * DAY], ['glow', 12 * DAY], [null, 20 * DAY], ['glow', 40 * DAY], ['clear-skin', 50 * DAY], ['glow', 100 * DAY])

    expect(chaseStartFor(rows, 'glow', on(100 * DAY))).toEqual(on(0))
  })

  it('keeps only the detours since the last gap too long to resume', () => {
    const fresh = 10 * DAY + WINDOW + 1
    const rows = history(['glow', 0], ['brighter', 10 * DAY], ['glow', fresh], ['even-tone', fresh + DAY], ['glow', fresh + 3 * DAY])

    expect(chaseStartFor(rows, 'glow', on(fresh + 3 * DAY))).toEqual(on(fresh))
    // The older chase is still the answer for a time inside it.
    expect(chaseStartFor(rows, 'glow', on(5 * DAY))).toEqual(on(0))
  })

  it('answers for the chase that holds the time asked about, not for the newest chase', () => {
    const fresh = 10 * DAY + WINDOW + 1
    const rows = history(['glow', 0], ['brighter', 10 * DAY], ['glow', fresh])

    expect(chaseStartFor(rows, 'glow', on(DAY))).toEqual(on(0))
    expect(chaseStartFor(rows, 'glow', on(fresh + DAY))).toEqual(on(fresh))
  })
})

// A goal's review point is when its chase is looked at again: day one plus the goal's review week, which starts at 6 for every goal and is a
// placeholder to tune per goal later (issue #145, "Review point"). The table is versioned like the others. Every expectation below is a literal
// written from the issue, never read from the module.
describe('reviewPointFor: when a goal\'s chase is looked at again', () => {
  /** Week 6 for every goal, from the issue. */
  const REVIEW_WEEK = 6
  const DAY = 24 * 60 * 60 * 1000
  const WEEK = 7 * DAY
  /** The day one every fixture here hangs off; the review point is written out as its own literal, not worked out from this one. */
  const DAY_ONE = new Date('2030-06-15T12:00:00.000Z')
  /** 2030-06-15 plus 42 days, by the calendar. */
  const REVIEW_POINT = new Date('2030-07-27T12:00:00.000Z')

  it.each([...GOALS])('gives %s a review week of 6, the placeholder every goal starts at', (goal) => {
    expect(REVIEW_WEEKS[goal]).toBe(REVIEW_WEEK)
  })

  it('covers every goal in the vocabulary and nothing else, so no goal is left without a review point', () => {
    expect(Object.keys(REVIEW_WEEKS).sort()).toEqual([...GOALS].sort())
  })

  it.each([...GOALS])('puts %s\'s review point six weeks after day one, to the millisecond', (goal) => {
    expect(reviewPointFor(DAY_ONE, goal)).toEqual(REVIEW_POINT)
  })

  it('moves with day one: a day one a day later has its review point a day later', () => {
    expect(reviewPointFor(new Date(DAY_ONE.getTime() + DAY), 'glow')).toEqual(new Date(REVIEW_POINT.getTime() + DAY))
  })

  it('keeps the time of day of day one: a scan taken in the evening is reviewed in the evening', () => {
    expect(reviewPointFor(new Date('2030-06-15T19:45:30.250Z'), 'glow')).toEqual(new Date('2030-07-27T19:45:30.250Z'))
  })

  it('leaves day one alone: the date it was given is not moved on', () => {
    const dayOne = new Date(DAY_ONE)

    reviewPointFor(dayOne, 'glow')

    expect(dayOne).toEqual(DAY_ONE)
  })

  it('is six weeks, which is 42 days, for every goal', () => {
    for (const goal of GOALS) expect(reviewPointFor(DAY_ONE, goal).getTime() - DAY_ONE.getTime()).toBe(REVIEW_WEEK * WEEK)
  })

  it('is well inside the 90-day resume window, so a chase cannot lapse before its own review point', () => {
    expect(reviewPointFor(DAY_ONE, 'glow').getTime() - DAY_ONE.getTime()).toBeLessThan(RESUME_DAYS * DAY)
  })
})

// The next-goal rule (issue #145): at a chase's check-in, once the goal's own concerns have got fainter, which other goal would the face most plausibly
// want next. Pure and without a model: the same rows always give the same goal. Every expectation is a literal written from the brief.
describe('nextGoalFor: which goal to suggest after a check-in', () => {
  type Row = { concern: string; region: string; rawScore: number }
  type Input = Parameters<typeof nextGoalFor>[0]

  /** A raw_score in each band, per concern, written out from the cut-offs above (faint is above `visible`). */
  const AT: Record<ShownConcern, Record<'faint' | 'a-little' | 'some' | 'clear', number>> = {
    hd_acne: { faint: 90, 'a-little': 65, some: 58, clear: 50 },
    hd_age_spot: { faint: 95, 'a-little': 85, some: 80, clear: 70 },
    hd_pore: { faint: 90, 'a-little': 55, some: 40, clear: 20 },
    hd_oiliness: { faint: 95, 'a-little': 80, some: 70, clear: 60 },
    hd_redness: { faint: 99, 'a-little': 90, some: 75, clear: 60 },
    hd_radiance: { faint: 90, 'a-little': 72, some: 65, clear: 60 },
    hd_texture: { faint: 60, 'a-little': 35, some: 25, clear: 15 },
    hd_dark_circle: { faint: 80, 'a-little': 58, some: 50, clear: 45 },
    hd_moisture: { faint: 60, 'a-little': 32, some: 29, clear: 25 },
  }
  type BandName = keyof (typeof AT)['hd_acne']

  /** Whole-face rows for all nine concerns: every one faint, then the bands given. */
  const rowsOf = (bands: Partial<Record<ShownConcern, BandName>> = {}): Row[] =>
    SHOWN_CONCERNS.map((concern) => ({ concern, region: 'whole', rawScore: AT[concern][bands[concern] ?? 'faint'] }))
  /** The day-one rows: a glow, even-tone, ... chase's own concerns, all at a middling score a check-in can rise or fall from. */
  const dayOneRows = (scores: Partial<Record<ShownConcern, number>>): Row[] => Object.entries(scores).map(([concern, rawScore]) => ({ concern, region: 'whole', rawScore }))
  const call = (over: Partial<Input> & Pick<Input, 'goal'>) =>
    nextGoalFor({ results: rowsOf(), dayOneResults: [], everWantedLighter: false, ...over })

  // Glow's own three are radiance, moisture and texture. Day one had radiance at 50; a check-in rows set radiance to 56 (+6, fainter) or less.
  const GLOW_DAY_ONE = dayOneRows({ hd_radiance: 50, hd_moisture: 50, hd_texture: 50 })
  /** Glow's check-in rows with radiance fainter (+6) and then the bands given. */
  const fainterGlow = (bands: Partial<Record<ShownConcern, BandName>>): Row[] => rowsOf(bands).map((row) => (row.concern === 'hd_radiance' ? { ...row, rawScore: 56 } : row.concern === 'hd_moisture' || row.concern === 'hd_texture' ? { ...row, rawScore: 50 } : row))

  describe('the gate: only after the goal\'s own concerns have got fainter', () => {
    it('gives null when none of the goal\'s concerns is fainter, however plainly other goals\' concerns can be seen', () => {
      const results = rowsOf({ hd_pore: 'clear', hd_acne: 'clear' }).map((row) => ({ ...row, rawScore: GLOW_DAY_ONE.find((d) => d.concern === row.concern)?.rawScore ?? row.rawScore }))

      expect(call({ goal: 'glow', results, dayOneResults: GLOW_DAY_ONE })).toBeNull()
    })

    it('gives null when the goal\'s concerns have only got more visible', () => {
      const results = fainterGlow({ hd_pore: 'clear' }).map((row) => (row.concern === 'hd_radiance' ? { ...row, rawScore: 40 } : row))

      expect(call({ goal: 'glow', results, dayOneResults: GLOW_DAY_ONE })).toBeNull()
    })

    it('suggests a goal when just one of the three concerns is fainter', () => {
      const results = rowsOf({ hd_pore: 'clear' }).map((row) => (row.concern === 'hd_texture' ? { ...row, rawScore: 56 } : row.concern === 'hd_radiance' || row.concern === 'hd_moisture' ? { ...row, rawScore: 50 } : row))

      expect(call({ goal: 'glow', results, dayOneResults: GLOW_DAY_ONE })).toBe('clear-skin')
    })

    it('counts a rise of 6 as fainter but a rise of exactly 5 as within the noise', () => {
      const withRadiance = (rawScore: number) => fainterGlow({ hd_pore: 'clear' }).map((row) => (row.concern === 'hd_radiance' ? { ...row, rawScore } : row))

      expect(call({ goal: 'glow', results: withRadiance(55), dayOneResults: GLOW_DAY_ONE })).toBeNull()
      expect(call({ goal: 'glow', results: withRadiance(55.5), dayOneResults: GLOW_DAY_ONE })).toBe('clear-skin')
    })

    it('ignores a concern outside the goal getting fainter', () => {
      // Acne rose 30 points since day one, but it is not one of glow's three, and glow's own are flat.
      const dayOne = [...GLOW_DAY_ONE, ...dayOneRows({ hd_acne: 40 })]
      const results = rowsOf({ hd_pore: 'clear' }).map((row) => (['hd_radiance', 'hd_moisture', 'hd_texture'].includes(row.concern) ? { ...row, rawScore: 50 } : row.concern === 'hd_acne' ? { ...row, rawScore: 70 } : row))

      expect(call({ goal: 'glow', results, dayOneResults: dayOne })).toBeNull()
    })

    it('gives null when day one has no row for the concern, as there is nothing to be fainter than', () => {
      expect(call({ goal: 'glow', results: fainterGlow({ hd_pore: 'clear' }), dayOneResults: [] })).toBeNull()
    })

    it('reads the whole-face row where there is one, ignoring the regions', () => {
      const results = fainterGlow({ hd_pore: 'clear' }).map((row) => (row.concern === 'hd_radiance' ? { ...row, rawScore: 50 } : row))
      results.push({ concern: 'hd_radiance', region: 'cheek', rawScore: 90 })

      expect(call({ goal: 'glow', results, dayOneResults: GLOW_DAY_ONE })).toBeNull()
    })

    it('reads the first region by name when there is no whole-face row', () => {
      const regions = (left: number, right: number): Row[] => [
        { concern: 'hd_radiance', region: 'right-cheek', rawScore: right },
        { concern: 'hd_radiance', region: 'left-cheek', rawScore: left },
      ]
      const withoutRadiance = (rows: Row[]) => rows.filter((row) => row.concern !== 'hd_radiance')
      const pore = fainterGlow({ hd_pore: 'clear' })
      const dayOne = [...withoutRadiance(GLOW_DAY_ONE), ...regions(50, 30)]

      // left-cheek sorts first: flat at 50 while only right-cheek rose.
      expect(call({ goal: 'glow', results: [...withoutRadiance(pore), ...regions(50, 60)], dayOneResults: dayOne })).toBeNull()
      // left-cheek rose.
      expect(call({ goal: 'glow', results: [...withoutRadiance(pore), ...regions(60, 30)], dayOneResults: dayOne })).toBe('clear-skin')
    })
  })

  describe('scoring the other goals', () => {
    it.each([
      ['clear', 'clear-skin'],
      ['some', 'clear-skin'],
      ['a-little', 'clear-skin'],
      ['faint', null],
    ] as const)('counts a concern that is %s as visible only when it is not faint', (band, expected) => {
      expect(call({ goal: 'glow', results: fainterGlow({ hd_pore: band }), dayOneResults: GLOW_DAY_ONE })).toBe(expected)
    })

    // Brighter is the only goal with dark circles, and (with the wish) the only way to put them against clear-skin's pores and shine, so the two are
    // set against each other. The weights are clear 3, some 2, a-little 1, faint 0, pinned by sums that tie or just differ.
    const lighter = (bands: Partial<Record<ShownConcern, BandName>>) => call({ goal: 'glow', results: fainterGlow(bands), dayOneResults: GLOW_DAY_ONE, everWantedLighter: true })

    it('weighs clear as 3: one clear concern ties with a some (2) plus an a-little (1), and the tie goes to the earlier goal', () => {
      expect(lighter({ hd_dark_circle: 'clear', hd_pore: 'some', hd_oiliness: 'a-little' })).toBe('clear-skin')
    })

    it('weighs clear as more than two a-littles (2)', () => {
      expect(lighter({ hd_dark_circle: 'clear', hd_pore: 'a-little', hd_oiliness: 'a-little' })).toBe('brighter')
    })

    it('weighs some as 2: it ties with two a-littles, and beats one', () => {
      expect(lighter({ hd_dark_circle: 'some', hd_pore: 'a-little', hd_oiliness: 'a-little' })).toBe('clear-skin')
      expect(lighter({ hd_dark_circle: 'some', hd_pore: 'a-little' })).toBe('brighter')
    })

    it('weighs a-little as 1: one beats a faint (0) and loses to a some (2)', () => {
      expect(lighter({ hd_dark_circle: 'a-little' })).toBe('brighter')
      expect(lighter({ hd_dark_circle: 'a-little', hd_pore: 'some' })).toBe('clear-skin')
    })

    it('adds the three concerns of a goal together', () => {
      // clear-skin: acne a-little + pore a-little + oiliness a-little = 3, against brighter dark circle some = 2.
      expect(lighter({ hd_dark_circle: 'some', hd_acne: 'a-little', hd_pore: 'a-little', hd_oiliness: 'a-little' })).toBe('clear-skin')
    })

    it('leaves out the concerns the current goal shares, scoring only each candidate\'s other concerns', () => {
      // Even-tone's age spot, redness and radiance; fade-dark-marks, brighter and calm-repair share some. Without the exclusion calm-repair (redness 3 + moisture 2
      // + texture 1) wins; with it, calm-repair has moisture and texture only (3), and glow has the same (3), so the earlier, glow, wins.
      const dayOne = dayOneRows({ hd_age_spot: 50, hd_redness: 50, hd_radiance: 50 })
      const results = rowsOf({ hd_age_spot: 'clear', hd_redness: 'clear', hd_moisture: 'some', hd_texture: 'a-little' }).map((row) => (row.concern === 'hd_radiance' ? { ...row, rawScore: 56 } : row))

      expect(call({ goal: 'even-tone', results, dayOneResults: dayOne })).toBe('glow')
    })

    it('gives null when only the concerns the current goal shares can be seen', () => {
      const dayOne = dayOneRows({ hd_age_spot: 50, hd_redness: 50, hd_radiance: 50 })
      const results = rowsOf({ hd_age_spot: 'clear', hd_redness: 'clear' }).map((row) => (row.concern === 'hd_radiance' ? { ...row, rawScore: 56 } : row))

      expect(call({ goal: 'even-tone', results, dayOneResults: dayOne })).toBeNull()
    })

    it('goes to the highest score', () => {
      // clear-skin pore some (2) against calm-repair... glow current: even-tone redness clear (3).
      expect(call({ goal: 'glow', results: fainterGlow({ hd_pore: 'some', hd_redness: 'clear' }), dayOneResults: GLOW_DAY_ONE })).toBe('even-tone')
    })

    it('breaks a tie by the fixed goal order, here taking the earliest of three that tie', () => {
      // Current clear-skin (acne, pore, oiliness): texture clear gives fade-dark-marks, glow and calm-repair 3 each.
      const dayOne = dayOneRows({ hd_acne: 50, hd_pore: 50, hd_oiliness: 50 })
      const results = rowsOf({ hd_texture: 'clear' }).map((row) => (row.concern === 'hd_acne' ? { ...row, rawScore: 56 } : row))

      expect(call({ goal: 'clear-skin', results, dayOneResults: dayOne })).toBe('fade-dark-marks')
    })

    it('breaks the same tie the same way whatever order the rows come in', () => {
      const dayOne = dayOneRows({ hd_acne: 50, hd_pore: 50, hd_oiliness: 50 })
      const results = rowsOf({ hd_texture: 'clear' }).map((row) => (row.concern === 'hd_acne' ? { ...row, rawScore: 56 } : row))

      expect(call({ goal: 'clear-skin', results: [...results].reverse(), dayOneResults: [...dayOne].reverse() })).toBe('fade-dark-marks')
    })

    it('gives null when every score is 0', () => {
      expect(call({ goal: 'glow', results: fainterGlow({}), dayOneResults: GLOW_DAY_ONE, everWantedLighter: true })).toBeNull()
    })

    it('counts a concern with no row as 0', () => {
      const withoutPore = fainterGlow({ hd_pore: 'clear' }).filter((row) => row.concern !== 'hd_pore')
      const justRadiance = [{ concern: 'hd_radiance', region: 'whole', rawScore: 56 }]

      expect(call({ goal: 'glow', results: withoutPore, dayOneResults: GLOW_DAY_ONE })).toBeNull()
      expect(call({ goal: 'glow', results: justRadiance, dayOneResults: GLOW_DAY_ONE })).toBeNull()
    })

    it('scores from the whole-face row where there is one, and the first region by name where there is not', () => {
      const wholeFaint = [...fainterGlow({}).filter((row) => row.concern !== 'hd_pore'), { concern: 'hd_pore', region: 'whole', rawScore: AT.hd_pore.faint }, { concern: 'hd_pore', region: 'a-cheek', rawScore: AT.hd_pore.clear }]
      const regionsOnly = [...fainterGlow({}).filter((row) => row.concern !== 'hd_pore'), { concern: 'hd_pore', region: 'b-cheek', rawScore: AT.hd_pore.faint }, { concern: 'hd_pore', region: 'a-cheek', rawScore: AT.hd_pore.clear }]

      expect(call({ goal: 'glow', results: wholeFaint, dayOneResults: GLOW_DAY_ONE })).toBeNull()
      expect(call({ goal: 'glow', results: regionsOnly, dayOneResults: GLOW_DAY_ONE })).toBe('clear-skin')
    })
  })

  describe('brighter', () => {
    it('is never suggested unless the profile ever wanted lighter, however plainly its concerns can be seen', () => {
      const results = fainterGlow({ hd_dark_circle: 'clear' })

      expect(call({ goal: 'glow', results, dayOneResults: GLOW_DAY_ONE, everWantedLighter: false })).toBeNull()
    })

    it('is suggested when the profile ever wanted lighter and its concerns score highest', () => {
      const results = fainterGlow({ hd_dark_circle: 'clear' })

      expect(call({ goal: 'glow', results, dayOneResults: GLOW_DAY_ONE, everWantedLighter: true })).toBe('brighter')
    })

    it('does not outrank a goal that scores higher just because the wish was made', () => {
      const results = fainterGlow({ hd_dark_circle: 'a-little', hd_pore: 'clear' })

      expect(call({ goal: 'glow', results, dayOneResults: GLOW_DAY_ONE, everWantedLighter: true })).toBe('clear-skin')
    })

    it('never returns the current goal, whichever goal that is, even with every other concern plain to see', () => {
      for (const goal of GOALS) {
        const own = GOAL_CONCERNS[goal]
        const dayOne = dayOneRows(Object.fromEntries(own.map((concern) => [concern, 50])))
        const results = SHOWN_CONCERNS.map((concern) => ({ concern, region: 'whole', rawScore: (own as readonly string[]).includes(concern) ? 56 : AT[concern].clear }))

        const next = call({ goal, results, dayOneResults: dayOne, everWantedLighter: true })

        expect(next).not.toBeNull()
        expect(next).not.toBe(goal)
      }
    })
  })

  describe('purity', () => {
    it('gives the same answer for the same inputs, every time', () => {
      const input = { goal: 'glow' as const, results: fainterGlow({ hd_pore: 'some', hd_redness: 'some' }), dayOneResults: GLOW_DAY_ONE, everWantedLighter: true }

      expect([nextGoalFor(input), nextGoalFor(input), nextGoalFor(input)]).toEqual(['clear-skin', 'clear-skin', 'clear-skin'])
    })

    it('does not change its inputs, and reads them frozen', () => {
      const results = fainterGlow({ hd_pore: 'some' })
      results.push({ concern: 'hd_redness', region: 'right', rawScore: 70 }, { concern: 'hd_redness', region: 'left', rawScore: 71 })
      const dayOneResults = [...GLOW_DAY_ONE]
      const before = structuredClone({ results, dayOneResults })
      for (const row of [...results, ...dayOneResults]) Object.freeze(row)
      Object.freeze(results)
      Object.freeze(dayOneResults)

      expect(nextGoalFor({ goal: 'glow', results, dayOneResults, everWantedLighter: true })).toBe('clear-skin')
      expect({ results, dayOneResults }).toEqual(before)
    })
  })
})
