import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createDb } from '../../src/lib/db'
import { D1ProfilesRepository } from '../../src/modules/profiles/profiles.repository'
import { D1RemindersRepository } from '../../src/modules/reminders/reminders.repository'
import { remindersRepositoryContract } from '../../src/modules/reminders/reminders.repository.contract'
import { D1UsersRepository } from '../../src/modules/users/users.repository'

const BASE = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000

const db = createDb(env.DB)
const users = new D1UsersRepository(db)
const profiles = new D1ProfilesRepository(db)

// reminder_settings references profiles, and D1 enforces it, so each contract account is a real guest (made the way the app makes
// one, which writes the default profile in the same batch).
const newGuest = async () => {
  const userId = crypto.randomUUID()
  const profileId = crypto.randomUUID()
  await users.createGuestForDevice({ user: { id: userId, createdAt: BASE }, device: { deviceHash: `reminders-contract-${userId}`, platform: 'ios' }, profile: { id: profileId } })
  return { userId, profileId }
}
const newProfile = async (userId: string) => {
  const id = crypto.randomUUID()
  await profiles.insert({ id, userId, displayName: null, isDefault: false, createdAt: BASE })
  return id
}

remindersRepositoryContract('D1', () => ({ repository: new D1RemindersRepository(db), newAccount: newGuest, newProfile }))

describe('reminder_settings in D1', () => {
  const at = (offsetMs: number) => new Date(BASE.getTime() + offsetMs)

  it('removes a user\'s settings with the user (a guest purged by the cleanup), and leaves other accounts\' rows', async () => {
    const repository = new D1RemindersRepository(db)
    const guest = await newGuest()
    const kept = await newGuest()
    await repository.upsert(guest.profileId, { enabled: true, timeZone: 'Africa/Lagos' }, at(MINUTE))
    await repository.upsert(kept.profileId, { enabled: true }, at(MINUTE))

    expect(await users.deleteUsers([guest.userId])).toBe(1)

    expect(await repository.get(guest.profileId)).toBeNull()
    expect(await repository.get(kept.profileId)).toMatchObject({ enabled: true })
  })

  it('removes a profile\'s settings with the profile, and leaves the account\'s other profiles', async () => {
    const repository = new D1RemindersRepository(db)
    const account = await newGuest()
    const second = await newProfile(account.userId)
    await repository.upsert(account.profileId, { morning: '06:00' }, at(MINUTE))
    await repository.upsert(second, { morning: '08:00' }, at(MINUTE))

    // There is no product path that deletes a profile yet; this is the schema's ON DELETE CASCADE.
    await env.DB.prepare('DELETE FROM profiles WHERE id = ?').bind(second).run()

    expect(await repository.get(second)).toBeNull()
    expect(await repository.get(account.profileId)).toMatchObject({ morning: '06:00' })
  })

  it('refuses settings for a profile that does not exist', async () => {
    const repository = new D1RemindersRepository(db)

    await expect(repository.upsert(crypto.randomUUID(), { enabled: true }, at(MINUTE))).rejects.toThrow()
  })
})
