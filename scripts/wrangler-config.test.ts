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
// hour, to dodge the top-of-hour rush), the scan reaper every 10 minutes and the reminder send job every 15 minutes (a reminder time is due in a 15 minute window).
const GUEST_CLEANUP_CRON = '17 3 * * *'
const SCAN_REAPER_CRON = '*/10 * * * *'
const REMINDERS_CRON = '*/15 * * * *'

describe('wrangler.jsonc cron triggers', () => {
  const places: [string, string[] | undefined][] = [
    ['top level', config.triggers?.crons],
    ['env.staging', config.env.staging?.triggers?.crons],
    ['env.production', config.env.production?.triggers?.crons],
  ]

  it.each(places)('%s has exactly the daily guest cleanup, the 10 minute scan reaper and the 15 minute reminder send job', (_, crons) => {
    expect([...(crons ?? [])].sort()).toEqual([GUEST_CLEANUP_CRON, SCAN_REAPER_CRON, REMINDERS_CRON].sort())
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

  // The routine writer's words reach users, so it is Sonnet by the AI cost rule.
  it.each(blocks)('%s sets the better model for the routine writer', (_, block) => {
    expect(block?.vars?.ANTHROPIC_MODEL_ROUTINE).toBe('claude-sonnet-5-5')
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

// Perfect Corp (YouCam) runs the face scan. Per environment even though one account is shared today, so a separate account per
// environment later needs no code change. The key and webhook secret are secrets (optional for now); the address and
// the price of one unit are plain vars. Env blocks do not inherit either, so each block restates them. The price is not pinned to a
// number, only to a positive one, because it is the owner's to set.
describe('wrangler.jsonc Perfect Corp config', () => {
  it.each(blocks)('%s sets the Perfect Corp API address', (_, block) => {
    expect(block?.vars?.PERFECT_CORP_BASE_URL).toBe('https://yce-api-01.makeupar.com')
  })

  it.each(blocks)('%s sets the price of one Perfect Corp unit in USD as a positive number', (_, block) => {
    const price = block?.vars?.PERFECT_CORP_USD_PER_UNIT

    expect(typeof price).toBe('string')
    expect(price).toMatch(/^\d+(\.\d+)?$/)
    expect(Number(price)).toBeGreaterThan(0)
    expect(Number.isFinite(Number(price))).toBe(true)
  })

  // Required now that the face scan pipeline calls Perfect Corp and verifies its webhooks: a deploy without them must fail, not run without them.
  it.each(blocks)('%s requires PERFECT_CORP_API_KEY and PERFECT_CORP_WEBHOOK_SECRET, so a deploy fails without them', (_, block) => {
    expect(block?.secrets?.required).toContain('PERFECT_CORP_API_KEY')
    expect(block?.secrets?.required).toContain('PERFECT_CORP_WEBHOOK_SECRET')
  })

  it.each(blocks)('%s does not hold the key or the webhook secret as plain vars', (_, block) => {
    expect(block?.vars).not.toHaveProperty('PERFECT_CORP_API_KEY')
    expect(block?.vars).not.toHaveProperty('PERFECT_CORP_WEBHOOK_SECRET')
  })

  it.each(blocks)('%s still requires the secrets it already required', (_, block) => {
    expect(block?.secrets?.required).toEqual(
      expect.arrayContaining(['ZEPTOMAIL_API_KEY', 'OTP_PEPPER', 'JWT_SECRET', 'DEVICE_ID_KEY', 'ANTHROPIC_API_KEY', 'EXPO_ACCESS_TOKEN']),
    )
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
// consumer keeps the standard 5 attempts and takes one message at a time.
describe('wrangler.jsonc parse-safety queue', () => {
  it.each(scanBlocks)('%s produces to the parse-safety queue as PARSE_SAFETY_QUEUE', (_, block, environment) => {
    expect(block?.queues?.producers?.find((p) => p.binding === 'PARSE_SAFETY_QUEUE')?.queue).toBe(`deepertones-parse-safety-${environment}`)
  })

  it.each(scanBlocks)('%s consumes the parse-safety queue with 4 retries, then its dead-letter queue', (_, block, environment) => {
    const consumer = block?.queues?.consumers?.find((c) => c.queue === `deepertones-parse-safety-${environment}`)

    expect(consumer).toMatchObject({ max_retries: 4, dead_letter_queue: `deepertones-parse-safety-dlq-${environment}` })
  })

  // A parse is a model read and a catalog research per message, and a batch is retried or acked as a whole: one message at a time keeps one slow
  // research from holding up, or re-running, the others.
  it.each(scanBlocks)('%s hands the parse-safety consumer one message at a time', (_, block, environment) => {
    const consumer = block?.queues?.consumers?.find((c) => c.queue === `deepertones-parse-safety-${environment}`)

    expect(consumer).toMatchObject({ max_batch_size: 1 })
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

describe('wrangler.jsonc scan, goal, safety, product search and shelf route rate limits', () => {
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
    // Saved reaction and prescription words queue a parse that can research a product into the shared catalog, and a guest costs nothing to make: as tight as the goal's.
    ['SAFETY_SET_IP_LIMITER', 20],
    ['SAFETY_SET_USER_LIMITER', 10],
    // Search runs as the user types (a request every keystroke or two, and no AI), so it is far looser than the routes that cost something.
    ['PRODUCT_SEARCH_IP_LIMITER', 120],
    ['PRODUCT_SEARCH_USER_LIMITER', 60],
    // Adding a product from search starts a scan that may research and analyse it: as tight as the other routes that can cost a model call.
    ['SHELF_ADD_IP_LIMITER', 20],
    ['SHELF_ADD_USER_LIMITER', 10],
    // A face scan sends a photo to Perfect Corp, which is paid per use: as tight as the other routes that can cost money. A profile can start one
    // per goal anyway (409/429 on the rest), so this only stops a flood of rejected attempts.
    ['FACE_SCAN_IP_LIMITER', 20],
    ['FACE_SCAN_USER_LIMITER', 10],
    // Perfect Corp's webhook: public, and signed, so the limit only keeps a flood of unsigned requests from costing a signature check each. A burst of
    // genuine deliveries (every scan sends one or two) is far under it.
    ['PERFECT_CORP_WEBHOOK_LIMITER', 300],
    // The admin catalog routes (export and import), per address and before the token is checked, so a guess at the token costs an attempt. Only a few people ever call them.
    ['ADMIN_IP_LIMITER', 10],
    // Each share card spends an Images transformation (5,000 a month free): as tight as the other routes that can cost something. Per user only; the route needs a session.
    ['FACE_SHARE_USER_LIMITER', 10],
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

// The face scan limiters (issue #112) each get an id of their own in every block. Pinned to the numbers, not only to being unique: the ids
// are account-wide counters, and dev, staging and production are told apart by their thousands (1xxx, 2xxx, 3xxx).
describe('wrangler.jsonc face scan rate limit namespace ids', () => {
  const ids: [string, QueueBlock | undefined, { ip: string; user: string }][] = [
    ['top level', queueConfig, { ip: '1026', user: '1027' }],
    ['env.staging', queueConfig.env.staging, { ip: '2026', user: '2027' }],
    ['env.production', queueConfig.env.production, { ip: '3026', user: '3027' }],
  ]

  it.each(ids)('%s gives FACE_SCAN_IP_LIMITER and FACE_SCAN_USER_LIMITER their own ids', (_, block, expected) => {
    const byName = Object.fromEntries((block?.ratelimits ?? []).map((limit) => [limit.name, limit.namespace_id]))

    expect(byName.FACE_SCAN_IP_LIMITER).toBe(expected.ip)
    expect(byName.FACE_SCAN_USER_LIMITER).toBe(expected.user)
  })
})

describe('wrangler.jsonc Perfect Corp webhook rate limit namespace id', () => {
  const ids: [string, QueueBlock | undefined, string][] = [
    ['top level', queueConfig, '1028'],
    ['env.staging', queueConfig.env.staging, '2028'],
    ['env.production', queueConfig.env.production, '3028'],
  ]

  it.each(ids)('%s gives PERFECT_CORP_WEBHOOK_LIMITER its own id', (_, block, expected) => {
    const byName = Object.fromEntries((block?.ratelimits ?? []).map((limit) => [limit.name, limit.namespace_id]))

    expect(byName.PERFECT_CORP_WEBHOOK_LIMITER).toBe(expected)
  })
})

// Face scans' background work (issue #112): the analysis job runs on a queue of its own, with a dead-letter queue, per environment. The consumer
// takes one message at a time: a message is one exchange with Perfect Corp (an upload, task creation or a fetch), and a batch is retried or acked as a whole.
describe('wrangler.jsonc face-scans queue', () => {
  it.each(scanBlocks)('%s produces to the face-scans queue as FACE_SCANS_QUEUE', (_, block, environment) => {
    expect(block?.queues?.producers?.find((p) => p.binding === 'FACE_SCANS_QUEUE')?.queue).toBe(`deepertones-face-scans-${environment}`)
  })

  it.each(scanBlocks)('%s consumes the face-scans queue one message at a time with 4 retries, then its dead-letter queue', (_, block, environment) => {
    const consumer = block?.queues?.consumers?.find((c) => c.queue === `deepertones-face-scans-${environment}`)

    expect(consumer).toMatchObject({ max_batch_size: 1, max_retries: 4, dead_letter_queue: `deepertones-face-scans-dlq-${environment}` })
  })

  it.each(scanBlocks)('%s consumes the face-scans dead-letter queue, so dead letters reach the job\'s dead-letter hook', (_, block, environment) => {
    const consumer = block?.queues?.consumers?.find((c) => c.queue === `deepertones-face-scans-dlq-${environment}`)

    expect(consumer).toBeDefined()
  })

  it.each(scanBlocks)('%s keeps every queue it already had beside it', (_, block, environment) => {
    const bindings = Object.fromEntries((block?.queues?.producers ?? []).map((p) => [p.binding, p.queue]))

    expect(bindings).toMatchObject({
      OTP_DELIVERY_QUEUE: `deepertones-otp-delivery-${environment}`,
      SCAN_ITEMS_QUEUE: `deepertones-scan-items-${environment}`,
      PARSE_SAFETY_QUEUE: `deepertones-parse-safety-${environment}`,
      EMAIL_QUEUE: `deepertones-email-${environment}`,
    })
  })
})

// The shelf verdict's build (issue #171): the build-verdict job runs on a queue of its own, with a dead-letter queue, per environment. The consumer takes one
// message at a time: a message is one fit-judge call, and a batch is retried or acked as a whole. 4 retries make the 5 attempts the job's own ladder expects.
describe('wrangler.jsonc verdicts queue', () => {
  it.each(scanBlocks)('%s produces to the verdicts queue as VERDICTS_QUEUE', (_, block, environment) => {
    expect(block?.queues?.producers?.find((p) => p.binding === 'VERDICTS_QUEUE')?.queue).toBe(`deepertones-verdicts-${environment}`)
  })

  it.each(scanBlocks)('%s consumes the verdicts queue one message at a time with 4 retries, then its dead-letter queue', (_, block, environment) => {
    const consumer = block?.queues?.consumers?.find((c) => c.queue === `deepertones-verdicts-${environment}`)

    expect(consumer).toMatchObject({ max_batch_size: 1, max_retries: 4, dead_letter_queue: `deepertones-verdicts-dlq-${environment}` })
  })

  it.each(scanBlocks)('%s consumes the verdicts dead-letter queue, so dead letters reach the job\'s dead-letter hook', (_, block, environment) => {
    const consumer = block?.queues?.consumers?.find((c) => c.queue === `deepertones-verdicts-dlq-${environment}`)

    expect(consumer).toBeDefined()
  })

  it.each(scanBlocks)('%s keeps every queue it already had beside it', (_, block, environment) => {
    const bindings = Object.fromEntries((block?.queues?.producers ?? []).map((p) => [p.binding, p.queue]))

    expect(bindings).toMatchObject({
      OTP_DELIVERY_QUEUE: `deepertones-otp-delivery-${environment}`,
      SCAN_ITEMS_QUEUE: `deepertones-scan-items-${environment}`,
      PUSH_DELIVERY_QUEUE: `deepertones-push-delivery-${environment}`,
      PUSH_RECEIPTS_QUEUE: `deepertones-push-receipts-${environment}`,
      PARSE_SAFETY_QUEUE: `deepertones-parse-safety-${environment}`,
      EMAIL_QUEUE: `deepertones-email-${environment}`,
      FACE_SCANS_QUEUE: `deepertones-face-scans-${environment}`,
    })
  })
})

// The routine's build (issue #189): the build-routine job runs on a queue of its own (never the verdicts queue: a bare verdict body in flight at deploy would be
// dropped by a shared consumer), with a dead-letter queue, per environment. One message at a time, 4 retries to make the 5 attempts the job's ladder expects.
describe('wrangler.jsonc routines queue', () => {
  it.each(scanBlocks)('%s produces to the routines queue as ROUTINES_QUEUE', (_, block, environment) => {
    expect(block?.queues?.producers?.find((p) => p.binding === 'ROUTINES_QUEUE')?.queue).toBe(`deepertones-routines-${environment}`)
  })

  it.each(scanBlocks)('%s consumes the routines queue one message at a time with 4 retries, then its dead-letter queue', (_, block, environment) => {
    const consumer = block?.queues?.consumers?.find((c) => c.queue === `deepertones-routines-${environment}`)

    expect(consumer).toMatchObject({ max_batch_size: 1, max_retries: 4, dead_letter_queue: `deepertones-routines-dlq-${environment}` })
  })

  it.each(scanBlocks)('%s consumes the routines dead-letter queue, so dead letters reach the job\'s dead-letter hook', (_, block, environment) => {
    const consumer = block?.queues?.consumers?.find((c) => c.queue === `deepertones-routines-dlq-${environment}`)

    expect(consumer).toBeDefined()
  })

  it.each(scanBlocks)('%s keeps the verdicts queue and its consumers as they were, beside the routines queue', (_, block, environment) => {
    expect(block?.queues?.producers?.find((p) => p.binding === 'VERDICTS_QUEUE')?.queue).toBe(`deepertones-verdicts-${environment}`)
    expect(block?.queues?.consumers?.find((c) => c.queue === `deepertones-verdicts-${environment}`)).toMatchObject({ max_batch_size: 1, max_retries: 4, dead_letter_queue: `deepertones-verdicts-dlq-${environment}` })
    expect(block?.queues?.consumers?.find((c) => c.queue === `deepertones-verdicts-dlq-${environment}`)).toBeDefined()
  })

  it.each(scanBlocks)('%s keeps every queue it already had beside it', (_, block, environment) => {
    const bindings = Object.fromEntries((block?.queues?.producers ?? []).map((p) => [p.binding, p.queue]))

    expect(bindings).toMatchObject({
      OTP_DELIVERY_QUEUE: `deepertones-otp-delivery-${environment}`,
      SCAN_ITEMS_QUEUE: `deepertones-scan-items-${environment}`,
      PUSH_DELIVERY_QUEUE: `deepertones-push-delivery-${environment}`,
      PUSH_RECEIPTS_QUEUE: `deepertones-push-receipts-${environment}`,
      PARSE_SAFETY_QUEUE: `deepertones-parse-safety-${environment}`,
      EMAIL_QUEUE: `deepertones-email-${environment}`,
      FACE_SCANS_QUEUE: `deepertones-face-scans-${environment}`,
      VERDICTS_QUEUE: `deepertones-verdicts-${environment}`,
    })
  })
})

// The switch for every routine trigger and sweep. Env blocks do not inherit vars, so each restates it: off in dev and test (no job runs by itself), on in
// staging, and off in production until the routine is launched there. A string, as every wrangler var.
describe('wrangler.jsonc routines switch', () => {
  const switches: [string, Block | undefined, string][] = [
    ['top level', catalogConfig, 'false'],
    ['env.staging', catalogConfig.env.staging, 'true'],
    ['env.production', catalogConfig.env.production, 'false'],
  ]

  it.each(switches)('%s sets ROUTINES_ENABLED to its own value, as a string', (_, block, expected) => {
    expect(block?.vars?.ROUTINES_ENABLED).toBe(expected)
  })
})

// The admin catalog routes: the token is a secret in every block (env blocks do not inherit `secrets`), and the limiter has an id of its own in each.
describe('wrangler.jsonc admin catalog access', () => {
  const adminBlocks: [string, { secrets?: { required?: string[] }; vars?: Record<string, string>; ratelimits?: { name: string; namespace_id: string }[] } | undefined, string][] = [
    ['top level', config as never, '1029'],
    ['env.staging', config.env.staging as never, '2029'],
    ['env.production', config.env.production as never, '3029'],
  ]

  it.each(adminBlocks)('%s requires ADMIN_API_TOKEN as a secret, never holds it as a plain var', (_, block) => {
    expect(block?.secrets?.required).toContain('ADMIN_API_TOKEN')
    expect(block?.vars).not.toHaveProperty('ADMIN_API_TOKEN')
  })

  it.each(adminBlocks)('%s gives ADMIN_IP_LIMITER its own namespace_id', (_, block, expected) => {
    expect(block?.ratelimits?.find((limit) => limit.name === 'ADMIN_IP_LIMITER')?.namespace_id).toBe(expected)
  })
})
