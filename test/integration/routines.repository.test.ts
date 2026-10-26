import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createDb } from '../../src/lib/db'
import type { EmailAddress } from '../../src/lib/email-address'
import { D1RoutinesRepository } from '../../src/modules/routines/routines.repository'
import { routinesRepositoryContract } from '../../src/modules/routines/routines.repository.contract'
import { D1UsersRepository } from '../../src/modules/users/users.repository'

const BASE = new Date('2030-06-15T12:00:00.000Z')
const HOUR = 60 * 60 * 1000

const db = createDb(env.DB)
const users = new D1UsersRepository(db)

type Appended = Parameters<D1RoutinesRepository['append']>[0]

// routine_versions references profiles, and D1 enforces it, so each contract account is a real guest (made the way the app makes one, which writes the
// default profile in the same batch).
const newGuest = async () => {
  const userId = crypto.randomUUID()
  const profileId = crypto.randomUUID()
  await users.createGuestForDevice({ user: { id: userId, createdAt: BASE }, device: { deviceHash: `routines-contract-${userId}`, platform: 'ios' }, profile: { id: profileId } })
  return { userId, profileId }
}

const rowFor = (profileId: string, createdAt: Date, over: Partial<Appended> = {}): Appended => ({
  id: crypto.randomUUID(),
  profileId,
  status: 'ready',
  createdAt,
  steps: [{ step: 'cleanse', product: { kind: 'none' }, frequency: 'am-pm', reason: 'Use what you have for now.', grounding: [], gotIt: false, fixedFrom: null }],
  tapers: [],
  expectation: 'Give it 8 to 12 weeks before judging.',
  startedOn: null,
  servedAt: null,
  model: 'claude-sonnet-5-5',
  promptHash: 'prompt-hash-1',
  catalogVersion: 7,
  rulesVersion: '1',
  hintsShown: false,
  verdictFingerprint: 'verdict-fp-1',
  routineFingerprint: 'routine-fp-1',
  source: 'writer',
  reason: 'first',
  writerRetryDueAt: null,
  writerCalls: 1,
  ...over,
})

routinesRepositoryContract('D1', () => ({ repository: new D1RoutinesRepository(db), newAccount: newGuest }))

describe('routine_versions in D1', () => {
  it('removes a user\'s routine versions with the user (a guest purged by the cleanup), and leaves other accounts\' versions', async () => {
    const repository = new D1RoutinesRepository(db)
    const guest = await newGuest()
    const kept = await newGuest()
    await repository.append(rowFor(guest.profileId, BASE))
    await repository.append(rowFor(guest.profileId, new Date(BASE.getTime() + HOUR), { status: 'pending', steps: [], expectation: null, model: null, promptHash: null, catalogVersion: null, routineFingerprint: null, source: null, writerCalls: 0 }))
    await repository.append(rowFor(kept.profileId, BASE))

    expect(await users.deleteUsers([guest.userId])).toBe(1)

    expect(await repository.latest(guest.profileId)).toBeNull()
    expect(await repository.current(guest.profileId)).toBeNull()
    expect(await repository.writerBuildsSince(guest.profileId, new Date(BASE.getTime() - HOUR))).toBe(0)
    expect(await repository.latest(kept.profileId)).not.toBeNull()
  })

  it('keeps the routine versions when the guest signs up, because the account and its profile are promoted in place', async () => {
    const repository = new D1RoutinesRepository(db)
    const guest = await newGuest()
    const row = rowFor(guest.profileId, BASE)
    await repository.append(row)

    const { outcome } = await users.promote(guest.userId, { kind: 'email', email: `routine-${crypto.randomUUID()}@example.com` as EmailAddress }, new Date(BASE.getTime() + HOUR))

    expect(outcome).toBe('promoted')
    expect(await repository.current(guest.profileId)).toEqual(row)
  })

  it('refuses a version for a profile that does not exist', async () => {
    const repository = new D1RoutinesRepository(db)

    await expect(repository.append(rowFor(crypto.randomUUID(), BASE))).rejects.toThrow()
  })

  it('stores every time it holds to the millisecond', async () => {
    const repository = new D1RoutinesRepository(db)
    const guest = await newGuest()
    const createdAt = new Date(BASE.getTime() + 123)
    const startedOn = new Date(BASE.getTime() - HOUR + 456)
    const retryDue = new Date(BASE.getTime() + 24 * HOUR + 789)
    const served = new Date(BASE.getTime() + 2 * HOUR + 321)
    const row = rowFor(guest.profileId, createdAt, { startedOn, writerRetryDueAt: retryDue, source: 'rules', model: null, promptHash: null, writerCalls: 0 })
    await repository.append(row)
    await repository.markServed(row.id, served)

    const stored = await repository.latest(guest.profileId)

    expect(stored!.createdAt.getTime()).toBe(createdAt.getTime())
    expect(stored!.startedOn!.getTime()).toBe(startedOn.getTime())
    expect(stored!.writerRetryDueAt!.getTime()).toBe(retryDue.getTime())
    expect(stored!.servedAt!.getTime()).toBe(served.getTime())
  })

  it('counts a cut-off to the millisecond', async () => {
    const repository = new D1RoutinesRepository(db)
    const guest = await newGuest()
    const createdAt = new Date(BASE.getTime() + 123)
    await repository.append(rowFor(guest.profileId, createdAt))

    expect(await repository.writerBuildsSince(guest.profileId, createdAt)).toBe(1)
    expect(await repository.writerBuildsSince(guest.profileId, new Date(createdAt.getTime() + 1))).toBe(0)
  })
})
