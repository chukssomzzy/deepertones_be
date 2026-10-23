// The HTTP app, kept apart from src/index.ts so `npm run openapi` can load it in plain Node: the Worker entry also exports the
// Durable Object class, which imports `cloudflare:workers`.
import { logger } from 'hono/logger'
import { requestId } from 'hono/request-id'
import { secureHeaders } from 'hono/secure-headers'
import { mountDocs } from './docs'
import { API_V1_PREFIX } from './lib/api-version'
import { errorHandler, notFoundHandler } from './lib/errors'
import { openapiApp } from './lib/openapi'
import { auth } from './middleware/auth'
import { container } from './middleware/container'
import { cors } from './middleware/cors'
import { requestContext } from './middleware/request-context'
import { authRoutes, meRoutes } from './modules/auth/auth.routes'
import { productRoutes } from './modules/catalog/catalog.routes'
import { adminCatalogRoutes } from './modules/catalog/catalog.workbook.routes'
import { faceConsentRoutes, faceScanRoutes, webhookRoutes } from './modules/face-scans/face-scans.routes'
import { goalsRoutes } from './modules/goals/goals.routes'
import { healthRoutes } from './modules/health/health.routes'
import { notificationsRoutes } from './modules/notifications/notifications.routes'
import { onboardingRoutes } from './modules/onboarding/onboarding.routes'
import { recommendationsRoutes } from './modules/recommendations/recommendations.routes'
import { safetyRoutes } from './modules/safety/safety.routes'
import { shelfRoutes } from './modules/shelf/shelf.routes'
import { FACE_SCANS_PATH, PRODUCT_SCANS_PATH } from './modules/scans/scans.paths'
import { scanRoutes } from './modules/scans/scans.routes'

export const app = openapiApp()

// Order matters: CORS answers preflights before any context or services are built. container is
// lazy, so it is cheap to run early; auth needs services.tokens, and records who is calling without
// ever rejecting. requestContext comes last and wraps every route and service call. Anything before it
// (container, auth, a future rate limiter) runs outside the request context, so it must not call a
// service that reads currentActor()/requireUser().
app.use(requestId(), logger(), cors, secureHeaders(), container, auth, requestContext)

// Keep this a single chain: AppType is inferred from it, and the frontend's
// typed client (hc<AppType>) only sees routes mounted inside the chain.
// Everything but /health lives under API_V1_PREFIX: one sub-app carries the versioned routes so a future v2 sits beside it.
const v1 = openapiApp()
  .route('/auth', authRoutes)
  .route('/me', meRoutes)
  .route('/me', notificationsRoutes)
  .route('/me', goalsRoutes)
  .route('/me', safetyRoutes)
  .route('/me', recommendationsRoutes)
  .route('/me', shelfRoutes)
  .route('/me', faceConsentRoutes)
  .route('/products', productRoutes)
  .route('/onboarding', onboardingRoutes)
  .route(PRODUCT_SCANS_PATH, scanRoutes)
  .route(FACE_SCANS_PATH, faceScanRoutes)
  .route('/webhooks', webhookRoutes)
  .route('/admin', adminCatalogRoutes)
const routes = app.route('/health', healthRoutes).route(API_V1_PREFIX, v1)

mountDocs(app)
app.onError(errorHandler)
app.notFound(notFoundHandler)

export type AppType = typeof routes
