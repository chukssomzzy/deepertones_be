import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createDb } from '../../src/lib/db'
import { D1ProfilesRepository } from '../../src/modules/profiles/profiles.repository'
import { D1EscalationHoldsRepository } from '../../src/modules/skin-care/skin-care.holds.repository'
import { escalationHoldsRepositoryContract } from '../../src/modules/skin-care/skin-care.holds.repository.contract'
import type { NewEscalationHold } from '../../src/modules/skin-care/skin-care.types'
import { D1UsersRepository } from '../../src/modules/users/users.repository'

const BASE = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000

const db = createDb(env.DB)
const users = new D1UsersRepository(db)
const profiles = new D1ProfilesRepository(db)

// escalation_holds references profiles, and D1 enforces it, so each contract account is a real guest (made the way the app makes one,
// which writes the default profile in the same batch).
const newGuest = async () => {
  const userId = crypto.randomUUID()
  const profileId = crypto.randomUUID()
  await users.createGuestForDevice({ user: { id: userId, createdAt: BASE }, device: { deviceHash: `holds-contract-${userId}`, platform: 'ios' }, profile: { id: profileId } })
  return { userId, profileId }
}

escalationHoldsRepositoryContract('D1', () => ({ repository: new D1EscalationHoldsRepository(db), newAccount: newGuest }))

const holdFor = (profileId: string, over: Partial<NewEscalationHold> = {}): NewEscalationHold => ({
  id: crypto.randomUUID(),
  profileId,
  reason: 'swelling',
  sourceLogId: null,
  openedOn: BASE.toISOString().slice(0, 10),
  openedAt: new Date(BASE.getTime() + MINUTE),
  ...over,
})

type Raw = { id: string; closed_at: number | null; closed_how: string | null }
// The contract has no way to read a closed hold, so the closing columns are read straight from the table here (the one place a test looks past the repository).
const rawRow = (id: string) => env.DB.prepare('SELECT id, closed_at, closed_how FROM escalation_holds WHERE id = ?').bind(id).first<Raw>()
const rawInsertOpen = (id: string, profileId: string) =>
  env.DB.prepare('INSERT INTO escalation_holds (id, profile_id, reason, source_log_id, opened_on, opened_at, closed_at, closed_how) VALUES (?, ?, ?, NULL, ?, ?, NULL, NULL)')
    .bind(id, profileId, 'swelling', BASE.toISOString().slice(0, 10), BASE.getTime())
    .run()

describe('escalation_holds in D1', () => {
  it('records when and how a hold was closed, and the first close is the one that stays', async () => {
    const repository = new D1EscalationHoldsRepository(db)
    const { profileId } = await newGuest()
    const hold = holdFor(profileId)
    await repository.open(hold)
    const closedAt = new Date(BASE.getTime() + 5 * MINUTE)

    expect(await repository.close(profileId, hold.id, 'settled', closedAt)).toBe(true)
    expect(await repository.close(profileId, hold.id, 'seen', new Date(BASE.getTime() + 9 * MINUTE))).toBe(false)

    expect(await rawRow(hold.id)).toEqual({ id: hold.id, closed_at: closedAt.getTime(), closed_how: 'settled' })
  })

  it('leaves an open hold with closed_at and closed_how null', async () => {
    const repository = new D1EscalationHoldsRepository(db)
    const { profileId } = await newGuest()
    const hold = holdFor(profileId)
    await repository.open(hold)

    expect(await rawRow(hold.id)).toEqual({ id: hold.id, closed_at: null, closed_how: null })
  })

  it('enforces one open hold per profile in the table itself, not only in the repository', async () => {
    const repository = new D1EscalationHoldsRepository(db)
    const { profileId } = await newGuest()
    const hold = holdFor(profileId)
    await repository.open(hold)

    // A write that skips the repository's own check still meets the partial unique index.
    await expect(rawInsertOpen(crypto.randomUUID(), profileId)).rejects.toThrow()

    expect(await repository.openFor(profileId)).toMatchObject({ id: hold.id })
  })

  it('lets the table hold a closed hold beside an open one for the same profile', async () => {
    const repository = new D1EscalationHoldsRepository(db)
    const { profileId } = await newGuest()
    const closed = holdFor(profileId)
    await repository.open(closed)
    await repository.close(profileId, closed.id, 'seen', new Date(BASE.getTime() + 2 * MINUTE))

    await rawInsertOpen(crypto.randomUUID(), profileId)

    expect((await repository.openFor(profileId))?.id).not.toBe(closed.id)
  })

  it('removes a user\'s holds with the user (a guest purged by the cleanup), and leaves other accounts\' holds', async () => {
    const repository = new D1EscalationHoldsRepository(db)
    const guest = await newGuest()
    const kept = await newGuest()
    const guestHold = holdFor(guest.profileId)
    await repository.open(guestHold)
    await repository.open(holdFor(kept.profileId))

    expect(await users.deleteUsers([guest.userId])).toBe(1)

    expect(await repository.openFor(guest.profileId)).toBeNull()
    expect(await rawRow(guestHold.id)).toBeNull()
    expect(await repository.openFor(kept.profileId)).not.toBeNull()
  })

  it('removes a profile\'s holds, open and closed, with the profile, and leaves the account\'s other profiles', async () => {
    const repository = new D1EscalationHoldsRepository(db)
    const account = await newGuest()
    const second = crypto.randomUUID()
    await profiles.insert({ id: second, userId: account.userId, displayName: null, isDefault: false, createdAt: BASE })
    const closed = holdFor(second)
    await repository.open(closed)
    await repository.close(second, closed.id, 'seen', new Date(BASE.getTime() + 2 * MINUTE))
    const open = holdFor(second, { reason: 'near-eyes' })
    await repository.open(open)
    await repository.open(holdFor(account.profileId))

    // There is no product path that deletes a profile yet; this is the schema's ON DELETE CASCADE.
    await env.DB.prepare('DELETE FROM profiles WHERE id = ?').bind(second).run()

    expect(await repository.openFor(second)).toBeNull()
    expect(await rawRow(closed.id)).toBeNull()
    expect(await rawRow(open.id)).toBeNull()
    expect(await repository.openFor(account.profileId)).not.toBeNull()
  })

  it('refuses a hold for a profile that does not exist', async () => {
    const repository = new D1EscalationHoldsRepository(db)

    await expect(repository.open(holdFor(crypto.randomUUID()))).rejects.toThrow()
  })
})
