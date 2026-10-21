import { FakeFaceScansRepository } from './face-scans.repository.fake'
import { faceScansRepositoryContract } from './face-scans.repository.contract'

// A user or profile id only has to be unique here; the D1 twin (test/integration/face-scans.repository.test.ts) makes real accounts.
faceScansRepositoryContract('fake', () => ({
  repository: new FakeFaceScansRepository(),
  newAccount: async () => ({ userId: crypto.randomUUID(), profileId: crypto.randomUUID() }),
  newProfile: async () => crypto.randomUUID(),
}))
