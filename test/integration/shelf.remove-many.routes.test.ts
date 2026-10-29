import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { eq } from 'drizzle-orm'
import { hc } from 'hono/client'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import worker, { type AppType } from '../../src/index'
import { createDb } from '../../src/lib/db'
import { parseEmailAddress } from '../../src/lib/email-address'
import { D1CatalogRepository } from '../../src/modules/catalog/catalog.repository'
import { ProductCatalogService } from '../../src/modules/catalog/catalog.service'
import { D1CatalogWorkbookRepository } from '../../src/modules/catalog/catalog.workbook.repository'
import { FakeOpsAlertsRepository } from '../../src/modules/ops-alerts/ops-alerts.repository.fake'
import { OpsAlertsService } from '../../src/modules/ops-alerts/ops-alerts.service'
import { TokenService } from '../../src/modules/auth/tokens.service'
import { D1ProfilesRepository } from '../../src/modules/profiles/profiles.repository'
import { STEP_DOWN_LINE_GUEST, STEP_DOWN_LINE_VERIFIED } from '../../src/modules/shelf/shelf.copy'
import { profileProducts } from '../../src/modules/shelf/shelf.table'
import { D1UsersRepository } from '../../src/modules/users/users.repository'
import { messageResponse, textBlock } from '../../src/providers/anthropic/messages-api.fake'
import { MemoryCatalogImageStore } from '../../src/providers/catalog-images/memory.catalog-image-store'
import { MemoryEmailSender } from '../../src/providers/email/memory.email'
import { MemoryJobQueue } from '../../src/providers/job-queue/memory.job-queue'
import { MemoryProductAnalyst } from '../../src/providers/product-analysis/memory.product-analyst'
import { MemoryProductResearcher } from '../../src/providers/product-research/memory.product-researcher'
import { applied, code, ruleRow, taperRow, word } from './admin.catalog.support'

// POST /api/v1/me/shelf/remove (spec #259, B2) through the Worker's public surface: the real entrypoint and real local D1. It takes several products off the
// shelf at once, all or nothing, and warns about any product removed that the person's current shelf verdict says to STOP (a steroid or lightening product is
// stepped down, never stopped suddenly). The warning comes from the real verdict pipeline, as verdicts.routes.test.ts drives it: the GET route queues a
// `build-verdict` message, the queue handler runs it, and only the outbound Anthropic call (the fit judge) is stubbed at fetch. Products reach the shelf as rows
// put straight into profile_products, as that file does. The shelf, and the removed time and reason that no read shows, are read back from the route and the table.
//
// The workbook is one database for the whole file, so the describes run in order against the state the one before left: no step-down template at all (the
// verdict is unavailable), then both templates and the rules approved.

const VERDICTS_MAIN = 'deepertones-verdicts-development'
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages'
const SOURCE_URL = 'https://shop.example/product'
const CLEAN = ['Aqua', 'Glycerin', 'Cetearyl Alcohol']
const CHEAP_USAGE = { input_tokens: 100, output_tokens: 50 }
const MINUTE = 60 * 1000
// The one clock for hand-made rows: "now" is the real clock the Worker runs on, fixtures are offsets.
const NOW = Date.now()

type Queued = { body: unknown }
const verdictsQueued: Queued[] = []
// When set, the verdicts queue refuses a message, as a queue outage would: a verdict that needs a new build then cannot even be read.
let verdictsQueueDown = false
const verdictsQueue = {
  send: async (body: unknown) => {
    if (verdictsQueueDown) throw new Error('queue unavailable')
    verdictsQueued.push({ body })
  },
  sendBatch: async () => {},
} as unknown as Queue
const quietQueue = { send: async () => {}, sendBatch: async () => {} } as unknown as Queue
const WORKER_ENV = {
  ...env,
  VERDICTS_QUEUE: verdictsQueue,
  SCAN_ITEMS_QUEUE: quietQueue,
  PARSE_SAFETY_QUEUE: quietQueue,
  PUSH_DELIVERY_QUEUE: quietQueue,
}
const ORIGIN = 'http://deepertones.test'
const fetchWorker = (input: RequestInfo | URL, init?: RequestInit) => worker.fetch!(new Request(input, init) as never, WORKER_ENV, createExecutionContext())
const api = hc<AppType>(ORIGIN, { fetch: fetchWorker as typeof fetch })
const v1 = api.api.v1

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  verdictsQueued.length = 0
  verdictsQueueDown = false
})

const runSalt = String(Math.floor(Math.random() * 1e6))
let counter = 0
const next = () => counter++
const freshIp = () => {
  const n = next()
  return `10.${Number(runSalt) % 250}.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`
}
const freshBrand = () => `${runSalt}${next()}x BulkBrand`

type Envelope<T> = { success: true; status: number; data: T } | { success: false; status: number; error: { code: string } }
type Reply = { json(): Promise<unknown>; status: number; headers: Headers }
const dataOf = async <T>(res: Reply): Promise<T> => {
  const body = (await res.json()) as Envelope<T>
  if (!body.success) throw new Error(`expected a success, got ${res.status} ${body.error.code}`)
  return body.data
}
const errorCodeOf = async (res: Reply) => {
  const body = (await res.json()) as Envelope<unknown>
  if (body.success) throw new Error(`expected an error, got ${res.status}`)
  return body.error.code
}

type RemoveResult = { removed: string[]; stepDownWarnings: { entryId: string; taperCode: string | null; line: string }[] }

// --- people: a guest of one install (guests are included, as they are for DELETE) ---

const db = createDb(env.DB)
const newGuest = async () => {
  const ip = freshIp()
  const res = await v1.auth.anonymous.$post({ json: { deviceId: `device-bulk-${runSalt}-${next()}`, platform: 'ios' } }, { headers: { 'cf-connecting-ip': ip } })
  const session = await dataOf<{ tokens: { accessToken: string }; user: { id: string } }>(res)
  const profileId = (await new D1ProfilesRepository(db).defaultFor(session.user.id))!.id
  return { userId: session.user.id, profileId, headers: (): Record<string, string> => ({ 'cf-connecting-ip': ip, Authorization: `Bearer ${session.tokens.accessToken}` }) }
}
type Guest = Awaited<ReturnType<typeof newGuest>>

const users = new D1UsersRepository(db)
const tokenService = new TokenService({ secret: env.JWT_SECRET })
/** A guest who has signed up: the same account and profile, now verified, with an access token that says so (the route reads the status from the token). */
const newMember = async (): Promise<Guest> => {
  const guest = await newGuest()
  const promoted = await users.promote(guest.userId, { kind: 'email', email: parseEmailAddress(`${guest.userId}@example.com`) }, new Date())
  if (promoted.outcome !== 'promoted') throw new Error(`expected the guest to be promoted, got ${promoted.outcome}`)
  const { accessToken } = await tokenService.issue(promoted.user, guest.profileId)
  const ip = freshIp()
  return { ...guest, headers: () => ({ 'cf-connecting-ip': ip, Authorization: `Bearer ${accessToken}` }) }
}

const putGoal = async (guest: Guest, goal = 'fade-dark-marks') => expect((await v1.me.goal.$put({ json: { goal } as never }, { headers: guest.headers() })).status).toBe(200)
const putSafety = async (guest: Guest, json: Record<string, unknown>) => expect((await v1.me.safety.$put({ json: json as never }, { headers: guest.headers() })).status).toBe(200)

// --- the route under test, and the ones that show its effects. Read with plain fetch: the typed client has no call for the new route until it exists. ---

/** POST /me/shelf/remove with the body as a client sends it (JSON text is sent as it is). */
const postRemove = (guest: Guest | undefined, body: unknown) =>
  fetchWorker(`${ORIGIN}/api/v1/me/shelf/remove`, {
    method: 'POST',
    headers: { ...(guest ? guest.headers() : { 'cf-connecting-ip': freshIp() }), 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
const deleteEntry = (guest: Guest, entryId: string, body?: Record<string, unknown>) =>
  fetchWorker(`${ORIGIN}/api/v1/me/shelf/${entryId}`, {
    method: 'DELETE',
    headers: { ...guest.headers(), 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
const getVerdict = (guest: Guest) => v1.me.verdict.$get({}, { headers: guest.headers() })
const shelfIds = async (guest: Guest) => (await dataOf<{ entries: { id: string }[] }>(await v1.me.shelf.$get({}, { headers: guest.headers() }))).entries.map((entry) => entry.id)
/**
 * The ids of the profile's entries not removed, read from the table. For entries made with putRow, whose product never resolves in the catalog and so is left off
 * GET /me/shelf (as `shelf-entry-unresolved`): the shelf read cannot tell removed from unresolved there, the table can.
 */
const activeIds = async (guest: Guest) =>
  (await db.select({ id: profileProducts.id, removedAt: profileProducts.removedAt }).from(profileProducts).where(eq(profileProducts.profileId, guest.profileId))).filter((row) => row.removedAt === null).map((row) => row.id)
/** The table is the one place to see the removed time and reason, which no read shows. */
const rowOf = async (entryId: string) => (await db.select().from(profileProducts).where(eq(profileProducts.id, entryId)))[0]!

// --- the shelf ---

/** A row put straight into the table, for the cases that only need entries to remove. Answers its id. */
const putRow = async (guest: Guest, over: Partial<typeof profileProducts.$inferInsert> = {}) => {
  const id = crypto.randomUUID()
  await db.insert(profileProducts).values({
    id,
    profileId: guest.profileId,
    kind: 'product',
    productId: crypto.randomUUID(),
    formulationId: crypto.randomUUID(),
    scanId: crypto.randomUUID(),
    itemId: crypto.randomUUID(),
    addedAt: new Date(NOW - MINUTE),
    lastScannedAt: new Date(NOW - MINUTE),
    ...over,
  })
  return id
}

const quietOpsAlerts = () =>
  new OpsAlertsService({ repository: new FakeOpsAlertsRepository(), jobs: new MemoryJobQueue(), email: new MemoryEmailSender(), recipient: '', environment: 'test' })
/** A product the catalog holds, researched and analysed, and put on the guest's shelf. Answers the shelf entry's id. */
const onShelf = async (guest: Guest, ingredients: string[] = CLEAN): Promise<string> => {
  const researcher = new MemoryProductResearcher()
  researcher.respondWith(() => ({ found: true, ingredients, sourceUrl: SOURCE_URL }))
  // The analysis has to cover every flagged fact (a steroid and a mercury compound are), as the model's does.
  const analyst = new MemoryProductAnalyst()
  analyst.analyseWith((input) =>
    input.flaggedFacts.map((fact) => ({ kind: fact.kind, severity: 'high', ingredients: [fact.ingredient], why: 'Flagged by the rules.', whoShouldTakeCare: 'Everyone.', traits: [], sources: fact.source === null ? [] : [fact.source] })),
  )
  const catalog = new ProductCatalogService({
    repository: new D1CatalogRepository(db),
    workbook: new D1CatalogWorkbookRepository(db),
    researcher,
    analyst,
    images: new MemoryCatalogImageStore(),
    imageKeyPrefix: 'catalog/test',
    opsAlerts: quietOpsAlerts(),
  })
  const brand = freshBrand()
  const resolved = await catalog.resolve({ brand, name: brand, category: 'skin' })
  if (resolved.kind !== 'needs-research') throw new Error(`expected needs-research, got ${resolved.kind}`)
  const found = await catalog.research(resolved.productId)
  if (found.kind !== 'found') throw new Error('expected found')
  await catalog.analyse(found.formulationId)
  return putRow(guest, { productId: resolved.productId, formulationId: found.formulationId })
}

// --- the fit judge, stubbed at fetch, and the build the route queued ---

type Call = { body: any }
const requestOf = (call: Call): { shelf: { id: string; floor: { status: string } }[] } => JSON.parse(String(call.body.messages[0].content[0].text).split('\n').slice(1).join('\n'))
/** The judge calls every open product helping. */
const stubFit = () => {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input) !== ANTHROPIC_URL) return new Response('not found', { status: 404 })
    const products = requestOf({ body: JSON.parse(init!.body as string) })
      .shelf.filter((p) => p.floor.status === 'open')
      .map((p) => ({ id: p.id, label: 'helping', reason: 'Reason: helping.', sameJobAs: null }))
    return messageResponse({ content: [textBlock(JSON.stringify({ products, clashes: [] }))], usage: CHEAP_USAGE })
  })
}
/** Delivers the build message the verdict route queued for this guest to the Worker's queue handler. */
const buildQueued = async (guest: Guest) => {
  const message = verdictsQueued.filter((queued) => (queued.body as { profileId: string }).profileId === guest.profileId).at(-1)
  if (!message) throw new Error('the route queued no build')
  stubFit()
  const batch = createMessageBatch(VERDICTS_MAIN, [{ id: 'm', timestamp: new Date(), attempts: 1, body: message.body }])
  const ctx = createExecutionContext()
  await worker.queue!(batch, WORKER_ENV, ctx)
  expect((await getQueueResult(batch, ctx)).explicitAcks).toEqual(['m'])
  vi.unstubAllGlobals()
}

// --- the workbook: step-down templates and the rules the floor reads, put in the way the team does, through the admin import ---

const STEROID_TAPER = code('TPR-STEROID')
const LIGHTENING_TAPER = code('TPR-LIGHTENING')
const STEROID_INGREDIENT = `${word('zq')} corticoidum`
const MERCURY_INGREDIENT = `${word('zq')} hydrargyrum`
const RETINOID_INGREDIENT = `${word('zq')} retinoidum`
const ACID_INGREDIENT = `${word('zq')} acidum`

describe('POST /api/v1/me/shelf/remove: while no step-down template is approved, so the verdict is unavailable', () => {
  it('removes the entries anyway, with no warnings, since a verdict that cannot be read stops nothing', async () => {
    const guest = await newGuest()
    await putGoal(guest)
    const steroid = await onShelf(guest, [...CLEAN, STEROID_INGREDIENT])
    const other = await onShelf(guest)
    expect((await getVerdict(guest)).status).toBe(503)

    const res = await postRemove(guest, { entryIds: [steroid, other] })

    expect(res.status).toBe(200)
    expect(await dataOf(res)).toEqual({ removed: [steroid, other], stepDownWarnings: [] })
    expect(await shelfIds(guest)).toEqual([])
  })
})

describe('POST /api/v1/me/shelf/remove: with both step-down templates approved', () => {
  beforeAll(async () => {
    await applied((workbook) => {
      workbook.tapers.rows.push(taperRow({ code: STEROID_TAPER, kind: 'steroid' }), taperRow({ code: LIGHTENING_TAPER, kind: 'lightening-agent' }))
      workbook.ingredients.rows.push(
        ruleRow({ name: STEROID_INGREDIENT, kind: 'banned-substance', group: 'steroid', statement: 'A topical steroid.' }),
        ruleRow({ name: MERCURY_INGREDIENT, kind: 'banned-substance', group: 'mercury', statement: 'A mercury compound.' }),
        ruleRow({ name: RETINOID_INGREDIENT, kind: 'irritation', group: 'retinoid', clashes_with: 'exfoliating-acid' }),
        ruleRow({ name: ACID_INGREDIENT, kind: 'irritation', group: 'exfoliating-acid', clashes_with: 'retinoid' }),
      )
    })
  })

  /**
   * A guest (or, when asked, a signed-up member) with a goal and a shelf of six whose verdict has been built (the verdict it reads is checked, so a failed
   * arrangement is not read as a failed warning): two steroid creams (STOP, with the steroid step-down), a mercury cream (DROP), a clean serum (KEEP), and a retinoid and an acid that clash (the acid is
   * REDUCED to alternate days, the retinoid kept).
   */
  const builtShelf = async ({ verified = false }: { verified?: boolean } = {}) => {
    const guest = verified ? await newMember() : await newGuest()
    await putGoal(guest)
    await putSafety(guest, { choices: ['none'] })
    const shelf = {
      steroid: await onShelf(guest, [...CLEAN, STEROID_INGREDIENT]),
      steroidToo: await onShelf(guest, [...CLEAN, STEROID_INGREDIENT]),
      mercury: await onShelf(guest, [...CLEAN, MERCURY_INGREDIENT]),
      serum: await onShelf(guest),
      retinoid: await onShelf(guest, [...CLEAN, RETINOID_INGREDIENT]),
      acid: await onShelf(guest, [...CLEAN, ACID_INGREDIENT]),
    }
    expect(await dataOf(await getVerdict(guest))).toEqual({ status: 'pending' })
    await buildQueued(guest)
    const built = await dataOf<{ products?: unknown[] }>(await getVerdict(guest))
    if (verified) expect(built).toMatchObject({ status: 'ready', locked: false, fit: 'ready' })
    else expect(built).toMatchObject({ status: 'ready', locked: true, fit: 'ready', total: 6, counts: { 'likely-the-problem': 3 } })
    if (verified) expect(built.products).toHaveLength(6)
    return { guest, ...shelf }
  }

  describe('the warnings', () => {
    it('warns a guest for each product removed that the verdict stops, with no step-down code and the guest line, in the order asked for, and for no other product removed with it', async () => {
      const { guest, steroid, steroidToo, serum, mercury, acid, retinoid } = await builtShelf()

      const res = await postRemove(guest, { entryIds: [steroidToo, serum, steroid, mercury, acid, retinoid] })

      expect(res.status).toBe(200)
      expect(await dataOf(res)).toEqual({
        removed: [steroidToo, serum, steroid, mercury, acid, retinoid],
        stepDownWarnings: [
          { entryId: steroidToo, taperCode: null, line: STEP_DOWN_LINE_GUEST },
          { entryId: steroid, taperCode: null, line: STEP_DOWN_LINE_GUEST },
        ],
      })
      expect(await shelfIds(guest)).toEqual([])
    })

    it('gives a guest nothing of the verdict beyond the line: no step-down code, name or schedule anywhere in the answer', async () => {
      const { guest, steroid } = await builtShelf()

      const res = await postRemove(guest, { entryIds: [steroid] })

      const text = JSON.stringify(await dataOf(res))
      expect(text).not.toContain(STEROID_TAPER)
      expect(text).not.toContain(LIGHTENING_TAPER)
      expect(Object.keys(JSON.parse(text).stepDownWarnings[0]).sort()).toEqual(['entryId', 'line', 'taperCode'])
    })

    it('warns a verified user for each product removed that the verdict stops, with its step-down code and the verified line, in the order asked for, and for no other product removed with it', async () => {
      const { guest, steroid, steroidToo, serum, mercury, acid, retinoid } = await builtShelf({ verified: true })

      const res = await postRemove(guest, { entryIds: [steroidToo, serum, steroid, mercury, acid, retinoid] })

      expect(res.status).toBe(200)
      expect(await dataOf(res)).toEqual({
        removed: [steroidToo, serum, steroid, mercury, acid, retinoid],
        stepDownWarnings: [
          { entryId: steroidToo, taperCode: STEROID_TAPER, line: STEP_DOWN_LINE_VERIFIED },
          { entryId: steroid, taperCode: STEROID_TAPER, line: STEP_DOWN_LINE_VERIFIED },
        ],
      })
      expect(await shelfIds(guest)).toEqual([])
    })

    it('gives a verified user no warning for products the verdict keeps, reduces or drops', async () => {
      const { guest, serum, acid, mercury, retinoid } = await builtShelf({ verified: true })

      const res = await postRemove(guest, { entryIds: [serum, acid, mercury, retinoid] })

      expect(await dataOf(res)).toEqual({ removed: [serum, acid, mercury, retinoid], stepDownWarnings: [] })
    })

    it('gives no warning for products the verdict keeps, reduces or drops, though a product it stops stays on the shelf', async () => {
      const { guest, steroid, steroidToo, serum, mercury, acid, retinoid } = await builtShelf()

      const res = await postRemove(guest, { entryIds: [serum, acid, mercury, retinoid] })

      expect(res.status).toBe(200)
      expect(await dataOf(res)).toEqual({ removed: [serum, acid, mercury, retinoid], stepDownWarnings: [] })
      expect((await shelfIds(guest)).sort()).toEqual([steroid, steroidToo].sort())
    })

    it('gives the same warning for a product removed alone, as it would among others', async () => {
      const { guest, steroid, serum } = await builtShelf()

      const res = await postRemove(guest, { entryIds: [steroid] })

      expect(await dataOf(res)).toEqual({ removed: [steroid], stepDownWarnings: [{ entryId: steroid, taperCode: null, line: STEP_DOWN_LINE_GUEST }] })
      expect(await shelfIds(guest)).toContain(serum)
    })

    it('gives no warning while the verdict is still pending: it has not been built', async () => {
      const guest = await newGuest()
      await putGoal(guest)
      await putSafety(guest, { choices: ['none'] })
      const steroid = await onShelf(guest, [...CLEAN, STEROID_INGREDIENT])
      expect(await dataOf(await getVerdict(guest))).toEqual({ status: 'pending' })

      const res = await postRemove(guest, { entryIds: [steroid] })

      expect(res.status).toBe(200)
      expect(await dataOf(res)).toEqual({ removed: [steroid], stepDownWarnings: [] })
    })

    it('gives no warning when the verdict is out of date: the shelf changed since it was built', async () => {
      const { guest, steroid } = await builtShelf()
      await onShelf(guest)

      const res = await postRemove(guest, { entryIds: [steroid] })

      expect(res.status).toBe(200)
      expect(await dataOf(res)).toEqual({ removed: [steroid], stepDownWarnings: [] })
      expect(await shelfIds(guest)).not.toContain(steroid)
    })

    it('gives no warning for a profile with no goal, which has no verdict', async () => {
      const guest = await newGuest()
      const steroid = await onShelf(guest, [...CLEAN, STEROID_INGREDIENT])

      const res = await postRemove(guest, { entryIds: [steroid] })

      expect(res.status).toBe(200)
      expect(await dataOf(res)).toEqual({ removed: [steroid], stepDownWarnings: [] })
    })

    it('still removes, with no warnings, when the verdict cannot be read because a new build cannot be queued, and logs no more than ids', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const { guest, steroid, serum } = await builtShelf()
      await onShelf(guest)
      verdictsQueueDown = true

      const res = await postRemove(guest, { entryIds: [steroid, serum], reason: 'stopped' })

      expect(res.status).toBe(200)
      expect(await dataOf(res)).toEqual({ removed: [steroid, serum], stepDownWarnings: [] })
      expect(await shelfIds(guest)).toHaveLength(5)
      expect(await rowOf(steroid)).toMatchObject({ removedReason: 'stopped' })
      expect(error.mock.calls.flat().some((arg) => arg instanceof Error)).toBe(false)
      expect(JSON.stringify(error.mock.calls)).not.toContain('queue unavailable')
    })
  })

  describe('the removal', () => {
    it('takes every entry off the shelf at once, with the reason and the time on each, and leaves the rest', async () => {
      const guest = await newGuest()
      const [first, second, third] = [await putRow(guest), await putRow(guest), await putRow(guest)]

      const res = await postRemove(guest, { entryIds: [first, second], reason: 'finished' })

      expect(res.status).toBe(200)
      expect(await dataOf(res)).toEqual({ removed: [first, second], stepDownWarnings: [] })
      expect(await activeIds(guest)).toEqual([third])
      for (const id of [first, second]) {
        const row = await rowOf(id)
        expect(row).toMatchObject({ removedReason: 'finished' })
        expect(Math.abs(row.removedAt!.getTime() - NOW)).toBeLessThan(5 * MINUTE)
      }
      expect(await rowOf(third)).toMatchObject({ removedAt: null, removedReason: null })
    })

    it('answers the removed ids in the order they were asked for, whatever the order of the ids or of the shelf', async () => {
      const guest = await newGuest()
      const ids = [await putRow(guest), await putRow(guest), await putRow(guest), await putRow(guest)]
      const asked = [...ids].sort().reverse()

      const res = await postRemove(guest, { entryIds: asked })

      expect((await dataOf<RemoveResult>(res)).removed).toEqual(asked)
    })

    it('keeps no reason when none is given', async () => {
      const guest = await newGuest()
      const id = await putRow(guest)

      expect((await postRemove(guest, { entryIds: [id] })).status).toBe(200)

      const row = await rowOf(id)
      expect(row).toMatchObject({ removedReason: null })
      expect(row.removedAt).toBeInstanceOf(Date)
    })

    it.each(['finished', 'stopped', 'not-mine'] as const)('keeps the reason %s on each entry removed', async (reason) => {
      const guest = await newGuest()
      const ids = [await putRow(guest), await putRow(guest)]

      expect((await postRemove(guest, { entryIds: ids, reason })).status).toBe(200)

      for (const id of ids) expect(await rowOf(id)).toMatchObject({ removedReason: reason })
    })

    it('removes 50 entries in one call, the most it takes', async () => {
      const guest = await newGuest()
      const ids: string[] = []
      for (let i = 0; i < 50; i++) ids.push(await putRow(guest))

      const res = await postRemove(guest, { entryIds: ids })

      expect(res.status).toBe(200)
      expect((await dataOf<RemoveResult>(res)).removed).toEqual(ids)
      expect(await activeIds(guest)).toEqual([])
    })

    it('serves a guest, as DELETE does', async () => {
      const guest = await newGuest()
      const id = await putRow(guest)

      expect((await postRemove(guest, { entryIds: [id] })).status).toBe(200)
    })
  })

  describe('all or nothing', () => {
    it('answers 404 SHELF_ENTRY_NOT_FOUND and removes none of them when one id among good ones is unknown', async () => {
      const guest = await newGuest()
      const [first, second] = [await putRow(guest), await putRow(guest)]

      const res = await postRemove(guest, { entryIds: [first, crypto.randomUUID(), second], reason: 'finished' })

      expect(res.status).toBe(404)
      expect(await errorCodeOf(res)).toBe('SHELF_ENTRY_NOT_FOUND')
      expect((await activeIds(guest)).sort()).toEqual([first, second].sort())
      for (const id of [first, second]) expect(await rowOf(id)).toMatchObject({ removedAt: null, removedReason: null })
    })

    it('answers 404 SHELF_ENTRY_NOT_FOUND for an id that is not a UUID, which no entry ever had, as it does for a UUID', async () => {
      const guest = await newGuest()
      const id = await putRow(guest)

      const res = await postRemove(guest, { entryIds: [id, 'not-an-entry'] })

      expect(res.status).toBe(404)
      expect(await errorCodeOf(res)).toBe('SHELF_ENTRY_NOT_FOUND')
      expect(await activeIds(guest)).toEqual([id])
    })

    it('answers 404 SHELF_ENTRY_NOT_FOUND, the same as for an unknown id, and removes none of them when one id is another profile\'s, which stays on its owner\'s shelf', async () => {
      const owner = await newGuest()
      const intruder = await newGuest()
      const theirs = await putRow(owner)
      const mine = await putRow(intruder)

      const res = await postRemove(intruder, { entryIds: [mine, theirs], reason: 'not-mine' })
      const unknown = await postRemove(intruder, { entryIds: [mine, crypto.randomUUID()], reason: 'not-mine' })

      expect(res.status).toBe(404)
      expect(await errorCodeOf(res)).toBe('SHELF_ENTRY_NOT_FOUND')
      expect(unknown.status).toBe(404)
      expect(await activeIds(owner)).toEqual([theirs])
      expect(await activeIds(intruder)).toEqual([mine])
      expect(await rowOf(theirs)).toMatchObject({ removedAt: null, removedReason: null })
    })

    it('answers 404 SHELF_ENTRY_NOT_FOUND for another profile\'s entry that was removed already, as it does for one still on the shelf', async () => {
      const owner = await newGuest()
      const intruder = await newGuest()
      const theirs = await putRow(owner, { removedAt: new Date(NOW - MINUTE), removedReason: 'finished' })

      const res = await postRemove(intruder, { entryIds: [theirs] })

      expect(res.status).toBe(404)
      expect(await errorCodeOf(res)).toBe('SHELF_ENTRY_NOT_FOUND')
    })

    it('removes nothing and leaves the verdict as it was when it refuses, though a product the verdict stops was named', async () => {
      const { guest, steroid, serum } = await builtShelf()

      const res = await postRemove(guest, { entryIds: [steroid, crypto.randomUUID()] })

      expect(res.status).toBe(404)
      expect(await errorCodeOf(res)).toBe('SHELF_ENTRY_NOT_FOUND')
      expect(await shelfIds(guest)).toContain(steroid)
      // Nothing changed, so the verdict that was built is still the one served.
      expect(await dataOf(await getVerdict(guest))).toMatchObject({ status: 'ready', total: 6 })
      expect(await shelfIds(guest)).toContain(serum)
    })
  })

  describe('entries removed before', () => {
    it('accepts them without counting them as removed now, and keeps their first reason and time while it removes the rest', async () => {
      const guest = await newGuest()
      const [before, active] = [await putRow(guest), await putRow(guest)]
      expect((await deleteEntry(guest, before, { reason: 'finished' })).status).toBe(204)
      const firstRemovedAt = (await rowOf(before)).removedAt!.getTime()

      const res = await postRemove(guest, { entryIds: [before, active], reason: 'stopped' })

      expect(res.status).toBe(200)
      expect(await dataOf(res)).toEqual({ removed: [active], stepDownWarnings: [] })
      expect(await rowOf(before)).toMatchObject({ removedReason: 'finished' })
      expect((await rowOf(before)).removedAt!.getTime()).toBe(firstRemovedAt)
      expect(await rowOf(active)).toMatchObject({ removedReason: 'stopped' })
    })

    it('answers 200 with nothing removed when every entry was removed before', async () => {
      const guest = await newGuest()
      const id = await putRow(guest)
      expect((await deleteEntry(guest, id, { reason: 'finished' })).status).toBe(204)

      const res = await postRemove(guest, { entryIds: [id], reason: 'stopped' })

      expect(res.status).toBe(200)
      expect(await dataOf(res)).toEqual({ removed: [], stepDownWarnings: [] })
      expect(await rowOf(id)).toMatchObject({ removedReason: 'finished' })
    })
  })

  describe('the body', () => {
    it('answers 400 VALIDATION_FAILED for no ids, and for 51, and removes nothing', async () => {
      const guest = await newGuest()
      const ids: string[] = []
      for (let i = 0; i < 51; i++) ids.push(await putRow(guest))

      for (const entryIds of [[], ids]) {
        const res = await postRemove(guest, { entryIds })
        expect(res.status).toBe(400)
        expect(await errorCodeOf(res)).toBe('VALIDATION_FAILED')
      }

      expect(await activeIds(guest)).toHaveLength(51)
    })

    it('answers 400 VALIDATION_FAILED for the same id twice, and removes nothing', async () => {
      const guest = await newGuest()
      const [first, second] = [await putRow(guest), await putRow(guest)]

      const res = await postRemove(guest, { entryIds: [first, second, first] })

      expect(res.status).toBe(400)
      expect(await errorCodeOf(res)).toBe('VALIDATION_FAILED')
      expect((await activeIds(guest)).sort()).toEqual([first, second].sort())
    })

    it.each([
      ['no entryIds', {}],
      ['entryIds that is not a list', { entryIds: 'one' }],
      ['an id that is not a string', { entryIds: [7] }],
      ['a reason outside the three', { entryIds: ['x'], reason: 'because' }],
      ['a key it does not know', { entryIds: ['x'], extra: true }],
      ['a misspelt reason key', { entryIds: ['x'], reson: 'finished' }],
    ])('answers 400 VALIDATION_FAILED for a body with %s', async (_name, body) => {
      const guest = await newGuest()

      const res = await postRemove(guest, body)

      expect(res.status).toBe(400)
      expect(await errorCodeOf(res)).toBe('VALIDATION_FAILED')
    })

    it('answers 400 for a body that is not JSON, and removes nothing', async () => {
      const guest = await newGuest()
      const id = await putRow(guest)

      const res = await postRemove(guest, '{not json')

      expect(res.status).toBe(400)
      expect(await activeIds(guest)).toEqual([id])
    })
  })

  describe('who may call it', () => {
    it('answers 401 AUTH_REQUIRED without a token', async () => {
      const res = await postRemove(undefined, { entryIds: [crypto.randomUUID()] })

      expect(res.status).toBe(401)
      expect(await errorCodeOf(res)).toBe('AUTH_REQUIRED')
    })

    it('answers 401 AUTH_REQUIRED, not 400, without a token even for a body that would not validate: the caller is checked before the body is read', async () => {
      const res = await postRemove(undefined, { entryIds: [] })

      expect(res.status).toBe(401)
      expect(await errorCodeOf(res)).toBe('AUTH_REQUIRED')
    })
  })

  describe('DELETE /api/v1/me/shelf/{entryId}', () => {
    it('still answers 204 with no body, and gives no step-down warning', async () => {
      const { guest, steroid } = await builtShelf()

      const res = await deleteEntry(guest, steroid)

      expect(res.status).toBe(204)
      expect(await res.text()).toBe('')
      expect(await shelfIds(guest)).not.toContain(steroid)
    })
  })
})
