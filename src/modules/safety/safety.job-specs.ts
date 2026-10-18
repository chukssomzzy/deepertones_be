import { z } from 'zod'
import { jobSpec } from '../../jobs/job'

/**
 * The parse of one answer's reaction and prescription words. The message carries the id of the safety row (and, on the second try, that flag) and nothing else: the words are
 * personal and are read from the row when the job runs. The key is the row, so a message sent twice, or sent again by the repair on a read,
 * is one run.
 *
 * A parse that ran out of retries is given one more try the next day, queued by the daily sweep with `retry: true`. Its key is its own: the
 * dispatcher records a dead-lettered run as failed for good, and a message with the first key would be acked as that finished run.
 */
export const parseSafetySpec = jobSpec({
  name: 'parse-safety',
  queue: 'parse-safety',
  schema: z.object({ safetyId: z.string(), retry: z.boolean().optional() }),
  key: (body) => (body.retry ? `parse-safety:${body.safetyId}:retry` : `parse-safety:${body.safetyId}`),
  // Nobody waits for a parse, and a spent AI budget needs spacing between tries: retry as patiently as the receipt check.
  retry: { baseSeconds: 30, factor: 3, capSeconds: 600 },
})

export type ParseSafetyMessage = z.infer<typeof parseSafetySpec.schema>
