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

  it('logs a failed check by the error\'s name, never its message, which may carry connection details', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    repository.ping = async () => {
      throw new TypeError('connect failed: password hunter2')
    }

    await service.check()

    expect(log).toHaveBeenCalledWith({ check: 'database', error: 'TypeError' })
    expect(JSON.stringify(log.mock.calls)).not.toContain('hunter2')
    log.mockRestore()
  })
})
