// Measures whether the catalog's matching and stock images hold up on the owner's own photos: `npm run eval:matching`.
// Photos live in eval-photos/catalog/<product folder>/*.{jpg,jpeg,png,webp} (at least 2 per product), beside labels.json:
//   { "<folder>": { "brand": "...", "name": "...", "variant"?: "...", "form"?: "<form>", "category": "skin|hair|body|makeup|other", "lookalikes"?: ["<folder>"] } }
// and verdicts.json ({ "<sha256 of an image>": "right" | "wrong" }, written by --verdict). Look-alikes are declared on both sides. All git-ignored.
// Shelf photos live in eval-photos/shelf/<file>.{jpg,jpeg,png,webp} (at most 2,000,000 bytes), beside labels.json:
//   { "<file>": { "products": [ { "folder": "<catalog folder>" } | { "brand": "...", "name": "...", "variant"?: "...", "form"?: "...", "category": "..." } ] } }
// listing every product whose brand and name a person can read. The shelf part needs the directory; `all` skips it when it is absent.
// Needs ANTHROPIC_API_KEY (environment, else .dev.vars) and makes real, billed calls. Report-only: never part of `npm test`.
//   matching  every photo is read once, then fed to a fresh in-memory catalog in 3 fixed random orders: do repeat photos of a product find its row?
//   images    each product is created from its label and researched for real; the stock image it stores is saved for you to judge.
//   shelf     photos of several products together are read once each; every product listed is resolved against a catalog seeded with the true
//             rows of the single set and of the shelf photos' other products: did it find what is in the photo, invent nothing, land on the right rows?
//   --part matching|images|shelf|all   (default all)    --max-usd N   stop spending at N dollars (default 3)    --limit N   products to run
//   --limit does not cut the shelf photos: the catalog is seeded from the whole set.
//   --model JOB=MODEL   run a job on another model (repeatable)
//   --verdict HASH=right|wrong   record your verdict on a stored image (repeatable); makes no calls, spends nothing, then exits 0
// Reports go to .eval/matching/<timestamp>/: report.json and contact-sheet.html (the stored images beside your photos, each with the
// command that records your verdict; the shelf photos with what each listed product landed on). The report may hold what the model read from your labels; the console never does: it prints only
// folder names, short row ids, codes, field names and numbers, never a prompt, the key or other model text.
// Exit: 0 every target of the parts that ran was met, 1 one was missed, 2 the run could not start (photo set, verdicts, arguments, key).
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { brandKey, identityKey, normaliseText } from '../../src/modules/catalog/catalog.identity'
import { FakeCatalogRepository } from '../../src/modules/catalog/catalog.repository.fake'
import type { NewProduct, Product } from '../../src/modules/catalog/catalog.types'
import { ProductCatalogService } from '../../src/modules/catalog/catalog.service'
import type { OpsAlertsService } from '../../src/modules/ops-alerts/ops-alerts.service'
import { SCAN_POLICY } from '../../src/modules/scans/scans.service'
import { AiBudgetExceededError } from '../../src/providers/anthropic/ai-spend.provider'
import { AnthropicClient } from '../../src/providers/anthropic/anthropic.client'
import { AnthropicConfigError, AnthropicRefusalError, AnthropicUnavailableError } from '../../src/providers/anthropic/anthropic.provider'
import { MemoryAiSpendLedger } from '../../src/providers/anthropic/memory.ai-spend-ledger'
import { R2CatalogImageStore } from '../../src/providers/catalog-images/r2.catalog-image-store'
import type { ProductAnalyst, ProductImage } from '../../src/providers/product-analysis/product-analyst.provider'
import { AnthropicProductAnalyst } from '../../src/providers/product-analysis/anthropic.product-analyst'
import { AnthropicProductRecognizer } from '../../src/providers/product-recognition/anthropic.product-recognizer'
import type { Recognition, ShelfRecognition } from '../../src/providers/product-recognition/product-recognizer.provider'
import { AnthropicProductResearcher } from '../../src/providers/product-research/anthropic.product-researcher'
import type { ProductIdentity } from '../../src/providers/product-research/product-researcher.provider'
import { DEFAULT_MODELS } from './models'
import {
  ANALYSIS_COST_USD,
  duplicateCost,
  DUPLICATE_COST_USD,
  duplicateUnitCost,
  exitCode,
  type ImageOutcome,
  type ImageStage,
  judge,
  type MatchingScore,
  type OrderScore,
  type PhotoOutcome,
  scoreImages,
  scoreMatching,
  scoreShelf,
  type ShelfPhotoInput,
  type ShelfScore,
} from './matching-score'
import {
  type Label,
  loadPhotoSet,
  loadShelfSet,
  loadVerdicts,
  parseVerdictFlag,
  type PhotoSet,
  recordVerdicts,
  SEEDS,
  seededShuffle,
  type SetPhoto,
  type SetProduct,
  type ShelfPhoto,
  type ShelfSet,
  type Verdicts,
} from './matching-set'
import { loadEnv, parseArgs } from './score'

const DIRECTORY = 'eval-photos/catalog'
const SHELF_DIRECTORY = 'eval-photos/shelf'
const DEFAULT_MAX_USD = 3
const PARTS = ['matching', 'images', 'shelf', 'all'] as const
type Part = (typeof PARTS)[number]
const IDENTITY_FIELDS = ['brand', 'name', 'variant', 'form', 'category'] as const

const USAGE = 'Usage: npm run eval:matching -- [--part matching|images|shelf|all] [--limit N] [--max-usd N] [--model JOB=MODEL]... [--verdict HASH=right|wrong]...'

/** The run cannot go on and the numbers would say nothing about the code: exit 2, not 1. */
class SetupError extends Error {}

const usd = (micros: number): string => `$${(micros / 1_000_000).toFixed(4)}`
const percent = (ratio: number): string => `${Math.round(ratio * 100)}%`
const errorName = (error: unknown): string => (error instanceof Error ? error.name : 'UnknownError')
/**
 * A model that is briefly down (overloaded, rate-limited) is retried, as the Worker's queue retries a step, so an outage does not
 * read as a pipeline error. Up to 2 retries, 3 and then 10 seconds apart; anything else, or a third failure, is thrown.
 */
const withRetries = async <T>(call: () => Promise<T>): Promise<T> => {
  for (const waitMs of [3_000, 10_000]) {
    try {
      return await call()
    } catch (error) {
      if (!(error instanceof AnthropicUnavailableError)) throw error
      await new Promise((resolve) => setTimeout(resolve, waitMs))
    }
  }
  return call()
}
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const dataUri = (mediaType: string, bytes: Uint8Array): string => `data:${mediaType};base64,${Buffer.from(bytes).toString('base64')}`

/** Pulls out this script's own flags; whatever is left goes to the shared parser, which refuses anything it does not know. */
const splitArgs = (argv: string[]): { part: Part; verdicts: string[]; rest: string[]; maxUsdGiven: boolean } => {
  let part: Part = 'all'
  const verdicts: string[] = []
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const equals = arg.startsWith('--') ? arg.indexOf('=') : -1
    const flag = equals === -1 ? arg : arg.slice(0, equals)
    if (flag !== '--part' && flag !== '--verdict') {
      rest.push(arg)
      continue
    }
    const value = equals === -1 ? argv[++i] : arg.slice(equals + 1)
    if (value === undefined || value === '' || value.startsWith('-')) throw new SetupError(`${flag} needs a value. ${USAGE}`)
    if (flag === '--verdict') verdicts.push(value)
    else if (PARTS.includes(value as Part)) part = value as Part
    else throw new SetupError(`Unknown part "${value}". ${USAGE}`)
  }
  return { part, verdicts, rest, maxUsdGiven: rest.some((arg) => arg === '--max-usd' || arg.startsWith('--max-usd=')) }
}

const readPhoto = (photo: SetPhoto): ProductImage => ({ bytes: readFileSync(photo.path), mediaType: photo.mediaType })

const identityOfLabel = (product: { label: Label }): ProductIdentity => {
  const { brand, name, variant, form, category } = product.label
  return { brand, name, category, ...(variant ? { variant } : {}), ...(form ? { form } : {}) }
}

/** A ledger that remembers having refused a reservation: the run then stopped short of what it was asked to measure. */
class WatchedLedger extends MemoryAiSpendLedger {
  refused = false
  override async reserve(input: Parameters<MemoryAiSpendLedger['reserve']>[0]): Promise<string> {
    try {
      return await super.reserve(input)
    } catch (error) {
      if (error instanceof AiBudgetExceededError) this.refused = true
      throw error
    }
  }
}

/** The service needs an alerts service; the eval has nobody to email, and it raises nothing below 200 researches. */
const NO_ALERTS = { raise: async () => undefined } as unknown as OpsAlertsService

// ---- matching ----

type Read = { identity: ProductIdentity; confidence: number }
/** What recognising a photo gave: a readable beauty product, nothing to match (a fixed classification code or a refusal), or a failure. */
type Recognised = { photo: SetPhoto; folder: string; read: Read } | { photo: SetPhoto; folder: string; unreadable: string } | { photo: SetPhoto; folder: string; error: string }

const recogniseOnce = async (recognizer: AnthropicProductRecognizer, products: SetProduct[]): Promise<Recognised[]> => {
  const out: Recognised[] = []
  for (const product of products) {
    for (const photo of product.photos) {
      let seen: Recognition
      try {
        seen = await withRetries(() => recognizer.recognize(readPhoto(photo)))
      } catch (error) {
        if (error instanceof AnthropicConfigError) throw new SetupError('Claude rejected the API key or the account (check ANTHROPIC_API_KEY and billing).')
        if (error instanceof AiBudgetExceededError) throw new SetupError('The spend cap was reached while reading photos; raise --max-usd.')
        if (error instanceof AnthropicRefusalError) out.push({ photo, folder: product.folder, unreadable: errorName(error) })
        else out.push({ photo, folder: product.folder, error: errorName(error) })
        continue
      }
      if (seen.classification !== 'beauty-product') {
        out.push({ photo, folder: product.folder, unreadable: seen.classification })
        continue
      }
      const { brand, name, variant, form, category, confidence } = seen
      out.push({ photo, folder: product.folder, read: { confidence, identity: { brand, name, category, ...(variant ? { variant } : {}), ...(form ? { form } : {}) } } })
    }
  }
  return out
}

type JudgeAnswer = { candidateRowId: string; same: boolean }
type Trace = { created: boolean; questions: JudgeAnswer[] }

/** The in-memory repository, watched: what resolve created and which rows it offered the judge. Behaviour is unchanged. */
class ObservedRepository extends FakeCatalogRepository {
  trace: Trace = { created: false, questions: [] }
  offered: Product[] = []

  override async productsByBrandFamily(firstWord: string, limit: number): Promise<Product[]> {
    this.offered = await super.productsByBrandFamily(firstWord, limit)
    return this.offered
  }

  override async createProduct(input: NewProduct): Promise<Product> {
    const row = await super.createProduct(input)
    if (row.id === input.id) this.trace.created = true
    return row
  }
}

/** The real judge, with its questions recorded. The catalog's other two analyst calls must not happen in this part, so they throw if one does. */
const observedAnalyst = (real: ProductAnalyst, repository: ObservedRepository): ProductAnalyst => ({
  async sameProduct(a, b) {
    const same = await real.sameProduct(a, b)
    const row = repository.offered.find((p) => p.brand === b.brand && p.name === b.name && (p.variant ?? '') === (b.variant ?? '') && p.form === (b.form ?? null) && p.category === b.category)
    repository.trace.questions.push({ candidateRowId: row?.id ?? '?', same })
    return same
  },
  async analyse() {
    throw new Error('the matching part must not analyse')
  },
  async imageShowsProduct() {
    throw new Error('the matching part must not check images')
  },
})

const normalise = (value: string | undefined | null): string => (value ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
const differing = (first: ProductIdentity, other: ProductIdentity): string[] => IDENTITY_FIELDS.filter((field) => normalise(first[field]) !== normalise(other[field]))

type PhotoRecord = PhotoOutcome & { identity?: ProductIdentity; confidence?: number; belowConfirmConfidence?: boolean; reason?: string }

const runOrder = async (seed: number, recognised: Recognised[], analyst: ProductAnalyst): Promise<PhotoRecord[]> => {
  const repository = new ObservedRepository()
  let n = 0
  const service = new ProductCatalogService({
    repository,
    researcher: { research: async () => { throw new Error('the matching part must not research') } },
    analyst: observedAnalyst(analyst, repository),
    images: undefined as never,
    imageKeyPrefix: 'catalog/eval',
    opsAlerts: NO_ALERTS,
    newId: () => `r${++n}`,
  })
  const firstRead = new Map<string, ProductIdentity>()
  const records: PhotoRecord[] = []
  for (const item of seededShuffle(recognised, seed)) {
    const { folder, photo } = item
    if ('error' in item) {
      records.push({ folder, photo: photo.name, error: item.error })
      continue
    }
    if (!('read' in item)) {
      records.push({ folder, photo: photo.name, unreadable: true, reason: item.unreadable })
      continue
    }
    const { identity, confidence } = item.read
    repository.trace = { created: false, questions: [] }
    let resolved
    try {
      // Production would ask for confirmation below the threshold; the eval resolves regardless and records the confidence.
      resolved = await withRetries(() => service.resolve(identity))
    } catch (error) {
      if (error instanceof AnthropicConfigError) throw new SetupError('Claude rejected the API key or the account (check ANTHROPIC_API_KEY and billing).')
      if (errorName(error) === 'CatalogBusyError') throw new SetupError('The spend cap was reached while matching; raise --max-usd.')
      records.push({ folder, photo: photo.name, error: errorName(error) })
      continue
    }
    const { questions, created } = repository.trace
    const first = firstRead.get(folder)
    if (!first) firstRead.set(folder, identity)
    records.push({
      folder,
      photo: photo.name,
      rowId: resolved.productId,
      // An alias the catalog remembered from an earlier judge-same answers by key without asking again, so it reads as exact-key here.
      how: created ? 'new-row' : questions.some((q) => q.same) ? 'judge-same' : 'exact-key',
      judged: questions,
      differs: first ? differing(first, identity) : [],
      identity,
      confidence,
      belowConfirmConfidence: confidence < SCAN_POLICY.confirmBelowConfidence,
    })
  }
  return records
}

const unitDescription = (unit: { source: 'measured' | 'constant' }): string =>
  unit.source === 'measured'
    ? `mean settled research cost of this run + $${ANALYSIS_COST_USD} analysis, a documented constant: analysis never runs here`
    : `one research + one analysis, a documented constant of $${DUPLICATE_COST_USD}: this run settled no research`

const printMatching = (score: MatchingScore, orders: { seed: number; photos: PhotoRecord[] }[], unit: ReturnType<typeof duplicateUnitCost>) => {
  for (const order of score.orders) {
    console.log(`\nMatching, order seed ${order.seed}: repeat-hit ${percent(order.repeatHit)} (${order.hits}/${order.repeats}), ${order.duplicates} duplicates, ${order.unreadable} unreadable, ${order.errors} errored`)
    const width = Math.max('folder'.length, ...order.products.map((p) => p.folder.length))
    console.log(`${'folder'.padEnd(width)}  photos  rows  hits  consistency  causes`)
    for (const p of order.products) {
      const causes = p.duplicates.map((d) => `${d.rowId}:${d.cause}[${d.differs.join(',')}]`).join(' ')
      console.log(`${p.folder.padEnd(width)}  ${String(p.photos).padStart(6)}  ${String(p.rows).padStart(4)}  ${`${p.hits}/${p.repeats}`.padStart(4)}  ${percent(p.consistency).padStart(11)}  ${causes}`)
    }
    for (const merge of order.wrongMerges) console.log(`  WRONG MERGE on ${merge.rowId}: ${merge.folders.join(' + ')}${merge.lookalikes ? ' (declared look-alikes)' : ''}`)
  }
  const tally = orders.flatMap((o) => o.photos).filter((p): p is PhotoRecord & { how: string } => 'how' in p)
  console.log(`\nMatching overall: worst repeat-hit ${percent(score.worstRepeatHit)}, average ${percent(score.averageRepeatHit)}, ${score.wrongMerges} wrong merges, ${score.duplicates} duplicates`)
  console.log(`  how photos resolved: exact-key ${tally.filter((p) => p.how === 'exact-key').length}, judge-same ${tally.filter((p) => p.how === 'judge-same').length}, new-row ${tally.filter((p) => p.how === 'new-row').length}`)
  if (score.errors > 0) console.log(`  ERRORED photos: ${score.errors} (${score.errorNames.join(', ')}); they fail the run`)
  console.log(`  duplicate cost estimate: ${score.duplicates} x $${unit.each.toFixed(4)} = $${duplicateCost(score.duplicates, unit.each).toFixed(2)} (${unitDescription(unit)})`)
}

// ---- images ----

type StoredObject = { bytes: Uint8Array; contentType: string }

/** The two bucket methods the image store and this script use, over a Map. Everything else on R2Bucket is absent on purpose. */
class MemoryBucket {
  readonly objects = new Map<string, StoredObject>()
  async put(key: string, value: Uint8Array, options?: { httpMetadata?: { contentType?: string } }): Promise<null> {
    this.objects.set(key, { bytes: value, contentType: options?.httpMetadata?.contentType ?? 'application/octet-stream' })
    return null
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key)
  }
}

type ImageDetail = ImageOutcome & { stored?: StoredObject }

const runImages = async (products: SetProduct[], realAnalyst: ProductAnalyst, researcher: AnthropicProductResearcher): Promise<ImageDetail[]> => {
  const details: ImageDetail[] = []
  for (const product of products) {
    // The catalog turns a failed image check into an `error` stage; watch it so a spent cap is not read as a broken check.
    let budgetHit = false
    let checkError: string | undefined
    const analyst: ProductAnalyst = {
      analyse: (...args) => realAnalyst.analyse(...args),
      sameProduct: (...args) => realAnalyst.sameProduct(...args),
      async imageShowsProduct(...args) {
        try {
          return await realAnalyst.imageShowsProduct(...args)
        } catch (error) {
          if (error instanceof AiBudgetExceededError) budgetHit = true
          checkError = errorName(error)
          throw error
        }
      },
    }
    const repository = new FakeCatalogRepository()
    const bucket = new MemoryBucket()
    const service = new ProductCatalogService({
      repository,
      researcher,
      analyst,
      images: new R2CatalogImageStore({ bucket: bucket as unknown as R2Bucket, publicBaseUrl: '' }),
      imageKeyPrefix: 'catalog/eval',
      opsAlerts: NO_ALERTS,
    })
    const folder = product.folder
    const stage = async (): Promise<ImageDetail> => {
      try {
        // A fresh catalog holds nothing, so this creates the product from its true label without asking the judge.
        const { productId } = await service.resolve(identityOfLabel(product))
        const result = await withRetries(() => service.research(productId))
        if (result.kind === 'not-found' && result.image === undefined) return { folder, stage: 'no-source-page' }
        if (result.kind === 'budget-exhausted') return { folder, stage: 'budget-exhausted' }
        // From here a found or a not-found research both carry the image stage; a stored image is hashed either way, to be judged.
        if (result.image === 'error') return budgetHit ? { folder, stage: 'budget-exhausted' } : { folder, stage: 'error', error: checkError ?? 'ImageStageError' }
        if (result.image !== 'stored') return { folder, stage: result.image ?? 'error', ...(result.image ? {} : { error: 'NoImageOutcome' }) }
        const key = (await repository.findProductById(productId))?.imageKey
        const stored = key ? bucket.objects.get(key) : undefined
        return stored ? { folder, stage: 'stored', hash: sha256(stored.bytes), stored } : { folder, stage: 'error', error: 'StoredImageMissing' }
      } catch (error) {
        if (error instanceof AnthropicConfigError) throw new SetupError('Claude rejected the API key or the account (check ANTHROPIC_API_KEY and billing).')
        if (error instanceof AiBudgetExceededError || budgetHit) return { folder, stage: 'budget-exhausted' }
        return { folder, stage: 'error', error: errorName(error) }
      }
    }
    details.push(await stage())
  }
  return details
}

const imageCards = (products: SetProduct[], details: ImageDetail[], score: ReturnType<typeof scoreImages>): string => {
  const cards = products.map((product) => {
    const detail = details.find((d) => d.folder === product.folder)!
    const verdict = score.perProduct.find((p) => p.folder === product.folder)?.verdict
    const own = readPhoto(product.photos[0]!)
    const { brand, name, variant } = product.label
    const stored = detail.stored
    return `<section>
<h2>${escapeHtml(product.folder)}: ${escapeHtml([brand, name, variant].filter(Boolean).join(' / '))}</h2>
<p>stage: <b>${escapeHtml(detail.stage)}</b>${verdict ? ` | verdict: <b>${verdict}</b>` : ''}</p>
<div class="pair">
<figure>${stored ? `<img src="${dataUri(stored.contentType, stored.bytes)}">` : '<div class="none">no image stored</div>'}<figcaption>stored image</figcaption></figure>
<figure><img src="${dataUri(own.mediaType, own.bytes)}"><figcaption>your photo (${escapeHtml(product.photos[0]!.name)})</figcaption></figure>
</div>
${detail.hash ? `<p>hash <code>${detail.hash}</code><br>right: <code>npm run eval:matching -- --verdict ${detail.hash}=right</code><br>wrong: <code>npm run eval:matching -- --verdict ${detail.hash}=wrong</code></p>` : ''}
</section>`
  })
  return `<h1>Stock images beside your photos</h1>\n${cards.join('\n')}`
}

const sheetPage = (sections: string[]): string => `<!doctype html><meta charset="utf-8"><title>eval:matching contact sheet</title>
<style>body{font:14px system-ui;margin:2rem}section{border-top:1px solid #ccc;padding:1rem 0}.pair{display:flex;gap:1rem}figure{margin:0}img{max-height:260px;max-width:320px;object-fit:contain;background:#eee}.shelf img{max-height:480px;max-width:640px}.none{width:260px;height:260px;display:grid;place-items:center;background:#eee}code{background:#f3f3f3;padding:2px 4px}</style>
${sections.join('\n')}`

const printImages = (score: ReturnType<typeof scoreImages>) => {
  console.log('\nImages')
  const width = Math.max('folder'.length, ...score.perProduct.map((p) => p.folder.length))
  console.log(`${'folder'.padEnd(width)}  stage             verdict`)
  for (const p of score.perProduct) console.log(`${p.folder.padEnd(width)}  ${p.stage.padEnd(16)}  ${p.verdict ?? ''}${p.hash ? `  ${p.hash.slice(0, 12)}` : ''}`)
  const counts = Object.entries(score.stages).filter(([, count]) => count > 0).map(([stage, count]) => `${stage} ${count}`)
  if (score.errorNames.length > 0) console.log(`  errored images: ${score.errorNames.join(', ')}`)
  console.log(`${score.stored}/${score.products} stored (coverage ${percent(score.coverage)}): ${counts.join(', ')}; ${score.right} right, ${score.wrong} wrong, ${score.unjudged} unjudged`)
}

// ---- shelf ----

/** One product the shelf prompt listed, with what resolve did with it. The identity is model text: it stays in the report file. */
type ShelfListedDetail = { identity: ProductIdentity; confidence: number; belowConfirmConfidence: boolean; landed: string | null; onCreatedRow?: true; questions: JudgeAnswer[] }
type ShelfDetail = {
  input: ShelfPhotoInput
  /** The recognition's own classification and excluded counts; absent when it failed. */
  classification?: ShelfRecognition['classification']
  excluded?: ShelfRecognition['excluded']
  listed: ShelfListedDetail[]
}

type ShelfSeed = { id: string; identity: ProductIdentity; inSet: boolean }

/**
 * The true identity of every product of the single set and of every out-of-set product labelled in a shelf photo, once each. Two
 * different products with one identity key cannot both be a row, so the set is wrong and no number from it would mean anything.
 */
const shelfSeeds = (products: SetProduct[], shelf: ShelfSet): ShelfSeed[] => {
  const byKey = new Map<string, ShelfSeed>()
  const add = (seed: ShelfSeed, where: string) => {
    const key = identityKey(seed.identity)
    const other = byKey.get(key)
    if (other && other.id !== seed.id) throw new SetupError(`${where}: ${seed.identity.brand} / ${seed.identity.name} has the same identity key as ${other.identity.brand} / ${other.identity.name}; one product cannot be two rows.`)
    byKey.set(key, seed)
  }
  for (const product of products) add({ id: product.folder, identity: identityOfLabel(product), inSet: true }, product.folder)
  for (const photo of shelf.photos) {
    for (const product of photo.products) {
      const identity = identityOfLabel(product)
      add({ id: product.folder ?? `shelf:${identityKey(identity)}`, identity, inSet: product.folder !== undefined }, photo.name)
    }
  }
  return [...byKey.values()]
}

/** Fills the catalog with the seeds exactly as findOrCreateProduct would write them, but without asking the judge: similar real products stay separate rows. */
const seedCatalog = async (repository: ObservedRepository, seeds: ShelfSeed[]): Promise<Map<string, string>> => {
  const rows = new Map<string, string>()
  for (const { id, identity } of seeds) {
    const row = await repository.createProduct({
      id: `seed:${id}`,
      identityKey: identityKey(identity),
      brandKey: brandKey(identity.brand),
      kind: 'named',
      brand: identity.brand,
      name: identity.name,
      variant: identity.variant ?? null,
      form: identity.form ?? null,
      category: identity.category,
      searchText: normaliseText(`${identity.brand} ${identity.name} ${identity.variant ?? ''}`),
      createdAt: new Date(),
    })
    rows.set(id, row.id)
  }
  return rows
}

const runShelfPhoto = async (photo: ShelfPhoto, seeds: ShelfSeed[], recognizer: AnthropicProductRecognizer, analyst: ProductAnalyst): Promise<ShelfDetail> => {
  const repository = new ObservedRepository()
  const rows = await seedCatalog(repository, seeds)
  let n = 0
  const service = new ProductCatalogService({
    repository,
    researcher: { research: async () => { throw new Error('the shelf part must not research') } },
    analyst: observedAnalyst(analyst, repository),
    images: undefined as never,
    imageKeyPrefix: 'catalog/eval',
    opsAlerts: NO_ALERTS,
    newId: () => `r${++n}`,
  })
  const labelled = photo.products.map((product) => {
    const id = product.folder ?? `shelf:${identityKey(identityOfLabel(product))}`
    return { id, rowId: rows.get(id)!, brand: product.label.brand, inSet: product.folder !== undefined }
  })
  const failed = (error: string): ShelfDetail => ({ input: { photo: photo.name, labelled, listed: [], error }, listed: [] })

  let seen: ShelfRecognition
  try {
    seen = await withRetries(() => recognizer.recognizeShelf(readPhoto(photo)))
  } catch (error) {
    if (error instanceof AnthropicConfigError) throw new SetupError('Claude rejected the API key or the account (check ANTHROPIC_API_KEY and billing).')
    if (error instanceof AiBudgetExceededError) throw new SetupError('The spend cap was reached while reading shelf photos; raise --max-usd.')
    return failed(errorName(error))
  }
  const listed: ShelfListedDetail[] = []
  // Rows this photo's own listings created: a later listing landing on one is the same product read twice.
  const createdHere = new Set<string>()
  for (const { brand, name, variant, form, category, confidence } of seen.products) {
    const identity: ProductIdentity = { brand, name, category, ...(variant ? { variant } : {}), ...(form ? { form } : {}) }
    repository.trace = { created: false, questions: [] }
    try {
      const resolved = await withRetries(() => service.resolve(identity))
      const { created, questions } = repository.trace
      const onCreatedRow = !created && createdHere.has(resolved.productId)
      if (created) createdHere.add(resolved.productId)
      listed.push({ identity, confidence, belowConfirmConfidence: confidence < SCAN_POLICY.confirmBelowConfidence, landed: created ? null : resolved.productId, ...(onCreatedRow ? { onCreatedRow: true as const } : {}), questions })
    } catch (error) {
      if (error instanceof AnthropicConfigError) throw new SetupError('Claude rejected the API key or the account (check ANTHROPIC_API_KEY and billing).')
      if (errorName(error) === 'CatalogBusyError') throw new SetupError('The spend cap was reached while matching; raise --max-usd.')
      return { ...failed(errorName(error)), classification: seen.classification, excluded: seen.excluded }
    }
  }
  return { input: { photo: photo.name, labelled, listed: listed.map(({ identity, landed, onCreatedRow }) => ({ brand: identity.brand, landed, ...(onCreatedRow ? { onCreatedRow } : {}) })) }, classification: seen.classification, excluded: seen.excluded, listed }
}

const labelledName = (product: ShelfPhoto['products'][number]): string => product.folder ?? `${product.label.brand} / ${product.label.name}`

const printShelf = (score: ShelfScore) => {
  console.log('\nShelf')
  for (const p of score.photos) {
    console.log(`${p.photo}: labelled ${p.labelled}, expected ${p.expected}, found ${p.found}, missing ${p.missing.length}, misread ${p.misread}, invented ${p.invented}, wrong rows ${p.wrongRows}${p.error ? `, ERROR ${p.error}` : ''}`)
  }
  console.log(`Shelf overall: found ${percent(score.foundRate)} (${score.found}/${score.expected}), same row ${percent(score.sameRow)}, ${score.misread} misread, ${score.invented} invented, ${score.wrongRows} wrong rows, ${score.repeat} repeats`)
  if (score.errors > 0) console.log(`  ERRORED photos: ${score.errors} (${score.errorNames.join(', ')}); they fail the run`)
}

const shelfCards = (shelf: ShelfSet, details: ShelfDetail[], score: ShelfScore): string => {
  const cards = shelf.photos.map((photo, index) => {
    const detail = details[index]!
    const result = score.photos[index]!
    const image = readPhoto(photo)
    const labelled = photo.products.map((product, i) => {
      const missing = result.missing.includes(detail.input.labelled[i]!.id)
      return `<li>${escapeHtml(labelledName(product))}${product.folder ? '' : ' (not in the single set)'}: <b>${missing ? 'missing' : 'found'}</b></li>`
    })
    const listed = detail.listed.map((item, i) => {
      const { brand, name, variant, form } = item.identity
      return `<li><b>${result.outcomes[i]}</b>: ${escapeHtml([brand, name, variant, form].filter(Boolean).join(' / '))} (confidence ${item.confidence.toFixed(2)}${item.belowConfirmConfidence ? ', below the confirm threshold' : ''})</li>`
    })
    const { classification, excluded } = detail
    return `<section class="shelf">
<h2>${escapeHtml(photo.name)}</h2>
${result.error ? `<p>recognition failed: <b>${escapeHtml(result.error)}</b></p>` : ''}
<figure><img src="${dataUri(image.mediaType, image.bytes)}"></figure>
<p>labelled in the photo:</p><ul>${labelled.join('')}</ul>
<p>listed${classification ? ` (classification ${escapeHtml(classification)}, ${excluded?.otherProducts ?? 0} other products and ${excluded?.unreadable ?? 0} unreadable left out)` : ''}:</p><ul>${listed.join('') || '<li>nothing</li>'}</ul>
</section>`
  })
  return `<h1>Shelf photos: what was listed</h1>\n${cards.join('\n')}`
}

// ---- run ----

const main = async (): Promise<number> => {
  let split, args, env, set: PhotoSet, verdicts: Verdicts, shelfSet: ShelfSet | null = null, seeds: ShelfSeed[] = []
  try {
    split = splitArgs(process.argv.slice(2))
    if (split.verdicts.length > 0) {
      if (split.rest.length > 0) throw new SetupError(`--verdict records verdicts and spends nothing; give it alone. ${USAGE}`)
      const recorded = await recordVerdicts(DIRECTORY, Object.fromEntries(split.verdicts.map(parseVerdictFlag)))
      console.log(`Recorded ${split.verdicts.length} verdicts in ${DIRECTORY}/verdicts.json (${Object.keys(recorded).length} in the file). Nothing was spent.`)
      return 0
    }
    args = parseArgs(split.rest, USAGE)
    // The set and verdicts first: a missing photo set must be the message, not a missing key.
    set = await loadPhotoSet(DIRECTORY)
    verdicts = await loadVerdicts(DIRECTORY)
    if (split.part === 'shelf' || split.part === 'all') {
      const catalogLabels = Object.fromEntries(set.products.map((p) => [p.folder, p.label]))
      shelfSet = await loadShelfSet(SHELF_DIRECTORY, catalogLabels)
      if (shelfSet) seeds = shelfSeeds(set.products, shelfSet)
      else if (split.part === 'shelf') throw new SetupError(`${SHELF_DIRECTORY} does not exist: put your shelf photos and labels.json there (see the header of scripts/eval/matching.ts).`)
      else console.log(`Shelf part skipped: ${SHELF_DIRECTORY} does not exist.`)
    }
    env = await loadEnv()
  } catch (error) {
    console.error((error as Error).message)
    return 2
  }
  const maxUsd = split.maxUsdGiven ? args.maxUsd : DEFAULT_MAX_USD
  const models = { ...DEFAULT_MODELS, ...args.models }
  const ledger = new WatchedLedger({ capMicros: Math.round(maxUsd * 1_000_000) })
  const client = new AnthropicClient({ apiKey: env.apiKey, models, ledger })
  const analyst = new AnthropicProductAnalyst(client)

  const products = set.products.slice(0, args.limit)
  const labels = Object.fromEntries(products.map((p) => [p.folder, { lookalikes: p.label.lookalikes }]))
  const startedAt = new Date()
  console.log(`Matching eval: part ${split.part}, ${products.length} products, ${products.reduce((n, p) => n + p.photos.length, 0)} photos${shelfSet ? `, ${shelfSet.photos.length} shelf photos` : ''}, cap ${usd(ledger.capMicros)}`)
  console.log(`Models: recognize ${models.recognize}, same-product ${models['same-product']}, research ${models.research}, image-check ${models['image-check']}`)

  let matching: MatchingScore | undefined
  let orders: { seed: number; photos: PhotoRecord[] }[] = []
  let images: ReturnType<typeof scoreImages> | undefined
  let imageDetails: ImageDetail[] = []
  let shelf: ShelfScore | undefined
  let shelfDetails: ShelfDetail[] = []
  try {
    if (split.part === 'matching' || split.part === 'all') {
      const recognised = await recogniseOnce(new AnthropicProductRecognizer(client), products)
      orders = []
      for (const seed of SEEDS) orders.push({ seed, photos: await runOrder(seed, recognised, analyst) })
      matching = scoreMatching(orders, labels)
    }
    if (split.part === 'images' || split.part === 'all') {
      imageDetails = await runImages(products, analyst, new AnthropicProductResearcher(client))
      images = scoreImages(imageDetails, verdicts)
    }
    if (shelfSet) {
      const recognizer = new AnthropicProductRecognizer(client)
      for (const photo of shelfSet.photos) shelfDetails.push(await runShelfPhoto(photo, seeds, recognizer, analyst))
      shelf = scoreShelf(shelfDetails.map((d) => d.input))
    }
  } catch (error) {
    if (!(error instanceof SetupError)) throw error
    console.error(error.message)
    return 2
  }

  // After the images part, so its settled research calls can price a duplicate.
  const unit = duplicateUnitCost(images ? ledger.entries : [])
  if (matching) printMatching(matching, orders, unit)
  if (images) printImages(images)
  if (shelf) printShelf(shelf)

  const verdict = judge({ matching, images, shelf })
  console.log(`\n${verdict.summary}`)
  console.log(`Spent ${usd(ledger.spentMicros())} of ${usd(ledger.capMicros)}`)

  // No colons: the folder name is also an artifact path.
  const folder = join('.eval', 'matching', startedAt.toISOString().replace(/:/g, '-'))
  mkdirSync(folder, { recursive: true })
  const report = {
    startedAt: startedAt.toISOString(),
    part: split.part,
    maxUsd,
    models,
    spentMicros: ledger.spentMicros(),
    duplicateCost: { eachUsd: unit.each, source: unit.source, description: unitDescription(unit), documentedConstantUsd: DUPLICATE_COST_USD },
    spendCapReached: ledger.refused,
    matching: matching && { score: matching, photos: orders },
    images: images && { score: images, hashes: imageDetails.map(({ folder: name, stage, hash, error }) => ({ folder: name, stage, hash, error })) },
    shelf: shelf && { score: shelf, photos: shelfDetails.map(({ input, classification, excluded, listed }) => ({ photo: input.photo, error: input.error, classification, excluded, labelled: input.labelled, listed })) },
    verdict,
  }
  writeFileSync(join(folder, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(`Report: ${join(folder, 'report.json')}`)
  if (images || shelf) {
    writeFileSync(join(folder, 'contact-sheet.html'), sheetPage([...(images ? [imageCards(products, imageDetails, images)] : []), ...(shelf && shelfSet ? [shelfCards(shelfSet, shelfDetails, shelf)] : [])]))
    console.log(`Contact sheet: ${join(folder, 'contact-sheet.html')}`)
  }
  if (images) {
    for (const p of images.perProduct.filter((x) => x.verdict === 'unjudged')) console.log(`  judge ${p.folder}: npm run eval:matching -- --verdict ${p.hash}=right|wrong`)
  }
  if (ledger.refused) {
    console.error(`\nSPEND CAP REACHED: results incomplete. The ${usd(ledger.capMicros)} cap refused a call, so the numbers above are not the whole picture; raise --max-usd and run again.`)
    return 2
  }
  return exitCode(verdict)
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    console.error(`The eval stopped on an unexpected ${errorName(error)}.`)
    process.exitCode = 2
  },
)
