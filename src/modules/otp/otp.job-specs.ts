import { z } from 'zod'
import { jobSpec } from '../../jobs/job'

/** What the delivery job carries: no phone (less personal data in the queue; the DB row is authoritative) and the code only sealed (see OtpService). */
export const deliverOtpSpec = jobSpec({
  name: 'deliver-otp',
  queue: 'otp-delivery',
  schema: z.object({ challengeId: z.string(), sealedCode: z.string() }),
  key: (body) => body.challengeId,
  // 5 attempts finish well inside the 10 minute code lifetime.
  retry: { baseSeconds: 5, factor: 3, capSeconds: 135 },
})

export type DeliverOtpMessage = z.infer<typeof deliverOtpSpec.schema>
