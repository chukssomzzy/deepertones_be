/*
 * The measurement sets of `npm run eval:verdict`: synthetic shelves, one JSON file each at <root>/cases/{main,holdout}/<id>.json. Unlike the routine eval's cases
 * they are NOT committed: they sit in the gitignored eval-data/verdict folder on the owner's machine, because a case may copy a real catalog product's name and
 * ingredients. So this loader is the only thing between a hand-written file and a paid run: it checks every file against a closed schema, then the whole set
 * against the rules a hand-written file most easily breaks (see `crossChecks`). It reports every problem it finds, not the first.
 *
 * A case holds what the app would know when it builds a verdict (the goal, the scan, the safety answers, the shelf) and what the rules floor is expected to do
 * with each skin entry. The ids of entries are the case's own and only unique inside it.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { CATEGORIES, PRODUCT_FORMS, ROUTINE_STEPS, TAPER_KINDS } from '../../src/modules/catalog/catalog.vocabulary'
import { SHOWN_CONCERNS, SKIN_TYPE_LABELS, type Band } from '../../src/modules/face-scans/face-scans.tables'
import { GOALS } from '../../src/modules/goals/goals.vocabulary'
import { SAFETY_CHOICES } from '../../src/modules/safety/safety.vocabulary'
import { NO_LABEL_PURPOSES } from '../../src/modules/scans/scans.vocabulary'

export const DEFAULT_VERDICT_ROOT = 'eval-data/verdict'

/** The measurement sets: main is tuned on, holdout is the bar. */
export type VerdictSet = 'main' | 'holdout'
const SETS: readonly VerdictSet[] = ['main', 'holdout']
const PREFIX: Record<VerdictSet, string> = { main: 'main-', holdout: 'hold-' }

/** The cases cannot be used and say nothing about the code: the CLI exits 2. `problems` holds every one found; a message holds ids, paths and rule words, never a model's answer. */
export class VerdictCaseError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`The verdict cases have ${problems.length} problem${problems.length === 1 ? '' : 's'}:\n${problems.map((problem) => `  ${problem}`).join('\n')}`)
  }
}

// --- the schema ----------------------------------------------------------------------------------------------------------------------------------

const BANDS = ['faint', 'a-little', 'some', 'clear'] as const satisfies readonly Band[]
const FLOOR_GROUPS = ['prescribed', 'likely-the-problem', 'conflicting', 'cant-tell'] as const

const ShownConcernSchema = z.enum(SHOWN_CONCERNS)

const ProductEntrySchema = z.strictObject({
  id: z.string().min(1),
  kind: z.literal('product'),
  brand: z.string().min(1),
  name: z.string().min(1),
  variant: z.string().min(1).nullable(),
  form: z.enum(PRODUCT_FORMS).nullable(),
  category: z.enum(CATEGORIES),
  ingredients: z.array(z.string()),
  steps: z.array(z.enum(ROUTINE_STEPS)),
  /** A product the case copies from the catalog snapshot (checked by `checkCatalogEntries`), or one made up for the eval. */
  source: z.union([z.strictObject({ catalogCode: z.string().min(1) }), z.strictObject({ madeUp: z.literal(true) })]),
  /** What the recommendation catalog says the product is for; left out for a product the catalog does not recommend. */
  skinConcerns: z.array(ShownConcernSchema).optional(),
})

const NoLabelEntrySchema = z.strictObject({
  id: z.string().min(1),
  kind: z.literal('no-label'),
  purpose: z.enum(NO_LABEL_PURPOSES),
})

const EntrySchema = z.discriminatedUnion('kind', [ProductEntrySchema, NoLabelEntrySchema])

const MentionSchema = z.strictObject({
  source: z.enum(['reaction', 'prescription']),
  kind: z.enum(['product', 'ingredient']),
  name: z.string().min(1),
  /** The id of the shelf entry the catalog resolved the mention to, or null when it resolved to nothing on the shelf. */
  resolvesTo: z.string().min(1).nullable(),
})

const OpenSchema = z.strictObject({ outcome: z.literal('open') })
const IgnoredSchema = z.strictObject({ outcome: z.literal('ignored') })
const FixedSchema = z
  .strictObject({
    outcome: z.literal('fixed'),
    group: z.enum(FLOOR_GROUPS),
    verdict: z.enum(['keep', 'drop', 'stop']),
    taper: z.enum(TAPER_KINDS).optional(),
    escalate: z.literal(true).optional(),
  })
  .superRefine((fixed, context) => {
    if (fixed.verdict === 'stop' && fixed.taper === undefined) context.addIssue({ code: 'custom', path: ['taper'], message: 'a stop needs the kind of taper it is stopped with' })
    if (fixed.verdict !== 'stop' && fixed.taper !== undefined) context.addIssue({ code: 'custom', path: ['taper'], message: `a ${fixed.verdict} has no taper` })
  })

/** What the rules floor does with one entry: nothing yet (open), nothing ever (ignored: not a skin product), or a fixed answer. */
const ExpectedSchema = z.discriminatedUnion('outcome', [OpenSchema, IgnoredSchema, FixedSchema])

const CaseSchema = z.strictObject({
  id: z.string().min(1),
  persona: z.enum(['amara', 'tolu', 'ngozi', 'chidi']).nullable(),
  country: z.enum(['NG', 'GB']),
  note: z.string(),
  goal: z.enum(GOALS),
  scan: z
    .strictObject({
      skinType: z.enum(SKIN_TYPE_LABELS).nullable(),
      concerns: z.array(z.strictObject({ concern: ShownConcernSchema, band: z.enum(BANDS) })),
    })
    .nullable(),
  safety: z.strictObject({ choices: z.array(z.enum(SAFETY_CHOICES)), mentions: z.array(MentionSchema) }),
  shelf: z.array(EntrySchema),
  expect: z.strictObject({
    entries: z.record(z.string(), ExpectedSchema),
    /** Pairs of entry ids the floor is expected to report as clashing. */
    clashes: z.array(z.tuple([z.string(), z.string()])),
  }),
})

export type VerdictCase = z.infer<typeof CaseSchema>
export type VerdictEntry = z.infer<typeof EntrySchema>
export type ExpectedFloor = z.infer<typeof ExpectedSchema>

// --- reading -------------------------------------------------------------------------------------------------------------------------------------

type Loaded = { set: VerdictSet; file: string; case: VerdictCase }

const where = (path: PropertyKey[]): string => (path.length === 0 ? 'the case' : path.map(String).join('.'))

const isSkin = (entry: VerdictEntry): boolean => entry.kind === 'no-label' || entry.category === 'skin'

const readSet = async (root: string, set: VerdictSet, problems: string[]): Promise<Loaded[]> => {
  const folder = join(root, 'cases', set)
  let files: string[]
  try {
    files = (await readdir(folder)).filter((file) => file.endsWith('.json')).sort()
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'ENOENT') {
      problems.push(`No folder ${folder}: the ${set} cases go there, one <id>.json file each.`)
      return []
    }
    throw error
  }
  const loaded: Loaded[] = []
  for (const file of files) {
    const label = `${set}/${file}`
    let json: unknown
    try {
      json = JSON.parse(await readFile(join(folder, file), 'utf8'))
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error
      problems.push(`${label}: not JSON (${error.message})`)
      continue
    }
    const parsed = CaseSchema.safeParse(json)
    if (!parsed.success) {
      for (const issue of parsed.error.issues) problems.push(`${label}: ${where(issue.path)}: ${issue.message}`)
      continue
    }
    loaded.push({ set, file, case: parsed.data })
  }
  return loaded
}

// --- the rules of the whole set ------------------------------------------------------------------------------------------------------------------

const squash = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').trim()

/** What makes a shelf entry the same product in two cases: its catalog code, or else its brand, name and variant (capitals and spacing aside); a no-label item by its purpose. */
const entryKey = (entry: VerdictEntry): string => {
  if (entry.kind === 'no-label') return `no-label:${entry.purpose}`
  if ('catalogCode' in entry.source) return `catalog:${entry.source.catalogCode}`
  return `made-up:${squash(entry.brand)}|${squash(entry.name)}|${squash(entry.variant ?? '')}`
}

/** The shelf as a set of products: the order of the entries and what the case calls them make no difference. */
const shelfKey = (shelf: readonly VerdictEntry[]): string => shelf.map(entryKey).sort().join('\n')

const ownProblems = ({ set, file, case: c }: Loaded): string[] => {
  const found: string[] = []
  const bad = (text: string) => found.push(`${c.id}: ${text}`)
  if (file !== `${c.id}.json`) bad(`the file is ${set}/${file}, which is not named after the case id (${c.id}.json)`)
  if (!c.id.startsWith(PREFIX[set])) bad(`a ${set} case has an id that starts with "${PREFIX[set]}", and this one is in the ${set} folder`)

  const entries = new Map<string, VerdictEntry>()
  for (const entry of c.shelf) {
    if (entries.has(entry.id)) bad(`the entry id "${entry.id}" is used twice on the shelf`)
    entries.set(entry.id, entry)
  }
  for (const mention of c.safety.mentions) {
    if (mention.resolvesTo === null) continue
    const target = entries.get(mention.resolvesTo)
    if (!target) bad(`a ${mention.source} mention resolves to "${mention.resolvesTo}", which is not an entry of the shelf`)
    else if (target.kind !== 'product') bad(`a ${mention.source} mention resolves to "${mention.resolvesTo}", which is a no-label item and not a product`)
  }
  for (const id of Object.keys(c.expect.entries)) if (!entries.has(id)) bad(`an expectation is written for "${id}", which is not an entry of the shelf`)
  for (const pair of c.expect.clashes) for (const id of pair) if (!entries.has(id)) bad(`an expected clash names "${id}", which is not an entry of the shelf`)
  for (const entry of c.shelf) if (isSkin(entry) && !(entry.id in c.expect.entries)) bad(`the skin entry "${entry.id}" has no expectation`)
  return found
}

/** Ids claimed twice (in a set or across both) and shelves that are the same shelf: a duplicate would count one case as two, or let a holdout case leak a tuned one. */
const crossChecks = (loaded: readonly Loaded[]): string[] => {
  const found: string[] = []
  const byId = new Map<string, Loaded[]>()
  const byShelf = new Map<string, Loaded[]>()
  for (const item of loaded) {
    byId.set(item.case.id, [...(byId.get(item.case.id) ?? []), item])
    const key = shelfKey(item.case.shelf)
    byShelf.set(key, [...(byShelf.get(key) ?? []), item])
  }
  for (const [id, items] of byId) {
    if (items.length > 1) found.push(`${id}: the case id is claimed by ${items.map((item) => `${item.set}/${item.file}`).join(' and ')}`)
  }
  for (const items of byShelf.values()) {
    const ids = [...new Set(items.map((item) => item.case.id))]
    if (ids.length > 1) found.push(`${ids.join(' and ')}: these cases have the same shelf`)
  }
  return found
}

/** Every case of both folders, each in id order. Throws a `VerdictCaseError` holding every problem when anything is wrong. */
export const loadVerdictCases = async (root: string = DEFAULT_VERDICT_ROOT): Promise<Record<VerdictSet, VerdictCase[]>> => {
  const problems: string[] = []
  const loaded = (await Promise.all(SETS.map((set) => readSet(root, set, problems)))).flat()
  for (const item of loaded) problems.push(...ownProblems(item))
  problems.push(...crossChecks(loaded))
  if (problems.length > 0) throw new VerdictCaseError(problems)

  const inSet = (set: VerdictSet) => loaded.filter((item) => item.set === set).map((item) => item.case).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return { main: inSet('main'), holdout: inSet('holdout') }
}
