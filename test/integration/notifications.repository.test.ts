import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createDb } from '../../src/lib/db'
import { D1NotificationSettingsRepository, D1PushTokensRepository } from '../../src/modules/notifications/notifications.repository'
import {
  notificationSettingsRepositoryContract,
  pushTokensRepositoryContract,
} from '../../src/modules/notifications/notifications.repository.contract'
import { D1ProfilesRepository } from '../../src/modules/profiles/profiles.repository'
import { D1UsersRepository } from '../../src/modules/users/users.repository'

const BASE = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000

const db = createDb(env.DB)
const users = new D1UsersRepository(db)
const profiles = new D1ProfilesRepository(db)

// push_tokens and notification_settings reference users and profiles, and D1 enforces it, so each contract account is a real guest
// (made the way the app makes one, which writes the default profile in the same batch).
const newGuest = async () => {
  const userId = crypto.randomUUID()
  const profileId = crypto.randomUUID()
  await users.createGuestForDevice({ user: { id: userId, createdAt: BASE }, device: { deviceHash: `notifications-contract-${userId}`, platform: 'ios' }, profile: { id: profileId } })
  return { userId, profileId }
}
const newProfile = async (userId: string) => {
  const id = crypto.randomUUID()
  await profiles.insert({ id, userId, displayName: null, isDefault: false, createdAt: BASE })
  return id
}

pushTokensRepositoryContract('D1', () => ({ repository: new D1PushTokensRepository(db), newAccount: newGuest, newProfile }))
notificationSettingsRepositoryContract('D1', () => ({ repository: new D1NotificationSettingsRepository(db), newUser: async () => (await newGuest()).userId }))

describe('push_tokens in D1', () => {
  const row = (account: { userId: string; profileId: string }, over: Partial<Parameters<D1PushTokensRepository['upsert']>[0]> = {}) => ({
    deviceHash: `device-${crypto.randomUUID()}`,
    token: `ExponentPushToken[${crypto.randomUUID()}]`,
    platform: 'ios' as const,
    userId: account.userId,
    profileId: account.profileId,
    createdAt: BASE,
    updatedAt: BASE,
    ...over,
  })

  it('moves a token off its old holder atomically: a write that fails leaves the old holder in place', async () => {
    const repository = new D1PushTokensRepository(db)
    const holderAccount = await newGuest()
    const holder = row(holderAccount)
    await repository.upsert(holder)

    // A profile that does not exist makes the device-row write fail (foreign key); the delete of the old holder must roll back with it.
    await expect(repository.upsert(row(holderAccount, { token: holder.token, profileId: crypto.randomUUID() }))).rejects.toThrow()

    expect(await repository.find(holder.deviceHash)).toMatchObject({ token: holder.token })
  })

  it('removes a user\'s rows with the user (a guest purged by the cleanup)', async () => {
    const repository = new D1PushTokensRepository(db)
    const guest = await newGuest()
    const kept = await newGuest()
    await repository.upsert(row(guest))
    await repository.upsert(row(kept))

    expect(await users.deleteUsers([guest.userId])).toBe(1)

    expect(await repository.forUser(guest.userId)).toEqual([])
    expect(await repository.forUser(kept.userId)).toHaveLength(1)
  })

  it('removes a profile\'s rows with the profile', async () => {
    const repository = new D1PushTokensRepository(db)
    const account = await newGuest()
    const second = await newProfile(account.userId)
    const onDefault = row(account)
    await repository.upsert(onDefault)
    await repository.upsert(row(account, { profileId: second }))

    // There is no product path that deletes a profile yet; this is the schema's ON DELETE CASCADE.
    await env.DB.prepare('DELETE FROM profiles WHERE id = ?').bind(second).run()

    expect((await repository.forUser(account.userId)).map((r) => r.deviceHash)).toEqual([onDefault.deviceHash])
  })
})

describe('notification_settings in D1', () => {
  it('removes a user\'s settings with the user', async () => {
    const repository = new D1NotificationSettingsRepository(db)
    const guest = await newGuest()
    await repository.upsert(guest.userId, { scanFinished: false }, new Date(BASE.getTime() + MINUTE))

    await users.deleteUsers([guest.userId])

    expect(await repository.get(guest.userId)).toBeNull()
  })
})
