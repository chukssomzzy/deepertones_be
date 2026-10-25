import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RoutineStep } from '../../src/modules/catalog/catalog.vocabulary'
import type { Routine, RoutineSkeleton } from '../../src/modules/routines/routines.types'
import { type AiJob } from '../../src/providers/anthropic/ai-spend.provider'
import { AnthropicConfigError } from '../../src/providers/anthropic/anthropic.provider'
import { BIG_CAP_MICROS } from '../../src/providers/anthropic/messages-api.fake'
import { MemoryAiSpendLedger } from '../../src/providers/anthropic/memory.ai-spend-ledger'
import { MemoryRoutineWriter } from '../../src/providers/routine-writing/memory.routine-writer'
import type { RoutineWriter } from '../../src/providers/routine-writing/routine-writer.provider'
import type { RoutineCase } from './routine-cases'
import type { GroundingJudge, GroundingRequest, GroundingVerdict } from './routine-grounding-judge'
import type { RoutineJudge, RoutineJudgement } from './routine-judge'
import type { LabelSet } from './routine-labels'
import { defaultOutDir, runRoutineEval } from './routine-run'
import { caseOf, offer, row, snapshotOf } from './routine.fixture'

// The orchestration of `npm run eval:routine`, with the writer faked (MemoryRoutineWriter) and the ledger real (a MemoryAiSpendLedger, as in the script), and
// the snapshot, labels, clock and disk handed in: each case's skeleton is built by the real buildSkeleton over a tiny snapshot, written, checked by the real
// checkRoutine, scored, and the report and console lines come out. Nothing here calls the API or touches the disk.
//
// D2 adds the judges: after a case's routine is written and checked, the rubric judge (judge-routine) judges it once, and then each of its grounding links is checked
// by the page-support judge (judge-grounding), up to --max-grounding fetches for the whole run. Both are faked here (a recording judge that spends on the real ledger,
// as the writer's fake does). With a judge a full, labelled holdout run CAN pass the bar. A rule that can be evaluated and fails (gates, forbidden wording, right
// product with labels, judge agreement) is a FAIL and exits 1, with what could not be evaluated listed beside it. A run with nothing failing and something missing
// is a trial: not evaluated, exit 0. A rejected key exits 2. A judge that fails in any other way leaves the case unjudged (the bar then says no-judge); it never
// stops the run. The page-support score is reported and is not in the bar.
//
// PR 4c: the run takes a LIST of rubric judges (haiku and opus, in --judges order) instead of one. Each case's routine is written once and judged by every judge, on the
// same { skeleton, routine } and the same ledger; the cost of each judge's calls is recorded per case and per judge. The summary compares the judges, and the cheapest
// one whose agreement is at least 80% (else the highest agreement) is the one whose agreement, fit, simplicity and words feed the bar. The shapes the tests expect:
//   RunArgs.judges: { name: string; model: string }[]                  (replaces RunArgs.judgeModel)
//   RunDeps.judges: { name: string; model: string; judge: RoutineJudge }[]   (replaces RunDeps.judge), in the same order
//   report.judges, case.judgements / judgeErrors / judgeCostMicros keyed by name, summary.judgeComparison, summary.selectedJudge (a name or null)

/** The one day every date in this file hangs from. */
const BASE = new Date('2030-06-15T00:00:00.000Z')
const JOB: AiJob = 'write-routine'
const OUT = 'out/run-1'
const REPORT_PATH = join(OUT, 'report.json')
const MICROS_PER_CALL = 1000

// Text that must never reach the console: a reason, the expectation, an evidence link's path, and the message of an error.
const REASON_SENTINEL = 'SENTINEL-REASON'
const EXPECTATION_SENTINEL = 'SENTINEL-EXPECTATION'
const URL_SENTINEL = 'SENTINEL-URL-PATH'
const ERROR_SENTINEL = 'SENTINEL-ERROR-MESSAGE'

class FakeWriterError extends Error {}
class FakeJudgeError extends Error {}

// What the judges' answers hold that must never reach the console: the problem codes (and a judge's error message).
const PROBLEMS = ['vague-reason', 'poor-fit'] as const
const JUDGE_ERROR_SENTINEL = 'SENTINEL-JUDGE-ERROR-MESSAGE'
const WRITER_MODEL = 'claude-test-model'
const JUDGE_MODELS = { haiku: 'claude-haiku-5-5', opus: 'claude-opus-5-5' } as const
type JudgeName = keyof typeof JUDGE_MODELS

// --- the snapshot, the cases and the labels --------------------------------------------------------------------------------------------------

// Cleanse has two candidates (C-A is cheaper), moisturise and protect one each, treat none. So a person with an empty shelf has 3 gaps with candidates.
const SNAPSHOT = snapshotOf([
  offer('NG', row('C-A', { steps: ['cleanse'], priceMin: 1000, evidenceUrls: [`https://shop.example/${URL_SENTINEL}/c-a`] })),
  offer('NG', row('C-B', { steps: ['cleanse'], priceMin: 2000 })),
  offer('NG', row('M-1', { steps: ['moisturise'] })),
  offer('NG', row('P-1', { steps: ['protect'], frequency: 'am' })),
])

const CASES: RoutineCase[] = [caseOf({ id: 'hold-01' }), caseOf({ id: 'hold-02', persona: 'tolu' }), caseOf({ id: 'hold-03', persona: 'chidi' })]

const LABELS_FOR_ALL = (cases: RoutineCase[]): LabelSet => ({
  version: 'v1',
  status: 'provisional',
  snapshotSha256: SNAPSHOT.sha256,
  cases: Object.fromEntries(
    cases.map((c) => [
      c.id,
      {
        cleanse: { candidates: ['C-A', 'C-B'], best: 'C-A', acceptable: ['C-B'] },
        moisturise: { candidates: ['M-1'], best: 'M-1', acceptable: [] },
        protect: { candidates: ['P-1'], best: 'P-1', acceptable: [] },
      },
    ]),
  ) as LabelSet['cases'],
})

// --- the writer ------------------------------------------------------------------------------------------------------------------------------

/** A routine that passes every gate: the cheapest candidate for each gap that has one, "use what you have" for the rest. Every reason and the expectation hold sentinels. */
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

/** Takes the call's cost on the real ledger path (reserve, then settle), so the cap really stops it, and records when each call starts and ends. */
class SpendingWriter implements RoutineWriter {
  readonly events: string[] = []
  constructor(
    private readonly inner: MemoryRoutineWriter,
    private readonly ledger: MemoryAiSpendLedger,
    private readonly micros: number,
  ) {}
  async write(skeleton: RoutineSkeleton): Promise<Routine> {
    this.events.push('start')
    try {
      if (this.micros > 0) {
        const id = await this.ledger.reserve({ job: JOB, model: 'fake-model', estimateMicros: this.micros })
        await this.ledger.settle(id, { usage: { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, webSearches: 0 }, costMicros: this.micros })
      }
      return await this.inner.write(skeleton)
    } finally {
      this.events.push('end')
    }
  }
}

type Usage = { inputTokens: 0; outputTokens: 0; cacheWriteTokens: 0; cacheReadTokens: 0; webSearches: 0 }
const NO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, webSearches: 0 }

const spend = async (ledger: MemoryAiSpendLedger, job: AiJob, micros: number) => {
  if (micros <= 0) return
  const id = await ledger.reserve({ job, model: 'fake-model', estimateMicros: micros })
  await ledger.settle(id, { usage: NO_USAGE, costMicros: micros })
}

/** The default answer of the rubric judge: it agrees with the labels (each of the routine's picks is the labelled best) and scores fit 4, simplicity 5, words 3. */
const agreeingJudgement = (): RoutineJudgement => ({
  picks: [
    { step: 'cleanse', pickClass: 'best' },
    { step: 'moisturise', pickClass: 'best' },
    { step: 'protect', pickClass: 'best' },
  ],
  fit: 4,
  simplicity: 5,
  words: 3,
  problems: [...PROBLEMS],
})

/** The rubric judge: takes its call's cost on the real ledger, and records what it was asked. */
class SpendingJudge implements RoutineJudge {
  readonly calls: { skeleton: RoutineSkeleton; routine: Routine }[] = []
  constructor(
    private readonly name: string,
    private readonly ledger: MemoryAiSpendLedger,
    private readonly micros: number,
    private readonly answer: (call: number, input: { skeleton: RoutineSkeleton; routine: Routine }) => RoutineJudgement | undefined,
    private readonly order: string[],
  ) {}
  async judge(input: { skeleton: RoutineSkeleton; routine: Routine }): Promise<RoutineJudgement> {
    this.calls.push(input)
    this.order.push(`judge:${this.name}`)
    await spend(this.ledger, 'judge-routine' as AiJob, this.micros)
    return this.answer(this.calls.length, input) ?? agreeingJudgement()
  }
}

/** The page-support judge: the default verdict is a page that supports the reason. */
class SpendingGrounding implements GroundingJudge {
  readonly calls: GroundingRequest[] = []
  constructor(
    private readonly ledger: MemoryAiSpendLedger,
    private readonly micros: number,
    private readonly answer: (call: number, request: GroundingRequest) => GroundingVerdict | undefined,
    private readonly order: string[],
  ) {}
  async judge(request: GroundingRequest): Promise<GroundingVerdict> {
    this.calls.push(request)
    this.order.push('ground')
    await spend(this.ledger, 'judge-grounding' as AiJob, this.micros)
    return this.answer(this.calls.length, request) ?? { fetched: true, supports: 'yes' }
  }
}

type Setup = {
  cases?: RoutineCase[]
  set?: 'dev' | 'holdout'
  labels?: LabelSet | null
  limit?: number
  capMicros?: number
  previous?: { summary: { rightProduct: number | null; fit: number | null; simplicity: number | null; words: number | null } } | null
  /** What the writer answers on the n-th call (1-based); the good routine when it returns undefined. Throw to fail that call. */
  answer?: (call: number, skeleton: RoutineSkeleton) => Routine | undefined
  /** The judges of the run, in order (default haiku then opus, as --judges' default). */
  judgeNames?: JudgeName[]
  /** What each rubric judge answers on its n-th call (each judge counts its own calls); the agreeing judgement when it returns undefined. Throw to fail that call. */
  judgeAnswer?: (call: number, input: { skeleton: RoutineSkeleton; routine: Routine }) => RoutineJudgement | undefined
  /** The same, for one judge; it takes the place of judgeAnswer for that judge. */
  judgeAnswers?: Partial<Record<JudgeName, (call: number, input: { skeleton: RoutineSkeleton; routine: Routine }) => RoutineJudgement | undefined>>
  /** What the page-support judge answers on its n-th call; a supported page when it returns undefined. */
  groundingAnswer?: (call: number, request: GroundingRequest) => GroundingVerdict | undefined
  /** What each rubric judge call costs on the ledger (0: nothing, so the writer's arithmetic stays the only spend): one number for both judges, or one per judge. */
  judgeMicros?: number | Partial<Record<JudgeName, number>>
  groundingMicros?: number
  maxGrounding?: number
}

const setup = ({ cases = CASES, set = 'holdout', labels, limit, capMicros = BIG_CAP_MICROS, previous, answer = () => undefined, judgeNames = ['haiku', 'opus'], judgeAnswer = () => undefined, judgeAnswers = {}, groundingAnswer = () => undefined, judgeMicros = 0, groundingMicros = 0, maxGrounding = 100 }: Setup = {}) => {
  const ledger = new MemoryAiSpendLedger({ capMicros })
  const memory = new MemoryRoutineWriter()
  const order: string[] = []
  let call = 0
  memory.respondWith((skeleton) => {
    order.push('write')
    return answer(++call, skeleton) ?? goodRoutine(skeleton)
  })
  const writer = new SpendingWriter(memory, ledger, MICROS_PER_CALL)
  const judgeFakes = judgeNames.map((name) => ({ name, model: JUDGE_MODELS[name], judge: new SpendingJudge(name, ledger, typeof judgeMicros === 'number' ? judgeMicros : (judgeMicros[name] ?? 0), judgeAnswers[name] ?? judgeAnswer, order) }))
  const judges = Object.fromEntries(judgeFakes.map((j) => [j.name, j.judge])) as Record<JudgeName, SpendingJudge>
  /** The first judge of the list: most tests are about what a judge is asked, and both are asked the same. */
  const judge = judgeFakes[0]!.judge
  const grounding = new SpendingGrounding(ledger, groundingMicros, groundingAnswer, order)
  const logs: string[] = []
  const dirs: string[] = []
  const files = new Map<string, string>()
  const run = () =>
    runRoutineEval({
      cases,
      set,
      limit,
      outDir: OUT,
      startedAt: BASE,
      model: WRITER_MODEL,
      judges: judgeFakes.map(({ name, model }) => ({ name, model })),
      maxGrounding,
      promptHash: 'prompt-hash-123',
      snapshot: SNAPSHOT,
      labels: labels === undefined ? LABELS_FOR_ALL(cases) : labels,
      ...(previous === undefined ? {} : { previous }),
      deps: { writer, judges: judgeFakes, grounding, ledger },
      io: {
        log: (line) => logs.push(line),
        mkdir: async (dir) => void dirs.push(dir),
        writeFile: async (path, text) => void files.set(path, text),
      },
    })
  return { ledger, memory, writer, judge, judges, grounding, order, logs, dirs, files, run }
}

type JudgeRow = { name: string; model: string; agreement: number | null; exactAgreement: number | null; fit: number | null; simplicity: number | null; words: number | null; costMicros: number; agreementPerDollar: number | null; selfAgreement: boolean }

type Reported = {
  startedAt: string
  set: string
  snapshotSha256: string
  labelVersion: string | null
  labelSnapshotSha256: string | null
  /** Who made the labels: a model id, 'human', or null when the run had no labels. */
  labelledBy: string | null
  model: string
  judges: { name: string; model: string }[]
  promptHash: string
  partial: boolean
  cases: {
    id: string
    state: string
    writerError?: string
    skeleton?: RoutineSkeleton
    routine: Routine | null
    failures: { gate: string; step: RoutineStep | null }[]
    costMicros: number
    score: { picks: string; gatesPassed: boolean }
    /** What each rubric judge said, whole (its problem codes are here and only here), or null. Every judge of the run has a key. */
    judgements: Record<string, RoutineJudgement | null>
    /** The class name of each judge's error, for the judges that had one. */
    judgeErrors: Record<string, string>
    /** What each judge's calls cost on this case. */
    judgeCostMicros: Record<string, number>
    grounding: { step: string; sourceUrl: string; verdict: GroundingVerdict }[]
  }[]
  summary: {
    gatesPassed: number | null
    forbiddenWording: number
    rightProduct: number | null
    needsRelabel: string[]
    costMicros: number
    judgeAgreement: number | null
    judgeExactAgreement: number | null
    fit: number | null
    simplicity: number | null
    words: number | null
    judgeComparison: JudgeRow[]
    selectedJudge: string | null
    groundingSupport: number | null
    groundingChecked: number
    groundingSupported: number
    groundingUnverifiable: number
    groundingSkipped: number
    bar: { status: string; reasons?: string[]; rules?: string[] }
  }
}
const reportOf = (files: Map<string, string>): Reported => JSON.parse(files.get(REPORT_PATH)!)
const lineOf = (logs: string[], id: string) => logs.filter((l) => l.startsWith(id))

describe('runRoutineEval: one case at a time', () => {
  it('builds each case\'s skeleton from the snapshot and asks the writer once per case, in order', async () => {
    const { run, memory } = setup()

    await run()

    expect(memory.calls).toHaveLength(3)
    for (const skeleton of memory.calls) {
      expect(skeleton.gaps.map((g) => [g.step, g.candidates.map((c) => c.code)])).toEqual([
        ['cleanse', ['C-A', 'C-B']],
        ['treat', []],
        ['moisturise', ['M-1']],
        ['protect', ['P-1']],
      ])
      expect(skeleton.limits.maxNewProducts).toBe(3)
    }
  })

  it('never starts a case before the one before it has finished', async () => {
    const { run, writer } = setup()

    await run()

    expect(writer.events).toEqual(['start', 'end', 'start', 'end', 'start', 'end'])
  })

  it('runs only the first N cases with --limit', async () => {
    const { run, memory, files } = setup({ limit: 2 })

    await run()

    expect(memory.calls).toHaveLength(2)
    expect(reportOf(files).cases.map((c) => c.id)).toEqual(['hold-01', 'hold-02'])
  })

  it('keeps going after a writer error: the next case is still run', async () => {
    const { run, memory, files } = setup({
      answer: (call) => {
        if (call === 1) throw new FakeWriterError(ERROR_SENTINEL)
        return undefined
      },
    })

    const { exitCode } = await run()

    expect(memory.calls).toHaveLength(2)
    expect(reportOf(files).cases.map((c) => c.state)).toEqual(['writer-error', 'done', 'done'])
    // 1 of 3 routines failed, so the gates rule fails the bar.
    expect(exitCode).toBe(1)
  })
})

describe('runRoutineEval: the console', () => {
  // case 1 is fine; case 2's writer fails with a message that holds a sentinel; case 3's routine breaks the frequency gate (protect must be am).
  const messy = (): Setup => ({
    answer: (call, skeleton) => {
      if (call === 2) throw new FakeWriterError(ERROR_SENTINEL)
      if (call === 3) {
        const routine = goodRoutine(skeleton)
        return { ...routine, steps: routine.steps.map((e) => (e.step === 'protect' ? { ...e, frequency: 'pm' as const } : e)) }
      }
      return undefined
    },
  })

  it('never prints a routine\'s reason or expectation, a link\'s address, or an error\'s message', async () => {
    const { run, logs, files } = setup(messy())

    await run()

    const console_ = logs.join('\n')
    for (const sentinel of [REASON_SENTINEL, EXPECTATION_SENTINEL, URL_SENTINEL, ERROR_SENTINEL]) expect(console_, sentinel).not.toContain(sentinel)
    expect(console_).not.toMatch(/https?:\/\//)
    // The routines do go to the report, which is what proves the check above is not vacuous.
    const report = files.get(REPORT_PATH)!
    expect(report).toContain(REASON_SENTINEL)
    expect(report).toContain(EXPECTATION_SENTINEL)
    expect(report).toContain(URL_SENTINEL)
    // A writer error is reported by its class name and never its message.
    expect(report).not.toContain(ERROR_SENTINEL)
  })

  it('prints one line per case that starts with its id: gates ok or the failed gate codes, whether the picks were right, wrong or unscored, and the cost', async () => {
    const { run, logs } = setup(messy())

    await run()

    const [one, two, three] = ['hold-01', 'hold-02', 'hold-03'].map((id) => lineOf(logs, id)) as [string[], string[], string[]]
    expect(one).toHaveLength(1)
    expect(one[0]).toMatch(/\bok\b/)
    expect(one[0]).toContain('right')
    expect(one[0]).toContain('$0.0010')
    expect(two).toHaveLength(1)
    expect(two[0]).toContain('FakeWriterError')
    expect(three).toHaveLength(1)
    expect(three[0]).toContain('frequency')
    expect(three[0]).toContain('wrong')
  })

  it('says a case is unscored when there are no labels', async () => {
    const { run, logs } = setup({ labels: null })

    await run()

    for (const id of ['hold-01', 'hold-02', 'hold-03']) expect(lineOf(logs, id)[0], id).toContain('unscored')
  })

  it('ends with the bar line, whatever else it printed', async () => {
    const { run, logs } = setup(messy())

    await run()

    expect(logs.at(-1)).toMatch(/^Bar: (PASS|FAIL|not evaluated)/)
  })
})

describe('runRoutineEval: the report', () => {
  it('makes the out directory first and writes report.json into it', async () => {
    const { run, dirs, files } = setup()

    const result = await run()

    expect(dirs).toEqual([OUT])
    expect([...files.keys()]).toEqual([REPORT_PATH])
    expect(result.outDir).toBe(OUT)
  })

  it('names the snapshot, labels, model and prompt it ran on, and the set', async () => {
    const { run, files } = setup()

    await run()

    const report = reportOf(files)
    expect(report).toMatchObject({ startedAt: BASE.toISOString(), set: 'holdout', snapshotSha256: SNAPSHOT.sha256, labelVersion: 'v1', model: WRITER_MODEL, judges: [{ name: 'haiku', model: 'claude-haiku-5-5' }, { name: 'opus', model: 'claude-opus-5-5' }], promptHash: 'prompt-hash-123', partial: false })
  })

  it('records every case\'s skeleton, routine, gate failures, cost and score', async () => {
    const { run, files } = setup()

    await run()

    const [first] = reportOf(files).cases
    expect(first!.id).toBe('hold-01')
    expect(first!.state).toBe('done')
    expect(first!.skeleton!.goal).toBe('glow')
    expect(first!.routine!.steps.map((e) => e.step)).toEqual(['cleanse', 'treat', 'moisturise', 'protect'])
    expect(first!.failures).toEqual([])
    expect(first!.costMicros).toBe(MICROS_PER_CALL)
    expect(first!.score).toMatchObject({ gatesPassed: true, picks: 'right' })
  })

  it('reports a writer error as its class name, with no routine, and counts it as a failed routine', async () => {
    const { run, files } = setup({
      answer: (call) => {
        if (call === 2) throw new FakeWriterError(ERROR_SENTINEL)
        return undefined
      },
    })

    await run()

    const report = reportOf(files)
    expect(report.cases[1]).toMatchObject({ id: 'hold-02', state: 'writer-error', writerError: 'FakeWriterError', routine: null })
    // 2 of 3 routines passed the gates.
    expect(report.summary.gatesPassed).toBeCloseTo(66.667, 2)
  })

  it('totals what the cases cost, from the ledger', async () => {
    const { run, files, ledger } = setup()

    await run()

    expect(ledger.spentMicros()).toBe(3 * MICROS_PER_CALL)
    expect(reportOf(files).summary.costMicros).toBe(3000)
  })

  it('lists the cases whose labels were made on other candidates, and leaves them out of the scores', async () => {
    const labels = LABELS_FOR_ALL(CASES)
    labels.cases['hold-02'] = { ...labels.cases['hold-02']!, cleanse: { candidates: ['C-A'], best: 'C-A', acceptable: [] } }
    const { run, files, logs } = setup({ labels })

    await run()

    const report = reportOf(files)
    expect(report.summary.needsRelabel).toEqual(['hold-02'])
    expect(report.cases[1]!.score.picks).toBe('unscored')
    expect(lineOf(logs, 'hold-02')[0]).toContain('unscored')
  })

  it('names the default out directory after the start time, without a colon', () => {
    expect(defaultOutDir(BASE)).toBe('.eval/routine-2030-06-15T00-00-00.000Z')
  })

  // pr6b: a later `eval:routine:rejudge --rescore` reuses the saved judgements, and can only tell whether they came from today's judge prompt if the report names it.
  it('names the hash of the rubric judge prompt it ran with, beside the writer\'s promptHash', async () => {
    const { routineJudgeJudgeRoutinePrompt } = await import('../../src/prompts/prompts.generated')
    const { run, files } = setup()

    await run()

    expect(reportOf(files)).toMatchObject({ judgePromptHash: routineJudgeJudgeRoutinePrompt.hash, promptHash: 'prompt-hash-123' })
    expect(routineJudgeJudgeRoutinePrompt.hash).toEqual(expect.any(String))
  })
})

describe('runRoutineEval: the bar', () => {
  it('PASSES a full, labelled holdout run whose routines pass every gate, whose picks the judge agrees with and whose wording is clean, and exits 0', async () => {
    // 3 of 3 routines pass the gates; the one scored gap per case picks the labelled best (100% right product); the judge agrees on 3 of 3 (100%, the bar is 80%).
    const { run, logs, files } = setup()

    const { exitCode } = await run()

    expect(logs.at(-1)).toBe('Bar: PASS')
    expect(exitCode).toBe(0)
    expect(reportOf(files).summary.bar).toEqual({ status: 'pass' })
    expect(logs.join('\n')).not.toMatch(/trial/i)
  })

  it('is not evaluated, exits 0 and says it is a trial, when the rubric judge could not judge any case: no judge result, no pass', async () => {
    // A judge that fails on every call (not the key, not the cap) leaves every case unjudged: the run goes on and the bar says what is missing.
    const { run, logs, files } = setup({
      judgeAnswer: () => {
        throw new FakeJudgeError(JUDGE_ERROR_SENTINEL)
      },
    })

    const { exitCode } = await run()

    expect(logs.at(-1)).toBe('Bar: not evaluated (no-judge)')
    expect(logs.join('\n')).toMatch(/trial/i)
    expect(exitCode).toBe(0)
    expect(reportOf(files).summary.bar).toEqual({ status: 'not-evaluated', reasons: ['no-judge'] })
    // Neither judge produced a result, so there is no judge to take the bar's numbers from.
    expect(reportOf(files).summary.selectedJudge).toBeNull()
    expect(reportOf(files).summary.judgeAgreement).toBeNull()
  })

  it('is not evaluated without labels, and says so', async () => {
    const { run, logs } = setup({ labels: null })

    const { exitCode } = await run()

    expect(logs.at(-1)).toMatch(/^Bar: not evaluated \(.*no-labels.*\)$/)
    expect(exitCode).toBe(0)
  })

  it('is never evaluated for the dev set', async () => {
    const { run, logs } = setup({ set: 'dev' })

    const { exitCode } = await run()

    expect(logs.at(-1)).toMatch(/^Bar: not evaluated \(.*dev-set.*\)$/)
    expect(exitCode).toBe(0)
  })

  it('fails the bar and exits 1 when a routine breaks a gate, naming the rules that failed', async () => {
    // Case 3's routine breaks the frequency gate (protect must be am): gates are 2 of 3, and the right product is 2 of 3 (its pick counts as not right).
    const { run, logs, files } = setup({
      answer: (call, skeleton) => {
        if (call !== 3) return undefined
        const routine = goodRoutine(skeleton)
        return { ...routine, steps: routine.steps.map((e) => (e.step === 'protect' ? { ...e, frequency: 'pm' as const } : e)) }
      },
    })

    const { exitCode } = await run()

    expect(exitCode).toBe(1)
    expect(logs.at(-1)).toBe('Bar: FAIL (gates, right-product)')
    expect(reportOf(files).summary.bar).toEqual({ status: 'fail', rules: ['gates', 'right-product'], notEvaluated: [] })
  })

  it('fails the bar when a reason uses forbidden wording', async () => {
    const { run, logs } = setup({
      answer: (call, skeleton) => {
        if (call !== 1) return undefined
        const routine = goodRoutine(skeleton)
        return { ...routine, steps: routine.steps.map((e, i) => (i === 0 ? { ...e, reason: 'Expect lighter skin soon.' } : e)) }
      },
    })

    const { exitCode } = await run()

    expect(exitCode).toBe(1)
    expect(logs.at(-1)).toMatch(/^Bar: FAIL \(gates, right-product, forbidden-wording/)
  })

  it('compares the scores with the previous report when given one, and says which measure decided', async () => {
    // Every case picks its labelled best, so the right product is 100%; the previous run had 50%.
    const { run, logs } = setup({ previous: { summary: { rightProduct: 50, fit: null, simplicity: null, words: null } } })

    await run()

    const line = logs.find((l) => /better/.test(l) && /rightProduct/.test(l))
    expect(line).toBeDefined()
  })
})

describe('runRoutineEval: a partial run is never the bar', () => {
  // The cap is 2500 and each call costs 1000: calls 1 and 2 fit (2000), and the reservation for call 3 would make 3000.
  const CAPPED = 2500

  it('stops at the spend cap: the cases after it are not run, and are reported as cut off', async () => {
    const { run, memory, files, logs } = setup({ capMicros: CAPPED })

    await run()

    expect(memory.calls).toHaveLength(2)
    const report = reportOf(files)
    expect(report.partial).toBe(true)
    expect(report.cases.map((c) => c.state)).toEqual(['done', 'done', 'cut-off'])
    expect(report.summary.costMicros).toBe(2000)
    expect(logs.join('\n')).toMatch(/spend cap/i)
    expect(lineOf(logs, 'hold-03')[0]).toContain('cut-off')
  })

  it('is not evaluated even when every case that finished was perfect and the labels are complete, and exits 0 as a trial', async () => {
    const { run, logs, files } = setup({ capMicros: CAPPED })

    const { exitCode } = await run()

    expect(reportOf(files).summary.rightProduct).toBe(100)
    expect(reportOf(files).summary.gatesPassed).toBe(100)
    expect(logs.at(-1)).toMatch(/^Bar: not evaluated \(.*partial-run.*\)$/)
    expect(reportOf(files).summary.bar.reasons).toContain('partial-run')
    expect(exitCode).toBe(0)
  })

  it('is still a FAIL, exit 1, when a case that finished broke a gate: a trial can fail, it cannot pass', async () => {
    const { run, logs } = setup({
      capMicros: CAPPED,
      answer: (call, skeleton) => {
        if (call !== 1) return undefined
        const routine = goodRoutine(skeleton)
        return { ...routine, steps: routine.steps.map((e) => (e.step === 'protect' ? { ...e, frequency: 'pm' as const } : e)) }
      },
    })

    const { exitCode } = await run()

    expect(exitCode).toBe(1)
    expect(logs.at(-1)).toMatch(/^Bar: FAIL \(.*; not evaluated: .*partial-run.*\)$/)
  })

  it('leaves the cut-off cases out of the percentages: they are not counted as failed routines', async () => {
    const { run, files } = setup({ capMicros: CAPPED })

    await run()

    // 2 cases ran and passed the gates; the third did not run, so it is not a failure.
    expect(reportOf(files).summary.gatesPassed).toBe(100)
  })

  it('still writes the report of a partial run', async () => {
    const { run, files } = setup({ capMicros: CAPPED })

    await run()

    expect(files.has(REPORT_PATH)).toBe(true)
  })
})

describe('runRoutineEval: a rejected key stops the run and exits 2', () => {
  const rejected: Setup = {
    answer: (call) => {
      if (call === 2) throw new AnthropicConfigError(ERROR_SENTINEL)
      return undefined
    },
  }

  it('does not ask the writer again after the key was refused, and exits 2', async () => {
    const { run, writer, files } = setup(rejected)

    const { exitCode } = await run()

    expect(exitCode).toBe(2)
    expect(writer.events.filter((e) => e === 'start')).toHaveLength(2)
    const report = reportOf(files)
    expect(report.partial).toBe(true)
    expect(report.cases.map((c) => c.state)).toEqual(['done', 'cut-off', 'cut-off'])
  })

  it('tells the person to fix the setup, without the error\'s message, and the run is still not the bar', async () => {
    const { run, logs } = setup(rejected)

    await run()

    const console_ = logs.join('\n')
    expect(console_).toMatch(/key/i)
    expect(console_).not.toContain(ERROR_SENTINEL)
    expect(logs.at(-1)).toMatch(/^Bar: not evaluated \(.*partial-run.*\)$/)
  })
})

describe('runRoutineEval: a run of the first N cases is a trial', () => {
  it('is not the bar however good the cases that ran were: a labelled, clean --limit run of the holdout is not PASS', async () => {
    const { run, logs, files } = setup({ limit: 2 })

    const { exitCode } = await run()

    expect(reportOf(files).partial).toBe(true)
    expect(reportOf(files).summary.gatesPassed).toBe(100)
    expect(reportOf(files).summary.rightProduct).toBe(100)
    expect(logs.at(-1)).toMatch(/^Bar: not evaluated \(.*partial-run.*\)$/)
    expect(logs.at(-1)).not.toContain('PASS')
    expect(exitCode).toBe(0)
  })

  it('can still fail: a gate broken in the cases that ran is a FAIL, listing the partial run beside it', async () => {
    const { run, logs } = setup({
      limit: 2,
      answer: (call, skeleton) => {
        if (call !== 1) return undefined
        const routine = goodRoutine(skeleton)
        return { ...routine, steps: routine.steps.map((e) => (e.step === 'protect' ? { ...e, frequency: 'pm' as const } : e)) }
      },
    })

    const { exitCode } = await run()

    expect(exitCode).toBe(1)
    expect(logs.at(-1)).toMatch(/^Bar: FAIL \(.*; not evaluated: .*partial-run.*\)$/)
  })

  it('is not partial when --limit is as big as the set', async () => {
    const { run, files } = setup({ limit: 3 })

    await run()

    expect(reportOf(files).partial).toBe(false)
  })
})

describe('runRoutineEval: the label set it was scored with', () => {
  it('names the snapshot the labels were made on beside the one the run used, and null when there are no labels', async () => {
    const labelled = setup({ labels: { ...LABELS_FOR_ALL(CASES), snapshotSha256: 'b'.repeat(64) } })
    await labelled.run()
    const unlabelled = setup({ labels: null })
    await unlabelled.run()

    expect(reportOf(labelled.files)).toMatchObject({ snapshotSha256: SNAPSHOT.sha256, labelSnapshotSha256: 'b'.repeat(64) })
    expect(reportOf(unlabelled.files).labelSnapshotSha256).toBeNull()
  })
})


// --- D2: the judges -------------------------------------------------------------------------------------------------------------------------

/** Each case's goodRoutine has three grounding links (cleanse, moisturise, protect: the first evidence address of the candidate it picks); treat is "use what you have". */
const LINKS_PER_CASE = 3

describe('runRoutineEval: the rubric judge', () => {
  it('judges each case that has a routine once with each judge, in the order of the list, after the writer wrote it and before the next case is written', async () => {
    const { run, judges, order } = setup()

    await run()

    expect(judges.haiku.calls).toHaveLength(3)
    expect(judges.opus.calls).toHaveLength(3)
    expect(order.filter((e) => e === 'write' || e.startsWith('judge:'))).toEqual(['write', 'judge:haiku', 'judge:opus', 'write', 'judge:haiku', 'judge:opus', 'write', 'judge:haiku', 'judge:opus'])
  })

  it('gives each judge exactly the skeleton the writer was given and the routine it wrote, and nothing else: no label, no gap code list, no score', async () => {
    const { run, judges, memory } = setup()

    await run()

    for (const judge of [judges.haiku, judges.opus]) {
      for (const [i, input] of judge.calls.entries()) {
        expect(Object.keys(input).sort()).toEqual(['routine', 'skeleton'])
        expect(input.skeleton).toBe(memory.calls[i])
        expect(input.routine).toEqual(goodRoutine(memory.calls[i]!))
      }
    }
  })

  it('gives the judge the same input when there are no labels at all, and when there are: the labels never change what it is asked', async () => {
    const labelled = setup()
    const unlabelled = setup({ labels: null })

    await labelled.run()
    await unlabelled.run()

    expect(unlabelled.judges.haiku.calls).toEqual(labelled.judges.haiku.calls)
    expect(unlabelled.judges.opus.calls).toEqual(labelled.judges.opus.calls)
  })

  it('does not judge a case whose writer failed, and judges the others', async () => {
    const { run, judges, files } = setup({
      answer: (call) => {
        if (call === 2) throw new FakeWriterError(ERROR_SENTINEL)
        return undefined
      },
    })

    await run()

    expect(judges.haiku.calls).toHaveLength(2)
    expect(judges.opus.calls).toHaveLength(2)
    const [one, two, three] = reportOf(files).cases
    expect(one!.judgements.haiku).not.toBeNull()
    expect(one!.judgements.opus).not.toBeNull()
    // Every judge has a key, with null where it judged nothing and a cost of 0.
    expect(two).toMatchObject({ state: 'writer-error', judgements: { haiku: null, opus: null }, judgeErrors: {}, judgeCostMicros: { haiku: 0, opus: 0 } })
    expect(three!.judgements.haiku).not.toBeNull()
  })

  it('does not judge a case the run never reached (cut off by the spend cap)', async () => {
    // The cap of 2500 lets writer calls 1 and 2 through (1000 each) and stops the third.
    const { run, judges, files } = setup({ capMicros: 2500 })

    await run()

    expect(reportOf(files).cases.map((c) => c.state)).toEqual(['done', 'done', 'cut-off'])
    expect(judges.haiku.calls).toHaveLength(2)
    expect(judges.opus.calls).toHaveLength(2)
  })

  it('judges a routine that broke a gate: the gates and the judge are different checks', async () => {
    const { run, judges } = setup({
      answer: (call, skeleton) => {
        if (call !== 1) return undefined
        const routine = goodRoutine(skeleton)
        return { ...routine, steps: routine.steps.map((e) => (e.step === 'protect' ? { ...e, frequency: 'pm' as const } : e)) }
      },
    })

    await run()

    expect(judges.haiku.calls).toHaveLength(3)
    expect(judges.opus.calls).toHaveLength(3)
  })

  it('records each judge\'s judgement whole in the report, and the agreement the comparison takes from them', async () => {
    const { run, files } = setup()

    await run()

    const report = reportOf(files)
    const [first] = report.cases
    expect(first!.judgements).toEqual({ haiku: agreeingJudgement(), opus: agreeingJudgement() })
    // Scored gaps: cleanse only (the other two gaps have one candidate). Both judges said "best" and the labels say the pick (C-A) is the best: 3 of 3 over the run.
    expect(report.summary.judgeComparison.map((row) => [row.name, row.agreement, row.fit, row.simplicity, row.words])).toEqual([
      ['haiku', 100, 4, 5, 3],
      ['opus', 100, 4, 5, 3],
    ])
  })

  it('pools the agreement over all picks judged and averages fit, simplicity and words over the cases judged', async () => {
    // Cleanse is the one scored gap of each case. Case 1: the judge says best (the label says best): agreed. Case 2: it says not: not agreed. Case 3: best: agreed.
    // (Changed in #152 follow-up: case 2 said 'acceptable', which is now on the label's side of best and so would agree; 'not' keeps the disagreement this test is about.)
    // So 2 of 3 = 66.67%. fit (5 + 3 + 1) / 3 = 3, simplicity (5 + 4 + 3) / 3 = 4, words (2 + 3 + 4) / 3 = 3.
    const scores = [
      { fit: 5, simplicity: 5, words: 2 },
      { fit: 3, simplicity: 4, words: 3 },
      { fit: 1, simplicity: 3, words: 4 },
    ]
    const { run, files } = setup({
      judgeAnswer: (call) => {
        const base = agreeingJudgement()
        const picks = base.picks.map((p) => (call === 2 && p.step === 'cleanse' ? { ...p, pickClass: 'not' as const } : p))
        return { ...base, ...scores[call - 1]!, picks }
      },
    })

    await run()

    const { summary } = reportOf(files)
    expect(summary.judgeAgreement).toBeCloseTo(66.667, 2)
    expect(summary.judgeExactAgreement).toBeCloseTo(66.667, 2)
    expect(summary.fit).toBe(3)
    expect(summary.simplicity).toBe(4)
    expect(summary.words).toBe(3)
  })

  it('counts "acceptable" against a label of best as agreement in the report, and reports the exact figure beside it, so the bar does not fail', async () => {
    // Cleanse is the one scored gap of each case and every label says the pick is best. Case 2 the judges say acceptable: the same side, so agreed, but not exactly.
    // Agreed 3 of 3 = 100%; exactly 2 of 3 = 66.67%. The bar takes the 100.
    const { run, files } = setup({
      judgeAnswer: (call) => {
        const base = agreeingJudgement()
        return { ...base, picks: base.picks.map((p) => (call === 2 && p.step === 'cleanse' ? { ...p, pickClass: 'acceptable' as const } : p)) }
      },
    })

    const { exitCode } = await run()

    const { summary } = reportOf(files)
    expect(summary.judgeAgreement).toBe(100)
    expect(summary.judgeExactAgreement).toBeCloseTo(66.667, 2)
    expect(summary.judgeComparison.map((row) => [row.name, row.agreement, row.exactAgreement])).toEqual([
      ['haiku', 100, expect.closeTo(66.667, 2)],
      ['opus', 100, expect.closeTo(66.667, 2)],
    ])
    expect(summary.bar.status).toBe('pass')
    expect(exitCode).toBe(0)
  })

  it('fails the bar on judge agreement below 80%, naming it, and exits 1', async () => {
    // The judge disagrees on case 2 and case 3: 1 of 3 = 33%.
    const { run, logs } = setup({
      judgeAnswer: (call) => {
        const base = agreeingJudgement()
        return { ...base, picks: base.picks.map((p) => (call > 1 && p.step === 'cleanse' ? { ...p, pickClass: 'not' as const } : p)) }
      },
    })

    const { exitCode } = await run()

    expect(exitCode).toBe(1)
    expect(logs.at(-1)).toBe('Bar: FAIL (judge-agreement)')
  })

  it('keeps going when the judges fail on one case (not the key, not the cap): the case is reported unjudged, with each error\'s class name and never its message', async () => {
    const { run, judges, files, logs } = setup({
      judgeAnswer: (call) => {
        if (call === 2) throw new FakeJudgeError(JUDGE_ERROR_SENTINEL)
        return undefined
      },
    })

    const { exitCode } = await run()

    expect(judges.haiku.calls).toHaveLength(3)
    expect(judges.opus.calls).toHaveLength(3)
    const report = reportOf(files)
    expect(report.cases.map((c) => c.state)).toEqual(['done', 'done', 'done'])
    expect(report.cases[1]).toMatchObject({ judgements: { haiku: null, opus: null }, judgeErrors: { haiku: 'FakeJudgeError', opus: 'FakeJudgeError' } })
    expect(report.cases[0]!.judgeErrors).toEqual({})
    expect(files.get(REPORT_PATH)).not.toContain(JUDGE_ERROR_SENTINEL)
    expect(logs.join('\n')).not.toContain(JUDGE_ERROR_SENTINEL)
    // One case is unjudged, so the bar cannot pass: it is a trial, with the judge named as the missing piece.
    expect(logs.at(-1)).toBe('Bar: not evaluated (no-judge)')
    expect(exitCode).toBe(0)
  })

  it('stops, exits 2 and asks for no more calls, of the other judge too, when a judge is refused by Claude (key, billing or permission), like a writer', async () => {
    const { run, judges, memory, logs, files } = setup({
      judgeAnswer: () => {
        throw new AnthropicConfigError(ERROR_SENTINEL)
      },
    })

    const { exitCode } = await run()

    expect(exitCode).toBe(2)
    expect(judges.haiku.calls).toHaveLength(1)
    expect(judges.opus.calls).toHaveLength(0)
    expect(memory.calls).toHaveLength(1)
    expect(reportOf(files).cases[0]).toMatchObject({ judgements: { haiku: null }, judgeErrors: { haiku: 'AnthropicConfigError' } })
    expect(reportOf(files).partial).toBe(true)
    expect(reportOf(files).cases.map((c) => c.state)).toEqual(['done', 'cut-off', 'cut-off'])
    expect(logs.join('\n')).toMatch(/key/i)
    expect(logs.join('\n')).not.toContain(ERROR_SENTINEL)
  })

  it('shares the spend cap with the writer: when a judge\'s call would pass the cap the run stops, the rest are cut off, and it is a trial', async () => {
    // Cap 1500; the writer takes 1000 a call, haiku 100 and opus 500. Case 1: writer 1000, haiku 1100 fits, opus would make 1600 and is stopped.
    const { run, judges, memory, grounding, files, logs } = setup({
      capMicros: 1500,
      judgeMicros: { haiku: 100, opus: 500 },
    })

    const { exitCode } = await run()

    expect(memory.calls).toHaveLength(1)
    expect(judges.haiku.calls).toHaveLength(1)
    expect(judges.opus.calls).toHaveLength(1)
    expect(grounding.calls).toHaveLength(0)
    const report = reportOf(files)
    expect(report.partial).toBe(true)
    expect(report.cases.map((c) => c.state)).toEqual(['done', 'cut-off', 'cut-off'])
    expect(report.cases[0]!.judgements.haiku).not.toBeNull()
    expect(report.cases[0]!.judgements.opus).toBeNull()
    expect(report.cases[0]!.judgeErrors).toEqual({ opus: 'AiBudgetExceededError' })
    expect(logs.join('\n')).toMatch(/spend cap/i)
    expect(logs.at(-1)).toMatch(/^Bar: not evaluated \(.*partial-run.*\)$/)
    expect(exitCode).toBe(0)
  })

  it('counts the judges\' spend in each case\'s cost and in the total: writer 1000 + haiku 100 + opus 500 + 3 grounding checks of 100 = 1900 a case', async () => {
    const { run, logs, files, ledger } = setup({ judgeMicros: { haiku: 100, opus: 500 }, groundingMicros: 100 })

    await run()

    const report = reportOf(files)
    expect(report.cases.map((c) => c.costMicros)).toEqual([1900, 1900, 1900])
    expect(report.summary.costMicros).toBe(5700)
    expect(ledger.spentMicros()).toBe(5700)
    expect(lineOf(logs, 'hold-01')[0]).toContain('$0.0019')
  })
})

describe('runRoutineEval: what the console never prints from the judges', () => {
  it('never prints a problem code or any other judge output, and prints no extra line that starts with a case id', async () => {
    const { run, logs, files } = setup()

    await run()

    const console_ = logs.join('\n')
    for (const code of PROBLEMS) expect(console_, code).not.toContain(code)
    // The report is where they go, which is what proves the check above is not vacuous.
    for (const code of PROBLEMS) expect(files.get(REPORT_PATH)!, code).toContain(code)
    for (const id of ['hold-01', 'hold-02', 'hold-03']) expect(lineOf(logs, id), id).toHaveLength(1)
  })

  it('prints one line per judge with its numbers (agreement, fit, simplicity, words) as scores, its cost in dollars and its agreement per dollar', async () => {
    // Both judges agree on 3 of 3 (100%), fit 4, simplicity 5, words 3. haiku costs 100 a call and opus 500: 300 micros = $0.0003 and 1500 micros = $0.0015.
    // Agreement per dollar: 100 / 0.0003 = 333333.3 and 100 / 0.0015 = 66666.7.
    const { run, logs } = setup({ judgeMicros: { haiku: 100, opus: 500 } })

    await run()

    const haiku = logs.filter((l) => l.startsWith('Judge haiku'))
    const opus = logs.filter((l) => l.startsWith('Judge opus'))
    expect(haiku).toHaveLength(1)
    expect(opus).toHaveLength(1)
    for (const line of [haiku[0]!, opus[0]!]) {
      expect(line).toContain('agreement 100.0% (exact 100.0%)')
      expect(line).toMatch(/fit 4\.0/)
      expect(line).toMatch(/simplicity 5\.0/)
      expect(line).toMatch(/words 3\.0/)
    }
    expect(haiku[0]).toContain('$0.0003')
    expect(haiku[0]).toContain('333333.3')
    expect(opus[0]).toContain('$0.0015')
    expect(opus[0]).toContain('66666.7')
    // They come in the order of the list.
    expect(logs.indexOf(haiku[0]!)).toBeLessThan(logs.indexOf(opus[0]!))
  })

  it('shows both figures on the judge line, agreement (right against not) first and the exact figure after it, and nothing of what a judge said', async () => {
    // Every case's cleanse pick is labelled best. Case 2 the judges say acceptable: agreed 3 of 3 = 100.0%, exactly 2 of 3 = 66.7%.
    const { run, logs } = setup({
      judgeAnswer: (call) => {
        const base = agreeingJudgement()
        return { ...base, picks: base.picks.map((p) => (call === 2 && p.step === 'cleanse' ? { ...p, pickClass: 'acceptable' as const } : p)) }
      },
    })

    await run()

    for (const name of ['haiku', 'opus']) expect(logs.find((l) => l.startsWith(`Judge ${name}`))!, name).toContain('agreement 100.0% (exact 66.7%)')
  })

  it('prints n/a for both figures of a judge that produced nothing', async () => {
    const { run, logs } = setup({ judgeAnswers: { haiku: () => { throw new FakeJudgeError(JUDGE_ERROR_SENTINEL) } } })

    await run()

    expect(logs.find((l) => l.startsWith('Judge haiku'))!).toContain('agreement n/a (exact n/a)')
  })

  it('prints n/a, not a number, for a judge that produced nothing, and for an agreement per dollar when the judge cost nothing', async () => {
    const { run, logs } = setup({
      judgeAnswers: {
        haiku: () => {
          throw new FakeJudgeError(JUDGE_ERROR_SENTINEL)
        },
      },
    })

    await run()

    const haiku = logs.find((l) => l.startsWith('Judge haiku'))!
    const opus = logs.find((l) => l.startsWith('Judge opus'))!
    expect(haiku).toContain('n/a')
    // opus agrees at 100% and cost nothing here, so its agreement per dollar is n/a too.
    expect(opus).toContain('100.0%')
    expect(opus).toContain('n/a')
    for (const line of [haiku, opus]) expect(line).not.toMatch(/NaN|Infinity|null|undefined/)
  })
})

describe('runRoutineEval: the judge models', () => {
  it('names both judges and their models in the report, in the order of the list, beside the writer\'s model', async () => {
    const { run, files } = setup()

    await run()

    expect(reportOf(files)).toMatchObject({ model: WRITER_MODEL, judges: [{ name: 'haiku', model: 'claude-haiku-5-5' }, { name: 'opus', model: 'claude-opus-5-5' }] })
  })

  it('names only the judges that were asked for, and keys each case\'s judgements by them', async () => {
    const { run, files, judges } = setup({ judgeNames: ['opus'] })

    await run()

    const report = reportOf(files)
    expect(report.judges).toEqual([{ name: 'opus', model: 'claude-opus-5-5' }])
    expect(Object.keys(report.cases[0]!.judgements)).toEqual(['opus'])
    expect(judges.opus.calls).toHaveLength(3)
    expect(report.summary.judgeComparison.map((row) => row.name)).toEqual(['opus'])
    expect(report.summary.selectedJudge).toBe('opus')
  })

  it('prints no same-model note any more: a judge that equals the writer is refused with the arguments, before a run starts', async () => {
    const { run, logs } = setup()

    await run()

    expect(logs.filter((l) => l.includes('judge-routine') && l.includes('write-routine'))).toEqual([])
    expect(logs.filter((l) => /blind spot|grading its own/i.test(l))).toEqual([])
  })
})

// --- two judges on the same routines (#152, PR 4c) ---------------------------------------------------------------------------------------------------

/** Cases hold-01 to hold-20, each with one scored gap (cleanse), so a judge's agreement moves in steps of 5 points: 17 of 20 is 85. */
const TWENTY: RoutineCase[] = Array.from({ length: 20 }, (_, i) => caseOf({ id: `hold-${String(i + 1).padStart(2, '0')}` }))

/** A judge that gets cleanse wrong (says "not" where the labels say best) on its first `wrong` calls, and scores what it is given. */
const wrongOn =
  (wrong: number, scores: { fit: number; simplicity: number; words: number } = { fit: 4, simplicity: 5, words: 3 }) =>
  (call: number): RoutineJudgement => {
    const base = agreeingJudgement()
    return { ...base, ...scores, picks: base.picks.map((p) => (call <= wrong && p.step === 'cleanse' ? { ...p, pickClass: 'not' as const } : p)) }
  }

const HAIKU_SCORES = { fit: 4, simplicity: 5, words: 3 }
const OPUS_SCORES = { fit: 2, simplicity: 3, words: 4 }

describe('runRoutineEval: two judges on the same routines', () => {
  it('writes each routine once and gives both judges the same skeleton and routine: no writer call is repeated', async () => {
    const { run, memory, writer, judges } = setup()

    await run()

    expect(memory.calls).toHaveLength(3)
    expect(writer.events).toEqual(['start', 'end', 'start', 'end', 'start', 'end'])
    for (const [i, skeleton] of memory.calls.entries()) {
      expect(judges.haiku.calls[i]!.skeleton).toBe(skeleton)
      expect(judges.opus.calls[i]!.skeleton).toBe(skeleton)
      expect(judges.haiku.calls[i]!.routine).toEqual(goodRoutine(skeleton))
      expect(judges.opus.calls[i]!.routine).toEqual(judges.haiku.calls[i]!.routine)
    }
  })

  it('records each judge\'s cost per case and per judge, and compares them: worked by hand', async () => {
    // 3 cases. haiku costs 200 a call, opus 900, the writer 1000, no grounding cost. A case costs 1000 + 200 + 900 = 2100; the run 6300.
    // haiku: disagrees on case 2 (cleanse 'not'; was 'acceptable' before #152 follow-up, which now agrees), so 2 of 3 = 66.667%; fit (5 + 3 + 1) / 3 = 3, simplicity (5 + 4 + 3) / 3 = 4, words (2 + 3 + 4) / 3 = 3.
    //   cost 3 * 200 = 600 micros = $0.0006; agreement per dollar 66.667 / 0.0006 = 111111.1.
    // opus: agrees on all 3 = 100%, fit 4, simplicity 5, words 3 (the default answer). cost 3 * 900 = 2700 micros = $0.0027; agreement per dollar 100 / 0.0027 = 37037.04.
    // opus is the only judge at 80% or more, so opus is selected and its numbers are the run's.
    const scores = [
      { fit: 5, simplicity: 5, words: 2 },
      { fit: 3, simplicity: 4, words: 3 },
      { fit: 1, simplicity: 3, words: 4 },
    ]
    const { run, files, ledger } = setup({
      judgeMicros: { haiku: 200, opus: 900 },
      judgeAnswers: {
        haiku: (call) => {
          const base = agreeingJudgement()
          return { ...base, ...scores[call - 1]!, picks: base.picks.map((p) => (call === 2 && p.step === 'cleanse' ? { ...p, pickClass: 'not' as const } : p)) }
        },
      },
    })

    await run()

    const report = reportOf(files)
    for (const c of report.cases) {
      expect(c.judgeCostMicros).toEqual({ haiku: 200, opus: 900 })
      expect(c.costMicros).toBe(2100)
    }
    expect(report.summary.costMicros).toBe(6300)
    expect(ledger.spentMicros()).toBe(6300)
    const [haiku, opus] = report.summary.judgeComparison
    expect(haiku).toMatchObject({ name: 'haiku', model: 'claude-haiku-5-5', fit: 3, simplicity: 4, words: 3, costMicros: 600 })
    expect(haiku!.agreement).toBeCloseTo(66.667, 2)
    expect(haiku!.agreementPerDollar).toBeCloseTo(111111.1, 0)
    expect(opus).toMatchObject({ name: 'opus', model: 'claude-opus-5-5', agreement: 100, fit: 4, simplicity: 5, words: 3, costMicros: 2700 })
    expect(opus!.agreementPerDollar).toBeCloseTo(37037.04, 1)
    expect(report.summary.judgeComparison).toHaveLength(2)
    expect(report.summary.selectedJudge).toBe('opus')
    expect(report.summary).toMatchObject({ judgeAgreement: 100, fit: 4, simplicity: 5, words: 3 })
  })

  it('has no agreement per dollar for a judge that cost nothing: the division by zero is null', async () => {
    const { run, files } = setup()

    await run()

    for (const row of reportOf(files).summary.judgeComparison) {
      expect(row.costMicros).toBe(0)
      expect(row.agreement).toBe(100)
      expect(row.agreementPerDollar).toBeNull()
    }
  })

  it('selects the cheaper judge when both reach 80%, feeds its numbers to the bar and PASSES: haiku 17 of 20 = 85%, opus 19 of 20 = 95%', async () => {
    // Haiku (200 a call) gets cleanse wrong on its first 3 calls: 17 of 20 = 85%. Opus (900 a call) on its first 1: 19 of 20 = 95%. Both are trusted; haiku is cheaper.
    // haiku: 20 * 200 = 4000 micros = $0.0040, 85 / 0.0040 = 21250. opus: 20 * 900 = 18000 micros = $0.0180, 95 / 0.0180 = 5277.78.
    // The bar takes haiku's numbers: agreement 85 (not opus's 95), fit 4 (not opus's 2).
    const { run, files, logs } = setup({
      cases: TWENTY,
      judgeMicros: { haiku: 200, opus: 900 },
      judgeAnswers: { haiku: wrongOn(3, HAIKU_SCORES), opus: wrongOn(1, OPUS_SCORES) },
    })

    const { exitCode } = await run()

    const { summary } = reportOf(files)
    const [haiku, opus] = summary.judgeComparison
    expect(haiku).toMatchObject({ name: 'haiku', agreement: 85, fit: 4, simplicity: 5, words: 3, costMicros: 4000 })
    expect(haiku!.agreementPerDollar).toBeCloseTo(21250, 2)
    expect(opus).toMatchObject({ name: 'opus', agreement: 95, fit: 2, simplicity: 3, words: 4, costMicros: 18000 })
    expect(opus!.agreementPerDollar).toBeCloseTo(5277.78, 2)
    expect(summary.selectedJudge).toBe('haiku')
    expect(summary).toMatchObject({ judgeAgreement: 85, fit: 4, simplicity: 5, words: 3 })
    expect(summary.bar).toEqual({ status: 'pass' })
    expect(logs.at(-1)).toBe('Bar: PASS')
    expect(exitCode).toBe(0)
  })

  it('selects the dearer judge when only it reaches 80%, and that is what lets the bar PASS: haiku 15 of 20 = 75%, opus 18 of 20 = 90%', async () => {
    const { run, files, logs } = setup({
      cases: TWENTY,
      judgeMicros: { haiku: 200, opus: 900 },
      judgeAnswers: { haiku: wrongOn(5, HAIKU_SCORES), opus: wrongOn(2, OPUS_SCORES) },
    })

    const { exitCode } = await run()

    const { summary } = reportOf(files)
    expect(summary.selectedJudge).toBe('opus')
    expect(summary).toMatchObject({ judgeAgreement: 90, fit: 2, simplicity: 3, words: 4 })
    expect(summary.bar).toEqual({ status: 'pass' })
    expect(logs.at(-1)).toBe('Bar: PASS')
    expect(exitCode).toBe(0)
  })

  it('counts exactly 80% as trusted and passing: haiku 16 of 20 = 80% is selected over opus at 100%', async () => {
    const { run, files, logs } = setup({
      cases: TWENTY,
      judgeMicros: { haiku: 200, opus: 900 },
      judgeAnswers: { haiku: wrongOn(4, HAIKU_SCORES), opus: wrongOn(0, OPUS_SCORES) },
    })

    const { exitCode } = await run()

    const { summary } = reportOf(files)
    expect(summary.judgeComparison.map((row) => row.agreement)).toEqual([80, 100])
    expect(summary.selectedJudge).toBe('haiku')
    expect(summary.judgeAgreement).toBe(80)
    expect(logs.at(-1)).toBe('Bar: PASS')
    expect(exitCode).toBe(0)
  })

  it('uses the judge with the highest agreement when neither reaches 80%, and the bar FAILS on judge-agreement: haiku 14 of 20 = 70%, opus 15 of 20 = 75%', async () => {
    const { run, files, logs } = setup({
      cases: TWENTY,
      judgeMicros: { haiku: 200, opus: 900 },
      judgeAnswers: { haiku: wrongOn(6, HAIKU_SCORES), opus: wrongOn(5, OPUS_SCORES) },
    })

    const { exitCode } = await run()

    const { summary } = reportOf(files)
    expect(summary.selectedJudge).toBe('opus')
    expect(summary.judgeAgreement).toBe(75)
    expect(summary.bar).toMatchObject({ status: 'fail', rules: ['judge-agreement'] })
    expect(logs.at(-1)).toBe('Bar: FAIL (judge-agreement)')
    expect(exitCode).toBe(1)
  })

  it('leaves the other judge selected when one fails on every case, and the bar PASSES on it; the failed judge is reported with its errors, and its billed calls still count', async () => {
    // haiku throws on every call (after taking its 200 micros), so it has no result: agreement n/a, and it is not selected however cheap it is. Opus agrees on 3 of 3.
    const { run, memory, judges, files, logs } = setup({
      judgeMicros: { haiku: 200, opus: 900 },
      judgeAnswers: {
        haiku: () => {
          throw new FakeJudgeError(JUDGE_ERROR_SENTINEL)
        },
      },
    })

    const { exitCode } = await run()

    expect(memory.calls).toHaveLength(3)
    expect(judges.haiku.calls).toHaveLength(3)
    expect(judges.opus.calls).toHaveLength(3)
    const report = reportOf(files)
    for (const c of report.cases) {
      expect(c.judgements.haiku).toBeNull()
      expect(c.judgements.opus).not.toBeNull()
      expect(c.judgeErrors).toEqual({ haiku: 'FakeJudgeError' })
    }
    const [haiku, opus] = report.summary.judgeComparison
    expect(haiku).toMatchObject({ name: 'haiku', agreement: null, fit: null, simplicity: null, words: null, agreementPerDollar: null, costMicros: 600 })
    expect(opus).toMatchObject({ name: 'opus', agreement: 100, costMicros: 2700 })
    expect(report.summary.selectedJudge).toBe('opus')
    expect(report.summary.bar).toEqual({ status: 'pass' })
    expect(logs.at(-1)).toBe('Bar: PASS')
    expect(exitCode).toBe(0)
    expect(files.get(REPORT_PATH)).not.toContain(JUDGE_ERROR_SENTINEL)
    expect(logs.join('\n')).not.toContain(JUDGE_ERROR_SENTINEL)
  })

  it('has no selected judge, and the bar says no-judge, when both judges failed on every case', async () => {
    const fail = () => {
      throw new FakeJudgeError(JUDGE_ERROR_SENTINEL)
    }
    const { run, files, logs } = setup({ judgeAnswers: { haiku: fail, opus: fail } })

    const { exitCode } = await run()

    expect(reportOf(files).summary.selectedJudge).toBeNull()
    expect(reportOf(files).summary.judgeComparison.map((row) => row.agreement)).toEqual([null, null])
    expect(logs.find((l) => l.startsWith('Selected judge'))).toMatch(/none/i)
    expect(logs.at(-1)).toBe('Bar: not evaluated (no-judge)')
    expect(exitCode).toBe(0)
  })

  it('shows the comparison on the console, and names the selected judge after the judge lines and before the bar line', async () => {
    const { run, logs } = setup({
      cases: TWENTY,
      judgeMicros: { haiku: 200, opus: 900 },
      judgeAnswers: { haiku: wrongOn(3, HAIKU_SCORES), opus: wrongOn(1, OPUS_SCORES) },
    })

    await run()

    const haiku = logs.findIndex((l) => l.startsWith('Judge haiku'))
    const opus = logs.findIndex((l) => l.startsWith('Judge opus'))
    const selected = logs.findIndex((l) => l.startsWith('Selected judge'))
    const bar = logs.findIndex((l) => l.startsWith('Bar:'))
    expect(logs.filter((l) => l.startsWith('Selected judge'))).toHaveLength(1)
    expect(haiku).toBeGreaterThan(-1)
    expect(opus).toBeGreaterThan(haiku)
    expect(selected).toBeGreaterThan(opus)
    expect(bar).toBeGreaterThan(selected)
    expect(logs[selected]).toContain('haiku')
    expect(logs[selected]).not.toContain('opus')
    // haiku: 85.0%, fit 4.0, simplicity 5.0, words 3.0, $0.0040, 21250.0 per dollar. opus: 95.0%, fit 2.0, simplicity 3.0, words 4.0, $0.0180, 5277.8 per dollar.
    expect(logs[haiku]).toContain('85.0%')
    expect(logs[haiku]).toMatch(/fit 4\.0/)
    expect(logs[haiku]).toContain('$0.0040')
    expect(logs[haiku]).toContain('21250.0')
    expect(logs[opus]).toContain('95.0%')
    expect(logs[opus]).toMatch(/fit 2\.0/)
    expect(logs[opus]).toContain('$0.0180')
    expect(logs[opus]).toContain('5277.8')
  })

  it('never prints a judge\'s problem codes or any other text of a judge, with two judges, and starts no line with a case id but the case\'s own', async () => {
    const { run, logs, files } = setup({ judgeMicros: { haiku: 100, opus: 500 } })

    await run()

    const console_ = logs.join('\n')
    for (const code of PROBLEMS) expect(console_, code).not.toContain(code)
    for (const code of PROBLEMS) expect(files.get(REPORT_PATH)!, code).toContain(code)
    for (const id of ['hold-01', 'hold-02', 'hold-03']) expect(lineOf(logs, id), id).toHaveLength(1)
  })
})

describe('runRoutineEval: the page-support judge', () => {
  it('checks each grounding link of each entry once, with the step, the entry\'s reason and the link, in case and entry order', async () => {
    const { run, grounding } = setup()

    await run()

    expect(grounding.calls).toHaveLength(3 * LINKS_PER_CASE)
    expect(grounding.calls[0]).toEqual({ step: 'cleanse', reason: `${REASON_SENTINEL} for cleanse`, sourceUrl: `https://shop.example/${URL_SENTINEL}/c-a` })
    expect(grounding.calls.slice(0, 3).map((r) => r.step)).toEqual(['cleanse', 'moisturise', 'protect'])
    expect(grounding.calls.slice(3, 6).map((r) => r.step)).toEqual(['cleanse', 'moisturise', 'protect'])
  })

  it('checks nothing for a case with no routine, or with an entry that has no grounding link', async () => {
    const { run, grounding } = setup({
      answer: (call, skeleton) => {
        if (call === 1) throw new FakeWriterError(ERROR_SENTINEL)
        if (call === 2) {
          const routine = goodRoutine(skeleton)
          return { ...routine, steps: routine.steps.map((e) => ({ ...e, grounding: [] })) }
        }
        return undefined
      },
    })

    await run()

    // Case 1 has no routine, case 2's entries cite nothing, case 3 has its 3 links.
    expect(grounding.calls).toHaveLength(LINKS_PER_CASE)
  })

  it('stops asking at --max-grounding for the whole run: 3 cases of 3 links with a cap of 4 is 4 checks, the first 4 in order', async () => {
    const { run, grounding, files } = setup({ maxGrounding: 4 })

    await run()

    expect(grounding.calls).toHaveLength(4)
    expect(grounding.calls.map((r) => r.step)).toEqual(['cleanse', 'moisturise', 'protect', 'cleanse'])
    const { summary } = reportOf(files)
    expect(summary.groundingChecked).toBe(4)
    expect(summary.groundingSkipped).toBe(5)
  })

  it('asks for no check at all with --max-grounding 0, and has no support score', async () => {
    const { run, grounding, files, logs } = setup({ maxGrounding: 0 })

    const { exitCode } = await run()

    expect(grounding.calls).toEqual([])
    expect(reportOf(files).summary).toMatchObject({ groundingSupport: null, groundingChecked: 0, groundingSkipped: 9 })
    expect(logs.at(-1)).toBe('Bar: PASS')
    expect(exitCode).toBe(0)
  })

  it('checks every link when the cap is as big as the links: the boundary, 9 of 9', async () => {
    const { run, grounding, files } = setup({ maxGrounding: 9 })

    await run()

    expect(grounding.calls).toHaveLength(9)
    expect(reportOf(files).summary.groundingSkipped).toBe(0)
  })

  it('scores the share of links checked that are supported, counting a link it could not verify as not supported', async () => {
    // Cap 4: the verdicts are supported, not supported, unverifiable and supported: 2 of 4 = 50%. One of the four was unverifiable.
    const verdicts: GroundingVerdict[] = [
      { fetched: true, supports: 'yes' },
      { fetched: true, supports: 'no' },
      { fetched: false, supports: 'unclear', reason: 'not-fetched' },
      { fetched: true, supports: 'yes' },
    ]
    const { run, files, logs } = setup({ maxGrounding: 4, groundingAnswer: (call) => verdicts[call - 1] })

    await run()

    const { summary, cases } = reportOf(files)
    expect(summary).toMatchObject({ groundingSupport: 50, groundingChecked: 4, groundingSupported: 2, groundingUnverifiable: 1 })
    expect(cases[0]!.grounding.map((g) => g.verdict)).toEqual(verdicts.slice(0, 3))
    expect(cases[1]!.grounding.map((g) => g.verdict.supports)).toEqual(['yes'])
    expect(logs.find((l) => /ground/i.test(l))).toMatch(/2 of 4/)
  })

  it('does not put the support score in the bar: every link unsupported still PASSES a run that is otherwise clean', async () => {
    const { run, logs, files } = setup({ groundingAnswer: () => ({ fetched: true, supports: 'no' }) })

    const { exitCode } = await run()

    expect(reportOf(files).summary.groundingSupport).toBe(0)
    expect(logs.at(-1)).toBe('Bar: PASS')
    expect(exitCode).toBe(0)
  })

  it('never prints a link\'s address or a reason on the console', async () => {
    const { run, logs } = setup()

    await run()

    const console_ = logs.join('\n')
    expect(console_).not.toContain(URL_SENTINEL)
    expect(console_).not.toContain(REASON_SENTINEL)
    expect(console_).not.toMatch(/https?:\/\//)
  })

  it('stops the run, exits 2, and asks for nothing more when the page-support judge is refused by Claude', async () => {
    const { run, grounding, memory } = setup({
      groundingAnswer: () => {
        throw new AnthropicConfigError(ERROR_SENTINEL)
      },
    })

    const { exitCode } = await run()

    expect(exitCode).toBe(2)
    expect(grounding.calls).toHaveLength(1)
    expect(memory.calls).toHaveLength(1)
  })

  it('asks about no link of a routine that failed the grounding gate, and counts them apart from the ones the cap left out', async () => {
    // Case 2 cites a link that is not its candidate's own (the grounding gate), so none of its 3 links is fetched; cases 1 and 3 are checked as usual.
    const { run, grounding, files } = setup({
      answer: (call, skeleton) => {
        if (call !== 2) return undefined
        const routine = goodRoutine(skeleton)
        return { ...routine, steps: routine.steps.map((e) => (e.grounding.length > 0 ? { ...e, grounding: ['https://elsewhere.example/not-its-own'] } : e)) }
      },
    })

    await run()

    expect(grounding.calls).toHaveLength(2 * LINKS_PER_CASE)
    const { summary, cases } = reportOf(files)
    expect(summary).toMatchObject({ groundingChecked: 6, groundingSkipped: 0, groundingSkippedGate: LINKS_PER_CASE })
    expect(cases[1]!.grounding).toEqual([])
  })

  it('treats a page-support judge that fails some other way as an unverifiable link, and goes on', async () => {
    const { run, grounding, files } = setup({
      groundingAnswer: (call) => {
        if (call === 2) throw new FakeJudgeError(JUDGE_ERROR_SENTINEL)
        return undefined
      },
    })

    await run()

    expect(grounding.calls).toHaveLength(9)
    const { summary } = reportOf(files)
    expect(summary).toMatchObject({ groundingChecked: 9, groundingSupported: 8, groundingUnverifiable: 1 })
    expect(files.get(REPORT_PATH)).not.toContain(JUDGE_ERROR_SENTINEL)
  })
})


// --- who made the labels (#152, follow-up to PR D2) ------------------------------------------------------------------------------------------
// Opus can label the cases (`npm run eval:routine:auto-label`), and a model never grades its own work: a judge whose model made the labels is reported, marked as
// self-agreement, and left out of choosing the judge. The report names who made the labels (`labelledBy`, top level: a model id, 'human', or null with no labels); a label set
// without the field is a legacy one and counts as human. The Opus judge runs on 'claude-opus-5-5' (JUDGE_MODELS), which is what the labels name here.
//   summary.judgeComparison[].selfAgreement: boolean       summary.bar reason 'judge-self-labelled' when every judge made the labels
//   console: the judge line of a self-agreeing judge ends with "(self-agreement: made the labels)"

const OPUS_LABELS = (cases: RoutineCase[]): LabelSet => ({ ...LABELS_FOR_ALL(cases), labelledBy: JUDGE_MODELS.opus })

describe('runRoutineEval: who made the labels', () => {
  it('names the model that made the labels at the top of the report', async () => {
    const { run, files } = setup({ labels: OPUS_LABELS(CASES) })

    await run()

    expect(reportOf(files).labelledBy).toBe('claude-opus-5-5')
  })

  it('names a human for labels made in the sheet, and for a label set that does not say (a legacy one)', async () => {
    const sheet = setup({ labels: { ...LABELS_FOR_ALL(CASES), labelledBy: 'human' } })
    await sheet.run()
    const legacy = setup({ labels: LABELS_FOR_ALL(CASES) })
    await legacy.run()

    expect(reportOf(sheet.files).labelledBy).toBe('human')
    expect(reportOf(legacy.files).labelledBy).toBe('human')
  })

  it('names nobody when the run had no labels', async () => {
    const { run, files } = setup({ labels: null })

    await run()

    expect(reportOf(files).labelledBy).toBeNull()
  })
})

describe('runRoutineEval: a judge whose model made the labels', () => {
  // 20 cases. Opus (200 a call) agrees on all 20 = 100%; Haiku (900 a call) gets cleanse wrong on 3: 17 of 20 = 85%. Opus agrees more and is cheaper than Haiku;
  // both reach 80%. With human labels Opus is the cheapest trusted judge. With labels made by Opus it is not allowed to count, so Haiku is selected.
  const twentyJudges = (labels: LabelSet) => setup({ cases: TWENTY, labels, judgeMicros: { haiku: 900, opus: 200 }, judgeAnswers: { haiku: wrongOn(3, HAIKU_SCORES), opus: wrongOn(0, OPUS_SCORES) } })

  it('selects Haiku, and feeds its numbers to the bar, even though Opus agrees more and costs less', async () => {
    const { run, files, logs } = twentyJudges(OPUS_LABELS(TWENTY))

    const { exitCode } = await run()

    const { summary } = reportOf(files)
    expect(summary.selectedJudge).toBe('haiku')
    expect(summary).toMatchObject({ judgeAgreement: 85, fit: 4, simplicity: 5, words: 3 })
    expect(summary.bar).toEqual({ status: 'pass' })
    expect(logs.at(-1)).toBe('Bar: PASS')
    expect(exitCode).toBe(0)
  })

  it('selects Opus, as before, when a human made the same labels: the rule is about who made them, not about Opus', async () => {
    const { run, files } = twentyJudges({ ...LABELS_FOR_ALL(TWENTY), labelledBy: 'human' })

    await run()

    const { summary } = reportOf(files)
    expect(summary.selectedJudge).toBe('opus')
    expect(summary.judgeAgreement).toBe(100)
    expect(summary.judgeComparison.map((row) => row.selfAgreement)).toEqual([false, false])
  })

  it('still reports the self-agreeing judge in full, marked in the report: its agreement, scores and cost are there', async () => {
    const { run, files } = twentyJudges(OPUS_LABELS(TWENTY))

    await run()

    const [haiku, opus] = reportOf(files).summary.judgeComparison
    expect(haiku).toMatchObject({ name: 'haiku', selfAgreement: false, agreement: 85, costMicros: 18000 })
    expect(opus).toMatchObject({ name: 'opus', model: 'claude-opus-5-5', selfAgreement: true, agreement: 100, fit: 2, simplicity: 3, words: 4, costMicros: 4000 })
  })

  it('marks it on the console: the judge line of the judge that made the labels says "(self-agreement: made the labels)", and the other does not', async () => {
    const { run, logs } = twentyJudges(OPUS_LABELS(TWENTY))

    await run()

    const haiku = logs.find((l) => l.startsWith('Judge haiku'))!
    const opus = logs.find((l) => l.startsWith('Judge opus'))!
    expect(opus).toContain('(self-agreement: made the labels)')
    expect(opus).toContain('100.0%')
    expect(haiku).not.toContain('self-agreement')
  })

  it('does not mark any judge when a human made the labels', async () => {
    const { run, logs } = twentyJudges({ ...LABELS_FOR_ALL(TWENTY), labelledBy: 'human' })

    await run()

    expect(logs.filter((l) => l.includes('self-agreement'))).toEqual([])
  })

  it('has no selected judge, and the bar says judge-self-labelled, when the only judge is the one that made the labels', async () => {
    const { run, files, logs } = setup({ judgeNames: ['opus'], labels: OPUS_LABELS(CASES) })

    const { exitCode } = await run()

    const { summary } = reportOf(files)
    expect(summary.selectedJudge).toBeNull()
    expect(summary.judgeAgreement).toBeNull()
    expect(summary.judgeComparison).toHaveLength(1)
    expect(summary.judgeComparison[0]).toMatchObject({ name: 'opus', selfAgreement: true, agreement: 100 })
    expect(summary.bar).toEqual({ status: 'not-evaluated', reasons: ['judge-self-labelled'] })
    expect(logs.find((l) => l.startsWith('Selected judge'))).toMatch(/none/i)
    expect(logs.at(-1)).toBe('Bar: not evaluated (judge-self-labelled)')
    expect(exitCode).toBe(0)
  })

  it('says no-judge, not judge-self-labelled, when the judges failed and no labels were the cause', async () => {
    const fail = () => {
      throw new FakeJudgeError(JUDGE_ERROR_SENTINEL)
    }
    const { run, logs } = setup({ judgeNames: ['opus'], judgeAnswers: { opus: fail }, labels: { ...LABELS_FOR_ALL(CASES), labelledBy: 'human' } })

    await run()

    expect(logs.at(-1)).toBe('Bar: not evaluated (no-judge)')
  })
})
