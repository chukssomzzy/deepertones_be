import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { CATEGORIES, PRODUCT_FORMS, type ProductForm } from '../../src/modules/catalog/catalog.vocabulary'
import type { ProductImage } from '../../src/providers/product-analysis/product-analyst.provider'

// Reads and checks the owner's photo set for `npm run eval:matching` (see matching.ts): everything that can be wrong with
// the set is found here, before a single billed call.

export type Label = {
  brand: string
  name: string
  variant?: string
  form?: ProductForm
  category: (typeof CATEGORIES)[number]
  /** Folders of products that look much like this one; a merge between them is still a miss, but is named as understandable. */
  lookalikes?: string[]
}

export type SetPhoto = { name: string; path: string; mediaType: ProductImage['mediaType'] }
export type SetProduct = { folder: string; label: Label; photos: SetPhoto[] }
export type PhotoSet = { products: SetProduct[] }

export type Verdict = 'right' | 'wrong'
export type Verdicts = Record<string, Verdict>

/** The photo set cannot be used as it is; the message says what to fix. */
export class PhotoSetError extends Error {}
/** The verdicts file or a --verdict flag cannot be used; the message says what to fix. */
export class VerdictsError extends Error {}

/** Three fixed seeds: the same three photo orders on every run, so two runs differ only in what the code does. */
export const SEEDS: readonly number[] = [11, 23, 37]

const MEDIA_TYPES: Record<string, SetPhoto['mediaType']> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }
const LABELS_FILE = 'labels.json'
const VERDICTS_FILE = 'verdicts.json'
const MIN_PHOTOS = 2
const SHA256_HEX = /^[0-9a-f]{64}$/

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const isMissing = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'ENOENT'

const readLabelsFile = async (directory: string): Promise<Record<string, unknown>> => {
  let text: string
  try {
    text = await readFile(join(directory, LABELS_FILE), 'utf8')
  } catch (error) {
    if (isMissing(error)) throw new PhotoSetError(`${LABELS_FILE} is missing in ${directory}: it names every product folder (see the header of scripts/eval/matching.ts).`)
    throw error
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new PhotoSetError(`${LABELS_FILE} is malformed: it is not valid JSON.`)
  }
  if (!isRecord(parsed) || Object.values(parsed).some((label) => !isRecord(label))) {
    throw new PhotoSetError(`${LABELS_FILE} is malformed: it must be an object of { "<folder>": { "brand", "name", "category", ... } }.`)
  }
  return parsed
}

const text = (folder: string, label: Record<string, unknown>, field: 'brand' | 'name' | 'variant', required: boolean): string | undefined => {
  const value = label[field]
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string' || value.trim() === '') throw new PhotoSetError(`${folder}: the label needs a ${field} (a non-empty string).`)
  return value
}

const toLabel = (folder: string, raw: Record<string, unknown>): Label => {
  const brand = text(folder, raw, 'brand', true)!
  const name = text(folder, raw, 'name', true)!
  const variant = text(folder, raw, 'variant', false)
  const { category, form, lookalikes } = raw
  if (!CATEGORIES.includes(category as Label['category'])) throw new PhotoSetError(`${folder}: category "${String(category)}" is not one of ${CATEGORIES.join(', ')}.`)
  if (form !== undefined && !PRODUCT_FORMS.includes(form as ProductForm)) throw new PhotoSetError(`${folder}: form "${String(form)}" is not one of ${PRODUCT_FORMS.join(', ')}.`)
  if (lookalikes !== undefined && (!Array.isArray(lookalikes) || lookalikes.some((entry) => typeof entry !== 'string'))) {
    throw new PhotoSetError(`${folder}: lookalikes must be a list of folder names.`)
  }
  return {
    brand,
    name,
    ...(variant === undefined ? {} : { variant }),
    ...(form === undefined ? {} : { form: form as ProductForm }),
    category: category as Label['category'],
    ...(lookalikes === undefined ? {} : { lookalikes: lookalikes as string[] }),
  }
}

const listPhotos = async (directory: string, folder: string): Promise<SetPhoto[]> => {
  const entries = await readdir(join(directory, folder), { withFileTypes: true })
  const photos: SetPhoto[] = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const mediaType = entry.isFile() ? MEDIA_TYPES[extname(entry.name).toLowerCase()] : undefined
    if (!mediaType) throw new PhotoSetError(`${folder}/${entry.name}: unsupported file (only .jpg, .jpeg, .png and .webp photos belong in a product folder).`)
    photos.push({ name: entry.name, path: join(directory, folder, entry.name), mediaType })
  }
  return photos.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** Loads `<directory>/labels.json` and the product folders beside it, or throws a PhotoSetError naming the first problem. */
export const loadPhotoSet = async (directory: string): Promise<PhotoSet> => {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (isMissing(error)) throw new PhotoSetError(`${directory} does not exist: put your product folders and ${LABELS_FILE} there (see the header of scripts/eval/matching.ts).`)
    throw error
  }
  const rawLabels = await readLabelsFile(directory)
  const folders = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name).sort()

  for (const folder of folders) if (!(folder in rawLabels)) throw new PhotoSetError(`${folder}: the folder has no label in ${LABELS_FILE}.`)
  for (const folder of Object.keys(rawLabels)) if (!folders.includes(folder)) throw new PhotoSetError(`${folder}: the label has no folder in ${directory}.`)

  const labels = new Map(folders.map((folder) => [folder, toLabel(folder, rawLabels[folder] as Record<string, unknown>)]))
  for (const [folder, label] of labels) {
    for (const other of label.lookalikes ?? []) {
      if (other === folder) throw new PhotoSetError(`${folder}: a product cannot be its own lookalike.`)
      const theirs = labels.get(other)
      if (!theirs) throw new PhotoSetError(`${folder}: lookalike "${other}" is an unknown folder.`)
      if (!theirs.lookalikes?.includes(folder)) throw new PhotoSetError(`${folder} lists ${other} as a lookalike but ${other} does not list ${folder}: lookalikes must be symmetric.`)
    }
  }

  const products: SetProduct[] = []
  for (const folder of folders) {
    const photos = await listPhotos(directory, folder)
    if (photos.length < MIN_PHOTOS) throw new PhotoSetError(`${folder}: needs at least ${MIN_PHOTOS} photos to say whether a repeat photo finds its row (found ${photos.length}).`)
    products.push({ folder, label: labels.get(folder)!, photos })
  }
  return { products }
}

export const parseVerdicts = (body: string): Verdicts => {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw new VerdictsError(`${VERDICTS_FILE} is malformed: it is not valid JSON.`)
  }
  if (!isRecord(parsed)) throw new VerdictsError(`${VERDICTS_FILE} is malformed: it must be an object of { "<image hash>": "right" | "wrong" }.`)
  for (const [hash, verdict] of Object.entries(parsed)) {
    if (verdict !== 'right' && verdict !== 'wrong') throw new VerdictsError(`${VERDICTS_FILE}: the verdict for ${hash} must be "right" or "wrong" (got ${JSON.stringify(verdict)}).`)
  }
  return parsed as Verdicts
}

/** The verdicts in `<directory>/verdicts.json`; none when the file is not there. */
export const loadVerdicts = async (directory: string): Promise<Verdicts> => {
  try {
    return parseVerdicts(await readFile(join(directory, VERDICTS_FILE), 'utf8'))
  } catch (error) {
    if (isMissing(error)) return {}
    throw error
  }
}

/** `HASH=right` or `HASH=wrong`, as given to --verdict. */
export const parseVerdictFlag = (flag: string): [string, Verdict] => {
  const at = flag.indexOf('=')
  const hash = flag.slice(0, at)
  const verdict = flag.slice(at + 1)
  if (at === -1 || !SHA256_HEX.test(hash) || (verdict !== 'right' && verdict !== 'wrong')) throw new VerdictsError('--verdict must be HASH=right or HASH=wrong, where HASH is the 64-character lowercase hex hash from the contact sheet.')
  return [hash, verdict]
}

/** Adds the verdicts to the file (a verdict for a hash already there replaces it) and returns what the file now holds. A malformed file is left untouched. */
export const recordVerdicts = async (directory: string, updates: Verdicts): Promise<Verdicts> => {
  const merged = { ...(await loadVerdicts(directory)), ...updates }
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, VERDICTS_FILE), `${JSON.stringify(merged, null, 2)}\n`)
  return merged
}

/** mulberry32: a small seeded generator, so a seed always means the same order. */
const generator = (seed: number): (() => number) => {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A Fisher-Yates shuffle that depends only on the seed; the list given is not changed. */
export const seededShuffle = <T>(list: readonly T[], seed: number): T[] => {
  const next = generator(seed)
  const shuffled = [...list]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]
  }
  return shuffled
}
