import type { HealthReport } from './health.types'

export const toHealthResponse = (report: HealthReport) => ({
  status: report.status,
  environment: report.environment,
  checks: report.checks,
})
