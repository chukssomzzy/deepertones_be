import type { z } from 'zod'
import type { JobSpec } from '../../jobs/job'

/** Hands a message to a job's queue. Typed by the job's schema, so a wrong shape fails to compile. */
export interface JobQueue {
  enqueue<S extends z.ZodType>(job: JobSpec<S>, body: z.input<S>): Promise<void>
}
