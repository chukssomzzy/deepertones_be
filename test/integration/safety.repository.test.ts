import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createDb } from '../../src/lib/db'
import { D1ProfilesRepository } from '../../src/modules/profiles/profiles.repository'
import { D1SafetyRepository } from '../../src/modules/safety/safety.repository'
import { safetyRepositoryContract } from '../../src/modules/safety/safety.repository.contract'
import { D1UsersRepository } from '../../src/modules/users/users.repository'

const BASE = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000

const db = createDb(env.DB)
const users = new D1UsersRepository(db)
const profiles = new D1ProfilesRepository(db)

// profile_safety references profiles, and D1 enforces it, so each contract account is a real guest (made the way the app makes
// one, which writes the default profile in the same batch).
const newGuest = async () => {
  const userId = crypto.randomUUID()
  const profileId = crypto.randomUUID()
  await users.createGuestForDevice({ user: { id: userId, createdAt: BASE }, device: { deviceHash: `safety-contract-${userId}`, platform: 'ios' }, profile: { id: profileId } })
  return { userId, profileId }
}
const newProfile = async (userId: string) => {
  const id = crypto.randomUUID()
  await profiles.insert({ id, userId, displayName: null, isDefault: false, createdAt: BASE })
  return id
}

safetyRepositoryContract('D1', () => ({ repository: new D1SafetyRepository(db), newAccount: newGuest, newProfile }))

describe('profile_safety in D1', () => {
  const row = (profileId: string, over: Partial<Parameters<D1SafetyRepository['append']>[0]> = {}) => ({
    id: `safety-${crypto.randomUUID()}`,
    profileId,
    choices: ['pregnant' as const],
    reactionText: null,
    prescriptionText: null,
    parseState: 'none' as const,
    parseDueAt: null,
    createdAt: new Date(BASE.getTime() + MINUTE),
    ...over,
  })

  it('removes a user\'s safety rows with the user (a guest purged by the cleanup), and leaves other accounts\' rows', async () => {
    const repository = new D1SafetyRepository(db)
    const guest = await newGuest()
    const kept = await newGuest()
    await repository.append(row(guest.profileId))
    await repository.append(row(guest.profileId, { choices: ['reaction'], reactionText: 'fragrance', createdAt: new Date(BASE.getTime() + 2 * MINUTE) }))
    await repository.append(row(kept.profileId))

    expect(await users.deleteUsers([guest.userId])).toBe(1)

    expect(await repository.history(guest.profileId)).toEqual([])
    expect(await repository.current(guest.profileId)).toBeNull()
    expect(await repository.history(kept.profileId)).toHaveLength(1)
  })

  it('refuses a row for a profile that does not exist', async () => {
    const repository = new D1SafetyRepository(db)

    await expect(repository.append(row(crypto.randomUUID()))).rejects.toThrow()
  })

  // Rows that existed before the parse (migration 0025) were saved with nothing to parse, so the new columns must default to that.
  it('gives a row written without a parse state (as every row was before the parse existed) the state none and no due time', async () => {
    const repository = new D1SafetyRepository(db)
    const guest = await newGuest()
    const id = `safety-${crypto.randomUUID()}`

    await env.DB.prepare('INSERT INTO profile_safety (id, profile_id, choices, created_at) VALUES (?, ?, ?, ?)')
      .bind(id, guest.profileId, JSON.stringify(['pregnant']), BASE.getTime())
      .run()

    expect(await repository.find(id)).toMatchObject({ choices: ['pregnant'], parseState: 'none', parseDueAt: null })
  })

  it('stores the due time to the millisecond', async () => {
    const repository = new D1SafetyRepository(db)
    const guest = await newGuest()
    const due = new Date(BASE.getTime() + 3_600_123)
    const saved = row(guest.profileId, { choices: ['reaction'], reactionText: 'x', parseState: 'pending', parseDueAt: due })
    await repository.append(saved)

    expect((await repository.find(saved.id))!.parseDueAt!.getTime()).toBe(due.getTime())
  })
})

describe('safety_mentions in D1', () => {
  const row = (profileId: string, over: Partial<Parameters<D1SafetyRepository['append']>[0]> = {}) => ({
    id: `safety-${crypto.randomUUID()}`,
    profileId,
    choices: ['reaction' as const],
    reactionText: 'Caro White and fragrance',
    prescriptionText: null,
    parseState: 'pending' as const,
    parseDueAt: new Date(BASE.getTime() + MINUTE),
    createdAt: new Date(BASE.getTime() + MINUTE),
    ...over,
  })
  const mention = (safetyId: string, over: Partial<Parameters<D1SafetyRepository['appendMentions']>[0][number]> = {}) => ({
    id: `mention-${crypto.randomUUID()}`,
    safetyId,
    source: 'reaction' as const,
    kind: 'product' as const,
    brand: 'Caro White',
    name: 'Caro White',
    variant: null,
    category: 'skin',
    productId: null,
    resolution: 'pending' as const,
    position: 0,
    createdAt: new Date(BASE.getTime() + MINUTE),
    ...over,
  })

  it('removes the mentions of a user\'s safety rows with the user (a guest purged by the cleanup), and leaves other accounts\' mentions', async () => {
    const repository = new D1SafetyRepository(db)
    const guest = await newGuest()
    const kept = await newGuest()
    const goneRow = row(guest.profileId)
    const keptRow = row(kept.profileId)
    await repository.append(goneRow)
    await repository.append(keptRow)
    await repository.appendMentions([mention(goneRow.id), mention(goneRow.id, { kind: 'ingredient', name: 'fragrance', brand: null, category: null, resolution: null, position: 1 })])
    await repository.appendMentions([mention(keptRow.id)])

    expect(await users.deleteUsers([guest.userId])).toBe(1)

    expect(await repository.mentions(goneRow.id)).toEqual([])
    expect(await repository.mentions(keptRow.id)).toHaveLength(1)
  })

  it('refuses a mention for a safety row that does not exist', async () => {
    const repository = new D1SafetyRepository(db)

    await expect(repository.appendMentions([mention(`safety-${crypto.randomUUID()}`)])).rejects.toThrow()
  })

  it('stores nothing of a batch when one of its mentions is refused', async () => {
    const repository = new D1SafetyRepository(db)
    const guest = await newGuest()
    const saved = row(guest.profileId)
    await repository.append(saved)

    await expect(repository.appendMentions([mention(saved.id), mention(`safety-${crypto.randomUUID()}`, { position: 1 })])).rejects.toThrow()

    expect(await repository.mentions(saved.id)).toEqual([])
  })
})
