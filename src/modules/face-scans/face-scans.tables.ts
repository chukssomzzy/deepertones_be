import { GOALS, type Goal } from '../goals/goals.vocabulary'

// The face-scan rules: pure, versioned tables over what Perfect Corp measures. No I/O, no clock, no model, so the same results always give
// the same words, and a change to any of them is a reviewed change to this file. Each table has a version that a stored result carries,
// so a client can tell which rules wrote what it shows.
//
// Perfect Corp scores run 1 to 100 and HIGHER IS HEALTHIER. Everything here reads `raw_score`, never `ui_score`.
//
// The visibility cut-offs were calibrated on 2026-10-23 (see below). The noise thresholds for a change since day one are still placeholders to calibrate
// against real staging results, and the overlays and skin age have not been checked on darker skin (see CONTEXT.md). Changing a number means bumping that
// table's version.

export const GOAL_CONCERNS_VERSION = 2
export const VISIBILITY_VERSION = 3
export const WORDING_VERSION = 2
export const SKIN_TYPE_VERSION = 1
export const CHANGE_VERSION = 1
export const CHASE_VERSION = 1
export const REVIEW_VERSION = 1
export const SPACING_VERSION = 1
export const NEXT_GOAL_VERSION = 1
/** A new chase's first scan waits this many days after the profile's last day-one scan, under any goal. */
export const SCAN_SPACING_DAYS = 30

/** Every table's version as one text. A stored result carries it (face_scans.tables_version), so a client can tell which rules were in force when it was read. */
export const TABLES_VERSION = `concerns:${GOAL_CONCERNS_VERSION},visibility:${VISIBILITY_VERSION},wording:${WORDING_VERSION},skin-type:${SKIN_TYPE_VERSION},change:${CHANGE_VERSION},chase:${CHASE_VERSION},review:${REVIEW_VERSION},spacing:${SPACING_VERSION},next-goal:${NEXT_GOAL_VERSION}`

/** A goal left and taken up again within this many days of leaving continues its chase; any longer and the goal starts fresh (issue #145). */
export const RESUME_DAYS = 90

/** The concerns a goal can show. `hd_skin_type` is also asked for, but it is the skin type label and never a seen-words concern. */
export const SHOWN_CONCERNS = ['hd_acne', 'hd_pore', 'hd_oiliness', 'hd_age_spot', 'hd_redness', 'hd_radiance', 'hd_texture', 'hd_dark_circle', 'hd_moisture'] as const
export type ShownConcern = (typeof SHOWN_CONCERNS)[number]

/**
 * How much of a concern can be seen, from the faintest. `faint` is a score above the visible cut-off: it is shown (every goal concern Perfect Corp
 * measured is shown, because the cut-offs are a first calibration) but worded as hardly there, never claimed to be clearly seen.
 */
export type Band = 'faint' | 'a-little' | 'some' | 'clear'

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

// Measured for every goal whatever it is: the routine stage needs the whole picture (a glow user with spots needs products that do not clog pores; on
// darker skin dark marks are the most common concern of all), and a concern not measured on day one can never show change since day one.
const CORE_CONCERNS: readonly ShownConcern[] = ['hd_age_spot', 'hd_acne', 'hd_pore', 'hd_oiliness']

/** Everything measured for a goal: its own three in goal order, then the core concerns it lacks in core order. 4 to 7 concerns, a fresh list each time. */
export const measuredConcernsForGoal = (goal: Goal): ShownConcern[] => {
  const own = concernsForGoal(goal)
  return [...own, ...CORE_CONCERNS.filter((concern) => !own.includes(concern))]
}

/** What to ask Perfect Corp for: everything measured for the goal and the skin type, which is 5 to 8 actions (the HD 5 to 8 tier, 16 units). */
export const hdActionsForGoal = (goal: Goal): (ShownConcern | typeof HD_SKIN_TYPE)[] => [...measuredConcernsForGoal(goal), HD_SKIN_TYPE]

/**
 * What to ask Perfect Corp for at a chase's review point: every concern any goal can show, plus the skin type, whatever the goal is. Ten
 * actions (the HD 9 to 12 tier, 20 units), against 5 to 8 for a normal scan: the extra reads feed the next-goal rule, though the result still
 * shows only the goal's own three. A fresh list each time.
 */
export const hdActionsForCheckIn = (): (ShownConcern | typeof HD_SKIN_TYPE)[] => [...SHOWN_CONCERNS, HD_SKIN_TYPE]

// A concern is visible at or below `visible`, and the band is how far below: (some, visible] is a-little, (clear, some] is some, and
// clear or less is clear. Above `visible` is faint. Each concern has its own cut-offs because Perfect Corp's raw_score sits on a different range for each
// (moisture 27 to 61, redness 61 to 100), so one shared set hid dark marks and redness always and called almost every face dry.
//
// Calibrated 2026-10-23 on 40 Chicago Face Database photos (mostly Black, some Indian and multiracial) against blind visual ratings by an AI rater. This
// is a first calibration, to be re-checked by a human rater experienced with skin of colour and on real app selfies. Redness, texture and moisture are
// low-confidence, see LOW_CONFIDENCE_CONCERNS (redness was at chance on the darker half, texture and moisture barely tracked the ratings). Evidence:
// .humanlayer/tasks/face-scan/research-visibility-thresholds.md.
type Thresholds = { visible: number; some: number; clear: number }
const THRESHOLDS: ReadonlyMap<string, Thresholds> = new Map<ShownConcern, Thresholds>([
  ['hd_acne', { visible: 68, some: 60, clear: 55 }],
  ['hd_age_spot', { visible: 86, some: 81, clear: 76 }],
  ['hd_pore', { visible: 60, some: 43, clear: 25 }],
  ['hd_oiliness', { visible: 82, some: 72, clear: 62 }],
  ['hd_redness', { visible: 95, some: 80, clear: 65 }],
  ['hd_radiance', { visible: 75, some: 68, clear: 62 }],
  ['hd_texture', { visible: 40, some: 30, clear: 20 }],
  ['hd_dark_circle', { visible: 60, some: 54, clear: 48 }],
  ['hd_moisture', { visible: 33, some: 30, clear: 28 }],
])

/** The concerns the first calibration could not stand behind. */
export const LOW_CONFIDENCE_CONCERNS: readonly ShownConcern[] = ['hd_redness', 'hd_texture', 'hd_moisture']

/** Which band a raw_score is in for a concern: `faint` when it is above the visible cut-off. */
export const bandFor = (concern: ShownConcern, rawScore: number): Band => {
  const thresholds = THRESHOLDS.get(concern)
  if (!thresholds) throw new Error(`Not a concern that is shown: ${JSON.stringify(concern)}`)
  if (rawScore > thresholds.visible) return 'faint'
  if (rawScore <= thresholds.clear) return 'clear'
  return rawScore <= thresholds.some ? 'some' : 'a-little'
}

/** Whether a score is visible, which is to say not faint. */
export const isVisible = (concern: ShownConcern, rawScore: number): boolean => bandFor(concern, rawScore) !== 'faint'

// What can be seen, in plain words, never what it is called. Each text is short and calm and describes the face, not the person: it names
// no condition, never says "you have", never says "acne" (spots and breakouts are what show), carries no number, and never talks of
// lightness. face-scans.tables.test.ts scans every string for those, so a new one fails there before it ships.
//
// `whole` is the answer for the whole face and for any region without words of its own. Regions with words of their own are added here
// once Perfect Corp's region names are confirmed against a real staging response.
export const WORDING: Record<ShownConcern, Record<Band, { whole: string } & Partial<Record<string, string>>>> = {
  hd_acne: {
    faint: { whole: 'Hardly any spots' },
    'a-little': { whole: 'A few small spots here and there' },
    some: { whole: 'Some spots and breakouts across the face' },
    clear: { whole: 'Many spots and breakouts across the face' },
  },
  hd_pore: {
    faint: { whole: 'Hardly any open pores' },
    'a-little': { whole: 'Pores a little more open in places' },
    some: { whole: 'Open pores in several places' },
    clear: { whole: 'Open pores across much of the face' },
  },
  hd_oiliness: {
    faint: { whole: 'Hardly any shine' },
    'a-little': { whole: 'A little shine on the skin' },
    some: { whole: 'Some shine across the face' },
    clear: { whole: 'Shine across much of the face' },
  },
  hd_age_spot: {
    faint: { whole: 'Hardly any dark marks' },
    'a-little': { whole: 'A few faint dark marks' },
    some: { whole: 'Some dark marks across the face' },
    clear: { whole: 'Many dark marks across the face' },
  },
  hd_redness: {
    faint: { whole: 'Hardly any redness' },
    'a-little': { whole: 'A little redness in places' },
    some: { whole: 'Some redness across the face' },
    clear: { whole: 'Redness across much of the face' },
  },
  hd_radiance: {
    faint: { whole: 'An even glow across the face' },
    'a-little': { whole: 'A little less glow in places' },
    some: { whole: 'Less glow across the face' },
    clear: { whole: 'Less glow across most of the face' },
  },
  hd_texture: {
    faint: { whole: 'Skin looks smooth' },
    'a-little': { whole: 'A little roughness in places' },
    some: { whole: 'Some rough, uneven patches' },
    clear: { whole: 'Rough, uneven skin across much of the face' },
  },
  hd_dark_circle: {
    faint: { whole: 'Hardly any darkness under the eyes' },
    'a-little': { whole: 'A little darkness under the eyes' },
    some: { whole: 'Some darkness under the eyes' },
    clear: { whole: 'Darkness under the eyes that is easy to see' },
  },
  hd_moisture: {
    faint: { whole: 'Hardly any dry patches' },
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

export const SKIN_TYPE_LABELS = ['oily', 'dry', 'combination', 'normal'] as const
export type SkinTypeLabel = (typeof SKIN_TYPE_LABELS)[number]

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

type SeenItem = { concern: ConcernId; region: string; level: Band; words: string; overlay: { url: string } | null }

export type ResultView = {
  seen: SeenItem[]
  alsoNoticed: SeenItem[]
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

/** The goal's concerns that have a row in these results, in goal order, each with the row read and its band (faint included). The same rule `resultView` shows by. */
export const shownConcerns = (goal: Goal, results: readonly ScoreRow[]): { concern: ShownConcern; row: ScoreRow; band: Band }[] => {
  const shown: ReturnType<typeof shownConcerns> = []
  for (const concern of concernsForGoal(goal)) {
    const row = rowFor(results, concern)
    if (row) shown.push({ concern, row, band: bandFor(concern, row.rawScore) })
  }
  return shown
}

/** The measured concerns outside the goal's own that have a row and can be seen (not faint), in core order, each with the row read and its band. The same rule `resultView` lists `alsoNoticed` by. */
export const noticedConcerns = (goal: Goal, results: readonly ScoreRow[]): { concern: ShownConcern; row: ScoreRow; band: Band }[] => {
  const own = concernsForGoal(goal)
  const noticed: ReturnType<typeof noticedConcerns> = []
  for (const concern of measuredConcernsForGoal(goal)) {
    if (own.includes(concern)) continue
    const row = rowFor(results, concern)
    if (!row) continue
    const band = bandFor(concern, row.rawScore)
    if (band !== 'faint') noticed.push({ concern, row, band })
  }
  return noticed
}

/**
 * What the app shows for a ready scan, from the stored rows alone: every one of the goal's concerns Perfect Corp measured (a faint one is worded as hardly
 * there), the skin reading, and how each concern has moved since day one. The words are worked out here, when read, so a change to the tables reaches scans
 * already stored. `alsoNoticed` is the other measured concerns that can be seen (not faint), in core order; a faint one stays stored for the routine
 * stage and is not shown. `overlays` are already signed links by Perfect Corp concern; only a concern that is shown keeps its link. Never holds a score, a
 * Perfect Corp name or a condition.
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
  const item = ({ concern, row, band }: { concern: ShownConcern; row: ScoreRow; band: Band }): SeenItem => ({
    concern: CONCERN_IDS[concern],
    region: row.region,
    level: band,
    words: seenWords(concern, band, row.region),
    overlay: overlays[concern] ? { url: overlays[concern].url } : null,
  })
  const seen = shownConcerns(goal, results).map(item)
  const alsoNoticed = noticedConcerns(goal, results).map(item)

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
    alsoNoticed,
    nothingStandsOut: seen.every(({ level }) => level === 'faint') ? NOTHING_STANDS_OUT : null,
    skinType,
    skinAge: skinAge === null ? null : { years: Math.round(skinAge), words: skinAgeWords(skinAge) },
    sinceDayOne,
    tablesVersion: TABLES_VERSION,
  }
}

const RESUME_WINDOW_MS = RESUME_DAYS * 24 * 60 * 60 * 1000

/**
 * The start of the chase of `goal` that `at` falls in, read from the profile's goal history alone (oldest first), or null when `goal` was not
 * current at `at`. A row is current from its `createdAt`, inclusive; a run of consecutive rows of the same goal is one chase so far, and a row
 * of any other goal, or a null goal (typed words nobody sorted yet), counts as leaving. Walking back from the chase that holds `at`: each time
 * the chase's start is reached, the detour just before it (every row back to the last row of `goal`, however many different goals it crossed)
 * is one step away, and the chase swallows it when the return is no more than RESUME_DAYS after the detour began; a longer gap stops the walk
 * with the chase as found so far. Exactly RESUME_DAYS continues it; a millisecond more starts a new chase.
 */
export const chaseStartFor = (history: readonly { goal: Goal | null; createdAt: Date }[], goal: Goal, at: Date): Date | null => {
  const atMs = at.getTime()
  let i = -1
  for (let row = 0; row < history.length; row++) {
    if (history[row]!.createdAt.getTime() > atMs) break
    i = row
  }
  if (i === -1 || history[i]!.goal !== goal) return null

  for (;;) {
    while (i > 0 && history[i - 1]!.goal === goal) i--
    const chaseStart = history[i]!.createdAt
    if (i === 0) return chaseStart
    // The detour right before this run: every row back to (but not including) the last time `goal` was current, whatever goals it crossed.
    let detourStart = i - 1
    while (detourStart > 0 && history[detourStart - 1]!.goal !== goal) detourStart--
    if (detourStart === 0) return chaseStart // nothing of `goal` earlier than the detour to merge with
    if (chaseStart.getTime() - history[detourStart]!.createdAt.getTime() > RESUME_WINDOW_MS) return chaseStart
    i = detourStart - 1
  }
}

// What a visible concern adds to a candidate goal's score: the plainer it is in the check-in, the more it counts. Faint and missing add nothing.
const NEXT_GOAL_WEIGHTS: Record<Band, number> = { clear: 3, some: 2, 'a-little': 1, faint: 0 }

/**
 * The goal to suggest at a chase's check-in, or null for none. Nothing is suggested until at least one of the goal's own concerns is fainter than on day
 * one (the same `concernChange` and noise as the result view; a concern read from different regions on the two scans, or missing on either, does not count,
 * as `sinceDayOne` skips it). Then every other goal is scored by the concerns it has that the current goal does not, each weighted by its band in the check-in
 * (clear 3, some 2, a-little 1, faint or missing 0), and the highest wins; a tie goes to the earlier goal in GOALS, and if every score is 0 there is
 * none. `brighter` is a candidate only when the profile ever wanted lighter: it is never offered unasked. Pure: the inputs are only read.
 */
export const nextGoalFor = (input: {
  goal: Goal
  results: readonly ScoreRow[]
  dayOneResults: readonly ScoreRow[]
  everWantedLighter: boolean
}): Goal | null => {
  const { goal, results, dayOneResults, everWantedLighter } = input
  const own = concernsForGoal(goal)

  const fainter = own.some((concern) => {
    const now = rowFor(results, concern)
    const before = rowFor(dayOneResults, concern)
    return now !== null && before !== null && now.region === before.region && concernChange(before.rawScore, now.rawScore) === 'fainter'
  })
  if (!fainter) return null

  let best: Goal | null = null
  let bestScore = 0
  for (const candidate of GOALS) {
    if (candidate === goal || (candidate === 'brighter' && !everWantedLighter)) continue
    let score = 0
    for (const concern of concernsForGoal(candidate)) {
      if (own.includes(concern)) continue
      const row = rowFor(results, concern)
      if (row) score += NEXT_GOAL_WEIGHTS[bandFor(concern, row.rawScore)]
    }
    // Strictly greater, so an equal score keeps the earlier goal.
    if (score > bestScore) {
      best = candidate
      bestScore = score
    }
  }
  return best
}

/**
 * Each goal's review week: how long after day one its chase is looked at again (issue #145, "Review point"). Every goal starts at 6, a
 * placeholder to tune per goal later as a reviewed change.
 */
export const REVIEW_WEEKS: Record<Goal, number> = {
  'clear-skin': 6,
  'even-tone': 6,
  'fade-dark-marks': 6,
  brighter: 6,
  glow: 6,
  'calm-repair': 6,
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000

/** A goal's review point: day one plus its review week, keeping day one's time of day. Does not mutate `dayOneAt`. */
export const reviewPointFor = (dayOneAt: Date, goal: Goal): Date => new Date(dayOneAt.getTime() + REVIEW_WEEKS[goal] * WEEK_MS)
