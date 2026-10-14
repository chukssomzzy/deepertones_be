import { UnavailableError } from '../../lib/errors'
import { defineRoute, errorResponses, ok, openapiApp, success } from '../../lib/openapi'
import { toHealthResponse } from './health.presenter'
import { HealthResponse } from './health.schemas'

const getHealth = defineRoute({
  method: 'get',
  path: '/',
  operationId: 'getHealth',
  tags: ['Health'],
  summary: 'Check the API and its dependencies',
  description: 'For uptime checks: the status code alone says whether the API can serve requests.',
  security: [],
  responses: {
    200: success(HealthResponse, 'Everything is reachable'),
    ...errorResponses(503),
  },
})

export const healthRoutes = openapiApp().openapi(getHealth, async (c) => {
  const report = await c.var.services.health.check()
  if (report.status !== 'ok') {
    throw new UnavailableError('SERVICE_DEGRADED', 'A dependency is down', toHealthResponse(report))
  }
  return ok(c, toHealthResponse(report), 'Health check complete')
})
