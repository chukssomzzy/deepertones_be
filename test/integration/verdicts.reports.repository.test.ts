import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createDb } from '../../src/lib/db'
import { D1UsersRepository } from '../../src/modules/users/users.repository'
import { D1VerdictReportsRepository } from '../../src/modules/verdicts/verdicts.reports.repository'
import { verdictReportsRepositoryContract } from '../../src/modules/verdicts/verdicts.reports.repository.contract'

const BASE = new Date('2030-06-15T12:00:00.000Z')

const db = createDb(env.DB)
const users = new D1UsersRepository(db)

// verdict_reports references profiles, and D1 enforces it, so each contract account is a real guest (made the way the app makes one, which writes the
// default profile in the same batch).
const newGuest = async () => {
  const userId = crypto.randomUUID()
  const profileId = crypto.randomUUID()
  await users.createGuestForDevice({ user: { id: userId, createdAt: BASE }, device: { deviceHash: `reports-contract-${userId}`, platform: 'ios' }, profile: { id: profileId } })
  return { userId, profileId }
}

verdictReportsRepositoryContract('D1', () => ({ repository: new D1VerdictReportsRepository(db), newAccount: newGuest }))

describe('verdict_reports in D1', () => {
  const report = (profileId: string, over: Record<string, unknown> = {}) => ({
    id: crypto.randomUUID(),
    profileId,
    entryId: 'entry-1',
    group: 'helping' as const,
    verdict: { kind: 'keep' as const },
    basis: [{ kind: 'fit' as const, line: 'A fit check of the product against your goal.' }],
    fingerprint: 'fingerprint-1',
    note: 'a note',
    ...over,
  })

  it('refuses a report for a profile that does not exist', async () => {
    const repository = new D1VerdictReportsRepository(db)

    await expect(repository.upsertMistake(report(crypto.randomUUID()), BASE)).rejects.toThrow()
    await expect(repository.recordWrongMatch({ id: crypto.randomUUID(), profileId: crypto.randomUUID(), entryId: 'entry-1', oldProductId: 'a', newProductId: 'b' }, BASE)).rejects.toThrow()
  })

  it('removes a user\'s reports with the user (a guest purged by the cleanup), and leaves other accounts\' reports', async () => {
    const repository = new D1VerdictReportsRepository(db)
    const guest = await newGuest()
    const kept = await newGuest()
    const mistake = report(guest.profileId)
    const wrong = { id: crypto.randomUUID(), profileId: guest.profileId, entryId: 'entry-2', oldProductId: 'a', newProductId: 'b' }
    const other = report(kept.profileId)
    await repository.upsertMistake(mistake, BASE)
    await repository.recordWrongMatch(wrong, BASE)
    await repository.upsertMistake(other, BASE)

    expect(await users.deleteUsers([guest.userId])).toBe(1)

    expect(await repository.find(mistake.id)).toBeNull()
    expect(await repository.find(wrong.id)).toBeNull()
    expect(await repository.find(other.id)).not.toBeNull()
  })

  it('lets exactly one of 20 parallel reports of one entry and verdict be the new one', async () => {
    const repository = new D1VerdictReportsRepository(db)
    const guest = await newGuest()

    const answers = await Promise.all(Array.from({ length: 20 }, (_, i) => repository.upsertMistake(report(guest.profileId, { note: `note ${i}` }), BASE)))

    expect(answers.filter((answer) => answer.created)).toHaveLength(1)
    expect(new Set(answers.map((answer) => answer.id)).size).toBe(1)
  })

  it('stores the report for an entry that is no longer on the shelf: the entry id is a plain reference, not a foreign key', async () => {
    const repository = new D1VerdictReportsRepository(db)
    const guest = await newGuest()
    const mistake = report(guest.profileId, { entryId: `gone-${crypto.randomUUID()}` })

    await expect(repository.upsertMistake(mistake, BASE)).resolves.toEqual({ id: mistake.id, created: true })
  })
})
