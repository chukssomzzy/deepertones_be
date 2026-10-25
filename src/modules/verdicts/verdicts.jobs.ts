import type { Container } from '../../container'
import { defineJob } from '../../jobs/job'
import { buildVerdictSpec } from './verdicts.job-specs'

export const buildVerdict = defineJob<typeof buildVerdictSpec.schema, Container>(buildVerdictSpec, {
  handle: (body, services) => services.verdicts.build(body),
  onDeadLetter: (body, services) => services.verdicts.markFitFailed(body),
})
