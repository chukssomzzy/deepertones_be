import { z } from 'zod'
import { jobSpec } from '../../jobs/job'

/**
 * The build of one profile's shelf verdict. The message carries the profile's id, the fingerprint the request was claimed with, when it was requested, how many
 * times it has waited for the shelf to settle, and (on the second try) a flag; the shelf, goal and safety words are personal and are read from the database when
 * the job runs. The key is the request and its wait, so a message delivered twice is one run, and each wait is a run of its own.
 *
 * A fit that failed for good the first day is given one more try the next day, queued by the daily sweep with `retry: true`. Its key is its own: the
 * dispatcher records a dead-lettered run as failed for good, and a message with the first key would be acked as that finished run.
 */
export const buildVerdictSpec = jobSpec({
  name: 'build-verdict',
  queue: 'verdicts',
  schema: z.object({
    profileId: z.string(),
    fingerprint: z.string(),
    requestedAt: z.number().int().nonnegative(),
    waits: z.number().int().nonnegative(),
    retry: z.boolean().optional(),
  }),
  key: (body) => `build-verdict:${body.profileId}:${body.requestedAt}:${body.waits}${body.retry ? ':retry' : ''}`,
  // Nobody waits for the build in a request, and a spent AI budget needs spacing between tries: retry as patiently as the safety parse.
  retry: { baseSeconds: 30, factor: 3, capSeconds: 600 },
})

export type BuildVerdictMessage = z.infer<typeof buildVerdictSpec.schema>
