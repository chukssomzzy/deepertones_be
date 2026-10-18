import { FakeProfilesRepository } from '../profiles/profiles.repository.fake'
import { FakeShelfStore } from '../shelf/shelf.store.fake'
import { FakeScansRepository } from './scans.repository.fake'
import { scansRepositoryContract } from './scans.repository.contract'

const BASE = new Date('2030-06-15T12:00:00.000Z')

// A user id only has to be unique here; the D1 twin (test/integration/scans.repository.test.ts) makes real users.
// The fake scans repository reads default profiles from the fake profiles repository it is given, as D1 reads the profiles table.
scansRepositoryContract('fake', () => {
  const profiles = new FakeProfilesRepository()
  const shelf = new FakeShelfStore()
  return {
    repository: new FakeScansRepository({ profiles, shelf }),
    newUser: async () => crypto.randomUUID(),
    newUserWithoutProfile: async () => crypto.randomUUID(),
    giveDefaultProfile: async (userId) => {
      const id = crypto.randomUUID()
      await profiles.insert({ id, userId, displayName: null, isDefault: true, createdAt: BASE })
      return id
    },
    shelfOf: async (profileId) => shelf.rows.filter((row) => row.profileId === profileId),
    // Stands in for the shelf module's remove, which comes later: it marks the row as that remove will.
    removeFromShelf: async (entryId, reason, at) => {
      const row = shelf.rows.find((r) => r.id === entryId)!
      row.removedAt = at
      row.removedReason = reason
    },
  }
})
