import { describe, expect, it } from 'vitest'
import { runAs } from '../../lib/context'
import { MemoryPhotoStore } from '../../providers/photo-store/memory.photo-store'
import { ScanDataCleaner } from './scans.cleaner'
import { markedJpeg } from './scans.photos.fake'
import { FakeScansRepository } from './scans.repository.fake'

const T0 = new Date('2030-06-15T12:00:00.000Z')
const USER = 'user-1'
const OTHER_USER = 'user-2'

const setup = () => {
  const repository = new FakeScansRepository()
  const photos = new MemoryPhotoStore({ environment: 'test' })
  return { repository, photos, cleaner: new ScanDataCleaner({ repository, photos }) }
}
type Ctx = ReturnType<typeof setup>

const cleanup = <T>(fn: () => Promise<T>) => runAs({ kind: 'system', job: 'guest-cleanup' }, fn)

/** Two users, each with a scan of two items whose first also has a back photo (three photos kept for each). */
const twoUsers = async (ctx: Ctx) => {
  const out: Record<string, { scanId: string; itemId: string; frontKey: string }> = {}
  for (const userId of [USER, OTHER_USER]) {
    const scanId = `scan-${userId}`
    const items = [0, 1].map((position) => ({
      id: `item-${userId}-${position}`,
      scanId,
      userId,
      position,
      photoKey: `photos/test/${userId}/${scanId}/item-${userId}-${position}.jpg`,
      createdAt: T0,
    }))
    await ctx.repository.createScan({ id: scanId, userId, ipHash: `ip-${userId}`, createdAt: T0 }, items)
    for (const item of items) await ctx.photos.put(item.photoKey, markedJpeg(item.position))
    const backKey = `photos/test/${userId}/${scanId}/${items[0]!.id}-back.jpg`
    await ctx.photos.put(backKey, markedJpeg(9))
    await ctx.repository.updateItem(items[0]!.id, 'recognising', { state: 'needs-back-photo', updatedAt: T0 })
    await ctx.repository.updateItem(
      items[0]!.id,
      'needs-back-photo',
      { state: 'reading-label', backPhotoKey: backKey, updatedAt: T0 },
      { id: `upload-${userId}`, itemId: items[0]!.id, userId, ipHash: `ip-${userId}`, uploadedAt: T0 },
    )
    out[userId] = { scanId, itemId: items[0]!.id, frontKey: items[0]!.photoKey }
  }
  return out
}

describe('ScanDataCleaner.deleteForUsers (guest cleanup)', () => {
  it('deletes every photo and back photo of those users, and their scans, items and upload records, and nobody else\'s', async () => {
    const ctx = setup()
    const { [USER]: mine, [OTHER_USER]: theirs } = await twoUsers(ctx)
    expect(ctx.photos.stored.size).toBe(6)

    await cleanup(() => ctx.cleaner.deleteForUsers([USER]))

    expect([...ctx.photos.stored.keys()].every((key) => key.startsWith(`photos/test/${OTHER_USER}/`))).toBe(true)
    expect(ctx.photos.stored.size).toBe(3)
    expect(await ctx.repository.findScan(mine!.scanId)).toBeNull()
    expect(await ctx.repository.findItem(mine!.itemId)).toBeNull()
    expect(await ctx.repository.photosSince(USER, new Date(0))).toEqual({ count: 0, oldest: null })
    expect(await ctx.repository.findScan(theirs!.scanId)).not.toBeNull()
    expect(await ctx.repository.itemsOf(theirs!.scanId)).toHaveLength(2)
    expect((await ctx.repository.photosSince(OTHER_USER, new Date(0))).count).toBe(3)
  })

  it('is safe to repeat, and safe when a photo is already gone', async () => {
    const ctx = setup()
    const { [USER]: mine } = await twoUsers(ctx)
    ctx.photos.stored.delete(mine!.frontKey)

    await cleanup(() => ctx.cleaner.deleteForUsers([USER]))
    await expect(cleanup(() => ctx.cleaner.deleteForUsers([USER]))).resolves.toBeUndefined()

    expect(await ctx.repository.findScan(mine!.scanId)).toBeNull()
  })

  it('does nothing for no users', async () => {
    const ctx = setup()
    await twoUsers(ctx)

    await cleanup(() => ctx.cleaner.deleteForUsers([]))

    expect(ctx.photos.stored.size).toBe(6)
  })

  it('deletes the photos before the rows, so a failed photo delete leaves the rows for the next run to try again', async () => {
    class DeleteFails extends MemoryPhotoStore {
      fail = true
      override async deleteMany(keys: string[]): Promise<void> {
        if (this.fail) throw new Error('bucket is down')
        return super.deleteMany(keys)
      }
    }
    const repository = new FakeScansRepository()
    const photos = new DeleteFails({ environment: 'test' })
    const ctx = { repository, photos, cleaner: new ScanDataCleaner({ repository, photos }) }
    const { [USER]: mine } = await twoUsers(ctx)

    await expect(cleanup(() => ctx.cleaner.deleteForUsers([USER]))).rejects.toThrow('bucket is down')

    expect(await repository.findScan(mine!.scanId)).not.toBeNull()
    photos.fail = false
    await cleanup(() => ctx.cleaner.deleteForUsers([USER]))
    expect(await repository.findScan(mine!.scanId)).toBeNull()
    expect([...photos.stored.keys()].some((key) => key.includes(`/${USER}/`))).toBe(false)
  })
})
