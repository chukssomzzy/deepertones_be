import { env } from 'cloudflare:workers'
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../../src/index'
import { createDb } from '../../src/lib/db'
import { D1FaceScansRepository } from '../../src/modules/face-scans/face-scans.repository'
import { D1UsersRepository } from '../../src/modules/users/users.repository'

// The Worker's scheduled handler runs the daily guest cleanup on its own cron and the scan reaper on theirs (see scheduled.test.ts, which pins
// the crons). This file is about what the daily cleanup does to the face scans of the guests it deletes. Every guest here is made by this file.
const GUEST_CLEANUP_CRON = '17 3 * * *'
const SCAN_REAPER_CRON = '*/10 * * * *'

const NOW = Date.now()
const DAY = 24 * 60 * 60 * 1000

const users = new D1UsersRepository(createDb(env.DB))

afterEach(() => {
  vi.restoreAllMocks()
})

const fire = async (cron: string) => {
  const ctx = createExecutionContext()
  await worker.scheduled!(createScheduledController({ scheduledTime: NOW, cron }), env, ctx)
  await waitOnExecutionContext(ctx)
}

// A guest's face photos are in the private bucket, and the rows for them cascade from the guest's profile. The cascade clears the rows but never the
// bucket, so what these tests are about is the photos: they must be gone after the daily cleanup, and must go BEFORE the rows, so a bucket that fails
// leaves everything for the next run to find.
describe('the Worker scheduled handler: face scans of the guests it deletes', () => {
  const faces = new D1FaceScansRepository(createDb(env.DB))
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])

  /** A guest with a face consent, a face scan of one photo in the bucket and its rows. Abandoned (120 days unseen, no device) or seen just now. */
  const guestWithFaceScan = async (abandoned: boolean) => {
    const userId = crypto.randomUUID()
    const profileId = crypto.randomUUID()
    const seen = new Date(NOW - (abandoned ? 120 * DAY : 0))
    await users.createGuestForDevice({ user: { id: userId, createdAt: seen }, device: { deviceHash: `scheduled-face-${userId}`, platform: 'ios' }, profile: { id: profileId } })
    if (abandoned) {
      await users.touch(userId, seen)
      await users.unlinkDevices(userId)
    }
    const scanId = crypto.randomUUID()
    const photoKey = `faces/${env.ENVIRONMENT}/${userId}/${profileId}/${scanId}/front.jpg`
    await env.PRIVATE_PHOTOS.put(photoKey, JPEG, { httpMetadata: { contentType: 'image/jpeg' } })
    await faces.giveConsent({ profileId, userId, version: 1, at: seen })
    await faces.createFaceScan(
      { id: scanId, userId, profileId, goalAtScan: 'glow', createdAt: seen },
      [{ faceScanId: scanId, userId, position: 'front', photoKey, createdAt: seen }],
    )
    return { userId, profileId, scanId, photoKey }
  }
  const bucketHolds = async (key: string) => (await env.PRIVATE_PHOTOS.head(key)) !== null

  it('on the daily cron, deletes the face photos of an abandoned guest from the bucket, and its face scans, photo rows and consent with it', async () => {
    const guest = await guestWithFaceScan(true)
    expect(await bucketHolds(guest.photoKey)).toBe(true)

    await fire(GUEST_CLEANUP_CRON)

    expect(await bucketHolds(guest.photoKey)).toBe(false)
    expect(await faces.findFaceScan(guest.scanId)).toBeNull()
    expect(await faces.photosOf(guest.scanId)).toEqual([])
    expect(await faces.consentOf(guest.profileId)).toBeNull()
    expect(await users.findById(guest.userId)).toBeNull()
  })

  it('on the daily cron, leaves the face photos and scans of a guest who is not abandoned alone', async () => {
    const abandoned = await guestWithFaceScan(true)
    const kept = await guestWithFaceScan(false)

    await fire(GUEST_CLEANUP_CRON)

    expect(await bucketHolds(abandoned.photoKey)).toBe(false)
    expect(await bucketHolds(kept.photoKey)).toBe(true)
    expect(await faces.findFaceScan(kept.scanId)).not.toBeNull()
    expect(await faces.consentOf(kept.profileId)).not.toBeNull()
    expect(await users.findById(kept.userId)).not.toBeNull()
  })

  it('on the reaper cron, which has nothing to do with the guests, leaves an abandoned guest\'s face photos alone', async () => {
    const guest = await guestWithFaceScan(true)

    await fire(SCAN_REAPER_CRON)

    expect(await bucketHolds(guest.photoKey)).toBe(true)
    expect(await faces.findFaceScan(guest.scanId)).not.toBeNull()
  })

  it('deletes the photos before the rows: with the bucket down the run fails and the guest, its rows and its photo are all left for the next run, which then clears them', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const guest = await guestWithFaceScan(true)
    const bucketDown = {
      get: (...args: Parameters<R2Bucket['get']>) => env.PRIVATE_PHOTOS.get(...args),
      put: (...args: Parameters<R2Bucket['put']>) => env.PRIVATE_PHOTOS.put(...args),
      delete: async () => {
        throw new Error('bucket is down')
      },
    } as unknown as R2Bucket
    const ctx = createExecutionContext()

    await expect(worker.scheduled!(createScheduledController({ scheduledTime: NOW, cron: GUEST_CLEANUP_CRON }), { ...env, PRIVATE_PHOTOS: bucketDown } as typeof env, ctx)).rejects.toThrow()
    await waitOnExecutionContext(ctx).catch(() => undefined)

    expect(await bucketHolds(guest.photoKey)).toBe(true)
    expect(await faces.findFaceScan(guest.scanId)).not.toBeNull()
    expect(await users.findById(guest.userId)).not.toBeNull()
    await fire(GUEST_CLEANUP_CRON)
    expect(await bucketHolds(guest.photoKey)).toBe(false)
    expect(await faces.findFaceScan(guest.scanId)).toBeNull()
    expect(await users.findById(guest.userId)).toBeNull()
  })

  // The overlay masks are PNG objects in the same bucket. The analysis writes them later; here they are put by hand, with their rows, as it will.
  describe('the masks of a scan', () => {
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    const withMasks = async (abandoned: boolean) => {
      const guest = await guestWithFaceScan(abandoned)
      const maskKeys = ['hd-acne', 'hd-redness'].map((concern) => `faces/${env.ENVIRONMENT}/${guest.userId}/${guest.profileId}/${guest.scanId}/mask-${concern}.png`)
      for (const key of maskKeys) await env.PRIVATE_PHOTOS.put(key, PNG, { httpMetadata: { contentType: 'image/png' } })
      for (const [i, key] of maskKeys.entries()) {
        await env.DB.prepare('INSERT INTO face_masks (face_scan_id, user_id, concern, mask_key) VALUES (?, ?, ?, ?)').bind(guest.scanId, guest.userId, `concern-${i}`, key).run()
        await env.DB.prepare('INSERT INTO face_results (face_scan_id, user_id, concern, region, raw_score, ui_score) VALUES (?, ?, ?, ?, ?, ?)').bind(guest.scanId, guest.userId, `concern-${i}`, 'whole', 40, 60).run()
      }
      return { ...guest, maskKeys }
    }

    it('on the daily cron, deletes the mask objects of an abandoned guest from the bucket with its photo, and leaves a guest who is not abandoned\'s masks', async () => {
      const abandoned = await withMasks(true)
      const kept = await withMasks(false)
      for (const key of abandoned.maskKeys) expect(await bucketHolds(key)).toBe(true)

      await fire(GUEST_CLEANUP_CRON)

      for (const key of [...abandoned.maskKeys, abandoned.photoKey]) expect(await bucketHolds(key)).toBe(false)
      for (const key of [...kept.maskKeys, kept.photoKey]) expect(await bucketHolds(key)).toBe(true)
      expect(await faces.keysOfFaceScan(abandoned.scanId)).toEqual([])
      expect(await faces.keysOfFaceScan(kept.scanId)).toHaveLength(3)
    })

    it('on the daily cron, removes the mask and result rows of an abandoned guest', async () => {
      const guest = await withMasks(true)

      await fire(GUEST_CLEANUP_CRON)

      for (const table of ['face_masks', 'face_results']) {
        expect((await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE user_id = ?`).bind(guest.userId).first<{ n: number }>())!.n).toBe(0)
      }
    })

    it('deletes the masks before the rows: with the bucket down the masks and their rows are all left for the next run', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined)
      const guest = await withMasks(true)
      const bucketDown = {
        get: (...args: Parameters<R2Bucket['get']>) => env.PRIVATE_PHOTOS.get(...args),
        put: (...args: Parameters<R2Bucket['put']>) => env.PRIVATE_PHOTOS.put(...args),
        delete: async () => {
          throw new Error('bucket is down')
        },
      } as unknown as R2Bucket
      const ctx = createExecutionContext()

      await expect(worker.scheduled!(createScheduledController({ scheduledTime: NOW, cron: GUEST_CLEANUP_CRON }), { ...env, PRIVATE_PHOTOS: bucketDown } as typeof env, ctx)).rejects.toThrow()
      await waitOnExecutionContext(ctx).catch(() => undefined)

      for (const key of guest.maskKeys) expect(await bucketHolds(key)).toBe(true)
      expect(await faces.keysOfFaceScan(guest.scanId)).toHaveLength(3)
      await fire(GUEST_CLEANUP_CRON)
      for (const key of guest.maskKeys) expect(await bucketHolds(key)).toBe(false)
    })
  })
})
