import { z } from 'zod'
import { jobSpec } from '../../jobs/job'

/** One job for every step of an item: the dispatcher routes one job per queue, so the steps share this queue pair. */
export const advanceScanItemSpec = jobSpec({
  name: 'advance-scan-item',
  queue: 'scan-items',
  schema: z.object({
    itemId: z.string(),
    step: z.enum(['recognise', 'match', 'research', 'read-label', 'analyse']),
    /**
     * When (ms) the item entered the state this step works on: the `updatedAt` of the move that queued it, or `createdAt`
     * for `recognise`. A queue redelivery and the reaper's re-send of a lost message carry the same time, so they share a
     * key and a run that already finished is acked, not repeated; a step sent again after an undo or a wait is stamped
     * with the time it was sent and is claimed on its own.
     */
    at: z.number().int().nonnegative(),
  }),
  key: (body) => `${body.itemId}:${body.step}:${body.at}`,
  // 5 attempts finish in minutes, well inside the time a person waits on a scan.
  retry: { baseSeconds: 5, factor: 3, capSeconds: 135 },
})

export type AdvanceScanItemMessage = z.infer<typeof advanceScanItemSpec.schema>
export type ScanStep = AdvanceScanItemMessage['step']
