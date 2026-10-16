import { FakeScansRepository } from './scans.repository.fake'
import { scansRepositoryContract } from './scans.repository.contract'

// A user id only has to be unique here; the D1 twin (test/integration/scans.repository.test.ts) makes real users.
scansRepositoryContract('fake', () => ({ repository: new FakeScansRepository(), newUser: async () => crypto.randomUUID() }))
