import type { Container } from '../../container'
import { defineJob } from '../../jobs/job'
import { buildRoutineSpec } from './routines.job-specs'

export const buildRoutine = defineJob<typeof buildRoutineSpec.schema, Container>(buildRoutineSpec, {
  handle: (body, services) => services.routines.run(body),
  onDeadLetter: (body, services) => services.routines.markBuildFailed(body),
})
