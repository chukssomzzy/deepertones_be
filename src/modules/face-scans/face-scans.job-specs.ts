import { z } from 'zod'
import { jobSpec } from '../../jobs/job'

/**
 * One job for every step of a face scan's analysis, alone on its queue: `upload` sends the photo and starts the Perfect Corp tasks, `fetch` copies
 * the analysis when it is done, `fitzpatrick` stores the skin type read from the first scan.
 */
export const analyseFaceScanSpec = jobSpec({
  name: 'analyse-face-scan',
  queue: 'face-scans',
  schema: z.object({
    faceScanId: z.string(),
    step: z.enum(['upload', 'fetch', 'fitzpatrick']),
    /** When (ms) the step was queued for. A redelivery carries the same time and so shares a key, and a step sent again is stamped afresh and claimed on its own. */
    at: z.number().int().nonnegative(),
    /** Perfect Corp's id for the webhook delivery that woke the step. */
    webhookId: z.string().optional(),
  }),
  // A webhook delivered twice carries the same id and so shares a key whatever time it arrived at: the dispatcher's claim acks the repeat.
  key: (body) => (body.webhookId ? `${body.faceScanId}:${body.step}:wh:${body.webhookId}` : `${body.faceScanId}:${body.step}:${body.at}`),
  // 5 attempts finish in minutes, well inside the time a person waits on a scan.
  retry: { baseSeconds: 5, factor: 3, capSeconds: 135 },
})

export type AnalyseFaceScanMessage = z.infer<typeof analyseFaceScanSpec.schema>
