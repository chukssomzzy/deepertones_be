import { env } from 'cloudflare:workers'
import { createDb } from '../../src/lib/db'
import { D1CatalogRepository } from '../../src/modules/catalog/catalog.repository'
import { catalogRepositoryContract } from '../../src/modules/catalog/catalog.repository.contract'

catalogRepositoryContract('D1', () => new D1CatalogRepository(createDb(env.DB)))
