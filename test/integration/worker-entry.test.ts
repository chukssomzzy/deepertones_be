import { env, exports } from 'cloudflare:workers'
import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test'
import { describe, expect, it, vi } from 'vitest'
import worker, { app } from '../../src/index'

describe('the Worker entry', () => {
  it('still serves HTTP through the default export', async () => {
    const res = await exports.default.fetch(new Request('http://deepertones.test/health'))

    expect(res.status).toBe(200)
  })

  it('exports the Hono app by name', () => {
    expect(typeof app.request).toBe('function')
  })

  it('has a scheduled handler for the cleanup cron', () => {
    expect(typeof worker.scheduled).toBe('function')
  })

  it('has a queue handler that is wired to the dispatcher', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(typeof worker.queue).toBe('function')
    const batch = createMessageBatch('deepertones-no-such-queue-development', [
      { id: 'm1', timestamp: new Date(), attempts: 1, body: {} },
    ])
    const ctx = createExecutionContext()

    await worker.queue!(batch, env, ctx)
    const result = await getQueueResult(batch, ctx)

    expect(result.retryBatch.retry).toBe(true)
    vi.restoreAllMocks()
  })
})
