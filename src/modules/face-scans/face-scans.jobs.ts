import type { Container } from '../../container'
import { defineJob, PermanentJobError } from '../../jobs/job'
import { analyseFaceScanSpec } from './face-scans.job-specs'

// A placeholder until the analysis pipeline lands: it fails every scan cleanly instead of leaving it analysing for ever. A PermanentJobError
// is acked and never reaches the dead-letter queue, so the handler itself fails the scan before it throws.
export const analyseFaceScan = defineJob<typeof analyseFaceScanSpec.schema, Container>(analyseFaceScanSpec, {
  handle: async (body, services) => {
    await services.faceScans.markFailed(body.faceScanId)
    throw new PermanentJobError('face analysis not built yet')
  },
  onDeadLetter: (body, services) => services.faceScans.markFailed(body.faceScanId),
})
