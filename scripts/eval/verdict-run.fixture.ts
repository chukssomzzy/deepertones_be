import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { floorVerdicts, type FloorResult } from '../../src/modules/verdicts/verdicts.floor'
import { assembleVerdictInputs, fitRequestOf } from '../../src/modules/verdicts/verdicts.inputs'
import type { VerdictProduct } from '../../src/modules/verdicts/verdicts.merge'
import { stableJson } from '../../src/lib/stable-json'
import { MemoryAiSpendLedger } from '../../src/providers/anthropic/memory.ai-spend-ledger'
import { BIG_CAP_MICROS } from '../../src/providers/anthropic/messages-api.fake'
import { MemoryVerdictFitter } from '../../src/providers/verdict-fitting/memory.verdict-fitter'
import type { FitRequest, FitResult, VerdictFitter } from '../../src/providers/verdict-fitting/verdict-fitter.provider'
import type { VerdictCase, VerdictSet } from './verdict-cases'
import { factsOf } from './verdict-facts'
import type { CaseLabels, LabelSet } from './verdict-labels'
import { runVerdictEval } from './verdict-run'
import { BASE, FIXTURE, FIXTURE_REFERENCE } from './verdict.fixture'

// Shared by the verdict eval's run, rescore and parity tests (as routine.fixture.ts is by the routine eval's): the harness that runs `runVerdictEval` with the fit judge
// faked and the ledger real, and the builders of the labels that go with a run. Everything about a run that a test needs to know independently (the request a case
// makes, its sha256) is worked out here with the REAL src functions, never with the harness under test. Not a test file, so it is never run.
//
// Shapes assumed (the contract the verdict run/rescore tests pin):
//   runVerdictEval({ cases, set, limit?, outDir, startedAt, floorOnly, reference, snapshotSha256, labels, deps: { fitter: VerdictFitter | null; ledger }, io })
//     : Promise<{ exitCode: number; reportPath: string }>        io = { log(line), mkdir(dir), writeFile(path, text) }
//   The report is written to <outDir>/verdict-<startedAt ISO, colons as dashes>/report.json. Its shape is `Report` below.

export const OUT = 'out'
export const SNAPSHOT_SHA = 'f'.repeat(64)
export const MICROS_PER_CALL = 1000
export const FIT_REASON = 'Suits the goal.'

/** The directory of a run's report, worked out by the rule (the iso time, with no colon: actions/upload-artifact refuses colons in a file name). */
export const runDirOf = (startedAt: Date, prefix = 'verdict'): string => join(OUT, `${prefix}-${startedAt.toISOString().replace(/:/g, '-')}`)

// --- the report, as the tests read it ------------------------------------------------------------------------------------------------------------------

export type Rate = { count: number; total: number; rate: number | null }
export type ReportedCase = {
  id: string
  state: 'done' | 'fit-error' | 'merge-error' | 'cut-off'
  error?: string
  expect: VerdictCase['expect']
  floor: FloorResult | null
  fitRequest: FitRequest | null
  requestSha256: string | null
  fit: FitResult | null
  products: VerdictProduct[] | null
  costMicros: number
}
export type Report = {
  startedAt: string
  set: VerdictSet
  floorOnly: boolean
  partial: boolean
  snapshotSha256: string
  labelVersion: string | null
  model: string | null
  promptHash: string | null
  capMicros: number
  tapers: Record<string, string>
  cases: ReportedCase[]
  summary: {
    cases: number
    costMicros: number
    needsRelabel: string[]
    floor: { accuracy: number | null; missed: string[] }
    stricterOnly: { violations: { caseId: string; entryId: string }[] }
    fit: Rate
    harmful: Rate
    harmfulAllOpen: Rate
    overStrict: Rate
    bar: { status: 'pass' | 'fail' | 'not-evaluated'; rules?: string[]; reasons?: string[]; notEvaluated?: string[] }
  }
}

// --- the independent sha ------------------------------------------------------------------------------------------------------------------------------

export const IDENTITY = new MemoryVerdictFitter().identity

/** The request a case makes of the fit judge, built by the real functions the app builds it with. Null when nothing is open and nothing clashes. */
export const requestOf = (c: VerdictCase): FitRequest | null => {
  const facts = factsOf(c, FIXTURE_REFERENCE, IDENTITY)
  return fitRequestOf(facts, floorVerdicts(assembleVerdictInputs(facts).floorInput))
}

export const shaOf = (request: FitRequest): string => createHash('sha256').update(stableJson(request)).digest('hex')

export const requestShaOf = (c: VerdictCase): string => {
  const request = requestOf(c)
  if (request === null) throw new Error(`${c.id} makes no request, so it has no sha`)
  return shaOf(request)
}

// --- labels -----------------------------------------------------------------------------------------------------------------------------------------

type EntryLabel = CaseLabels['entries'][string]
export const labelOf = (label: EntryLabel['label'], over: Partial<EntryLabel> = {}): EntryLabel => ({ label, alsoAcceptable: [], rationale: 'SENTINEL-RATIONALE', ...over })

/** The labels of one case, pinned to the request the case makes today unless a test gives another sha. */
export const caseLabelsOf = (c: VerdictCase, entries: CaseLabels['entries'], over: Partial<CaseLabels> = {}): CaseLabels => ({
  caseId: c.id,
  requestSha256: requestShaOf(c),
  labelledBy: 'human',
  entries,
  clashes: [],
  ...over,
})

export const labelSetOf = (cases: CaseLabels[], over: Partial<LabelSet> = {}): LabelSet => ({ version: 'v1', reviewed: true, cases: Object.fromEntries(cases.map((c) => [c.caseId, c])), ...over })

// --- the fit judge ------------------------------------------------------------------------------------------------------------------------------------

export const openIds = (request: FitRequest): string[] => request.shelf.filter((p) => p.floor.status === 'open').map((p) => p.id)

/** Every open product helping, every clash left to the floor. */
export const helpingAll = (request: FitRequest): FitResult => ({ products: openIds(request).map((id) => ({ id, label: 'helping' as const, reason: FIT_REASON, sameJobAs: null })), clashes: [] })

/** Takes the call's cost on the real ledger path (reserve, then settle) so the cap really stops it, then asks the memory fitter; MemoryVerdictFitter spends nothing itself. */
export class SpendingFitter implements VerdictFitter {
  readonly identity: VerdictFitter['identity']
  constructor(
    readonly inner: MemoryVerdictFitter,
    private readonly ledger: MemoryAiSpendLedger,
    private readonly micros: number,
    private readonly events: string[] = [],
  ) {
    this.identity = inner.identity
  }
  async fit(request: FitRequest): Promise<FitResult> {
    this.events.push('fit')
    if (this.micros > 0) {
      const id = await this.ledger.reserve({ job: 'fit-verdict', model: 'fake-model', estimateMicros: this.micros })
      await this.ledger.settle(id, { usage: { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, webSearches: 0 }, costMicros: this.micros })
    }
    return this.inner.fit(request)
  }
}

// --- the harness ---------------------------------------------------------------------------------------------------------------------------------------

export type HarnessOptions = {
  cases?: VerdictCase[]
  set?: VerdictSet
  limit?: number
  capMicros?: number
  /** What each fit call costs on the ledger. */
  micros?: number
  floorOnly?: boolean
  labels?: LabelSet | null
  /** What the judge answers on its n-th call (1-based); every open product helping when it returns undefined. Throw to fail that call. */
  answer?: (call: number, request: FitRequest) => FitResult | undefined
  startedAt?: Date
}

export const harness = ({ cases = [FIXTURE.reactionProduct], set = 'main', limit, capMicros = BIG_CAP_MICROS, micros = MICROS_PER_CALL, floorOnly = false, labels = null, answer = () => undefined, startedAt = BASE }: HarnessOptions = {}) => {
  const ledger = new MemoryAiSpendLedger({ capMicros })
  const inner = new MemoryVerdictFitter()
  const events: string[] = []
  let call = 0
  inner.respondWith((request) => answer(++call, request) ?? helpingAll(request))
  const fitter = new SpendingFitter(inner, ledger, micros, events)
  const logs: string[] = []
  const dirs: string[] = []
  const files = new Map<string, string>()
  const run = async () => {
    const result = await runVerdictEval({
      cases,
      set,
      ...(limit === undefined ? {} : { limit }),
      outDir: OUT,
      startedAt,
      floorOnly,
      reference: FIXTURE_REFERENCE,
      snapshotSha256: SNAPSHOT_SHA,
      labels,
      deps: { fitter: floorOnly ? null : fitter, ledger },
      io: {
        log: (line: string) => logs.push(line),
        mkdir: async (dir: string) => void (dirs.push(dir), events.push('mkdir')),
        writeFile: async (path: string, text: string) => void files.set(path, text),
      },
    })
    return { ...result, report: JSON.parse(files.get(result.reportPath)!) as Report }
  }
  return { ledger, inner, fitter, events, logs, dirs, files, run }
}

export const linesOf = (logs: string[], id: string): string[] => logs.filter((line) => line.startsWith(id))
