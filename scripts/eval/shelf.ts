// Scores the shelf recognizer on the owner's own photos: `npm run eval:shelf`.
// Photos and answers live in eval-photos/shelf/ (git-ignored, never committed): expected.json is
// { "<photo file>": [{ "brand": "...", "name": "..." }] } and the photos sit beside it (.jpg, .jpeg, .png or .webp).
// Needs ANTHROPIC_API_KEY (environment, else .dev.vars) and makes real, billed calls. Report-only: never part of `npm test`.
// It prints only the file name and the brand and name of products, never a prompt, the key or other model text.
//   --max-usd N   stop spending at N dollars (default 2)    --model recognize-shelf=MODEL   run on another model
//   --limit N   photos to run
// Exit: 0 the run finished, 2 it could not start. How good the reading was is for you to judge from the numbers.
import { readFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { AnthropicClient } from '../../src/providers/anthropic/anthropic.client'
import { AnthropicConfigError } from '../../src/providers/anthropic/anthropic.provider'
import { MemoryAiSpendLedger } from '../../src/providers/anthropic/memory.ai-spend-ledger'
import type { ProductImage } from '../../src/providers/product-analysis/product-analyst.provider'
import { AnthropicProductRecognizer } from '../../src/providers/product-recognition/anthropic.product-recognizer'
import { DEFAULT_MODELS } from './models'
import { loadEnv, parseArgs } from './score'
import { type ShelfEntry, type ShelfScore, scoreShelf, summariseShelf } from './shelf-score'

const DIRECTORY = 'eval-photos/shelf'
const MEDIA_TYPES: Record<string, ProductImage['mediaType']> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }

const usd = (micros: number): string => `$${(micros / 1_000_000).toFixed(4)}`
const label = (entry: ShelfEntry): string => `${entry.brand} / ${entry.name}`
const percent = (ratio: number): string => `${Math.round(ratio * 100)}%`

const readExpected = (): Record<string, ShelfEntry[]> => {
  let text: string
  try {
    text = readFileSync(join(DIRECTORY, 'expected.json'), 'utf8')
  } catch {
    throw new Error(`${DIRECTORY}/expected.json is missing. Put your photos and expected.json in ${DIRECTORY}/ (see the header of this file).`)
  }
  const parsed: unknown = JSON.parse(text)
  const valid =
    typeof parsed === 'object' &&
    parsed !== null &&
    Object.values(parsed).every((list) => Array.isArray(list) && list.every((e) => typeof e?.brand === 'string' && typeof e?.name === 'string'))
  if (!valid) throw new Error('expected.json must be { "<file>": [{ "brand": "...", "name": "..." }] }.')
  return parsed as Record<string, ShelfEntry[]>
}

const main = async (): Promise<number> => {
  let args, env, expected
  try {
    args = parseArgs(process.argv.slice(2))
    env = await loadEnv()
    expected = readExpected()
  } catch (error) {
    console.error((error as Error).message)
    return 2
  }
  const models = { ...DEFAULT_MODELS, ...args.models }
  const ledger = new MemoryAiSpendLedger({ capMicros: Math.round(args.maxUsd * 1_000_000) })
  const recognizer = new AnthropicProductRecognizer(new AnthropicClient({ apiKey: env.apiKey, models, ledger }))

  const files = Object.keys(expected).slice(0, args.limit)
  console.log(`Shelf eval: ${files.length} photos, model ${models['recognize-shelf']}, cap ${usd(ledger.capMicros)}`)

  const scores: ShelfScore[] = []
  for (const file of files) {
    const mediaType = MEDIA_TYPES[extname(file).toLowerCase()]
    if (!mediaType) {
      console.error(`${file}: not a .jpg, .jpeg, .png or .webp photo.`)
      return 2
    }
    let bytes: Uint8Array
    try {
      bytes = readFileSync(join(DIRECTORY, file))
    } catch {
      console.error(`${file}: cannot be read from ${DIRECTORY}/.`)
      return 2
    }
    let result
    try {
      result = await recognizer.recognizeShelf({ bytes, mediaType })
    } catch (error) {
      if (error instanceof AnthropicConfigError) {
        console.error('Claude rejected the API key or the account (check ANTHROPIC_API_KEY and billing).')
        return 2
      }
      console.log(`\n${file}: failed with ${error instanceof Error ? error.name : 'UnknownError'}`)
      continue
    }
    const score = scoreShelf(expected[file]!, result.products)
    scores.push(score)
    console.log(`\n${file}: expected ${score.expected}, found ${score.found}, matched ${score.matched} (recall ${percent(score.recall)}, precision ${percent(score.precision)})`)
    console.log(`  excluded: ${result.excluded.otherProducts} not beauty, ${result.excluded.unreadable} unreadable`)
    for (const entry of score.missing) console.log(`  missing: ${label(entry)}`)
    for (const entry of score.extra) console.log(`  extra:   ${label(entry)}`)
  }

  const summary = summariseShelf(scores)
  console.log(
    `\nOverall: ${summary.photos} photos, ${summary.matched}/${summary.expected} expected found, ${summary.found} found: recall ${percent(summary.recall)}, precision ${percent(summary.precision)}, ${usd(ledger.spentMicros())} spent`,
  )
  return 0
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    console.error(`The eval stopped on an unexpected ${error instanceof Error ? error.name : 'UnknownError'}.`)
    process.exitCode = 2
  },
)
