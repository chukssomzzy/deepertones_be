import type { Container } from '../../container'
import { defineJob } from '../../jobs/job'
import { deliverOtpSpec } from './otp.job-specs'

export const deliverOtp = defineJob<typeof deliverOtpSpec.schema, Container>(deliverOtpSpec, {
  handle: (body, services) => services.otp.deliver(body),
  onDeadLetter: (body, services) => services.otp.markUndeliverable(body.challengeId),
})
