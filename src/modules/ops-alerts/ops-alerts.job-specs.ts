import { z } from 'zod'
import { jobSpec } from '../../jobs/job'
import { OPS_ALERT_KINDS } from './ops-alerts.types'

/** The first job on the shared `email` queue, which every later email kind joins. The message carries no data: the text is fixed per kind. */
export const sendOpsAlertSpec = jobSpec({
  name: 'send-ops-alert',
  queue: 'email',
  shared: true,
  schema: z.object({
    kind: z.enum(OPS_ALERT_KINDS),
    /** Start (ms) of the hour or UTC day the alert was raised for. */
    windowStart: z.number().int().nonnegative(),
  }),
  key: (body) => `${body.kind}:${body.windowStart}`,
  // An email that fails to send is retried for a while; the next window's raise sends a fresh one anyway.
  retry: { baseSeconds: 5, factor: 3, capSeconds: 135 },
})

export type SendOpsAlertMessage = z.infer<typeof sendOpsAlertSpec.schema>
