import { z } from 'zod'
import { jobSpec } from '../../jobs/job'

/**
 * The build of one profile's routine. The message carries the profile's id, why it is built, what the request was claimed for, when it was requested, how many
 * times it has waited for the verdict to be ready, and (on the second try) a flag; the shelf, goal and safety words are personal and are read from the database
 * when the job runs. The key is the request and its wait, so a message delivered twice is one run, and each wait is a run of its own.
 *
 * A build that failed for good the first day is given one more try the next day, queued by the daily sweep with `retry: true`. Its key is its own: the
 * dispatcher records a dead-lettered run as failed for good, and a message with the first key would be acked as that finished run.
 */
export const buildRoutineSpec = jobSpec({
  name: 'build-routine',
  queue: 'routines',
  schema: z.object({
    profileId: z.string(),
    reason: z.enum(['first', 'shelf', 'goal', 'safety', 'verdict', 'review-point', 'catalog-retired', 'sold-here', 'got-it', 'writer-retry']),
    requestKey: z.string(),
    requestedAt: z.number().int().nonnegative(),
    waits: z.number().int().nonnegative(),
    retry: z.boolean().optional(),
  }),
  key: (body) => `build-routine:${body.profileId}:${body.requestKey}:${body.requestedAt}:${body.waits}${body.retry ? ':retry' : ''}`,
  // Nobody waits for the build in a request, and a spent AI budget needs spacing between tries: retry as patiently as the verdict build.
  retry: { baseSeconds: 30, factor: 3, capSeconds: 600 },
})

export type BuildRoutineMessage = z.infer<typeof buildRoutineSpec.schema>
