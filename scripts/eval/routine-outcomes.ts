/*
 * `npm run eval:routine:outcomes -- --counts FILE --labels v1 --out v2`: real outcomes (counts of what happened to users who had a product in their routine at the
 * review point) can overturn a labelled best. The rule is `labelChange` from routines.outcomes.ts, which this file does not restate. Caution stays above outcomes:
 * a case with a caution state is never changed. The result is a new label set (status outcome) and a note beside it that the team and the dermatologist read. The
 * pure core is applyOutcomes and renderNote; runOutcomes is the I/O around them, handed in by the script. Counts can describe a real group of users, so no message or
 * console line carries a number from the file.
 */
import { z } from 'zod'
import { ROUTINE_STEPS, type RoutineStep } from '../../src/modules/catalog/catalog.vocabulary'
import { flareFlag, labelChange, netFainterOf, type OutcomeCounts, outcomeHint } from '../../src/modules/routines/routines.outcomes'
import type { RoutineCase } from './routine-cases'
import { type LabelSet, LabelSetError, labelSetPath } from './routine-labels'

/** A counts file that cannot be used. The message is fixed text and paths into the file, never a value from it. */
export class OutcomesError extends Error {}

const CountsSchema = z.strictObject({
  code: z.string().min(1),
  n: z.number().int().nonnegative(),
  fainter: z.number().int().nonnegative(),
  flared: z.number().int().nonnegative(),
  flaredOrStopped: z.number().int().nonnegative(),
  fainterAndFlaredOrStopped: z.number().int().nonnegative(),
})
const CountsFileSchema = z.strictObject({
  groups: z.array(z.strictObject({ goal: z.string().min(1), skinType: z.string().min(1).nullable(), country: z.string().min(1), products: z.array(CountsSchema) })),
})
export type CountsFile = z.infer<typeof CountsFileSchema>

const countsOf = ({ code: _code, ...counts }: CountsFile['groups'][number]['products'][number]): OutcomeCounts => counts

/** The counts file, strictly: nothing it does not define, every count a whole number, counts that could come from real users, and no group or product twice. */
export const parseCountsFile = (input: unknown): CountsFile => {
  const parsed = CountsFileSchema.safeParse(input)
  if (!parsed.success) throw new OutcomesError(`The counts file is not valid at ${[...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(top)'))].join(', ')}.`)
  const seen = new Set<string>()
  for (const [g, group] of parsed.data.groups.entries()) {
    const key = JSON.stringify([group.goal, group.skinType, group.country])
    if (seen.has(key)) throw new OutcomesError(`The counts file has the same group twice (groups.${g}).`)
    seen.add(key)
    const codes = new Set<string>()
    for (const [p, product] of group.products.entries()) {
      if (codes.has(product.code)) throw new OutcomesError(`The counts file has the same product twice in a group (groups.${g}.products.${p}).`)
      codes.add(product.code)
      try {
        // Throws for counts that cannot have come from real users; the message of that error is not used.
        outcomeHint(countsOf(product))
      } catch {
        throw new OutcomesError(`The counts file has counts that cannot come from real users (groups.${g}.products.${p}).`)
      }
    }
  }
  return parsed.data
}

export type OutcomeSide = { n: number; netFainter: number }
export type LabelChange = { caseId: string; step: RoutineStep; oldBest: string; newBest: string; old: OutcomeSide; new: OutcomeSide; lift: number }
export type FlaggedProduct = { goal: string; skinType: string | null; country: string; code: string; n: number; flared: number }

const sideOf = (counts: OutcomeCounts): OutcomeSide => ({ n: counts.n, netFainter: netFainterOf(counts) })

/**
 * The label set after outcomes, the changes made, the cases skipped for a caution state, and the products flagged for flares (from every group in the file). For
 * each gap, the labelled best B is compared with every other candidate A of the gap in the case's group (goal, skin type and country) by labelChange(A, B); when
 * several A beat B, the one with the highest net fainter wins. Outcomes win over a label: A may have been labelled not acceptable. B becomes acceptable.
 */
export const applyOutcomes = (labels: LabelSet, counts: CountsFile, cases: RoutineCase[], version: string): { labels: LabelSet; changes: LabelChange[]; skippedForCautions: string[]; flagged: FlaggedProduct[] } => {
  // Each case gets its own copy of its gaps (a gap is replaced, never edited), so two cases that share a label object in memory are changed on their own.
  const out: LabelSet = { ...labels, version, status: 'outcome', cases: Object.fromEntries(Object.entries(labels.cases).map(([id, gaps]) => [id, { ...gaps }])) }
  const changes: LabelChange[] = []
  const skippedForCautions: string[] = []

  for (const c of cases) {
    const caseLabels = out.cases[c.id]
    if (caseLabels === undefined) continue
    if (c.cautions.length > 0) {
      skippedForCautions.push(c.id)
      continue
    }
    const group = counts.groups.find((g) => g.goal === c.goal && g.skinType === c.skinType && g.country === c.country)
    if (group === undefined) continue
    const countsFor = (code: string): OutcomeCounts | undefined => {
      const product = group.products.find((p) => p.code === code)
      return product === undefined ? undefined : countsOf(product)
    }
    for (const step of ROUTINE_STEPS) {
      const label = caseLabels[step]
      const best = label === undefined ? undefined : countsFor(label.best)
      if (label === undefined || best === undefined) continue
      let winner: { code: string; counts: OutcomeCounts } | undefined
      for (const code of label.candidates) {
        const challenger = code === label.best ? undefined : countsFor(code)
        if (challenger === undefined || !labelChange(challenger, best)) continue
        if (winner === undefined || sideOf(challenger).netFainter > sideOf(winner.counts).netFainter) winner = { code, counts: challenger }
      }
      if (winner === undefined) continue
      const [old, now] = [sideOf(best), sideOf(winner.counts)]
      changes.push({ caseId: c.id, step, oldBest: label.best, newBest: winner.code, old, new: now, lift: now.netFainter - old.netFainter })
      caseLabels[step] = { candidates: label.candidates, best: winner.code, acceptable: [...label.acceptable.filter((code) => code !== winner.code), label.best].sort() }
    }
  }

  const flagged = counts.groups.flatMap((g) =>
    g.products.filter((p) => flareFlag(countsOf(p))).map((p) => ({ goal: g.goal, skinType: g.skinType, country: g.country, code: p.code, n: p.n, flared: p.flared })),
  )
  return { labels: out, changes, skippedForCautions, flagged }
}

const net = (value: number): string => value.toFixed(2)

/** The record of a run: every change, and the audit list of flare-flagged products. Only case ids, step names, product codes and aggregate numbers. */
export const renderNote = (changes: LabelChange[], flagged: FlaggedProduct[]): string => {
  const lines = ['# Label changes from outcomes', '']
  if (changes.length === 0) lines.push('No change: no labelled best was overturned.')
  else {
    lines.push('A challenger replaced the labelled best where its net fainter (fainter minus flared or stopped, per user) led by at least 0.1 and the lead was not noise. Users and net fainter are given for the old best and the new best.', '')
    for (const x of changes) {
      lines.push(`- ${x.caseId} ${x.step}: ${x.oldBest} (${x.old.n} users, net fainter ${net(x.old.netFainter)}) -> ${x.newBest} (${x.new.n} users, net fainter ${net(x.new.netFainter)}), lift ${net(x.lift)}`)
    }
  }
  lines.push('', '## Products flagged for flares', '')
  if (flagged.length === 0) lines.push('None.')
  else {
    lines.push('At least 15% of the users of these products logged a flare. For audit: the labels are not changed by it.', '')
    for (const f of flagged) lines.push(`- ${f.code}: goal ${f.goal}, skin type ${f.skinType ?? 'none'}, country ${f.country}, ${f.n} users, ${f.flared} flared`)
  }
  return `${lines.join('\n')}\n`
}

/** Beside the label set it belongs to, in the gitignored folder. */
export const outcomeNotePath = (version: string): string => labelSetPath(version).replace(/\.json$/, '.note.md')

export type OutcomesIo = {
  /** The cases whose ids the label set holds (dev and holdout), for their goal, skin type, country and cautions. */
  cases: RoutineCase[]
  readCounts: (path: string) => Promise<string>
  loadLabelSet: (version: string) => Promise<LabelSet>
  saveLabelSet: (labels: LabelSet) => Promise<string>
  writeNote: (path: string, text: string) => Promise<void>
  log: (line: string) => void
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** Exit 0 when the new label set and its note were written; 2 when they could not be (when only the note fails, the label set stays and a fixed line says so). */
export const runOutcomes = async ({ counts: countsPath, labels: from, out }: { counts: string; labels: string; out: string }, io: OutcomesIo): Promise<number> => {
  try {
    let text: string
    try {
      text = await io.readCounts(countsPath)
    } catch {
      throw new OutcomesError(`Cannot read the counts file ${countsPath}.`)
    }
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch {
      throw new OutcomesError('The counts file is not JSON.')
    }
    const counts = parseCountsFile(json)
    const base = await io.loadLabelSet(from)
    const result = applyOutcomes(base, counts, io.cases, out)
    // The note is rendered, and its path checked, before anything is saved, so what can be known to fail has failed while nothing is written.
    const notePath = outcomeNotePath(out)
    const note = renderNote(result.changes, result.flagged)
    // The label set first: it refuses a version that exists, and then no note is written beside someone else's.
    const path = await io.saveLabelSet(result.labels)
    try {
      await io.writeNote(notePath, note)
    } catch {
      io.log(`The label set ${path} was written but its note was not (${notePath}). The label set is kept: write the note again from the same counts under a new version, or by hand.`)
      return 2
    }
    io.log(`Wrote ${path} (status outcome): ${plural(result.changes.length, 'change', 'changes')}, ${plural(result.skippedForCautions.length, 'case', 'cases')} skipped for a caution state, ${plural(result.flagged.length, 'flare-flagged product', 'flare-flagged products')} listed.`)
    io.log(`Note: ${notePath}`)
    return 0
  } catch (error) {
    if (error instanceof OutcomesError || error instanceof LabelSetError) {
      io.log(error.message)
      return 2
    }
    throw error
  }
}
