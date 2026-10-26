/*
 * The labels of `npm run eval:verdict`: what each product the rules floor leaves open IS (helping, redundant or blocking), with the other labels that would also be
 * fine and which of a clashing pair to reduce. One JSON file for each case at <root>/labels/<version>/<caseId>.json, in the gitignored eval-data/verdict folder (a
 * label names the products of a case, which may copy catalog products). Like the cases, the files are checked on the way in and every problem is listed at once.
 *
 * A model may draft a file, but only a version in which EVERY file was written by a person or marked reviewed counts as `reviewed`, and only a reviewed version
 * can let the bar PASS. `requestSha256` pins a file to the request its case made of the fit judge when it was labelled: a case whose request has changed since
 * is listed for re-labelling by the score and left out of the fit.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { isLabelVersion } from './routine-labels'

/** The labels cannot be used and say nothing about the code: the CLI exits 2. `problems` holds every one found; a message holds ids, paths and rule words, never a label's text. */
export class VerdictLabelError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`The verdict labels have ${problems.length} problem${problems.length === 1 ? '' : 's'}:\n${problems.map((problem) => `  ${problem}`).join('\n')}`)
  }
}

const LabelSchema = z.enum(['helping', 'redundant', 'blocking'])

const EntrySchema = z.strictObject({
  label: LabelSchema,
  alsoAcceptable: z.array(LabelSchema),
  /** The product that does a redundant product's job and stays. */
  sameJobAs: z.string().min(1).optional(),
  rationale: z.string().min(1),
})

const CaseLabelsSchema = z.strictObject({
  caseId: z.string().min(1),
  requestSha256: z.string().regex(/^[0-9a-f]{64}$/, 'must be a sha256 in lower-case hex'),
  /** 'human', or the id of the model that drafted the file. */
  labelledBy: z.string().min(1),
  status: z.enum(['provisional', 'reviewed']).optional(),
  entries: z.record(z.string().min(1), EntrySchema),
  /** For each clashing pair: the product to reduce, or 'either'. */
  clashes: z.array(z.strictObject({ ids: z.tuple([z.string().min(1), z.string().min(1)]), reduce: z.string().min(1) })),
})

export type CaseLabels = z.infer<typeof CaseLabelsSchema>
export type LabelSet = { version: string; cases: Record<string, CaseLabels>; reviewed: boolean }

const isReviewed = (labels: CaseLabels): boolean => labels.labelledBy === 'human' || labels.status === 'reviewed'

/** The problems of one file that the schema cannot say: a contradiction between an entry's label and the labels that would also do, a redundant product with no other to point at, a clash reduced to nobody. */
const ruleProblems = (labels: CaseLabels): string[] => {
  const found: string[] = []
  for (const [id, entry] of Object.entries(labels.entries)) {
    if (entry.label === 'blocking' && entry.alsoAcceptable.includes('helping')) found.push(`${labels.caseId}: ${id} is blocking and also lists helping as acceptable`)
    else if (entry.label === 'helping' && entry.alsoAcceptable.includes('blocking')) found.push(`${labels.caseId}: ${id} is helping and also lists blocking as acceptable`)
    if (entry.label === 'redundant' && entry.sameJobAs === undefined) found.push(`${labels.caseId}: ${id} is redundant and does not say which product does its job (sameJobAs)`)
  }
  for (const { ids, reduce } of labels.clashes) {
    if (reduce !== 'either' && !ids.includes(reduce)) found.push(`${labels.caseId}: the clash of ${ids.join(' and ')} is reduced to "${reduce}", which is neither of them nor "either"`)
  }
  return found
}

/** Every file of one version of the labels. Throws a `VerdictLabelError` holding every problem when anything is wrong, or when the version has no file. */
export const loadVerdictLabels = async (root: string, version: string): Promise<LabelSet> => {
  if (!isLabelVersion(version)) throw new VerdictLabelError([`"${version}" is not a plain label version (letters, digits, - and _)`])
  const folder = join(root, 'labels', version)
  let files: string[]
  try {
    files = (await readdir(folder)).filter((file) => file.endsWith('.json')).sort()
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'ENOENT') throw new VerdictLabelError([`No labels for version ${version}: the files go in ${folder}, one <caseId>.json each.`])
    throw error
  }
  // An empty set would be "reviewed" by the empty rule, so it is refused.
  if (files.length === 0) throw new VerdictLabelError([`No labels for version ${version}: ${folder} holds no .json file.`])

  const problems: string[] = []
  const cases: Record<string, CaseLabels> = {}
  for (const file of files) {
    let json: unknown
    try {
      json = JSON.parse(await readFile(join(folder, file), 'utf8'))
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      // The parser's message can quote the text, and a label's rationale is not for the console.
      problems.push(`${file}: not JSON`)
      continue
    }
    const parsed = CaseLabelsSchema.safeParse(json)
    if (!parsed.success) {
      for (const issue of parsed.error.issues) problems.push(`${file}: ${issue.path.length === 0 ? 'the file' : issue.path.map(String).join('.')}: ${issue.message}`)
      continue
    }
    if (file !== `${parsed.data.caseId}.json`) {
      problems.push(`${file}: the file is not named after its case id (${parsed.data.caseId}.json)`)
      continue
    }
    const found = ruleProblems(parsed.data)
    problems.push(...found)
    if (found.length === 0) cases[parsed.data.caseId] = parsed.data
  }
  if (problems.length > 0) throw new VerdictLabelError(problems)
  return { version, cases, reviewed: Object.values(cases).every(isReviewed) }
}
