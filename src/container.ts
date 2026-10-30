import { D1JobRunsRepository } from './jobs/job-runs.repository'
import { createDb } from './lib/db'
import { once } from './lib/once'
import { D1AiUsageRepository } from './modules/ai-usage/ai-usage.repository'
import { AiUsageService } from './modules/ai-usage/ai-usage.service'
import { AuthService } from './modules/auth/auth.service'
import { TokenService } from './modules/auth/tokens.service'
import { D1CatalogRepository } from './modules/catalog/catalog.repository'
import { ProductCatalogService } from './modules/catalog/catalog.service'
import { D1CatalogWorkbookRepository } from './modules/catalog/catalog.workbook.repository'
import { CatalogWorkbookService } from './modules/catalog/catalog.workbook.service'
import { FaceDataCleaner } from './modules/face-scans/face-scans.cleaner'
import { D1FaceScansRepository } from './modules/face-scans/face-scans.repository'
import { FaceScanService } from './modules/face-scans/face-scans.service'
import { D1FaceSharesRepository } from './modules/face-shares/face-shares.repository'
import { FaceSharesService } from './modules/face-shares/face-shares.service'
import { D1GoalsRepository } from './modules/goals/goals.repository'
import { GoalsService } from './modules/goals/goals.service'
import { D1HealthRepository } from './modules/health/health.repository'
import { HealthService } from './modules/health/health.service'
import { D1InboxRepository } from './modules/inbox/inbox.repository'
import { InboxService } from './modules/inbox/inbox.service'
import { D1NotificationSettingsRepository, D1PushTokensRepository } from './modules/notifications/notifications.repository'
import { NotificationsService } from './modules/notifications/notifications.service'
import { D1OpsAlertsRepository } from './modules/ops-alerts/ops-alerts.repository'
import { OpsAlertsService } from './modules/ops-alerts/ops-alerts.service'
import { D1OtpRepository } from './modules/otp/otp.repository'
import { OtpService, parseOtpChannels } from './modules/otp/otp.service'
import { D1ProfilesRepository } from './modules/profiles/profiles.repository'
import { ProfilesService } from './modules/profiles/profiles.service'
import { D1RecommendationsRepository } from './modules/recommendations/recommendations.repository'
import { RecommendationService } from './modules/recommendations/recommendations.service'
import { D1RemindersRepository } from './modules/reminders/reminders.repository'
import { D1ReminderSendsRepository } from './modules/reminders/reminders.sends.repository'
import { ReminderSendsService } from './modules/reminders/reminders.sends.service'
import { ReminderFanOutService } from './modules/reminders/reminders.fan-out.service'
import { RemindersService } from './modules/reminders/reminders.service'
import { D1RoutineCheckInsRepository } from './modules/routines/routines.check-ins.repository'
import { RoutineCheckInsService } from './modules/routines/routines.check-ins.service'
import { D1OutcomeCountsRepository } from './modules/routines/routines.outcome-counts.repository'
import { D1RoutinesRepository } from './modules/routines/routines.repository'
import { RoutineService } from './modules/routines/routines.service'
import { RoutineViewerService } from './modules/routines/routines.viewer.service'
import type { RoutineTrigger } from './modules/routines/routines.trigger'
import { D1SafetyRepository } from './modules/safety/safety.repository'
import { SafetyService } from './modules/safety/safety.service'
import { D1ScansRepository } from './modules/scans/scans.repository'
import { ScanDataCleaner } from './modules/scans/scans.cleaner'
import { ScanService } from './modules/scans/scans.service'
import { D1ShelfRepository } from './modules/shelf/shelf.repository'
import { ShelfService } from './modules/shelf/shelf.service'
import { D1EscalationHoldsRepository } from './modules/skin-care/skin-care.holds.repository'
import { D1StepPausesRepository } from './modules/skin-care/skin-care.pauses.repository'
import { D1SkinCareRepository } from './modules/skin-care/skin-care.repository'
import { SkinCareService } from './modules/skin-care/skin-care.service'
import type { SkinCareRoutine } from './modules/skin-care/skin-care.types'
import { D1UsersRepository } from './modules/users/users.repository'
import { UsersService } from './modules/users/users.service'
import { D1VerdictReportsRepository } from './modules/verdicts/verdicts.reports.repository'
import { D1VerdictsRepository } from './modules/verdicts/verdicts.repository'
import { VerdictReportsService } from './modules/verdicts/verdicts.reports.service'
import { VerdictService } from './modules/verdicts/verdicts.service'
import { routineWriterWriteRoutinePrompt } from './prompts/prompts.generated'
import { AnthropicClient } from './providers/anthropic/anthropic.client'
import { R2CatalogImageStore } from './providers/catalog-images/r2.catalog-image-store'
import { ZeptoMailEmailSender } from './providers/email/zeptomail.email'
import { AnthropicGoalReader } from './providers/goal-reading/anthropic.goal-reader'
import { CloudflareQueuesJobQueue } from './providers/job-queue/cloudflare-queues.job-queue'
import { AnthropicLabelReader } from './providers/label-reading/anthropic.label-reader'
import { AnthropicMentionReader } from './providers/mention-reading/anthropic.mention-reader'
import { AnthropicNameSplitter } from './providers/name-splitting/anthropic.name-splitter'
import { MetaWhatsAppOtpDelivery } from './providers/otp-delivery/meta-whatsapp.otp-delivery'
import { RestPerfectCorpClient } from './providers/perfect-corp/rest.perfect-corp'
import type { PhotoEnvironment } from './providers/photo-store/photo-store.provider'
import { R2PhotoStore } from './providers/photo-store/r2.photo-store'
import { AnthropicProductAnalyst } from './providers/product-analysis/anthropic.product-analyst'
import { AnthropicProductRecognizer } from './providers/product-recognition/anthropic.product-recognizer'
import { AnthropicProductResearcher } from './providers/product-research/anthropic.product-researcher'
import { ExpoPushSender } from './providers/push/expo.push'
import { CloudflareImagesShareCardRenderer } from './providers/share-card/cloudflare-images.share-card-renderer'
import { DurableObjectScanEvents } from './providers/scan-events/durable-object.scan-events'
import { AnthropicRoutineWriter } from './providers/routine-writing/anthropic.routine-writer'
import { AnthropicVerdictFitter } from './providers/verdict-fitting/anthropic.verdict-fitter'
import { R2WorkbookArchive } from './providers/workbook-archive/r2.workbook-archive'

const PHOTO_ENVIRONMENTS: readonly string[] = ['development', 'staging', 'production', 'test']

/** The email logo in the public bucket (assets/email/logo.png, synced by CI): the share card's corner mark. */
const EMAIL_LOGO_KEY = 'email/logo.png'

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

  // The day's AI spend figure, which emails the owner when passed and refuses nothing. Built here, not by the client, so the client can be given a different ledger (the eval's).
  const aiUsage = once(() => {
    const dailyBudgetUsd = Number(env.AI_DAILY_BUDGET_USD)
    // A cap that is missing or unreadable must not quietly become "no cap" (or "everything refused").
    if (!Number.isFinite(dailyBudgetUsd) || dailyBudgetUsd <= 0) {
      throw new Error('AI_DAILY_BUDGET_USD must be a positive number of US dollars, e.g. "5"')
    }
    return new AiUsageService({
      repository: new D1AiUsageRepository(db()),
      opsAlerts: opsAlerts(),
      capMicros: Math.round(dailyBudgetUsd * 1_000_000),
      // Passed raw and checked when a Perfect Corp call is recorded, so a bad price cannot take the Claude calls down with it.
      perfectCorpUsdPerUnit: env.PERFECT_CORP_USD_PER_UNIT,
    })
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
        'recognize-shelf': env.ANTHROPIC_MODEL_RECOGNIZE_SHELF,
        'read-label': env.ANTHROPIC_MODEL_VISION,
        'split-name': env.ANTHROPIC_MODEL_JUDGE,
        'read-goal': env.ANTHROPIC_MODEL_JUDGE,
        'read-mentions': env.ANTHROPIC_MODEL_JUDGE,
        'draft-catalog-row': env.ANTHROPIC_MODEL_RESEARCH,
        'judge-draft': env.ANTHROPIC_MODEL_JUDGE,
        'judge-routine': env.ANTHROPIC_MODEL_JUDGE,
        'label-routine': env.ANTHROPIC_MODEL_JUDGE,
        'judge-grounding': env.ANTHROPIC_MODEL_JUDGE,
        'write-routine': env.ANTHROPIC_MODEL_ROUTINE,
        'fit-verdict': env.ANTHROPIC_MODEL_ROUTINE,
      },
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    })
  // The client for the queue's model calls, which can take a minute (a web search turn).
  const anthropic = once(() => newAnthropic())
  // The split runs inside the user's request (identification), so it gives up after 15 s, not 60: the user is told to try again.
  const SPLIT_NAME_TIMEOUT_MS = 15_000
  const nameSplitterAnthropic = once(() => newAnthropic(SPLIT_NAME_TIMEOUT_MS))
  // A typed goal is on the first screen and a failure only means the app shows the chips, so the read gives up sooner than the split does.
  const GOAL_READ_TIMEOUT_MS = 8_000
  const goalReaderAnthropic = once(() => newAnthropic(GOAL_READ_TIMEOUT_MS))
  // The parse of a typed reaction or prescription runs on the queue and nobody waits for it, but one read is one short call: it gives up after
  // 30 s so a stuck request frees the consumer for the retry, which is billed afresh, rather than holding it for the 60 s a web search turn can take.
  const MENTION_READ_TIMEOUT_MS = 30_000
  const mentionReaderAnthropic = once(() => newAnthropic(MENTION_READ_TIMEOUT_MS))
  // The fit judge reads a whole shelf and gives a reason for each product (adaptive thinking included), so one call runs well past a mention read; it is on
  // the queue and nobody waits, and 120 s still frees the consumer for the retry, which is billed afresh, if the request is stuck.
  const VERDICT_FIT_TIMEOUT_MS = 120_000
  const verdictFitterAnthropic = once(() => newAnthropic(VERDICT_FIT_TIMEOUT_MS))
  // The routine writer writes a reason for each step with adaptive thinking, so a call runs as long as a verdict fit does; it is on the queue and nobody waits.
  const ROUTINE_WRITE_TIMEOUT_MS = 120_000
  const routineWriterAnthropic = once(() => newAnthropic(ROUTINE_WRITE_TIMEOUT_MS))

  // The catalog is shared data, not per-user, so it has no GuestDataCleaner.
  const catalog = once(
    () =>
      new ProductCatalogService({
        repository: new D1CatalogRepository(db()),
        workbook: new D1CatalogWorkbookRepository(db()),
        researcher: new AnthropicProductResearcher(anthropic()),
        analyst: new AnthropicProductAnalyst(anthropic()),
        // The bucket is shared with the CI asset sync, which refuses any catalog/ key; the environment keeps staging and production apart.
        imageKeyPrefix: `catalog/${env.ENVIRONMENT}`,
        opsAlerts: opsAlerts(),
        images: new R2CatalogImageStore({
          bucket: env.CATALOG_IMAGES,
          publicBaseUrl: env.CATALOG_IMAGES_PUBLIC_URL,
          // Our own zones, so a redirect from a brand site cannot point the Worker back at us.
          blockedHostSuffixes: ['deepertones.com', 'workers.dev'],
        }),
      }),
  )

  // The catalog workbook: the live rules, the countries and the approved products, and the admin export and import. The archive of each applied
  // upload's .xlsx goes in the private bucket, under workbooks/<this environment>/.
  const catalogWorkbook = once(
    () =>
      new CatalogWorkbookService({
        repository: new D1CatalogWorkbookRepository(db()),
        archive: new R2WorkbookArchive({ bucket: env.PRIVATE_PHOTOS, environment: photoEnvironment(env.ENVIRONMENT) }),
        now: () => new Date(),
        newId: () => crypto.randomUUID(),
        // In production only, an approved step-down template must be approved by someone on this list.
        environment: env.ENVIRONMENT,
        qualifiedApprovers: env.QUALIFIED_APPROVERS,
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
        'parse-safety': env.PARSE_SAFETY_QUEUE,
        email: env.EMAIL_QUEUE,
        'face-scans': env.FACE_SCANS_QUEUE,
        verdicts: env.VERDICTS_QUEUE,
        routines: env.ROUTINES_QUEUE,
      }),
  )

  // Emails the owner when an environment-wide limit is passed or Claude refuses our account. The alert is a job on the shared email queue.
  const opsAlerts = once(
    () =>
      new OpsAlertsService({
        repository: new D1OpsAlertsRepository(db()),
        jobs: jobQueue(),
        email: email(),
        recipient: env.OPS_ALERT_EMAIL,
        environment: env.ENVIRONMENT,
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
        opsAlerts: opsAlerts(),
        // photo-link.ts derives its own key from this with a distinct HKDF info, so it cannot be used to sign a JWT.
        photoLinkSecret: env.JWT_SECRET,
        // A separate HKDF info (see ScanService) keeps the IP hash key unrelated to how device ids are hashed with the same secret.
        ipHashSecret: env.DEVICE_ID_KEY,
        environment: photoEnvironment(env.ENVIRONMENT),
      }),
  )

  // The guest cleanup needs only the scan rows and photos, not the scan service with the catalog and model clients behind it.
  const scanCleaner = once(() => new ScanDataCleaner({ repository: new D1ScansRepository(db()), photos: privatePhotos() }))

  // Likewise for face scans: the cleanup deletes their photos and masks from the bucket (the rows cascade from the profile, the bucket does not).
  const faceCleaner = once(() => new FaceDataCleaner({ repository: new D1FaceScansRepository(db()), photos: privatePhotos() }))

  // A module that stores per-user data adds a cleaner here; the daily guest cleanup runs it before deleting the guests.
  // (push_tokens, notification_settings, profile_goals, profile_safety and profile_shopping are not listed: their foreign keys cascade from users or profiles.)
  const users = once(
    () =>
      new UsersService({
        repository: new D1UsersRepository(db()),
        guestDataCleaners: [
          { name: 'scans', deleteFor: (ids) => scanCleaner().deleteForUsers(ids) },
          { name: 'face-scans', deleteFor: (ids) => faceCleaner().deleteForUsers(ids) },
        ],
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
        reminders: reminders(),
        deviceIdKey: env.DEVICE_ID_KEY,
      }),
  )

  const inbox = once(() => new InboxService({ repository: new D1InboxRepository(db()) }))

  const reminders = once(
    () =>
      new RemindersService({
        repository: new D1RemindersRepository(db()),
        users: users(),
        profiles: profiles(),
        whatsappEnabled: parseOtpChannels(env.OTP_CHANNELS).includes('whatsapp'),
        inbox: inbox(),
      }),
  )

  const safety = once(
    () =>
      new SafetyService({
        repository: new D1SafetyRepository(db()),
        reader: new AnthropicMentionReader(mentionReaderAnthropic()),
        catalog: catalog(),
        jobs: jobQueue(),
        now: () => new Date(),
        newId: () => crypto.randomUUID(),
      }),
  )

  const goals = once(
    () =>
      new GoalsService({
        repository: new D1GoalsRepository(db()),
        reader: new AnthropicGoalReader(goalReaderAnthropic()),
        safety: safety(),
        now: () => new Date(),
        newId: () => crypto.randomUUID(),
      }),
  )

  const verdictReportsRepository = once(() => new D1VerdictReportsRepository(db()))

  const shelf = once(
    () =>
      new ShelfService({
        repository: new D1ShelfRepository(db()),
        catalog: catalog(),
        scans: scans(),
        // The verdict as it would be served now (null while pending, out of date or unavailable): its stopped products by entry, with the code of the step-down each is shown
        // with (`taperTemplateId`, the `code` of `tapers[]` in GET /me/verdict). The verdict is built on the shelf, so it is asked through here, not imported by the shelf module.
        stepDowns: {
          stopsFor: async (profileId): Promise<Map<string, string>> => {
            const saved = await verdicts().savedFor(profileId)
            return new Map((saved?.products ?? []).flatMap(({ entryId, verdict }) => (verdict.kind === 'stop' ? [[entryId, verdict.taperTemplateId] as const] : [])))
          },
        },
        // Structural, so shelf does not import verdicts: the swap's report goes to the verdicts' report table.
        wrongMatches: { record: (report, now) => verdictReportsRepository().recordWrongMatch(report, now) },
        opsAlerts: opsAlerts(),
        now: () => new Date(),
      }),
  )

  const perfectCorp = once(() => new RestPerfectCorpClient({ apiKey: env.PERFECT_CORP_API_KEY, webhookSecret: env.PERFECT_CORP_WEBHOOK_SECRET, baseUrl: env.PERFECT_CORP_BASE_URL }))

  // Lazily: the routines service reads the modules that call this, so it cannot be built before them. The annotation keeps the types of the two from defining each other.
  const routineTrigger: RoutineTrigger = async (profileId, reason, requestKey) => {
    // Triggers ask again at their next event, so whether a build was queued is not theirs to know.
    await routines().request(profileId, reason, requestKey)
  }

  const faceScans = once(
    () =>
      new FaceScanService({
        repository: new D1FaceScansRepository(db()),
        goals: goals(),
        photos: privatePhotos(),
        jobs: jobQueue(),
        perfectCorp: perfectCorp(),
        // Perfect Corp's units go in the same ledger as the Claude calls: one table, one daily figure, one alert.
        aiUsage: aiUsage(),
        events: new DurableObjectScanEvents(env.SCAN_STREAM),
        notifications: notifications(),
        opsAlerts: opsAlerts(),
        reminders: reminders(),
        // photo-link.ts derives its own key from this with a distinct HKDF info, so it cannot be used to sign a JWT.
        photoLinkSecret: env.JWT_SECRET,
        environment: photoEnvironment(env.ENVIRONMENT),
        onRoutineTrigger: routineTrigger,
      }),
  )

  const faceShares = once(
    () =>
      new FaceSharesService({
        repository: new D1FaceSharesRepository(db()),
        faceScans: faceScans(),
        photos: privatePhotos(),
        // The label font is a repo asset (assets/share-card/), synced to the public bucket like the email logo.
        renderer: new CloudflareImagesShareCardRenderer({ images: env.IMAGES, fontUrl: `${env.CATALOG_IMAGES_PUBLIC_URL}/share-card/label.ttf` }),
        readLogo: async () => {
          const logo = await env.CATALOG_IMAGES.get(EMAIL_LOGO_KEY)
          if (!logo) throw new Error('The email logo is not in the public bucket')
          return { bytes: new Uint8Array(await logo.arrayBuffer()), mediaType: 'image/png' }
        },
        opsAlerts: opsAlerts(),
      }),
  )

  const recommendations = once(
    () =>
      new RecommendationService({
        repository: new D1RecommendationsRepository(db()),
        goals: goals(),
        safety: safety(),
        workbook: catalogWorkbook(),
        faceScans: faceScans(),
        catalog: catalog(),
        now: () => new Date(),
        newId: () => crypto.randomUUID(),
      }),
  )

  const verdicts = once(
    () =>
      new VerdictService({
        repository: new D1VerdictsRepository(db()),
        fitter: new AnthropicVerdictFitter(verdictFitterAnthropic()),
        jobs: jobQueue(),
        events: new DurableObjectScanEvents(env.SCAN_STREAM),
        workbook: catalogWorkbook(),
        catalog: catalog(),
        shelf: shelf(),
        scans: scans(),
        safety: safety(),
        goals: goals(),
        faceScans: faceScans(),
        onRoutineTrigger: routineTrigger,
        now: () => new Date(),
      }),
  )

  const verdictReports = once(
    () => new VerdictReportsService({ repository: verdictReportsRepository(), verdicts: verdicts(), opsAlerts: opsAlerts(), now: () => new Date() }),
  )

  const routines = once(() => {
    const client = routineWriterAnthropic()
    return new RoutineService({
      verdicts: verdicts(),
      recommendations: recommendations(),
      goals: goals(),
      safety: safety(),
      shelf: shelf(),
      // The wrong-product swap's right product (#259 B5): the routines module sees only this read, not the verdicts module.
      swaps: { rightProductsFor: (profileId, entryIds) => verdictReportsRepository().wrongMatchesFor(profileId, entryIds) },
      catalog: catalog(),
      faceScans: faceScans(),
      workbook: catalogWorkbook(),
      profiles: profiles(),
      reminders: reminders(),
      writer: new AnthropicRoutineWriter(client),
      writerIdentity: { model: client.modelFor(routineWriterWriteRoutinePrompt.job), promptHash: routineWriterWriteRoutinePrompt.hash },
      repository: new D1RoutinesRepository(db()),
      outcomeCounts: new D1OutcomeCountsRepository(db()),
      jobs: jobQueue(),
      enabled: env.ROUTINES_ENABLED === 'true',
      // Lazy: the viewer reads this service, so wiring it here is deferred to the first announcement.
      announce: async (profileId: string): Promise<void> => routineViewer().announce(profileId),
      skinCare: skinCare(),
      now: () => new Date(),
      newId: () => crypto.randomUUID(),
    })
  })

  // Skin care reads the routine through the viewer, which reads skin care's pauses (`stateFor`) and the routine service, which asks it to reconcile: the viewer is reached lazily
  // so none of the three needs another to exist first, and the lambdas name their return types so the cycle does not make them infer from each other.
  const skinCare = once(
    () =>
      new SkinCareService({
        repository: new D1SkinCareRepository(db()),
        pauses: new D1StepPausesRepository(db()),
        holds: new D1EscalationHoldsRepository(db()),
        workbook: catalogWorkbook(),
        reminders: reminders(),
        routine: {
          // The log hands over the routine it has read (one read for the step-down and the choice); a call without one reads it.
          stepDownRunning: async (profileId: string, _today: string, read?: SkinCareRoutine | null): Promise<boolean> =>
            (read === undefined ? await routineViewer().skinCareRoutineFor(profileId) : read)?.stepDownRunning ?? false,
          skinCareRoutineFor: async (profileId: string): Promise<SkinCareRoutine | null> => routineViewer().skinCareRoutineFor(profileId),
        },
        inbox: inbox(),
        safety: safety(),
        verdicts: verdicts(),
        catalog: catalog(),
      }),
  )

  const routineCheckInsRepository = once(() => new D1RoutineCheckInsRepository(db()))

  const routineCheckIns = once(
    () =>
      new RoutineCheckInsService({
        repository: routineCheckInsRepository(),
        versions: new D1RoutinesRepository(db()),
        reminders: reminders(),
        inbox: inbox(),
        routine: routineViewer(),
      }),
  )

  const routineViewer = once(
    () =>
      new RoutineViewerService({
        routines: routines(),
        goals: goals(),
        workbook: catalogWorkbook(),
        catalog: catalog(),
        shelf: shelf(),
        recommendations: recommendations(),
        safety: safety(),
        repository: new D1RoutinesRepository(db()),
        skinCare: skinCare(),
        reminders: reminders(),
        checkIns: routineCheckInsRepository(),
        inbox: inbox(),
        events: new DurableObjectScanEvents(env.SCAN_STREAM),
        enabled: env.ROUTINES_ENABLED === 'true',
        now: () => new Date(),
      }),
  )

  const reminderSends = once(
    () =>
      new ReminderSendsService({
        settings: new D1RemindersRepository(db()),
        sends: new D1ReminderSendsRepository(db()),
        routine: routineViewer(),
        checkIns: routineCheckIns(),
        channel: reminders(),
        notifications: notifications(),
        inbox: inbox(),
        skinCare: skinCare(),
      }),
  )

  const reminderFanOut = once(() => new ReminderFanOutService({ profiles: routines(), jobs: jobQueue() }))

  const auth = once(
    () =>
      new AuthService({
        users: users(),
        profiles: profiles(),
        otp: otp(),
        tokens: tokens(),
        notifications: notifications(),
        deviceIdKey: env.DEVICE_ID_KEY,
        onRoutineTrigger: routineTrigger,
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
    get catalogWorkbook() {
      return catalogWorkbook()
    },
    get faceScans() {
      return faceScans()
    },
    get faceShares() {
      return faceShares()
    },
    get goals() {
      return goals()
    },
    get health() {
      return health()
    },
    get inbox() {
      return inbox()
    },
    get notifications() {
      return notifications()
    },
    get opsAlerts() {
      return opsAlerts()
    },
    get otp() {
      return otp()
    },
    get profiles() {
      return profiles()
    },
    get recommendations() {
      return recommendations()
    },
    get reminders() {
      return reminders()
    },
    get reminderFanOut() {
      return reminderFanOut()
    },
    get reminderSends() {
      return reminderSends()
    },
    get safety() {
      return safety()
    },
    get skinCare() {
      return skinCare()
    },
    get routines() {
      return routines()
    },
    get routineCheckIns() {
      return routineCheckIns()
    },
    get routineViewer() {
      return routineViewer()
    },
    get scans() {
      return scans()
    },
    get shelf() {
      return shelf()
    },
    get tokens() {
      return tokens()
    },
    get users() {
      return users()
    },
    get verdicts() {
      return verdicts()
    },
    get verdictReports() {
      return verdictReports()
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
