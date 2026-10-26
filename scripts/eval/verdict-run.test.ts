import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AnthropicConfigError } from '../../src/providers/anthropic/anthropic.provider'
import type { FitRequest, FitResult } from '../../src/providers/verdict-fitting/verdict-fitter.provider'
import type { VerdictCase } from './verdict-cases'
import { caseLabelsOf, harness, helpingAll, labelOf, labelSetOf, linesOf, OUT, openIds, requestOf, requestShaOf, runDirOf, shaOf, SNAPSHOT_SHA, FIT_REASON } from './verdict-run.fixture'
import { BASE, caseOf, FIXTURE, FIXTURE_HOLDOUT, FIXTURE_MAIN, FIXTURE_REFERENCE, product } from './verdict.fixture'

// The orchestration of `npm run eval:verdict`, with the fit judge faked (MemoryVerdictFitter, wrapped so its calls spend on a REAL MemoryAiSpendLedger the way the
// script's client does), and the reference, labels, clock and disk handed in. Nothing here calls the API, reads a key or touches the disk. For each case the run does
// what VerdictService.build does (see verdict-run-parity.test.ts, which holds the two to the same answer): factsOf, assembleVerdictInputs, floorVerdicts, fitRequestOf
// (null: no call), the fit judge, mergeVerdict. Then it scores (verdict-score.ts), writes report.json and prints the console lines.
//
// Decisions this file pins (the brief left them open, or they differ from the obvious reading):
//   * A fit judge that throws (state `fit-error`) or whose answer cannot be merged (state `merge-error`) is handled as VerdictService.build handles it: the case is saved
//     with the floor-only merge (open products `undecided`) and the run goes on. The error is recorded by CLASS NAME in `error`, never its message.
//   * The spend cap and a rejected key are the only errors that end the run. The case whose call they stopped, and every case after it, is `cut-off`, and cut-off cases are
//     left out of every percentage. A cap stop is a TRIAL like routine's (bar `not evaluated (partial-run, ...)`, exit 0), and FAILs (exit 1) only when a rule fails
//     on the cases that finished. A rejected key is exit 2. (The brief said "exit 1 like routine" for the cap; routine's verified behaviour is exit 0 unless a rule fails.)
//   * `--floor-only` still builds each case's request and records it with its sha256 (a person labelling needs it) but never sends it: no fitter, no spend.
//   * The run's output directory is the PARENT: the report goes to <outDir>/verdict-<iso time, colons as dashes>/report.json, which is also what runVerdictEval returns.
//   * The console prints only ids, states, counts, scores and costs. For `holdout` it prints NO case id and no entry id at all: aggregates only. report.json always has them.
//
// Shapes assumed: see verdict-run.fixture.ts (the call, the result and the report).

const SENTINEL = 'SENTINEL-TEXT'
class FakeFitError extends Error {}

/** A fit answer that is helping for every open product, with a reason that must never reach the console. */
const sentinelHelping = (request: FitRequest): FitResult => ({ products: openIds(request).map((id) => ({ id, label: 'helping' as const, reason: `${SENTINEL} reason`, sameJobAs: null })), clashes: [] })

/** The clash of the retinoid and the acid: the judge settles it by naming `reduceId`, or leaves it to the floor. */
const clashAnswer =
  (reduceId: string | null) =>
  (_call: number, request: FitRequest): FitResult => ({
    ...helpingAll(request),
    clashes: reduceId === null ? [] : request.clashes.map(({ ids }) => ({ ids, reduceId })),
  })

const withExpectation = (c: VerdictCase, id: string, expected: VerdictCase['expect']['entries'][string]): VerdictCase => ({ ...c, expect: { ...c.expect, entries: { ...c.expect.entries, [id]: expected } } })

describe('runVerdictEval: one case at a time, the way VerdictService.build does it', () => {
  it('asks the fit judge once for each case that has an open product or a clash, and never for a shelf the floor settled', async () => {
    const { run, inner } = harness({ cases: [FIXTURE.mercury, FIXTURE.reactionProduct, FIXTURE.retinoidAcidClash] })

    await run()

    expect(inner.calls).toHaveLength(2)
  })

  it('sends the request the real app would send: every skin product, the floor\'s status on each, and the clash pairs', async () => {
    const { run, inner } = harness({ cases: [FIXTURE.reactionProduct, FIXTURE.retinoidAcidClash] })

    await run()

    expect(inner.calls[0]!.shelf.map((p) => [p.id, p.floor])).toEqual([
      ['calm-cream', { status: 'fixed', group: 'likely-the-problem' }],
      ['other-cream', { status: 'open' }],
    ])
    expect(inner.calls[0]).toEqual(requestOf(FIXTURE.reactionProduct))
    expect(inner.calls[1]!.clashes).toEqual([{ ids: ['retinol-serum', 'acid-toner'], groups: ['retinoid', 'exfoliating-acid'] }])
    expect(inner.calls[1]).toEqual(requestOf(FIXTURE.retinoidAcidClash))
  })

  it('makes the output directory before anything is spent, so a directory that cannot be made stops the run while it is free', async () => {
    const { run, events, dirs } = harness()

    await run()

    expect(events[0]).toBe('mkdir')
    expect(dirs).toContain(runDirOf(BASE))
  })

  it('merges the judge\'s answer with the floor\'s: the floor\'s label stands for a product it decided, the judge\'s for one it left open', async () => {
    const { run } = harness({ cases: [FIXTURE.reactionProduct] })

    const { report } = await run()

    expect(report.cases[0]!.products!.map(({ entryId, group, verdict, escalate }) => ({ entryId, group, verdict, escalate }))).toEqual([
      { entryId: 'calm-cream', group: 'likely-the-problem', verdict: { kind: 'drop' }, escalate: false },
      { entryId: 'other-cream', group: 'helping', verdict: { kind: 'keep' }, escalate: false },
    ])
    expect(report.cases[0]!.products![1]!.reason).toBe(FIT_REASON)
  })

  it('reduces the product of a clashing pair that the judge names, and the floor\'s tie-break when it names none', async () => {
    const named = await harness({ cases: [FIXTURE.retinoidAcidClash], answer: clashAnswer('retinol-serum') }).run()
    const unnamed = await harness({ cases: [FIXTURE.retinoidAcidClash], answer: clashAnswer(null) }).run()

    const reducedIn = (products: { entryId: string; verdict: { kind: string } }[]) => products.filter((p) => p.verdict.kind === 'reduce').map((p) => p.entryId)
    expect(reducedIn(named.report.cases[0]!.products!)).toEqual(['retinol-serum'])
    // The floor reduces the exfoliating acid before the retinoid.
    expect(reducedIn(unnamed.report.cases[0]!.products!)).toEqual(['acid-toner'])
  })

  it('merges with the profile\'s safety choices, as the service does: a stopped steroid cream is worded with the prescriber\'s note only for a person who ticked prescription', async () => {
    const steroidWith = (choices: ('none' | 'prescription')[]): VerdictCase => ({ ...FIXTURE.steroid, safety: { choices, mentions: [] } })
    const plain = await harness({ cases: [steroidWith(['none'])] }).run()
    const prescribed = await harness({ cases: [steroidWith(['prescription'])] }).run()

    const reasonOf = (report: { cases: { products: { reason: string }[] | null }[] }) => report.cases[0]!.products![0]!.reason
    expect(reasonOf(prescribed.report).startsWith(reasonOf(plain.report))).toBe(true)
    expect(reasonOf(prescribed.report).length).toBeGreaterThan(reasonOf(plain.report).length)
  })
})

describe('runVerdictEval: what each case records', () => {
  it('records the floor, the request and its sha256, the judge\'s raw answer, the merged products, the cost and the expectation', async () => {
    const { run } = harness({ cases: [FIXTURE.reactionProduct] })

    const { report } = await run()

    const recorded = report.cases[0]!
    const request = requestOf(FIXTURE.reactionProduct)!
    expect(recorded.id).toBe('main-09')
    expect(recorded.state).toBe('done')
    expect(recorded.error).toBeUndefined()
    expect(recorded.expect).toEqual(FIXTURE.reactionProduct.expect)
    expect(recorded.floor!.entries.map((e) => [e.id, e.status])).toEqual([
      ['calm-cream', 'fixed'],
      ['other-cream', 'open'],
    ])
    expect(recorded.fitRequest).toEqual(request)
    expect(recorded.requestSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(recorded.requestSha256).toBe(shaOf(request))
    expect(recorded.requestSha256).toBe(requestShaOf(FIXTURE.reactionProduct))
    expect(recorded.fit).toEqual(helpingAll(request))
    expect(recorded.costMicros).toBe(1000)
  })

  it('records no request, no sha and no cost for a case the floor settled whole, and still its floor and its products', async () => {
    const { run, inner } = harness({ cases: [FIXTURE.mercury] })

    const { report } = await run()

    expect(inner.calls).toHaveLength(0)
    expect(report.cases[0]).toMatchObject({ id: 'main-01', state: 'done', fitRequest: null, requestSha256: null, fit: null, costMicros: 0 })
    expect(report.cases[0]!.floor!.entries.map((e) => [e.id, e.status])).toEqual([['mercury-cream', 'fixed']])
    expect(report.cases[0]!.products!.map(({ entryId, group, verdict, escalate }) => ({ entryId, group, verdict, escalate }))).toEqual([{ entryId: 'mercury-cream', group: 'likely-the-problem', verdict: { kind: 'drop' }, escalate: true }])
  })

  it('records the judge\'s raw answer as it came, not as the merge applied it', async () => {
    const { run } = harness({ cases: [FIXTURE.retinoidAcidClash], answer: clashAnswer('retinol-serum') })

    const { report } = await run()

    const request = requestOf(FIXTURE.retinoidAcidClash)!
    // Both products are helping in the raw answer; the merge reduced one of them.
    expect(report.cases[0]!.fit!.products.map((p) => [p.id, p.label])).toEqual([
      ['retinol-serum', 'helping'],
      ['acid-toner', 'helping'],
    ])
    expect(report.cases[0]!.fit!.clashes).toEqual([{ ids: request.clashes[0]!.ids, reduceId: 'retinol-serum' }])
    expect(report.cases[0]!.products!.find((p) => p.entryId === 'retinol-serum')!.group).toBe('conflicting')
  })
})

describe('runVerdictEval: --floor-only', () => {
  it('sends nothing to any judge and spends nothing, and the open products are undecided, as the service leaves them while the judge has not answered', async () => {
    const { run, inner, ledger, events } = harness({ cases: [FIXTURE.reactionProduct], floorOnly: true })

    const { report } = await run()

    expect(inner.calls).toHaveLength(0)
    expect(events).not.toContain('fit')
    expect(ledger.entries).toHaveLength(0)
    expect(report.floorOnly).toBe(true)
    expect(report.cases[0]).toMatchObject({ state: 'done', fit: null, costMicros: 0 })
    expect(report.cases[0]!.products!.map((p) => [p.entryId, p.group, p.verdict])).toEqual([
      ['calm-cream', 'likely-the-problem', { kind: 'drop' }],
      ['other-cream', 'undecided', { kind: 'keep' }],
    ])
  })

  it('still builds and records the request and its sha256, which is what a person labels against', async () => {
    const { run } = harness({ cases: [FIXTURE.reactionProduct], floorOnly: true })

    const { report } = await run()

    expect(report.cases[0]!.fitRequest).toEqual(requestOf(FIXTURE.reactionProduct))
    expect(report.cases[0]!.requestSha256).toBe(requestShaOf(FIXTURE.reactionProduct))
  })

  it('has no model or prompt to name in the report', async () => {
    const { run } = harness({ floorOnly: true })

    const { report } = await run()

    expect(report.model).toBeNull()
    expect(report.promptHash).toBeNull()
  })

  it('gets every one of the 12 main fixture shelves right with the real floor, and is a trial that only says there was no fit run (exit 0)', async () => {
    const { run, logs } = harness({ cases: FIXTURE_MAIN, floorOnly: true })

    const { report, exitCode } = await run()

    expect(report.summary.floor).toEqual({ accuracy: 100, missed: [] })
    expect(report.summary.bar).toEqual({ status: 'not-evaluated', reasons: ['no-fit-run'] })
    expect(logs.at(-1)).toBe('Bar: not evaluated (no-fit-run)')
    expect(exitCode).toBe(0)
  })

  it('FAILs the bar, exit 1, when the floor missed what a case expects, whatever else is missing', async () => {
    const wrong = withExpectation(FIXTURE.reactionProduct, 'calm-cream', { outcome: 'fixed', group: 'conflicting', verdict: 'drop' })
    const { run, logs } = harness({ cases: [wrong], floorOnly: true })

    const { report, exitCode } = await run()

    expect(report.summary.floor.missed).toEqual(['main-09'])
    expect(logs.at(-1)).toBe('Bar: FAIL (floor; not evaluated: no-fit-run)')
    expect(exitCode).toBe(1)
  })
})

describe('runVerdictEval: a fit judge that fails, and an answer that cannot be merged', () => {
  it('records a judge that threw as fit-error with its class name only, keeps the cost of the failed call, saves the floor-only merge and goes on to the next case', async () => {
    const { run, inner, logs } = harness({ cases: [FIXTURE.reactionProduct, FIXTURE.reactionIngredient] })
    inner.failNextWith(new FakeFitError(SENTINEL))

    const { report, exitCode } = await run()

    expect(report.cases.map((c) => c.state)).toEqual(['fit-error', 'done'])
    expect(report.cases[0]).toMatchObject({ error: 'FakeFitError', fit: null, costMicros: 1000 })
    expect(report.cases[0]!.products!.map((p) => [p.entryId, p.group])).toEqual([
      ['calm-cream', 'likely-the-problem'],
      ['other-cream', 'undecided'],
    ])
    expect(report.cases[1]!.error).toBeUndefined()
    expect(logs.join('\n')).not.toContain(SENTINEL)
    expect(JSON.stringify(report)).not.toContain(SENTINEL)
    // A judge that failed is the judge's trouble, not the floor's: nothing here fails the bar by itself.
    expect(exitCode).toBe(0)
  })

  it('counts the open products of a fit-error case as not agreed with their labels, and never as harmful', async () => {
    const labels = labelSetOf([caseLabelsOf(FIXTURE.reactionProduct, { 'other-cream': labelOf('blocking') })])
    const { run, inner } = harness({ cases: [FIXTURE.reactionProduct], labels })
    inner.failNextWith(new FakeFitError(SENTINEL))

    const { report } = await run()

    expect(report.summary.fit).toMatchObject({ count: 0, total: 1, rate: 0 })
    expect(report.summary.harmful).toMatchObject({ count: 0, total: 1 })
  })

  it('records an answer that cannot be merged as merge-error, with the answer, the error\'s class name and the floor-only merge, fails the floor rule (exit 1) and goes on', async () => {
    const unmergeable = (_call: number, request: FitRequest): FitResult | undefined =>
      _call === 1 ? { products: openIds(request).map((id) => ({ id, label: 'redundant' as const, reason: FIT_REASON, sameJobAs: 'ghost' })), clashes: [] } : undefined
    const { run, logs } = harness({ cases: [FIXTURE.reactionProduct, FIXTURE.reactionIngredient], answer: unmergeable })

    const { report, exitCode } = await run()

    expect(report.cases.map((c) => c.state)).toEqual(['merge-error', 'done'])
    expect(report.cases[0]!.error).toBe('Error')
    expect(report.cases[0]!.fit!.products).toEqual([{ id: 'other-cream', label: 'redundant', reason: FIT_REASON, sameJobAs: 'ghost' }])
    expect(report.cases[0]!.products!.find((p) => p.entryId === 'other-cream')!.group).toBe('undecided')
    expect(report.summary.floor.missed).toEqual(['main-09'])
    expect(logs.at(-1)).toMatch(/^Bar: FAIL \(floor/)
    expect(exitCode).toBe(1)
  })
})

describe('runVerdictEval: the spend cap and a rejected key', () => {
  // The cap is 2500 and each call costs 1000: calls 1 and 2 fit (2000), and the reservation for call 3 would make 3000.
  const THREE = [FIXTURE.reactionProduct, FIXTURE.reactionIngredient, FIXTURE.retinoidAcidClash]

  it('stops at the cap: the case it stopped and those after it are cut off and never reach the judge, and the run is a trial that exits 0', async () => {
    const { run, inner, logs } = harness({ cases: THREE, capMicros: 2500 })

    const { report, exitCode } = await run()

    expect(report.cases.map((c) => c.state)).toEqual(['done', 'done', 'cut-off'])
    expect(inner.calls).toHaveLength(2)
    expect(report.partial).toBe(true)
    expect(report.summary.costMicros).toBe(2000)
    expect(logs.join('\n')).toMatch(/spend cap/i)
    expect(logs.at(-1)).toMatch(/^Bar: not evaluated \(.*partial-run.*\)$/)
    expect(report.summary.bar.reasons).toContain('partial-run')
    expect(exitCode).toBe(0)
  })

  it('leaves the cut-off cases out of every percentage: they are not counted as failed cases', async () => {
    const { run } = harness({ cases: THREE, capMicros: 2500 })

    const { report } = await run()

    expect(report.summary.cases).toBe(2)
    expect(report.summary.floor).toEqual({ accuracy: 100, missed: [] })
  })

  it('does not stop when the cases cost exactly the cap: 3 calls of 1000 fit a cap of 3000 and the run is whole', async () => {
    const { run } = harness({ cases: THREE, capMicros: 3000 })

    const { report } = await run()

    expect(report.cases.map((c) => c.state)).toEqual(['done', 'done', 'done'])
    expect(report.partial).toBe(false)
  })

  it('is still a FAIL, exit 1, when a case that finished missed the floor: a trial can fail, it cannot pass', async () => {
    const wrong = withExpectation(FIXTURE.reactionProduct, 'calm-cream', { outcome: 'fixed', group: 'conflicting', verdict: 'drop' })
    const { run, logs } = harness({ cases: [wrong, FIXTURE.reactionIngredient, FIXTURE.retinoidAcidClash], capMicros: 2500 })

    const { exitCode } = await run()

    expect(exitCode).toBe(1)
    expect(logs.at(-1)).toMatch(/^Bar: FAIL \(floor; not evaluated: .*partial-run.*\)$/)
  })

  it('writes the report of a cut-off run', async () => {
    const { run, files } = harness({ cases: THREE, capMicros: 2500 })

    const { reportPath } = await run()

    expect(files.has(reportPath)).toBe(true)
  })

  it('stops for good when Claude rejects the key: exit 2, nothing more is asked, the rest are cut off, and the message never reaches the console', async () => {
    const rejected = (call: number): FitResult | undefined => {
      if (call === 2) throw new AnthropicConfigError(SENTINEL)
      return undefined
    }
    const { run, events, logs } = harness({ cases: THREE, answer: rejected })

    const { report, exitCode } = await run()

    expect(exitCode).toBe(2)
    expect(events.filter((e) => e === 'fit')).toHaveLength(2)
    expect(report.cases.map((c) => c.state)).toEqual(['done', 'cut-off', 'cut-off'])
    expect(report.partial).toBe(true)
    expect(logs.join('\n')).toMatch(/key/i)
    expect(logs.join('\n')).not.toContain(SENTINEL)
  })
})

describe('runVerdictEval: --limit', () => {
  it('runs only the first N cases, and a run of the first N is a trial: it can fail the bar but never pass it', async () => {
    const { run, inner, logs } = harness({ cases: [FIXTURE.reactionProduct, FIXTURE.reactionIngredient, FIXTURE.retinoidAcidClash], limit: 2 })

    const { report, exitCode } = await run()

    expect(inner.calls).toHaveLength(2)
    expect(report.cases.map((c) => c.id)).toEqual(['main-09', 'main-10'])
    expect(report.partial).toBe(true)
    expect(report.summary.bar.reasons).toContain('partial-run')
    expect(logs.at(-1)).toMatch(/^Bar: not evaluated \(.*partial-run.*\)$/)
    expect(exitCode).toBe(0)
  })

  it('is not partial when the limit is the size of the set', async () => {
    const { run } = harness({ cases: [FIXTURE.reactionProduct, FIXTURE.reactionIngredient], limit: 2 })

    const { report } = await run()

    expect(report.partial).toBe(false)
  })
})

describe('runVerdictEval: the fit scored against labels', () => {
  const labelled = (said: 'helping' | 'blocking', labelled: 'helping' | 'blocking') => {
    const labels = labelSetOf([caseLabelsOf(FIXTURE.reactionProduct, { 'other-cream': labelOf(labelled) })])
    const answer = (_call: number, request: FitRequest): FitResult => ({ products: openIds(request).map((id) => ({ id, label: said, reason: FIT_REASON, sameJobAs: null })), clashes: [] })
    return harness({ cases: [FIXTURE.reactionProduct], labels, answer })
  }

  it('agrees when the judge says what the label says', async () => {
    const { run } = labelled('helping', 'helping')

    const { report } = await run()

    expect(report.summary.fit).toMatchObject({ count: 1, total: 1, rate: 100 })
    expect(report.labelVersion).toBe('v1')
  })

  it('disagrees, and is harmful, when the judge calls helping a product the label says is blocking', async () => {
    const { run } = labelled('helping', 'blocking')

    const { report } = await run()

    expect(report.summary.fit).toMatchObject({ count: 0, total: 1, rate: 0 })
    expect(report.summary.harmful).toMatchObject({ count: 1, total: 1, rate: 100 })
  })

  it('lists a case whose labels were made on another request as needing a re-label, and scores nothing of its fit', async () => {
    const labels = labelSetOf([caseLabelsOf(FIXTURE.reactionProduct, { 'other-cream': labelOf('helping') }, { requestSha256: '0'.repeat(64) })])
    const { run } = harness({ cases: [FIXTURE.reactionProduct], labels })

    const { report } = await run()

    expect(report.summary.needsRelabel).toEqual(['main-09'])
    expect(report.summary.fit.total).toBe(0)
    expect(report.summary.bar.reasons).toContain('needs-relabel')
  })

  it('has no labels in the report when the run had none', async () => {
    const { run } = harness()

    const { report } = await run()

    expect(report.labelVersion).toBeNull()
    expect(report.summary.fit).toMatchObject({ total: 0, rate: null })
    expect(report.summary.bar.reasons).toContain('no-labels')
  })
})

describe('runVerdictEval: report.json', () => {
  it('is written, once, to <out-dir>/verdict-<time with no colon>/report.json, and that path is returned', async () => {
    const { run, files } = harness()

    const { reportPath } = await run()

    expect(reportPath).toBe(join(runDirOf(BASE), 'report.json'))
    expect(reportPath).not.toContain(':')
    expect(reportPath.startsWith(`${OUT}/verdict-`)).toBe(true)
    expect([...files.keys()]).toEqual([reportPath])
  })

  it('says what the run was: when, which set, which snapshot and labels, the judge\'s model and prompt, the cap and the step-down templates the floor used', async () => {
    const labels = labelSetOf([caseLabelsOf(FIXTURE.reactionProduct, { 'other-cream': labelOf('helping') })], { version: 'v7' })
    const { run, ledger, fitter } = harness({ labels })

    const { report } = await run()

    expect(report).toMatchObject({
      startedAt: BASE.toISOString(),
      set: 'main',
      floorOnly: false,
      partial: false,
      snapshotSha256: SNAPSHOT_SHA,
      labelVersion: 'v7',
      model: fitter.identity.model,
      promptHash: fitter.identity.promptHash,
      capMicros: ledger.capMicros,
      tapers: FIXTURE_REFERENCE.tapers,
    })
  })

  it('totals what the run spent and says so on the console', async () => {
    const { run, ledger, logs } = harness({ cases: [FIXTURE.reactionProduct, FIXTURE.reactionIngredient] })

    const { report } = await run()

    expect(report.summary.costMicros).toBe(2000)
    expect(ledger.spentMicros()).toBe(2000)
    expect(logs.some((line) => /^Spent \$0\.0020 of the \$/.test(line))).toBe(true)
  })
})

describe('runVerdictEval: the console prints ids, counts, scores and costs, and nothing a person or a model wrote', () => {
  const SECRETS = ['SENTINEL-BRAND', 'SENTINEL-NAME', 'SENTINEL-RATIONALE', SENTINEL]
  const sentinelCase = caseOf('main-20', {
    shelf: [product('s-cream', { brand: 'SENTINEL-BRAND', name: 'SENTINEL-NAME', ingredients: ['Aqua', 'Squalane'] })],
    expect: { entries: { 's-cream': { outcome: 'open' } }, clashes: [] },
  })

  it('prints one line for each case on the main set, led by its id and saying its state, and no word of the fit judge, the labels or the shelf', async () => {
    const cases = [FIXTURE.reactionProduct, sentinelCase, FIXTURE.mercury]
    const labels = labelSetOf([caseLabelsOf(sentinelCase, { 's-cream': labelOf('helping') })])
    const { run, logs, inner } = harness({ cases, labels, answer: (_call, request) => sentinelHelping(request) })
    inner.failNextWith(new FakeFitError(SENTINEL))

    await run()

    for (const [id, state] of [['main-09', 'fit-error'], ['main-20', 'done'], ['main-01', 'done']] as const) {
      const lines = linesOf(logs, id)
      expect(lines, id).toHaveLength(1)
      expect(lines[0], id).toContain(state)
      expect(lines[0], id).toContain('$')
    }
    for (const secret of SECRETS) expect(logs.join('\n'), secret).not.toContain(secret)
  })

  it('prints no case id and no entry id at all for the holdout: aggregates only, however many cases failed or need a re-label', async () => {
    const wrong = withExpectation(FIXTURE.unresolvedMention, 'fine-cream', { outcome: 'fixed', group: 'conflicting', verdict: 'drop' })
    const labels = labelSetOf([caseLabelsOf(FIXTURE.retinoidAcidClash, { 'retinol-serum': labelOf('helping'), 'acid-toner': labelOf('helping') }, { requestSha256: '0'.repeat(64) })])
    const { run, logs } = harness({ cases: [wrong, FIXTURE.nonSkin, FIXTURE.retinoidAcidClash], set: 'holdout', labels, answer: (_call, request) => sentinelHelping(request) })

    const { report } = await run()

    const printed = logs.join('\n')
    for (const id of ['hold-01', 'hold-02', 'hold-03', 'fine-cream', 'face-cream', 'edge-pomade', 'retinol-serum', 'acid-toner']) expect(printed, id).not.toContain(id)
    for (const secret of SECRETS) expect(printed, secret).not.toContain(secret)
    // What the console leaves out is not lost: the report names them.
    expect(report.summary.floor.missed).toEqual(['hold-01'])
    expect(report.summary.needsRelabel).toEqual(['hold-03'])
    expect(report.cases.map((c) => c.id)).toEqual(['hold-01', 'hold-02', 'hold-03'])
  })

  it('still says the scores, the cost and the bar for the holdout, and ends on the bar line', async () => {
    const { run, logs } = harness({ cases: FIXTURE_HOLDOUT, set: 'holdout' })

    await run()

    expect(logs.some((line) => /set holdout/.test(line))).toBe(true)
    expect(logs.some((line) => /^Spent \$/.test(line))).toBe(true)
    expect(logs.some((line) => /floor/i.test(line))).toBe(true)
    expect(logs.at(-1)).toMatch(/^Bar: /)
  })

  it('ends on the bar line for the main set, too, with the report\'s path on the line before the closing summary lines', async () => {
    const { run, logs } = harness({ cases: [FIXTURE.reactionProduct] })

    const { reportPath } = await run()

    expect(logs.some((line) => line.includes(reportPath))).toBe(true)
    expect(logs.at(-1)).toMatch(/^Bar: /)
  })
})
