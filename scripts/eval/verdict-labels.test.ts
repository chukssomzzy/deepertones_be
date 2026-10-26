import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadVerdictLabels, VerdictLabelError } from './verdict-labels'

// The labels of `npm run eval:verdict`: what a person (or a labelling model, until a person has checked it) says each product the rules floor leaves open IS, for
// one case: helping, redundant or blocking, with the other labels that would also be fine, and which of a clashing pair to reduce. One JSON file per case at
// <root>/labels/<version>/<caseId>.json, in the gitignored eval-data/verdict folder. Like the cases, the files are checked on the way in, every problem listed at once.
//
// Shapes assumed (the contract this file pins):
//   loadVerdictLabels(root: string, version: string): Promise<LabelSet>
//   LabelSet   = { version: string; cases: Record<caseId, CaseLabels>; reviewed: boolean }
//   CaseLabels = { caseId; requestSha256: string; labelledBy: string; status?: 'provisional' | 'reviewed';
//                  entries: Record<productId, { label; alsoAcceptable: label[]; sameJobAs?: string; rationale: string }>;
//                  clashes: { ids: [string, string]; reduce: string /* one of the ids, or 'either' */ }[] }
//   label      = 'helping' | 'redundant' | 'blocking'
//   VerdictLabelError extends Error, with `problems: string[]`, one line for each thing wrong in any file; every line names the case id or file it is about.
//   A version is `reviewed` only when EVERY file has labelledBy 'human' or status 'reviewed'. A folder that is missing or holds no file is refused: an empty set
//   would otherwise be "reviewed" by the empty rule.

let root: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'verdict-labels-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const SHA = 'a'.repeat(64)

type Entry = { label: string; alsoAcceptable: string[]; sameJobAs?: string; rationale: string }
const entry = (label: string, over: Partial<Entry> = {}): Entry => ({ label, alsoAcceptable: [], rationale: 'A made-up reason for the label.', ...over })

type LabelFile = { caseId: string; requestSha256: string; labelledBy: string; status?: string; entries: Record<string, Entry>; clashes: { ids: [string, string]; reduce: string }[] }
const labelFile = (caseId: string, over: Partial<LabelFile> = {}): LabelFile => ({ caseId, requestSha256: SHA, labelledBy: 'human', entries: { 'cream-a': entry('helping') }, clashes: [], ...over })

type Put = LabelFile | { json: unknown; file: string }
const asFile = (put: Put): { json: unknown; file: string } => ('file' in put ? put : { json: put, file: `${put.caseId}.json` })

const seed = async (version: string, puts: Put[]) => {
  const folder = join(root, 'labels', version)
  await mkdir(folder, { recursive: true })
  for (const put of puts) {
    const { json, file } = asFile(put)
    await writeFile(join(folder, file), typeof json === 'string' ? json : JSON.stringify(json))
  }
}

/** The error the loader throws, or fails the test when it loads. */
const refusal = async (version = 'v1'): Promise<VerdictLabelError> => {
  const error = await loadVerdictLabels(root, version).then(
    () => null,
    (e: unknown) => e,
  )
  expect(error, 'the loader should have refused these labels').toBeInstanceOf(VerdictLabelError)
  return error as VerdictLabelError
}

describe('loadVerdictLabels: reading a version', () => {
  it('loads every file of the version, by case id, with everything the file says', async () => {
    const clash = { ids: ['retinol-serum', 'acid-toner'] as [string, string], reduce: 'acid-toner' }
    await seed('v1', [
      labelFile('main-09', { entries: { 'other-cream': entry('helping', { alsoAcceptable: ['redundant'], rationale: 'Plain and gentle.' }) } }),
      labelFile('hold-03', {
        requestSha256: 'b'.repeat(64),
        labelledBy: 'claude-test-model',
        status: 'reviewed',
        entries: { 'retinol-serum': entry('helping'), 'acid-toner': entry('redundant', { sameJobAs: 'retinol-serum' }) },
        clashes: [clash],
      }),
    ])

    const labels = await loadVerdictLabels(root, 'v1')

    expect(labels.version).toBe('v1')
    expect(Object.keys(labels.cases).sort()).toEqual(['hold-03', 'main-09'])
    expect(labels.cases['main-09']).toEqual({ caseId: 'main-09', requestSha256: SHA, labelledBy: 'human', entries: { 'other-cream': entry('helping', { alsoAcceptable: ['redundant'], rationale: 'Plain and gentle.' }) }, clashes: [] })
    expect(labels.cases['hold-03']).toEqual({
      caseId: 'hold-03',
      requestSha256: 'b'.repeat(64),
      labelledBy: 'claude-test-model',
      status: 'reviewed',
      entries: { 'retinol-serum': entry('helping'), 'acid-toner': entry('redundant', { sameJobAs: 'retinol-serum' }) },
      clashes: [clash],
    })
  })

  it('reads only the folder of the version asked for', async () => {
    await seed('v1', [labelFile('main-01')])
    await seed('v2', [labelFile('main-02'), labelFile('main-03')])

    expect(Object.keys((await loadVerdictLabels(root, 'v1')).cases)).toEqual(['main-01'])
    expect(Object.keys((await loadVerdictLabels(root, 'v2')).cases).sort()).toEqual(['main-02', 'main-03'])
  })

  it('refuses a version whose folder is missing, naming the version and where the files go', async () => {
    const error = await refusal('v9')

    expect(error.message).toContain('v9')
    expect(error.message).toContain(join(root, 'labels', 'v9'))
  })

  it('refuses a version with no file: an empty set must not count as reviewed', async () => {
    await mkdir(join(root, 'labels', 'v1'), { recursive: true })

    await refusal()
  })

  it('refuses a version name that is not a plain name, so it cannot reach outside the labels folder', async () => {
    await expect(loadVerdictLabels(root, '../cases')).rejects.toThrow()
    await expect(loadVerdictLabels(root, 'a/b')).rejects.toThrow()
  })
})

describe('loadVerdictLabels: when a version counts as reviewed', () => {
  it('is reviewed when every file was labelled by a human', async () => {
    await seed('v1', [labelFile('main-01'), labelFile('main-02')])

    expect((await loadVerdictLabels(root, 'v1')).reviewed).toBe(true)
  })

  it('is not reviewed when one file was labelled by a model and nobody has marked it reviewed', async () => {
    await seed('v1', [labelFile('main-01'), labelFile('main-02', { labelledBy: 'claude-test-model' })])

    expect((await loadVerdictLabels(root, 'v1')).reviewed).toBe(false)
  })

  it('is not reviewed when a model\'s file is marked provisional', async () => {
    await seed('v1', [labelFile('main-01', { labelledBy: 'claude-test-model', status: 'provisional' })])

    expect((await loadVerdictLabels(root, 'v1')).reviewed).toBe(false)
  })

  it('is reviewed when a model\'s file has been marked reviewed, and every other file is human or reviewed', async () => {
    await seed('v1', [labelFile('main-01'), labelFile('main-02', { labelledBy: 'claude-test-model', status: 'reviewed' })])

    expect((await loadVerdictLabels(root, 'v1')).reviewed).toBe(true)
  })

  it('is not reviewed by one reviewed file among model files that are not: every file must be', async () => {
    await seed('v1', [labelFile('main-01', { labelledBy: 'claude-test-model', status: 'reviewed' }), labelFile('main-02', { labelledBy: 'claude-test-model' })])

    expect((await loadVerdictLabels(root, 'v1')).reviewed).toBe(false)
  })
})

describe('loadVerdictLabels: the rules on an entry', () => {
  it('refuses a blocking product that lists helping among the labels that would also do', async () => {
    await seed('v1', [labelFile('main-01', { entries: { 'cream-a': entry('blocking', { alsoAcceptable: ['helping'] }) } })])

    const error = await refusal()

    expect(error.problems).toHaveLength(1)
    expect(error.problems[0]).toContain('main-01')
    expect(error.problems[0]).toContain('cream-a')
  })

  it('refuses a helping product that lists blocking among the labels that would also do', async () => {
    await seed('v1', [labelFile('main-01', { entries: { 'cream-a': entry('helping', { alsoAcceptable: ['blocking'] }) } })])

    const error = await refusal()

    expect(error.problems).toHaveLength(1)
    expect(error.problems[0]).toContain('cream-a')
  })

  it('refuses a redundant product that does not say which product does its job', async () => {
    await seed('v1', [labelFile('main-01', { entries: { 'cream-a': entry('redundant') } })])

    const error = await refusal()

    expect(error.problems).toHaveLength(1)
    expect(error.problems[0]).toContain('cream-a')
  })

  it.each([
    ['helping', ['redundant']],
    ['redundant', ['helping']],
    ['redundant', ['blocking']],
    ['blocking', ['redundant']],
    ['blocking', ['redundant', 'blocking']],
  ])('accepts a %s product that also accepts %j (only helping against blocking is a contradiction)', async (label, alsoAcceptable) => {
    await seed('v1', [labelFile('main-01', { entries: { 'cream-a': entry(label, { alsoAcceptable, ...(label === 'redundant' ? { sameJobAs: 'cream-b' } : {}) }) } })])

    const labels = await loadVerdictLabels(root, 'v1')

    expect(labels.cases['main-01']!.entries['cream-a']!.alsoAcceptable).toEqual(alsoAcceptable)
  })

  it('accepts a helping or blocking product with no sameJobAs', async () => {
    await seed('v1', [labelFile('main-01', { entries: { 'cream-a': entry('helping'), 'cream-b': entry('blocking') } })])

    await expect(loadVerdictLabels(root, 'v1')).resolves.toBeDefined()
  })

  it('refuses a label that is not helping, redundant or blocking, among the label and among the also-acceptable', async () => {
    await seed('v1', [
      labelFile('main-01', { entries: { 'cream-a': entry('great') } }),
      labelFile('main-02', { entries: { 'cream-a': entry('helping', { alsoAcceptable: ['fine'] }) } }),
    ])

    const error = await refusal()

    expect(error.problems.join('\n')).toContain('main-01')
    expect(error.problems.join('\n')).toContain('main-02')
  })
})

describe('loadVerdictLabels: the files', () => {
  it('lists every problem of every file at once, so one pass fixes them all', async () => {
    await seed('v1', [
      labelFile('main-01', { entries: { 'cream-a': entry('blocking', { alsoAcceptable: ['helping'] }) } }),
      labelFile('main-02', { entries: { 'cream-a': entry('redundant') } }),
      labelFile('main-03'),
    ])

    const error = await refusal()

    expect(error.problems).toHaveLength(2)
    expect(error.problems.join('\n')).toContain('main-01')
    expect(error.problems.join('\n')).toContain('main-02')
    expect(error.problems.join('\n')).not.toContain('main-03')
    expect(error.message).toContain('main-01')
    expect(error.message).toContain('main-02')
  })

  it('refuses a file that is not named after its case id', async () => {
    await seed('v1', [{ json: labelFile('main-01'), file: 'main-07.json' }])

    const error = await refusal()

    expect(error.problems.join('\n')).toContain('main-07.json')
  })

  it('refuses a file that is not JSON, naming the file', async () => {
    await seed('v1', [{ json: '{ not json', file: 'main-01.json' }])

    const error = await refusal()

    expect(error.problems.join('\n')).toContain('main-01.json')
  })

  it('refuses a file that lacks a required field, or has one nobody asked for', async () => {
    const { requestSha256: _dropped, ...noSha } = labelFile('main-01')
    await seed('v1', [{ json: noSha, file: 'main-01.json' }, { json: { ...labelFile('main-02'), colour: 'blue' }, file: 'main-02.json' }])

    const error = await refusal()

    expect(error.problems.join('\n')).toContain('main-01.json')
    expect(error.problems.join('\n')).toContain('main-02.json')
  })

  it('refuses a status that is neither provisional nor reviewed', async () => {
    await seed('v1', [labelFile('main-01', { status: 'final' })])

    await refusal()
  })

  it('ignores files that are not .json', async () => {
    await seed('v1', [labelFile('main-01'), { json: 'notes to self', file: 'notes.md' }])

    expect(Object.keys((await loadVerdictLabels(root, 'v1')).cases)).toEqual(['main-01'])
  })
})
