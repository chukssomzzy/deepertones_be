import { env } from 'cloudflare:workers'
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../../src/index'
import { createDb } from '../../src/lib/db'
import { ProductCatalogService } from '../../src/modules/catalog/catalog.service'
import { D1FaceScansRepository } from '../../src/modules/face-scans/face-scans.repository'
import { FaceScanService } from '../../src/modules/face-scans/face-scans.service'
import { D1SafetyRepository } from '../../src/modules/safety/safety.repository'
import { SafetyService } from '../../src/modules/safety/safety.service'
import { D1ScansRepository } from '../../src/modules/scans/scans.repository'
import { ScanService } from '../../src/modules/scans/scans.service'
import { D1UsersRepository } from '../../src/modules/users/users.repository'
import { UsersService } from '../../src/modules/users/users.service'
import { queueRecorder, stubPerfectCorp } from './perfect-corp.stub'

// The Worker's scheduled handler is one export for every cron in wrangler.jsonc. Each cron runs its own job and no other:
// the daily guest cleanup must not run every 10 minutes, nor the reaper once a day. The crons are pinned to the config in
// scripts/wrangler-config.test.ts.
const GUEST_CLEANUP_CRON = '17 3 * * *'
const SCAN_REAPER_CRON = '*/10 * * * *'

const NOW = Date.now()
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

const users = new D1UsersRepository(createDb(env.DB))
const scans = new D1ScansRepository(createDb(env.DB))

afterEach(() => {
  vi.restoreAllMocks()
})

/** An abandoned guest the daily cleanup deletes: unseen for 120 days, with no device. */
const abandonedGuest = async () => {
  const id = crypto.randomUUID()
  const longAgo = new Date(NOW - 120 * DAY)
  await users.createGuestForDevice({ user: { id, createdAt: longAgo }, device: { deviceHash: `scheduled-${id}`, platform: 'ios' }, profile: { id: crypto.randomUUID() } })
  await users.touch(id, longAgo)
  await users.unlinkDevices(id)
  return id
}

/** A guest with a one-item scan that has sat `recognising` for `ageMs`: stuck, as far as the reaper can tell. */
const stuckItem = async (ageMs: number) => {
  const userId = crypto.randomUUID()
  const profileId = crypto.randomUUID()
  await users.createGuestForDevice({ user: { id: userId, createdAt: new Date(NOW) }, device: { deviceHash: `scheduled-${userId}`, platform: 'ios' }, profile: { id: profileId } })
  const scanId = crypto.randomUUID()
  const itemId = crypto.randomUUID()
  const createdAt = new Date(NOW - ageMs)
  const photoId = crypto.randomUUID()
  await scans.createScan(
    { id: scanId, kind: 'product', userId, profileId, ipHash: `ip-${scanId}`, createdAt },
    [{ id: photoId, scanId, userId, position: 0, photoKey: null, createdAt }],
    [{ id: itemId, scanId, userId, position: 0, photoId, photoKey: `photos/${env.ENVIRONMENT}/${userId}/${scanId}/${itemId}.jpg`, createdAt }],
  )
  return itemId
}

const fire = async (cron: string) => {
  const ctx = createExecutionContext()
  await worker.scheduled!(createScheduledController({ scheduledTime: NOW, cron }), env, ctx)
  await waitOnExecutionContext(ctx)
}

// --- search text for products the old Worker made ---

const runSalt = String(Math.floor(Math.random() * 1e5)).padStart(5, '0')
let counter = 0
/** What the old Worker did on a new product: an INSERT that leaves search_text at its empty default. */
const oldWorkerProduct = async (brand: string, name: string) => {
  const id = crypto.randomUUID()
  await env.DB.prepare('INSERT INTO products (id, identity_key, brand_key, kind, brand, name, variant, category, created_at, search_text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, `${brand.toLowerCase()}|${name.toLowerCase()}|`, brand.toLowerCase(), 'named', brand, name, null, 'skin', NOW, '')
    .run()
  // Search lists only a product with ingredients, as it was once the old Worker had researched it, so these have a formulation too.
  await env.DB.prepare('INSERT INTO formulations (id, product_id, ingredients, ingredients_key, source_kind, found_at) VALUES (?, ?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), id, JSON.stringify(['Aqua', 'Glycerin']), 'aqua\nglycerin', 'label', NOW)
    .run()
  return id
}
const fetchWorker = (path: string, init?: RequestInit) => worker.fetch!(new Request(`http://deepertones.test${path}`, init) as never, env, createExecutionContext())
const signedInGuest = async () => {
  const ip = `10.${(Number(runSalt) + 11) % 250}.0.${(counter++ % 250) + 1}`
  const res = await fetchWorker('/api/v1/auth/anonymous', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ deviceId: `device-scheduled-${runSalt}-${counter++}`, platform: 'ios' }),
  })
  const body = (await res.json()) as { data: { tokens: { accessToken: string } } }
  return { 'cf-connecting-ip': ip, Authorization: `Bearer ${body.data.tokens.accessToken}` }
}
const searchFor = async (headers: Record<string, string>, q: string) => {
  const res = await fetchWorker(`/api/v1/products/search?q=${encodeURIComponent(q)}`, { headers })
  expect(res.status).toBe(200)
  return ((await res.json()) as { data: { products: { id: string }[] } }).data.products.map((p) => p.id)
}

describe('the Worker scheduled handler: search text', () => {
  it('on the reaper cron, makes products that were created with no search text searchable by plain typed text', async () => {
    const w = `sched${runSalt}n${counter++}z`
    const johnson = await oldWorkerProduct(`Johnson & ${w}`, 'Baby Oil')
    const dove = await oldWorkerProduct(`Dove${w}`, 'Men+Care Body Wash')
    const loreal = await oldWorkerProduct(`L'Oréal${w}`, 'Revitalift Crème')
    const headers = await signedInGuest()
    expect(await searchFor(headers, `johnson & ${w}`)).toEqual([])

    await fire(SCAN_REAPER_CRON)

    expect(await searchFor(headers, `johnson & ${w}`)).toEqual([johnson])
    expect(await searchFor(headers, `men+care dove${w}`)).toEqual([dove])
    expect(await searchFor(headers, `loreal${w} creme`)).toEqual([loreal])
  })

  it('still fills in search text when the scan sweep throws, and the run still fails with the sweep\'s error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(ScanService.prototype, 'reap').mockRejectedValue(new Error('the sweep exploded'))
    const w = `sched${runSalt}n${counter++}z`
    const product = await oldWorkerProduct(`Acme${w}`, 'Serum')
    const headers = await signedInGuest()

    await expect(fire(SCAN_REAPER_CRON)).rejects.toThrow('the sweep exploded')

    expect(await searchFor(headers, `acme${w}`)).toEqual([product])
  })

  it('still sweeps the scans when filling in search text throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(ProductCatalogService.prototype, 'fillSearchText').mockRejectedValue(new Error('the fill exploded'))
    const stuck = await stuckItem(3 * HOUR)

    await fire(SCAN_REAPER_CRON).catch(() => undefined)

    expect(await scans.findItem(stuck)).toMatchObject({ state: 'failed', reason: 'unavailable' })
  })

  it('leaves the products alone on the daily cron, which has nothing to do with search', async () => {
    const w = `sched${runSalt}n${counter++}z`
    await oldWorkerProduct(`Acme${w}`, 'Serum')
    const headers = await signedInGuest()

    await fire(GUEST_CLEANUP_CRON)

    expect(await searchFor(headers, `acme${w}`)).toEqual([])
  })
})

describe('the Worker scheduled handler', () => {
  it('on the reaper cron, fails an item stuck for over 2 hours as unavailable, and leaves a recent one and the abandoned guests alone', async () => {
    const stuck = await stuckItem(3 * HOUR)
    const recent = await stuckItem(5 * 60 * 1000)
    const guest = await abandonedGuest()

    await fire(SCAN_REAPER_CRON)

    expect(await scans.findItem(stuck)).toMatchObject({ state: 'failed', reason: 'unavailable' })
    expect(await scans.findItem(recent)).toMatchObject({ state: 'recognising', reason: null })
    expect(await users.findById(guest)).not.toBeNull()
  })

  it('on the daily cron, deletes the abandoned guests and does not sweep the scans', async () => {
    const stuck = await stuckItem(3 * HOUR)
    const guest = await abandonedGuest()

    await fire(GUEST_CLEANUP_CRON)

    expect(await users.findById(guest)).toBeNull()
    expect(await scans.findItem(stuck)).toMatchObject({ state: 'recognising' })
  })

  it('on a cron it does not know, runs neither job, says so and fails the run so Cloudflare records it', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const stuck = await stuckItem(3 * HOUR)
    const guest = await abandonedGuest()

    await expect(fire('5 5 * * *')).rejects.toThrow('5 5 * * *')

    expect(await scans.findItem(stuck)).toMatchObject({ state: 'recognising' })
    expect(await users.findById(guest)).not.toBeNull()
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'unknown-cron', cron: '5 5 * * *' }))
  })
})

// --- the second try of a safety parse that dead-lettered ---

// A parse that ran out of retries is given one more try the next day (SafetyService.markParseFailed puts it back to pending, due at the next
// midnight UTC). A queue delay cannot reach that far, so the daily cron queues it: SafetyService.requeueDueParses. The Worker's parse-safety
// producer is a recorder here, so what the cron queues can be read back.
describe('the Worker scheduled handler: parses due for their second try', () => {
  const safetyRows = new D1SafetyRepository(createDb(env.DB))
  const queuedParses: { body: unknown; delaySeconds: number | undefined }[] = []
  const parseQueue = { send: async (body: unknown, options?: { delaySeconds?: number }) => void queuedParses.push({ body, delaySeconds: options?.delaySeconds }), sendBatch: async () => {} } as unknown as Queue
  const fireWithQueue = async (cron: string) => {
    const ctx = createExecutionContext()
    await worker.scheduled!(createScheduledController({ scheduledTime: NOW, cron }), { ...env, PARSE_SAFETY_QUEUE: parseQueue } as typeof env, ctx)
    await waitOnExecutionContext(ctx)
  }
  afterEach(() => {
    queuedParses.length = 0
  })

  /** A guest whose answer has words and a parse pending, due `dueInMs` from now (negative: it was due that long ago). */
  const pendingParse = async (dueInMs: number, over: { parseState?: 'pending' | 'done' | 'failed'; parseRetried?: boolean } = {}) => {
    const userId = crypto.randomUUID()
    const profileId = crypto.randomUUID()
    await users.createGuestForDevice({ user: { id: userId, createdAt: new Date(NOW) }, device: { deviceHash: `scheduled-${userId}`, platform: 'ios' }, profile: { id: profileId } })
    const id = crypto.randomUUID()
    await safetyRows.append({
      id,
      profileId,
      choices: ['reaction'],
      reactionText: 'Caro White and fragrance',
      prescriptionText: null,
      parseState: over.parseState ?? 'pending',
      parseDueAt: new Date(NOW + dueInMs),
      parseRetried: over.parseRetried ?? true,
      createdAt: new Date(NOW - DAY),
    })
    return { userId, id }
  }
  const queuedIds = () => queuedParses.map((message) => (message.body as { safetyId: string }).safetyId)

  it('on the daily cron, queues the parse of a pending answer that is due, with no delay', async () => {
    const { id } = await pendingParse(-HOUR)

    await fireWithQueue(GUEST_CLEANUP_CRON)

    expect(queuedIds()).toContain(id)
    expect(queuedParses.filter((message) => (message.body as { safetyId: string }).safetyId === id)[0]!.delaySeconds ?? 0).toBe(0)
  })

  it('on the daily cron, leaves a parse that is not due yet, and one that is finished or failed, alone', async () => {
    const later = await pendingParse(DAY)
    const done = await pendingParse(-HOUR, { parseState: 'done' })
    const failed = await pendingParse(-HOUR, { parseState: 'failed' })

    await fireWithQueue(GUEST_CLEANUP_CRON)

    for (const { id } of [later, done, failed]) expect(queuedIds()).not.toContain(id)
  })

  it('on the reaper cron, which runs every 10 minutes, queues nothing: the retry is a once-a-day job', async () => {
    const { id } = await pendingParse(-HOUR)

    await fireWithQueue(SCAN_REAPER_CRON)

    expect(queuedIds()).not.toContain(id)
  })

  it('still deletes the abandoned guests on the daily cron when the sweep throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(SafetyService.prototype, 'requeueDueParses').mockRejectedValue(new Error('the sweep exploded'))
    const guest = await abandonedGuest()

    await fireWithQueue(GUEST_CLEANUP_CRON).catch(() => undefined)

    expect(await users.findById(guest)).toBeNull()
  })

  it('still queues the due parses on the daily cron when deleting the abandoned guests throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(UsersService.prototype, 'purgeUnreachableGuests').mockRejectedValue(new Error('the cleanup exploded'))
    const { id } = await pendingParse(-HOUR)

    await fireWithQueue(GUEST_CLEANUP_CRON).catch(() => undefined)

    expect(queuedIds()).toContain(id)
  })
})

// --- face scans stuck analysing: the reaper's one check ---

// A face scan sits `analysing` while Perfect Corp works, and the webhook normally wakes it. If the webhook never comes (or the first message was
// lost) the reaper looks once, 15 minutes on, by queueing the step that would have run, and gives up after 2 hours. The Worker's face-scans producer is a
// recorder here, so what the reaper queues can be read back. The reaper reads the real clock, so the scans are aged from NOW with margins far from the
// 15-minute and 2-hour lines (the exact lines are pinned in FaceScanService's unit tests).
describe('the Worker scheduled handler: face scans stuck analysing', () => {
  const faces = new D1FaceScansRepository(createDb(env.DB))
  const recorder = queueRecorder()
  const MINUTE = 60 * 1000
  const fireFaces = async (cron: string) => {
    const ctx = createExecutionContext()
    await worker.scheduled!(createScheduledController({ scheduledTime: NOW, cron }), { ...env, FACE_SCANS_QUEUE: recorder.queue } as typeof env, ctx)
    await waitOnExecutionContext(ctx)
  }
  // Failing a scan deletes its Perfect Corp task; without the stub that call goes to the real API and waits for the network.
  beforeEach(() => {
    stubPerfectCorp()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    recorder.messages.length = 0
  })

  /** A guest's face scan that has sat analysing for `ageMs`, with an analysis task at Perfect Corp when `task` is set. */
  const stuckFace = async (ageMs: number, { task = true }: { task?: boolean } = {}) => {
    const userId = crypto.randomUUID()
    const profileId = crypto.randomUUID()
    await users.createGuestForDevice({ user: { id: userId, createdAt: new Date(NOW) }, device: { deviceHash: `scheduled-${userId}`, platform: 'ios' }, profile: { id: profileId } })
    const id = crypto.randomUUID()
    const createdAt = new Date(NOW - ageMs)
    await faces.createFaceScan(
      { id, userId, profileId, goalAtScan: 'glow', createdAt },
      [{ faceScanId: id, userId, position: 'front', photoKey: `faces/${env.ENVIRONMENT}/${userId}/${profileId}/${id}/front.jpg`, createdAt }],
    )
    if (task) await faces.updateFaceScan(id, 'analysing', { pcAnalysisTaskId: `skin-${id}`, pcEnvironment: env.ENVIRONMENT, updatedAt: createdAt })
    return id
  }
  const queuedFor = (id: string) => (recorder.messages as { faceScanId: string }[]).filter((message) => message.faceScanId === id)

  it('on the reaper cron, queues the fetch step once for a scan that has sat 20 minutes with an analysis task, and notes that it looked', async () => {
    const id = await stuckFace(20 * MINUTE)

    await fireFaces(SCAN_REAPER_CRON)

    expect(queuedFor(id)).toEqual([{ faceScanId: id, step: 'fetch', at: expect.any(Number) }])
    const row = (await faces.findFaceScan(id))!
    expect(row.state).toBe('analysing')
    expect(row.reaperCheckedAt).toBeInstanceOf(Date)
  })

  it('looks only once: the next sweep queues nothing more for the same scan', async () => {
    const id = await stuckFace(20 * MINUTE)
    await fireFaces(SCAN_REAPER_CRON)
    recorder.messages.length = 0

    await fireFaces(SCAN_REAPER_CRON)

    expect(queuedFor(id)).toEqual([])
    expect((await faces.findFaceScan(id))!.state).toBe('analysing')
  })

  it('queues the upload step once for a scan that has sat 20 minutes with no analysis task, because its first message was lost', async () => {
    const id = await stuckFace(20 * MINUTE, { task: false })

    await fireFaces(SCAN_REAPER_CRON)
    await fireFaces(SCAN_REAPER_CRON)

    expect(queuedFor(id)).toEqual([{ faceScanId: id, step: 'upload', at: expect.any(Number) }])
  })

  it('fails a scan that has sat for over 2 hours as unavailable, queueing nothing for it', async () => {
    const id = await stuckFace(3 * 60 * MINUTE)

    await fireFaces(SCAN_REAPER_CRON)

    expect(await faces.findFaceScan(id)).toMatchObject({ state: 'failed', reason: 'unavailable' })
    expect(queuedFor(id)).toEqual([])
  })

  it('leaves a scan that has only sat 5 minutes alone', async () => {
    const id = await stuckFace(5 * MINUTE)

    await fireFaces(SCAN_REAPER_CRON)

    expect(await faces.findFaceScan(id)).toMatchObject({ state: 'analysing', reaperCheckedAt: null })
    expect(queuedFor(id)).toEqual([])
  })

  it('on the daily cron, does not look at face scans', async () => {
    const id = await stuckFace(20 * MINUTE)
    const old = await stuckFace(3 * 60 * MINUTE)

    await fireFaces(GUEST_CLEANUP_CRON)

    expect(queuedFor(id)).toEqual([])
    expect((await faces.findFaceScan(old))!.state).toBe('analysing')
  })

  it('still reaps face scans when the product scan sweep throws, and the run still fails with the sweep\'s error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(ScanService.prototype, 'reap').mockRejectedValue(new Error('the sweep exploded'))
    const id = await stuckFace(3 * 60 * MINUTE)

    await expect(fireFaces(SCAN_REAPER_CRON)).rejects.toThrow('the sweep exploded')

    expect((await faces.findFaceScan(id))!.state).toBe('failed')
  })

  it('still sweeps the product scans and fills in search text when the face scan sweep throws, and does not fail the run for it (it is logged)', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(FaceScanService.prototype, 'reap').mockRejectedValue(new Error('the face sweep exploded'))
    const stuck = await stuckItem(3 * HOUR)

    await expect(fireFaces(SCAN_REAPER_CRON)).resolves.toBeUndefined()

    expect(await scans.findItem(stuck)).toMatchObject({ state: 'failed', reason: 'unavailable' })
    expect(logged).toHaveBeenCalled()
  })
})
