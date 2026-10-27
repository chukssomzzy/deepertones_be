import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createDb } from '../../src/lib/db'
import { D1ProfilesRepository } from '../../src/modules/profiles/profiles.repository'
import { D1RoutineCheckInsRepository } from '../../src/modules/routines/routines.check-ins.repository'
import { routineCheckInsRepositoryContract } from '../../src/modules/routines/routines.check-ins.repository.contract'
import { D1UsersRepository } from '../../src/modules/users/users.repository'

const BASE = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000
const DAY = 24 * 60 * MINUTE
const at = (offsetMs: number) => new Date(BASE.getTime() + offsetMs)
const day = (n: number) => new Date(BASE.getTime() + n * DAY).toISOString().slice(0, 10)

const db = createDb(env.DB)
const users = new D1UsersRepository(db)
const profiles = new D1ProfilesRepository(db)

// routine_check_ins references profiles, and D1 enforces it, so each contract account is a real guest (made the way the app makes one, which writes the default
// profile in the same batch).
const newGuest = async () => {
  const userId = crypto.randomUUID()
  const profileId = crypto.randomUUID()
  await users.createGuestForDevice({ user: { id: userId, createdAt: BASE }, device: { deviceHash: `check-ins-contract-${userId}`, platform: 'ios' }, profile: { id: profileId } })
  return { userId, profileId }
}

routineCheckInsRepositoryContract('D1', () => ({ repository: new D1RoutineCheckInsRepository(db), newAccount: newGuest }))

describe('routine_check_ins in D1', () => {
  it('removes a user\'s check-ins with the user (a guest purged by the cleanup), and leaves other accounts\' rows', async () => {
    const repository = new D1RoutineCheckInsRepository(db)
    const guest = await newGuest()
    const kept = await newGuest()
    await repository.record(guest.profileId, day(0), 'morning', at(MINUTE))
    await repository.record(kept.profileId, day(0), 'morning', at(MINUTE))

    expect(await users.deleteUsers([guest.userId])).toBe(1)

    expect(await repository.list(guest.profileId, day(-1), day(1))).toEqual([])
    expect(await repository.list(kept.profileId, day(-1), day(1))).toHaveLength(1)
  })

  it('removes a profile\'s check-ins with the profile, and leaves the account\'s other profiles', async () => {
    const repository = new D1RoutineCheckInsRepository(db)
    const account = await newGuest()
    const second = crypto.randomUUID()
    await profiles.insert({ id: second, userId: account.userId, displayName: null, isDefault: false, createdAt: BASE })
    await repository.record(account.profileId, day(0), 'morning', at(MINUTE))
    await repository.record(second, day(0), 'evening', at(MINUTE))

    // There is no product path that deletes a profile yet; this is the schema's ON DELETE CASCADE.
    await env.DB.prepare('DELETE FROM profiles WHERE id = ?').bind(second).run()

    expect(await repository.list(second, day(-1), day(1))).toEqual([])
    expect(await repository.list(account.profileId, day(-1), day(1))).toHaveLength(1)
  })

  it('refuses a check-in for a profile that does not exist', async () => {
    const repository = new D1RoutineCheckInsRepository(db)

    await expect(repository.record(crypto.randomUUID(), day(0), 'morning', at(MINUTE))).rejects.toThrow()
  })
})
