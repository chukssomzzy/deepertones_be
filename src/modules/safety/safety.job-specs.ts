import { z } from 'zod'
import { jobSpec } from '../../jobs/job'

/**
 * The parse of one answer's reaction and prescription words. The message carries the id of the safety row and nothing else: the words are
 * personal and are read from the row when the job runs. The key is the row, so a message sent twice, or sent again by the repair on a read,
 * is one run.
 */
export const parseSafetySpec = jobSpec({
  name: 'parse-safety',
  queue: 'parse-safety',
  schema: z.object({ safetyId: z.string() }),
  key: (body) => `parse-safety:${body.safetyId}`,
  // Nobody waits for a parse, and a spent AI budget needs spacing between tries: retry as patiently as the receipt check.
  retry: { baseSeconds: 30, factor: 3, capSeconds: 600 },
})

export type ParseSafetyMessage = z.infer<typeof parseSafetySpec.schema>
