/*
 * The run of `npm run eval:routine -- --set hints --labels VERSION`, without the network, the clock or the disk (the script injects them). Cases whose labels need
 * re-making (their candidates changed since) are left out, the hint cases are built from the rest, and for each one the writer is asked once with a strong outcome hint
 * on one candidate of one gap. The pick at that gap is recorded, and the follow-rate and ignore-rate are printed as numbers and written to report.json. They are not in the bar,
 * so the exit code is 0, except 2 when Claude refused our key or when no hint case can be built from the label set. The console prints only ids, counts and costs.
 * A hint case whose writer call failed has no result and makes the run partial.
 */
import { join } from 'node:path'
import { AiBudgetExceededError } from '../../src/providers/anthropic/ai-spend.provider'
import { AnthropicConfigError } from '../../src/providers/anthropic/anthropic.provider'
import type { RoutineSkeleton } from '../../src/modules/routines/routines.types'
import type { RoutineCase } from './routine-cases'
import { applyHint, buildHintCases, hintRates, type HintResult } from './routine-hints'
import type { LabelSet } from './routine-labels'
import { defaultOutDir, type RunDeps, type RunIo, usd } from './routine-run'
import { needsRelabelOf } from './routine-score'
import { buildSkeleton } from './routine-skeleton'
import type { Snapshot } from './routine-snapshot'

export type HintRunArgs = {
  cases: RoutineCase[]
  /** Run only the first N hint cases. */
  limit?: number
  outDir?: string
  startedAt: Date
  model: string
  promptHash: string
  snapshot: Snapshot
  labels: LabelSet
  deps: Pick<RunDeps, 'writer' | 'ledger'>
  io: RunIo
}

const shown = (value: number | null): string => (value === null ? 'n/a' : value.toFixed(1))

export const runHintEval = async ({ cases, limit, outDir: given, startedAt, model, promptHash, snapshot, labels, deps, io }: HintRunArgs): Promise<{ exitCode: number; outDir: string }> => {
  const { writer, ledger } = deps
  const outDir = given ?? defaultOutDir(startedAt)
  await io.mkdir(outDir)

  // A skeleton is built once per case: every hint case of it starts from the same one.
  const skeletons = new Map<string, RoutineSkeleton>()
  const stale: string[] = []
  for (const c of cases) {
    const caseLabels = labels.cases[c.id]
    if (caseLabels === undefined) continue
    const { skeleton, gapCodes } = await buildSkeleton(c, snapshot, { hintsShown: false })
    if (needsRelabelOf({ gapCodes, labels: caseLabels })) stale.push(c.id)
    else skeletons.set(c.id, skeleton)
  }
  const built = buildHintCases(cases.filter((c) => skeletons.has(c.id)), labels)
  const hintCases = built.slice(0, limit)
  io.log(`Hint eval: ${hintCases.length} hint cases from ${skeletons.size} cases, cap ${usd(ledger.capMicros)}, labels ${labels.version}`)
  if (stale.length > 0) io.log(`Needs re-label (left out): ${stale.join(', ')}`)
  if (hintCases.length === 0) {
    io.log('No hint case could be built from this label set.')
    return { exitCode: 2, outDir }
  }

  const results: (HintResult & { costMicros: number })[] = []
  let stopped: 'cap' | 'config' | null = null
  let costMicros = 0
  let writerErrors = 0
  for (const h of hintCases) {
    if (stopped !== null) break
    const spentBefore = ledger.spentMicros()
    let pick: string | null = null
    let failed = false
    try {
      const routine = await writer.write(applyHint(skeletons.get(h.caseId)!, h.step, h.hinted))
      const product = routine.steps.find((entry) => entry.step === h.step)?.product
      pick = product?.kind === 'candidate' ? product.code : null
    } catch (caught) {
      if (caught instanceof AiBudgetExceededError) stopped = 'cap'
      else if (caught instanceof AnthropicConfigError) stopped = 'config'
      else failed = true
    }
    const cost = ledger.spentMicros() - spentBefore
    costMicros += cost
    // A call that failed or was refused made no pick, and is not a result: it would count as ignoring (or missing) a hint it never saw answered.
    if (stopped !== null || failed) {
      if (failed) writerErrors++
      io.log(`${h.id}  ${stopped !== null ? 'cut-off' : 'writer-error'}  ${usd(cost)}`)
      continue
    }
    results.push({ id: h.id, kind: h.kind, hinted: h.hinted, pick, costMicros: cost })
    const rates = hintRates([results.at(-1)!])
    io.log(`${h.id}  ${rates.missed.length === 0 ? 'met' : 'missed'}  ${usd(cost)}`)
  }

  const rates = hintRates(results)
  const reportPath = join(outDir, 'report.json')
  const partial = stopped !== null || writerErrors > 0 || hintCases.length < built.length
  await io.writeFile(
    reportPath,
    `${JSON.stringify({ startedAt: startedAt.toISOString(), set: 'hints', snapshotSha256: snapshot.sha256, labelVersion: labels.version, labelSnapshotSha256: labels.snapshotSha256, model, promptHash, capMicros: ledger.capMicros, partial, needsRelabel: stale, results, summary: { ...rates, cases: results.length, costMicros } }, null, 2)}\n`,
  )

  if (stopped === 'cap') io.log('Stopped at the spend cap: the hint cases after this point were not run.')
  if (stopped === 'config') io.log('Stopped: Claude refused our key, billing or permissions. Fix the setup (ANTHROPIC_API_KEY and the account) and run again.')
  io.log(`Follow rate: ${shown(rates.followRate)}%, ignore rate: ${shown(rates.ignoreRate)}% (not in the bar)`)
  if (rates.missed.length > 0) io.log(`Missed: ${rates.missed.join(', ')}`)
  io.log(`Spent ${usd(costMicros)} of the ${usd(ledger.capMicros)} cap.`)
  io.log(`Report: ${reportPath}`)
  return { exitCode: stopped === 'config' ? 2 : 0, outDir }
}
