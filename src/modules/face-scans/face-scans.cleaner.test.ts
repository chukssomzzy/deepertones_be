import { describe, expect, it } from 'vitest'
import { runAs } from '../../lib/context'
import { MemoryPhotoStore } from '../../providers/photo-store/memory.photo-store'
import { markedJpeg } from '../scans/scans.photos.fake'
import { FaceDataCleaner } from './face-scans.cleaner'
import { FakeFaceScansRepository } from './face-scans.repository.fake'

const T0 = new Date('2030-06-15T12:00:00.000Z')
const USER = 'user-1'
const OTHER_USER = 'user-2'

const setup = () => {
  const repository = new FakeFaceScansRepository()
  const photos = new MemoryPhotoStore({ environment: 'test' })
  return { repository, photos, cleaner: new FaceDataCleaner({ repository, photos }) }
}
type Ctx = ReturnType<typeof setup>

const cleanup = <T>(fn: () => Promise<T>) => runAs({ kind: 'system', job: 'guest-cleanup' }, fn)

const keyOf = (userId: string, scanId: string, position: string) => `faces/test/${userId}/profile-${userId}/${scanId}/${position}.jpg`

/** Two users, each with a consent and a face scan of two photos (front and right), all four photos in the bucket. */
const twoUsers = async (ctx: Ctx) => {
  const out: Record<string, { scanId: string; frontKey: string; profileId: string }> = {}
  for (const userId of [USER, OTHER_USER]) {
    const scanId = `face-scan-${userId}`
    const profileId = `profile-${userId}`
    const scan = { id: scanId, userId, profileId, goalAtScan: 'glow' as const, createdAt: T0 }
    const photos = (['front', 'right'] as const).map((position) => ({ faceScanId: scanId, userId, position, photoKey: keyOf(userId, scanId, position), createdAt: T0 }))
    await ctx.repository.giveConsent({ profileId, userId, version: 1, at: T0 })
    await ctx.repository.createFaceScan(scan, photos)
    for (const photo of photos) await ctx.photos.put(photo.photoKey, markedJpeg(1))
    out[userId] = { scanId, frontKey: keyOf(userId, scanId, 'front'), profileId }
  }
  return out
}

describe('FaceDataCleaner.deleteForUsers (guest cleanup)', () => {
  it('deletes every face photo of those users, and their face scans, photo rows and consent, and nobody else\'s', async () => {
    const ctx = setup()
    const { [USER]: mine, [OTHER_USER]: theirs } = await twoUsers(ctx)
    expect(ctx.photos.stored.size).toBe(4)

    await cleanup(() => ctx.cleaner.deleteForUsers([USER]))

    expect([...ctx.photos.stored.keys()].every((key) => key.startsWith(`faces/test/${OTHER_USER}/`))).toBe(true)
    expect(ctx.photos.stored.size).toBe(2)
    expect(await ctx.repository.findFaceScan(mine!.scanId)).toBeNull()
    expect(await ctx.repository.photosOf(mine!.scanId)).toEqual([])
    expect(await ctx.repository.consentOf(mine!.profileId)).toBeNull()
    expect(await ctx.repository.findFaceScan(theirs!.scanId)).not.toBeNull()
    expect(await ctx.repository.photosOf(theirs!.scanId)).toHaveLength(2)
    expect(await ctx.repository.consentOf(theirs!.profileId)).not.toBeNull()
  })

  it('is safe to repeat, and safe when a photo is already gone', async () => {
    const ctx = setup()
    const { [USER]: mine } = await twoUsers(ctx)
    ctx.photos.stored.delete(mine!.frontKey)

    await cleanup(() => ctx.cleaner.deleteForUsers([USER]))
    await expect(cleanup(() => ctx.cleaner.deleteForUsers([USER]))).resolves.toBeUndefined()

    expect(await ctx.repository.findFaceScan(mine!.scanId)).toBeNull()
  })

  it('does nothing for no users', async () => {
    const ctx = setup()
    await twoUsers(ctx)

    await cleanup(() => ctx.cleaner.deleteForUsers([]))

    expect(ctx.photos.stored.size).toBe(4)
  })

  it('leaves product photos alone: it deletes only what the face tables list', async () => {
    const ctx = setup()
    await twoUsers(ctx)
    const productKey = `photos/test/${USER}/some-scan/some-item.jpg`
    await ctx.photos.put(productKey, markedJpeg(2))

    await cleanup(() => ctx.cleaner.deleteForUsers([USER]))

    expect(ctx.photos.stored.has(productKey)).toBe(true)
  })

  it('deletes the photos before the rows, so a failed photo delete leaves the rows for the next run to try again', async () => {
    class DeleteFails extends MemoryPhotoStore {
      fail = true
      override async deleteMany(keys: string[]): Promise<void> {
        if (this.fail) throw new Error('bucket is down')
        return super.deleteMany(keys)
      }
    }
    const repository = new FakeFaceScansRepository()
    const photos = new DeleteFails({ environment: 'test' })
    const ctx = { repository, photos, cleaner: new FaceDataCleaner({ repository, photos }) }
    const { [USER]: mine } = await twoUsers(ctx)

    await expect(cleanup(() => ctx.cleaner.deleteForUsers([USER]))).rejects.toThrow('bucket is down')

    expect(await repository.findFaceScan(mine!.scanId)).not.toBeNull()
    expect(await repository.photosOf(mine!.scanId)).toHaveLength(2)
    photos.fail = false
    await cleanup(() => ctx.cleaner.deleteForUsers([USER]))
    expect(await repository.findFaceScan(mine!.scanId)).toBeNull()
    expect([...photos.stored.keys()].some((key) => key.includes(`/${USER}/`))).toBe(false)
  })
})
