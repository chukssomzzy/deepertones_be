import type { z } from 'zod'
import type { JobSpec } from '../../jobs/job'
import type { JobQueue } from './job-queue.provider'

/** Records what would have been enqueued. For tests. */
export class MemoryJobQueue implements JobQueue {
  readonly enqueued: { job: string; body: unknown }[] = []

  async enqueue<S extends z.ZodType>(job: JobSpec<S>, body: z.input<S>): Promise<void> {
    this.enqueued.push({ job: job.name, body })
  }
}
