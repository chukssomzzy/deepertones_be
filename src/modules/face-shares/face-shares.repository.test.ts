import { FakeFaceSharesRepository } from './face-shares.repository.fake'
import { faceSharesRepositoryContract } from './face-shares.repository.contract'

// A user or profile id only has to be unique here; the D1 twin (test/integration/face-shares.repository.test.ts) makes real accounts.
faceSharesRepositoryContract('fake', () => ({
  repository: new FakeFaceSharesRepository(),
  newAccount: async () => ({ userId: crypto.randomUUID(), profileId: crypto.randomUUID() }),
  newProfile: async () => crypto.randomUUID(),
}))
