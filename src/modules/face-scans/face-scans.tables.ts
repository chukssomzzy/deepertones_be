import type { Goal } from '../goals/goals.vocabulary'

// The face-scan rules: pure, versioned tables over what Perfect Corp measures. No I/O, no clock, no model, so the same results always give
// the same words, and a change to any of them is a reviewed change to this file. Each table has a version that a stored result carries,
// so a client can tell which rules wrote what it shows.
//
// Perfect Corp scores run 1 to 100 and HIGHER IS HEALTHIER. Everything here reads `raw_score`, never `ui_score`.
//
// EVERY NUMBER BELOW IS A PLACEHOLDER to calibrate against real staging results before launch, and none has been checked on darker skin
// (see CONTEXT.md). Changing one means bumping that table's version.

export const GOAL_CONCERNS_VERSION = 1
export const VISIBILITY_VERSION = 1
export const WORDING_VERSION = 1
export const SKIN_TYPE_VERSION = 1
export const CHANGE_VERSION = 1

/** Every table's version as one text. A stored result carries it (face_scans.tables_version), so a client can tell which rules were in force when it was read. */
export const TABLES_VERSION = `concerns:${GOAL_CONCERNS_VERSION},visibility:${VISIBILITY_VERSION},wording:${WORDING_VERSION},skin-type:${SKIN_TYPE_VERSION},change:${CHANGE_VERSION}`

/** A concern a goal can show. `hd_skin_type` is also asked for, but it is the skin type label and never a seen-words concern. */
export type ShownConcern =
  | 'hd_acne'
  | 'hd_pore'
  | 'hd_oiliness'
  | 'hd_age_spot'
  | 'hd_redness'
  | 'hd_radiance'
  | 'hd_texture'
  | 'hd_dark_circle'
  | 'hd_moisture'

/** How much of a concern can be seen, from the faintest. A score that is not visible has no band. */
export type Band = 'a-little' | 'some' | 'clear'

const HD_SKIN_TYPE = 'hd_skin_type'

// Three concerns per goal, in the order they are shown.
const GOAL_CONCERNS: Record<Goal, readonly [ShownConcern, ShownConcern, ShownConcern]> = {
  'clear-skin': ['hd_acne', 'hd_pore', 'hd_oiliness'],
  'even-tone': ['hd_age_spot', 'hd_redness', 'hd_radiance'],
  'fade-dark-marks': ['hd_age_spot', 'hd_acne', 'hd_texture'],
  brighter: ['hd_radiance', 'hd_dark_circle', 'hd_age_spot'],
  glow: ['hd_radiance', 'hd_moisture', 'hd_texture'],
  'calm-repair': ['hd_redness', 'hd_moisture', 'hd_texture'],
}

// A Map, not the object: a name like "toString" or "__proto__" finds nothing in it, so it is refused rather than answered with an
// inherited member.
const CONCERNS_BY_GOAL: ReadonlyMap<string, readonly ShownConcern[]> = new Map(Object.entries(GOAL_CONCERNS))

/** The three concerns to show for a goal. Throws for anything that is not a goal: a typo must not quietly cost a different analysis. A fresh list each time. */
export const concernsForGoal = (goal: Goal): ShownConcern[] => {
  const concerns = CONCERNS_BY_GOAL.get(goal)
  if (!concerns) throw new Error(`Not a goal: ${JSON.stringify(goal)}`)
  return [...concerns]
}

/** What to ask Perfect Corp for: the goal's three concerns and the skin type, which is four actions (the HD 1 to 4 tier). */
export const hdActionsForGoal = (goal: Goal): (ShownConcern | typeof HD_SKIN_TYPE)[] => [...concernsForGoal(goal), HD_SKIN_TYPE]

// A concern is visible at or below `visible`, and the band is how far below: (some, visible] is a-little, (clear, some] is some, and
// clear or less is clear.
type Thresholds = { visible: number; some: number; clear: number }
const SAME: Thresholds = { visible: 60, some: 45, clear: 30 }
const THRESHOLDS: ReadonlyMap<string, Thresholds> = new Map<ShownConcern, Thresholds>([
  ['hd_acne', SAME],
  ['hd_pore', SAME],
  ['hd_oiliness', SAME],
  ['hd_age_spot', SAME],
  ['hd_redness', SAME],
  ['hd_radiance', SAME],
  ['hd_texture', SAME],
  ['hd_dark_circle', SAME],
  ['hd_moisture', SAME],
])

/** Which band a raw_score is in for a concern, or null when it is not clearly enough visible to show. */
export const bandFor = (concern: ShownConcern, rawScore: number): Band | null => {
  const thresholds = THRESHOLDS.get(concern)
  if (!thresholds) throw new Error(`Not a concern that is shown: ${JSON.stringify(concern)}`)
  if (rawScore > thresholds.visible) return null
  if (rawScore <= thresholds.clear) return 'clear'
  return rawScore <= thresholds.some ? 'some' : 'a-little'
}

export const isVisible = (concern: ShownConcern, rawScore: number): boolean => bandFor(concern, rawScore) !== null

// What can be seen, in plain words, never what it is called. Each text is short and calm and describes the face, not the person: it names
// no condition, never says "you have", never says "acne" (spots and breakouts are what show), carries no number, and never talks of
// lightness. face-scans.tables.test.ts scans every string for those, so a new one fails there before it ships.
//
// `whole` is the answer for the whole face and for any region without words of its own. Regions with words of their own are added here
// once Perfect Corp's region names are confirmed against a real staging response.
export const WORDING: Record<ShownConcern, Record<Band, { whole: string } & Partial<Record<string, string>>>> = {
  hd_acne: {
    'a-little': { whole: 'A few small spots here and there' },
    some: { whole: 'Some spots and breakouts across the face' },
    clear: { whole: 'Many spots and breakouts across the face' },
  },
  hd_pore: {
    'a-little': { whole: 'Pores a little more open in places' },
    some: { whole: 'Open pores in several places' },
    clear: { whole: 'Open pores across much of the face' },
  },
  hd_oiliness: {
    'a-little': { whole: 'A little shine on the skin' },
    some: { whole: 'Some shine across the face' },
    clear: { whole: 'Shine across much of the face' },
  },
  hd_age_spot: {
    'a-little': { whole: 'A few faint dark marks' },
    some: { whole: 'Some dark marks across the face' },
    clear: { whole: 'Many dark marks across the face' },
  },
  hd_redness: {
    'a-little': { whole: 'A little redness in places' },
    some: { whole: 'Some redness across the face' },
    clear: { whole: 'Redness across much of the face' },
  },
  hd_radiance: {
    'a-little': { whole: 'A little less glow in places' },
    some: { whole: 'Less glow across the face' },
    clear: { whole: 'Less glow across most of the face' },
  },
  hd_texture: {
    'a-little': { whole: 'A little roughness in places' },
    some: { whole: 'Some rough, uneven patches' },
    clear: { whole: 'Rough, uneven skin across much of the face' },
  },
  hd_dark_circle: {
    'a-little': { whole: 'A little darkness under the eyes' },
    some: { whole: 'Some darkness under the eyes' },
    clear: { whole: 'Darkness under the eyes that is easy to see' },
  },
  hd_moisture: {
    'a-little': { whole: 'A little dryness in places' },
    some: { whole: 'Some dry patches' },
    clear: { whole: 'Dry patches across much of the face' },
  },
}

/** The words for a concern at a band in a region; the whole-face words when the region has none of its own. */
export const seenWords = (concern: ShownConcern, band: Band, region: string): string => {
  const regions = WORDING[concern][band]
  return (Object.hasOwn(regions, region) ? regions[region] : undefined) ?? regions.whole
}

export type SkinTypeLabel = 'oily' | 'dry' | 'combination' | 'normal'

// Perfect Corp's own text for a region is the type, optionally with "Redness" added: "Dry", "Dry & Redness", "Oily and Redness", and plain
// "Redness", which has no oil or dryness to name and so reads as normal. Anything else is a type this table does not know.
const SKIN_TYPE_TEXT = /^(?:(oily|dry|combination|normal)(?:\s*(?:&|and)\s*redness)?|(redness))$/

/**
 * The skin type label from Perfect Corp's `hd_skin_type` items, read from the whole-face item only: the t_zone and u_zone items are
 * not averaged into a guess. Null when there is no whole-face item or its text is not a type this table knows.
 */
export const skinTypeLabel = (items: readonly { region: string; skinType: string }[]): SkinTypeLabel | null => {
  const text = items.find((item) => item.region === 'whole')?.skinType
  if (typeof text !== 'string') return null
  const match = SKIN_TYPE_TEXT.exec(text.trim().toLowerCase())
  if (!match) return null
  return (match[1] as SkinTypeLabel | undefined) ?? 'normal'
}

// The difference between two scans of the same face that is ordinary variation (lighting, angle, time of day). A change counts only when it
// is BIGGER than this; exactly this much is still noise.
const CONCERN_NOISE = 5
const SKIN_AGE_NOISE = 2

export type ConcernChange = 'fainter' | 'more visible' | 'no clear change'
export type SkinAgeChange = 'younger' | 'older' | 'no clear change'

/** Change in a goal concern since day one. A higher raw_score is healthier, so a rise is "fainter". Never a word about lightness. */
export const concernChange = (baseline: number, current: number): ConcernChange => {
  const change = current - baseline
  if (change > CONCERN_NOISE) return 'fainter'
  return change < -CONCERN_NOISE ? 'more visible' : 'no clear change'
}

export const skinAgeChange = (baseline: number, current: number): SkinAgeChange => {
  const change = current - baseline
  if (change > SKIN_AGE_NOISE) return 'older'
  return change < -SKIN_AGE_NOISE ? 'younger' : 'no clear change'
}

/** The skin age as a plain fact, a whole number. It has no real age to compare with, so it never compares. */
export const skinAgeWords = (skinAge: number): string => `Your skin looks about ${Math.round(skinAge)}`

/** What the app calls a concern. Never Perfect Corp's name: that is theirs to change, and the app must not depend on it. */
export type ConcernId = 'spots' | 'pores' | 'shine' | 'marks' | 'redness' | 'glow' | 'texture' | 'under-eyes' | 'dryness'

export const CONCERN_IDS: Record<ShownConcern, ConcernId> = {
  hd_acne: 'spots',
  hd_pore: 'pores',
  hd_oiliness: 'shine',
  hd_age_spot: 'marks',
  hd_redness: 'redness',
  hd_radiance: 'glow',
  hd_texture: 'texture',
  hd_dark_circle: 'under-eyes',
  hd_moisture: 'dryness',
}

// The words for a change since day one. "fainter" is the healthy direction (the score rose), so for radiance it reads as more glow. Like the
// seen-words, none talks of lightness; face-scans.tables.test.ts scans every one.
const CHANGE_WORDS: Record<ShownConcern, Record<ConcernChange, string>> = {
  hd_acne: { fainter: 'Spots look fainter than on day one', 'more visible': 'Spots look more visible than on day one', 'no clear change': 'No clear change in spots since day one' },
  hd_pore: { fainter: 'Pores look less open than on day one', 'more visible': 'Pores look more open than on day one', 'no clear change': 'No clear change in pores since day one' },
  hd_oiliness: { fainter: 'Less shine than on day one', 'more visible': 'More shine than on day one', 'no clear change': 'No clear change in shine since day one' },
  hd_age_spot: { fainter: 'Marks look fainter than on day one', 'more visible': 'Marks look more visible than on day one', 'no clear change': 'No clear change in marks since day one' },
  hd_redness: { fainter: 'Redness looks fainter than on day one', 'more visible': 'Redness looks more visible than on day one', 'no clear change': 'No clear change in redness since day one' },
  hd_radiance: { fainter: 'More glow than on day one', 'more visible': 'Less glow than on day one', 'no clear change': 'No clear change in glow since day one' },
  hd_texture: { fainter: 'Skin looks smoother than on day one', 'more visible': 'Skin looks rougher than on day one', 'no clear change': 'No clear change in smoothness since day one' },
  hd_dark_circle: {
    fainter: 'Under-eye shadows look fainter than on day one',
    'more visible': 'Under-eye shadows look more visible than on day one',
    'no clear change': 'No clear change under the eyes since day one',
  },
  hd_moisture: { fainter: 'Skin looks less dry than on day one', 'more visible': 'Skin looks drier than on day one', 'no clear change': 'No clear change in dryness since day one' },
}

export const changeWords = (concern: ShownConcern, change: ConcernChange): string => CHANGE_WORDS[concern][change]

/** The skin age change in words. `years` is the whole number of years apart, at least 1; it is only said for a change. */
export const skinAgeChangeWords = (change: SkinAgeChange, years: number): string => {
  if (change === 'no clear change') return 'No clear change in skin age since day one'
  return `Your skin looks about ${years} year${years === 1 ? '' : 's'} ${change} than on day one`
}

export const NOTHING_STANDS_OUT = 'Nothing stands out for your goal right now'

/** A stored concern score: the one number the rules read. */
type ScoreRow = { concern: string; region: string; rawScore: number }

type ViewConcernChange = 'fainter' | 'more-visible' | 'no-clear-change'
type ViewSkinAgeChange = 'younger' | 'older' | 'no-clear-change'

export type ResultView = {
  seen: { concern: ConcernId; region: string; words: string; overlay: { url: string } | null }[]
  nothingStandsOut: string | null
  skinType: SkinTypeLabel | null
  skinAge: { years: number; words: string } | null
  sinceDayOne: {
    dayOneScanId: string
    dayOneAt: Date
    concerns: { concern: ConcernId; change: ViewConcernChange; words: string }[]
    skinAge: { change: ViewSkinAgeChange; words: string } | null
  } | null
  tablesVersion: string
}

// The API spells a change with hyphens; the tables' own values keep their spaces.
const CONCERN_CHANGE_IDS: Record<ConcernChange, ViewConcernChange> = { fainter: 'fainter', 'more visible': 'more-visible', 'no clear change': 'no-clear-change' }
const SKIN_AGE_CHANGE_IDS: Record<SkinAgeChange, ViewSkinAgeChange> = { younger: 'younger', older: 'older', 'no clear change': 'no-clear-change' }

/** The row to read for a concern: the whole-face one, else the first region by name. Null when the scan has no row for it. */
const rowFor = (results: readonly ScoreRow[], concern: ShownConcern): ScoreRow | null => {
  const rows = results.filter((row) => row.concern === concern)
  return rows.find((row) => row.region === 'whole') ?? rows.sort((a, b) => (a.region < b.region ? -1 : a.region > b.region ? 1 : 0))[0] ?? null
}

/** The goal's concerns that can be seen in these rows, in goal order, each with the row read and its band. The same rule `resultView` shows by. */
export const shownConcerns = (goal: Goal, results: readonly ScoreRow[]): { concern: ShownConcern; row: ScoreRow; band: Band }[] => {
  const shown: ReturnType<typeof shownConcerns> = []
  for (const concern of concernsForGoal(goal)) {
    const row = rowFor(results, concern)
    const band = row ? bandFor(concern, row.rawScore) : null
    if (row && band) shown.push({ concern, row, band })
  }
  return shown
}

/**
 * What the app shows for a ready scan, from the stored rows alone: the goal's concerns that can be seen, the skin reading, and how each concern has
 * moved since day one. The words are worked out here, when read, so a change to the tables reaches scans already stored. `overlays` are already signed
 * links by Perfect Corp concern; only a concern that is shown keeps its link. Never holds a score, a Perfect Corp name or a condition.
 */
export const resultView = (input: {
  goal: Goal
  results: readonly ScoreRow[]
  overlays: Partial<Record<string, { url: string }>>
  skinType: SkinTypeLabel | null
  skinAge: number | null
  dayOne: { id: string; createdAt: Date; results: readonly ScoreRow[]; skinAge: number | null } | null
}): ResultView => {
  const { goal, results, overlays, skinType, skinAge, dayOne } = input
  const concerns = concernsForGoal(goal)
  const seen: ResultView['seen'] = shownConcerns(goal, results).map(({ concern, row, band }) => ({
    concern: CONCERN_IDS[concern],
    region: row.region,
    words: seenWords(concern, band, row.region),
    overlay: overlays[concern] ? { url: overlays[concern].url } : null,
  }))

  let sinceDayOne: ResultView['sinceDayOne'] = null
  if (dayOne) {
    const changes: NonNullable<ResultView['sinceDayOne']>['concerns'] = []
    for (const concern of concerns) {
      const now = rowFor(results, concern)
      const before = rowFor(dayOne.results, concern)
      // A cheek score is not the whole face's: rows for different regions are not comparable, so that concern is left out.
      if (!now || !before || now.region !== before.region) continue
      const change = concernChange(before.rawScore, now.rawScore)
      changes.push({ concern: CONCERN_IDS[concern], change: CONCERN_CHANGE_IDS[change], words: changeWords(concern, change) })
    }
    let ageChange: NonNullable<ResultView['sinceDayOne']>['skinAge'] = null
    if (skinAge !== null && dayOne.skinAge !== null) {
      const change = skinAgeChange(dayOne.skinAge, skinAge)
      ageChange = { change: SKIN_AGE_CHANGE_IDS[change], words: skinAgeChangeWords(change, Math.max(1, Math.round(Math.abs(skinAge - dayOne.skinAge)))) }
    }
    sinceDayOne = { dayOneScanId: dayOne.id, dayOneAt: dayOne.createdAt, concerns: changes, skinAge: ageChange }
  }

  return {
    seen,
    nothingStandsOut: seen.length === 0 ? NOTHING_STANDS_OUT : null,
    skinType,
    skinAge: skinAge === null ? null : { years: Math.round(skinAge), words: skinAgeWords(skinAge) },
    sinceDayOne,
    tablesVersion: TABLES_VERSION,
  }
}
