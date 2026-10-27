import { env } from 'cloudflare:workers'
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../../src/index'
import { buildContainer } from '../../src/container'
import { createDb } from '../../src/lib/db'
import { ProductCatalogService } from '../../src/modules/catalog/catalog.service'
import { parseEmailAddress } from '../../src/lib/email-address'
import { D1GoalsRepository } from '../../src/modules/goals/goals.repository'
import { D1FaceScansRepository } from '../../src/modules/face-scans/face-scans.repository'
import { FaceScanService } from '../../src/modules/face-scans/face-scans.service'
import { D1SafetyRepository } from '../../src/modules/safety/safety.repository'
import { SafetyService } from '../../src/modules/safety/safety.service'
import { D1ScansRepository } from '../../src/modules/scans/scans.repository'
import { ScanService } from '../../src/modules/scans/scans.service'
import { D1UsersRepository } from '../../src/modules/users/users.repository'
import { UsersService } from '../../src/modules/users/users.service'
import { ReminderSendsService } from '../../src/modules/reminders/reminders.sends.service'
import { D1RoutinesRepository } from '../../src/modules/routines/routines.repository'
import { D1VerdictsRepository } from '../../src/modules/verdicts/verdicts.repository'
import { queueRecorder, stubPerfectCorp } from './perfect-corp.stub'

// The Worker's scheduled handler is one export for every cron in wrangler.jsonc. Each cron runs its own job and no other:
// the daily guest cleanup must not run every 10 minutes, nor the reaper once a day. The crons are pinned to the config in
// scripts/wrangler-config.test.ts.
const GUEST_CLEANUP_CRON = '17 3 * * *'
const SCAN_REAPER_CRON = '*/10 * * * *'
const REMINDERS_CRON = '*/15 * * * *'

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

// --- the "check-in due" push ---

// A verified profile whose current goal's chase has a ready day one that reached its review point (six weeks after it was taken), with no check-in
// taken, is sent one push by the daily cron: FaceScanService.sendDueCheckIns (the rules are pinned in its unit tests). The cron reads the real clock, so the
// day ones here are aged from NOW with margins of days from the six-week line. The Worker's push producer is a recorder, so what the cron queues can be read back.
describe('the Worker scheduled handler: check-in due pushes', () => {
  const faces = new D1FaceScansRepository(createDb(env.DB))
  const goalRows = new D1GoalsRepository(createDb(env.DB))
  const pushes = queueRecorder()
  const fireWithPushes = async (cron: string) => {
    const ctx = createExecutionContext()
    await worker.scheduled!(createScheduledController({ scheduledTime: NOW, cron }), { ...env, PUSH_DELIVERY_QUEUE: pushes.queue } as typeof env, ctx)
    await waitOnExecutionContext(ctx)
  }
  afterEach(() => {
    pushes.messages.length = 0
    pushes.state.failing = false
  })

  /** A verified user whose glow goal was set 60 days ago and whose ready day-one scan was taken `takenAgoMs` ago. */
  const dayOneTakenAgo = async (takenAgoMs: number) => {
    const userId = crypto.randomUUID()
    const profileId = crypto.randomUUID()
    await users.createGuestForDevice({ user: { id: userId, createdAt: new Date(NOW) }, device: { deviceHash: `scheduled-${userId}`, platform: 'ios' }, profile: { id: profileId } })
    await users.promote(userId, { kind: 'email', email: parseEmailAddress(`${userId}@example.com`) }, new Date(NOW))
    await goalRows.append({ id: crypto.randomUUID(), profileId, text: null, goal: 'glow', wantsLighter: false, answersVersion: 1, createdAt: new Date(NOW - 60 * DAY) })
    const id = crypto.randomUUID()
    const createdAt = new Date(NOW - takenAgoMs)
    await faces.createFaceScan(
      { id, userId, profileId, goalAtScan: 'glow', checkIn: false, createdAt },
      [{ faceScanId: id, userId, position: 'front', photoKey: `faces/${env.ENVIRONMENT}/${userId}/${profileId}/${id}/front.jpg`, createdAt }],
    )
    await faces.completeFaceScan(id, { results: [], masks: [], skinType: null, skinAge: null, tablesVersion: '1', updatedAt: new Date(createdAt.getTime() + HOUR) })
    return { userId, profileId, id }
  }
  const pushedFor = (profileId: string) => (pushes.messages as { profileId?: string }[]).filter((message) => message.profileId === profileId)

  it('on the daily cron, queues one check-in-due push, carrying only ids, for a day one past its review point', async () => {
    const due = await dayOneTakenAgo(50 * DAY)

    await fireWithPushes(GUEST_CLEANUP_CRON)

    expect(pushedFor(due.profileId)).toEqual([{ kind: 'face-check-in-due', userId: due.userId, profileId: due.profileId, dayOneScanId: due.id }])
  })

  it('on the daily cron, leaves a day one that has not reached its review point alone', async () => {
    const early = await dayOneTakenAgo(34 * DAY)

    await fireWithPushes(GUEST_CLEANUP_CRON)

    expect(pushedFor(early.profileId)).toEqual([])
  })

  it('on a second daily cron, sends nothing more for the same chase', async () => {
    const due = await dayOneTakenAgo(50 * DAY)
    await fireWithPushes(GUEST_CLEANUP_CRON)

    await fireWithPushes(GUEST_CLEANUP_CRON)

    expect(pushedFor(due.profileId)).toHaveLength(1)
  })

  it('on the reaper cron, which runs every 10 minutes, queues nothing: the check-in push is a once-a-day job', async () => {
    const due = await dayOneTakenAgo(50 * DAY)

    await fireWithPushes(SCAN_REAPER_CRON)

    expect(pushedFor(due.profileId)).toEqual([])
  })

  it('calls the sweep with the time of the run', async () => {
    const sweep = vi.spyOn(FaceScanService.prototype, 'sendDueCheckIns').mockResolvedValue(0)
    const before = Date.now()

    await fireWithPushes(GUEST_CLEANUP_CRON)

    expect(sweep).toHaveBeenCalledTimes(1)
    const when = sweep.mock.calls[0]![0]
    expect(when).toBeInstanceOf(Date)
    expect(when.getTime()).toBeGreaterThanOrEqual(before)
    expect(when.getTime()).toBeLessThanOrEqual(Date.now())
  })

  it('still deletes the abandoned guests and queues the due safety parses when the check-in sweep throws, and the run still fails with its error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(FaceScanService.prototype, 'sendDueCheckIns').mockRejectedValue(new Error('the check-in sweep exploded'))
    const guest = await abandonedGuest()

    await expect(fireWithPushes(GUEST_CLEANUP_CRON)).rejects.toThrow('the check-in sweep exploded')

    expect(await users.findById(guest)).toBeNull()
  })

  it('logs a failed check-in sweep as { job, outcome: failed } with a scrubbed error', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(FaceScanService.prototype, 'sendDueCheckIns').mockRejectedValue(new Error('the check-in sweep exploded'))

    await fireWithPushes(GUEST_CLEANUP_CRON).catch(() => undefined)

    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ job: 'face-check-in-push', outcome: 'failed' }))
  })

  it('still sends the check-in pushes when deleting the abandoned guests throws, and the run still fails with that error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(UsersService.prototype, 'purgeUnreachableGuests').mockRejectedValue(new Error('the cleanup exploded'))
    const due = await dayOneTakenAgo(50 * DAY)

    await expect(fireWithPushes(GUEST_CLEANUP_CRON)).rejects.toThrow('the cleanup exploded')

    expect(pushedFor(due.profileId)).toHaveLength(1)
  })

  it('still sends the check-in pushes when the safety requeue throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(SafetyService.prototype, 'requeueDueParses').mockRejectedValue(new Error('the sweep exploded'))
    const due = await dayOneTakenAgo(50 * DAY)

    await fireWithPushes(GUEST_CLEANUP_CRON).catch(() => undefined)

    expect(pushedFor(due.profileId)).toHaveLength(1)
  })

  it('still requeues the due safety parses when the check-in sweep throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(FaceScanService.prototype, 'sendDueCheckIns').mockRejectedValue(new Error('the check-in sweep exploded'))
    const requeue = vi.spyOn(SafetyService.prototype, 'requeueDueParses')

    await fireWithPushes(GUEST_CLEANUP_CRON).catch(() => undefined)

    expect(requeue).toHaveBeenCalledTimes(1)
  })
})

// --- the second try of a shelf verdict's fit that failed ---

// A verdict whose fit judge failed three times is shown without the fit and given one more try 24 hours on: the row carries the due time, and the daily
// cron queues it with VerdictService.requeueDueFits (the rules are pinned in its unit tests). The Worker's verdicts producer is a recorder here. The sweep is
// spied on through the service the container builds, not by importing the class, so a Worker without the service fails these tests and no others of this file.
describe('the Worker scheduled handler: verdict fit retries due', () => {
  const verdictRows = new D1VerdictsRepository(createDb(env.DB))
  const verdictQueue = queueRecorder()
  const pushes = queueRecorder()
  const fireWithVerdicts = async (cron: string) => {
    const ctx = createExecutionContext()
    await worker.scheduled!(createScheduledController({ scheduledTime: NOW, cron }), { ...env, VERDICTS_QUEUE: verdictQueue.queue, PUSH_DELIVERY_QUEUE: pushes.queue } as typeof env, ctx)
    await waitOnExecutionContext(ctx)
  }
  const verdictsServicePrototype = () => Object.getPrototypeOf(buildContainer(env).verdicts) as { requeueDueFits(now: Date): Promise<number> }
  afterEach(() => {
    verdictQueue.messages.length = 0
    pushes.messages.length = 0
  })

  /** A guest whose verdict is ready without its fit, with the retry due `dueInMs` from now (negative: it was due that long ago), or no retry due when null. */
  const verdictWithRetry = async (dueInMs: number | null) => {
    const userId = crypto.randomUUID()
    const profileId = crypto.randomUUID()
    const fingerprint = `fingerprint-${profileId}`
    await users.createGuestForDevice({ user: { id: userId, createdAt: new Date(NOW) }, device: { deviceHash: `scheduled-${userId}`, platform: 'ios' }, profile: { id: profileId } })
    await verdictRows.requestBuild(profileId, fingerprint, new Date(NOW - 2 * DAY), new Date(NOW - 3 * DAY))
    await verdictRows.setFitState(profileId, { fitAttempts: 3, fitRetried: dueInMs !== null, fitRetryDueAt: dueInMs === null ? null : new Date(NOW + dueInMs) })
    return { userId, profileId, fingerprint }
  }
  const queuedFor = (profileId: string) => verdictQueue.messages.filter((message) => (message as { profileId: string }).profileId === profileId)

  it('on the daily cron, queues the retry of a verdict whose retry is due, marked as the retry', async () => {
    const due = await verdictWithRetry(-HOUR)

    await fireWithVerdicts(GUEST_CLEANUP_CRON)

    expect(queuedFor(due.profileId)).toEqual([{ profileId: due.profileId, fingerprint: due.fingerprint, requestedAt: expect.any(Number), waits: 0, retry: true }])
  })

  it('on the daily cron, leaves a verdict whose retry is not due yet, and one with no retry scheduled, alone', async () => {
    const later = await verdictWithRetry(DAY)
    const none = await verdictWithRetry(null)

    await fireWithVerdicts(GUEST_CLEANUP_CRON)

    expect(queuedFor(later.profileId)).toEqual([])
    expect(queuedFor(none.profileId)).toEqual([])
  })

  it('on the reaper cron, which runs every 10 minutes, queues nothing: the retry is a once-a-day job', async () => {
    const due = await verdictWithRetry(-HOUR)

    await fireWithVerdicts(SCAN_REAPER_CRON)

    expect(queuedFor(due.profileId)).toEqual([])
  })

  it('calls the sweep with the time of the run', async () => {
    const sweep = vi.spyOn(verdictsServicePrototype(), 'requeueDueFits').mockResolvedValue(0)
    const before = Date.now()

    await fireWithVerdicts(GUEST_CLEANUP_CRON)

    expect(sweep).toHaveBeenCalledTimes(1)
    const when = sweep.mock.calls[0]![0]
    expect(when).toBeInstanceOf(Date)
    expect(when.getTime()).toBeGreaterThanOrEqual(before)
    expect(when.getTime()).toBeLessThanOrEqual(Date.now())
  })

  it('still queues the due verdict retries when the safety requeue throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(SafetyService.prototype, 'requeueDueParses').mockRejectedValue(new Error('the sweep exploded'))
    const due = await verdictWithRetry(-HOUR)

    await fireWithVerdicts(GUEST_CLEANUP_CRON).catch(() => undefined)

    expect(queuedFor(due.profileId)).toHaveLength(1)
  })

  it('still queues the due verdict retries when deleting the abandoned guests throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(UsersService.prototype, 'purgeUnreachableGuests').mockRejectedValue(new Error('the cleanup exploded'))
    const due = await verdictWithRetry(-HOUR)

    await fireWithVerdicts(GUEST_CLEANUP_CRON).catch(() => undefined)

    expect(queuedFor(due.profileId)).toHaveLength(1)
  })

  it('still queues the due verdict retries when the check-in sweep throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(FaceScanService.prototype, 'sendDueCheckIns').mockRejectedValue(new Error('the check-in sweep exploded'))
    const due = await verdictWithRetry(-HOUR)

    await fireWithVerdicts(GUEST_CLEANUP_CRON).catch(() => undefined)

    expect(queuedFor(due.profileId)).toHaveLength(1)
  })

  it('still deletes the abandoned guests and sends the check-in pushes when the verdict sweep throws, and the run still fails with its error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(verdictsServicePrototype(), 'requeueDueFits').mockRejectedValue(new Error('the verdict sweep exploded'))
    const sweep = vi.spyOn(FaceScanService.prototype, 'sendDueCheckIns').mockResolvedValue(0)
    const guest = await abandonedGuest()

    await expect(fireWithVerdicts(GUEST_CLEANUP_CRON)).rejects.toThrow('the verdict sweep exploded')

    expect(await users.findById(guest)).toBeNull()
    expect(sweep).toHaveBeenCalledTimes(1)
  })
})


// --- the routines sweeps (spec #189, PR 3c) ---

// The daily cron ends with RoutineService.sweep(now): the dead-letter retries due, the writer retries due and the routines holding a retired product, each
// capped at 200 (their rules are pinned in routines.service.test.ts and the repository contract). It runs after the verdict sweep, in its own try like the others, and a
// failure is rethrown after everything else has run. It does nothing while routines are switched off: ROUTINES_ENABLED is false in the Worker's default
// environment (wrangler.jsonc), so the tests that need it on say so in the env they hand the Worker. The routines producer is a recorder. The sweep is spied on
// through the service the container builds, as the verdict sweep is, so a Worker without the service fails these tests and no others of this file.
describe('the Worker scheduled handler: routines sweeps', () => {
  const routineRows = new D1RoutinesRepository(createDb(env.DB))
  const routineQueue = queueRecorder()
  const verdictQueue = queueRecorder()
  const pushes = queueRecorder()
  const fireWithRoutines = async (cron: string, enabled = true) => {
    const ctx = createExecutionContext()
    const bindings = { ...env, ROUTINES_QUEUE: routineQueue.queue, VERDICTS_QUEUE: verdictQueue.queue, PUSH_DELIVERY_QUEUE: pushes.queue, ...(enabled ? { ROUTINES_ENABLED: 'true' } : {}) }
    await worker.scheduled!(createScheduledController({ scheduledTime: NOW, cron }), bindings as typeof env, ctx)
    await waitOnExecutionContext(ctx)
  }
  const routinesServicePrototype = () => Object.getPrototypeOf(buildContainer(env).routines) as { sweep(now: Date): Promise<number> }
  const verdictsServicePrototype = () => Object.getPrototypeOf(buildContainer(env).verdicts) as { requeueDueFits(now: Date): Promise<number> }
  afterEach(() => {
    routineQueue.messages.length = 0
    verdictQueue.messages.length = 0
    pushes.messages.length = 0
  })

  /** An account whose build request dead-lettered a day ago, so its retry is due now. Only a verified account is built a routine, so it has verified unless it is to stay a guest. */
  const deadLetteredGuest = async ({ verified = true }: { verified?: boolean } = {}) => {
    const userId = crypto.randomUUID()
    const profileId = crypto.randomUUID()
    await users.createGuestForDevice({ user: { id: userId, createdAt: new Date(NOW) }, device: { deviceHash: `scheduled-routines-${userId}`, platform: 'ios' }, profile: { id: profileId } })
    if (verified) await users.promote(userId, { kind: 'email', email: parseEmailAddress(`${userId}@example.com`) }, new Date(NOW))
    await routineRows.claim(profileId, 'routine-fp-1', new Date(NOW - 2 * DAY), new Date(NOW - 3 * DAY))
    await routineRows.setRequestRetry(profileId, { retried: true, retryDueAt: new Date(NOW - HOUR) })
    return profileId
  }
  const queuedFor = (profileId: string) => routineQueue.messages.filter((message) => (message as { profileId: string }).profileId === profileId)

  it('on the daily cron, queues the retry of a build request whose retry is due, marked as the retry', async () => {
    const profileId = await deadLetteredGuest()

    await fireWithRoutines(GUEST_CLEANUP_CRON)

    expect(queuedFor(profileId)).toEqual([{ profileId, reason: expect.any(String), requestKey: 'routine-fp-1', requestedAt: expect.any(Number), waits: 0, retry: true }])
  })

  it('queues nothing for a guest, and drops the retry so it stops being due', async () => {
    const profileId = await deadLetteredGuest({ verified: false })

    await fireWithRoutines(GUEST_CLEANUP_CRON)

    expect(queuedFor(profileId)).toEqual([])
    expect((await routineRows.findRequest(profileId))!.retryDueAt).toBeNull()
  })

  it('queues nothing while routines are switched off, which is how the Worker is configured by default', async () => {
    const profileId = await deadLetteredGuest()

    await fireWithRoutines(GUEST_CLEANUP_CRON, false)

    expect(queuedFor(profileId)).toEqual([])
    expect((await routineRows.findRequest(profileId))!.retryDueAt).not.toBeNull()
  })

  it('on the reaper cron, which runs every 10 minutes, queues nothing: the sweeps are a once-a-day job', async () => {
    const profileId = await deadLetteredGuest()

    await fireWithRoutines(SCAN_REAPER_CRON)

    expect(queuedFor(profileId)).toEqual([])
  })

  it('calls the sweep once, with the time of the run', async () => {
    const sweep = vi.spyOn(routinesServicePrototype(), 'sweep').mockResolvedValue(0)
    const before = Date.now()

    await fireWithRoutines(GUEST_CLEANUP_CRON)

    expect(sweep).toHaveBeenCalledTimes(1)
    const when = sweep.mock.calls[0]![0]
    expect(when).toBeInstanceOf(Date)
    expect(when.getTime()).toBeGreaterThanOrEqual(before)
    expect(when.getTime()).toBeLessThanOrEqual(Date.now())
  })

  it('runs the routines sweep after the verdict sweep', async () => {
    const verdicts = vi.spyOn(verdictsServicePrototype(), 'requeueDueFits').mockResolvedValue(0)
    const routines = vi.spyOn(routinesServicePrototype(), 'sweep').mockResolvedValue(0)

    await fireWithRoutines(GUEST_CLEANUP_CRON)

    expect(verdicts).toHaveBeenCalledTimes(1)
    expect(routines).toHaveBeenCalledTimes(1)
    expect(verdicts.mock.invocationCallOrder[0]!).toBeLessThan(routines.mock.invocationCallOrder[0]!)
  })

  it('still runs the routines sweep when the verdict sweep throws, and the run still fails with the verdict sweep\'s error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(verdictsServicePrototype(), 'requeueDueFits').mockRejectedValue(new Error('the verdict sweep exploded'))
    const routines = vi.spyOn(routinesServicePrototype(), 'sweep').mockResolvedValue(0)

    await expect(fireWithRoutines(GUEST_CLEANUP_CRON)).rejects.toThrow('the verdict sweep exploded')

    expect(routines).toHaveBeenCalledTimes(1)
  })

  it('still deletes the abandoned guests, queues the due safety parses, sends the check-in pushes and queues the verdict retries when the routines sweep throws, and the run still fails with its error', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(routinesServicePrototype(), 'sweep').mockRejectedValue(new Error('the routines sweep exploded'))
    const parses = vi.spyOn(SafetyService.prototype, 'requeueDueParses').mockResolvedValue(0)
    const checkIns = vi.spyOn(FaceScanService.prototype, 'sendDueCheckIns').mockResolvedValue(0)
    const verdicts = vi.spyOn(verdictsServicePrototype(), 'requeueDueFits').mockResolvedValue(0)
    const guest = await abandonedGuest()

    await expect(fireWithRoutines(GUEST_CLEANUP_CRON)).rejects.toThrow('the routines sweep exploded')

    expect(await users.findById(guest)).toBeNull()
    expect(parses).toHaveBeenCalledTimes(1)
    expect(checkIns).toHaveBeenCalledTimes(1)
    expect(verdicts).toHaveBeenCalledTimes(1)
  })

  it('fails the run with the first failure when the routines sweep throws after an earlier sweep did', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(SafetyService.prototype, 'requeueDueParses').mockRejectedValue(new Error('the safety sweep exploded'))
    vi.spyOn(routinesServicePrototype(), 'sweep').mockRejectedValue(new Error('the routines sweep exploded'))

    await expect(fireWithRoutines(GUEST_CLEANUP_CRON)).rejects.toThrow('the safety sweep exploded')
  })

  it('logs a failed routines sweep with a scrubbed error and no words of the error\'s own', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(routinesServicePrototype(), 'sweep').mockRejectedValue(new Error('the routines sweep exploded with Karo Glow Cream'))

    await fireWithRoutines(GUEST_CLEANUP_CRON).catch(() => undefined)

    const text = logged.mock.calls.map((call) => JSON.stringify(call)).join('\n')
    expect(text).toContain('failed')
    expect(text).not.toContain('Karo Glow Cream')
  })
})

// --- the reminder send job ---

// Every 15 minutes the Worker asks ReminderSendsService.sendDue which reminders are due. The window is a slot on the quarter hour, so the job is given the time the
// cron was SCHEDULED for (controller.scheduledTime), not the moment the Worker happened to start. What is sent is pinned in reminders.sends.service.test.ts; here only the wiring.
describe('the Worker scheduled handler: the reminder send job', () => {
  const SLOT = Date.UTC(2030, 5, 15, 6, 45)
  const fireReminders = async (cron: string, scheduledTime = SLOT) => {
    const ctx = createExecutionContext()
    await worker.scheduled!(createScheduledController({ scheduledTime, cron }), env, ctx)
    await waitOnExecutionContext(ctx)
  }

  it('on the 15 minute cron, sends the due reminders once, for the time the cron was scheduled for', async () => {
    const sweep = vi.spyOn(ReminderSendsService.prototype, 'sendDue').mockResolvedValue(0)

    await fireReminders(REMINDERS_CRON)

    expect(sweep).toHaveBeenCalledTimes(1)
    expect(sweep.mock.calls[0]![0]).toEqual(new Date(SLOT))
  })

  it('on the daily and the 10 minute crons, sends no reminders', async () => {
    const sweep = vi.spyOn(ReminderSendsService.prototype, 'sendDue').mockResolvedValue(0)

    await fireReminders(GUEST_CLEANUP_CRON)
    await fireReminders(SCAN_REAPER_CRON)

    expect(sweep).not.toHaveBeenCalled()
  })

  it('on the 15 minute cron, runs neither the guest cleanup nor the scan reaper', async () => {
    vi.spyOn(ReminderSendsService.prototype, 'sendDue').mockResolvedValue(0)
    const stuck = await stuckItem(3 * HOUR)
    const guest = await abandonedGuest()

    await fireReminders(REMINDERS_CRON)

    expect(await scans.findItem(stuck)).toMatchObject({ state: 'recognising' })
    expect(await users.findById(guest)).not.toBeNull()
  })

  it('fails the run when the send job throws, and logs it as { job, outcome: failed } with a scrubbed error', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(ReminderSendsService.prototype, 'sendDue').mockRejectedValue(new Error('the send job exploded with ExponentPushToken[abc]'))

    await expect(fireReminders(REMINDERS_CRON)).rejects.toThrow('the send job exploded')

    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ job: 'reminder-send', outcome: 'failed' }))
    expect(logged.mock.calls.map((call) => JSON.stringify(call)).join('\n')).not.toContain('ExponentPushToken[abc]')
  })
})
