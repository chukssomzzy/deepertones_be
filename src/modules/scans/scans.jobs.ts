import type { Container } from '../../container'
import { defineJob } from '../../jobs/job'
import { advanceScanItemSpec } from './scans.job-specs'

export const advanceScanItem = defineJob<typeof advanceScanItemSpec.schema, Container>(advanceScanItemSpec, {
  handle: (body, services) => services.scans.advance(body.itemId, body.step),
  onDeadLetter: (body, services) => services.scans.markItemFailed(body.itemId),
})
