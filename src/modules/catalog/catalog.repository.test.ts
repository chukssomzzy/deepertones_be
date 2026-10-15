import { FakeCatalogRepository } from './catalog.repository.fake'
import { catalogRepositoryContract } from './catalog.repository.contract'

catalogRepositoryContract('fake', () => new FakeCatalogRepository())
