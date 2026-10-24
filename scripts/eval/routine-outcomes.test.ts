import { describe, expect, it } from 'vitest'
import type { OutcomeCounts } from '../../src/modules/routines/routines.outcomes'
import { applyOutcomes, type CountsFile, OutcomesError, outcomeNotePath, parseCountsFile, renderNote, runOutcomes } from './routine-outcomes'
import { type LabelSet, LabelSetError } from './routine-labels'
import { caseOf } from './routine.fixture'

// `npm run eval:routine:outcomes -- --counts FILE --labels v1 --out v2`: real outcomes (counts of what happened to users with each product) can overturn a
// labelled best. The rule is labelChange from routines.outcomes.ts (both groups at 30 users or more, a lead of at least 0.1 net fainter, and a 95% interval on
// the lead that excludes 0), which is NOT re-implemented here: every fixture below is chosen so that its answer is clear, with the arithmetic beside it, and was
// checked against the real function. Caution stays above outcomes: a case with a caution state is never changed.
//
// Counts are written c(n, fainter, flaredOrStopped, flared, both). Net fainter is (fainter - flaredOrStopped) / n.

const c = (n: number, fainter: number, flaredOrStopped = 0, flared = flaredOrStopped, both = 0): OutcomeCounts => ({ n, fainter, flared, flaredOrStopped, fainterAndFlaredOrStopped: both })
const product = (code: string, counts: OutcomeCounts) => ({ code, ...counts })

// B, the labelled best: 30 users and nobody fainter, nobody flared: net 0 and no spread (variance 0).
const ZERO = c(30, 0)
// An A that clearly beats ZERO: 30 of 30 fainter: net 1, variance 1 - 1 = 0, lead 1. With no spread the lead decides, so it is a change. 30 is MIN_USERS.
const ALL = c(30, 30)

const SNAPSHOT = 'a'.repeat(64)
const GROUP = { goal: 'glow', skinType: 'oily', country: 'NG' }
const group = (products: ReturnType<typeof product>[], over: Partial<typeof GROUP> = {}) => ({ ...GROUP, ...over, products })
const countsOf = (...groups: ReturnType<typeof group>[]): CountsFile => ({ groups })

const CASE = caseOf({ id: 'hold-01', goal: 'glow', country: 'NG', skinType: 'oily', cautions: [] })
const labelsOf = (cases: LabelSet['cases']): LabelSet => ({ version: 'v1', status: 'provisional', snapshotSha256: SNAPSHOT, cases })
/** Cleanse: C-1 best, C-2 acceptable. Moisturise: M-1 best, M-2 acceptable. */
const LABELS = labelsOf({
  'hold-01': {
    cleanse: { candidates: ['C-1', 'C-2'], best: 'C-1', acceptable: ['C-2'] },
    moisturise: { candidates: ['M-1', 'M-2'], best: 'M-1', acceptable: ['M-2'] },
  },
})
const apply = (counts: CountsFile, labels: LabelSet = LABELS, cases = [CASE]) => applyOutcomes(labels, counts, cases, 'v2')

describe('parseCountsFile', () => {
  const VALID = { groups: [{ ...GROUP, products: [{ code: 'C-1', n: 30, fainter: 3, flared: 1, flaredOrStopped: 2, fainterAndFlaredOrStopped: 1 }] }] }

  it('reads groups of goal, skin type and country, each with its products\' counts', () => {
    expect(parseCountsFile(VALID)).toEqual(VALID)
  })

  it('takes a null skin type, for people whose scan gave none', () => {
    const file = { groups: [{ ...VALID.groups[0]!, skinType: null }] }

    expect(parseCountsFile(file)).toEqual(file)
  })

  it('takes no groups at all', () => {
    expect(parseCountsFile({ groups: [] })).toEqual({ groups: [] })
  })

  const group0 = () => structuredClone(VALID.groups[0]!) as any
  const with0 = (change: (g: any) => void) => {
    const g = group0()
    change(g)
    return { groups: [g] }
  }
  it.each([
    ['something that is not an object', 'counts'],
    ['null', null],
    ['no groups', {}],
    ['groups that are not a list', { groups: 'all' }],
    ['a field the file does not have', { ...VALID, notes: 'x' }],
    ['a group field the file does not have', with0((g) => (g.region = 'north'))],
    ['a group with no goal', with0((g) => delete g.goal)],
    ['a group with no country', with0((g) => delete g.country)],
    ['a group with no products', with0((g) => delete g.products)],
    ['an empty country', with0((g) => (g.country = ''))],
    ['a product with no code', with0((g) => delete g.products[0].code)],
    ['a product with an empty code', with0((g) => (g.products[0].code = ''))],
    ['a product with a field the file does not have', with0((g) => (g.products[0].rating = 5))],
    ['a product with a count missing', with0((g) => delete g.products[0].flared)],
    ['a count that is negative', with0((g) => (g.products[0].fainter = -1))],
    ['a count that is not a whole number', with0((g) => (g.products[0].n = 30.5))],
    ['a count that is a string', with0((g) => (g.products[0].n = '30'))],
    ['counts that cannot come from real users: more fainter than users', with0((g) => (g.products[0].fainter = 31))],
    ['counts that cannot come from real users: more flared than flared-or-stopped', with0((g) => (g.products[0].flared = 3))],
    ['counts that cannot come from real users: both more than fainter', with0((g) => (g.products[0].fainterAndFlaredOrStopped = 5))],
    ['the same product twice in a group', with0((g) => g.products.push({ ...g.products[0] }))],
    ['the same group twice', { groups: [VALID.groups[0], VALID.groups[0]] }],
  ])('refuses %s', (_label, file) => {
    expect(() => parseCountsFile(file)).toThrow(OutcomesError)
  })

  it('never puts a number from the file in the message: counts can describe a real group of users', () => {
    const file = with0((g) => {
      g.products[0].n = 987654
      g.products[0].fainter = 987655
    })

    expect(() => parseCountsFile(file)).toThrow(OutcomesError)
    try {
      parseCountsFile(file)
    } catch (error) {
      expect((error as Error).message).not.toMatch(/9876/)
    }
  })
})

describe('applyOutcomes: a change applies only when labelChange says so', () => {
  it('makes A the best and the old best acceptable when A clearly leads, and records the change with both groups\' numbers', () => {
    const { labels, changes } = apply(countsOf(group([product('C-1', ZERO), product('C-2', ALL)])))

    expect(labels.cases['hold-01']!.cleanse).toEqual({ candidates: ['C-1', 'C-2'], best: 'C-2', acceptable: ['C-1'] })
    expect(changes).toEqual([{ caseId: 'hold-01', step: 'cleanse', oldBest: 'C-1', newBest: 'C-2', old: { n: 30, netFainter: 0 }, new: { n: 30, netFainter: 1 }, lift: 1 }])
  })

  it('writes a label set of the version asked for, status outcome, on the same snapshot, and leaves the label set it started from alone', () => {
    const before = structuredClone(LABELS)

    const { labels } = apply(countsOf(group([product('C-1', ZERO), product('C-2', ALL)])))

    expect(labels).toMatchObject({ version: 'v2', status: 'outcome', snapshotSha256: SNAPSHOT })
    expect(LABELS).toEqual(before)
  })

  it('leaves a gap alone when its counts do not lead enough, and a case with no change keeps its labels exactly', () => {
    // Moisturise: M-2 has 29 users: under MIN_USERS (30) the group says nothing, however good it looks. Cleanse has no counts at all.
    const { labels, changes } = apply(countsOf(group([product('M-1', ZERO), product('M-2', c(29, 29))])))

    expect(changes).toEqual([])
    expect(labels.cases).toEqual(LABELS.cases)
  })

  // Each pair is an A that does not replace the best B. The arithmetic (net fainter = (fainter - flaredOrStopped) / n; variance = mean(v^2) - mean(v)^2):
  it.each([
    // B has 29 users: under MIN_USERS.
    ['the best having under 30 users', ALL, c(29, 0)],
    // A has 29 users: under MIN_USERS.
    ['the challenger having under 30 users', c(29, 29), ZERO],
    // 99 of 1000 fainter is net 0.099 against 0: a lead under MIN_LIFT (0.1).
    ['a lead of 0.099, under the 0.1 it takes', c(1000, 99), c(1000, 0)],
    // A: 15 of 30, net 0.5, variance 0.5 - 0.25 = 0.25. B: 12 of 30, net 0.4, variance 0.4 - 0.16 = 0.24. Lead 0.1 (enough), but its standard error is
    // sqrt(0.25/30 + 0.24/30) = 0.128, so the 95% interval (about 0.1 +- 0.25) includes 0: it could be noise.
    ['a lead of 0.1 that could be noise (the interval includes 0)', c(30, 15), c(30, 12)],
    // A: 12 fainter and 6 flared or stopped: net (12 - 6) / 30 = 0.2. B: 6 fainter: net 6 / 30 = 0.2. Equal, so there is no lead at all.
    ['no lead at all (equal net fainter)', c(30, 12, 6), c(30, 6)],
  ])('keeps the labelled best against %s', (_label, a, b) => {
    const { changes } = apply(countsOf(group([product('C-1', b), product('C-2', a)])))

    expect(changes).toEqual([])
  })

  it('changes the best at a lead of exactly 0.1: 100 of 1000 fainter against none, with a standard error of about 0.01', () => {
    // A: net 0.1, variance 0.1 - 0.01 = 0.09. B: net 0. Lead 0.1 = MIN_LIFT, interval 0.1 +- 1.96 * sqrt(0.09/1000) = 0.1 +- 0.019, which excludes 0.
    const { changes } = apply(countsOf(group([product('C-1', c(1000, 0)), product('C-2', c(1000, 100))])))

    expect(changes.map((x) => [x.oldBest, x.newBest])).toEqual([['C-1', 'C-2']])
  })

  it('changes the best at exactly 30 users on both sides, and not at 29', () => {
    expect(apply(countsOf(group([product('C-1', ZERO), product('C-2', ALL)]))).changes).toHaveLength(1)
    expect(apply(countsOf(group([product('C-1', ZERO), product('C-2', c(29, 29))]))).changes).toHaveLength(0)
    expect(apply(countsOf(group([product('C-1', c(29, 0)), product('C-2', ALL)]))).changes).toHaveLength(0)
  })

  it('makes no change when the challenger or the best has no counts in the group', () => {
    expect(apply(countsOf(group([product('C-1', ZERO)]))).changes).toEqual([])
    expect(apply(countsOf(group([product('C-2', ALL)]))).changes).toEqual([])
  })

  it('uses only the counts of the case\'s own group: its goal, its skin type and its country', () => {
    const better = [product('C-1', ZERO), product('C-2', ALL)]

    expect(apply(countsOf(group(better, { country: 'GB' }))).changes).toEqual([])
    expect(apply(countsOf(group(better, { goal: 'even-tone' }))).changes).toEqual([])
    expect(apply(countsOf(group(better, { skinType: 'dry' }))).changes).toEqual([])
    expect(apply(countsOf(group(better, { skinType: null as unknown as string }))).changes).toEqual([])
    // And it does find its group among others.
    expect(apply(countsOf(group(better, { country: 'GB' }), group(better), group(better, { skinType: 'dry' }))).changes).toHaveLength(1)
  })

  it('finds no group for a person whose scan gave no skin type, unless the file has a group with a null skin type', () => {
    const noType = caseOf({ id: 'hold-01', goal: 'glow', country: 'NG', skinType: null, cautions: [] })
    const better = [product('C-1', ZERO), product('C-2', ALL)]

    expect(apply(countsOf(group(better)), LABELS, [noType]).changes).toEqual([])
    expect(apply(countsOf(group(better, { skinType: null as unknown as string })), LABELS, [noType]).changes).toHaveLength(1)
  })

  it('changes every gap of a case that clearly changes, and only those', () => {
    const { changes } = apply(countsOf(group([product('C-1', ZERO), product('C-2', ALL), product('M-1', ZERO), product('M-2', ALL)])))

    expect(changes.map((x) => [x.caseId, x.step, x.oldBest, x.newBest])).toEqual([
      ['hold-01', 'cleanse', 'C-1', 'C-2'],
      ['hold-01', 'moisturise', 'M-1', 'M-2'],
    ])
  })
})

describe('applyOutcomes: caution stays above outcomes', () => {
  const better = countsOf(group([product('C-1', ZERO), product('C-2', ALL)]))

  it.each(['pregnant', 'breastfeeding', 'tapering', 'recent-reaction', 'prescription'] as const)('skips a case in the %s state, however clear the outcomes are', (caution) => {
    const { labels, changes, skippedForCautions } = apply(better, LABELS, [caseOf({ id: 'hold-01', goal: 'glow', country: 'NG', skinType: 'oily', cautions: [caution] })])

    expect(changes).toEqual([])
    expect(labels.cases['hold-01']).toEqual(LABELS.cases['hold-01'])
    expect(skippedForCautions).toEqual(['hold-01'])
  })

  it('changes the cases without a caution and skips the ones with, in one label set', () => {
    const labels = labelsOf({ 'hold-01': LABELS.cases['hold-01']!, 'hold-02': LABELS.cases['hold-01']! })
    const cases = [CASE, caseOf({ id: 'hold-02', goal: 'glow', country: 'NG', skinType: 'oily', cautions: ['tapering'] })]

    const result = apply(better, labels, cases)

    expect(result.changes.map((x) => x.caseId)).toEqual(['hold-01'])
    expect(result.labels.cases['hold-01']!.cleanse!.best).toBe('C-2')
    expect(result.labels.cases['hold-02']!.cleanse!.best).toBe('C-1')
    expect(result.skippedForCautions).toEqual(['hold-02'])
  })

  it('lists no skipped case when no case has a caution', () => {
    expect(apply(better).skippedForCautions).toEqual([])
  })
})

describe('applyOutcomes: which challenger wins', () => {
  it('takes the challenger with the highest net fainter when several beat the best, whatever their order', () => {
    // Best C-1: ZERO. C-2: 24 of 30 fainter, net 0.8, variance 0.8 - 0.64 = 0.16, standard error sqrt(0.16/30) = 0.073: lead 0.8, interval 0.8 +- 0.14, a change.
    // C-3: 30 of 30, net 1.0: a change too, and higher. So C-3 wins though it comes last; C-2 keeps its acceptable label.
    const labels = labelsOf({ 'hold-01': { cleanse: { candidates: ['C-1', 'C-2', 'C-3'], best: 'C-1', acceptable: ['C-2'] } } })

    const { labels: out, changes } = apply(countsOf(group([product('C-1', ZERO), product('C-2', c(30, 24)), product('C-3', ALL)])), labels)

    expect(out.cases['hold-01']!.cleanse).toEqual({ candidates: ['C-1', 'C-2', 'C-3'], best: 'C-3', acceptable: ['C-1', 'C-2'] })
    expect(changes).toHaveLength(1)
    expect(changes[0]).toMatchObject({ oldBest: 'C-1', newBest: 'C-3', new: { n: 30, netFainter: 1 } })
  })

  it('takes the higher one when the better challenger is listed first, too', () => {
    const labels = labelsOf({ 'hold-01': { cleanse: { candidates: ['C-1', 'C-2', 'C-3'], best: 'C-3', acceptable: [] } } })

    const { labels: out } = apply(countsOf(group([product('C-3', ZERO), product('C-1', ALL), product('C-2', c(30, 24))])), labels)

    expect(out.cases['hold-01']!.cleanse!.best).toBe('C-1')
  })

  it('lets a candidate the labels called not acceptable win: outcomes win over a label', () => {
    const labels = labelsOf({ 'hold-01': { cleanse: { candidates: ['C-1', 'C-2'], best: 'C-1', acceptable: [] } } })

    const { labels: out, changes } = apply(countsOf(group([product('C-1', ZERO), product('C-2', ALL)])), labels)

    expect(out.cases['hold-01']!.cleanse).toEqual({ candidates: ['C-1', 'C-2'], best: 'C-2', acceptable: ['C-1'] })
    expect(changes).toHaveLength(1)
  })

  it('does not list the new best among the acceptable ones, and keeps the candidates as they were', () => {
    const { labels } = apply(countsOf(group([product('C-1', ZERO), product('C-2', ALL)])))

    const cleanse = labels.cases['hold-01']!.cleanse!
    expect(cleanse.acceptable).not.toContain(cleanse.best)
    expect(cleanse.candidates).toEqual(LABELS.cases['hold-01']!.cleanse!.candidates)
  })
})

describe('applyOutcomes: the audit list of flare-flagged products', () => {
  // flareFlag is: at least 30 users and at least 15% of them logged a flare. 6 of 40 is 15%: flagged. 5 of 40 is 12.5%: not. 29 of 29 is under 30 users: not.
  it('lists the products flareFlag flags, with their group, users and flares, and no others', () => {
    const { flagged } = apply(countsOf(group([product('F-AT', c(40, 0, 6, 6)), product('F-UNDER', c(40, 0, 5, 5)), product('F-SMALL', c(29, 0, 29, 29))])))

    expect(flagged).toEqual([{ ...GROUP, code: 'F-AT', n: 40, flared: 6 }])
  })

  it('lists them from every group in the file, not only the groups of the cases being changed, and a product flagged in two groups twice', () => {
    const flaring = [product('F-AT', c(40, 0, 6, 6))]

    const { flagged } = apply(countsOf(group(flaring), group(flaring, { country: 'GB' }), group([product('OK', c(40, 0, 0, 0))], { goal: 'even-tone' })))

    expect(flagged.map((f) => [f.code, f.country])).toEqual([
      ['F-AT', 'NG'],
      ['F-AT', 'GB'],
    ])
  })

  it('counts a flare, not a stop: a product people stopped without a flare is not flagged', () => {
    // 20 of 40 flared or stopped, none of them flared.
    expect(apply(countsOf(group([product('STOPPED', c(40, 0, 20, 0))]))).flagged).toEqual([])
  })

  it('lists a flagged product even for a case that was skipped for a caution', () => {
    const flaring = countsOf(group([product('F-AT', c(40, 0, 6, 6))]))

    const { flagged } = apply(flaring, LABELS, [caseOf({ id: 'hold-01', goal: 'glow', country: 'NG', skinType: 'oily', cautions: ['prescription'] })])

    expect(flagged).toHaveLength(1)
  })
})

describe('renderNote', () => {
  // A: 40 users, 30 fainter: net 0.75. B: 50 users, 10 fainter: net 0.2. Lead 0.55 (clearly a change).
  const COUNTS = countsOf(group([product('C-1', c(50, 10)), product('C-2', c(40, 30)), product('F-AT', c(40, 0, 6, 6))]))

  it('lists every change as case, step, old best, new best, users and net fainter of both, and the lift', () => {
    const { changes, flagged } = apply(COUNTS)

    expect(changes).toHaveLength(1)
    expect(changes[0]!.lift).toBeCloseTo(0.55, 10)
    const note = renderNote(changes, flagged)
    for (const part of ['hold-01', 'cleanse', 'C-1', 'C-2', '50', '40', '0.75', '0.55']) expect(note, part).toContain(part)
    expect(note).toMatch(/0\.2/)
  })

  it('has a line for each change: two changes, two lines with their case ids', () => {
    const labels = labelsOf({ 'hold-01': LABELS.cases['hold-01']!, 'hold-02': LABELS.cases['hold-01']! })
    const cases = [CASE, caseOf({ id: 'hold-02', goal: 'glow', country: 'NG', skinType: 'oily', cautions: [] })]
    const { changes, flagged } = apply(countsOf(group([product('C-1', ZERO), product('C-2', ALL)])), labels, cases)

    const note = renderNote(changes, flagged)

    expect(changes).toHaveLength(2)
    expect(note.split('\n').filter((line) => line.includes('hold-01') && line.includes('cleanse'))).toHaveLength(1)
    expect(note.split('\n').filter((line) => line.includes('hold-02') && line.includes('cleanse'))).toHaveLength(1)
  })

  it('lists the flare-flagged products as an audit list', () => {
    const { changes, flagged } = apply(COUNTS)

    const note = renderNote(changes, flagged)

    expect(note).toContain('F-AT')
    expect(note.toLowerCase()).toContain('flare')
  })

  it('says so when there is no change, and still lists the flagged products', () => {
    const { changes, flagged } = apply(countsOf(group([product('F-AT', c(40, 0, 6, 6))])))

    const note = renderNote(changes, flagged)

    expect(changes).toEqual([])
    expect(note.toLowerCase()).toMatch(/no change/)
    expect(note).toContain('F-AT')
  })

  it('names no person: a note is the record the team and the dermatologist read, and holds only case ids, product codes and aggregate numbers', () => {
    const { changes, flagged } = apply(COUNTS)

    expect(renderNote(changes, flagged)).not.toMatch(/@|https?:\/\//)
  })
})

describe('outcomeNotePath', () => {
  it('sits beside the label set it belongs to, in the gitignored folder', () => {
    expect(outcomeNotePath('v2')).toBe('eval-data/routine/labels/v2.note.md')
  })
})

describe('runOutcomes: the thin I/O around the core', () => {
  const ARGS = { counts: 'counts.json', labels: 'v1', out: 'v2' }
  const GOOD_COUNTS = JSON.stringify({ groups: [{ ...GROUP, products: [product('C-1', ZERO), product('C-2', ALL), product('F-AT', c(40, 0, 6, 6))] }] })

  const setup = (over: { counts?: string; saveFails?: Error; loadFails?: Error } = {}) => {
    const events: string[] = []
    const saved: LabelSet[] = []
    const notes: { path: string; text: string }[] = []
    const logs: string[] = []
    const io = {
      cases: [CASE],
      readCounts: async (path: string) => {
        events.push(`read ${path}`)
        return over.counts ?? GOOD_COUNTS
      },
      loadLabelSet: async (version: string) => {
        events.push(`load ${version}`)
        if (over.loadFails) throw over.loadFails
        return structuredClone(LABELS)
      },
      saveLabelSet: async (labels: LabelSet) => {
        events.push(`save ${labels.version}`)
        if (over.saveFails) throw over.saveFails
        saved.push(labels)
        return `eval-data/routine/labels/${labels.version}.json`
      },
      writeNote: async (path: string, text: string) => {
        events.push(`note ${path}`)
        notes.push({ path, text })
      },
      log: (line: string) => void logs.push(line),
    }
    return { io, events, saved, notes, logs, run: () => runOutcomes(ARGS, io) }
  }

  it('reads the counts and the label set, saves the new label set, then writes the note beside it, and exits 0', async () => {
    const { run, events, saved, notes } = setup()

    const code = await run()

    expect(code).toBe(0)
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ version: 'v2', status: 'outcome' })
    expect(saved[0]!.cases['hold-01']!.cleanse!.best).toBe('C-2')
    expect(notes.map((n) => n.path)).toEqual(['eval-data/routine/labels/v2.note.md'])
    expect(notes[0]!.text).toContain('C-2')
    expect(notes[0]!.text).toContain('F-AT')
    expect(events.filter((e) => e.startsWith('save') || e.startsWith('note'))).toEqual(['save v2', 'note eval-data/routine/labels/v2.note.md'])
    expect(events).toContain('read counts.json')
    expect(events).toContain('load v1')
  })

  it('prints the counts of changes, and no product code, case id or number from the counts file', async () => {
    const { run, logs } = setup()

    await run()

    const printed = logs.join('\n')
    expect(printed).toMatch(/\b1\b[^\n]*change/i)
    for (const part of ['C-1', 'C-2', 'F-AT', 'hold-01']) expect(printed, part).not.toContain(part)
  })

  it('refuses a version that exists: exits 2, says so, and writes no note', async () => {
    const { run, notes, logs } = setup({ saveFails: new LabelSetError('eval-data/routine/labels/v2.json exists already. A label set is never overwritten: pick a new version.') })

    const code = await run()

    expect(code).toBe(2)
    expect(notes).toEqual([])
    expect(logs.join('\n')).toMatch(/exists already/)
  })

  it('says so, in a fixed line, and exits 2 when the label set was saved but the note could not be written', async () => {
    const { io, saved, logs } = setup()
    io.writeNote = async () => {
      throw new Error('disk full: 987654')
    }

    const code = await runOutcomes(ARGS, io)

    expect(code).toBe(2)
    expect(saved).toHaveLength(1)
    expect(logs.join('\n')).toMatch(/was written but its note was not/)
    expect(logs.join('\n')).not.toMatch(/disk full|9876/)
  })

  it('refuses a label set that is not there: exits 2, saves nothing', async () => {
    const { run, saved, notes } = setup({ loadFails: new LabelSetError('No label set at eval-data/routine/labels/v1.json.') })

    expect(await run()).toBe(2)
    expect(saved).toEqual([])
    expect(notes).toEqual([])
  })

  it.each([
    ['text that is not JSON', 'groups: none'],
    ['a counts file with a field it does not have', JSON.stringify({ groups: [], extra: true })],
    ['counts that cannot come from real users', JSON.stringify({ groups: [{ ...GROUP, products: [{ code: 'C-1', n: 987654, fainter: 987655, flared: 0, flaredOrStopped: 0, fainterAndFlaredOrStopped: 0 }] }] })],
  ])('refuses %s: exits 2, saves nothing, writes no note and prints no number from the file', async (_label, counts) => {
    const { run, saved, notes, logs } = setup({ counts })

    expect(await run()).toBe(2)
    expect(saved).toEqual([])
    expect(notes).toEqual([])
    expect(logs.join('\n')).not.toMatch(/9876/)
  })
})
