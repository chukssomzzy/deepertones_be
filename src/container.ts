import { D1JobRunsRepository } from './jobs/job-runs.repository'
import { createDb } from './lib/db'
import { once } from './lib/once'
import { D1AiUsageRepository } from './modules/ai-usage/ai-usage.repository'
import { AiUsageService } from './modules/ai-usage/ai-usage.service'
import { AuthService } from './modules/auth/auth.service'
import { TokenService } from './modules/auth/tokens.service'
import { D1CatalogRepository } from './modules/catalog/catalog.repository'
import { ProductCatalogService } from './modules/catalog/catalog.service'
import { D1GoalsRepository } from './modules/goals/goals.repository'
import { GoalsService } from './modules/goals/goals.service'
import { D1HealthRepository } from './modules/health/health.repository'
import { HealthService } from './modules/health/health.service'
import { D1NotificationSettingsRepository, D1PushTokensRepository } from './modules/notifications/notifications.repository'
import { NotificationsService } from './modules/notifications/notifications.service'
import { D1OtpRepository } from './modules/otp/otp.repository'
import { OtpService, parseOtpChannels } from './modules/otp/otp.service'
import { D1ProfilesRepository } from './modules/profiles/profiles.repository'
import { ProfilesService } from './modules/profiles/profiles.service'
import { D1ScansRepository } from './modules/scans/scans.repository'
import { ScanDataCleaner } from './modules/scans/scans.cleaner'
import { ScanService } from './modules/scans/scans.service'
import { D1UsersRepository } from './modules/users/users.repository'
import { UsersService } from './modules/users/users.service'
import { AnthropicClient } from './providers/anthropic/anthropic.client'
import { R2CatalogImageStore } from './providers/catalog-images/r2.catalog-image-store'
import { ZeptoMailEmailSender } from './providers/email/zeptomail.email'
import { CloudflareQueuesJobQueue } from './providers/job-queue/cloudflare-queues.job-queue'
import { AnthropicLabelReader } from './providers/label-reading/anthropic.label-reader'
import { AnthropicNameSplitter } from './providers/name-splitting/anthropic.name-splitter'
import { MetaWhatsAppOtpDelivery } from './providers/otp-delivery/meta-whatsapp.otp-delivery'
import type { PhotoEnvironment } from './providers/photo-store/photo-store.provider'
import { R2PhotoStore } from './providers/photo-store/r2.photo-store'
import { AnthropicProductAnalyst } from './providers/product-analysis/anthropic.product-analyst'
import { AnthropicProductRecognizer } from './providers/product-recognition/anthropic.product-recognizer'
import { AnthropicProductResearcher } from './providers/product-research/anthropic.product-researcher'
import { ExpoPushSender } from './providers/push/expo.push'
import { DurableObjectScanEvents } from './providers/scan-events/durable-object.scan-events'

const PHOTO_ENVIRONMENTS: readonly string[] = ['development', 'staging', 'production', 'test']

/** The private bucket tells environments apart by key prefix, so an unknown ENVIRONMENT must stop the build, not become a prefix. */
const photoEnvironment = (value: string): PhotoEnvironment => {
  if (!PHOTO_ENVIRONMENTS.includes(value)) throw new Error(`ENVIRONMENT must be one of ${PHOTO_ENVIRONMENTS.join(', ')} to name private photos, got ${JSON.stringify(value)}`)
  return value as PhotoEnvironment
}

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

  // The clients share the key, the models and the spend ledger. `timeoutMs` is the client's alone, so a caller that must answer within a
  // request gets its own.
  const newAnthropic = (timeoutMs?: number) =>
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
        'split-name': env.ANTHROPIC_MODEL_JUDGE,
      },
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    })
  // The client for the queue's model calls, which can take a minute (a web search turn).
  const anthropic = once(() => newAnthropic())
  // The split runs inside the user's request (identification), so it gives up after 15 s, not 60: the user is told to try again.
  const SPLIT_NAME_TIMEOUT_MS = 15_000
  const nameSplitterAnthropic = once(() => newAnthropic(SPLIT_NAME_TIMEOUT_MS))

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

  // One producer for every job: each job's `queue` name picks its binding.
  const jobQueue = once(
    () =>
      new CloudflareQueuesJobQueue({
        'otp-delivery': env.OTP_DELIVERY_QUEUE,
        'scan-items': env.SCAN_ITEMS_QUEUE,
        'push-delivery': env.PUSH_DELIVERY_QUEUE,
        'push-receipts': env.PUSH_RECEIPTS_QUEUE,
      }),
  )

  const otp = once(
    () =>
      new OtpService({
        repository: new D1OtpRepository(db()),
        jobs: jobQueue(),
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

  // The one private bucket, shared by every environment; the store refuses any key outside photos/<this environment>/.
  const privatePhotos = once(() => new R2PhotoStore({ bucket: env.PRIVATE_PHOTOS, environment: photoEnvironment(env.ENVIRONMENT) }))

  // The scan service never depends on users (users' cleaners call it), so there is no cycle.
  const scans = once(
    () =>
      new ScanService({
        repository: new D1ScansRepository(db()),
        catalog: catalog(),
        recognizer: new AnthropicProductRecognizer(anthropic()),
        labelReader: new AnthropicLabelReader(anthropic()),
        nameSplitter: new AnthropicNameSplitter(nameSplitterAnthropic()),
        photos: privatePhotos(),
        jobs: jobQueue(),
        events: new DurableObjectScanEvents(env.SCAN_STREAM),
        notifications: notifications(),
        // photo-link.ts derives its own key from this with a distinct HKDF info, so it cannot be used to sign a JWT.
        photoLinkSecret: env.JWT_SECRET,
        // A separate HKDF info (see ScanService) keeps the IP hash key unrelated to how device ids are hashed with the same secret.
        ipHashSecret: env.DEVICE_ID_KEY,
        environment: photoEnvironment(env.ENVIRONMENT),
      }),
  )

  // The guest cleanup needs only the scan rows and photos, not the scan service with the catalog and model clients behind it.
  const scanCleaner = once(() => new ScanDataCleaner({ repository: new D1ScansRepository(db()), photos: privatePhotos() }))

  // A module that stores per-user data adds a cleaner here; the daily guest cleanup runs it before deleting the guests.
  // (push_tokens, notification_settings and profile_goals are not listed: their foreign keys cascade from users or profiles.)
  const users = once(
    () =>
      new UsersService({
        repository: new D1UsersRepository(db()),
        guestDataCleaners: [{ name: 'scans', deleteFor: (ids) => scanCleaner().deleteForUsers(ids) }],
      }),
  )

  const profiles = once(() => new ProfilesService({ repository: new D1ProfilesRepository(db()) }))

  const tokens = once(() => new TokenService({ secret: env.JWT_SECRET, previousSecret: env.JWT_SECRET_PREVIOUS || undefined }))

  // The same DEVICE_ID_KEY as the auth service, so a token row's device hash is the `devices` table's hash of that phone.
  const notifications = once(
    () =>
      new NotificationsService({
        pushTokens: new D1PushTokensRepository(db()),
        settings: new D1NotificationSettingsRepository(db()),
        push: new ExpoPushSender({ accessToken: env.EXPO_ACCESS_TOKEN }),
        jobs: jobQueue(),
        deviceIdKey: env.DEVICE_ID_KEY,
      }),
  )

  const goals = once(() => new GoalsService({ repository: new D1GoalsRepository(db()), now: () => new Date(), newId: () => crypto.randomUUID() }))

  const auth = once(
    () =>
      new AuthService({
        users: users(),
        profiles: profiles(),
        otp: otp(),
        tokens: tokens(),
        notifications: notifications(),
        deviceIdKey: env.DEVICE_ID_KEY,
      }),
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
    get goals() {
      return goals()
    },
    get health() {
      return health()
    },
    get notifications() {
      return notifications()
    },
    get otp() {
      return otp()
    },
    get profiles() {
      return profiles()
    },
    get scans() {
      return scans()
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
