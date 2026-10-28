import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createDb } from '../../src/lib/db'
import { D1ProfilesRepository } from '../../src/modules/profiles/profiles.repository'
import { SKIN_OUTCOME_RULES_VERSION } from '../../src/modules/skin-care/skin-care.outcomes'
import { D1SkinCareRepository } from '../../src/modules/skin-care/skin-care.repository'
import { skinCareRepositoryContract } from '../../src/modules/skin-care/skin-care.repository.contract'
import type { NewSkinLog } from '../../src/modules/skin-care/skin-care.types'
import { D1UsersRepository } from '../../src/modules/users/users.repository'

const BASE = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000

const db = createDb(env.DB)
const users = new D1UsersRepository(db)
const profiles = new D1ProfilesRepository(db)

// skin_logs references profiles, and D1 enforces it, so each contract account is a real guest (made the way the app makes one,
// which writes the default profile in the same batch).
const newGuest = async () => {
  const userId = crypto.randomUUID()
  const profileId = crypto.randomUUID()
  await users.createGuestForDevice({ user: { id: userId, createdAt: BASE }, device: { deviceHash: `skin-care-contract-${userId}`, platform: 'ios' }, profile: { id: profileId } })
  return { userId, profileId }
}

skinCareRepositoryContract('D1', () => ({ repository: new D1SkinCareRepository(db), newAccount: newGuest }))

const logFor = (profileId: string, over: Partial<NewSkinLog> = {}): NewSkinLog => ({
  id: crypto.randomUUID(),
  profileId,
  noticing: ['stinging-or-burning'],
  where: [],
  howBad: 'mild',
  note: null,
  localDay: '2030-06-15',
  outcome: 'pause',
  reason: null,
  rulesVersion: SKIN_OUTCOME_RULES_VERSION,
  createdAt: new Date(BASE.getTime() + MINUTE),
  ...over,
})

describe('skin_logs in D1', () => {
  it('removes a user\'s logs with the user (a guest purged by the cleanup), and leaves other accounts\' logs', async () => {
    const repository = new D1SkinCareRepository(db)
    const guest = await newGuest()
    const kept = await newGuest()
    await repository.append(logFor(guest.profileId))
    await repository.append(logFor(kept.profileId))

    expect(await users.deleteUsers([guest.userId])).toBe(1)

    expect(await repository.recent(guest.profileId, 20)).toEqual([])
    expect(await repository.recent(kept.profileId, 20)).toHaveLength(1)
  })

  it('removes a profile\'s logs with the profile, and leaves the account\'s other profiles', async () => {
    const repository = new D1SkinCareRepository(db)
    const account = await newGuest()
    const second = crypto.randomUUID()
    await profiles.insert({ id: second, userId: account.userId, displayName: null, isDefault: false, createdAt: BASE })
    await repository.append(logFor(account.profileId))
    await repository.append(logFor(second))

    // There is no product path that deletes a profile yet; this is the schema's ON DELETE CASCADE.
    await env.DB.prepare('DELETE FROM profiles WHERE id = ?').bind(second).run()

    expect(await repository.recent(second, 20)).toEqual([])
    expect(await repository.recent(account.profileId, 20)).toHaveLength(1)
  })

  it('refuses a log for a profile that does not exist', async () => {
    const repository = new D1SkinCareRepository(db)

    await expect(repository.append(logFor(crypto.randomUUID()))).rejects.toThrow()
  })
})
