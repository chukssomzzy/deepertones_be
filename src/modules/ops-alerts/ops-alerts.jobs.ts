import type { Container } from '../../container'
import { defineJob } from '../../jobs/job'
import { sendOpsAlertSpec } from './ops-alerts.job-specs'

export const sendOpsAlert = defineJob<typeof sendOpsAlertSpec.schema, Container>(sendOpsAlertSpec, {
  handle: (body, services) => services.opsAlerts.send(body),
})
