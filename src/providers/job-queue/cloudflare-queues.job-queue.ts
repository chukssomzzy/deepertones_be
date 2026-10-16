import type { z } from 'zod'
import type { JobSpec } from '../../jobs/job'
import type { JobQueue } from './job-queue.provider'

/** Sends to the Queue binding for the job's queue. `queues` maps a job's `queue` name to its binding. */
export class CloudflareQueuesJobQueue implements JobQueue {
  readonly #queues: Record<string, Queue>

  constructor(queues: Record<string, Queue>) {
    this.#queues = queues
  }

  async enqueue<S extends z.ZodType>(job: JobSpec<S>, body: z.input<S>): Promise<void> {
    const queue = this.#queues[job.queue]
    if (!queue) throw new Error(`No Queue binding for job queue "${job.queue}"`)
    // Parsed, not passed through: unknown fields never reach the queue.
    await queue.send(job.schema.parse(body))
  }
}
