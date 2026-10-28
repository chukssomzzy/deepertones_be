import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createDb } from '../../src/lib/db'
import { D1ProfilesRepository } from '../../src/modules/profiles/profiles.repository'
import { D1StepPausesRepository } from '../../src/modules/skin-care/skin-care.pauses.repository'
import { stepPausesRepositoryContract } from '../../src/modules/skin-care/skin-care.pauses.repository.contract'
import type { NewStepPause } from '../../src/modules/skin-care/skin-care.types'
import { D1UsersRepository } from '../../src/modules/users/users.repository'

const BASE = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000

const db = createDb(env.DB)
const users = new D1UsersRepository(db)
const profiles = new D1ProfilesRepository(db)

// step_pauses references profiles, and D1 enforces it, so each contract account is a real guest (made the way the app makes one,
// which writes the default profile in the same batch).
const newGuest = async () => {
  const userId = crypto.randomUUID()
  const profileId = crypto.randomUUID()
  await users.createGuestForDevice({ user: { id: userId, createdAt: BASE }, device: { deviceHash: `step-pauses-contract-${userId}`, platform: 'ios' }, profile: { id: profileId } })
  return { userId, profileId }
}

stepPausesRepositoryContract('D1', () => ({ repository: new D1StepPausesRepository(db), newAccount: newGuest }))

const pauseFor = (profileId: string, over: Partial<NewStepPause> = {}): NewStepPause => ({
  id: crypto.randomUUID(),
  profileId,
  step: 'treat',
  productKey: `prod-${profileId}`,
  productId: `prod-${profileId}`,
  productRef: { kind: 'shelf', id: 'entry-1' },
  ingredientGroup: null,
  state: 'paused',
  pausedOn: '2030-06-15',
  checkDay: '2030-06-18',
  sameCount: 0,
  sourceLogId: null,
  ladderCode: null,
  ladderStartedOn: null,
  versionId: null,
  createdAt: new Date(BASE.getTime() + MINUTE),
  ...over,
})

describe('step_pauses in D1', () => {
  it('removes a user\'s pauses with the user (a guest purged by the cleanup), and leaves other accounts\' pauses', async () => {
    const repository = new D1StepPausesRepository(db)
    const guest = await newGuest()
    const kept = await newGuest()
    await repository.insert(pauseFor(guest.profileId))
    await repository.insert(pauseFor(kept.profileId))

    expect(await users.deleteUsers([guest.userId])).toBe(1)

    expect(await repository.openFor(guest.profileId)).toEqual([])
    expect(await repository.openFor(kept.profileId)).toHaveLength(1)
  })

  it('removes a profile\'s pauses with the profile, and leaves the account\'s other profiles', async () => {
    const repository = new D1StepPausesRepository(db)
    const account = await newGuest()
    const second = crypto.randomUUID()
    await profiles.insert({ id: second, userId: account.userId, displayName: null, isDefault: false, createdAt: BASE })
    await repository.insert(pauseFor(account.profileId))
    await repository.insert(pauseFor(second))

    // There is no product path that deletes a profile yet; this is the schema's ON DELETE CASCADE.
    await env.DB.prepare('DELETE FROM profiles WHERE id = ?').bind(second).run()

    expect(await repository.openFor(second)).toEqual([])
    expect(await repository.openFor(account.profileId)).toHaveLength(1)
  })

  it('refuses a pause for a profile that does not exist', async () => {
    const repository = new D1StepPausesRepository(db)

    await expect(repository.insert(pauseFor(crypto.randomUUID()))).rejects.toThrow()
  })
})
