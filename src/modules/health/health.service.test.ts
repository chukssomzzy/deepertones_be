import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeHealthRepository } from './health.repository.fake'
import { healthRepositoryContract } from './health.repository.contract'
import { HealthService } from './health.service'

healthRepositoryContract('fake', () => new FakeHealthRepository())

describe('HealthService.check', () => {
  let repository: FakeHealthRepository
  let service: HealthService

  beforeEach(() => {
    repository = new FakeHealthRepository()
    service = new HealthService(repository, 'test')
  })

  it('reports ok when the database answers', async () => {
    expect(await service.check()).toEqual({
      status: 'ok',
      environment: 'test',
      checks: { database: 'ok' },
    })
  })

  it('reports degraded, not an error, when the database is down', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    repository.up = false

    expect(await service.check()).toMatchObject({
      status: 'degraded',
      checks: { database: 'down' },
    })
  })
})
