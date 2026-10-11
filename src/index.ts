import { logger } from 'hono/logger'
import { requestId } from 'hono/request-id'
import { secureHeaders } from 'hono/secure-headers'
import { createQueueHandler } from './jobs/dispatcher'
import { jobs } from './jobs/registry'
import { mountDocs } from './docs'
import { errorHandler, notFoundHandler } from './lib/errors'
import { openapiApp } from './lib/openapi'
import { container } from './middleware/container'
import { cors } from './middleware/cors'
import { requestContext } from './middleware/request-context'
import { healthRoutes } from './modules/health/health.routes'

export const app = openapiApp()

// Order matters: CORS answers preflights before any context or services are built,
// and requestContext wraps everything that can reach a service.
app.use(requestId(), logger(), cors, secureHeaders(), requestContext, container)

// Keep this a single chain: AppType is inferred from it, and the frontend's
// typed client (hc<AppType>) only sees routes mounted inside the chain.
const routes = app.route('/health', healthRoutes)

mountDocs(app)
app.onError(errorHandler)
app.notFound(notFoundHandler)

export type AppType = typeof routes

export default {
  fetch: app.fetch,
  queue: createQueueHandler(jobs),
} satisfies ExportedHandler<CloudflareBindings>
