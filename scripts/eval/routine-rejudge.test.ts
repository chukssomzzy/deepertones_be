import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { RoutineStep } from '../../src/modules/catalog/catalog.vocabulary'
import type { GateFailure, Routine, RoutineSkeleton } from '../../src/modules/routines/routines.types'
import { routineJudgeJudgeRoutinePrompt } from '../../src/prompts/prompts.generated'
import { type AiJob } from '../../src/providers/anthropic/ai-spend.provider'
import { AnthropicRequestError } from '../../src/providers/anthropic/anthropic.provider'
import { BIG_CAP_MICROS } from '../../src/providers/anthropic/messages-api.fake'
import { MemoryAiSpendLedger } from '../../src/providers/anthropic/memory.ai-spend-ledger'
import { MemoryRoutineWriter } from '../../src/providers/routine-writing/memory.routine-writer'
import type { RoutineWriter } from '../../src/providers/routine-writing/routine-writer.provider'
import { RoutineUsageError } from './routine-args'
import type { RoutineCase } from './routine-cases'
import { type GroundingJudge, type GroundingRequest, type GroundingVerdict, unverifiableGrounding } from './routine-grounding-judge'
import type { PickClass, RoutineJudge, RoutineJudgement } from './routine-judge'
import type { LabelSet } from './routine-labels'
import { defaultRejudgeOutDir, readRejudgeReport, RejudgeReportError, runRejudge } from './routine-rejudge'
import { runRoutineEval } from './routine-run'
import { caseOf, offer, row, snapshotOf } from './routine.fixture'

// `npm run eval:routine:rejudge`: re-judges or re-scores the routines saved in an earlier report.json, with no writer and no page fetches. The pure core (runRejudge)
// is run here with memory judges, a real MemoryAiSpendLedger and injected I/O, over a source report that is made the real way: by running runRoutineEval with a
// memory writer and reading its report.json back through the real reader (readRejudgeReport) from a temp directory. Nothing here calls the API, and nothing
// touches eval-data/ or .eval/.
//
// The shapes these tests name (the implementer builds them in scripts/eval/routine-rejudge.ts):
//   readRejudgeReport(path): Promise<SourceReport>     throws RejudgeReportError for a missing file, a file that is not JSON, JSON of the wrong shape, and a hint-run report
//   defaultRejudgeOutDir(startedAt): string            `.eval/routine-rejudge-<ISO time, colons replaced by dashes>`
//   runRejudge({ report, reportPath, labels, mode, judges, deps: { judges, ledger }, io: { log, mkdir, writeFile }, startedAt, outDir? }): Promise<{ exitCode, outDir }>
//     report: what readRejudgeReport returned; reportPath: where it was read from (the new report's `source.report`); mode: 'rejudge' | 'rescore'
//     judges: the judges to ask, { name, model }[] (rejudge); [] for rescore, which uses the judges the source report names. deps has NO writer and NO grounding judge.
//     A judge whose model is the source report's writer model is refused with a RoutineUsageError before any call or write.

/** The one day every date in this file hangs from: the day the source report was made. The re-judge runs a day later. */
const BASE = new Date('2030-06-15T00:00:00.000Z')
const DAY_MS = 24 * 60 * 60 * 1000
const REJUDGED_AT = new Date(BASE.getTime() + DAY_MS)
const SOURCE_OUT = 'source/run-1'
const SOURCE_REPORT_PATH = join(SOURCE_OUT, 'report.json')
const OUT = 'out/rejudge-1'
const REPORT_PATH = join(OUT, 'report.json')
const WRITER_MICROS = 1000

const WRITER_MODEL = 'claude-test-model'
const HAIKU = 'claude-haiku-5-5'
const OPUS = 'claude-opus-5-5'
const JUDGE_MODELS = { haiku: HAIKU, opus: OPUS } as const
type JudgeName = keyof typeof JUDGE_MODELS

// What must never reach the console: a reason, the expectation, and the judges' problem codes. They are in the report file, which is what proves the check is not vacuous.
const REASON_SENTINEL = 'SENTINEL-REASON'
const EXPECTATION_SENTINEL = 'SENTINEL-EXPECTATION'
const PROBLEMS = ['vague-reason', 'poor-fit'] as const

class FakeWriterError extends Error {}

let tmp: string
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'rejudge-'))
})
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true })
})

// --- the snapshot, the cases and the labels (as routine-run.test.ts: cleanse has two candidates, the other gaps one each) -------------------------

// Only cleanse is a scored gap (two candidates); moisturise and protect have one candidate, so labels cannot be wrong about them.
const SNAPSHOT = snapshotOf([
  offer('NG', row('C-A', { steps: ['cleanse'], priceMin: 1000 })),
  offer('NG', row('C-B', { steps: ['cleanse'], priceMin: 2000 })),
  offer('NG', row('M-1', { steps: ['moisturise'] })),
  offer('NG', row('P-1', { steps: ['protect'], frequency: 'am' })),
])

const casesOf = (count: number): RoutineCase[] => Array.from({ length: count }, (_, i) => caseOf({ id: `hold-0${i + 1}`, persona: (['amara', 'tolu', 'chidi', 'ngozi'] as const)[i % 4]! }))

type Cleanse = { best: string; acceptable?: string[] }

/** A label set over `count` cases: every case's cleanse is labelled `A best` (C-A, C-B acceptable) unless `cleanse` says otherwise for that case index. */
const labelsOf = (version: string, count: number, over: { cleanse?: (index: number) => Cleanse; labelledBy?: string } = {}): LabelSet => ({
  version,
  status: 'provisional',
  snapshotSha256: SNAPSHOT.sha256,
  ...(over.labelledBy === undefined ? {} : { labelledBy: over.labelledBy }),
  cases: Object.fromEntries(
    casesOf(count).map((c, i) => {
      const cleanse = over.cleanse?.(i) ?? { best: 'C-A', acceptable: ['C-B'] }
      return [
        c.id,
        {
          cleanse: { candidates: ['C-A', 'C-B'], best: cleanse.best, acceptable: cleanse.acceptable ?? [] },
          moisturise: { candidates: ['M-1'], best: 'M-1', acceptable: [] },
          protect: { candidates: ['P-1'], best: 'P-1', acceptable: [] },
        },
      ]
    }),
  ) as LabelSet['cases'],
})

// --- the fakes ----------------------------------------------------------------------------------------------------------------------------------

/** A routine that passes every gate: the first candidate of each gap (C-A for cleanse), "use what you have" for the rest. Reasons and expectation hold sentinels. */
const goodRoutine = (skeleton: RoutineSkeleton): Routine => ({
  steps: skeleton.steps.map((step) => {
    const first = skeleton.gaps.find((gap) => gap.step === step)!.candidates[0]
    return first
      ? { step, product: { kind: 'candidate' as const, code: first.code }, frequency: first.frequency, reason: `${REASON_SENTINEL} for ${step}`, grounding: [first.evidenceUrls[0]!] }
      : { step, product: { kind: 'none' as const }, frequency: 'pm' as const, reason: `${REASON_SENTINEL} for ${step}`, grounding: [] }
  }),
  tapers: [],
  expectation: `${EXPECTATION_SENTINEL}: give it 8 to 12 weeks.`,
})

const NO_USAGE = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, webSearches: 0 } as const
const spend = async (ledger: MemoryAiSpendLedger, job: AiJob, micros: number) => {
  if (micros <= 0) return
  const id = await ledger.reserve({ job, model: 'fake-model', estimateMicros: micros })
  await ledger.settle(id, { usage: NO_USAGE, costMicros: micros })
}

/** What a judge says: `cleanse` is its class for the cleanse pick; moisturise and protect (one candidate each, unscored) are always best. */
const judgement = (cleanse: PickClass = 'best', over: Partial<RoutineJudgement> = {}): RoutineJudgement => ({
  picks: [
    { step: 'cleanse', pickClass: cleanse },
    { step: 'moisturise', pickClass: 'best' },
    { step: 'protect', pickClass: 'best' },
  ],
  fit: 4,
  simplicity: 5,
  words: 3,
  problems: [...PROBLEMS],
  ...over,
})

type JudgeInput = { skeleton: RoutineSkeleton; routine: Routine }

/** A rubric judge that takes its call's cost on the real ledger (so a cap really stops it) and records what it was asked. */
class SpendingJudge implements RoutineJudge {
  readonly calls: JudgeInput[] = []
  constructor(
    private readonly ledger: MemoryAiSpendLedger,
    private readonly micros: number,
    private readonly answer: (call: number) => RoutineJudgement,
  ) {}
  async judge(input: JudgeInput): Promise<RoutineJudgement> {
    this.calls.push(input)
    await spend(this.ledger, 'judge-routine', this.micros)
    return this.answer(this.calls.length)
  }
}

// --- the source report: a real run of runRoutineEval, read back through the real reader -----------------------------------------------------------

type SourceOptions = {
  cases?: number
  set?: 'dev' | 'holdout'
  limit?: number
  /** The source run's own cap: writer calls cost 1000 each, so 2500 leaves the third case cut off. */
  capMicros?: number
  model?: string
  /** The source's judges (default haiku alone), each judging as `sourceJudge` says. */
  judgeNames?: JudgeName[]
  sourceJudge?: Partial<Record<JudgeName, (call: number) => RoutineJudgement>>
  /** The writer throws on this call (1-based). */
  writerFailsOn?: number
  /** The first case's protect step is written in the wrong time of day: a gate failure. */
  breakGateOnFirst?: boolean
  /** Verdict of the page-support judge on its n-th call. */
  groundingAnswer?: (call: number) => GroundingVerdict | undefined
  labels?: LabelSet
  /** Edits the report as JSON before it is saved (to add or strip a field). */
  edit?: (raw: Record<string, unknown>) => void
}

let sourceNumber = 0

/** Makes a source report with the real run, saves it under the temp dir and reads it with the real reader. `raw` is the saved JSON. */
const makeSource = async ({ cases = 3, set = 'holdout', limit, capMicros = BIG_CAP_MICROS, model = WRITER_MODEL, judgeNames = ['haiku'], sourceJudge = {}, writerFailsOn, breakGateOnFirst = false, groundingAnswer = () => undefined, labels, edit }: SourceOptions = {}) => {
  const ledger = new MemoryAiSpendLedger({ capMicros })
  const memory = new MemoryRoutineWriter()
  let call = 0
  memory.respondWith((skeleton) => {
    call++
    if (call === writerFailsOn) throw new FakeWriterError('SENTINEL-WRITER-ERROR')
    const routine = goodRoutine(skeleton)
    return breakGateOnFirst && call === 1 ? { ...routine, steps: routine.steps.map((e) => (e.step === 'protect' ? { ...e, frequency: 'pm' as const } : e)) } : routine
  })
  const writer: RoutineWriter = {
    write: async (skeleton) => {
      await spend(ledger, 'write-routine', WRITER_MICROS)
      return memory.write(skeleton)
    },
  }
  const judges = judgeNames.map((name) => ({ name, model: JUDGE_MODELS[name], judge: new SpendingJudge(ledger, 0, sourceJudge[name] ?? (() => judgement())) }))
  let groundingCalls = 0
  const grounding: GroundingJudge = { judge: async (_: GroundingRequest) => groundingAnswer(++groundingCalls) ?? { fetched: true, supports: 'yes' } }
  const files = new Map<string, string>()
  await runRoutineEval({
    cases: casesOf(cases),
    set,
    limit,
    outDir: SOURCE_OUT,
    startedAt: BASE,
    model,
    judges: judges.map(({ name, model }) => ({ name, model })),
    maxGrounding: 100,
    promptHash: 'prompt-hash-123',
    snapshot: SNAPSHOT,
    labels: labels ?? labelsOf('v1', cases),
    deps: { writer, judges, grounding, ledger },
    io: { log: () => undefined, mkdir: async () => undefined, writeFile: async (path, text) => void files.set(path, text) },
  })
  const raw = JSON.parse(files.get(SOURCE_REPORT_PATH)!) as Record<string, unknown>
  edit?.(raw)
  const path = join(tmp, `source-${++sourceNumber}.json`)
  await writeFile(path, JSON.stringify(raw, null, 2))
  return { path, raw, report: await readRejudgeReport(path), writerCalls: memory.calls.length }
}

type Source = Awaited<ReturnType<typeof makeSource>>

type SavedCase = { id: string; state: string; writerError?: string; skeleton: RoutineSkeleton; routine: Routine | null; failures: GateFailure[]; costMicros: number; score: { picks: string; gatesPassed: boolean }; judgements: Record<string, RoutineJudgement | null>; judgeErrors: Record<string, string>; judgeCostMicros: Record<string, number>; judgeRetries: Record<string, number>; grounding: { step: RoutineStep; sourceUrl: string; verdict: GroundingVerdict }[] }
type JudgeRow = { name: string; model: string; agreement: number | null; exactAgreement: number | null; fit: number | null; simplicity: number | null; words: number | null; costMicros: number; agreementPerDollar: number | null; selfAgreement: boolean; retries: number }
type Summary = {
  cases: number
  gatesPassed: number | null
  forbiddenWording: number
  rightProduct: number | null
  exactlyBest: number | null
  judgeAgreement: number | null
  judgeExactAgreement: number | null
  fit: number | null
  simplicity: number | null
  words: number | null
  costMicros: number
  judgeComparison: JudgeRow[]
  selectedJudge: string | null
  groundingChecked: number
  groundingSupported: number
  bar: { status: string; reasons?: string[]; rules?: string[] }
}
type NewReport = {
  startedAt: string
  set: string
  partial: boolean
  snapshotSha256: string
  labelVersion: string | null
  labelledBy: string | null
  model: string
  promptHash: string
  judges: { name: string; model: string }[]
  capMicros: number
  source: { report: string; startedAt: string }
  mode: string
  judgePromptHash: string | null
  cases: SavedCase[]
  summary: Summary
}

type RejudgeSetup = {
  labels?: LabelSet
  mode?: 'rejudge' | 'rescore'
  /** The judges asked (rejudge). Default haiku. Ignored for a rescore, which passes []. */
  judgeNames?: JudgeName[]
  judgeAnswers?: Partial<Record<JudgeName, (call: number) => RoutineJudgement>>
  judgeMicros?: number
  capMicros?: number
  /** null runs with no --out-dir (the default directory). */
  outDir?: string | null
}

/** The fakes and the run for one re-judge of `source`. deps holds judges and a ledger and nothing else: a writer is not a thing a re-judge has. */
const rejudgeOf = (source: Source, { labels, mode = 'rejudge', judgeNames = ['haiku'], judgeAnswers = {}, judgeMicros = 0, capMicros = BIG_CAP_MICROS, outDir = OUT }: RejudgeSetup = {}) => {
  const ledger = new MemoryAiSpendLedger({ capMicros })
  // For a rescore the judges are spied on too (to prove they are never asked), but not named: the saved judgements of the source's own judges are used.
  const fakes = (mode === 'rescore' ? (['haiku', 'opus'] as const) : judgeNames).map((name) => ({ name, model: JUDGE_MODELS[name], judge: new SpendingJudge(ledger, judgeMicros, judgeAnswers[name] ?? (() => judgement())) }))
  const judges = Object.fromEntries(fakes.map((j) => [j.name, j.judge])) as Record<JudgeName, SpendingJudge>
  const logs: string[] = []
  const dirs: string[] = []
  const files = new Map<string, string>()
  const run = () =>
    runRejudge({
      report: source.report,
      reportPath: source.path,
      labels: labels ?? labelsOf('v1', source.report.cases.length),
      mode,
      judges: mode === 'rescore' ? [] : fakes.map(({ name, model }) => ({ name, model })),
      deps: { judges: fakes, ledger },
      io: {
        log: (line) => logs.push(line),
        mkdir: async (dir) => void dirs.push(dir),
        writeFile: async (path, text) => void files.set(path, text),
      },
      startedAt: REJUDGED_AT,
      ...(outDir === null ? {} : { outDir }),
    })
  return { ledger, judges, logs, dirs, files, run }
}

const reportOf = (files: Map<string, string>, path = REPORT_PATH): NewReport => JSON.parse(files.get(path)!)
const lineOf = (logs: string[], id: string) => logs.filter((l) => l.startsWith(id))
const savedCases = (source: Source): SavedCase[] => source.raw.cases as SavedCase[]

// --- the report reader --------------------------------------------------------------------------------------------------------------------------

describe('readRejudgeReport: the report it re-judges', () => {
  it('reads a report written by eval:routine: the set, whether it was partial, the writer model, the hashes and every case', async () => {
    const source = await makeSource()

    expect(source.report).toMatchObject({ set: 'holdout', partial: false, model: WRITER_MODEL, promptHash: 'prompt-hash-123', snapshotSha256: SNAPSHOT.sha256 })
    expect(source.report.cases.map((c) => c.id)).toEqual(['hold-01', 'hold-02', 'hold-03'])
    expect(source.report.cases[0]).toMatchObject({ id: 'hold-01', state: 'done', failures: [], routine: savedCases(source)[0]!.routine, skeleton: savedCases(source)[0]!.skeleton })
  })

  it('refuses a missing file with a RejudgeReportError, and names the path', async () => {
    const missing = join(tmp, 'no-such-report.json')

    await expect(readRejudgeReport(missing)).rejects.toThrow(RejudgeReportError)
    await expect(readRejudgeReport(missing)).rejects.toThrow(/no-such-report\.json/)
  })

  it('refuses a file that is not JSON with a RejudgeReportError', async () => {
    const path = join(tmp, 'not-json.json')
    await writeFile(path, '{ this is not json')

    await expect(readRejudgeReport(path)).rejects.toThrow(RejudgeReportError)
  })

  it.each([
    ['JSON that is not an object', '[1, 2, 3]'],
    ['an object with none of the fields', '{}'],
    ['a report with no cases', JSON.stringify({ set: 'holdout', partial: false, model: WRITER_MODEL, promptHash: 'h', snapshotSha256: 'a'.repeat(64), startedAt: BASE.toISOString() })],
  ])('refuses %s with a RejudgeReportError', async (_label, text) => {
    const path = join(tmp, `bad-${_label.replace(/\W+/g, '-')}.json`)
    await writeFile(path, text)

    await expect(readRejudgeReport(path)).rejects.toThrow(RejudgeReportError)
  })

  it('refuses a report whose case has no skeleton, or a routine of the wrong shape: the fields it re-judges on must be there', async () => {
    const noSkeleton = await makeSource({ edit: (raw) => void delete (raw.cases as Record<string, unknown>[])[0]!.skeleton })
      .then(() => 'unreachable')
      .catch((error: unknown) => error)
    const badRoutine = await makeSource({ edit: (raw) => void ((raw.cases as Record<string, unknown>[])[1]!.routine = { steps: 'many' }) })
      .then(() => 'unreachable')
      .catch((error: unknown) => error)

    expect(noSkeleton).toBeInstanceOf(RejudgeReportError)
    expect(badRoutine).toBeInstanceOf(RejudgeReportError)
  })

  it('refuses a hint-run report (set hints) with a RejudgeReportError that says so: it holds no routines to judge', async () => {
    // The shape routine-hints-run.ts writes: results, not cases.
    const hints = { startedAt: BASE.toISOString(), set: 'hints', snapshotSha256: SNAPSHOT.sha256, labelVersion: 'v1', labelSnapshotSha256: SNAPSHOT.sha256, model: WRITER_MODEL, promptHash: 'p', capMicros: BIG_CAP_MICROS, partial: false, needsRelabel: [], results: [], summary: { cases: 0, costMicros: 0 } }
    const path = join(tmp, 'hints-report.json')
    await writeFile(path, JSON.stringify(hints))

    await expect(readRejudgeReport(path)).rejects.toThrow(RejudgeReportError)
    await expect(readRejudgeReport(path)).rejects.toThrow(/hints/)
  })

  it('refuses a run report that was relabelled as a hint run, so the refusal is the set and nothing else', async () => {
    // A real run report with only its set changed: the one thing wrong with it is that it says hints.
    const real = await makeSource()
    const path = join(tmp, 'real-as-hints.json')
    await writeFile(path, JSON.stringify({ ...real.raw, set: 'hints' }))

    await expect(readRejudgeReport(path)).rejects.toThrow(/hints/)
  })

  it('does not echo the file\'s contents in its error', async () => {
    const path = join(tmp, 'leaky.json')
    await writeFile(path, '{"SENTINEL-FILE-TEXT": ')

    await expect(readRejudgeReport(path)).rejects.not.toThrow(/SENTINEL-FILE-TEXT/)
  })
})

describe('defaultRejudgeOutDir', () => {
  it('is named after the start time, without a colon, and apart from eval:routine\'s own directories', () => {
    expect(defaultRejudgeOutDir(BASE)).toBe('.eval/routine-rejudge-2030-06-15T00-00-00.000Z')
  })
})

// --- re-judging: only the judges are asked ----------------------------------------------------------------------------------------------------

describe('runRejudge: it judges the saved routines and nothing else', () => {
  it('asks each judge for each saved routine with exactly the saved { skeleton, routine }, in case order, and spends only on the judge job', async () => {
    const source = await makeSource()
    const { run, judges, ledger } = rejudgeOf(source, { judgeMicros: 100 })

    await run()

    expect(judges.haiku.calls).toEqual(savedCases(source).map(({ skeleton, routine }) => ({ skeleton, routine })))
    expect(ledger.entries).toHaveLength(3)
    expect(ledger.entries.every((entry) => entry.job === 'judge-routine')).toBe(true)
  })

  it('asks every judge named, in the order given, each of them for every routine', async () => {
    const source = await makeSource()
    const { run, judges, files } = rejudgeOf(source, { judgeNames: ['opus', 'haiku'] })

    await run()

    expect(judges.opus.calls).toHaveLength(3)
    expect(judges.haiku.calls).toHaveLength(3)
    expect(reportOf(files).judges).toEqual([
      { name: 'opus', model: OPUS },
      { name: 'haiku', model: HAIKU },
    ])
    expect(Object.keys(reportOf(files).cases[0]!.judgements)).toEqual(['opus', 'haiku'])
  })

  it('does not judge a case the writer failed on, keeps its state and its writer error, and judges the others', async () => {
    const source = await makeSource({ writerFailsOn: 2 })
    const { run, judges, files } = rejudgeOf(source)

    await run()

    expect(judges.haiku.calls).toEqual([savedCases(source)[0], savedCases(source)[2]].map((c) => ({ skeleton: c!.skeleton, routine: c!.routine })))
    const [first, second, third] = reportOf(files).cases
    expect(second).toMatchObject({ id: 'hold-02', state: 'writer-error', writerError: 'FakeWriterError', routine: null, judgements: { haiku: null } })
    expect(first!.judgements.haiku).not.toBeNull()
    expect(third!.judgements.haiku).not.toBeNull()
    // A writer that failed is a failed routine, as in the run that made the report.
    expect(reportOf(files).summary.gatesPassed).toBeCloseTo(200 / 3)
  })

  it('does not judge a case the source run never reached, keeps it cut off, and leaves it out of the percentages', async () => {
    // The source's cap is 2500 and a writer call costs 1000: the third case was cut off.
    const source = await makeSource({ capMicros: 2500 })
    expect(savedCases(source).map((c) => c.state)).toEqual(['done', 'done', 'cut-off'])
    const { run, judges, files } = rejudgeOf(source)

    await run()

    expect(judges.haiku.calls).toHaveLength(2)
    const report = reportOf(files)
    expect(report.cases.map((c) => c.state)).toEqual(['done', 'done', 'cut-off'])
    expect(report.cases[2]).toMatchObject({ routine: null, judgements: { haiku: null } })
    expect(report.summary.gatesPassed).toBe(100)
    expect(report.partial).toBe(true)
  })

  it('carries the saved gate failures over unchanged, judges that routine anyway, and does not run the gates again', async () => {
    const source = await makeSource({ breakGateOnFirst: true })
    const saved = savedCases(source)
    expect(saved[0]!.failures.length).toBeGreaterThan(0)
    const { run, judges, files } = rejudgeOf(source)

    await run()

    const report = reportOf(files)
    expect(report.cases.map((c) => c.failures)).toEqual(saved.map((c) => c.failures))
    expect(judges.haiku.calls).toHaveLength(3)
    expect(report.summary.gatesPassed).toBeCloseTo(200 / 3)
    expect(report.summary.bar).toMatchObject({ status: 'fail', rules: expect.arrayContaining(['gates']) })
  })

  it('trusts the saved failures: a case saved with none stays clean even if the saved routine is later altered to break a gate', async () => {
    // The gates are not re-run: the routine below is altered after the run, and its saved failures (none) stand.
    const source = await makeSource({
      edit: (raw) => {
        const first = (raw.cases as SavedCase[])[0]!
        first.routine = { ...first.routine!, steps: first.routine!.steps.map((e) => (e.step === 'protect' ? { ...e, frequency: 'pm' as const } : e)) }
      },
    })
    const { run, files } = rejudgeOf(source)

    await run()

    expect(reportOf(files).cases[0]!.failures).toEqual([])
    expect(reportOf(files).summary.gatesPassed).toBe(100)
  })

  it('copies the page-support results as the source had them, and fetches nothing: the support score is the source\'s', async () => {
    // Case 2's first link could not be verified; the other 8 of 9 are supported.
    const source = await makeSource({ groundingAnswer: (call) => (call === 4 ? unverifiableGrounding('api-error') : undefined) })
    const saved = savedCases(source)
    expect(saved.flatMap((c) => c.grounding)).toHaveLength(9)
    const { run, files, ledger } = rejudgeOf(source)

    await run()

    const report = reportOf(files)
    expect(report.cases.map((c) => c.grounding)).toEqual(saved.map((c) => c.grounding))
    expect(report.summary).toMatchObject({ groundingChecked: 9, groundingSupported: 8 })
    expect(ledger.entries.some((entry) => entry.job === 'judge-grounding')).toBe(false)
  })

  it('carries over the source run\'s set, snapshot, writer model, writer prompt hash and which cases it covered', async () => {
    const source = await makeSource({ set: 'dev', model: 'claude-other-writer' })
    const { run, files } = rejudgeOf(source)

    await run()

    expect(reportOf(files)).toMatchObject({ set: 'dev', snapshotSha256: SNAPSHOT.sha256, model: 'claude-other-writer', promptHash: 'prompt-hash-123' })
    expect(reportOf(files).cases.map((c) => c.id)).toEqual(['hold-01', 'hold-02', 'hold-03'])
  })
})

// --- scoring against another label set ----------------------------------------------------------------------------------------------------------

describe('runRejudge: the labels it scores against', () => {
  // Cleanse is the only scored gap (two candidates), so there are 3 scored gaps and the writer picked C-A in each case.
  // v1: C-A is best everywhere: right product 100% and exactly best 100%.
  // v2: in hold-01 C-B is best and C-A is not acceptable, so the pick is wrong; hold-02 and hold-03 as before. 2 of 3 right = 66.67%, 2 of 3 best.
  const V2 = (version = 'v2') => labelsOf(version, 3, { cleanse: (i) => (i === 0 ? { best: 'C-B' } : { best: 'C-A', acceptable: ['C-B'] }) })

  it('scores the same routines 100% right product under v1 and 2 of 3 under v2: the pick that is right under v1 and wrong under v2 changes the figure', async () => {
    const source = await makeSource()
    expect(source.report).toMatchObject({ set: 'holdout' })
    const underV1 = rejudgeOf(source, { labels: labelsOf('v1', 3) })
    const underV2 = rejudgeOf(source, { labels: V2() })

    await underV1.run()
    await underV2.run()

    expect(reportOf(underV1.files).summary).toMatchObject({ rightProduct: 100, exactlyBest: 100 })
    const v2 = reportOf(underV2.files)
    expect(v2.summary.rightProduct).toBeCloseTo(200 / 3)
    expect(v2.summary.exactlyBest).toBeCloseTo(200 / 3)
    expect(v2.cases.map((c) => c.score.picks)).toEqual(['wrong', 'right', 'right'])
    expect(v2.labelVersion).toBe('v2')
  })

  it('agreement is the new judge against the new labels: a judge that says "not" where v2 says not agrees 3 of 3', async () => {
    // Under v2 the pick in hold-01 is "not"; the judge's classes for the three cleanse picks are not, best, best.
    const source = await makeSource()
    const { run, files } = rejudgeOf(source, { labels: V2(), judgeAnswers: { haiku: (call) => judgement(call === 1 ? 'not' : 'best') } })

    await run()

    expect(reportOf(files).summary).toMatchObject({ judgeAgreement: 100, judgeExactAgreement: 100, selectedJudge: 'haiku' })
  })

  it('a pick right under v2 but wrong under v1 is counted too, and the bar is the new labels\' bar: v2 fails right-product, listing nothing else', async () => {
    const source = await makeSource()
    const { run, files, logs } = rejudgeOf(source, { labels: V2(), judgeAnswers: { haiku: (call) => judgement(call === 1 ? 'not' : 'best') } })

    const { exitCode } = await run()

    expect(reportOf(files).summary.bar).toEqual({ status: 'fail', rules: ['right-product'], notEvaluated: [] })
    expect(logs.at(-1)).toBe('Bar: FAIL (right-product)')
    expect(exitCode).toBe(1)
  })

  it('names the label set in the report: its version, the snapshot it was made on and who made it', async () => {
    const source = await makeSource()
    const { run, files } = rejudgeOf(source, { labels: { ...V2('v2-derm'), labelledBy: 'human' } })

    await run()

    expect(reportOf(files)).toMatchObject({ labelVersion: 'v2-derm', labelSnapshotSha256: SNAPSHOT.sha256, labelledBy: 'human' })
  })

  it('a judge that made the labels is still self-agreement: it is reported, marked, and not selected (a model never grades its own work)', async () => {
    // Haiku made these labels. With haiku alone no judge may count; with opus beside it, opus is selected.
    const labels = labelsOf('v1', 3, { labelledBy: HAIKU })
    const alone = rejudgeOf(await makeSource(), { labels })
    const both = rejudgeOf(await makeSource(), { labels, judgeNames: ['haiku', 'opus'] })

    await alone.run()
    await both.run()

    const one = reportOf(alone.files).summary
    expect(one.selectedJudge).toBeNull()
    expect(one.judgeAgreement).toBeNull()
    expect(one.judgeComparison[0]).toMatchObject({ name: 'haiku', selfAgreement: true, agreement: 100 })
    expect(one.bar).toEqual({ status: 'not-evaluated', reasons: ['judge-self-labelled'] })
    expect(alone.logs.at(-1)).toBe('Bar: not evaluated (judge-self-labelled)')
    expect(alone.logs.find((l) => l.startsWith('Judge haiku'))).toContain('(self-agreement: made the labels)')
    const two = reportOf(both.files).summary
    expect(two.selectedJudge).toBe('opus')
    expect(two.judgeComparison.map((row) => row.selfAgreement)).toEqual([true, false])
  })
})

// --- the bar --------------------------------------------------------------------------------------------------------------------------------------

describe('runRejudge: the bar is the source run\'s', () => {
  it('can PASS for a full holdout source: the routines are complete, labelled, clean and the judge agrees, and it exits 0', async () => {
    const source = await makeSource()
    const { run, files, logs } = rejudgeOf(source)

    const { exitCode } = await run()

    expect(reportOf(files)).toMatchObject({ set: 'holdout', partial: false })
    expect(reportOf(files).summary.bar).toEqual({ status: 'pass' })
    expect(logs.at(-1)).toBe('Bar: PASS')
    expect(exitCode).toBe(0)
  })

  it('can FAIL for a full holdout source: a judge that disagrees with every label fails judge-agreement, and it exits 1', async () => {
    // The labels say C-A is best; the judge says it is not, in every case: 0 of 3.
    const source = await makeSource()
    const { run, files, logs } = rejudgeOf(source, { judgeAnswers: { haiku: () => judgement('not') } })

    const { exitCode } = await run()

    expect(reportOf(files).summary.bar).toEqual({ status: 'fail', rules: ['judge-agreement'], notEvaluated: [] })
    expect(logs.at(-1)).toBe('Bar: FAIL (judge-agreement)')
    expect(exitCode).toBe(1)
  })

  it('stays a trial for a partial source (a --limit run): not evaluated for partial-run however well it is judged, and exit 0', async () => {
    const source = await makeSource({ limit: 2 })
    expect(source.report.partial).toBe(true)
    const { run, files, logs } = rejudgeOf(source)

    const { exitCode } = await run()

    expect(reportOf(files).partial).toBe(true)
    expect(reportOf(files).summary.bar).toEqual({ status: 'not-evaluated', reasons: ['partial-run'] })
    expect(logs.at(-1)).toBe('Bar: not evaluated (partial-run)')
    expect(exitCode).toBe(0)
  })

  it('does not evaluate a dev source: the dev set is for tuning', async () => {
    const source = await makeSource({ set: 'dev' })
    const { run, files, logs } = rejudgeOf(source)

    const { exitCode } = await run()

    expect(reportOf(files).set).toBe('dev')
    expect(reportOf(files).summary.bar).toEqual({ status: 'not-evaluated', reasons: ['dev-set'] })
    expect(logs.at(-1)).toBe('Bar: not evaluated (dev-set)')
    expect(exitCode).toBe(0)
  })
})

describe('runRejudge: the spend cap', () => {
  // Four saved routines, 1000 a judge call, cap 2500: calls 1 and 2 fit (2000), the reservation for call 3 would make 3000.
  it('makes the run partial when the cap stops a judge, asks for nothing more and retries nothing', async () => {
    const source = await makeSource({ cases: 4 })
    const { run, judges, files, logs, ledger } = rejudgeOf(source, { judgeMicros: 1000, capMicros: 2500 })

    await run()

    // The third call was refused by the ledger; the fourth routine was never asked about, and the third was not asked again.
    expect(judges.haiku.calls).toHaveLength(3)
    expect(ledger.spentMicros()).toBe(2000)
    const report = reportOf(files)
    expect(report.partial).toBe(true)
    expect(report.summary.bar).toMatchObject({ status: expect.stringMatching(/not-evaluated|fail/) })
    expect(JSON.stringify(report.summary.bar)).toContain('partial-run')
    expect(report.cases[0]!.judgements.haiku).not.toBeNull()
    expect(report.cases[1]!.judgements.haiku).not.toBeNull()
    expect(report.cases[2]!.judgements.haiku).toBeNull()
    expect(report.cases[2]!.judgeErrors).toEqual({ haiku: 'AiBudgetExceededError' })
    expect(report.cases[3]!.judgements.haiku).toBeNull()
    expect(logs.join('\n')).toMatch(/spend cap/i)
  })

  it('spends no more than --max-usd in total, the judge calls it did make counted per judge in the comparison', async () => {
    const source = await makeSource({ cases: 4 })
    const { run, files } = rejudgeOf(source, { judgeMicros: 1000, capMicros: 2500 })

    await run()

    expect(reportOf(files)).toMatchObject({ capMicros: 2500 })
    expect(reportOf(files).summary.judgeComparison[0]).toMatchObject({ name: 'haiku', costMicros: 2000 })
  })
})

describe('runRejudge: a rubric judge answer that is invalid is retried once', () => {
  /** The judge fails with an AnthropicRequestError on its n-th call (counted over the whole re-judge, retries included). */
  const failingOn = (...failing: number[]) => (call: number): RoutineJudgement => {
    if (failing.includes(call)) throw new AnthropicRequestError('SENTINEL-JUDGE-ERROR-MESSAGE')
    return judgement()
  }

  it('asks again about the same saved routine when the answer is invalid, keeps the second answer, and records the retry on the case, in the judge\'s row and on its console line', async () => {
    // Three saved routines; calls: 1 is hold-01, 2 fails on hold-02, 3 is hold-02 again, 4 is hold-03.
    const source = await makeSource()
    const { run, judges, files, logs } = rejudgeOf(source, { judgeAnswers: { haiku: failingOn(2) } })

    await run()

    expect(judges.haiku.calls).toHaveLength(4)
    expect(judges.haiku.calls[2]).toEqual(judges.haiku.calls[1])
    expect(judges.haiku.calls[1]!.routine).toEqual(savedCases(source)[1]!.routine)
    const report = reportOf(files)
    expect(report.cases[1]!.judgements.haiku).toEqual(judgement())
    expect(report.cases[1]!.judgeErrors).toEqual({})
    expect(report.cases.map((c) => c.judgeRetries)).toEqual([{ haiku: 0 }, { haiku: 1 }, { haiku: 0 }])
    expect(report.summary.judgeComparison[0]).toMatchObject({ name: 'haiku', retries: 1 })
    expect(logs.find((l) => l.startsWith('Judge haiku'))!).toMatch(/, retried 1$/)
  })

  it('lets the bar be evaluated, and pass, when the one judge\'s only failure is retried', async () => {
    const source = await makeSource()
    const { run, files, logs } = rejudgeOf(source, { judgeAnswers: { haiku: failingOn(1) } })

    const { exitCode } = await run()

    expect(reportOf(files).summary.bar).toEqual({ status: 'pass' })
    expect(logs.at(-1)).toBe('Bar: PASS')
    expect(exitCode).toBe(0)
  })

  it('counts the retry in the case\'s judge cost and in the judge\'s total: a failed call and its retry are 200 on that case', async () => {
    const source = await makeSource()
    const { run, files, ledger } = rejudgeOf(source, { judgeMicros: 100, judgeAnswers: { haiku: failingOn(1) } })

    await run()

    const report = reportOf(files)
    expect(report.cases.map((c) => c.judgeCostMicros)).toEqual([{ haiku: 200 }, { haiku: 100 }, { haiku: 100 }])
    expect(report.summary.judgeComparison[0]).toMatchObject({ costMicros: 400 })
    expect(ledger.spentMicros()).toBe(400)
  })

  it('leaves the case unjudged with the error\'s class name, after two calls and no more, when the retry fails too, and says no-judge for a single judge', async () => {
    const source = await makeSource()
    const { run, judges, files, logs } = rejudgeOf(source, { judgeAnswers: { haiku: failingOn(2, 3) } })

    await run()

    expect(judges.haiku.calls).toHaveLength(4)
    const report = reportOf(files)
    expect(report.cases[1]).toMatchObject({ judgements: { haiku: null }, judgeErrors: { haiku: 'AnthropicRequestError' } })
    expect(JSON.stringify(report)).not.toContain('SENTINEL-JUDGE-ERROR-MESSAGE')
    expect(logs.join('\n')).not.toContain('SENTINEL-JUDGE-ERROR-MESSAGE')
    expect(logs.at(-1)).toBe('Bar: not evaluated (no-judge)')
  })

  it('stops at the cap, as for any cap hit, when the retry is the call the cap refuses: no retry loop, nothing more asked, partial', async () => {
    // Four saved routines, 1000 a judge call, cap 2500. hold-01 takes call 1 (1000); hold-02's call 2 fails (2000); its retry would make 3000 and is refused.
    const source = await makeSource({ cases: 4 })
    const { run, judges, files, logs, ledger } = rejudgeOf(source, { judgeMicros: 1000, capMicros: 2500, judgeAnswers: { haiku: failingOn(2) } })

    await run()

    expect(judges.haiku.calls).toHaveLength(3)
    expect(ledger.spentMicros()).toBe(2000)
    const report = reportOf(files)
    expect(report.partial).toBe(true)
    expect(report.cases[0]!.judgements.haiku).not.toBeNull()
    expect(report.cases[1]).toMatchObject({ judgements: { haiku: null }, judgeErrors: { haiku: 'AiBudgetExceededError' } })
    expect(report.cases[2]!.judgements.haiku).toBeNull()
    expect(report.cases[3]!.judgements.haiku).toBeNull()
    expect(logs.join('\n')).toMatch(/spend cap/i)
  })

  it('records no retries and prints no "retried" when nothing failed', async () => {
    const source = await makeSource({ judgeNames: ['haiku', 'opus'] })
    const { run, files, logs } = rejudgeOf(source, { judgeNames: ['haiku', 'opus'] })

    await run()

    const report = reportOf(files)
    expect(report.cases.map((c) => c.judgeRetries)).toEqual([{ haiku: 0, opus: 0 }, { haiku: 0, opus: 0 }, { haiku: 0, opus: 0 }])
    expect(report.summary.judgeComparison.map((row) => row.retries)).toEqual([0, 0])
    expect(logs.join('\n')).not.toContain('retried')
  })

  it('still makes no calls on --rescore, whether or not the source run had a retry', async () => {
    const source = await makeSource({ sourceJudge: { haiku: (call) => { if (call === 2) throw new AnthropicRequestError('SENTINEL-JUDGE-ERROR-MESSAGE'); return judgement() } } })
    const { run, judges, ledger } = rejudgeOf(source, { mode: 'rescore' })

    await run()

    expect(judges.haiku.calls).toEqual([])
    expect(judges.opus.calls).toEqual([])
    expect(ledger.entries).toEqual([])
  })
})

// --- --rescore --------------------------------------------------------------------------------------------------------------------------------

describe('runRejudge: --rescore makes no calls', () => {
  // The source has two judges: haiku says "not" for hold-02's cleanse pick (labelled best), so it agrees 2 of 3 = 66.67%; opus agrees 3 of 3. Both are free, so opus is selected.
  const twoJudgeSource = () => makeSource({ judgeNames: ['haiku', 'opus'], sourceJudge: { haiku: (call) => judgement(call === 2 ? 'not' : 'best'), opus: () => judgement('best', { fit: 2, simplicity: 3, words: 4 }) } })

  it('asks no judge, spends nothing, and names the judges of the source report', async () => {
    const source = await twoJudgeSource()
    const { run, judges, ledger, files } = rejudgeOf(source, { mode: 'rescore' })

    await run()

    expect(judges.haiku.calls).toEqual([])
    expect(judges.opus.calls).toEqual([])
    expect(ledger.entries).toEqual([])
    expect(reportOf(files).judges).toEqual([
      { name: 'haiku', model: HAIKU },
      { name: 'opus', model: OPUS },
    ])
    expect(reportOf(files).mode).toBe('rescore')
  })

  it('reproduces the source run\'s numbers when given the same labels', async () => {
    const source = await twoJudgeSource()
    const { run, files } = rejudgeOf(source, { mode: 'rescore', labels: labelsOf('v1', 3) })

    await run()

    const before = (source.raw.summary as Summary)
    const after = reportOf(files).summary
    expect(after.judgeAgreement).toBeCloseTo(100)
    for (const key of ['cases', 'gatesPassed', 'forbiddenWording', 'rightProduct', 'exactlyBest', 'judgeAgreement', 'judgeExactAgreement', 'fit', 'simplicity', 'words', 'selectedJudge', 'bar'] as const) expect(after[key], key).toEqual(before[key])
    expect(after.judgeComparison.map(({ costMicros: _cost, ...rest }) => rest)).toEqual(before.judgeComparison.map(({ costMicros: _cost, ...rest }) => rest))
    expect(after.selectedJudge).toBe('opus')
    expect(reportOf(files).cases.map((c) => c.judgements)).toEqual(savedCases(source).map((c) => c.judgements))
  })

  it('scores the saved judgements against other labels: judge classes saved as best, v2 says the hold-01 pick is not, so agreement is 2 of 3', async () => {
    // The saved haiku said "best" for all three picks. Under v2 hold-01's pick is "not", so its saved "best" disagrees: 2 of 3 = 66.67% agreement.
    const source = await makeSource()
    const v2 = labelsOf('v2', 3, { cleanse: (i) => (i === 0 ? { best: 'C-B' } : { best: 'C-A', acceptable: ['C-B'] }) })
    const { run, files, judges } = rejudgeOf(source, { mode: 'rescore', labels: v2 })

    await run()

    const { summary } = reportOf(files)
    expect(summary.judgeAgreement).toBeCloseTo(200 / 3)
    expect(summary.rightProduct).toBeCloseTo(200 / 3)
    expect(summary.bar).toMatchObject({ status: 'fail', rules: expect.arrayContaining(['judge-agreement', 'right-product']) })
    expect(judges.haiku.calls).toEqual([])
  })

  it('carries the gate failures and page-support results over, as a re-judge does', async () => {
    const source = await makeSource({ breakGateOnFirst: true })
    const { run, files } = rejudgeOf(source, { mode: 'rescore' })

    await run()

    expect(reportOf(files).cases.map((c) => c.failures)).toEqual(savedCases(source).map((c) => c.failures))
    expect(reportOf(files).cases.map((c) => c.grounding)).toEqual(savedCases(source).map((c) => c.grounding))
  })

  it('keeps a case with no routine unjudged and unscored, and a cut-off case cut off', async () => {
    const source = await makeSource({ capMicros: 2500 })
    const { run, files } = rejudgeOf(source, { mode: 'rescore' })

    await run()

    expect(reportOf(files).cases.map((c) => c.state)).toEqual(['done', 'done', 'cut-off'])
    expect(reportOf(files).partial).toBe(true)
  })
})

// --- the report and the console ---------------------------------------------------------------------------------------------------------------

describe('runRejudge: the report', () => {
  it('is a new report beside the source: where it came from, how it was made, the judge prompt it ran with, and when', async () => {
    const source = await makeSource()
    const { run, files, dirs } = rejudgeOf(source)

    const result = await run()

    expect(dirs).toEqual([OUT])
    expect([...files.keys()]).toEqual([REPORT_PATH])
    expect(result.outDir).toBe(OUT)
    expect(reportOf(files)).toMatchObject({
      startedAt: REJUDGED_AT.toISOString(),
      source: { report: source.path, startedAt: BASE.toISOString() },
      mode: 'rejudge',
      judgePromptHash: routineJudgeJudgeRoutinePrompt.hash,
      capMicros: BIG_CAP_MICROS,
    })
    expect(routineJudgeJudgeRoutinePrompt.hash).toEqual(expect.any(String))
  })

  it('has the shape of a run\'s report: every case with its skeleton, routine, failures, score, judgements and judge costs, and a summary with the judge comparison', async () => {
    const source = await makeSource()
    const { run, files } = rejudgeOf(source, { judgeMicros: 100 })

    await run()

    const [first] = reportOf(files).cases
    expect(first).toMatchObject({ id: 'hold-01', state: 'done', skeleton: savedCases(source)[0]!.skeleton, routine: savedCases(source)[0]!.routine, score: { gatesPassed: true, picks: 'right' }, judgeErrors: {}, judgeCostMicros: { haiku: 100 } })
    expect(first!.judgements.haiku).toEqual(judgement())
    expect(reportOf(files).summary).toMatchObject({ selectedJudge: 'haiku', judgeAgreement: 100, fit: 4, simplicity: 5, words: 3 })
    expect(reportOf(files).summary.judgeComparison).toEqual([expect.objectContaining({ name: 'haiku', model: HAIKU, agreement: 100, costMicros: 300 })])
  })

  it('for a rescore, copies the judge prompt hash the source report had', async () => {
    const source = await makeSource({ edit: (raw) => void (raw.judgePromptHash = 'judge-prompt-hash-of-the-source') })
    const { run, files } = rejudgeOf(source, { mode: 'rescore' })

    await run()

    expect(reportOf(files).judgePromptHash).toBe('judge-prompt-hash-of-the-source')
  })

  it('for a rescore of a source with no judge prompt hash (an older report), says null: it cannot tell which judge prompt made the judgements', async () => {
    const source = await makeSource({ edit: (raw) => void delete raw.judgePromptHash })
    const { run, files } = rejudgeOf(source, { mode: 'rescore' })

    await run()

    expect(reportOf(files).judgePromptHash).toBeNull()
  })

  it('for a re-judge, uses today\'s judge prompt hash even when the source named another', async () => {
    const source = await makeSource({ edit: (raw) => void (raw.judgePromptHash = 'judge-prompt-hash-of-the-source') })
    const { run, files } = rejudgeOf(source)

    await run()

    expect(reportOf(files).judgePromptHash).toBe(routineJudgeJudgeRoutinePrompt.hash)
  })

  it('goes to the default directory named after the start time when no --out-dir is given, and never to the source\'s path', async () => {
    const source = await makeSource()
    const { run, files, dirs } = rejudgeOf(source, { outDir: null })

    const result = await run()

    const dir = '.eval/routine-rejudge-2030-06-16T00-00-00.000Z'
    expect(result.outDir).toBe(dir)
    expect(dirs).toEqual([dir])
    expect([...files.keys()]).toEqual([join(dir, 'report.json')])
    expect([...files.keys()]).not.toContain(source.path)
  })

  it('writes one new file and leaves the source report alone, even when the out directory is the source\'s own directory name', async () => {
    const source = await makeSource()
    const { run, files } = rejudgeOf(source)

    await run()

    expect(files.has(source.path)).toBe(false)
    expect(REPORT_PATH).not.toBe(source.path)
  })
})

describe('runRejudge: the console', () => {
  it('prints one line per case that starts with its id, with the gate result from the saved failures, the picks and the cost; a failed gate shows its code', async () => {
    const source = await makeSource({ breakGateOnFirst: true, writerFailsOn: 3 })
    const saved = savedCases(source)
    const { run, logs } = rejudgeOf(source)

    await run()

    for (const id of ['hold-01', 'hold-02', 'hold-03']) expect(lineOf(logs, id), id).toHaveLength(1)
    const failedGate = saved[0]!.failures[0]!.gate
    expect(lineOf(logs, 'hold-01')[0]).toContain(failedGate)
    expect(lineOf(logs, 'hold-02')[0]).toContain('ok')
    expect(lineOf(logs, 'hold-02')[0]).toContain('right')
    expect(lineOf(logs, 'hold-03')[0]).toContain('error FakeWriterError')
  })

  it('prints a judge line with agreement and exact agreement, the selected judge and the bar line, in that order, ending on the bar', async () => {
    const source = await makeSource()
    const { run, logs } = rejudgeOf(source, { judgeMicros: 100 })

    await run()

    const judgeLine = logs.findIndex((l) => l.startsWith('Judge haiku'))
    const selected = logs.findIndex((l) => l.startsWith('Selected judge: haiku'))
    expect(logs[judgeLine]).toContain('agreement 100.0% (exact 100.0%)')
    expect(logs[judgeLine]).toContain('$0.0003')
    expect(judgeLine).toBeGreaterThan(-1)
    expect(selected).toBeGreaterThan(judgeLine)
    expect(logs.at(-1)).toBe('Bar: PASS')
    expect(logs.find((l) => l.startsWith('Report:'))).toBe(`Report: ${REPORT_PATH}`)
  })

  it('says it spent nothing on a rescore', async () => {
    const source = await makeSource()
    const { run, logs } = rejudgeOf(source, { mode: 'rescore' })

    await run()

    expect(logs.join('\n')).toContain('Spent $0.0000')
  })

  it('never prints a judge\'s problem codes or a routine\'s words, and no extra line starts with a case id', async () => {
    const source = await makeSource()
    const { run, logs, files } = rejudgeOf(source)

    await run()

    const printed = logs.join('\n')
    for (const code of PROBLEMS) expect(printed, code).not.toContain(code)
    expect(printed).not.toContain(REASON_SENTINEL)
    expect(printed).not.toContain(EXPECTATION_SENTINEL)
    // They are in the report, which is what proves the checks above are not vacuous.
    for (const code of PROBLEMS) expect(files.get(REPORT_PATH)!, code).toContain(code)
    expect(files.get(REPORT_PATH)!).toContain(REASON_SENTINEL)
    for (const id of ['hold-01', 'hold-02', 'hold-03']) expect(lineOf(logs, id), id).toHaveLength(1)
  })
})

// --- a model never judges its own routines ----------------------------------------------------------------------------------------------------

describe('runRejudge: a model never judges its own routines', () => {
  it('refuses a judge whose model wrote the saved routines, with a RoutineUsageError, before any call or any file', async () => {
    // The source writer was Haiku, so haiku may not judge them.
    const source = await makeSource({ model: HAIKU })
    const { run, judges, ledger, files, dirs } = rejudgeOf(source)

    await expect(run()).rejects.toThrow(RoutineUsageError)
    await expect(run()).rejects.toThrow(/a model never judges its own routines/)

    expect(judges.haiku.calls).toEqual([])
    expect(ledger.entries).toEqual([])
    expect(files.size).toBe(0)
    expect(dirs).toEqual([])
  })

  it('refuses it when it is only one of the judges named, and lets the other judge the Haiku writer\'s routines', async () => {
    const source = await makeSource({ model: HAIKU })
    const refused = rejudgeOf(source, { judgeNames: ['opus', 'haiku'] })
    const allowed = rejudgeOf(source, { judgeNames: ['opus'] })

    await expect(refused.run()).rejects.toThrow(RoutineUsageError)
    expect(refused.judges.opus.calls).toEqual([])
    await expect(allowed.run()).resolves.toMatchObject({ exitCode: expect.any(Number) })
    expect(allowed.judges.opus.calls).toHaveLength(3)
  })
})
