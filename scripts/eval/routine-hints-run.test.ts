import { describe, expect, it } from 'vitest'
import type { Routine, RoutineSkeleton } from '../../src/modules/routines/routines.types'
import { AnthropicConfigError } from '../../src/providers/anthropic/anthropic.provider'
import { BIG_CAP_MICROS } from '../../src/providers/anthropic/messages-api.fake'
import { MemoryAiSpendLedger } from '../../src/providers/anthropic/memory.ai-spend-ledger'
import { MemoryRoutineWriter } from '../../src/providers/routine-writing/memory.routine-writer'
import type { LabelSet } from './routine-labels'
import { runHintEval } from './routine-hints-run'
import { caseOf, offer, row, snapshotOf } from './routine.fixture'

// The run of `--set hints`: the pure builder is tested in routine-hints.test.ts; this is the loop around it, with a memory writer and no disk.
// Cleanse has three candidates: C-A (best), C-B (acceptable) and C-C (not acceptable), so a person with no caution gets a follow case (C-B) and an ignore case (C-C).

const SNAPSHOT = snapshotOf([
  offer('NG', row('C-A', { steps: ['cleanse'] })),
  offer('NG', row('C-B', { steps: ['cleanse'] })),
  offer('NG', row('C-C', { steps: ['cleanse'] })),
  offer('NG', row('M-1', { steps: ['moisturise'] })),
])
const CASES = [caseOf({ id: 'hold-01' }), caseOf({ id: 'hold-02', cautions: ['tapering'] })]
const labelsFor = (ids: string[], candidates = ['C-A', 'C-B', 'C-C']): LabelSet => ({
  version: 'v1',
  status: 'provisional',
  snapshotSha256: SNAPSHOT.sha256,
  cases: Object.fromEntries(ids.map((id) => [id, { cleanse: { candidates, best: 'C-A', acceptable: ['C-B'] }, moisturise: { candidates: ['M-1'], best: 'M-1', acceptable: [] } }])) as LabelSet['cases'],
})

/** A writer that leans on the strongest hint in the cleanse gap (or takes the first candidate when there is none) and uses the only candidate elsewhere. */
const hintFollowing = (skeleton: RoutineSkeleton): Routine => ({
  steps: skeleton.steps.map((step) => {
    const candidates = skeleton.gaps.find((gap) => gap.step === step)!.candidates
    const chosen = [...candidates].sort((a, b) => (b.outcomeHint?.netFainter ?? 0) - (a.outcomeHint?.netFainter ?? 0))[0]
    return chosen ? { step, product: { kind: 'candidate' as const, code: chosen.code }, frequency: chosen.frequency, reason: 'r', grounding: [] } : { step, product: { kind: 'none' as const }, frequency: 'pm' as const, reason: 'r', grounding: [] }
  }),
  tapers: [],
  expectation: 'e',
})

const setup = (labels: LabelSet, over: { limit?: number } = {}) => {
  const memory = new MemoryRoutineWriter()
  memory.respondWith(hintFollowing)
  const logs: string[] = []
  const files = new Map<string, string>()
  const run = () =>
    runHintEval({
      cases: CASES,
      ...over,
      outDir: 'out',
      startedAt: new Date('2030-06-15T00:00:00.000Z'),
      model: 'claude-test-model',
      promptHash: 'h',
      snapshot: SNAPSHOT,
      labels,
      deps: { writer: memory, ledger: new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS }) },
      io: { log: (line) => logs.push(line), mkdir: async () => {}, writeFile: async (path, text) => void files.set(path, text) },
    })
  return { memory, logs, files, run }
}

describe('runHintEval', () => {
  it('asks the writer once per hint case with the strong hint on the hinted candidate and hints shown, and records the pick at that gap', async () => {
    const { run, memory, files } = setup(labelsFor(['hold-01', 'hold-02']))

    const { exitCode } = await run()

    // hold-01: follow C-B and ignore C-C. hold-02 has a caution: ignore C-C only.
    expect(exitCode).toBe(0)
    expect(memory.calls).toHaveLength(3)
    expect(memory.calls.every((s) => s.hintsShown)).toBe(true)
    const cleanse = memory.calls[0]!.gaps.find((g) => g.step === 'cleanse')!.candidates
    expect(cleanse.map((c) => [c.code, c.outcomeHint?.netFainter])).toEqual([['C-A', 0.1], ['C-B', 0.6], ['C-C', 0.1]])
    const report = JSON.parse(files.get('out/report.json')!)
    expect(report.set).toBe('hints')
    expect(report.results.map((r: { id: string; pick: string }) => [r.id, r.pick])).toEqual([['hold-01:cleanse:follow', 'C-B'], ['hold-01:cleanse:ignore', 'C-C'], ['hold-02:cleanse:ignore', 'C-C']])
  })

  it('prints the follow-rate and the ignore-rate as numbers and the cases that missed, and writes them to the report', async () => {
    const { run, logs, files } = setup(labelsFor(['hold-01', 'hold-02']))

    await run()

    // A writer that follows every hint follows the follow case and walks into both ignore cases.
    expect(logs).toContain('Follow rate: 100.0%, ignore rate: 0.0% (not in the bar)')
    expect(logs).toContain('Missed: hold-01:cleanse:ignore, hold-02:cleanse:ignore')
    expect(JSON.parse(files.get('out/report.json')!).summary).toMatchObject({ followRate: 100, ignoreRate: 0, missed: ['hold-01:cleanse:ignore', 'hold-02:cleanse:ignore'] })
  })

  it('leaves out a case whose labels need re-making, and says which', async () => {
    const { run, memory, logs } = setup(labelsFor(['hold-01', 'hold-02']))
    const stale = labelsFor(['hold-01', 'hold-02'])
    stale.cases['hold-02']!.cleanse!.candidates = ['C-A', 'C-B']
    const second = setup(stale)

    await second.run()
    await run()

    expect(second.memory.calls).toHaveLength(2)
    expect(second.logs).toContain('Needs re-label (left out): hold-02')
    expect(memory.calls).toHaveLength(3)
    expect(logs.some((l) => l.startsWith('Needs re-label'))).toBe(false)
  })

  it('exits 2 and asks for nothing when no hint case can be built', async () => {
    const { run, memory, logs } = setup(labelsFor([]))

    expect((await run()).exitCode).toBe(2)
    expect(memory.calls).toEqual([])
    expect(logs.at(-1)).toMatch(/No hint case/)
  })

  it('stops and exits 2 when Claude refuses the key, counting the refused call as no result', async () => {
    const { run, memory, files } = setup(labelsFor(['hold-01']))
    memory.failNextWith(new AnthropicConfigError('SENTINEL'))

    const { exitCode } = await run()

    expect(exitCode).toBe(2)
    expect(memory.calls).toEqual([])
    expect(JSON.parse(files.get('out/report.json')!)).toMatchObject({ partial: true, results: [] })
  })

  it('goes on after a writer error, leaves that case without a result and calls the run partial', async () => {
    const { run, memory, files } = setup(labelsFor(['hold-01']))
    memory.failNextWith(new Error('SENTINEL'))

    const { exitCode } = await run()

    expect(exitCode).toBe(0)
    const report = JSON.parse(files.get('out/report.json')!)
    expect(report.partial).toBe(true)
    expect(report.results.map((r: { id: string }) => r.id)).toEqual(['hold-01:cleanse:ignore'])
    expect(files.get('out/report.json')).not.toContain('SENTINEL')
  })

  it('runs only the first N hint cases with --limit, and calls the run partial', async () => {
    const { run, memory, files } = setup(labelsFor(['hold-01', 'hold-02']), { limit: 1 })

    await run()

    expect(memory.calls).toHaveLength(1)
    expect(JSON.parse(files.get('out/report.json')!).partial).toBe(true)
  })
})
