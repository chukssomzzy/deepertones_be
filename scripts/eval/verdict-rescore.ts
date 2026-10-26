/*
 * The core of `npm run eval:verdict:rescore`: a report written by `eval:verdict` already holds, for each case, the floor's answer, the request the judge was asked, its
 * raw answer and the merged products, so scoring them against ANOTHER version of the labels costs nothing: no judge, no key, no spend. The floor part of the score does
 * not depend on the labels, so it is kept whatever they say; the fit part is refused (the case is listed for re-labelling) where the saved request is not the one the new
 * labels were made for. The saved set, `--floor-only`, trial status and step-down codes are the source's: a rescore cannot make a trial whole. Like verdict-run.ts it
 * takes its I/O injected and prints only ids (never the holdout's), states, counts and scores.
 */
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { LabelSet } from './verdict-labels'
import type { RunIo } from './routine-run'
import { finishVerdictRun, type ReportedCase, runDirOf } from './verdict-run'
import type { ScoreOptions } from './verdict-score'

/** A report that cannot be rescored: missing, unreadable, or not written by eval:verdict. The CLI turns it into exit 2; the message names the path and never quotes the file. */
export class VerdictReportError extends Error {}

const FitProductSchema = z.looseObject({ id: z.string(), label: z.enum(['helping', 'redundant', 'blocking']), sameJobAs: z.string().nullable() })
// Only what a rescore reads is checked, and every case is passed on as it was read: nothing the run saved is dropped.
const CaseSchema = z.looseObject({
  id: z.string(),
  state: z.enum(['done', 'fit-error', 'merge-error', 'cut-off']),
  expect: z.looseObject({ entries: z.record(z.string(), z.looseObject({ outcome: z.enum(['open', 'ignored', 'fixed']) })), clashes: z.array(z.tuple([z.string(), z.string()])) }),
  floor: z.looseObject({ entries: z.array(z.looseObject({ id: z.string(), status: z.enum(['open', 'fixed', 'taper-missing']) })), clashes: z.array(z.looseObject({ ids: z.tuple([z.string(), z.string()]) })) }).nullable(),
  requestSha256: z.string().nullable(),
  fit: z.looseObject({ products: z.array(FitProductSchema), clashes: z.array(z.looseObject({ ids: z.tuple([z.string(), z.string()]), reduceId: z.string() })) }).nullable(),
  products: z.array(z.looseObject({ entryId: z.string(), group: z.string(), verdict: z.looseObject({ kind: z.string() }) })).nullable(),
  costMicros: z.number(),
})
const ReportSchema = z.looseObject({
  startedAt: z.string(),
  set: z.enum(['main', 'holdout']),
  floorOnly: z.boolean(),
  partial: z.boolean(),
  snapshotSha256: z.string(),
  model: z.string().nullable(),
  promptHash: z.string().nullable(),
  tapers: z.record(z.string(), z.string()),
  cases: z.array(CaseSchema),
})

export type SavedVerdictReport = {
  startedAt: string
  set: 'main' | 'holdout'
  floorOnly: boolean
  partial: boolean
  snapshotSha256: string
  model: string | null
  promptHash: string | null
  tapers: ScoreOptions['tapers']
  cases: ReportedCase[]
}

export const readVerdictReport = async (path: string): Promise<SavedVerdictReport> => {
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new VerdictReportError(`${path} could not be read as a report: ${(error as NodeJS.ErrnoException).code === 'ENOENT' ? 'there is no such file' : 'it is not JSON'}.`)
  }
  const parsed = ReportSchema.safeParse(raw)
  if (!parsed.success) {
    // The paths of the fields at fault and nothing of their contents.
    const fields = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(report)'))].slice(0, 5).join(', ')
    throw new VerdictReportError(`${path} is not a report written by eval:verdict (fields at fault: ${fields}).`)
  }
  // The schema holds the fields a rescore reads; the cast restores the types of what it lets through unread.
  return parsed.data as unknown as SavedVerdictReport
}

export type VerdictRescoreArgs = {
  report: SavedVerdictReport
  /** Where the report was read from, for the new report's `source`. */
  reportPath: string
  labels: LabelSet
  startedAt: Date
  /** The directory the rescore's own directory is made in. */
  outDir: string
  io: RunIo
}

export const runVerdictRescore = async ({ report, reportPath, labels, startedAt, outDir, io }: VerdictRescoreArgs): Promise<{ exitCode: number; reportPath: string }> => {
  const runDir = runDirOf(outDir, 'verdict-rescore', startedAt)
  await io.mkdir(runDir)
  io.log(`Verdict rescore: set ${report.set}, ${report.cases.length} cases from ${reportPath}, labels ${labels.version}`)
  const header = {
    startedAt: startedAt.toISOString(),
    set: report.set,
    floorOnly: report.floorOnly,
    snapshotSha256: report.snapshotSha256,
    labelVersion: labels.version,
    model: report.model,
    promptHash: report.promptHash,
    tapers: report.tapers,
    source: { report: reportPath, startedAt: report.startedAt },
    mode: 'rescore',
  }
  // What each case cost the run that made it stays in its record; this run spent nothing.
  return finishVerdictRun({ header, set: report.set, floorOnly: report.floorOnly, partial: report.partial, stopped: null, labels, tapers: report.tapers, cases: report.cases, costMicros: 0, capMicros: null, runDir, showCaseCost: false, io })
}
