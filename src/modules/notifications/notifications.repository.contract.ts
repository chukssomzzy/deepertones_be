import { describe, expect, it } from 'vitest'
import type { NotificationSettingsRepository, PushTokensRepository } from './notifications.repository'
import type { PushToken } from './notifications.types'

// The one clock every fixture hangs off; later times are offsets from it.
const BASE = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000
const at = (offsetMs: number) => new Date(BASE.getTime() + offsetMs)

type Account = { userId: string; profileId: string }

/**
 * What a push-token contract run needs: the repository, and a way to get an account that really exists, the way every account does
 * in life (D1 enforces push_tokens.user_id -> users and profile_id -> profiles). `newAccount` is a user with its default profile;
 * `newProfile` adds another profile to that user.
 */
export type PushTokensContractSetup = {
  repository: PushTokensRepository
  newAccount: () => Promise<Account>
  newProfile: (userId: string) => Promise<string>
}

// Device hashes and tokens are unique per call: the D1 run shares one database across every test in its file.
const rowOf = (account: Account, over: Partial<PushToken> = {}): PushToken => ({
  deviceHash: `device-${crypto.randomUUID()}`,
  token: `ExponentPushToken[${crypto.randomUUID()}]`,
  platform: 'ios',
  userId: account.userId,
  profileId: account.profileId,
  createdAt: BASE,
  updatedAt: BASE,
  ...over,
})

const hashesOf = (rows: PushToken[]) => rows.map((row) => row.deviceHash).sort()

/** Behaviour every PushTokensRepository must have. Runs against the fake (unit tier) and real local D1 (integration tier). */
export const pushTokensRepositoryContract = (name: string, make: () => PushTokensContractSetup | Promise<PushTokensContractSetup>) => {
  describe(`PushTokensRepository contract: ${name}`, () => {
    describe('upsert and find', () => {
      it('stores a new device row, and find returns it as it was given', async () => {
        const { repository, newAccount } = await make()
        const account = await newAccount()
        const row = rowOf(account, { platform: 'android', createdAt: at(MINUTE), updatedAt: at(2 * MINUTE) })

        await repository.upsert(row)

        const found = await repository.find(row.deviceHash)
        expect(found).toMatchObject({
          deviceHash: row.deviceHash,
          token: row.token,
          platform: 'android',
          userId: account.userId,
          profileId: account.profileId,
        })
        expect(found!.createdAt.getTime()).toBe(at(MINUTE).getTime())
        expect(found!.updatedAt.getTime()).toBe(at(2 * MINUTE).getTime())
      })

      it('returns null from find for an unknown device', async () => {
        const { repository } = await make()

        expect(await repository.find(`device-${crypto.randomUUID()}`)).toBeNull()
      })

      it('keeps the device row\'s original createdAt and takes the new updatedAt when it is moved', async () => {
        const { repository, newAccount } = await make()
        const first = await newAccount()
        const second = await newAccount()
        const row = rowOf(first, { createdAt: at(MINUTE), updatedAt: at(MINUTE) })
        await repository.upsert(row)

        await repository.upsert(rowOf(second, { deviceHash: row.deviceHash, createdAt: at(5 * MINUTE), updatedAt: at(6 * MINUTE) }))

        const found = await repository.find(row.deviceHash)
        expect(found!.userId).toBe(second.userId)
        expect(found!.createdAt.getTime()).toBe(at(MINUTE).getTime())
        expect(found!.updatedAt.getTime()).toBe(at(6 * MINUTE).getTime())
      })

      it('moves a device\'s row to another account and profile, with its new token, platform and time, leaving one row', async () => {
        const { repository, newAccount } = await make()
        const first = await newAccount()
        const second = await newAccount()
        const row = rowOf(first)
        await repository.upsert(row)

        const moved = rowOf(second, { deviceHash: row.deviceHash, platform: 'android', updatedAt: at(MINUTE) })
        await repository.upsert(moved)

        const found = await repository.find(row.deviceHash)
        expect(found).toMatchObject({
          token: moved.token,
          platform: 'android',
          userId: second.userId,
          profileId: second.profileId,
        })
        expect(found!.updatedAt.getTime()).toBe(at(MINUTE).getTime())
        expect(await repository.forUser(first.userId)).toEqual([])
        expect(hashesOf(await repository.forUser(second.userId))).toEqual([row.deviceHash])
      })

      it('moves a device to another profile of the same account', async () => {
        const { repository, newAccount, newProfile } = await make()
        const account = await newAccount()
        const other = await newProfile(account.userId)
        const row = rowOf(account)
        await repository.upsert(row)

        await repository.upsert({ ...row, profileId: other, updatedAt: at(MINUTE) })

        expect((await repository.find(row.deviceHash))!.profileId).toBe(other)
        expect(await repository.forProfile(account.profileId)).toEqual([])
        expect(hashesOf(await repository.forProfile(other))).toEqual([row.deviceHash])
      })

      it('keeps one row when the same device registers the same token again', async () => {
        const { repository, newAccount } = await make()
        const account = await newAccount()
        const row = rowOf(account)
        await repository.upsert(row)

        await repository.upsert({ ...row, updatedAt: at(MINUTE) })

        expect(hashesOf(await repository.forUser(account.userId))).toEqual([row.deviceHash])
        expect((await repository.find(row.deviceHash))!.token).toBe(row.token)
      })

      it('replaces a device\'s old token with its new one, so the old token is held by nobody', async () => {
        const { repository, newAccount } = await make()
        const account = await newAccount()
        const row = rowOf(account)
        await repository.upsert(row)
        const fresh = rowOf(account, { deviceHash: row.deviceHash })
        await repository.upsert(fresh)

        // The old token is free again: another device can take it, and nothing else is disturbed.
        const other = rowOf(account, { token: row.token })
        await repository.upsert(other)

        expect((await repository.find(row.deviceHash))!.token).toBe(fresh.token)
        expect((await repository.find(other.deviceHash))!.token).toBe(row.token)
        expect(hashesOf(await repository.forUser(account.userId))).toEqual([row.deviceHash, other.deviceHash].sort())
      })

      it('moves a token held by another device to the registering device, so a token lives in one row', async () => {
        const { repository, newAccount } = await make()
        const previous = await newAccount()
        const next = await newAccount()
        const holder = rowOf(previous)
        await repository.upsert(holder)

        const taker = rowOf(next, { token: holder.token })
        await repository.upsert(taker)

        expect(await repository.find(holder.deviceHash)).toBeNull()
        expect(await repository.find(taker.deviceHash)).toMatchObject({ token: holder.token, userId: next.userId })
        expect(await repository.forUser(previous.userId)).toEqual([])
      })

      it('lets a device that already holds a token take another device\'s token, leaving only that one row', async () => {
        const { repository, newAccount } = await make()
        const account = await newAccount()
        const a = rowOf(account)
        const b = rowOf(account)
        await repository.upsert(a)
        await repository.upsert(b)

        await repository.upsert({ ...a, token: b.token, updatedAt: at(MINUTE) })

        expect(await repository.find(b.deviceHash)).toBeNull()
        expect(await repository.find(a.deviceHash)).toMatchObject({ token: b.token })
        expect(hashesOf(await repository.forUser(account.userId))).toEqual([a.deviceHash])
      })

      it('lets different devices hold different tokens side by side', async () => {
        const { repository, newAccount } = await make()
        const account = await newAccount()
        const a = rowOf(account)
        const b = rowOf(account)

        await repository.upsert(a)
        await repository.upsert(b)

        expect(hashesOf(await repository.forUser(account.userId))).toEqual([a.deviceHash, b.deviceHash].sort())
      })
    })

    describe('deleteForDevice', () => {
      it('deletes the device\'s row when it belongs to that user, and says so', async () => {
        const { repository, newAccount } = await make()
        const account = await newAccount()
        const row = rowOf(account)
        await repository.upsert(row)

        expect(await repository.deleteForDevice(row.deviceHash, account.userId)).toBe(true)

        expect(await repository.find(row.deviceHash)).toBeNull()
      })

      it('leaves a row that belongs to someone else, and says nothing was deleted', async () => {
        const { repository, newAccount } = await make()
        const owner = await newAccount()
        const stranger = await newAccount()
        const row = rowOf(owner)
        await repository.upsert(row)

        expect(await repository.deleteForDevice(row.deviceHash, stranger.userId)).toBe(false)

        expect(await repository.find(row.deviceHash)).toMatchObject({ userId: owner.userId })
      })

      it('answers false for a device with no row', async () => {
        const { repository, newAccount } = await make()
        const account = await newAccount()

        expect(await repository.deleteForDevice(`device-${crypto.randomUUID()}`, account.userId)).toBe(false)
      })

      it('deletes only the one device\'s row', async () => {
        const { repository, newAccount } = await make()
        const account = await newAccount()
        const gone = rowOf(account)
        const kept = rowOf(account)
        await repository.upsert(gone)
        await repository.upsert(kept)

        await repository.deleteForDevice(gone.deviceHash, account.userId)

        expect(hashesOf(await repository.forUser(account.userId))).toEqual([kept.deviceHash])
      })
    })

    describe('deleteIfToken', () => {
      it('deletes the device\'s row when it still holds that token, and says so', async () => {
        const { repository, newAccount } = await make()
        const account = await newAccount()
        const row = rowOf(account)
        await repository.upsert(row)

        expect(await repository.deleteIfToken(row.deviceHash, row.token)).toBe(true)

        expect(await repository.find(row.deviceHash)).toBeNull()
      })

      it('leaves a row that holds a different token (the phone registered again), and says nothing was deleted', async () => {
        const { repository, newAccount } = await make()
        const account = await newAccount()
        const row = rowOf(account)
        await repository.upsert(row)
        const fresh = rowOf(account, { deviceHash: row.deviceHash, updatedAt: at(MINUTE) })
        await repository.upsert(fresh)

        expect(await repository.deleteIfToken(row.deviceHash, row.token)).toBe(false)

        expect(await repository.find(row.deviceHash)).toMatchObject({ token: fresh.token })
      })

      it('does not delete the row of another device that happens to be given the token', async () => {
        const { repository, newAccount } = await make()
        const account = await newAccount()
        const a = rowOf(account)
        const b = rowOf(account)
        await repository.upsert(a)
        await repository.upsert(b)

        expect(await repository.deleteIfToken(a.deviceHash, b.token)).toBe(false)

        expect(hashesOf(await repository.forUser(account.userId))).toEqual([a.deviceHash, b.deviceHash].sort())
      })

      it('answers false for a device with no row', async () => {
        const { repository } = await make()

        expect(await repository.deleteIfToken(`device-${crypto.randomUUID()}`, 'ExponentPushToken[nobody]')).toBe(false)
      })

      it('deletes only the one device\'s row, whichever account it is on', async () => {
        const { repository, newAccount } = await make()
        const account = await newAccount()
        const gone = rowOf(account)
        const kept = rowOf(account)
        await repository.upsert(gone)
        await repository.upsert(kept)

        await repository.deleteIfToken(gone.deviceHash, gone.token)

        expect(hashesOf(await repository.forUser(account.userId))).toEqual([kept.deviceHash])
      })
    })

    describe('deleteForUser', () => {
      it('deletes every row of the user across profiles and returns how many, leaving other users\' rows', async () => {
        const { repository, newAccount, newProfile } = await make()
        const account = await newAccount()
        const secondProfile = await newProfile(account.userId)
        const other = await newAccount()
        await repository.upsert(rowOf(account))
        await repository.upsert(rowOf(account, { profileId: secondProfile }))
        await repository.upsert(rowOf(account))
        const kept = rowOf(other)
        await repository.upsert(kept)

        expect(await repository.deleteForUser(account.userId)).toBe(3)

        expect(await repository.forUser(account.userId)).toEqual([])
        expect(hashesOf(await repository.forUser(other.userId))).toEqual([kept.deviceHash])
      })

      it('returns 0 for a user with no rows', async () => {
        const { repository, newAccount } = await make()
        const account = await newAccount()

        expect(await repository.deleteForUser(account.userId)).toBe(0)
      })
    })

    describe('forProfile and forUser', () => {
      it('forProfile returns only the rows on that profile, not the same user\'s other profile or another user\'s', async () => {
        const { repository, newAccount, newProfile } = await make()
        const account = await newAccount()
        const secondProfile = await newProfile(account.userId)
        const stranger = await newAccount()
        const onFirst = rowOf(account)
        const onFirstToo = rowOf(account)
        await repository.upsert(onFirst)
        await repository.upsert(onFirstToo)
        await repository.upsert(rowOf(account, { profileId: secondProfile }))
        await repository.upsert(rowOf(stranger))

        const rows = await repository.forProfile(account.profileId)

        expect(hashesOf(rows)).toEqual([onFirst.deviceHash, onFirstToo.deviceHash].sort())
        expect(rows.every((row) => row.profileId === account.profileId && row.userId === account.userId)).toBe(true)
      })

      it('forUser returns the rows of every profile of that user and nobody else\'s', async () => {
        const { repository, newAccount, newProfile } = await make()
        const account = await newAccount()
        const secondProfile = await newProfile(account.userId)
        const stranger = await newAccount()
        const a = rowOf(account)
        const b = rowOf(account, { profileId: secondProfile })
        await repository.upsert(a)
        await repository.upsert(b)
        await repository.upsert(rowOf(stranger))

        expect(hashesOf(await repository.forUser(account.userId))).toEqual([a.deviceHash, b.deviceHash].sort())
      })

      it('both are empty for ids nothing refers to', async () => {
        const { repository } = await make()

        expect(await repository.forProfile(crypto.randomUUID())).toEqual([])
        expect(await repository.forUser(crypto.randomUUID())).toEqual([])
      })
    })
  })
}

/** What a settings contract run needs: the repository, and a user that really exists (D1 enforces notification_settings.user_id -> users). */
export type NotificationSettingsContractSetup = {
  repository: NotificationSettingsRepository
  newUser: () => Promise<string>
}

/** Behaviour every NotificationSettingsRepository must have. Runs against the fake (unit tier) and real local D1 (integration tier). */
export const notificationSettingsRepositoryContract = (
  name: string,
  make: () => NotificationSettingsContractSetup | Promise<NotificationSettingsContractSetup>,
) => {
  describe(`NotificationSettingsRepository contract: ${name}`, () => {
    it('has no row for a user who never changed a setting', async () => {
      const { repository, newUser } = await make()

      expect(await repository.get(await newUser())).toBeNull()
    })

    it('creates the row from a partial patch, the other switch staying on, and returns the whole row', async () => {
      const { repository, newUser } = await make()
      const userId = await newUser()

      const saved = await repository.upsert(userId, { scanFinished: false }, at(MINUTE))

      expect(saved).toMatchObject({ userId, scanFinished: false, scanNeedsYou: true })
      expect(saved.updatedAt.getTime()).toBe(at(MINUTE).getTime())
      const read = await repository.get(userId)
      expect(read).toMatchObject({ userId, scanFinished: false, scanNeedsYou: true })
      expect(read!.updatedAt.getTime()).toBe(at(MINUTE).getTime())
    })

    it('merges a later patch into the stored row instead of resetting the other switch', async () => {
      const { repository, newUser } = await make()
      const userId = await newUser()
      await repository.upsert(userId, { scanFinished: false }, at(MINUTE))

      const saved = await repository.upsert(userId, { scanNeedsYou: false }, at(2 * MINUTE))

      expect(saved).toMatchObject({ scanFinished: false, scanNeedsYou: false })
      expect(saved.updatedAt.getTime()).toBe(at(2 * MINUTE).getTime())
      expect(await repository.get(userId)).toMatchObject({ scanFinished: false, scanNeedsYou: false })
    })

    it('turns a switch back on', async () => {
      const { repository, newUser } = await make()
      const userId = await newUser()
      await repository.upsert(userId, { scanFinished: false, scanNeedsYou: false }, at(MINUTE))

      const saved = await repository.upsert(userId, { scanFinished: true }, at(2 * MINUTE))

      expect(saved).toMatchObject({ scanFinished: true, scanNeedsYou: false })
    })

    it('writes both switches from a patch that names both', async () => {
      const { repository, newUser } = await make()
      const userId = await newUser()

      const saved = await repository.upsert(userId, { scanFinished: false, scanNeedsYou: false }, at(MINUTE))

      expect(saved).toMatchObject({ scanFinished: false, scanNeedsYou: false })
    })

    it('keeps each user\'s settings apart', async () => {
      const { repository, newUser } = await make()
      const a = await newUser()
      const b = await newUser()

      await repository.upsert(a, { scanFinished: false }, at(MINUTE))

      expect(await repository.get(b)).toBeNull()
      expect(await repository.get(a)).toMatchObject({ scanFinished: false })
    })

    it('answers an empty patch with the stored values (or both on when there is no row), and does not fail', async () => {
      const { repository, newUser } = await make()
      const fresh = await newUser()
      const changed = await newUser()
      await repository.upsert(changed, { scanNeedsYou: false }, at(MINUTE))

      expect(await repository.upsert(fresh, {}, at(2 * MINUTE))).toMatchObject({ scanFinished: true, scanNeedsYou: true })
      expect(await repository.upsert(changed, {}, at(2 * MINUTE))).toMatchObject({ scanFinished: true, scanNeedsYou: false })
    })
  })
}
