import { env } from 'cloudflare:workers'
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../../src/index'
import { createDb } from '../../src/lib/db'
import { D1ScansRepository } from '../../src/modules/scans/scans.repository'
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
  await scans.createScan({ id: scanId, userId, profileId, ipHash: `ip-${scanId}`, createdAt }, [
    { id: itemId, scanId, userId, position: 0, photoKey: `photos/${env.ENVIRONMENT}/${userId}/${scanId}/${itemId}.jpg`, createdAt },
  ])
  return itemId
}

const fire = async (cron: string) => {
  const ctx = createExecutionContext()
  await worker.scheduled!(createScheduledController({ scheduledTime: NOW, cron }), env, ctx)
  await waitOnExecutionContext(ctx)
}

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
