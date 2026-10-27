import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createDb } from '../../src/lib/db'
import { D1ProfilesRepository } from '../../src/modules/profiles/profiles.repository'
import { D1ReminderSendsRepository } from '../../src/modules/reminders/reminders.sends.repository'
import { reminderSendsRepositoryContract } from '../../src/modules/reminders/reminders.sends.repository.contract'
import { D1UsersRepository } from '../../src/modules/users/users.repository'

const BASE = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000
const at = (offsetMs: number) => new Date(BASE.getTime() + offsetMs)
const LOCAL_DAY = BASE.toISOString().slice(0, 10)

const db = createDb(env.DB)
const users = new D1UsersRepository(db)
const profiles = new D1ProfilesRepository(db)

// reminder_sends references profiles, and D1 enforces it, so each contract account is a real guest (made the way the app makes one, which writes the default
// profile in the same batch).
const newGuest = async () => {
  const userId = crypto.randomUUID()
  const profileId = crypto.randomUUID()
  await users.createGuestForDevice({ user: { id: userId, createdAt: BASE }, device: { deviceHash: `sends-contract-${userId}`, platform: 'ios' }, profile: { id: profileId } })
  return { userId, profileId }
}

reminderSendsRepositoryContract('D1', () => ({ repository: new D1ReminderSendsRepository(db), newAccount: newGuest }))

// The table is read directly here only because the repository has no read: the cascade is a property of the schema, and a claim cannot show that its row went.
const rowsOf = async (profileId: string) => (await env.DB.prepare('SELECT COUNT(*) AS n FROM reminder_sends WHERE profile_id = ?').bind(profileId).first<{ n: number }>())!.n

describe('reminder_sends in D1', () => {
  it('removes a user\'s sends with the user (a guest purged by the cleanup), and leaves other accounts\' rows', async () => {
    const repository = new D1ReminderSendsRepository(db)
    const guest = await newGuest()
    const kept = await newGuest()
    await repository.claim(guest.profileId, LOCAL_DAY, 'morning', at(MINUTE))
    await repository.claim(kept.profileId, LOCAL_DAY, 'morning', at(MINUTE))

    expect(await users.deleteUsers([guest.userId])).toBe(1)

    expect(await rowsOf(guest.profileId)).toBe(0)
    expect(await rowsOf(kept.profileId)).toBe(1)
  })

  it('removes a profile\'s sends with the profile, and leaves the account\'s other profiles', async () => {
    const repository = new D1ReminderSendsRepository(db)
    const account = await newGuest()
    const second = crypto.randomUUID()
    await profiles.insert({ id: second, userId: account.userId, displayName: null, isDefault: false, createdAt: BASE })
    await repository.claim(account.profileId, LOCAL_DAY, 'morning', at(MINUTE))
    await repository.claim(second, LOCAL_DAY, 'evening', at(MINUTE))

    // There is no product path that deletes a profile yet; this is the schema's ON DELETE CASCADE.
    await env.DB.prepare('DELETE FROM profiles WHERE id = ?').bind(second).run()

    expect(await rowsOf(second)).toBe(0)
    expect(await rowsOf(account.profileId)).toBe(1)
  })

  it('refuses a claim for a profile that does not exist', async () => {
    const repository = new D1ReminderSendsRepository(db)

    await expect(repository.claim(crypto.randomUUID(), LOCAL_DAY, 'morning', at(MINUTE))).rejects.toThrow()
  })
})
