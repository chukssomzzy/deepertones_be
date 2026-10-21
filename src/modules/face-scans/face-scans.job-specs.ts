import { z } from 'zod'
import { jobSpec } from '../../jobs/job'

/** One job for every step of a face scan's analysis, alone on its queue. Only the first step exists so far; the others arrive with the analysis. */
export const analyseFaceScanSpec = jobSpec({
  name: 'analyse-face-scan',
  queue: 'face-scans',
  schema: z.object({
    faceScanId: z.string(),
    step: z.enum(['upload']),
    /** When (ms) the step was queued for. A redelivery carries the same time and so shares a key, and a step sent again is stamped afresh and claimed on its own. */
    at: z.number().int().nonnegative(),
  }),
  key: (body) => `${body.faceScanId}:${body.step}:${body.at}`,
  // 5 attempts finish in minutes, well inside the time a person waits on a scan.
  retry: { baseSeconds: 5, factor: 3, capSeconds: 135 },
})

export type AnalyseFaceScanMessage = z.infer<typeof analyseFaceScanSpec.schema>
