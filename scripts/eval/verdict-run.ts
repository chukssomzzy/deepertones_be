/*
 * The orchestration of `npm run eval:verdict`, without the network, the clock or the disk (the script injects them). For each case it does what the app does when
 * it builds a verdict, with the REAL functions the app uses: the case becomes the facts a build reads, the floor decides what it can, the fit judge is asked about
 * the rest, and the two answers are merged. Then the run is scored (verdict-score.ts), report.json is written, and the console lines are printed. What the console
 * prints is only ids, states, counts, scores and costs: a product, a reason, a label's rationale and an error's message go to nobody, and the holdout prints no id at
 * all, so a run of it can be read but cannot be tuned on. report.json always has the ids.
 */
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { stableJson } from '../../src/lib/stable-json'
import type { TaperKind } from '../../src/modules/catalog/catalog.vocabulary'
import type { VerdictReference } from '../../src/modules/catalog/catalog.workbook.service'
import { floorVerdicts, type FloorResult } from '../../src/modules/verdicts/verdicts.floor'
import { assembleVerdictInputs, fitRequestOf } from '../../src/modules/verdicts/verdicts.inputs'
import { mergeVerdict, type VerdictProduct } from '../../src/modules/verdicts/verdicts.merge'
import { AiBudgetExceededError } from '../../src/providers/anthropic/ai-spend.provider'
import { AnthropicConfigError } from '../../src/providers/anthropic/anthropic.provider'
import type { MemoryAiSpendLedger } from '../../src/providers/anthropic/memory.ai-spend-ledger'
import type { FitRequest, FitResult, VerdictFitter } from '../../src/providers/verdict-fitting/verdict-fitter.provider'
import type { VerdictCase, VerdictSet } from './verdict-cases'
import { factsOf } from './verdict-facts'
import type { LabelSet } from './verdict-labels'
import { classNameOf, type RunIo, shown, usd } from './routine-run'
import { formatVerdictBarLine, type ScoreOptions, scoreVerdictRun, verdictBarExitCode, type VerdictScore } from './verdict-score'

export type VerdictRunDeps = {
  /** The fit judge, or null for a `--floor-only` run, which has none to call. */
  fitter: VerdictFitter | null
  /** The ledger the fit judge's client spends on; the run reads what each case cost from it. */
  ledger: MemoryAiSpendLedger
}

export type VerdictRunArgs = {
  cases: VerdictCase[]
  set: VerdictSet
  /** Run only the first N cases. */
  limit?: number
  /** The directory the run's own directory is made in. */
  outDir: string
  startedAt: Date
  floorOnly: boolean
  reference: VerdictReference
  snapshotSha256: string
  /** The label set, or null for a run with none. */
  labels: LabelSet | null
  deps: VerdictRunDeps
  io: RunIo
}

export type Stop = 'cap' | 'config' | null
export type VerdictCaseState = 'done' | 'fit-error' | 'merge-error' | 'cut-off'

/** A case as report.json holds it: what the floor said, what the judge was asked and said, and what the merge made of it. */
export type ReportedCase = {
  id: string
  state: VerdictCaseState
  /** The class name of the error of a case that failed (never its message). */
  error?: string
  expect: VerdictCase['expect']
  floor: FloorResult | null
  fitRequest: FitRequest | null
  requestSha256: string | null
  /** The judge's raw answer, before the merge. */
  fit: FitResult | null
  products: VerdictProduct[] | null
  costMicros: number
}

/** The directory of a run's report, made with no colon in its name: actions/upload-artifact refuses colons. */
export const runDirOf = (outDir: string, prefix: string, startedAt: Date): string => join(outDir, `${prefix}-${startedAt.toISOString().replace(/:/g, '-')}`)

// The floor and the request do not read the fingerprint's fitter, so a run with no judge names a placeholder.
const NO_FITTER = { model: 'none', promptHash: 'none' }

const requestShaOf = (request: FitRequest): string => createHash('sha256').update(stableJson(request)).digest('hex')

export const runVerdictEval = async ({ cases: allCases, set, limit, outDir, startedAt, floorOnly, reference, snapshotSha256, labels, deps, io }: VerdictRunArgs): Promise<{ exitCode: number; reportPath: string }> => {
  const { ledger } = deps
  const fitter = floorOnly ? null : deps.fitter
  if (!floorOnly && fitter === null) throw new Error('A run that is not --floor-only needs a fit judge')
  const cases = allCases.slice(0, limit)
  const runDir = runDirOf(outDir, 'verdict', startedAt)
  // Made before anything is spent, so a directory that cannot be made stops the run while it is still free.
  await io.mkdir(runDir)
  io.log(`Verdict eval: set ${set}, ${cases.length} cases, ${floorOnly ? 'floor only' : `cap ${usd(ledger.capMicros)}`}, labels ${labels?.version ?? 'none'}`)

  let stopped: Stop = null
  // A cap or a rejected key ends the run; any other failure of the judge is only that case's.
  const stopFor = (error: unknown): boolean => {
    if (error instanceof AiBudgetExceededError) stopped = 'cap'
    else if (error instanceof AnthropicConfigError) stopped = 'config'
    return stopped !== null
  }

  const reported: ReportedCase[] = []
  let costMicros = 0
  for (const c of cases) {
    const spentBefore = ledger.spentMicros()
    let recorded: ReportedCase
    if (stopped !== null) recorded = { id: c.id, state: 'cut-off', expect: c.expect, floor: null, fitRequest: null, requestSha256: null, fit: null, products: null, costMicros: 0 }
    else {
      // The sequence of VerdictService.build (src/modules/verdicts/verdicts.service.ts): the facts a build reads, the inputs they make, the floor's answer, the
      // request for the judge (null when nothing is open and nothing clashes), the judge, and the merge of the two, with the profile's safety choices.
      const facts = factsOf(c, reference, fitter?.identity ?? NO_FITTER)
      const inputs = assembleVerdictInputs(facts)
      const floor = floorVerdicts(inputs.floorInput)
      const request = fitRequestOf(facts, floor)
      const choices = facts.safety.view?.choices ?? []

      let state: VerdictCaseState = 'done'
      let error: string | undefined
      let fit: FitResult | null = null
      if (request !== null && fitter !== null) {
        try {
          fit = await fitter.fit(request)
        } catch (failure) {
          if (stopFor(failure)) state = 'cut-off'
          else [state, error] = ['fit-error', classNameOf(failure)]
        }
      }
      if (state === 'cut-off') recorded = { id: c.id, state, expect: c.expect, floor: null, fitRequest: null, requestSha256: null, fit: null, products: null, costMicros: 0 }
      else {
        const merge = (answer: FitResult | null) => mergeVerdict({ floor, fit: answer, entries: inputs.entries, choices, reference }).products
        let products: VerdictProduct[] | null = null
        try {
          products = merge(fit)
        } catch (failure) {
          // As the service does: the verdict is still the floor's, with the open products undecided. The raw answer stays in the report.
          state = 'merge-error'
          error = classNameOf(failure)
          try {
            products = merge(null)
          } catch {
            // The floor alone cannot be merged either (a step-down template is missing): the case has no products.
          }
        }
        recorded = {
          id: c.id,
          state,
          ...(error === undefined ? {} : { error }),
          expect: c.expect,
          floor,
          fitRequest: request,
          requestSha256: request === null ? null : requestShaOf(request),
          fit,
          products,
          costMicros: 0,
        }
      }
    }
    // What the case cost on the ledger, a failed call and the call that the cap or the key stopped included.
    recorded.costMicros = ledger.spentMicros() - spentBefore
    costMicros += recorded.costMicros
    reported.push(recorded)
  }

  const header = {
    startedAt: startedAt.toISOString(),
    set,
    floorOnly,
    snapshotSha256,
    labelVersion: labels?.version ?? null,
    model: fitter?.identity.model ?? null,
    promptHash: fitter?.identity.promptHash ?? null,
    capMicros: ledger.capMicros,
    tapers: reference.tapers,
  }
  // A run of the first N cases (--limit) is a trial, as one stopped at the cap is: it can fail the bar but never pass it.
  return finishVerdictRun({ header, set, floorOnly, partial: stopped !== null || cases.length < allCases.length, stopped, labels, tapers: reference.tapers, cases: reported, costMicros, capMicros: ledger.capMicros, runDir, io })
}

export type FinishArgs = {
  /** The report's fields before `partial`, `cases` and `summary`. */
  header: Record<string, unknown>
  set: VerdictSet
  floorOnly: boolean
  partial: boolean
  stopped: Stop
  labels: LabelSet | null
  tapers: ScoreOptions['tapers']
  cases: ReportedCase[]
  /** What the run spent: nothing for a rescore. */
  costMicros: number
  /** The cap the run was held to; null for a rescore, which makes no call. */
  capMicros: number | null
  /** The directory report.json is written to (already made). */
  runDir: string
  /** The cost of each case is printed on its line, as the run that made it spent it; a rescore leaves it out. */
  showCaseCost?: boolean
  io: RunIo
}

const countOf = (rate: { count: number; total: number; rate: number | null }): string => `${rate.count} of ${rate.total} (${shown(rate.rate)}%)`

const caseLine = (c: ReportedCase, { fit, floor, needsRelabel }: VerdictScore, floorOnly: boolean, showCost: boolean): string => {
  const cost = showCost ? `  ${usd(c.costMicros)}` : ''
  if (c.state === 'cut-off') return `${c.id}  cut-off${cost}`
  const state = c.error === undefined ? c.state : `${c.state} ${c.error}`
  const fitText = floorOnly || fit.total === 0 ? 'fit n/a' : `fit ${fit.count}/${fit.total}`
  return `${c.id}  ${state}  floor ${floor.missed.length === 0 ? 'ok' : 'MISS'}  ${fitText}${needsRelabel.length > 0 ? '  needs re-label' : ''}${cost}`
}

/** What follows the cases of a run, whichever way they got their answers: the scores and the bar, report.json, and the closing console lines. */
export const finishVerdictRun = async ({ header, set, floorOnly, partial, stopped, labels, tapers, cases, costMicros, capMicros, runDir, showCaseCost = true, io }: FinishArgs): Promise<{ exitCode: number; reportPath: string }> => {
  const options: ScoreOptions = { set, partial, floorOnly, labels, tapers }
  const score = scoreVerdictRun(cases, options)
  const summary = { ...score, costMicros }
  const reportPath = join(runDir, 'report.json')
  await io.writeFile(reportPath, `${JSON.stringify({ ...header, partial, cases, summary }, null, 2)}\n`)

  // The ids of the holdout stay out of the console: it is for measuring, never for tuning, so it says how many and the report says which.
  const named = set === 'main'
  if (named) for (const c of cases) io.log(caseLine(c, scoreVerdictRun([c], options), floorOnly, showCaseCost))
  if (stopped === 'cap') io.log('Stopped at the spend cap: the cases after this point were not run.')
  if (stopped === 'config') io.log('Stopped: Claude refused our key, billing or permissions. Fix the setup (ANTHROPIC_API_KEY and the account) and run again.')

  io.log(`Floor: ${shown(score.floor.accuracy)}% of the checks right, ${score.floor.missed.length} of ${score.cases} cases missed`)
  const { violations } = score.stricterOnly
  io.log(`Stricter-only violations: ${violations.length}${named && violations.length > 0 ? ` (${violations.map((v) => `${v.caseId}/${v.entryId}`).join(', ')})` : ''}`)
  if (floorOnly) io.log('Fit: not run (--floor-only)')
  else {
    io.log(`Fit agreement: ${countOf(score.fit)}, the bar is at least 85%`)
    io.log(`Harmful: ${countOf(score.harmful)} of the products labelled blocking were called helping, the bar is at most 2%; over every open product ${countOf(score.harmfulAllOpen)}`)
    io.log(`Over-strict: ${countOf(score.overStrict)} of the products labelled helping were called blocking`)
    io.log(`Confusion, by label then by what the judge said (helping, redundant, blocking): ${(['helping', 'redundant', 'blocking'] as const).map((label) => `${label} ${Object.values(score.confusion[label]).join('/')}`).join(', ')}`)
    io.log(`Same job named: ${countOf(score.sameJobAs)}, clash pick: ${countOf(score.clashPick)} (not in the bar)`)
  }
  if (score.needsRelabel.length > 0) io.log(`Needs re-label (the request changed since the labels were made): ${named ? score.needsRelabel.join(', ') : `${score.needsRelabel.length} cases`}`)
  io.log(capMicros === null ? `Spent ${usd(costMicros)}: a rescore makes no call.` : `Spent ${usd(costMicros)} of the ${usd(capMicros)} cap.`)
  io.log(`Report: ${reportPath}`)
  if (score.bar.status === 'not-evaluated') io.log('This run is a trial: it cannot pass or fail the bar.')
  io.log(formatVerdictBarLine(score.bar))
  return { exitCode: stopped === 'config' ? 2 : verdictBarExitCode(score.bar), reportPath }
}
