import type { z } from 'zod'
import type { JobSpec } from '../../jobs/job'

export type EnqueueOptions = {
  /** Hold the message this long before the consumer sees it. A wait that must not use up the message's retries is sent again with a delay. */
  delaySeconds?: number
}

/** Hands a message to a job's queue. Typed by the job's schema, so a wrong shape fails to compile. */
export interface JobQueue {
  enqueue<S extends z.ZodType>(job: JobSpec<S>, body: z.input<S>, options?: EnqueueOptions): Promise<void>
  /** Hands many messages of one job to its queue, in as few calls as the queue allows. Sends nothing, and makes no call, for an empty list. */
  enqueueBatch<S extends z.ZodType>(job: JobSpec<S>, bodies: z.input<S>[]): Promise<void>
}
