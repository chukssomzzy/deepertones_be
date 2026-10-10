import type { z } from '@hono/zod-openapi'
import type { HealthResponse } from './health.schemas'
import type { HealthReport } from './health.types'

export const toHealthResponse = (report: HealthReport): z.infer<typeof HealthResponse> => ({
  status: report.status,
  environment: report.environment,
  checks: report.checks,
})
