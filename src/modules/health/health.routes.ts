import { factory } from '../../lib/factory'
import { toHealthResponse } from './health.presenter'

export const healthRoutes = factory.createApp().get('/', async (c) => {
  const report = await c.var.services.health.check()
  return c.json(toHealthResponse(report), report.status === 'ok' ? 200 : 503)
})
