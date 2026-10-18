import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

// Env blocks do not inherit `triggers`, so each deployed environment must restate the cron.
const config = ts.parseConfigFileTextToJson('wrangler.jsonc', readFileSync('wrangler.jsonc', 'utf8')).config as {
  triggers?: { crons?: string[] }
  env: Record<string, { triggers?: { crons?: string[] } }>
}

// The Worker's `scheduled` handler picks the job by the cron that fired, so a cron here that the code does not know does
// nothing, and a job whose cron is missing here never runs. Both are pinned: the daily guest cleanup at 03:17 UTC (off the
// hour, to dodge the top-of-hour rush) and the scan reaper every 10 minutes.
const GUEST_CLEANUP_CRON = '17 3 * * *'
const SCAN_REAPER_CRON = '*/10 * * * *'

describe('wrangler.jsonc cron triggers', () => {
  const places: [string, string[] | undefined][] = [
    ['top level', config.triggers?.crons],
    ['env.staging', config.env.staging?.triggers?.crons],
    ['env.production', config.env.production?.triggers?.crons],
  ]

  it.each(places)('%s has exactly the daily guest cleanup and the 10 minute scan reaper', (_, crons) => {
    expect([...(crons ?? [])].sort()).toEqual([GUEST_CLEANUP_CRON, SCAN_REAPER_CRON].sort())
  })
})

// Env blocks do not inherit bindings, vars or secrets either, so each block restates the catalog's.
type Block = {
  r2_buckets?: { binding: string; bucket_name: string }[]
  vars?: Record<string, string>
  secrets?: { required?: string[] }
}
const catalogConfig = config as unknown as Block & { env: Record<string, Block> }

const blocks: [string, Block | undefined, { bucket: string; publicUrl: string; dailyBudgetUsd: string }][] = [
  ['top level', catalogConfig, { bucket: 'deepertones-assets', publicUrl: '', dailyBudgetUsd: '1' }],
  ['env.staging', catalogConfig.env.staging, { bucket: 'deepertones-assets', publicUrl: 'https://assets.deepertones.com', dailyBudgetUsd: '5' }],
  ['env.production', catalogConfig.env.production, { bucket: 'deepertones-assets', publicUrl: 'https://assets.deepertones.com', dailyBudgetUsd: '30' }],
]

describe('wrangler.jsonc product catalog config', () => {
  it.each(blocks)('%s binds the catalog image bucket as CATALOG_IMAGES', (_, block, expected) => {
    expect(block?.r2_buckets?.find((b) => b.binding === 'CATALOG_IMAGES')?.bucket_name).toBe(expected.bucket)
  })

  // Cost-effective by default (Haiku for research, vision and judging), a better model for the text users read.
  it.each(blocks)('%s sets the cheap model for research, vision and the same-product judge, and the better one for the analysis', (_, block) => {
    expect(block?.vars?.ANTHROPIC_MODEL_RESEARCH).toBe('claude-haiku-5-5')
    expect(block?.vars?.ANTHROPIC_MODEL_VISION).toBe('claude-haiku-5-5')
    expect(block?.vars?.ANTHROPIC_MODEL_JUDGE).toBe('claude-haiku-5-5')
    expect(block?.vars?.ANTHROPIC_MODEL_ANALYSIS).toBe('claude-sonnet-5-5')
  })

  it.each(blocks)('%s sets its own cheap model for the shelf recognizer, so the eval can move it alone', (_, block) => {
    expect(block?.vars?.ANTHROPIC_MODEL_RECOGNIZE_SHELF).toBe('claude-haiku-5-5')
  })

  it.each(blocks)('%s no longer sets the single ANTHROPIC_MODEL', (_, block) => {
    expect(block?.vars).not.toHaveProperty('ANTHROPIC_MODEL')
  })

  it.each(blocks)('%s sets the daily AI spend cap in USD', (_, block, expected) => {
    expect(block?.vars?.AI_DAILY_BUDGET_USD).toBe(expected.dailyBudgetUsd)
  })

  // Where the owner is emailed when an environment-wide limit trips or Claude refuses our account (see "Ops alerts" in docs/architecture.md).
  // Not a secret, and empty is allowed: the owner fills it in, and an empty one makes the alert job log and ack instead of sending.
  it.each(blocks)('%s sets OPS_ALERT_EMAIL, a string, so the alert job can read it', (_, block) => {
    expect(block?.vars).toHaveProperty('OPS_ALERT_EMAIL')
    expect(typeof block?.vars?.OPS_ALERT_EMAIL).toBe('string')
  })

  it.each(blocks)('%s sets where catalog images are served from', (_, block, expected) => {
    expect(block?.vars?.CATALOG_IMAGES_PUBLIC_URL).toBe(expected.publicUrl)
  })

  it.each(blocks)('%s requires ANTHROPIC_API_KEY as a secret', (_, block) => {
    expect(block?.secrets?.required).toContain('ANTHROPIC_API_KEY')
  })
})

// Users' product photos are private: one private bucket for every environment, told apart by key prefix
// (photos/<environment>/…), with no public address. It sits beside the public assets bucket, never in its place.
describe('wrangler.jsonc private photo storage', () => {
  it.each(blocks)('%s binds the private photo bucket as PRIVATE_PHOTOS', (_, block) => {
    expect(block?.r2_buckets?.find((b) => b.binding === 'PRIVATE_PHOTOS')?.bucket_name).toBe('deepertones-private')
  })

  it.each(blocks)('%s keeps the public CATALOG_IMAGES binding next to it, as the only other R2 binding', (_, block) => {
    const buckets = Object.fromEntries((block?.r2_buckets ?? []).map((b) => [b.binding, b.bucket_name]))
    expect(buckets).toEqual({ CATALOG_IMAGES: 'deepertones-assets', PRIVATE_PHOTOS: 'deepertones-private' })
  })
})

// The scan flow's background work: one queue (and its dead-letter queue) per environment, like OTP delivery.
// Env blocks do not inherit queues or rate limits, so each block restates them.
type QueueConsumer = { queue: string; max_batch_size?: number; max_batch_timeout?: number; max_retries?: number; dead_letter_queue?: string }
type QueueBlock = {
  queues?: { producers?: { binding: string; queue: string }[]; consumers?: QueueConsumer[] }
  ratelimits?: { name: string; namespace_id: string }[]
}
const queueConfig = config as unknown as QueueBlock & { env: Record<string, QueueBlock> }

const scanBlocks: [string, QueueBlock | undefined, string][] = [
  ['top level', queueConfig, 'development'],
  ['env.staging', queueConfig.env.staging, 'staging'],
  ['env.production', queueConfig.env.production, 'production'],
]

describe('wrangler.jsonc scan queues', () => {
  it.each(scanBlocks)('%s produces to the scan-items queue as SCAN_ITEMS_QUEUE', (_, block, environment) => {
    expect(block?.queues?.producers?.find((p) => p.binding === 'SCAN_ITEMS_QUEUE')?.queue).toBe(`deepertones-scan-items-${environment}`)
  })

  it.each(scanBlocks)('%s consumes the scan-items queue in batches of 10 with a 1 second wait, 4 retries, then its dead-letter queue', (_, block, environment) => {
    const consumer = block?.queues?.consumers?.find((c) => c.queue === `deepertones-scan-items-${environment}`)

    expect(consumer).toMatchObject({
      max_batch_size: 10,
      max_batch_timeout: 1,
      max_retries: 4,
      dead_letter_queue: `deepertones-scan-items-dlq-${environment}`,
    })
  })

  it.each(scanBlocks)('%s consumes the scan-items dead-letter queue, so dead letters reach the job\'s dead-letter hook', (_, block, environment) => {
    const consumer = block?.queues?.consumers?.find((c) => c.queue === `deepertones-scan-items-dlq-${environment}`)

    expect(consumer).toMatchObject({ max_batch_size: 10 })
  })

  // The shared email queue (the ops alert email now, every other email kind later): one queue (and its dead-letter queue) per environment, like the others.
  it.each(scanBlocks)('%s produces to the email queue as EMAIL_QUEUE', (_, block, environment) => {
    expect(block?.queues?.producers?.find((p) => p.binding === 'EMAIL_QUEUE')?.queue).toBe(`deepertones-email-${environment}`)
  })

  it.each(scanBlocks)('%s consumes the email queue with a dead-letter queue, and consumes that dead-letter queue too', (_, block, environment) => {
    const main = block?.queues?.consumers?.find((c) => c.queue === `deepertones-email-${environment}`)
    const deadLetter = block?.queues?.consumers?.find((c) => c.queue === `deepertones-email-dlq-${environment}`)

    expect(main).toMatchObject({ dead_letter_queue: `deepertones-email-dlq-${environment}` })
    expect(deadLetter).toBeDefined()
  })

  it.each(scanBlocks)('%s keeps the OTP delivery queue it already had', (_, block, environment) => {
    expect(block?.queues?.producers?.find((p) => p.binding === 'OTP_DELIVERY_QUEUE')?.queue).toBe(`deepertones-otp-delivery-${environment}`)
    expect(block?.queues?.consumers?.map((c) => c.queue)).toContain(`deepertones-otp-delivery-${environment}`)
  })
})

// Onboarding's safety parse: one queue (and its dead-letter queue) per environment, like the scan items. Nobody waits for it, so the
// consumer keeps the standard 5 attempts and nothing is asked of its batching.
describe('wrangler.jsonc parse-safety queue', () => {
  it.each(scanBlocks)('%s produces to the parse-safety queue as PARSE_SAFETY_QUEUE', (_, block, environment) => {
    expect(block?.queues?.producers?.find((p) => p.binding === 'PARSE_SAFETY_QUEUE')?.queue).toBe(`deepertones-parse-safety-${environment}`)
  })

  it.each(scanBlocks)('%s consumes the parse-safety queue with 4 retries, then its dead-letter queue', (_, block, environment) => {
    const consumer = block?.queues?.consumers?.find((c) => c.queue === `deepertones-parse-safety-${environment}`)

    expect(consumer).toMatchObject({ max_retries: 4, dead_letter_queue: `deepertones-parse-safety-dlq-${environment}` })
  })

  it.each(scanBlocks)('%s consumes the parse-safety dead-letter queue, so dead letters reach the job\'s dead-letter hook', (_, block, environment) => {
    const consumer = block?.queues?.consumers?.find((c) => c.queue === `deepertones-parse-safety-dlq-${environment}`)

    expect(consumer).toBeDefined()
  })

  it.each(scanBlocks)('%s keeps every queue it already had', (_, block, environment) => {
    const bindings = Object.fromEntries((block?.queues?.producers ?? []).map((p) => [p.binding, p.queue]))

    expect(bindings).toMatchObject({
      OTP_DELIVERY_QUEUE: `deepertones-otp-delivery-${environment}`,
      SCAN_ITEMS_QUEUE: `deepertones-scan-items-${environment}`,
      PUSH_DELIVERY_QUEUE: `deepertones-push-delivery-${environment}`,
      PUSH_RECEIPTS_QUEUE: `deepertones-push-receipts-${environment}`,
    })
  })
})

// A namespace_id is an account-wide counter: two bindings that share one share their counts, across environments too.
describe('wrangler.jsonc rate limits', () => {
  const all = scanBlocks.flatMap(([place, block]) => (block?.ratelimits ?? []).map((limit) => ({ place, ...limit })))

  it('has rate limits to check', () => {
    expect(all.length).toBeGreaterThan(0)
  })

  it('gives every rate limit in the whole file its own namespace_id', () => {
    const ids = all.map((limit) => limit.namespace_id)
    const repeated = ids.filter((id, i) => ids.indexOf(id) !== i)

    expect(repeated).toEqual([])
  })

  it.each(scanBlocks)('%s names each of its rate limits once', (_, block) => {
    const names = (block?.ratelimits ?? []).map((limit) => limit.name)

    expect(new Set(names).size).toBe(names.length)
  })
})

// The scan routes' rate limits (60 s windows). Env blocks do not inherit `ratelimits`, so each block restates them; the
// uniqueness of every namespace_id across the whole file is checked in "wrangler.jsonc rate limits" above.
type SimpleLimit = { name: string; namespace_id: string; simple?: { limit: number; period: number } }
const scanLimitBlocks = scanBlocks as unknown as [string, { ratelimits?: SimpleLimit[] } | undefined, string][]

describe('wrangler.jsonc scan, goal and product search route rate limits', () => {
  const limiters: [string, number][] = [
    ['SCAN_CREATE_IP_LIMITER', 20],
    ['SCAN_CREATE_USER_LIMITER', 10],
    // The shelf route reads up to 5 products per photo, so it costs what the product route does: the same numbers, a counter of its own.
    ['SCAN_SHELF_IP_LIMITER', 20],
    ['SCAN_SHELF_USER_LIMITER', 10],
    ['SCAN_BACK_PHOTO_USER_LIMITER', 10],
    ['SCAN_BACK_PHOTO_IP_LIMITER', 20],
    ['SCAN_RETAKE_IP_LIMITER', 20],
    ['SCAN_RETAKE_USER_LIMITER', 10],
    // Typing a name: each identification may cost a model call, so these are as tight as the retake's.
    ['SCAN_IDENTIFY_IP_LIMITER', 20],
    ['SCAN_IDENTIFY_USER_LIMITER', 10],
    // Saying a product has no label: no photo and no model, so no cost, but a write each; as tight as the other item routes that move an item on.
    ['SCAN_NO_LABEL_IP_LIMITER', 20],
    ['SCAN_NO_LABEL_USER_LIMITER', 10],
    // Typed goal words: each may cost a model call. The route cannot tell words from chips before it validates the body, so chips count too.
    ['GOAL_SET_IP_LIMITER', 20],
    ['GOAL_SET_USER_LIMITER', 10],
    // Search runs as the user types (a request every keystroke or two, and no AI), so it is far looser than the routes that cost something.
    ['PRODUCT_SEARCH_IP_LIMITER', 120],
    ['PRODUCT_SEARCH_USER_LIMITER', 60],
  ]
  const cases = scanLimitBlocks.flatMap(([place, block]) => limiters.map(([name, limit]) => ({ place, block, name, limit })))

  it.each(cases)('$place has $name allowing $limit requests per 60 seconds', ({ block, name, limit }) => {
    const found = block?.ratelimits?.find((l) => l.name === name)

    expect(found?.simple).toEqual({ limit, period: 60 })
    expect(found?.namespace_id).toEqual(expect.stringMatching(/^\d+$/))
  })
})

// Live scan updates: one Durable Object per scan, bound as SCAN_STREAM. Env blocks do not inherit `durable_objects`
// (wrangler reads the binding list back empty), so each block restates it. `migrations` and `compatibility_flags` ARE
// inherited, so the top level carries them once; an env block that sets its own list would replace the inherited one.
type StreamBlock = {
  compatibility_flags?: string[]
  durable_objects?: { bindings?: { name: string; class_name: string }[] }
  migrations?: { tag?: string; new_sqlite_classes?: string[]; new_classes?: string[] }[]
}
const streamConfig = config as unknown as StreamBlock & { env: Record<string, StreamBlock> }

const streamBlocks: [string, StreamBlock | undefined][] = [
  ['top level', streamConfig],
  ['env.staging', streamConfig.env.staging],
  ['env.production', streamConfig.env.production],
]

describe('wrangler.jsonc scan stream Durable Object', () => {
  it.each(streamBlocks)('%s binds the ScanStream class as SCAN_STREAM', (_, block) => {
    expect(block?.durable_objects?.bindings ?? []).toContainEqual({ name: 'SCAN_STREAM', class_name: 'ScanStream' })
  })

  it('migrates ScanStream in as a SQLite-backed class, once, at the top level', () => {
    const creating = (streamConfig.migrations ?? []).filter((m) => m.new_sqlite_classes?.includes('ScanStream'))

    expect(creating).toHaveLength(1)
    expect(creating[0]?.tag).toEqual(expect.any(String))
  })

  it('never declares a class with the legacy, non-SQLite kind of migration', () => {
    const everyBlock = streamBlocks.flatMap(([, block]) => block?.migrations ?? [])

    expect(everyBlock.filter((m) => m.new_classes !== undefined)).toEqual([])
  })

  it('turns on enable_request_signal, so the stream learns when a client has gone, and keeps nodejs_compat', () => {
    expect(streamConfig.compatibility_flags).toEqual(expect.arrayContaining(['enable_request_signal', 'nodejs_compat']))
  })

  it.each(streamBlocks.slice(1))('%s keeps both flags if it sets its own compatibility_flags, which would replace the inherited list', (_, block) => {
    if (block?.compatibility_flags === undefined) return

    expect(block.compatibility_flags).toEqual(expect.arrayContaining(['enable_request_signal', 'nodejs_compat']))
  })

  // Setting it by hand crashed workerd at startup (ERR_RUNTIME_FAILURE on wrangler 4.149 / miniflare 5.20261006), and it
  // becomes the default on 2026-11-17 anyway.
  it.each(streamBlocks)('%s does not set pipe_to_backward_propagation', (_, block) => {
    expect(block?.compatibility_flags ?? []).not.toContain('pipe_to_backward_propagation')
  })
})
