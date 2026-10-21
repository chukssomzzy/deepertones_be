import type { Container } from '../../container'
import { defineJob } from '../../jobs/job'
import { analyseFaceScanSpec } from './face-scans.job-specs'

// A scan whose retries run out is failed as unavailable by `giveUp`; a Fitzpatrick step that runs out leaves the scan alone.
export const analyseFaceScan = defineJob<typeof analyseFaceScanSpec.schema, Container>(analyseFaceScanSpec, {
  handle: (body, services) => services.faceScans.advance(body),
  onDeadLetter: (body, services) => services.faceScans.giveUp(body),
})
