import type { Container } from '../../container'
import { defineJob } from '../../jobs/job'
import { parseSafetySpec } from './safety.job-specs'

export const parseSafety = defineJob<typeof parseSafetySpec.schema, Container>(parseSafetySpec, {
  handle: (body, services) => services.safety.parse(body.safetyId),
  onDeadLetter: (body, services) => services.safety.markParseFailed(body.safetyId),
})
