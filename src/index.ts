import { logger } from 'hono/logger'
import { requestId } from 'hono/request-id'
import { secureHeaders } from 'hono/secure-headers'
import { errorHandler, notFoundHandler } from './lib/errors'
import { factory } from './lib/factory'
import { container } from './middleware/container'
import { cors } from './middleware/cors'
import { requestContext } from './middleware/request-context'
import { healthRoutes } from './modules/health/health.routes'

// Keep this a single chain: AppType is inferred from it, and the frontend's
// typed client (hc<AppType>) only sees routes mounted inside the chain.
//
// Middleware order matters: CORS answers preflights before any context or
// services are built, and requestContext wraps everything that can reach a service.
const app = factory
  .createApp()
  .use(requestId(), logger(), cors, secureHeaders(), requestContext, container)
  .route('/health', healthRoutes)

app.onError(errorHandler)
app.notFound(notFoundHandler)

export type AppType = typeof app
export default app
