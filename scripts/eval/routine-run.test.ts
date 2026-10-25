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
import type { LabelSet } from './routine-labels'
import { defaultOutDir, runRoutineEval } from './routine-run'
import { caseOf, offer, row, snapshotOf } from './routine.fixture'

// The orchestration of `npm run eval:routine`, with the writer faked (MemoryRoutineWriter) and the ledger real (a MemoryAiSpendLedger, as in the script), and
// the snapshot, labels, clock and disk handed in: each case's skeleton is built by the real buildSkeleton over a tiny snapshot, written, checked by the real
// checkRoutine, scored, and the report and console lines come out. Nothing here calls the API or touches the disk.
//
// The bar in D1: with no judge it can never PASS, but a rule that can be evaluated and fails (gates, forbidden wording, right product with labels) is a FAIL
// and exits 1, with what could not be evaluated listed beside it. A run with nothing failing and something missing is a trial: not evaluated, exit 0.
// A rejected key exits 2.

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

type Setup = {
  cases?: RoutineCase[]
  set?: 'dev' | 'holdout'
  labels?: LabelSet | null
  limit?: number
  capMicros?: number
  previous?: { summary: { rightProduct: number | null; fit: number | null; simplicity: number | null; words: number | null } } | null
  /** What the writer answers on the n-th call (1-based); the good routine when it returns undefined. Throw to fail that call. */
  answer?: (call: number, skeleton: RoutineSkeleton) => Routine | undefined
}

const setup = ({ cases = CASES, set = 'holdout', labels, limit, capMicros = BIG_CAP_MICROS, previous, answer = () => undefined }: Setup = {}) => {
  const ledger = new MemoryAiSpendLedger({ capMicros })
  const memory = new MemoryRoutineWriter()
  let call = 0
  memory.respondWith((skeleton) => answer(++call, skeleton) ?? goodRoutine(skeleton))
  const writer = new SpendingWriter(memory, ledger, MICROS_PER_CALL)
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
      model: 'claude-test-model',
      promptHash: 'prompt-hash-123',
      snapshot: SNAPSHOT,
      labels: labels === undefined ? LABELS_FOR_ALL(cases) : labels,
      ...(previous === undefined ? {} : { previous }),
      deps: { writer, ledger },
      io: {
        log: (line) => logs.push(line),
        mkdir: async (dir) => void dirs.push(dir),
        writeFile: async (path, text) => void files.set(path, text),
      },
    })
  return { ledger, memory, writer, logs, dirs, files, run }
}

type Reported = {
  startedAt: string
  set: string
  snapshotSha256: string
  labelVersion: string | null
  labelSnapshotSha256: string | null
  model: string
  promptHash: string
  partial: boolean
  cases: { id: string; state: string; writerError?: string; skeleton?: RoutineSkeleton; routine: Routine | null; failures: { gate: string; step: RoutineStep | null }[]; costMicros: number; score: { picks: string; gatesPassed: boolean } }[]
  summary: { gatesPassed: number | null; forbiddenWording: number; rightProduct: number | null; needsRelabel: string[]; costMicros: number; bar: { status: string; reasons?: string[]; rules?: string[] } }
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
    expect(report).toMatchObject({ startedAt: BASE.toISOString(), set: 'holdout', snapshotSha256: SNAPSHOT.sha256, labelVersion: 'v1', model: 'claude-test-model', promptHash: 'prompt-hash-123', partial: false })
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
})

describe('runRoutineEval: the bar, which a run in D1 can never pass', () => {
  it('is not evaluated for a full holdout run with labels and no judge, exits 0 and says it is a trial', async () => {
    const { run, logs, files } = setup()

    const { exitCode } = await run()

    expect(logs.at(-1)).toBe('Bar: not evaluated (no-judge)')
    expect(logs.join('\n')).toMatch(/trial/i)
    expect(exitCode).toBe(0)
    expect(reportOf(files).summary.bar).toEqual({ status: 'not-evaluated', reasons: ['no-judge'] })
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

  it('fails the bar and exits 1 when a routine breaks a gate, even with no judge, and says the judge is not evaluated', async () => {
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
    expect(logs.at(-1)).toBe('Bar: FAIL (gates, right-product; not evaluated: no-judge)')
    expect(reportOf(files).summary.bar).toEqual({ status: 'fail', rules: ['gates', 'right-product'], notEvaluated: ['no-judge'] })
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

