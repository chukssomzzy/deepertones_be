// Measures whether the catalog's matching and stock images hold up on the owner's own photos: `npm run eval:matching`.
// Photos live in eval-photos/catalog/<product folder>/*.{jpg,jpeg,png,webp} (at least 2 per product), beside labels.json:
//   { "<folder>": { "brand": "...", "name": "...", "variant"?: "...", "form"?: "<form>", "category": "skin|hair|body|makeup|other", "lookalikes"?: ["<folder>"] } }
// and verdicts.json ({ "<sha256 of an image>": "right" | "wrong" }, written by --verdict). Look-alikes are declared on both sides. All git-ignored.
// Needs ANTHROPIC_API_KEY (environment, else .dev.vars) and makes real, billed calls. Report-only: never part of `npm test`.
//   matching  every photo is read once, then fed to a fresh in-memory catalog in 3 fixed random orders: do repeat photos of a product find its row?
//   images    each product is created from its label and researched for real; the stock image it stores is saved for you to judge.
//   --part matching|images|all   (default all)    --max-usd N   stop spending at N dollars (default 3)    --limit N   products to run
//   --model JOB=MODEL   run a job on another model (repeatable)
//   --verdict HASH=right|wrong   record your verdict on a stored image (repeatable); makes no calls, spends nothing, then exits 0
// Reports go to .eval/matching/<timestamp>/: report.json and contact-sheet.html (the stored images beside your photos, each with the
// command that records your verdict). The report may hold what the model read from your labels; the console never does: it prints only
// folder names, short row ids, codes, field names and numbers, never a prompt, the key or other model text.
// Exit: 0 every target of the parts that ran was met, 1 one was missed, 2 the run could not start (photo set, verdicts, arguments, key).
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FakeCatalogRepository } from '../../src/modules/catalog/catalog.repository.fake'
import type { NewProduct, Product } from '../../src/modules/catalog/catalog.types'
import { ProductCatalogService } from '../../src/modules/catalog/catalog.service'
import type { OpsAlertsService } from '../../src/modules/ops-alerts/ops-alerts.service'
import { SCAN_POLICY } from '../../src/modules/scans/scans.service'
import { AiBudgetExceededError } from '../../src/providers/anthropic/ai-spend.provider'
import { AnthropicClient } from '../../src/providers/anthropic/anthropic.client'
import { AnthropicConfigError } from '../../src/providers/anthropic/anthropic.provider'
import { MemoryAiSpendLedger } from '../../src/providers/anthropic/memory.ai-spend-ledger'
import { R2CatalogImageStore } from '../../src/providers/catalog-images/r2.catalog-image-store'
import type { ProductAnalyst, ProductImage } from '../../src/providers/product-analysis/product-analyst.provider'
import { AnthropicProductAnalyst } from '../../src/providers/product-analysis/anthropic.product-analyst'
import { AnthropicProductRecognizer } from '../../src/providers/product-recognition/anthropic.product-recognizer'
import type { Recognition } from '../../src/providers/product-recognition/product-recognizer.provider'
import { AnthropicProductResearcher } from '../../src/providers/product-research/anthropic.product-researcher'
import type { ProductIdentity } from '../../src/providers/product-research/product-researcher.provider'
import { DEFAULT_MODELS } from './models'
import {
  duplicateCost,
  DUPLICATE_COST_USD,
  exitCode,
  type ImageOutcome,
  type ImageStage,
  judge,
  type MatchingScore,
  type OrderScore,
  type PhotoOutcome,
  scoreImages,
  scoreMatching,
} from './matching-score'
import {
  loadPhotoSet,
  loadVerdicts,
  parseVerdictFlag,
  type PhotoSet,
  recordVerdicts,
  SEEDS,
  seededShuffle,
  type SetPhoto,
  type SetProduct,
  type Verdicts,
} from './matching-set'
import { loadEnv, parseArgs } from './score'

const DIRECTORY = 'eval-photos/catalog'
const DEFAULT_MAX_USD = 3
const PARTS = ['matching', 'images', 'all'] as const
type Part = (typeof PARTS)[number]
const IDENTITY_FIELDS = ['brand', 'name', 'variant', 'form', 'category'] as const

const USAGE = 'Usage: npm run eval:matching -- [--part matching|images|all] [--limit N] [--max-usd N] [--model JOB=MODEL]... [--verdict HASH=right|wrong]...'

/** The run cannot go on and the numbers would say nothing about the code: exit 2, not 1. */
class SetupError extends Error {}

const usd = (micros: number): string => `$${(micros / 1_000_000).toFixed(4)}`
const percent = (ratio: number): string => `${Math.round(ratio * 100)}%`
const errorName = (error: unknown): string => (error instanceof Error ? error.name : 'UnknownError')
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

const identityOfLabel = (product: SetProduct): ProductIdentity => {
  const { brand, name, variant, form, category } = product.label
  return { brand, name, category, ...(variant ? { variant } : {}), ...(form ? { form } : {}) }
}

/** The service needs an alerts service; the eval has nobody to email, and it raises nothing below 200 researches. */
const NO_ALERTS = { raise: async () => undefined } as unknown as OpsAlertsService

// ---- matching ----

type Read = { identity: ProductIdentity; confidence: number }
/** What recognising a photo gave: a readable beauty product, or nothing to match (the classification is a fixed code). */
type Recognised = { photo: SetPhoto; folder: string; read: Read } | { photo: SetPhoto; folder: string; unreadable: string }

const recogniseOnce = async (recognizer: AnthropicProductRecognizer, products: SetProduct[]): Promise<Recognised[]> => {
  const out: Recognised[] = []
  for (const product of products) {
    for (const photo of product.photos) {
      let seen: Recognition
      try {
        seen = await recognizer.recognize(readPhoto(photo))
      } catch (error) {
        if (error instanceof AnthropicConfigError) throw new SetupError('Claude rejected the API key or the account (check ANTHROPIC_API_KEY and billing).')
        if (error instanceof AiBudgetExceededError) throw new SetupError('The spend cap was reached while reading photos; raise --max-usd.')
        out.push({ photo, folder: product.folder, unreadable: errorName(error) })
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
type Trace = { foundByKey: boolean; created: boolean; questions: JudgeAnswer[] }

/** The in-memory repository, watched: what resolve found by key, what it created, and which rows it offered the judge. Behaviour is unchanged. */
class ObservedRepository extends FakeCatalogRepository {
  trace: Trace = { foundByKey: false, created: false, questions: [] }
  offered: Product[] = []

  override async findProductByKey(key: string): Promise<Product | null> {
    const found = await super.findProductByKey(key)
    if (found) this.trace.foundByKey = true
    return found
  }

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
    if (!('read' in item)) {
      records.push({ folder, photo: photo.name, unreadable: true, reason: item.unreadable })
      continue
    }
    const { identity, confidence } = item.read
    repository.trace = { foundByKey: false, created: false, questions: [] }
    let resolved
    try {
      // Production would ask for confirmation below the threshold; the eval resolves regardless and records the confidence.
      resolved = await service.resolve(identity)
    } catch (error) {
      if (error instanceof AnthropicConfigError) throw new SetupError('Claude rejected the API key or the account (check ANTHROPIC_API_KEY and billing).')
      if (errorName(error) === 'CatalogBusyError') throw new SetupError('The spend cap was reached while matching; raise --max-usd.')
      records.push({ folder, photo: photo.name, unreadable: true, reason: errorName(error) })
      continue
    }
    const { questions, created } = repository.trace
    const first = firstRead.get(folder)
    if (!first) firstRead.set(folder, identity)
    records.push({
      folder,
      photo: photo.name,
      rowId: resolved.productId,
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

const printMatching = (score: MatchingScore, orders: { seed: number; photos: PhotoRecord[] }[]) => {
  for (const order of score.orders) {
    console.log(`\nMatching, order seed ${order.seed}: repeat-hit ${percent(order.repeatHit)} (${order.hits}/${order.repeats}), ${order.duplicates} duplicates, ${order.unreadable} unreadable`)
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
  console.log(`  duplicate cost estimate: ${score.duplicates} x $${DUPLICATE_COST_USD} (one research + one analysis, a documented constant: this part calls neither) = $${duplicateCost(score.duplicates).toFixed(2)}`)
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

const runImages = async (products: SetProduct[], analyst: ProductAnalyst, researcher: AnthropicProductResearcher): Promise<ImageDetail[]> => {
  const details: ImageDetail[] = []
  for (const product of products) {
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
        const result = await service.research(productId)
        if (result.kind === 'not-found') return { folder, stage: 'no-source-page' }
        if (result.kind === 'budget-exhausted') return { folder, stage: 'budget-exhausted' }
        if (result.image !== 'stored') return { folder, stage: result.image ?? 'error' }
        const key = (await repository.findProductById(productId))?.imageKey
        const stored = key ? bucket.objects.get(key) : undefined
        return stored ? { folder, stage: 'stored', hash: sha256(stored.bytes), stored } : { folder, stage: 'error' }
      } catch (error) {
        if (error instanceof AnthropicConfigError) throw new SetupError('Claude rejected the API key or the account (check ANTHROPIC_API_KEY and billing).')
        return { folder, stage: 'error' }
      }
    }
    details.push(await stage())
  }
  return details
}

const contactSheet = (products: SetProduct[], details: ImageDetail[], score: ReturnType<typeof scoreImages>): string => {
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
  return `<!doctype html><meta charset="utf-8"><title>eval:matching contact sheet</title>
<style>body{font:14px system-ui;margin:2rem}section{border-top:1px solid #ccc;padding:1rem 0}.pair{display:flex;gap:1rem}figure{margin:0}img{max-height:260px;max-width:320px;object-fit:contain;background:#eee}.none{width:260px;height:260px;display:grid;place-items:center;background:#eee}code{background:#f3f3f3;padding:2px 4px}</style>
<h1>Stock images beside your photos</h1>
${cards.join('\n')}`
}

const printImages = (score: ReturnType<typeof scoreImages>) => {
  console.log('\nImages')
  const width = Math.max('folder'.length, ...score.perProduct.map((p) => p.folder.length))
  console.log(`${'folder'.padEnd(width)}  stage             verdict`)
  for (const p of score.perProduct) console.log(`${p.folder.padEnd(width)}  ${p.stage.padEnd(16)}  ${p.verdict ?? ''}${p.hash ? `  ${p.hash.slice(0, 12)}` : ''}`)
  const counts = Object.entries(score.stages).filter(([, count]) => count > 0).map(([stage, count]) => `${stage} ${count}`)
  console.log(`${score.stored}/${score.products} stored (coverage ${percent(score.coverage)}): ${counts.join(', ')}; ${score.right} right, ${score.wrong} wrong, ${score.unjudged} unjudged`)
}

// ---- run ----

const main = async (): Promise<number> => {
  let split, args, env, set: PhotoSet, verdicts: Verdicts
  try {
    split = splitArgs(process.argv.slice(2))
    if (split.verdicts.length > 0) {
      if (split.rest.length > 0) throw new SetupError(`--verdict records verdicts and spends nothing; give it alone. ${USAGE}`)
      const recorded = await recordVerdicts(DIRECTORY, Object.fromEntries(split.verdicts.map(parseVerdictFlag)))
      console.log(`Recorded ${split.verdicts.length} verdicts in ${DIRECTORY}/verdicts.json (${Object.keys(recorded).length} in the file). Nothing was spent.`)
      return 0
    }
    args = parseArgs(split.rest)
    env = await loadEnv()
    set = await loadPhotoSet(DIRECTORY)
    verdicts = await loadVerdicts(DIRECTORY)
  } catch (error) {
    console.error((error as Error).message)
    return 2
  }
  const maxUsd = split.maxUsdGiven ? args.maxUsd : DEFAULT_MAX_USD
  const models = { ...DEFAULT_MODELS, ...args.models }
  const ledger = new MemoryAiSpendLedger({ capMicros: Math.round(maxUsd * 1_000_000) })
  const client = new AnthropicClient({ apiKey: env.apiKey, models, ledger })
  const analyst = new AnthropicProductAnalyst(client)

  const products = set.products.slice(0, args.limit)
  const labels = Object.fromEntries(products.map((p) => [p.folder, { lookalikes: p.label.lookalikes }]))
  const startedAt = new Date()
  console.log(`Matching eval: part ${split.part}, ${products.length} products, ${products.reduce((n, p) => n + p.photos.length, 0)} photos, cap ${usd(ledger.capMicros)}`)
  console.log(`Models: recognize ${models.recognize}, same-product ${models['same-product']}, research ${models.research}, image-check ${models['image-check']}`)

  let matching: MatchingScore | undefined
  let orders: { seed: number; photos: PhotoRecord[] }[] = []
  let images: ReturnType<typeof scoreImages> | undefined
  let imageDetails: ImageDetail[] = []
  try {
    if (split.part !== 'images') {
      const recognised = await recogniseOnce(new AnthropicProductRecognizer(client), products)
      orders = []
      for (const seed of SEEDS) orders.push({ seed, photos: await runOrder(seed, recognised, analyst) })
      matching = scoreMatching(orders as { seed: number; photos: PhotoOutcome[] }[], labels)
      printMatching(matching, orders)
    }
    if (split.part !== 'matching') {
      imageDetails = await runImages(products, analyst, new AnthropicProductResearcher(client))
      images = scoreImages(imageDetails, verdicts)
      printImages(images)
    }
  } catch (error) {
    if (!(error instanceof SetupError)) throw error
    console.error(error.message)
    return 2
  }

  const verdict = judge({ matching, images })
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
    duplicateCostUsdEach: DUPLICATE_COST_USD,
    matching: matching && { score: matching, photos: orders },
    images: images && { score: images, hashes: imageDetails.map(({ folder: name, stage, hash }) => ({ folder: name, stage, hash })) },
    verdict,
  }
  writeFileSync(join(folder, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
  console.log(`Report: ${join(folder, 'report.json')}`)
  if (images) {
    writeFileSync(join(folder, 'contact-sheet.html'), contactSheet(products, imageDetails, images))
    console.log(`Contact sheet: ${join(folder, 'contact-sheet.html')}`)
    for (const p of images.perProduct.filter((x) => x.verdict === 'unjudged')) console.log(`  judge ${p.folder}: npm run eval:matching -- --verdict ${p.hash}=right|wrong`)
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
