import { defineRoute, json, openapiApp } from '../../lib/openapi'
import { toHealthResponse } from './health.presenter'
import { HealthResponse } from './health.schemas'

const getHealth = defineRoute({
  method: 'get',
  path: '/',
  operationId: 'getHealth',
  tags: ['Health'],
  summary: 'Check the API and its dependencies',
  description: 'For uptime checks: the status code alone says whether the API can serve requests.',
  responses: {
    200: json(HealthResponse, 'Everything is reachable'),
    503: json(HealthResponse, 'Running, but a dependency (e.g. the database) is down'),
  },
})

export const healthRoutes = openapiApp().openapi(getHealth, async (c) => {
  const report = await c.var.services.health.check()
  return c.json(toHealthResponse(report), report.status === 'ok' ? 200 : 503)
})
