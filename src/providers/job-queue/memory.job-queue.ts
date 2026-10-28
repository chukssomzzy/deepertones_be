import type { z } from 'zod'
import type { JobSpec } from '../../jobs/job'
import type { EnqueueOptions, JobQueue } from './job-queue.provider'

/** Records what would have been enqueued (and the delay, when one was asked for). For tests. */
export class MemoryJobQueue implements JobQueue {
  readonly enqueued: { job: string; body: unknown; delaySeconds?: number }[] = []
  private failure: Error | undefined

  /** The next enqueue() rejects with `error` and records nothing. */
  failNextWith(error: Error) {
    this.failure = error
  }

  async enqueue<S extends z.ZodType>(job: JobSpec<S>, body: z.input<S>, options: EnqueueOptions = {}): Promise<void> {
    if (this.failure) {
      const failure = this.failure
      this.failure = undefined
      throw failure
    }
    this.enqueued.push({ job: job.name, body, ...(options.delaySeconds === undefined ? {} : { delaySeconds: options.delaySeconds }) })
  }

  async enqueueBatch<S extends z.ZodType>(job: JobSpec<S>, bodies: z.input<S>[]): Promise<void> {
    if (bodies.length === 0) return
    if (this.failure) {
      const failure = this.failure
      this.failure = undefined
      throw failure
    }
    for (const body of bodies) this.enqueued.push({ job: job.name, body })
  }
}
