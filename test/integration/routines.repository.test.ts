import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createDb } from '../../src/lib/db'
import { products } from '../../src/modules/catalog/catalog.table'
import { recommendedProducts } from '../../src/modules/catalog/catalog.workbook.table'
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
  steps: [{ step: 'cleanse', product: { kind: 'none' }, frequency: 'am-pm', reason: 'Use what you have for now.', grounding: [], gotIt: false, fixedFrom: null, changedOn: null }],
  tapers: [],
  expectation: 'Give it 8 to 12 weeks before judging.',
  cautions: [],
  goal: 'fade-dark-marks',
  shelfCounts: { keep: 1, reduce: 0, drop: 0, stop: 0 },
  notInRoutine: [],
  readyAt: createdAt,
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

// The retired-code sweep joins the catalog's recommended_products, which this repository does not write, so the contract is told which codes are retired by
// putting the rows in the catalog: a product and its retired recommendation, as an upload that retires a row leaves them (workbook.apply writes the same two tables).
// The test is the only writer of these rows; a code retired again moves to the new catalog version.
const retireCode = async (code: string, updatedInVersion: number) => {
  const productId = `product-${code}`
  await db.insert(products).values({ id: productId, identityKey: `test|${code}`, brandKey: 'test', brand: 'Test', name: code, category: 'skin', createdAt: BASE }).onConflictDoNothing()
  await db
    .insert(recommendedProducts)
    .values({
      code,
      productId,
      formulationId: null,
      brand: 'Test',
      name: code,
      variant: null,
      form: null,
      category: 'skin',
      ingredients: [],
      ingredientsSourceUrl: null,
      skinConcerns: [],
      skinTypes: ['all'],
      steps: ['treat'],
      frequency: 'pm',
      ownCautions: [],
      evidenceUrls: [],
      origin: 'sourced',
      status: 'retired',
      approvedBy: null,
      approvedOn: null,
      auditedBy: null,
      auditedOn: null,
      draftCells: [],
      updatedInVersion,
    })
    .onConflictDoUpdate({ target: recommendedProducts.code, set: { status: 'retired', updatedInVersion } })
}

routinesRepositoryContract('D1', () => ({ repository: new D1RoutinesRepository(db), newAccount: newGuest, retireCode }))

describe('routine_versions in D1', () => {
  it('removes a user\'s routine versions with the user (a guest purged by the cleanup), and leaves other accounts\' versions', async () => {
    const repository = new D1RoutinesRepository(db)
    const guest = await newGuest()
    const kept = await newGuest()
    await repository.append(rowFor(guest.profileId, BASE))
    await repository.append(rowFor(guest.profileId, new Date(BASE.getTime() + HOUR), { status: 'pending', steps: [], expectation: null, cautions: null, goal: null, readyAt: null, model: null, promptHash: null, catalogVersion: null, routineFingerprint: null, source: null, writerCalls: 0 }))
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

describe('routine_requests in D1', () => {
  const stale = new Date(BASE.getTime() - HOUR)

  it('removes a user\'s build request with the user (a guest purged by the cleanup), and leaves other accounts\' requests', async () => {
    const repository = new D1RoutinesRepository(db)
    const guest = await newGuest()
    const kept = await newGuest()
    await repository.claim(guest.profileId, 'routine-fp-1', BASE, stale)
    await repository.claim(kept.profileId, 'routine-fp-1', BASE, stale)

    expect(await users.deleteUsers([guest.userId])).toBe(1)

    expect(await repository.findRequest(guest.profileId)).toBeNull()
    expect(await repository.findRequest(kept.profileId)).not.toBeNull()
  })

  it('keeps the request when the guest signs up, because the account and its profile are promoted in place', async () => {
    const repository = new D1RoutinesRepository(db)
    const guest = await newGuest()
    await repository.claim(guest.profileId, 'routine-fp-1', BASE, stale)

    const { outcome } = await users.promote(guest.userId, { kind: 'email', email: `routine-request-${crypto.randomUUID()}@example.com` as EmailAddress }, new Date(BASE.getTime() + HOUR))

    expect(outcome).toBe('promoted')
    expect(await repository.findRequest(guest.profileId)).toMatchObject({ profileId: guest.profileId, requestKey: 'routine-fp-1' })
  })

  it('refuses a claim for a profile that does not exist', async () => {
    const repository = new D1RoutinesRepository(db)

    await expect(repository.claim(crypto.randomUUID(), 'routine-fp-1', BASE, stale)).rejects.toThrow()
  })

  it('lets exactly one of 20 parallel claims for one profile win', async () => {
    const repository = new D1RoutinesRepository(db)
    const guest = await newGuest()

    const answers = await Promise.all(Array.from({ length: 20 }, () => repository.claim(guest.profileId, 'routine-fp-1', BASE, stale)))

    expect(answers.filter(Boolean)).toHaveLength(1)
  })

  it('stores the claim time and the retry due time to the millisecond, and compares the cut-off to the millisecond', async () => {
    const repository = new D1RoutinesRepository(db)
    const guest = await newGuest()
    const requestedAt = new Date(BASE.getTime() + 123)
    const retryDueAt = new Date(BASE.getTime() + 24 * HOUR + 456)
    await repository.claim(guest.profileId, 'routine-fp-1', requestedAt, stale)
    await repository.setRequestRetry(guest.profileId, { retried: true, retryDueAt })

    const stored = await repository.findRequest(guest.profileId)

    expect(stored!.requestedAt.getTime()).toBe(requestedAt.getTime())
    expect(stored!.retryDueAt!.getTime()).toBe(retryDueAt.getTime())
    expect(await repository.claim(guest.profileId, 'routine-fp-1', new Date(requestedAt.getTime() + 1), new Date(requestedAt.getTime() - 1))).toBe(false)
    expect(await repository.claim(guest.profileId, 'routine-fp-1', new Date(requestedAt.getTime() + 1), requestedAt)).toBe(true)
  })
})

// The 15-minute reminder cron lists the profiles with a Started routine once and queues one message for each (spec #233, PR 8a).
describe('the started profiles in D1', () => {
  const STARTED = new Date(BASE.getTime() + 2 * HOUR)
  const pending = (profileId: string, createdAt: Date, over: Partial<Appended> = {}) =>
    rowFor(profileId, createdAt, { status: 'pending', steps: [], expectation: null, cautions: null, goal: null, readyAt: null, model: null, promptHash: null, catalogVersion: null, routineFingerprint: null, source: null, writerCalls: 0, ...over })

  it('lists a profile whose routine was Started, once however many versions carry the start, and no profile whose routine was not', async () => {
    const repository = new D1RoutinesRepository(db)
    const started = await newGuest()
    await repository.append(rowFor(started.profileId, BASE))
    await repository.markStarted(started.profileId, STARTED)
    // A rebuild carries the start forward, so the profile now has two Started versions.
    await repository.append(rowFor(started.profileId, new Date(BASE.getTime() + 3 * HOUR), { startedOn: STARTED }))
    const rebuilding = await newGuest()
    await repository.append(rowFor(rebuilding.profileId, BASE))
    await repository.markStarted(rebuilding.profileId, STARTED)
    // A rebuild asked for and not done yet: its row has no start, but the routine in force is Started.
    await repository.append(pending(rebuilding.profileId, new Date(BASE.getTime() + 3 * HOUR)))
    const ready = await newGuest()
    await repository.append(rowFor(ready.profileId, BASE))
    const building = await newGuest()
    await repository.append(pending(building.profileId, BASE))
    const none = await newGuest()

    const ids = await repository.startedProfileIds()

    expect(ids.filter((id) => id === started.profileId)).toHaveLength(1)
    expect(ids.filter((id) => id === rebuilding.profileId)).toHaveLength(1)
    for (const profile of [ready, building, none]) expect(ids).not.toContain(profile.profileId)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('answers the same list as the profiles that have a Started version', async () => {
    const repository = new D1RoutinesRepository(db)
    const guest = await newGuest()
    await repository.append(rowFor(guest.profileId, BASE))
    await repository.markStarted(guest.profileId, STARTED)

    const ids = await repository.startedProfileIds()

    const rows = await env.DB.prepare('SELECT DISTINCT profile_id AS id FROM routine_versions WHERE started_on IS NOT NULL').all<{ id: string }>()
    expect([...ids].sort()).toEqual(rows.results.map(({ id }) => id).sort())
  })

  it('has a partial index on the started routine rows, so the list is read from the few and not by scanning every version', async () => {
    const indexes = await env.DB.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'routine_versions' AND sql IS NOT NULL").all<{ name: string; sql: string }>()

    const partial = indexes.results.filter(({ sql }) => /where\s+["`]?(routine_versions["`]?\.["`]?)?started_on["`]?\s+is\s+not\s+null/i.test(sql))

    expect(partial.map(({ name }) => name)).toHaveLength(1)
    // It holds the profile id, which is what the list reads, so the table itself is not touched.
    expect(partial[0]!.sql).toMatch(/profile_id/)
  })
})
