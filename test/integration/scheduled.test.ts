import { env } from 'cloudflare:workers'
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../../src/index'
import { createDb } from '../../src/lib/db'
import { ProductCatalogService } from '../../src/modules/catalog/catalog.service'
import { D1ScansRepository } from '../../src/modules/scans/scans.repository'
import { ScanService } from '../../src/modules/scans/scans.service'
import { D1UsersRepository } from '../../src/modules/users/users.repository'

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
