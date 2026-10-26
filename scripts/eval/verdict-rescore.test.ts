import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { VerdictCase } from './verdict-cases'
import type { LabelSet } from './verdict-labels'
import { readVerdictReport, runVerdictRescore, VerdictReportError } from './verdict-rescore'
import { caseLabelsOf, harness, labelOf, labelSetOf, OUT, type Report, runDirOf } from './verdict-run.fixture'
import { BASE, dayAt, FIXTURE } from './verdict.fixture'

// `npm run eval:verdict:rescore`: a report written by `eval:verdict` already holds, for each case, the floor's answer, the request the judge was asked, its raw
// answer and the merged products, so scoring them against ANOTHER version of the labels costs nothing: no key, no judge, no ledger. The floor part of the score
// does not depend on the labels, so it is kept whatever the labels say; the fit part is refused for a case whose saved request is not the one its new labels were made for.
//
// Shapes assumed (the contract this file pins):
//   readVerdictReport(path): Promise<SavedVerdictReport>        throws VerdictReportError (a message that names the path and never quotes the file) when the file is
//                                                               missing, is not JSON, or is not a report written by eval:verdict
//   runVerdictRescore({ report, reportPath, labels, startedAt, outDir, io }): Promise<{ exitCode: number; reportPath: string }>
//     NO fitter, NO ledger and no key: a rescore has nothing to call. It scores the saved cases (`scoreVerdictRun`, with the saved set, floorOnly, partial and tapers) against
//     `labels` and writes <outDir>/verdict-rescore-<startedAt, colons as dashes>/report.json: the saved cases unchanged, the header of the source (set, floorOnly, partial,
//     snapshotSha256, model, promptHash, tapers) with labelVersion of the new labels, `source: { report: reportPath, startedAt: <the source's> }`, `mode: 'rescore'`, and a
//     new summary whose costMicros is 0 (it spent nothing). The console and exit code are the run's: ids only on the main set, aggregates only on the holdout, the bar
//     line last, exit 1 only for a FAIL.

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'verdict-rescore-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const THREE = [FIXTURE.reactionProduct, FIXTURE.reactionIngredient, FIXTURE.retinoidAcidClash]
const CLASH = { ids: ['retinol-serum', 'acid-toner'] as [string, string], reduce: 'either' }

/** Labels that agree with a judge who calls every open product helping. */
const labelsV1 = (): LabelSet =>
  labelSetOf([
    caseLabelsOf(FIXTURE.reactionProduct, { 'other-cream': labelOf('helping') }),
    caseLabelsOf(FIXTURE.reactionIngredient, { 'plain-wash': labelOf('helping') }),
    caseLabelsOf(FIXTURE.retinoidAcidClash, { 'retinol-serum': labelOf('helping'), 'acid-toner': labelOf('helping') }, { clashes: [CLASH] }),
  ])

const withExpectation = (c: VerdictCase, id: string, expected: VerdictCase['expect']['entries'][string]): VerdictCase => ({ ...c, expect: { ...c.expect, entries: { ...c.expect.entries, [id]: expected } } })

/** The report of a real run of the harness, saved to a file the way the CLI saves it. */
const savedRun = async (options: Parameters<typeof harness>[0] = {}) => {
  const { run, files } = harness({ cases: THREE, labels: labelsV1(), ...options })
  const result = await run()
  const path = join(dir, 'source-report.json')
  await writeFile(path, files.get(result.reportPath)!)
  return { ...result, path, text: files.get(result.reportPath)! }
}

const rescoreWith = async (source: { path: string }, labels: LabelSet, startedAt = dayAt(1)) => {
  const logs: string[] = []
  const dirs: string[] = []
  const files = new Map<string, string>()
  const report = await readVerdictReport(source.path)
  const result = await runVerdictRescore({
    report,
    reportPath: source.path,
    labels,
    startedAt,
    outDir: OUT,
    io: { log: (line: string) => logs.push(line), mkdir: async (d: string) => void dirs.push(d), writeFile: async (p: string, text: string) => void files.set(p, text) },
  })
  return { ...result, logs, dirs, files, report: JSON.parse(files.get(result.reportPath)!) as Report & { source: { report: string; startedAt: string }; mode: string } }
}

describe('runVerdictRescore: scoring a saved run again', () => {
  it('gives the very scores the run gave when the labels are the ones it was scored against', async () => {
    const source = await savedRun()

    const { report } = await rescoreWith(source, labelsV1())

    expect(report.summary).toEqual({ ...source.report.summary, costMicros: 0 })
    expect(report.summary.fit).toEqual({ count: 4, total: 4, rate: 100 })
  })

  it('scores the saved answers against the other labels: the judge said helping, and the new labels say blocking', async () => {
    const source = await savedRun()
    const v2 = labelSetOf(
      [
        caseLabelsOf(FIXTURE.reactionProduct, { 'other-cream': labelOf('blocking') }),
        caseLabelsOf(FIXTURE.reactionIngredient, { 'plain-wash': labelOf('helping') }),
        caseLabelsOf(FIXTURE.retinoidAcidClash, { 'retinol-serum': labelOf('helping'), 'acid-toner': labelOf('helping') }, { clashes: [CLASH] }),
      ],
      { version: 'v2' },
    )

    const { report } = await rescoreWith(source, v2)

    expect(report.labelVersion).toBe('v2')
    expect(report.summary.fit).toEqual({ count: 3, total: 4, rate: 75 })
    expect(report.summary.harmful).toEqual({ count: 1, total: 1, rate: 100 })
    expect(report.summary.bar).toMatchObject({ status: 'fail', rules: expect.arrayContaining(['fit-agreement', 'harmful']) })
  })

  it('exits 1 when the new labels make a rule fail, and prints the bar line last', async () => {
    const source = await savedRun()
    const v2 = labelSetOf([caseLabelsOf(FIXTURE.reactionProduct, { 'other-cream': labelOf('blocking') })], { version: 'v2' })

    const { exitCode, logs } = await rescoreWith(source, v2)

    expect(exitCode).toBe(1)
    expect(logs.at(-1)).toMatch(/^Bar: FAIL \(.*harmful.*\)$/)
  })

  it('refuses the fit part for a case whose saved request is not the one its new labels were made for, and keeps the floor part', async () => {
    // The first case has a floor miss, saved in the run; the other two are right.
    const wrong = withExpectation(FIXTURE.reactionProduct, 'calm-cream', { outcome: 'fixed', group: 'conflicting', verdict: 'drop' })
    const source = await savedRun({ cases: [wrong, FIXTURE.reactionIngredient, FIXTURE.retinoidAcidClash] })
    const v2 = labelSetOf(
      [
        caseLabelsOf(FIXTURE.reactionProduct, { 'other-cream': labelOf('blocking') }, { requestSha256: '0'.repeat(64) }),
        caseLabelsOf(FIXTURE.reactionIngredient, { 'plain-wash': labelOf('helping') }),
        caseLabelsOf(FIXTURE.retinoidAcidClash, { 'retinol-serum': labelOf('helping'), 'acid-toner': labelOf('helping') }, { clashes: [CLASH] }),
      ],
      { version: 'v2' },
    )

    const { report } = await rescoreWith(source, v2)

    expect(report.summary.needsRelabel).toEqual(['main-09'])
    // The stale case's open product (which the new labels would have called harmful) is not scored; the other cases' three are.
    expect(report.summary.fit).toEqual({ count: 3, total: 3, rate: 100 })
    expect(report.summary.harmful.count).toBe(0)
    // The floor part is kept: the miss the run saw is still there.
    expect(report.summary.floor.missed).toEqual(['main-09'])
    expect(report.summary.bar).toMatchObject({ status: 'fail', rules: ['floor'], notEvaluated: expect.arrayContaining(['needs-relabel']) })
  })

  it('scores a case with no labels in the new version as having none, without failing', async () => {
    const source = await savedRun()
    const v2 = labelSetOf([caseLabelsOf(FIXTURE.reactionProduct, { 'other-cream': labelOf('helping') })], { version: 'v2' })

    const { report } = await rescoreWith(source, v2)

    expect(report.summary.fit).toEqual({ count: 1, total: 1, rate: 100 })
    expect(report.summary.bar.status).toBe('not-evaluated')
    expect(report.summary.bar.reasons).toContain('no-labels')
  })
})

describe('runVerdictRescore: it costs nothing and says what it came from', () => {
  it('spends nothing, however much the source run spent, and says so', async () => {
    const source = await savedRun()
    expect(source.report.summary.costMicros).toBe(3000)

    const { report, logs } = await rescoreWith(source, labelsV1())

    expect(report.summary.costMicros).toBe(0)
    expect(logs.some((line) => /^Spent \$0\.0000/.test(line))).toBe(true)
    // What each case cost the run that made it is carried over unchanged.
    expect(report.cases.map((c) => c.costMicros)).toEqual([1000, 1000, 1000])
  })

  it('carries the saved cases over unchanged: the floor, the request and its sha, the judge\'s raw answer and the merged products', async () => {
    const source = await savedRun()

    const { report } = await rescoreWith(source, labelsV1())

    expect(report.cases).toEqual(source.report.cases)
  })

  it('names its source and its mode, the labels it scored against, and the source\'s own header', async () => {
    const source = await savedRun()

    const { report } = await rescoreWith(source, labelsV1())

    expect(report).toMatchObject({
      mode: 'rescore',
      source: { report: source.path, startedAt: BASE.toISOString() },
      startedAt: dayAt(1).toISOString(),
      labelVersion: 'v1',
      set: 'main',
      floorOnly: false,
      partial: false,
      snapshotSha256: source.report.snapshotSha256,
      model: source.report.model,
      promptHash: source.report.promptHash,
      tapers: source.report.tapers,
    })
  })

  it('writes one report, to <out-dir>/verdict-rescore-<time with no colon>/report.json, makes the directory first, and leaves the source alone', async () => {
    const source = await savedRun()

    const { reportPath, files, dirs } = await rescoreWith(source, labelsV1())

    expect(reportPath).toBe(join(runDirOf(dayAt(1), 'verdict-rescore'), 'report.json'))
    expect(reportPath).not.toContain(':')
    expect([...files.keys()]).toEqual([reportPath])
    expect(dirs).toContain(runDirOf(dayAt(1), 'verdict-rescore'))
    expect(await readFile(source.path, 'utf8')).toBe(source.text)
  })
})

describe('runVerdictRescore: what it inherits from the saved run', () => {
  it('stays a trial when the saved run was one: a run cut off at the spend cap is not made whole by new labels', async () => {
    const source = await savedRun({ capMicros: 2500 })
    expect(source.report.partial).toBe(true)

    const { report, exitCode } = await rescoreWith(source, labelsV1())

    expect(report.partial).toBe(true)
    expect(report.cases.map((c) => c.state)).toEqual(['done', 'done', 'cut-off'])
    expect(report.summary.bar.reasons).toContain('partial-run')
    expect(exitCode).toBe(0)
  })

  it('has no fit to score when the saved run was floor-only, whatever labels it is given, and says no-fit-run', async () => {
    const source = await savedRun({ floorOnly: true, labels: null })

    const { report, exitCode } = await rescoreWith(source, labelsV1())

    expect(report.floorOnly).toBe(true)
    expect(report.summary.fit).toEqual({ count: 0, total: 0, rate: null })
    expect(report.summary.bar).toEqual({ status: 'not-evaluated', reasons: ['no-fit-run'] })
    expect(exitCode).toBe(0)
  })

  it('still says only no-fit-run for a floor-only report given labels made for another request: no fit is scored, so there is nothing to re-label', async () => {
    const source = await savedRun({ floorOnly: true, labels: null })
    const v2 = labelSetOf([caseLabelsOf(FIXTURE.reactionProduct, { 'other-cream': labelOf('helping') }, { requestSha256: '0'.repeat(64) })], { version: 'v2' })

    const { report } = await rescoreWith(source, v2)

    expect(report.summary.bar).toEqual({ status: 'not-evaluated', reasons: ['no-fit-run'] })
  })

  it('fails the floor rule with the floor misses the saved run had, exit 1', async () => {
    const wrong = withExpectation(FIXTURE.reactionIngredient, 'scented-wash', { outcome: 'open' })
    const source = await savedRun({ cases: [FIXTURE.reactionProduct, wrong], labels: null })

    const { report, exitCode } = await rescoreWith(source, labelsV1())

    expect(report.summary.floor.missed).toEqual(['main-10'])
    expect(exitCode).toBe(1)
  })

  it('counts the open products of a case whose judge failed as not agreed with the new labels, as the run did', async () => {
    const labels = labelSetOf([caseLabelsOf(FIXTURE.reactionProduct, { 'other-cream': labelOf('helping') })], { version: 'v2' })
    const { run, files, inner } = harness({ cases: [FIXTURE.reactionProduct], labels })
    inner.failNextWith(new Error('the fit judge is unavailable'))
    const result = await run()
    const path = join(dir, 'fit-error-report.json')
    await writeFile(path, files.get(result.reportPath)!)

    const { report } = await rescoreWith({ path }, labels)

    expect(report.cases[0]!.state).toBe('fit-error')
    expect(report.summary.fit).toEqual({ count: 0, total: 1, rate: 0 })
  })
})

describe('runVerdictRescore: the console', () => {
  it('prints a line for each case on the main set, led by its id, and the bar last', async () => {
    const source = await savedRun()

    const { logs } = await rescoreWith(source, labelsV1())

    for (const id of ['main-09', 'main-10', 'hold-03']) expect(logs.filter((line) => line.startsWith(id)), id).toHaveLength(1)
    expect(logs.at(-1)).toMatch(/^Bar: /)
  })

  it('prints no case id and no entry id for a holdout run: aggregates only', async () => {
    const holdout = [FIXTURE.unresolvedMention, FIXTURE.retinoidAcidClash]
    const source = await savedRun({ cases: holdout, set: 'holdout', labels: null })
    const v2 = labelSetOf([caseLabelsOf(FIXTURE.retinoidAcidClash, { 'retinol-serum': labelOf('helping'), 'acid-toner': labelOf('helping') }, { requestSha256: '0'.repeat(64) })], { version: 'v2' })

    const { logs, report } = await rescoreWith(source, v2)

    const printed = logs.join('\n')
    for (const id of ['hold-01', 'hold-03', 'fine-cream', 'retinol-serum', 'acid-toner', 'SENTINEL']) expect(printed, id).not.toContain(id)
    expect(report.summary.needsRelabel).toEqual(['hold-03'])
    expect(logs.at(-1)).toMatch(/^Bar: /)
  })
})

describe('readVerdictReport', () => {
  it('reads what a run wrote', async () => {
    const source = await savedRun()

    const read = await readVerdictReport(source.path)

    expect(read.cases.map((c) => c.id)).toEqual(['main-09', 'main-10', 'hold-03'])
    expect(read.set).toBe('main')
  })

  it('refuses a file that is not there, naming the path', async () => {
    const path = join(dir, 'nothing.json')

    const error = await readVerdictReport(path).then(() => null, (e: unknown) => e)

    expect(error).toBeInstanceOf(VerdictReportError)
    expect((error as Error).message).toContain(path)
  })

  it('refuses a file that is not JSON, and a JSON file that is not a verdict report, without quoting a word of it', async () => {
    const notJson = join(dir, 'a.json')
    const other = join(dir, 'b.json')
    await writeFile(notJson, 'SENTINEL-CONTENT {')
    await writeFile(other, JSON.stringify({ set: 'dev', cases: [], note: 'SENTINEL-CONTENT' }))

    for (const path of [notJson, other]) {
      const error = await readVerdictReport(path).then(() => null, (e: unknown) => e)
      expect(error, path).toBeInstanceOf(VerdictReportError)
      expect((error as Error).message, path).toContain(path)
      expect((error as Error).message, path).not.toContain('SENTINEL-CONTENT')
    }
  })

  it('refuses a verdict report whose cases are not what a run saves', async () => {
    const source = await savedRun()
    const broken = JSON.parse(source.text) as { cases: Record<string, unknown>[] }
    delete broken.cases[0]!.expect
    const path = join(dir, 'broken.json')
    await writeFile(path, JSON.stringify(broken))

    await expect(readVerdictReport(path)).rejects.toBeInstanceOf(VerdictReportError)
  })
})
