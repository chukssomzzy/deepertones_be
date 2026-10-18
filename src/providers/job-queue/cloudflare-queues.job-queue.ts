import type { z } from 'zod'
import type { JobSpec } from '../../jobs/job'
import type { EnqueueOptions, JobQueue } from './job-queue.provider'

/** Sends to the Queue binding for the job's queue. `queues` maps a job's `queue` name to its binding. */
export class CloudflareQueuesJobQueue implements JobQueue {
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
}
