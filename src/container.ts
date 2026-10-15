import { D1JobRunsRepository } from './jobs/job-runs.repository'
import { createDb } from './lib/db'
import { once } from './lib/once'
import { D1AiUsageRepository } from './modules/ai-usage/ai-usage.repository'
import { AiUsageService } from './modules/ai-usage/ai-usage.service'
import { AuthService } from './modules/auth/auth.service'
import { TokenService } from './modules/auth/tokens.service'
import { D1CatalogRepository } from './modules/catalog/catalog.repository'
import { ProductCatalogService } from './modules/catalog/catalog.service'
import { D1HealthRepository } from './modules/health/health.repository'
import { HealthService } from './modules/health/health.service'
import { D1OtpRepository } from './modules/otp/otp.repository'
import { OtpService, parseOtpChannels } from './modules/otp/otp.service'
import { D1UsersRepository } from './modules/users/users.repository'
import { UsersService } from './modules/users/users.service'
import { AnthropicClient } from './providers/anthropic/anthropic.client'
import { R2CatalogImageStore } from './providers/catalog-images/r2.catalog-image-store'
import { ZeptoMailEmailSender } from './providers/email/zeptomail.email'
import { CloudflareQueuesJobQueue } from './providers/job-queue/cloudflare-queues.job-queue'
import { MetaWhatsAppOtpDelivery } from './providers/otp-delivery/meta-whatsapp.otp-delivery'
import { AnthropicProductAnalyst } from './providers/product-analysis/anthropic.product-analyst'
import { AnthropicProductResearcher } from './providers/product-research/anthropic.product-researcher'

/**
 * The composition root: the ONLY file that knows concrete repository, provider and
 * service classes. Built per request (bindings arrive with the request) and lazy, so a
 * request only constructs what it touches.
 *
 * To add a module: build its repository from db(), its providers from env, and pass
 * other modules' services (never their repositories) by calling their `once` factory.
 *   const tracks = once(() => new TracksService(new D1TracksRepository(db()), users()))
 * then expose it as a getter below.
 */
export const buildContainer = (env: CloudflareBindings) => {
  const db = once(() => createDb(env.DB))

  const health = once(() => new HealthService(new D1HealthRepository(db()), env.ENVIRONMENT))

  // Shared: later modules send email too.
  const email = once(
    () =>
      new ZeptoMailEmailSender({
        apiUrl: env.ZEPTOMAIL_API_URL,
        apiKey: env.ZEPTOMAIL_API_KEY,
        fromAddress: env.EMAIL_FROM_ADDRESS,
        fromName: env.EMAIL_FROM_NAME,
      }),
  )

  // The app's only AI spend cap. Built here, not by the client, so the client can be given a different ledger (the eval's).
  const aiUsage = once(() => {
    const dailyBudgetUsd = Number(env.AI_DAILY_BUDGET_USD)
    // A cap that is missing or unreadable must not quietly become "no cap" (or "everything refused").
    if (!Number.isFinite(dailyBudgetUsd) || dailyBudgetUsd <= 0) {
      throw new Error('AI_DAILY_BUDGET_USD must be a positive number of US dollars, e.g. "5"')
    }
    return new AiUsageService({ repository: new D1AiUsageRepository(db()), capMicros: Math.round(dailyBudgetUsd * 1_000_000) })
  })

  // One client for the researcher and the analyst, so they share the key, the models and the spend ledger.
  const anthropic = once(
    () =>
      new AnthropicClient({
        apiKey: env.ANTHROPIC_API_KEY,
        ledger: aiUsage(),
        models: {
          research: env.ANTHROPIC_MODEL_RESEARCH,
          analysis: env.ANTHROPIC_MODEL_ANALYSIS,
          'same-product': env.ANTHROPIC_MODEL_JUDGE,
          'image-check': env.ANTHROPIC_MODEL_VISION,
          recognize: env.ANTHROPIC_MODEL_VISION,
          'read-label': env.ANTHROPIC_MODEL_VISION,
        },
      }),
  )

  // The catalog is shared data, not per-user, so it has no GuestDataCleaner.
  const catalog = once(
    () =>
      new ProductCatalogService({
        repository: new D1CatalogRepository(db()),
        researcher: new AnthropicProductResearcher(anthropic()),
        analyst: new AnthropicProductAnalyst(anthropic()),
        // The bucket is shared with the CI asset sync, which refuses any catalog/ key; the environment keeps staging and production apart.
        imageKeyPrefix: `catalog/${env.ENVIRONMENT}`,
        images: new R2CatalogImageStore({
          bucket: env.CATALOG_IMAGES,
          publicBaseUrl: env.CATALOG_IMAGES_PUBLIC_URL,
          // Our own zones, so a redirect from a brand site cannot point the Worker back at us.
          blockedHostSuffixes: ['deepertones.com', 'workers.dev'],
        }),
      }),
  )

  const otp = once(
    () =>
      new OtpService({
        repository: new D1OtpRepository(db()),
        jobs: new CloudflareQueuesJobQueue({ 'otp-delivery': env.OTP_DELIVERY_QUEUE }),
        channels: parseOtpChannels(env.OTP_CHANNELS),
        email: email(),
        whatsapp: new MetaWhatsAppOtpDelivery({
          accessToken: env.WHATSAPP_ACCESS_TOKEN ?? '',
          phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
          templateName: env.WHATSAPP_OTP_TEMPLATE,
          languageCode: env.WHATSAPP_OTP_LANGUAGE,
        }),
        pepper: env.OTP_PEPPER,
      }),
  )

  // A module that stores per-user data adds a cleaner here; the daily guest cleanup runs it before deleting the guests.
  const users = once(() => new UsersService({ repository: new D1UsersRepository(db()), guestDataCleaners: [] }))

  const tokens = once(() => new TokenService({ secret: env.JWT_SECRET, previousSecret: env.JWT_SECRET_PREVIOUS || undefined }))

  const auth = once(
    () => new AuthService({ users: users(), otp: otp(), tokens: tokens(), deviceIdKey: env.DEVICE_ID_KEY }),
  )

  return {
    get aiUsage() {
      return aiUsage()
    },
    get auth() {
      return auth()
    },
    get catalog() {
      return catalog()
    },
    get health() {
      return health()
    },
    get otp() {
      return otp()
    },
    get tokens() {
      return tokens()
    },
    get users() {
      return users()
    },
  }
}

export type Container = ReturnType<typeof buildContainer>

/**
 * What a queue consumer needs: the services (what routes get) plus the job-run bookkeeping.
 * jobRuns stays out of the services Container so routes can never reach a repository.
 */
export const buildJobRuntime = (env: CloudflareBindings) => ({
  services: buildContainer(env),
  jobRuns: new D1JobRunsRepository(createDb(env.DB)),
})
