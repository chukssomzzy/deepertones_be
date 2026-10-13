import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { jobSpec } from '../../jobs/job'
import { CloudflareQueuesJobQueue } from './cloudflare-queues.job-queue'
import { MemoryJobQueue } from './memory.job-queue'

const job = jobSpec({
  name: 'test-job',
  queue: 'test-job',
  schema: z.object({ id: z.string() }),
  key: (body) => body.id,
  retry: { baseSeconds: 5, factor: 3, capSeconds: 135 },
})

const fakeQueue = () => {
  const sent: unknown[] = []
  const queue = { send: async (body: unknown) => void sent.push(body) } as unknown as Queue
  return { queue, sent }
}

describe('MemoryJobQueue', () => {
  it('records the job name and body of each enqueue', async () => {
    const memory = new MemoryJobQueue()

    await memory.enqueue(job, { id: 'a' })

    expect(memory.enqueued).toEqual([{ job: 'test-job', body: { id: 'a' } }])
  })
})

describe('CloudflareQueuesJobQueue', () => {
  it('sends the validated body to the binding for the job queue', async () => {
    const { queue, sent } = fakeQueue()

    await new CloudflareQueuesJobQueue({ 'test-job': queue }).enqueue(job, { id: 'a' })

    expect(sent).toEqual([{ id: 'a' }])
  })

  it('sends the parsed body, without fields the schema does not know', async () => {
    const { queue, sent } = fakeQueue()

    await new CloudflareQueuesJobQueue({ 'test-job': queue }).enqueue(job, { id: 'a', extra: 1 } as never)

    expect(sent).toEqual([{ id: 'a' }])
  })

  it('rejects a body that fails the schema and sends nothing', async () => {
    const { queue, sent } = fakeQueue()

    await expect(new CloudflareQueuesJobQueue({ 'test-job': queue }).enqueue(job, { id: 5 } as never)).rejects.toThrow()
    expect(sent).toEqual([])
  })

  it('throws an error naming the queue when its binding is missing', async () => {
    const adapter = new CloudflareQueuesJobQueue({})

    await expect(adapter.enqueue(job, { id: 'a' })).rejects.toThrow(/test-job/)
  })
})
