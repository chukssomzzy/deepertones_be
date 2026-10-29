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

const sharedJob = jobSpec({
  name: 'shared-job',
  queue: 'shared',
  shared: true,
  schema: z.object({ id: z.string() }),
  key: (body) => body.id,
  retry: { baseSeconds: 5, factor: 3, capSeconds: 135 },
})

const fakeQueue = () => {
  const sent: unknown[] = []
  const options: unknown[] = []
  const batches: unknown[][] = []
  /** Which `sendBatch` calls (by position among the calls made, from 0) reject. */
  const failing = new Set<number>()
  let calls = 0
  const queue = {
    send: async (body: unknown, sendOptions?: unknown) => {
      sent.push(body)
      options.push(sendOptions)
    },
    sendBatch: async (messages: { body: unknown }[]) => {
      if (failing.has(calls++)) throw new Error('queue is down')
      batches.push(messages.map((message) => message.body))
    },
  } as unknown as Queue
  return { queue, sent, options, batches, failing, calls: () => calls }
}

describe('MemoryJobQueue', () => {
  it('records each body of a batch as its own enqueue, and nothing for an empty batch', async () => {
    const memory = new MemoryJobQueue()

    await memory.enqueueBatch(job, [{ id: 'a' }, { id: 'b' }])
    await memory.enqueueBatch(job, [])

    expect(memory.enqueued).toEqual([
      { job: 'test-job', body: { id: 'a' } },
      { job: 'test-job', body: { id: 'b' } },
    ])
  })

  it('records the job name and body of each enqueue', async () => {
    const memory = new MemoryJobQueue()

    await memory.enqueue(job, { id: 'a' })

    expect(memory.enqueued).toEqual([{ job: 'test-job', body: { id: 'a' } }])
  })

  it('records the delay of an enqueue that asked for one, and no delay field for one that did not', async () => {
    const memory = new MemoryJobQueue()

    await memory.enqueue(job, { id: 'a' }, { delaySeconds: 30 })
    await memory.enqueue(job, { id: 'b' })

    expect(memory.enqueued).toEqual([
      { job: 'test-job', body: { id: 'a' }, delaySeconds: 30 },
      { job: 'test-job', body: { id: 'b' } },
    ])
  })

  it('fails the next enqueue with the error it was given, records nothing for it, and then works again', async () => {
    const memory = new MemoryJobQueue()
    const outage = new Error('queue is down')
    memory.failNextWith(outage)

    await expect(memory.enqueue(job, { id: 'a' })).rejects.toBe(outage)
    await memory.enqueue(job, { id: 'b' })

    expect(memory.enqueued).toEqual([{ job: 'test-job', body: { id: 'b' } }])
  })
})

describe('CloudflareQueuesJobQueue', () => {
  it('sends the validated body to the binding for the job queue', async () => {
    const { queue, sent } = fakeQueue()

    await new CloudflareQueuesJobQueue({ 'test-job': queue }).enqueue(job, { id: 'a' })

    expect(sent).toEqual([{ id: 'a' }])
  })

  it('sends the delay with the body when one is asked for, and no options when it is not', async () => {
    const { queue, options } = fakeQueue()
    const adapter = new CloudflareQueuesJobQueue({ 'test-job': queue })

    await adapter.enqueue(job, { id: 'a' }, { delaySeconds: 30 })
    await adapter.enqueue(job, { id: 'b' })

    expect(options).toEqual([{ delaySeconds: 30 }, undefined])
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

  // A shared queue carries several jobs, so the message names its own: { job, body }. A queue of one job keeps the bare body.
  it('wraps the validated body with the job name when the job\'s queue is shared', async () => {
    const { queue, sent } = fakeQueue()

    await new CloudflareQueuesJobQueue({ shared: queue }).enqueue(sharedJob, { id: 'a', extra: 1 } as never)

    expect(sent).toEqual([{ job: 'shared-job', body: { id: 'a' } }])
  })

  it('sends the delay beside the wrapped body on a shared queue', async () => {
    const { queue, options } = fakeQueue()

    await new CloudflareQueuesJobQueue({ shared: queue }).enqueue(sharedJob, { id: 'a' }, { delaySeconds: 30 })

    expect(options).toEqual([{ delaySeconds: 30 }])
  })

  it('rejects a body that fails the schema on a shared queue and sends nothing', async () => {
    const { queue, sent } = fakeQueue()

    await expect(new CloudflareQueuesJobQueue({ shared: queue }).enqueue(sharedJob, { id: 5 } as never)).rejects.toThrow()
    expect(sent).toEqual([])
  })

  describe('enqueueBatch', () => {
    const bodies = (count: number) => Array.from({ length: count }, (_, at) => ({ id: String(at) }))

    it('sends the validated bodies in batches of at most 100, in order', async () => {
      const { queue, batches } = fakeQueue()

      await new CloudflareQueuesJobQueue({ 'test-job': queue }).enqueueBatch(job, [...bodies(101), { id: 'x', extra: 1 } as never])

      expect(batches.map((batch) => batch.length)).toEqual([100, 2])
      expect(batches.flat().at(-1)).toEqual({ id: 'x' })
    })

    it('tries a chunk that fails again, up to 2 more times, and queues it when a retry works', async () => {
      const { queue, batches, failing, calls } = fakeQueue()
      failing.add(0).add(1)

      await new CloudflareQueuesJobQueue({ 'test-job': queue }).enqueueBatch(job, bodies(3))

      expect(calls()).toBe(3)
      expect(batches).toEqual([bodies(3)])
    })

    it('goes on to the chunks after one that fails every time, and throws the first error when all are done', async () => {
      const { queue, batches, failing, calls } = fakeQueue()
      // 250 bodies are chunks of 100, 100 and 50. Call 0 is the first chunk; calls 1 to 3 are the second chunk's three tries; call 4 is the third chunk.
      failing.add(1).add(2).add(3)

      await expect(new CloudflareQueuesJobQueue({ 'test-job': queue }).enqueueBatch(job, bodies(250))).rejects.toThrow('queue is down')

      expect(calls()).toBe(5)
      expect(batches.map((batch) => batch.length)).toEqual([100, 50])
      expect(batches[0]![0]).toEqual({ id: '0' })
      expect(batches[1]![0]).toEqual({ id: '200' })
    })

    it('makes no call for an empty list', async () => {
      const { queue, batches } = fakeQueue()

      await new CloudflareQueuesJobQueue({ 'test-job': queue }).enqueueBatch(job, [])

      expect(batches).toEqual([])
    })

    it('wraps each body with the job name on a shared queue', async () => {
      const { queue, batches } = fakeQueue()

      await new CloudflareQueuesJobQueue({ shared: queue }).enqueueBatch(sharedJob, [{ id: 'a' }])

      expect(batches).toEqual([[{ job: 'shared-job', body: { id: 'a' } }]])
    })

    it('sends nothing when one body fails the schema', async () => {
      const { queue, batches } = fakeQueue()

      await expect(new CloudflareQueuesJobQueue({ 'test-job': queue }).enqueueBatch(job, [{ id: 'a' }, { id: 5 } as never])).rejects.toThrow()
      expect(batches).toEqual([])
    })

    it('throws an error naming the queue when its binding is missing', async () => {
      await expect(new CloudflareQueuesJobQueue({}).enqueueBatch(job, [{ id: 'a' }])).rejects.toThrow(/test-job/)
    })
  })
})
