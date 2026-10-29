import type { z } from 'zod'
import type { JobSpec } from '../../jobs/job'
import type { EnqueueOptions, JobQueue } from './job-queue.provider'

/** Sends to the Queue binding for the job's queue. `queues` maps a job's `queue` name to its binding. */
export class CloudflareQueuesJobQueue implements JobQueue {
  /** The most messages Cloudflare takes in one `sendBatch`. */
  private static readonly BATCH_LIMIT = 100
  /** How many more times a `sendBatch` that failed is tried. */
  private static readonly EXTRA_TRIES = 2

  constructor(private readonly queues: Record<string, Queue>) {}

  async enqueue<S extends z.ZodType>(job: JobSpec<S>, body: z.input<S>, options: EnqueueOptions = {}): Promise<void> {
    const queue = this.queues[job.queue]
    if (!queue) throw new Error(`No Queue binding for job queue "${job.queue}"`)
    // Parsed, not passed through: unknown fields never reach the queue.
    const parsed = job.schema.parse(body)
    // A shared queue carries several jobs, so the message says which one it is for.
    const message = job.shared ? { job: job.name, body: parsed } : parsed
    if (options.delaySeconds === undefined) await queue.send(message)
    else await queue.send(message, { delaySeconds: options.delaySeconds })
  }

  async enqueueBatch<S extends z.ZodType>(job: JobSpec<S>, bodies: z.input<S>[]): Promise<void> {
    const queue = this.queues[job.queue]
    if (!queue) throw new Error(`No Queue binding for job queue "${job.queue}"`)
    // Every body is parsed before the first batch goes, so a bad one sends nothing.
    const messages = bodies.map((body) => {
      const parsed = job.schema.parse(body)
      return { body: job.shared ? { job: job.name, body: parsed } : parsed }
    })
    // A chunk that fails is tried again (a chunk already sent stays sent, and a repeat of a message is harmless to the jobs that use this), and one that still fails does not stop
    // the chunks after it: the first error is thrown when all have been tried, so the caller knows some messages were not queued.
    let failure: { error: unknown } | undefined
    for (let from = 0; from < messages.length; from += CloudflareQueuesJobQueue.BATCH_LIMIT) {
      const chunk = messages.slice(from, from + CloudflareQueuesJobQueue.BATCH_LIMIT)
      for (let attempt = 0; ; attempt++) {
        try {
          await queue.sendBatch(chunk)
          break
        } catch (error) {
          if (attempt < CloudflareQueuesJobQueue.EXTRA_TRIES) continue
          failure ??= { error }
          break
        }
      }
    }
    if (failure) throw failure.error
  }
}
