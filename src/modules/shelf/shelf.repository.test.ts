import { FakeShelfRepository } from './shelf.repository.fake'
import { shelfRepositoryContract } from './shelf.repository.contract'
import { FakeShelfStore } from './shelf.store.fake'

// The fake reads the store the scans fake writes, so rows put straight into the store are what a scan's move would have left there.
// A profile id only has to be unique here; the D1 twin (test/integration/shelf.repository.test.ts) makes real profiles.
shelfRepositoryContract('fake', () => {
  const store = new FakeShelfStore()
  return {
    repository: new FakeShelfRepository(store),
    newProfile: async () => crypto.randomUUID(),
    put: async (row) => {
      store.rows.push({ ...row })
    },
    stored: async (profileId) => store.rows.filter((row) => row.profileId === profileId),
  }
})
