import { afterEach, describe, expect, it, vi } from 'vitest'
import { PermanentJobError } from '../../jobs/job'
import { runAs } from '../../lib/context'
import { ConflictError, NotFoundError, UnauthorizedError, UnavailableError, ValidationError } from '../../lib/errors'
import { MemoryEmailSender } from '../../providers/email/memory.email'
import { MemoryGoalReader } from '../../providers/goal-reading/memory.goal-reader'
import { MemoryJobQueue } from '../../providers/job-queue/memory.job-queue'
import { MemoryMentionReader } from '../../providers/mention-reading/memory.mention-reader'
import { MemoryPerfectCorpClient } from '../../providers/perfect-corp/memory.perfect-corp'
import { MemoryPushSender } from '../../providers/push/memory.push'
import {
  PerfectCorpBadRequestError,
  PerfectCorpCreditError,
  PerfectCorpRejectedPhotoError,
  PerfectCorpUnavailableError,
  type SkinAnalysisResult,
} from '../../providers/perfect-corp/perfect-corp.provider'
import { MemoryPhotoStore } from '../../providers/photo-store/memory.photo-store'
import type { PhotoEnvironment } from '../../providers/photo-store/photo-store.provider'
import type { ProductImage } from '../../providers/product-analysis/product-analyst.provider'
import { MemoryScanEvents } from '../../providers/scan-events/memory.scan-events'
import { FakeGoalsRepository } from '../goals/goals.repository.fake'
import { GoalsService } from '../goals/goals.service'
import { GOALS, type Goal } from '../goals/goals.vocabulary'
import { FakeNotificationSettingsRepository } from '../notifications/notification-settings.repository.fake'
import { type SendPushMessage, sendPushSpec } from '../notifications/notifications.job-specs'
import { NotificationsService } from '../notifications/notifications.service'
import { FakePushTokensRepository } from '../notifications/push-tokens.repository.fake'
import { FakeOpsAlertsRepository } from '../ops-alerts/ops-alerts.repository.fake'
import { OpsAlertsService } from '../ops-alerts/ops-alerts.service'
import { FakeSafetyRepository } from '../safety/safety.repository.fake'
import { SafetyService } from '../safety/safety.service'
import { jpegPhoto } from '../scans/scans.photos.fake'
import { CURRENT_FACE_CONSENT_VERSION } from './face-scans.consent'
import { analyseFaceScanSpec } from './face-scans.job-specs'
import { FakeFaceScansRepository } from './face-scans.repository.fake'
import { FACE_SCAN_LIST_LIMIT, FaceScanService } from './face-scans.service'
import { measuredConcernsForGoal, TABLES_VERSION } from './face-scans.tables'
import { FakeVendorSpendLedger } from './face-scans.vendor-spend.fake'

// The face scan's analysis pipeline through FaceScanService: the three job steps (advance), the webhook (receiveWebhook), the retake, the
// reaper's one check (reap) and the live stream (watch). Only the edges are fakes: Perfect Corp (MemoryPerfectCorpClient, scripted per
// call), the bucket, the queue, the spend ledger, the live stream and the ops alert mail. The repository is the in-memory twin that the
// same contract as D1 pins, and the goals service is the real one. The service signatures these tests assume are listed in the report that
// came with them; the expected values below are literals worked out from the brief, never taken from the code under test.

// The one clock every test hangs off; fixtures are offsets from it.
const T0 = new Date('2030-06-15T12:00:00.000Z')
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
/** The reaper looks at an analysing scan once it has sat this long, and fails it once it has sat the second. */
const STALE_AFTER = 15 * MINUTE
const FAIL_AFTER = 2 * HOUR

const PHOTO_SECRET = 'photo-link-secret-for-tests'
const USER = 'user-1'
const PROFILE = 'profile-1'
const OTHER_PROFILE = 'profile-2'

const NO_CATALOG = {
  resolve: async () => {
    throw new Error('the face scan tests never reach the catalog')
  },
  research: async () => {
    throw new Error('the face scan tests never reach the catalog')
  },
}

/** A Perfect Corp client whose mask download can be interrupted by the test, and that answers with the bytes of the address it was given. */
class HookedPerfectCorp extends MemoryPerfectCorpClient {
  duringDownload: (() => Promise<void>) | undefined
  /** Runs once, after the analysis task exists at Perfect Corp and before the caller has it. */
  duringCreateSkinAnalysis: (() => Promise<void>) | undefined

  override async createSkinAnalysis(input: { fileId: string; actions: string[] }): Promise<string> {
    const taskId = await super.createSkinAnalysis(input)
    const hook = this.duringCreateSkinAnalysis
    this.duringCreateSkinAnalysis = undefined
    await hook?.()
    return taskId
  }

  override async downloadMask(url: string): Promise<Uint8Array> {
    await super.downloadMask(url)
    const hook = this.duringDownload
    this.duringDownload = undefined
    await hook?.()
    return new TextEncoder().encode(url)
  }
}

/** A repository whose reads can be interrupted once by the test, to put another change exactly between two of the service's own calls. */
class HookedRepository extends FakeFaceScansRepository {
  afterPhotosRead: (() => Promise<void>) | undefined
  afterKeysRead: (() => Promise<void>) | undefined
  afterUncheckedStaleRead: (() => Promise<void>) | undefined

  override async photosOf(faceScanId: string) {
    const photos = await super.photosOf(faceScanId)
    await this.once('afterPhotosRead')
    return photos
  }

  override async keysOfFaceScan(faceScanId: string) {
    const keys = await super.keysOfFaceScan(faceScanId)
    await this.once('afterKeysRead')
    return keys
  }

  override async staleAnalysing(before: Date, limit: number, options?: { unchecked?: true }) {
    const stale = await super.staleAnalysing(before, limit, options)
    if (options?.unchecked) await this.once('afterUncheckedStaleRead')
    return stale
  }

  private async once(name: 'afterPhotosRead' | 'afterKeysRead' | 'afterUncheckedStaleRead') {
    const hook = this[name]
    this[name] = undefined
    await hook?.()
  }
}

/** A repository that notes which scans' stored scores were read, to count the reads a list makes. */
class ReadCountingRepository extends FakeFaceScansRepository {
  readonly resultsRead: string[] = []

  override async resultsOf(faceScanId: string) {
    this.resultsRead.push(faceScanId)
    return super.resultsOf(faceScanId)
  }
}

class EventsThatFail extends MemoryScanEvents {
  override async publish(): Promise<void> {
    throw new Error('the stream is down')
  }
}

type SetupOptions = { repository?: FakeFaceScansRepository; environment?: PhotoEnvironment; events?: MemoryScanEvents }

const setup = (options: SetupOptions = {}) => {
  const environment = options.environment ?? 'test'
  let clock = T0
  let n = 0
  let g = 0
  const goalReader = new MemoryGoalReader()
  const safety = new SafetyService({
    repository: new FakeSafetyRepository(),
    reader: new MemoryMentionReader(),
    catalog: NO_CATALOG,
    jobs: new MemoryJobQueue(),
    now: () => clock,
    newId: () => `safety-${crypto.randomUUID()}`,
  })
  const goals = new GoalsService({ repository: new FakeGoalsRepository(), reader: goalReader, safety, now: () => clock, newId: () => `goal-${++g}` })
  const repository = options.repository ?? new FakeFaceScansRepository()
  const photos = new MemoryPhotoStore({ environment })
  const jobs = new MemoryJobQueue()
  const perfectCorp = new HookedPerfectCorp()
  const aiUsage = new FakeVendorSpendLedger()
  const events = options.events ?? new MemoryScanEvents()
  const alertJobs = new MemoryJobQueue()
  const opsAlerts = new OpsAlertsService({ repository: new FakeOpsAlertsRepository(), jobs: alertJobs, email: new MemoryEmailSender(), recipient: '', environment, now: () => clock })
  // The push jobs go to a queue of their own: `queuedSteps` and `clearQueue` read `jobs` as the scan's steps.
  const pushJobs = new MemoryJobQueue()
  const notifications = new NotificationsService({
    pushTokens: new FakePushTokensRepository(),
    settings: new FakeNotificationSettingsRepository(),
    push: new MemoryPushSender(),
    jobs: pushJobs,
    deviceIdKey: 'device-key-for-tests',
    now: () => clock,
  })
  const service = new FaceScanService({
    repository,
    goals,
    photos,
    jobs,
    perfectCorp,
    aiUsage,
    events,
    notifications,
    opsAlerts,
    photoLinkSecret: PHOTO_SECRET,
    environment,
    now: () => clock,
    newId: () => `id-${environment}-${++n}`,
  })
  return {
    service,
    repository,
    goals,
    photos,
    jobs,
    pushJobs,
    perfectCorp,
    aiUsage,
    events,
    alertJobs,
    environment,
    advanceClock: (ms: number) => (clock = new Date(clock.getTime() + ms)),
    now: () => clock,
  }
}
type Ctx = ReturnType<typeof setup>

const asUser = <T>(fn: () => Promise<T>, profileId = PROFILE) => runAs({ kind: 'user', userId: USER, status: 'verified', profileId }, fn)
const asSystem = <T>(fn: () => Promise<T>) => runAs({ kind: 'system', job: 'analyse-face-scan' }, fn)

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error as Error & { code?: string; details?: Record<string, unknown> }
  }
  throw new Error('expected the promise to reject')
}

/** The face-scan-concern-missing warnings `fn` logs, as the objects logged. */
const warningsDuring = async (fn: () => Promise<unknown>) => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  try {
    await fn()
    return warn.mock.calls.map((call) => call[0] as { outcome?: string }).filter((entry) => entry?.outcome === 'face-scan-concern-missing')
  } finally {
    warn.mockRestore()
  }
}

/** What the app and Perfect Corp see logged while `fn` runs, as one string. */
const loggedDuring = async (fn: () => Promise<unknown>) => {
  const spies = (['log', 'info', 'warn', 'error'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => undefined))
  try {
    await fn()
    return JSON.stringify(spies.flatMap((spy) => spy.mock.calls))
  } finally {
    spies.forEach((spy) => spy.mockRestore())
  }
}

// A face photo: a JPEG whose header says 1080 x 1440, with a marker byte at the end so two photos can be told apart in storage.
const face = (marker = 1): ProductImage => {
  const photo = jpegPhoto({ width: 1080, height: 1440 })
  photo.bytes[photo.bytes.length - 1] = marker
  return photo
}

const frontKey = (ctx: Ctx, scanId: string) => `faces/${ctx.environment}/${USER}/${PROFILE}/${scanId}/front.jpg`
const maskKey = (ctx: Ctx, scanId: string, slug: string) => `faces/${ctx.environment}/${USER}/${PROFILE}/${scanId}/mask-${slug}.png`
const masksStored = (ctx: Ctx) => [...ctx.photos.stored.keys()].filter((key) => key.includes('/mask-')).sort()

const giveConsent = (ctx: Ctx, profileId = PROFILE) => asUser(() => ctx.service.giveConsent(CURRENT_FACE_CONSENT_VERSION), profileId)
const setGoal = (ctx: Ctx, goal: Goal, profileId = PROFILE) => asUser(() => ctx.goals.set({ goal }), profileId)
/** A scan the way the create route makes it: consent, a goal and the front photo (marker 1). Resolves to the scan's id; the `upload` job is queued, not run. */
const started = async (ctx: Ctx, goal: Goal = 'glow'): Promise<string> => {
  await giveConsent(ctx)
  await setGoal(ctx, goal)
  const view = await asUser(() => ctx.service.create({ front: face(1) }))
  return view.id
}
const getScan = (ctx: Ctx, id: string, profileId = PROFILE): Promise<any> => asUser(() => ctx.service.getFaceScan(id), profileId)
const rowOf = async (ctx: Ctx, id: string) => (await ctx.repository.findFaceScan(id))!

const upload = (ctx: Ctx, id: string) => asSystem(() => ctx.service.advance({ faceScanId: id, step: 'upload', at: ctx.now().getTime() }))
const fetchStep = (ctx: Ctx, id: string, webhookId?: string) =>
  asSystem(() => ctx.service.advance({ faceScanId: id, step: 'fetch', at: ctx.now().getTime(), ...(webhookId ? { webhookId } : {}) }))
const fitzpatrickStep = (ctx: Ctx, id: string, webhookId?: string) =>
  asSystem(() => ctx.service.advance({ faceScanId: id, step: 'fitzpatrick', at: ctx.now().getTime(), ...(webhookId ? { webhookId } : {}) }))
const reap = (ctx: Ctx, at: Date) => asSystem(() => ctx.service.reap(at))
const retake = (ctx: Ctx, id: string, front: ProductImage = face(9), profileId = PROFILE) => asUser(() => ctx.service.retake(id, { front }), profileId)
const receive = (ctx: Ctx, rawBody = '{"data":{}}', headers: Record<string, string> = { 'webhook-id': 'wh-1' }) => asSystem(() => ctx.service.receiveWebhook(rawBody, new Headers(headers)))

const callsOf = (ctx: Ctx, method: string) => ctx.perfectCorp.calls.filter((call) => call.method === method)
const methodsCalled = (ctx: Ctx) => ctx.perfectCorp.calls.map((call) => call.method)
const queuedSteps = (ctx: Ctx) => ctx.jobs.enqueued.filter((job) => job.job === analyseFaceScanSpec.name).map((job) => job.body as Record<string, unknown>)
const clearQueue = (ctx: Ctx) => void (ctx.jobs.enqueued.length = 0)
const deletedTasks = (ctx: Ctx) => callsOf(ctx, 'deleteTask').map((call) => call.args[0])
const opsAlertsRaised = (ctx: Ctx) => ctx.alertJobs.enqueued.map((job) => (job.body as { kind: string }).kind)

const maskUrl = (name: string) => `https://masks.test/${name}.png?sig=abc`
/** A finished analysis for the `glow` goal (hd_radiance, hd_moisture, hd_texture), plus a concern the goal does not show, with a mask on the whole-face item of each. */
const analysed = (over: Partial<Extract<SkinAnalysisResult, { status: 'success' }>> = {}): SkinAnalysisResult => ({
  status: 'success',
  concerns: [
    { concern: 'hd_radiance', region: 'whole', rawScore: 41.5, uiScore: 52, maskUrls: [maskUrl('radiance')] },
    { concern: 'hd_radiance', region: 'left_cheek', rawScore: 38, uiScore: 47, maskUrls: [] },
    { concern: 'hd_moisture', region: 'whole', rawScore: 62, uiScore: 70, maskUrls: [maskUrl('moisture')] },
    { concern: 'hd_texture', region: 'whole', rawScore: 55, uiScore: 63, maskUrls: [] },
    { concern: 'hd_acne', region: 'whole', rawScore: 80, uiScore: 85, maskUrls: [maskUrl('acne')] },
  ],
  skinTypes: [
    { region: 'whole', skinType: 'Dry' },
    { region: 't_zone', skinType: 'Oily' },
  ],
  skinAge: 31,
  all: 70,
  skipped: [],
  ...over,
})
const byConcernThenRegion = (a: { concern: string; region: string }, b: { concern: string; region: string }) => a.concern.localeCompare(b.concern) || a.region.localeCompare(b.region)

/** A scan whose upload step has run: its tasks exist at Perfect Corp. */
const uploaded = async (ctx: Ctx, goal: Goal = 'glow'): Promise<{ id: string; analysisTask: string; fitzpatrickTask: string | null }> => {
  const id = await started(ctx, goal)
  await upload(ctx, id)
  const row = await rowOf(ctx, id)
  return { id, analysisTask: row.pcAnalysisTaskId!, fitzpatrickTask: row.pcFitzpatrickTaskId }
}
/** A scan made ready the real way: uploaded, then fetched from a finished analysis. */
const finished = async (ctx: Ctx, goal: Goal = 'glow') => {
  const scan = await uploaded(ctx, goal)
  ctx.perfectCorp.script('getSkinAnalysis', analysed())
  await fetchStep(ctx, scan.id)
  return scan
}

describe('FaceScanService.advance: the upload step', () => {
  it('sends the front photo once and starts the goal\'s measured HD concerns plus the skin type as one analysis, and a Fitzpatrick read for a profile that has none', async () => {
    const ctx = setup()
    const id = await started(ctx, 'glow')

    await upload(ctx, id)

    expect(methodsCalled(ctx)).toEqual(['uploadFile', 'createSkinAnalysis', 'createFitzpatrick'])
    const [bytes, options] = callsOf(ctx, 'uploadFile')[0]!.args as [Uint8Array, unknown]
    expect(Array.from(bytes)).toEqual(Array.from(face(1).bytes))
    expect(options).toEqual({ contentType: 'image/jpeg', fileName: 'front.jpg' })
    expect(callsOf(ctx, 'createSkinAnalysis')[0]!.args).toEqual([{ fileId: 'file-1', actions: ['hd_radiance', 'hd_moisture', 'hd_texture', 'hd_age_spot', 'hd_acne', 'hd_pore', 'hd_oiliness', 'hd_skin_type'] }])
    expect(callsOf(ctx, 'createFitzpatrick')[0]!.args).toEqual([{ fileId: 'file-1' }])
  })

  it('asks for the concerns of the goal the scan was taken under, not a fixed list', async () => {
    const ctx = setup()
    const id = await started(ctx, 'clear-skin')

    await upload(ctx, id)

    expect(callsOf(ctx, 'createSkinAnalysis')[0]!.args).toEqual([{ fileId: 'file-1', actions: ['hd_acne', 'hd_pore', 'hd_oiliness', 'hd_age_spot', 'hd_skin_type'] }])
  })

  // One goal per action count (5, 6, 7, 8): the goal's own three, then the core concerns it lacks, then the skin type.
  it.each([
    ['clear-skin', ['hd_acne', 'hd_pore', 'hd_oiliness', 'hd_age_spot', 'hd_skin_type']],
    ['fade-dark-marks', ['hd_age_spot', 'hd_acne', 'hd_texture', 'hd_pore', 'hd_oiliness', 'hd_skin_type']],
    ['even-tone', ['hd_age_spot', 'hd_redness', 'hd_radiance', 'hd_acne', 'hd_pore', 'hd_oiliness', 'hd_skin_type']],
    ['calm-repair', ['hd_redness', 'hd_moisture', 'hd_texture', 'hd_age_spot', 'hd_acne', 'hd_pore', 'hd_oiliness', 'hd_skin_type']],
  ] as const)('asks for exactly the measured actions of %s, with the skin type last', async (goal, actions) => {
    const ctx = setup()
    const id = await started(ctx, goal)

    await upload(ctx, id)

    expect(callsOf(ctx, 'createSkinAnalysis')[0]!.args).toEqual([{ fileId: 'file-1', actions }])
  })

  it('stores both task ids and the environment at once, leaves the scan analysing and queues nothing', async () => {
    const ctx = setup()
    const id = await started(ctx)
    clearQueue(ctx)

    await upload(ctx, id)

    expect(await rowOf(ctx, id)).toMatchObject({ state: 'analysing', reason: null, pcAnalysisTaskId: 'skin-task-1', pcFitzpatrickTaskId: 'fitzpatrick-task-2', pcEnvironment: 'test' })
    expect(ctx.jobs.enqueued).toEqual([])
  })

  it('tells the stream the scan is analysing, and does not say done', async () => {
    const ctx = setup()
    const id = await started(ctx)

    await upload(ctx, id)

    expect(ctx.events.eventsFor(id)).toEqual([{ type: 'face', faceScan: { id, state: 'analysing', reason: null } }])
  })

  it('records no spend: Perfect Corp charges only when a result comes back', async () => {
    const ctx = setup()
    const id = await started(ctx)

    await upload(ctx, id)

    expect(ctx.aiUsage.recorded).toEqual([])
  })

  it('does not read the Fitzpatrick type again for a profile that already has one, from an earlier scan', async () => {
    const ctx = setup()
    const first = await uploaded(ctx, 'glow')
    ctx.perfectCorp.script('getFitzpatrick', { status: 'success', fitzpatrick: 'V' })
    await fitzpatrickStep(ctx, first.id)
    ctx.advanceClock(SCAN_SPACING)
    await setGoal(ctx, 'brighter')
    const second = (await asUser(() => ctx.service.create({ front: face(2) }))).id
    const before = callsOf(ctx, 'createFitzpatrick').length

    await upload(ctx, second)

    expect(before).toBe(1)
    expect(callsOf(ctx, 'createFitzpatrick')).toHaveLength(1)
    expect(callsOf(ctx, 'createSkinAnalysis')).toHaveLength(2)
    expect((await rowOf(ctx, second)).pcFitzpatrickTaskId).toBeNull()
  })

  it('does nothing and pays for nothing when it runs again on a scan that already has its analysis task (a message taken over after the lease)', async () => {
    const ctx = setup()
    const id = await started(ctx)
    await upload(ctx, id)
    const callsBefore = ctx.perfectCorp.calls.length
    const taskBefore = (await rowOf(ctx, id)).pcAnalysisTaskId

    await upload(ctx, id)

    expect(ctx.perfectCorp.calls).toHaveLength(callsBefore)
    expect((await rowOf(ctx, id)).pcAnalysisTaskId).toBe(taskBefore)
  })

  it('makes no call for a scan that was deleted since the message was queued', async () => {
    const ctx = setup()
    const id = await started(ctx)
    await asUser(() => ctx.service.deleteFaceScan(id))

    await expect(upload(ctx, id)).resolves.toBeUndefined()

    expect(ctx.perfectCorp.calls).toEqual([])
    expect(ctx.events.published).toEqual([])
  })

  it('makes no call for a scan that is no longer analysing, and leaves it as it is', async () => {
    const ctx = setup()
    const id = await started(ctx)
    await asSystem(() => ctx.service.markFailed(id))

    await upload(ctx, id)

    expect(ctx.perfectCorp.calls).toEqual([])
    expect(await rowOf(ctx, id)).toMatchObject({ state: 'failed', reason: 'unavailable' })
  })

  it('fails the scan as consent-withdrawn, with no call to Perfect Corp, when the consent was withdrawn after the photo was taken', async () => {
    const ctx = setup()
    const id = await started(ctx)
    await asUser(() => ctx.service.withdrawConsent())

    await upload(ctx, id)

    expect(ctx.perfectCorp.calls).toEqual([])
    expect(await rowOf(ctx, id)).toMatchObject({ state: 'failed', reason: 'consent-withdrawn' })
    expect(ctx.events.eventsFor(id)).toEqual([{ type: 'face', faceScan: { id, state: 'failed', reason: 'consent-withdrawn' } }, { type: 'done' }])
  })

  it('fails the scan as consent-withdrawn when the consent on record is for an older wording', async () => {
    const ctx = setup()
    const id = await started(ctx)
    await ctx.repository.giveConsent({ profileId: PROFILE, userId: USER, version: CURRENT_FACE_CONSENT_VERSION - 1, at: T0 })

    await upload(ctx, id)

    expect(ctx.perfectCorp.calls).toEqual([])
    expect(await rowOf(ctx, id)).toMatchObject({ state: 'failed', reason: 'consent-withdrawn' })
  })

  it('fails the scan as unavailable, with no call to Perfect Corp, when the front photo is gone from the bucket', async () => {
    const ctx = setup()
    const id = await started(ctx)
    await ctx.photos.delete(frontKey(ctx, id))

    await upload(ctx, id)

    expect(ctx.perfectCorp.calls).toEqual([])
    expect(await rowOf(ctx, id)).toMatchObject({ state: 'failed', reason: 'unavailable' })
    expect(ctx.events.eventsFor(id)).toEqual([{ type: 'face', faceScan: { id, state: 'failed', reason: 'unavailable' } }, { type: 'done' }])
  })

  it.each([
    ['upload', 'uploadFile', 'image-size'],
    ['task creation', 'createSkinAnalysis', 'no-face'],
  ] as const)('sends the scan to needs-retake with the vendor\'s reason when the photo is refused at %s, records no spend and tells the stream', async (_where, method, reason) => {
    const ctx = setup()
    const id = await started(ctx)
    ctx.perfectCorp.script(method, new PerfectCorpRejectedPhotoError(reason))

    await expect(upload(ctx, id)).resolves.toBeUndefined()

    expect(await rowOf(ctx, id)).toMatchObject({ state: 'needs-retake', reason })
    expect(ctx.aiUsage.recorded).toEqual([])
    expect(ctx.events.eventsFor(id)).toEqual([{ type: 'face', faceScan: { id, state: 'needs-retake', reason } }, { type: 'done' }])
  })

  it('throws, so the queue tries again, and leaves the scan analysing when Perfect Corp is unavailable', async () => {
    const ctx = setup()
    const id = await started(ctx)
    ctx.perfectCorp.script('uploadFile', new PerfectCorpUnavailableError('down'))

    const error = await errorOf(upload(ctx, id))

    expect(error).toBeInstanceOf(PerfectCorpUnavailableError)
    expect(await rowOf(ctx, id)).toMatchObject({ state: 'analysing', reason: null })
    expect(ctx.events.eventsFor(id)).toEqual([])
  })

  it('fails the scan as unavailable, raises the ops alert for an account that cannot pay and ends the message as permanent when Perfect Corp has no credit', async () => {
    const ctx = setup()
    const id = await started(ctx)
    ctx.perfectCorp.script('createSkinAnalysis', new PerfectCorpCreditError('no units'))

    const error = await errorOf(upload(ctx, id))

    expect(error).toBeInstanceOf(PermanentJobError)
    expect(await rowOf(ctx, id)).toMatchObject({ state: 'failed', reason: 'unavailable' })
    expect(opsAlertsRaised(ctx)).toEqual(['face-scan-account'])
    expect(ctx.events.eventsFor(id)).toEqual([{ type: 'face', faceScan: { id, state: 'failed', reason: 'unavailable' } }, { type: 'done' }])
  })

  it('fails the scan as unavailable and ends the message as permanent when Perfect Corp calls the request bad, without an ops alert', async () => {
    const ctx = setup()
    const id = await started(ctx)
    ctx.perfectCorp.script('uploadFile', new PerfectCorpBadRequestError('bad key'))

    const error = await errorOf(upload(ctx, id))

    expect(error).toBeInstanceOf(PermanentJobError)
    expect(await rowOf(ctx, id)).toMatchObject({ state: 'failed', reason: 'unavailable' })
    expect(opsAlertsRaised(ctx)).toEqual([])
  })

  it('still analyses the face when the Fitzpatrick task cannot be created: the scan has its analysis task, stays analysing, and only the error\'s name is logged', async () => {
    const ctx = setup()
    const id = await started(ctx)
    ctx.perfectCorp.script('createFitzpatrick', new PerfectCorpUnavailableError('vendor said SECRET-VENDOR-TEXT-4821'))

    const logged = await loggedDuring(() => upload(ctx, id))

    expect(await rowOf(ctx, id)).toMatchObject({ state: 'analysing', pcAnalysisTaskId: 'skin-task-1', pcFitzpatrickTaskId: null })
    expect(logged).toContain('PerfectCorpUnavailableError')
    expect(logged).not.toContain('SECRET-VENDOR-TEXT-4821')
    expect(ctx.events.eventsFor(id)).toEqual([{ type: 'face', faceScan: { id, state: 'analysing', reason: null } }])
  })

  it('keeps the task of the upload that stored first and deletes the task of the one that lost, when two uploads of one scan run at once', async () => {
    const ctx = setup()
    const id = await started(ctx)
    // The outer upload has its task (skin-task-1) when a whole second upload runs and stores skin-task-2.
    ctx.perfectCorp.duringCreateSkinAnalysis = () => upload(ctx, id)

    await upload(ctx, id)

    expect(await rowOf(ctx, id)).toMatchObject({ pcAnalysisTaskId: 'skin-task-2', state: 'analysing' })
    expect(deletedTasks(ctx)).toEqual(['skin-task-1'])
    expect(callsOf(ctx, 'createFitzpatrick')).toHaveLength(1)
  })

  it('raises the ops alert too when Perfect Corp has no credit for the Fitzpatrick read, and still analyses the face', async () => {
    const ctx = setup()
    const id = await started(ctx)
    ctx.perfectCorp.script('createFitzpatrick', new PerfectCorpCreditError('no units'))

    await loggedDuring(() => upload(ctx, id))

    expect(opsAlertsRaised(ctx)).toEqual(['face-scan-account'])
    expect(await rowOf(ctx, id)).toMatchObject({ state: 'analysing', pcAnalysisTaskId: 'skin-task-1', pcFitzpatrickTaskId: null })
  })

  it('raises no ops alert for a Fitzpatrick read that fails for any other reason', async () => {
    const ctx = setup()
    const id = await started(ctx)
    ctx.perfectCorp.script('createFitzpatrick', new PerfectCorpUnavailableError('down'))

    await loggedDuring(() => upload(ctx, id))

    expect(opsAlertsRaised(ctx)).toEqual([])
  })

  it('does not fail the upload when the stream is down: the change is stored and the publish is best effort', async () => {
    const ctx = setup({ events: new EventsThatFail() })
    const id = await started(ctx)

    const logged = await loggedDuring(() => upload(ctx, id))

    expect(await rowOf(ctx, id)).toMatchObject({ state: 'analysing', pcAnalysisTaskId: 'skin-task-1' })
    expect(logged).toContain('publish-failed')
  })
})

describe('FaceScanService.advance: the fetch step', () => {
  it('copies a finished analysis: the scan is ready with its skin type and skin age, and every concern item, region and the overall score are stored', async () => {
    const ctx = setup()
    const { id } = await uploaded(ctx)
    ctx.perfectCorp.script('getSkinAnalysis', analysed())

    await fetchStep(ctx, id)

    expect(await rowOf(ctx, id)).toMatchObject({ state: 'ready', reason: null, skinType: 'dry', skinAge: 31 })
    expect((await rowOf(ctx, id)).tablesVersion).toEqual(expect.any(String))
    expect((await rowOf(ctx, id)).tablesVersion).not.toBe('')
    const rows = (await ctx.repository.resultsOf(id)).sort(byConcernThenRegion)
    expect(rows).toEqual(
      [
        { faceScanId: id, userId: USER, concern: 'all', region: 'whole', rawScore: 70, uiScore: 70 },
        { faceScanId: id, userId: USER, concern: 'hd_acne', region: 'whole', rawScore: 80, uiScore: 85 },
        { faceScanId: id, userId: USER, concern: 'hd_moisture', region: 'whole', rawScore: 62, uiScore: 70 },
        { faceScanId: id, userId: USER, concern: 'hd_radiance', region: 'left_cheek', rawScore: 38, uiScore: 47 },
        { faceScanId: id, userId: USER, concern: 'hd_radiance', region: 'whole', rawScore: 41.5, uiScore: 52 },
        { faceScanId: id, userId: USER, concern: 'hd_texture', region: 'whole', rawScore: 55, uiScore: 63 },
      ].sort(byConcernThenRegion),
    )
  })

  it('downloads the mask of each measured concern that has one, stores each as a PNG under its mask key with the bytes it got, and records the keys', async () => {
    const ctx = setup()
    const { id } = await uploaded(ctx)
    ctx.perfectCorp.script('getSkinAnalysis', analysed())

    await fetchStep(ctx, id)

    // hd_acne is a core concern, measured for glow too; hd_texture has no mask.
    expect(callsOf(ctx, 'downloadMask').map((call) => call.args[0]).sort()).toEqual([maskUrl('acne'), maskUrl('moisture'), maskUrl('radiance')])
    expect(masksStored(ctx)).toEqual([maskKey(ctx, id, 'hd-acne'), maskKey(ctx, id, 'hd-moisture'), maskKey(ctx, id, 'hd-radiance')])
    const radiance = ctx.photos.stored.get(maskKey(ctx, id, 'hd-radiance'))!
    expect(radiance.mediaType).toBe('image/png')
    expect(new TextDecoder().decode(radiance.bytes)).toBe(maskUrl('radiance'))
    expect(new TextDecoder().decode(ctx.photos.stored.get(maskKey(ctx, id, 'hd-moisture'))!.bytes)).toBe(maskUrl('moisture'))
    expect((await ctx.repository.masksOf(id)).sort((a, b) => a.concern.localeCompare(b.concern))).toEqual([
      { faceScanId: id, userId: USER, concern: 'hd_acne', maskKey: maskKey(ctx, id, 'hd-acne') },
      { faceScanId: id, userId: USER, concern: 'hd_moisture', maskKey: maskKey(ctx, id, 'hd-moisture') },
      { faceScanId: id, userId: USER, concern: 'hd_radiance', maskKey: maskKey(ctx, id, 'hd-radiance') },
    ])
  })

  it.each([...GOALS])('records the spend of a %s scan as 16 units, whatever its action count (5 to 8)', async (goal) => {
    const ctx = setup()
    const { id, analysisTask } = await uploaded(ctx, goal)
    ctx.perfectCorp.script('getSkinAnalysis', analysed())

    await fetchStep(ctx, id)

    expect(ctx.aiUsage.recorded).toEqual([{ vendor: 'perfect-corp', job: 'face-analysis', units: 16, key: analysisTask }])
  })

  it('stores the results and downloads and stores the mask of every measured concern, the core extras too, not only the goal\'s three', async () => {
    const ctx = setup()
    const { id } = await uploaded(ctx, 'glow')
    ctx.perfectCorp.script('getSkinAnalysis', analysisOf({ ...glowScores(65, 32, 35), ...coreScores(84, 58, 70, 70) }))

    await fetchStep(ctx, id)

    expect(await rowOf(ctx, id)).toMatchObject({ state: 'ready' })
    expect((await ctx.repository.resultsOf(id)).map((row) => row.concern).sort()).toEqual(['all', 'hd_acne', 'hd_age_spot', 'hd_moisture', 'hd_oiliness', 'hd_pore', 'hd_radiance', 'hd_texture'])
    expect(callsOf(ctx, 'downloadMask').map((call) => call.args[0]).sort()).toEqual(['acne', 'age_spot', 'moisture', 'oiliness', 'pore', 'radiance', 'texture'].map(maskUrl))
    expect(masksStored(ctx)).toEqual(['hd-acne', 'hd-age-spot', 'hd-moisture', 'hd-oiliness', 'hd-pore', 'hd-radiance', 'hd-texture'].map((slug) => maskKey(ctx, id, slug)))
    expect((await ctx.repository.masksOf(id)).map((mask) => mask.concern).sort()).toEqual(['hd_acne', 'hd_age_spot', 'hd_moisture', 'hd_oiliness', 'hd_pore', 'hd_radiance', 'hd_texture'])
  })

  it('stores no mask for a concern that is not measured for the goal, even when Perfect Corp sent one', async () => {
    const ctx = setup()
    const { id } = await uploaded(ctx, 'clear-skin')
    ctx.perfectCorp.script('getSkinAnalysis', analysisOf({ hd_acne: 50, hd_age_spot: 80, hd_radiance: 50, hd_redness: 50 }))

    await fetchStep(ctx, id)

    expect(masksStored(ctx)).toEqual([maskKey(ctx, id, 'hd-acne'), maskKey(ctx, id, 'hd-age-spot')])
  })

  it('keeps the front photo and the masks listed for the scan, so deleting the scan empties the bucket', async () => {
    const ctx = setup()
    const { id } = await finished(ctx)

    await asUser(() => ctx.service.deleteFaceScan(id))

    expect(ctx.photos.stored.size).toBe(0)
  })

  it('records the spend once: face-analysis, 16 units for the 8 actions, keyed by the analysis task id', async () => {
    const ctx = setup()
    const { id, analysisTask } = await uploaded(ctx)
    ctx.perfectCorp.script('getSkinAnalysis', analysed())

    await fetchStep(ctx, id)

    expect(ctx.aiUsage.recorded).toEqual([{ vendor: 'perfect-corp', job: 'face-analysis', units: 16, key: analysisTask }])
  })

  it('deletes the vendor\'s copy of the task once the results are ours', async () => {
    const ctx = setup()
    const { id, analysisTask } = await uploaded(ctx)
    ctx.perfectCorp.script('getSkinAnalysis', analysed())

    await fetchStep(ctx, id)

    expect(callsOf(ctx, 'deleteTask').map((call) => call.args[0])).toEqual([analysisTask])
  })

  it('records the spend as soon as Perfect Corp reports success: before a mask is downloaded and before the results are stored', async () => {
    const ctx = setup()
    const { id, analysisTask } = await uploaded(ctx)
    ctx.perfectCorp.script('getSkinAnalysis', analysed())
    let spendWhenDownloading: unknown[] = []
    let stateWhenDownloading = ''
    ctx.perfectCorp.duringDownload = async () => {
      spendWhenDownloading = [...ctx.aiUsage.recorded]
      stateWhenDownloading = (await rowOf(ctx, id)).state
    }

    await fetchStep(ctx, id)

    expect(spendWhenDownloading).toEqual([{ vendor: 'perfect-corp', job: 'face-analysis', units: 16, key: analysisTask }])
    expect(stateWhenDownloading).toBe('analysing')
  })

  it('is still ready when the spend cannot be recorded; the failure is logged by name with the task id, and nothing is thrown', async () => {
    const ctx = setup()
    const { id, analysisTask } = await uploaded(ctx)
    ctx.perfectCorp.script('getSkinAnalysis', analysed())
    ctx.aiUsage.failNextWith(new Error('ledger is down SECRET-LEDGER-TEXT-3306'))

    const logged = await loggedDuring(() => fetchStep(ctx, id))

    expect((await rowOf(ctx, id)).state).toBe('ready')
    expect(logged).toContain('spend-record-failed')
    expect(logged).toContain(analysisTask)
    expect(logged).not.toContain('SECRET-LEDGER-TEXT-3306')
  })

  it('queues the Fitzpatrick step, stamped with now, when the scan has a Fitzpatrick task and the profile still has no type: the backstop for a lost webhook', async () => {
    const ctx = setup()
    const { id, fitzpatrickTask } = await uploaded(ctx)
    expect(fitzpatrickTask).not.toBeNull()
    clearQueue(ctx)
    ctx.advanceClock(2 * MINUTE)
    ctx.perfectCorp.script('getSkinAnalysis', analysed())

    await fetchStep(ctx, id)

    expect(queuedSteps(ctx)).toEqual([{ faceScanId: id, step: 'fitzpatrick', at: ctx.now().getTime() }])
  })

  it('queues no Fitzpatrick step when the profile already has a type', async () => {
    const ctx = setup()
    const { id } = await uploaded(ctx)
    await ctx.repository.saveFitzpatrick({ profileId: PROFILE, userId: USER, fitzpatrick: 'V', taskId: 'earlier-task', createdAt: T0 })
    ctx.perfectCorp.script('getSkinAnalysis', analysed())
    clearQueue(ctx)

    await fetchStep(ctx, id)

    expect(queuedSteps(ctx)).toEqual([])
  })

  it('queues no Fitzpatrick step when the scan has no Fitzpatrick task', async () => {
    const ctx = setup()
    const { id } = await uploaded(ctx)
    await ctx.repository.updateFaceScan(id, 'analysing', { pcFitzpatrickTaskId: null, updatedAt: T0 })
    ctx.perfectCorp.script('getSkinAnalysis', analysed())
    clearQueue(ctx)

    await fetchStep(ctx, id)

    expect(queuedSteps(ctx)).toEqual([])
  })

  it('is still ready when the Fitzpatrick step cannot be queued', async () => {
    const ctx = setup()
    const { id } = await uploaded(ctx)
    ctx.perfectCorp.script('getSkinAnalysis', analysed())
    ctx.jobs.failNextWith(new Error('queue is down'))

    await loggedDuring(() => fetchStep(ctx, id))

    expect((await rowOf(ctx, id)).state).toBe('ready')
  })

  it('tells the stream the scan is ready and then that it is done', async () => {
    const ctx = setup()
    const { id } = await uploaded(ctx)
    ctx.perfectCorp.script('getSkinAnalysis', analysed())

    await fetchStep(ctx, id)

    expect(ctx.events.eventsFor(id)).toEqual([
      { type: 'face', faceScan: { id, state: 'analysing', reason: null } },
      { type: 'face', faceScan: { id, state: 'ready', reason: null } },
      { type: 'done' },
    ])
  })

  it('changes nothing, records nothing and deletes nothing while the task is still running', async () => {
    const ctx = setup()
    const { id, analysisTask } = await uploaded(ctx)
    const before = await rowOf(ctx, id)
    const framesBefore = ctx.events.published.length

    await fetchStep(ctx, id)

    expect(callsOf(ctx, 'getSkinAnalysis').map((call) => call.args[0])).toEqual([analysisTask])
    expect(await rowOf(ctx, id)).toEqual(before)
    expect(await ctx.repository.resultsOf(id)).toEqual([])
    expect(ctx.aiUsage.recorded).toEqual([])
    expect(callsOf(ctx, 'deleteTask')).toEqual([])
    expect(ctx.events.published).toHaveLength(framesBefore)
  })

  it('is ready, with the spend recorded, even when the vendor\'s copy cannot be deleted; only the error\'s name is logged and nothing is thrown', async () => {
    const ctx = setup()
    const { id } = await uploaded(ctx)
    ctx.perfectCorp.script('getSkinAnalysis', analysed())
    ctx.perfectCorp.script('deleteTask', new PerfectCorpUnavailableError('vendor said SECRET-VENDOR-TEXT-9917'))

    const logged = await loggedDuring(() => fetchStep(ctx, id))

    expect((await rowOf(ctx, id)).state).toBe('ready')
    expect(ctx.aiUsage.recorded).toHaveLength(1)
    expect(ctx.events.eventsFor(id).at(-1)).toEqual({ type: 'done' })
    expect(logged).toContain('PerfectCorpUnavailableError')
    expect(logged).not.toContain('SECRET-VENDOR-TEXT-9917')
  })

  it('leaves no mask in the bucket and no results, but still records the spend, when the user deleted the scan while the masks were being fetched', async () => {
    const ctx = setup()
    const { id, analysisTask } = await uploaded(ctx)
    ctx.perfectCorp.script('getSkinAnalysis', analysed())
    ctx.perfectCorp.duringDownload = () => asUser(() => ctx.service.deleteFaceScan(id))

    await expect(fetchStep(ctx, id)).resolves.toBeUndefined()

    expect(ctx.photos.stored.size).toBe(0)
    expect(await ctx.repository.findFaceScan(id)).toBeNull()
    expect(await ctx.repository.resultsOf(id)).toEqual([])
    expect(await ctx.repository.masksOf(id)).toEqual([])
    // Perfect Corp charged for the task when it succeeded, whatever became of our copy.
    expect(ctx.aiUsage.recorded).toEqual([{ vendor: 'perfect-corp', job: 'face-analysis', units: 16, key: analysisTask }])
  })

  it('leaves no mask in the bucket, and the scan as it moved to, but still records the spend, when the scan stopped being analysing while the masks were being fetched', async () => {
    const ctx = setup()
    const { id, analysisTask } = await uploaded(ctx)
    ctx.perfectCorp.script('getSkinAnalysis', analysed())
    ctx.perfectCorp.duringDownload = () => ctx.service.markFailed(id)

    await expect(fetchStep(ctx, id)).resolves.toBeUndefined()

    expect(masksStored(ctx)).toEqual([])
    expect(ctx.photos.stored.has(frontKey(ctx, id))).toBe(true)
    expect(await rowOf(ctx, id)).toMatchObject({ state: 'failed', reason: 'unavailable', skinAge: null })
    expect(await ctx.repository.resultsOf(id)).toEqual([])
    expect(ctx.aiUsage.recorded).toEqual([{ vendor: 'perfect-corp', job: 'face-analysis', units: 16, key: analysisTask }])
  })

  it('stores the age-spot result of a fade-dark-marks scan, and its mask, like the other concerns, when Perfect Corp sent it without a region (read as the whole face)', async () => {
    const ctx = setup()
    const { id } = await uploaded(ctx, 'fade-dark-marks')
    ctx.perfectCorp.script(
      'getSkinAnalysis',
      analysed({
        concerns: [
          { concern: 'hd_age_spot', region: 'whole', rawScore: 57.33, uiScore: 68, maskUrls: [maskUrl('age_spot')] },
          { concern: 'hd_acne', region: 'whole', rawScore: 80, uiScore: 85, maskUrls: [maskUrl('acne')] },
          { concern: 'hd_texture', region: 'whole', rawScore: 55, uiScore: 63, maskUrls: [] },
        ],
      }),
    )

    const warnings = await warningsDuring(() => fetchStep(ctx, id))

    expect(await rowOf(ctx, id)).toMatchObject({ state: 'ready', reason: null })
    expect((await ctx.repository.resultsOf(id)).filter((row) => row.concern === 'hd_age_spot')).toEqual([
      { faceScanId: id, userId: USER, concern: 'hd_age_spot', region: 'whole', rawScore: 57.33, uiScore: 68 },
    ])
    expect(callsOf(ctx, 'downloadMask').map((call) => call.args[0]).sort()).toEqual([maskUrl('acne'), maskUrl('age_spot')])
    expect(masksStored(ctx)).toEqual([maskKey(ctx, id, 'hd-acne'), maskKey(ctx, id, 'hd-age-spot')])
    expect(new TextDecoder().decode(ctx.photos.stored.get(maskKey(ctx, id, 'hd-age-spot'))!.bytes)).toBe(maskUrl('age_spot'))
    expect((await ctx.repository.masksOf(id)).map((mask) => mask.concern).sort()).toEqual(['hd_acne', 'hd_age_spot'])
    expect(warnings).toEqual([])
  })

  it('warns once, by name, when a goal concern is missing from the result, with the names that did come back and what the adapter skipped, and still makes the scan ready with the concerns it has', async () => {
    const ctx = setup()
    const { id } = await uploaded(ctx, 'fade-dark-marks')
    ctx.perfectCorp.script(
      'getSkinAnalysis',
      analysed({
        concerns: [
          { concern: 'hd_texture', region: 'whole', rawScore: 55, uiScore: 63, maskUrls: [] },
          { concern: 'hd_acne', region: 'left_cheek', rawScore: 70, uiScore: 75, maskUrls: [] },
          { concern: 'hd_acne', region: 'whole', rawScore: 80, uiScore: 85, maskUrls: [maskUrl('acne')] },
        ],
        skipped: [{ type: 'hd_redness', problem: 'no-scores' }],
      }),
    )

    const warnings = await warningsDuring(() => fetchStep(ctx, id))

    expect(warnings).toEqual([
      { outcome: 'face-scan-concern-missing', faceScanId: id, concern: 'hd_age_spot', returned: ['hd_acne', 'hd_texture'], skipped: [{ type: 'hd_redness', problem: 'no-scores' }] },
    ])
    expect(await rowOf(ctx, id)).toMatchObject({ state: 'ready', reason: null, skinType: 'dry', skinAge: 31 })
    expect((await ctx.repository.resultsOf(id)).map((row) => `${row.concern}/${row.region}`).sort()).toEqual(['all/whole', 'hd_acne/left_cheek', 'hd_acne/whole', 'hd_texture/whole'])
    expect(masksStored(ctx)).toEqual([maskKey(ctx, id, 'hd-acne')])
    expect(ctx.events.eventsFor(id).at(-1)).toEqual({ type: 'done' })
  })

  it('warns once for each missing goal concern, in the goal\'s order, each carrying the same distinct sorted names that came back', async () => {
    const ctx = setup()
    const { id } = await uploaded(ctx, 'glow')
    ctx.perfectCorp.script(
      'getSkinAnalysis',
      analysed({
        concerns: [
          { concern: 'hd_radiance', region: 'whole', rawScore: 41.5, uiScore: 52, maskUrls: [] },
          { concern: 'hd_radiance', region: 'left_cheek', rawScore: 38, uiScore: 47, maskUrls: [] },
          // Not a glow concern: it is returned, so it is named in `returned`, but it does not make a glow concern present.
          { concern: 'hd_acne', region: 'whole', rawScore: 80, uiScore: 85, maskUrls: [] },
        ],
      }),
    )

    const warnings = await warningsDuring(() => fetchStep(ctx, id))

    const returned = ['hd_acne', 'hd_radiance']
    expect(warnings).toEqual([
      { outcome: 'face-scan-concern-missing', faceScanId: id, concern: 'hd_moisture', returned, skipped: [] },
      { outcome: 'face-scan-concern-missing', faceScanId: id, concern: 'hd_texture', returned, skipped: [] },
    ])
    expect((await rowOf(ctx, id)).state).toBe('ready')
  })

  it('warns for every goal concern, with an empty list of what came back, when the result has no concern items at all', async () => {
    const ctx = setup()
    const { id } = await uploaded(ctx, 'clear-skin')
    ctx.perfectCorp.script('getSkinAnalysis', analysed({ concerns: [] }))

    const warnings = await warningsDuring(() => fetchStep(ctx, id))

    expect(warnings.map((warning) => (warning as { concern: string }).concern)).toEqual(['hd_acne', 'hd_pore', 'hd_oiliness'])
    for (const warning of warnings) expect(warning).toMatchObject({ outcome: 'face-scan-concern-missing', faceScanId: id, returned: [], skipped: [] })
    expect((await rowOf(ctx, id)).state).toBe('ready')
  })

  it('does not warn when every concern of the goal is in the result', async () => {
    const ctx = setup()
    const { id } = await uploaded(ctx, 'glow')
    ctx.perfectCorp.script('getSkinAnalysis', analysed())

    const warnings = await warningsDuring(() => fetchStep(ctx, id))

    expect(warnings).toEqual([])
    expect((await rowOf(ctx, id)).state).toBe('ready')
  })

  it('logs nothing about the photo, the scores or the mask links when it warns about a missing concern', async () => {
    const ctx = setup()
    const { id } = await uploaded(ctx, 'glow')
    ctx.perfectCorp.script('getSkinAnalysis', analysed({ concerns: [{ concern: 'hd_radiance', region: 'whole', rawScore: 41.5, uiScore: 52, maskUrls: [maskUrl('radiance')] }] }))

    const logged = await loggedDuring(() => fetchStep(ctx, id))

    expect(logged).toContain('face-scan-concern-missing')
    expect(logged).not.toContain('masks.test')
    expect(logged).not.toContain('41.5')
    expect(logged).not.toContain('front.jpg')
  })

  it('does not warn about a missing concern when the scan was deleted while the masks were being fetched, because nothing was stored', async () => {
    const ctx = setup()
    const { id } = await uploaded(ctx, 'glow')
    ctx.perfectCorp.script('getSkinAnalysis', analysed({ concerns: [{ concern: 'hd_radiance', region: 'whole', rawScore: 41.5, uiScore: 52, maskUrls: [maskUrl('radiance')] }] }))
    ctx.perfectCorp.duringDownload = () => asUser(() => ctx.service.deleteFaceScan(id))

    const warnings = await warningsDuring(() => fetchStep(ctx, id))

    expect(await ctx.repository.findFaceScan(id)).toBeNull()
    expect(warnings).toEqual([])
  })

  it('does not warn about a missing concern when the scan stopped being analysing while the masks were being fetched, because nothing was stored', async () => {
    const ctx = setup()
    const { id } = await uploaded(ctx, 'glow')
    ctx.perfectCorp.script('getSkinAnalysis', analysed({ concerns: [{ concern: 'hd_radiance', region: 'whole', rawScore: 41.5, uiScore: 52, maskUrls: [maskUrl('radiance')] }] }))
    ctx.perfectCorp.duringDownload = () => ctx.service.markFailed(id)

    const warnings = await warningsDuring(() => fetchStep(ctx, id))

    expect(await rowOf(ctx, id)).toMatchObject({ state: 'failed' })
    expect(await ctx.repository.resultsOf(id)).toEqual([])
    expect(warnings).toEqual([])
  })

  it('does nothing when it runs again on a scan that is already ready: no call to Perfect Corp, no second spend, no second stream event', async () => {
    const ctx = setup()
    const { id } = await finished(ctx)
    const callsBefore = ctx.perfectCorp.calls.length
    const framesBefore = ctx.events.published.length

    await fetchStep(ctx, id, 'wh-late-duplicate')

    expect(ctx.perfectCorp.calls).toHaveLength(callsBefore)
    expect(ctx.aiUsage.recorded).toHaveLength(1)
    expect(ctx.events.published).toHaveLength(framesBefore)
    expect((await rowOf(ctx, id)).state).toBe('ready')
  })

  it('does nothing for a scan that has no analysis task yet, or that does not exist', async () => {
    const ctx = setup()
    const id = await started(ctx)

    await fetchStep(ctx, id)
    await fetchStep(ctx, 'no-such-scan')

    expect(ctx.perfectCorp.calls).toEqual([])
    expect((await rowOf(ctx, id)).state).toBe('analysing')
  })

  it.each(['too-dark', 'turn-to-camera', 'move-closer', 'face-not-centred', 'no-face', 'image-size'] as const)(
    'sends the scan to needs-retake with reason %s when the finished task says the photo was refused, records no spend and tells the stream',
    async (reason) => {
      const ctx = setup()
      const { id } = await uploaded(ctx)
      ctx.perfectCorp.script('getSkinAnalysis', new PerfectCorpRejectedPhotoError(reason))

      await fetchStep(ctx, id, 'wh-error')

      expect(await rowOf(ctx, id)).toMatchObject({ state: 'needs-retake', reason })
      expect(ctx.aiUsage.recorded).toEqual([])
      expect(ctx.events.eventsFor(id).slice(-2)).toEqual([{ type: 'face', faceScan: { id, state: 'needs-retake', reason } }, { type: 'done' }])
    },
  )

  it('throws and leaves the scan analysing when Perfect Corp is unavailable, so the queue tries again', async () => {
    const ctx = setup()
    const { id } = await uploaded(ctx)
    ctx.perfectCorp.script('getSkinAnalysis', new PerfectCorpUnavailableError('down'))

    expect(await errorOf(fetchStep(ctx, id))).toBeInstanceOf(PerfectCorpUnavailableError)

    expect((await rowOf(ctx, id)).state).toBe('analysing')
    expect(ctx.aiUsage.recorded).toEqual([])
  })

  it('throws and leaves the scan analysing when a mask cannot be downloaded, so the queue tries again; the spend is already recorded, once, under the task id', async () => {
    const ctx = setup()
    const { id, analysisTask } = await uploaded(ctx)
    ctx.perfectCorp.script('getSkinAnalysis', analysed())
    ctx.perfectCorp.script('downloadMask', new PerfectCorpUnavailableError('down'))

    expect(await errorOf(fetchStep(ctx, id))).toBeInstanceOf(PerfectCorpUnavailableError)

    expect((await rowOf(ctx, id)).state).toBe('analysing')
    expect(ctx.aiUsage.recorded).toEqual([{ vendor: 'perfect-corp', job: 'face-analysis', units: 16, key: analysisTask }])
    expect(await ctx.repository.resultsOf(id)).toEqual([])
  })

  it('fails the scan as unavailable, raises the ops alert and ends the message as permanent when Perfect Corp has no credit', async () => {
    const ctx = setup()
    const { id } = await uploaded(ctx)
    ctx.perfectCorp.script('getSkinAnalysis', new PerfectCorpCreditError('no units'))

    expect(await errorOf(fetchStep(ctx, id))).toBeInstanceOf(PermanentJobError)

    expect(await rowOf(ctx, id)).toMatchObject({ state: 'failed', reason: 'unavailable' })
    expect(opsAlertsRaised(ctx)).toEqual(['face-scan-account'])
    expect(ctx.events.eventsFor(id).slice(-2)).toEqual([{ type: 'face', faceScan: { id, state: 'failed', reason: 'unavailable' } }, { type: 'done' }])
  })

  it('fails the scan as unavailable and ends the message as permanent when Perfect Corp calls the request bad', async () => {
    const ctx = setup()
    const { id } = await uploaded(ctx)
    ctx.perfectCorp.script('getSkinAnalysis', new PerfectCorpBadRequestError('expired'))

    expect(await errorOf(fetchStep(ctx, id))).toBeInstanceOf(PermanentJobError)

    expect(await rowOf(ctx, id)).toMatchObject({ state: 'failed', reason: 'unavailable' })
    expect(opsAlertsRaised(ctx)).toEqual([])
  })

  it('keeps a skin type or age the vendor did not send as null, and still makes the scan ready', async () => {
    const ctx = setup()
    const { id } = await uploaded(ctx)
    ctx.perfectCorp.script('getSkinAnalysis', analysed({ skinTypes: [], skinAge: null, all: null }))

    await fetchStep(ctx, id)

    expect(await rowOf(ctx, id)).toMatchObject({ state: 'ready', skinType: null, skinAge: null })
  })

  it('is still ready when the stream is down', async () => {
    const ctx = setup({ events: new EventsThatFail() })
    const { id } = await uploaded(ctx)
    ctx.perfectCorp.script('getSkinAnalysis', analysed())

    await loggedDuring(() => fetchStep(ctx, id))

    expect((await rowOf(ctx, id)).state).toBe('ready')
    expect(ctx.aiUsage.recorded).toHaveLength(1)
  })
})

/** The lines the fetch step logged with `outcome`, across every level, with the level they were logged at. */
const loggedOutcomes = async (fn: () => Promise<unknown>, outcome: string) => {
  const spies = (['log', 'info', 'warn', 'error'] as const).map((level) => ({ level, spy: vi.spyOn(console, level).mockImplementation(() => undefined) }))
  try {
    await fn()
    return spies.flatMap(({ level, spy }) =>
      spy.mock.calls.filter(([line]) => (line as { outcome?: string } | undefined)?.outcome === outcome).map(([line]) => ({ level, line: line as Record<string, unknown> })),
    )
  } finally {
    spies.forEach(({ spy }) => spy.mockRestore())
  }
}

const PNG_MASK = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 4, 56, 0, 0, 5, 160, 8, 6, 0, 0, 0])

describe('FaceScanService.advance: what the fetch step logs about the masks and the front photo', () => {
  it('logs each mask once, with its format, size and byte count, and no address or pixel', async () => {
    const ctx = setup()
    const { id } = await uploaded(ctx)
    ctx.perfectCorp.script('getSkinAnalysis', analysed())
    ctx.perfectCorp.downloadMask = async () => PNG_MASK.slice()

    const lines = await loggedOutcomes(() => fetchStep(ctx, id), 'mask-read')

    expect(lines.map((entry) => entry.level)).toEqual(['log', 'log', 'log'])
    expect(lines.map((entry) => entry.line)).toEqual([
      { outcome: 'mask-read', faceScanId: id, concern: 'hd_radiance', format: 'png', width: 1080, height: 1440, bytes: PNG_MASK.length },
      { outcome: 'mask-read', faceScanId: id, concern: 'hd_moisture', format: 'png', width: 1080, height: 1440, bytes: PNG_MASK.length },
      { outcome: 'mask-read', faceScanId: id, concern: 'hd_acne', format: 'png', width: 1080, height: 1440, bytes: PNG_MASK.length },
    ])
  })

  it('calls a mask that is not a PNG or JPEG other, with no size', async () => {
    const ctx = setup()
    const { id } = await uploaded(ctx)
    ctx.perfectCorp.script('getSkinAnalysis', analysed())

    const lines = await loggedOutcomes(() => fetchStep(ctx, id), 'mask-read')

    // The harness answers with the text of the address, which is not an image.
    expect(lines.map((entry) => entry.line)).toEqual([
      { outcome: 'mask-read', faceScanId: id, concern: 'hd_radiance', format: 'other', width: null, height: null, bytes: maskUrl('radiance').length },
      { outcome: 'mask-read', faceScanId: id, concern: 'hd_moisture', format: 'other', width: null, height: null, bytes: maskUrl('moisture').length },
      { outcome: 'mask-read', faceScanId: id, concern: 'hd_acne', format: 'other', width: null, height: null, bytes: maskUrl('acne').length },
    ])
  })

  it('logs the front photo\'s size once per read', async () => {
    const ctx = setup()
    const { id } = await uploaded(ctx)
    ctx.perfectCorp.script('getSkinAnalysis', analysed())

    const lines = await loggedOutcomes(() => fetchStep(ctx, id), 'front-photo-read')

    expect(lines).toEqual([{ level: 'log', line: { outcome: 'front-photo-read', faceScanId: id, width: 1080, height: 1440 } }])
  })

  it('still makes the scan ready, and logs the photo with no size, when the front photo is gone from the bucket', async () => {
    const ctx = setup()
    const { id } = await uploaded(ctx)
    ctx.perfectCorp.script('getSkinAnalysis', analysed())
    await ctx.photos.delete(frontKey(ctx, id))

    const lines = await loggedOutcomes(() => fetchStep(ctx, id), 'front-photo-read')

    expect((await rowOf(ctx, id)).state).toBe('ready')
    expect(lines.map((entry) => entry.line)).toEqual([{ outcome: 'front-photo-read', faceScanId: id, width: null, height: null }])
  })

  it('still makes the scan ready when the front photo cannot be read from the bucket', async () => {
    const ctx = setup()
    const { id } = await uploaded(ctx)
    ctx.perfectCorp.script('getSkinAnalysis', analysed())
    ctx.photos.get = async () => {
      throw new Error('the bucket is down')
    }

    await loggedOutcomes(() => fetchStep(ctx, id), 'front-photo-read')

    expect((await rowOf(ctx, id)).state).toBe('ready')
  })

  it('logs no address, score or text from the vendor in any of these lines', async () => {
    const ctx = setup()
    const { id } = await uploaded(ctx)
    ctx.perfectCorp.script('getSkinAnalysis', analysed())

    const logged = await loggedDuring(() => fetchStep(ctx, id))

    expect(logged).not.toContain('masks.test')
    expect(logged).not.toContain('sig=abc')
    expect(logged).not.toContain('41.5')
  })
})

describe('FaceScanService.advance: the fitzpatrick step', () => {
  it('stores the type for the profile, records 10 units keyed by the Fitzpatrick task, and deletes the vendor\'s copy', async () => {
    const ctx = setup()
    const { id, fitzpatrickTask } = await uploaded(ctx)
    ctx.perfectCorp.script('getFitzpatrick', { status: 'success', fitzpatrick: 'V' })

    await fitzpatrickStep(ctx, id)

    expect(await ctx.repository.fitzpatrickOf(PROFILE)).toMatchObject({ profileId: PROFILE, userId: USER, fitzpatrick: 'V', taskId: fitzpatrickTask })
    expect(ctx.aiUsage.recorded).toEqual([{ vendor: 'perfect-corp', job: 'fitzpatrick', units: 10, key: fitzpatrickTask }])
    expect(callsOf(ctx, 'getFitzpatrick').map((call) => call.args[0])).toEqual([fitzpatrickTask])
    expect(callsOf(ctx, 'deleteTask').map((call) => call.args[0])).toEqual([fitzpatrickTask])
  })

  it('never changes the scan: it stays analysing, and no stream event is sent for it', async () => {
    const ctx = setup()
    const { id } = await uploaded(ctx)
    const before = await rowOf(ctx, id)
    const framesBefore = ctx.events.published.length
    ctx.perfectCorp.script('getFitzpatrick', { status: 'success', fitzpatrick: 'III' })

    await fitzpatrickStep(ctx, id)

    expect(await rowOf(ctx, id)).toEqual(before)
    expect(ctx.events.published).toHaveLength(framesBefore)
  })

  it('arrives after the scan is ready without changing it, and the type is still stored', async () => {
    const ctx = setup()
    const { id } = await finished(ctx)
    ctx.perfectCorp.script('getFitzpatrick', { status: 'success', fitzpatrick: 'VI' })

    await fitzpatrickStep(ctx, id)

    expect((await rowOf(ctx, id)).state).toBe('ready')
    expect(await ctx.repository.fitzpatrickOf(PROFILE)).toMatchObject({ fitzpatrick: 'VI' })
  })

  it('records the spend, and keeps the type it has, when the profile already had a type from another task and this task reports success: Perfect Corp charged for it all the same', async () => {
    const ctx = setup()
    const { id, fitzpatrickTask } = await uploaded(ctx)
    await ctx.repository.saveFitzpatrick({ profileId: PROFILE, userId: USER, fitzpatrick: 'V', taskId: 'earlier-task', createdAt: T0 })
    ctx.perfectCorp.script('getFitzpatrick', { status: 'success', fitzpatrick: 'II' })

    await fitzpatrickStep(ctx, id)

    expect(ctx.aiUsage.recorded).toEqual([{ vendor: 'perfect-corp', job: 'fitzpatrick', units: 10, key: fitzpatrickTask }])
    expect(await ctx.repository.fitzpatrickOf(PROFILE)).toMatchObject({ fitzpatrick: 'V', taskId: 'earlier-task' })
    expect(deletedTasks(ctx)).toEqual([fitzpatrickTask])
    expect(callsOf(ctx, 'getFitzpatrick').map((call) => call.args[0])).toEqual([fitzpatrickTask])
  })

  it('records nothing and leaves the task to come back to when the profile already had a type from another task and this one is still running', async () => {
    const ctx = setup()
    const { id } = await uploaded(ctx)
    await ctx.repository.saveFitzpatrick({ profileId: PROFILE, userId: USER, fitzpatrick: 'V', taskId: 'earlier-task', createdAt: T0 })

    await fitzpatrickStep(ctx, id)

    expect(ctx.aiUsage.recorded).toEqual([])
    expect(deletedTasks(ctx)).toEqual([])
  })

  it('still deletes the task when the spend of a task the profile did not need cannot be recorded; the failure is logged by name', async () => {
    const ctx = setup()
    const { id, fitzpatrickTask } = await uploaded(ctx)
    await ctx.repository.saveFitzpatrick({ profileId: PROFILE, userId: USER, fitzpatrick: 'V', taskId: 'earlier-task', createdAt: T0 })
    ctx.perfectCorp.script('getFitzpatrick', { status: 'success', fitzpatrick: 'II' })
    ctx.aiUsage.failNextWith(new Error('ledger is down SECRET-LEDGER-TEXT-5512'))

    const logged = await loggedDuring(() => fitzpatrickStep(ctx, id))

    expect(deletedTasks(ctx)).toEqual([fitzpatrickTask])
    expect(logged).toContain('spend-record-failed')
    expect(logged).not.toContain('SECRET-LEDGER-TEXT-5512')
  })

  it('does nothing while the task is still running', async () => {
    const ctx = setup()
    const { id } = await uploaded(ctx)

    await fitzpatrickStep(ctx, id)

    expect(await ctx.repository.fitzpatrickOf(PROFILE)).toBeNull()
    expect(ctx.aiUsage.recorded).toEqual([])
    expect(callsOf(ctx, 'deleteTask')).toEqual([])
  })

  it('stores the type once and records 10 units once when the step runs twice: the second run only deletes the vendor\'s copy', async () => {
    const ctx = setup()
    const { id } = await uploaded(ctx)
    ctx.perfectCorp.script('getFitzpatrick', { status: 'success', fitzpatrick: 'V' }, { status: 'success', fitzpatrick: 'II' })

    await fitzpatrickStep(ctx, id, 'wh-1')
    await fitzpatrickStep(ctx, id, 'wh-2')

    expect(await ctx.repository.fitzpatrickOf(PROFILE)).toMatchObject({ fitzpatrick: 'V' })
    expect(ctx.aiUsage.recorded).toHaveLength(1)
    expect(callsOf(ctx, 'getFitzpatrick')).toHaveLength(1)
    expect(callsOf(ctx, 'deleteTask').length).toBeGreaterThanOrEqual(1)
  })

  it('does nothing for a scan that does not exist', async () => {
    const ctx = setup()

    await expect(fitzpatrickStep(ctx, 'no-such-scan')).resolves.toBeUndefined()

    expect(ctx.perfectCorp.calls).toEqual([])
  })

  it('is still stored when the vendor\'s copy cannot be deleted', async () => {
    const ctx = setup()
    const { id } = await uploaded(ctx)
    ctx.perfectCorp.script('getFitzpatrick', { status: 'success', fitzpatrick: 'IV' })
    ctx.perfectCorp.script('deleteTask', new PerfectCorpUnavailableError('down'))

    await loggedDuring(() => fitzpatrickStep(ctx, id))

    expect(await ctx.repository.fitzpatrickOf(PROFILE)).toMatchObject({ fitzpatrick: 'IV' })
    expect(ctx.aiUsage.recorded).toHaveLength(1)
  })
})

describe('FaceScanService.receiveWebhook', () => {
  it('refuses a delivery whose signature does not check out: 401 WEBHOOK_SIGNATURE_INVALID, and queues nothing', async () => {
    const ctx = setup()
    const { analysisTask } = await uploaded(ctx)
    clearQueue(ctx)

    const error = await errorOf(receive(ctx, JSON.stringify({ data: { task_id: analysisTask, task_status: 'success' } })))

    expect(error).toBeInstanceOf(UnauthorizedError)
    expect(error.code).toBe('WEBHOOK_SIGNATURE_INVALID')
    expect(ctx.jobs.enqueued).toEqual([])
  })

  it('logs why a delivery was rejected, once, as a warning with the reason, the fields it gave and the size of the body, and still answers 401', async () => {
    const ctx = setup()
    const { analysisTask } = await uploaded(ctx)
    clearQueue(ctx)
    const rejection = { reason: 'stale-timestamp' as const, skewSeconds: 4000, skewIfMilliseconds: null, signatureValid: true }
    ctx.perfectCorp.script('checkWebhook', { ok: false, rejection })
    const raw = JSON.stringify({ data: { task_id: analysisTask, task_status: 'success' } })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      const error = await errorOf(receive(ctx, raw))

      expect(error).toBeInstanceOf(UnauthorizedError)
      expect(error.code).toBe('WEBHOOK_SIGNATURE_INVALID')
      expect(ctx.jobs.enqueued).toEqual([])
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn.mock.calls[0]).toEqual([{ outcome: 'perfect-corp-webhook-rejected', ...rejection, bodyBytes: raw.length }])
    } finally {
      warn.mockRestore()
    }
  })

  it('logs every field of each kind of rejection it is given', async () => {
    const rejections = [
      { reason: 'missing-headers' as const, missing: ['webhook-id' as const] },
      {
        reason: 'signature-mismatch' as const,
        versions: ['v1', 'other'],
        signatureCount: 2,
        undecodedSecretWouldMatch: true,
        idWithoutSuffixWouldMatch: true,
        undecodedAndIdWithoutSuffixWouldMatch: false,
        topLevelKeys: ['created_at', 'data'],
        dataKeys: ['task_id', 'task_status'],
      },
      { reason: 'bad-shape' as const, problem: 'no-task-id' as const, topLevelKeys: ['data'], dataKeys: ['task_status'] },
    ]
    for (const rejection of rejections) {
      const ctx = setup()
      ctx.perfectCorp.script('checkWebhook', { ok: false, rejection })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      try {
        await errorOf(receive(ctx, 'abc'))

        expect(warn.mock.calls).toEqual([[{ outcome: 'perfect-corp-webhook-rejected', ...rejection, bodyBytes: 3 }]])
      } finally {
        warn.mockRestore()
      }
    }
  })

  it('logs nothing of the body when it rejects a delivery: only its size', async () => {
    const ctx = setup()
    ctx.perfectCorp.script('checkWebhook', { ok: false, rejection: { reason: 'bad-shape', problem: 'no-data', topLevelKeys: ['created_at'], dataKeys: [] } })
    const raw = JSON.stringify({ created_at: 1, note: 'distinctive-body-value-7731' })

    const logged = await loggedDuring(() => errorOf(receive(ctx, raw, { 'webhook-id': 'distinctive-id-value-5521', 'webhook-signature': 'v1,distinctive-signature-9913' })))

    expect(logged).toContain('perfect-corp-webhook-rejected')
    expect(logged).toContain(`"bodyBytes":${raw.length}`)
    expect(logged).not.toContain('distinctive-body-value-7731')
    expect(logged).not.toContain('distinctive-id-value-5521')
    expect(logged).not.toContain('distinctive-signature-9913')
  })

  it('logs no warning for a delivery it accepts', async () => {
    const ctx = setup()
    const { analysisTask } = await uploaded(ctx)
    ctx.perfectCorp.script('checkWebhook', { ok: true, delivery: { webhookId: 'wh-48', taskId: analysisTask, taskStatus: 'success' } })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    try {
      await receive(ctx)

      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('verifies the raw body and the headers exactly as they arrived', async () => {
    const ctx = setup()
    const raw = '{"data":  {"task_id":"t-1","task_status":"success"}}'
    ctx.perfectCorp.script('checkWebhook', { ok: false, rejection: { reason: 'bad-timestamp' } })

    await errorOf(receive(ctx, raw, { 'webhook-id': 'wh-9', 'webhook-timestamp': '1', 'webhook-signature': 'v1,abc' }))

    const [body, headers] = callsOf(ctx, 'checkWebhook')[0]!.args as [string, Headers]
    expect(body).toBe(raw)
    expect(headers.get('webhook-id')).toBe('wh-9')
    expect(headers.get('webhook-signature')).toBe('v1,abc')
  })

  it('queues the fetch step, stamped with now and carrying the webhook\'s id, for a task that is a scan\'s analysis', async () => {
    const ctx = setup()
    const { id, analysisTask } = await uploaded(ctx)
    clearQueue(ctx)
    ctx.advanceClock(3 * MINUTE)
    ctx.perfectCorp.script('checkWebhook', { ok: true, delivery: { webhookId: 'wh-42', taskId: analysisTask, taskStatus: 'success' } })

    await expect(receive(ctx)).resolves.toBeUndefined()

    expect(ctx.jobs.enqueued).toEqual([{ job: 'analyse-face-scan', body: { faceScanId: id, step: 'fetch', at: ctx.now().getTime(), webhookId: 'wh-42' } }])
  })

  it('queues the fitzpatrick step for a task that is a scan\'s Fitzpatrick read', async () => {
    const ctx = setup()
    const { id, fitzpatrickTask } = await uploaded(ctx)
    clearQueue(ctx)
    ctx.perfectCorp.script('checkWebhook', { ok: true, delivery: { webhookId: 'wh-43', taskId: fitzpatrickTask!, taskStatus: 'success' } })

    await receive(ctx)

    expect(ctx.jobs.enqueued).toEqual([{ job: 'analyse-face-scan', body: { faceScanId: id, step: 'fitzpatrick', at: ctx.now().getTime(), webhookId: 'wh-43' } }])
  })

  it('still queues the fetch step when the task ended in an error, so the step can find out why', async () => {
    const ctx = setup()
    const { id, analysisTask } = await uploaded(ctx)
    clearQueue(ctx)
    ctx.perfectCorp.script('checkWebhook', { ok: true, delivery: { webhookId: 'wh-44', taskId: analysisTask, taskStatus: 'error' } })

    await receive(ctx)

    expect(queuedSteps(ctx)).toEqual([{ faceScanId: id, step: 'fetch', at: ctx.now().getTime(), webhookId: 'wh-44' }])
  })

  it('answers and queues nothing for a task no scan holds (a deleted scan\'s, or a task from somewhere else)', async () => {
    const ctx = setup()
    await uploaded(ctx)
    clearQueue(ctx)
    ctx.perfectCorp.script('checkWebhook', { ok: true, delivery: { webhookId: 'wh-45', taskId: 'task-from-nowhere', taskStatus: 'success' } })

    await expect(receive(ctx)).resolves.toBeUndefined()

    expect(ctx.jobs.enqueued).toEqual([])
  })

  it('answers and queues nothing for a task that was made in another environment', async () => {
    const repository = new FakeFaceScansRepository()
    const production = setup({ repository, environment: 'production' })
    const { analysisTask } = await uploaded(production)
    const staging = setup({ repository, environment: 'staging' })
    staging.perfectCorp.script('checkWebhook', { ok: true, delivery: { webhookId: 'wh-46', taskId: analysisTask, taskStatus: 'success' } })

    await expect(receive(staging)).resolves.toBeUndefined()

    expect(staging.jobs.enqueued).toEqual([])
  })

  it('throws an UnavailableError, which the route answers 503 so Perfect Corp sends it again, when the step cannot be queued', async () => {
    const ctx = setup()
    const { analysisTask } = await uploaded(ctx)
    ctx.perfectCorp.script('checkWebhook', { ok: true, delivery: { webhookId: 'wh-47', taskId: analysisTask, taskStatus: 'success' } })
    ctx.jobs.failNextWith(new Error('queue is down'))

    expect(await errorOf(receive(ctx))).toBeInstanceOf(UnavailableError)
  })
})

describe('FaceScanService.retake', () => {
  /** A scan that needs a retake, reached the real way: the upload step is refused for the photo. */
  const needingRetake = async (ctx: Ctx, reason: 'too-dark' | 'no-face' = 'too-dark') => {
    const id = await started(ctx)
    ctx.perfectCorp.script('createSkinAnalysis', new PerfectCorpRejectedPhotoError(reason))
    await upload(ctx, id)
    clearQueue(ctx)
    expect(await rowOf(ctx, id)).toMatchObject({ state: 'needs-retake', reason })
    return id
  }

  it('replaces the front photo under the same key, moves the scan back to analysing with no reason and no analysis task, and queues the upload step', async () => {
    const ctx = setup()
    const id = await needingRetake(ctx)
    ctx.advanceClock(4 * MINUTE)

    const view = await retake(ctx, id, face(9))

    expect(view).toMatchObject({ id, state: 'analysing', reason: null })
    expect(Array.from(ctx.photos.stored.get(frontKey(ctx, id))!.bytes)).toEqual(Array.from(face(9).bytes))
    expect(await rowOf(ctx, id)).toMatchObject({ state: 'analysing', reason: null, pcAnalysisTaskId: null })
    expect(ctx.jobs.enqueued).toEqual([{ job: 'analyse-face-scan', body: { faceScanId: id, step: 'upload', at: ctx.now().getTime() } }])
    expect(view.photos.front.url).toEqual(expect.any(String))
  })

  it('runs the whole analysis again from the new photo: a fresh upload and a fresh task', async () => {
    const ctx = setup()
    const id = await needingRetake(ctx)
    await retake(ctx, id, face(9))
    ctx.perfectCorp.calls.length = 0

    await upload(ctx, id)

    expect(methodsCalled(ctx)).toContain('uploadFile')
    expect(Array.from((callsOf(ctx, 'uploadFile')[0]!.args[0] as Uint8Array))).toEqual(Array.from(face(9).bytes))
    expect(callsOf(ctx, 'createSkinAnalysis')).toHaveLength(1)
    expect((await rowOf(ctx, id)).pcAnalysisTaskId).toEqual(expect.any(String))
  })

  it('may be done again and again: there is no limit and no due-check', async () => {
    const ctx = setup()
    const id = await needingRetake(ctx)
    await retake(ctx, id, face(2))
    ctx.perfectCorp.script('createSkinAnalysis', new PerfectCorpRejectedPhotoError('no-face'))
    await upload(ctx, id)

    const second = await retake(ctx, id, face(3))

    expect(second).toMatchObject({ state: 'analysing', reason: null })
    expect(Array.from(ctx.photos.stored.get(frontKey(ctx, id))!.bytes)).toEqual(Array.from(face(3).bytes))
  })

  it.each(['analysing', 'ready', 'failed'] as const)('is 409 FACE_SCAN_NOT_AWAITING_RETAKE for a scan that is %s, and changes nothing', async (state) => {
    const ctx = setup()
    const id = await started(ctx)
    if (state === 'ready') {
      await upload(ctx, id)
      ctx.perfectCorp.script('getSkinAnalysis', analysed())
      await fetchStep(ctx, id)
    }
    if (state === 'failed') await asSystem(() => ctx.service.markFailed(id))
    clearQueue(ctx)
    const photoBefore = Array.from(ctx.photos.stored.get(frontKey(ctx, id))!.bytes)

    const error = await errorOf(retake(ctx, id, face(9)))

    expect(error).toBeInstanceOf(ConflictError)
    expect(error.code).toBe('FACE_SCAN_NOT_AWAITING_RETAKE')
    expect(Array.from(ctx.photos.stored.get(frontKey(ctx, id))!.bytes)).toEqual(photoBefore)
    expect((await rowOf(ctx, id)).state).toBe(state)
    expect(ctx.jobs.enqueued).toEqual([])
  })

  it('is 404 FACE_SCAN_NOT_FOUND for a scan that does not exist and for another profile\'s scan, with no hint that it exists', async () => {
    const ctx = setup()
    const id = await needingRetake(ctx)
    await giveConsent(ctx, OTHER_PROFILE)

    for (const attempt of [retake(ctx, 'no-such-scan'), retake(ctx, id, face(9), OTHER_PROFILE)]) {
      const error = await errorOf(attempt)
      expect(error).toBeInstanceOf(NotFoundError)
      expect(error.code).toBe('FACE_SCAN_NOT_FOUND')
    }
    expect((await rowOf(ctx, id)).state).toBe('needs-retake')
  })

  it('is 409 FACE_CONSENT_REQUIRED when the consent was withdrawn, and keeps the old photo and the scan as they were', async () => {
    const ctx = setup()
    const id = await needingRetake(ctx)
    await asUser(() => ctx.service.withdrawConsent())

    const error = await errorOf(retake(ctx, id, face(9)))

    expect(error).toBeInstanceOf(ConflictError)
    expect(error.code).toBe('FACE_CONSENT_REQUIRED')
    expect(Array.from(ctx.photos.stored.get(frontKey(ctx, id))!.bytes)).toEqual(Array.from(face(1).bytes))
    expect((await rowOf(ctx, id)).state).toBe('needs-retake')
    expect(ctx.jobs.enqueued).toEqual([])
  })

  it('asks for consent before it asks about the state', async () => {
    const ctx = setup()
    const id = await started(ctx)
    await asUser(() => ctx.service.withdrawConsent())

    expect((await errorOf(retake(ctx, id))).code).toBe('FACE_CONSENT_REQUIRED')
  })

  it('asks about the state before it looks at the photo', async () => {
    const ctx = setup()
    const id = await started(ctx)

    expect((await errorOf(retake(ctx, id, jpegPhoto({ width: 100, height: 100 })))).code).toBe('FACE_SCAN_NOT_AWAITING_RETAKE')
  })

  it.each([
    ['a photo that is not a JPEG', () => ({ bytes: new Uint8Array(64), mediaType: 'image/jpeg' as const }), 'UNSUPPORTED_IMAGE'],
    ['a photo too small to read a face from', () => jpegPhoto({ width: 1079, height: 1440 }), 'IMAGE_TOO_SMALL'],
  ])('is 400 %s, and leaves the old photo, the scan and the queue alone', async (_label, photo, code) => {
    const ctx = setup()
    const id = await needingRetake(ctx)

    const error = await errorOf(retake(ctx, id, photo()))

    expect(error).toBeInstanceOf(ValidationError)
    expect(error.code).toBe(code)
    expect(Array.from(ctx.photos.stored.get(frontKey(ctx, id))!.bytes)).toEqual(Array.from(face(1).bytes))
    expect((await rowOf(ctx, id)).state).toBe('needs-retake')
    expect(ctx.jobs.enqueued).toEqual([])
  })

  it('answers with the scan failed as unavailable, still, when the analysis cannot be queued', async () => {
    const ctx = setup()
    const id = await needingRetake(ctx)
    ctx.jobs.failNextWith(new Error('queue is down'))

    const view = await retake(ctx, id, face(9))

    expect(view).toMatchObject({ id, state: 'failed', reason: 'unavailable' })
    expect(await rowOf(ctx, id)).toMatchObject({ state: 'failed', reason: 'unavailable' })
  })

  it('gives the retaken scan a reaper check of its own, though the scan was checked before it was sent for a retake', async () => {
    const ctx = setup()
    const id = await uploaded(ctx).then((scan) => scan.id)
    ctx.advanceClock(STALE_AFTER + SECOND)
    await reap(ctx, ctx.now())
    ctx.perfectCorp.script('getSkinAnalysis', new PerfectCorpRejectedPhotoError('too-dark'))
    await fetchStep(ctx, id)
    expect((await rowOf(ctx, id)).state).toBe('needs-retake')
    await retake(ctx, id, face(9))
    clearQueue(ctx)
    // The upload message for the retake was lost: no task id, and it has now sat past the stale age.
    ctx.advanceClock(STALE_AFTER + SECOND)

    await reap(ctx, ctx.now())

    expect(queuedSteps(ctx)).toEqual([{ faceScanId: id, step: 'upload', at: ctx.now().getTime() }])
  })
})

describe('FaceScanService.reap: the reaper\'s one check', () => {
  it('leaves a scan alone until it has sat longer than 15 minutes, to the millisecond', async () => {
    const ctx = setup()
    const { id } = await uploaded(ctx)
    clearQueue(ctx)

    await reap(ctx, new Date(T0.getTime() + STALE_AFTER))
    expect(ctx.jobs.enqueued).toEqual([])
    expect((await rowOf(ctx, id)).reaperCheckedAt).toBeNull()

    await reap(ctx, new Date(T0.getTime() + STALE_AFTER + 1))
    expect(queuedSteps(ctx)).toEqual([{ faceScanId: id, step: 'fetch', at: T0.getTime() + STALE_AFTER + 1 }])
  })

  it('queues one fetch for a stale scan that has an analysis task, and records that it checked', async () => {
    const ctx = setup()
    const { id } = await uploaded(ctx)
    clearQueue(ctx)
    const at = new Date(T0.getTime() + 20 * MINUTE)

    await reap(ctx, at)

    expect(queuedSteps(ctx)).toEqual([{ faceScanId: id, step: 'fetch', at: at.getTime() }])
    expect((await rowOf(ctx, id)).reaperCheckedAt).toEqual(at)
    expect((await rowOf(ctx, id)).state).toBe('analysing')
  })

  it('checks a scan only once: reaping again, now or later, queues nothing more', async () => {
    const ctx = setup()
    const { id } = await uploaded(ctx)
    await reap(ctx, new Date(T0.getTime() + 20 * MINUTE))
    clearQueue(ctx)

    await reap(ctx, new Date(T0.getTime() + 20 * MINUTE))
    await reap(ctx, new Date(T0.getTime() + 30 * MINUTE))
    await reap(ctx, new Date(T0.getTime() + FAIL_AFTER))

    expect(ctx.jobs.enqueued).toEqual([])
    expect((await rowOf(ctx, id)).state).toBe('analysing')
  })

  it('queues the upload step once for a stale scan that has no analysis task, because the first message was lost', async () => {
    const ctx = setup()
    const id = await started(ctx)
    clearQueue(ctx)
    const at = new Date(T0.getTime() + 20 * MINUTE)

    await reap(ctx, at)
    await reap(ctx, new Date(at.getTime() + 10 * MINUTE))

    expect(queuedSteps(ctx)).toEqual([{ faceScanId: id, step: 'upload', at: at.getTime() }])
    expect((await rowOf(ctx, id)).reaperCheckedAt).toEqual(at)
  })

  it('does not make Perfect Corp calls itself: it only queues', async () => {
    const ctx = setup()
    await uploaded(ctx)
    const callsBefore = ctx.perfectCorp.calls.length

    await reap(ctx, new Date(T0.getTime() + 20 * MINUTE))

    expect(ctx.perfectCorp.calls).toHaveLength(callsBefore)
  })

  it('fails a scan that has sat longer than 2 hours as unavailable, to the millisecond, and tells the stream', async () => {
    const ctx = setup()
    const { id } = await uploaded(ctx)
    clearQueue(ctx)

    await reap(ctx, new Date(T0.getTime() + FAIL_AFTER))
    expect((await rowOf(ctx, id)).state).toBe('analysing')

    await reap(ctx, new Date(T0.getTime() + FAIL_AFTER + 1))
    expect(await rowOf(ctx, id)).toMatchObject({ state: 'failed', reason: 'unavailable' })
    expect(ctx.events.eventsFor(id).slice(-2)).toEqual([{ type: 'face', faceScan: { id, state: 'failed', reason: 'unavailable' } }, { type: 'done' }])
  })

  it('fails a scan the reaper never saw before it was 2 hours old, without queueing a check first', async () => {
    const ctx = setup()
    const { id } = await uploaded(ctx)
    clearQueue(ctx)

    await reap(ctx, new Date(T0.getTime() + FAIL_AFTER + HOUR))

    expect(await rowOf(ctx, id)).toMatchObject({ state: 'failed', reason: 'unavailable' })
    expect(ctx.jobs.enqueued).toEqual([])
  })

  it('does not restart the 2-hour clock when it checks: a scan checked at 20 minutes still fails 2 hours after it was last moved', async () => {
    const ctx = setup()
    const { id } = await uploaded(ctx)
    await reap(ctx, new Date(T0.getTime() + 20 * MINUTE))

    await reap(ctx, new Date(T0.getTime() + FAIL_AFTER + 1))

    expect((await rowOf(ctx, id)).state).toBe('failed')
  })

  it.each(['ready', 'needs-retake', 'failed'] as const)('leaves a scan that is %s alone, however old: it is waiting for the user or it is done', async (state) => {
    const ctx = setup()
    const { id } = await uploaded(ctx)
    if (state === 'ready') {
      ctx.perfectCorp.script('getSkinAnalysis', analysed())
      await fetchStep(ctx, id)
    }
    if (state === 'needs-retake') {
      ctx.perfectCorp.script('getSkinAnalysis', new PerfectCorpRejectedPhotoError('no-face'))
      await fetchStep(ctx, id)
    }
    if (state === 'failed') await asSystem(() => ctx.service.markFailed(id))
    clearQueue(ctx)
    const before = await rowOf(ctx, id)

    await reap(ctx, new Date(T0.getTime() + 30 * 24 * HOUR))

    expect(await rowOf(ctx, id)).toEqual(before)
    expect(ctx.jobs.enqueued).toEqual([])
  })

  it('handles every stale scan in one sweep, each by its own state', async () => {
    const repository = new FakeFaceScansRepository()
    const withTask = setup({ repository })
    const first = await uploaded(withTask)
    // A second profile of the same account, whose scan has no task: its first message was lost.
    await giveConsent(withTask, OTHER_PROFILE)
    await setGoal(withTask, 'brighter', OTHER_PROFILE)
    const second = (await asUser(() => withTask.service.create({ front: face(2) }), OTHER_PROFILE)).id
    clearQueue(withTask)
    const at = new Date(T0.getTime() + 20 * MINUTE)

    await reap(withTask, at)

    expect(queuedSteps(withTask)).toEqual(
      expect.arrayContaining([
        { faceScanId: first.id, step: 'fetch', at: at.getTime() },
        { faceScanId: second, step: 'upload', at: at.getTime() },
      ]),
    )
    expect(queuedSteps(withTask)).toHaveLength(2)
  })
})

describe('FaceScanService.reap: scans the reaper cannot let hold it back', () => {
  it('still checks a newer unchecked scan when 100 or more older ones were checked already and are not yet 2 hours old', async () => {
    const ctx = setup()
    for (let i = 0; i < 101; i++) {
      const id = `old-${i}`
      await ctx.repository.createFaceScan({ id, userId: 'old-user', profileId: `old-profile-${i}`, goalAtScan: 'glow', createdAt: new Date(T0.getTime() - 10 * MINUTE) }, [])
      await ctx.repository.markReaperChecked(id, T0)
    }
    const { id } = await uploaded(ctx)
    clearQueue(ctx)
    const at = new Date(T0.getTime() + 20 * MINUTE)

    const result = await reap(ctx, at)

    expect(queuedSteps(ctx)).toEqual([{ faceScanId: id, step: 'fetch', at: at.getTime() }])
    expect(result).toEqual({ checked: 1, failed: 0 })
  })

  it('does not move the updated time back when the scan moved on after the reaper read it', async () => {
    const repository = new HookedRepository()
    const ctx = setup({ repository })
    const { id } = await uploaded(ctx)
    const at = new Date(T0.getTime() + 20 * MINUTE)
    const movedAt = new Date(T0.getTime() + 19 * MINUTE)
    repository.afterUncheckedStaleRead = async () => void (await repository.updateFaceScan(id, 'analysing', { updatedAt: movedAt }))

    await reap(ctx, at)

    const row = await rowOf(ctx, id)
    expect(row.updatedAt).toEqual(movedAt)
    expect(row.reaperCheckedAt).toEqual(at)
  })

  it('queues nothing for a scan that another sweep checked between this one reading it and noting its check', async () => {
    const repository = new HookedRepository()
    const ctx = setup({ repository })
    const { id } = await uploaded(ctx)
    clearQueue(ctx)
    const other = new Date(T0.getTime() + 19 * MINUTE)
    repository.afterUncheckedStaleRead = async () => void (await repository.markReaperChecked(id, other))

    const result = await reap(ctx, new Date(T0.getTime() + 20 * MINUTE))

    expect(ctx.jobs.enqueued).toEqual([])
    expect(result).toEqual({ checked: 0, failed: 0 })
    expect((await rowOf(ctx, id)).reaperCheckedAt).toEqual(other)
  })
})

describe('FaceScanService: Perfect Corp\'s copy of the face photo is never left behind', () => {
  /** A scan whose analysis and Fitzpatrick tasks both exist at Perfect Corp, so a test can tell which of them were deleted. */
  const withBothTasks = async (ctx: Ctx) => {
    const scan = await uploaded(ctx)
    expect(scan.fitzpatrickTask).not.toBeNull()
    return { id: scan.id, both: [scan.analysisTask, scan.fitzpatrickTask!], analysisTask: scan.analysisTask, fitzpatrickTask: scan.fitzpatrickTask! }
  }
  const twoDeleteFailures = (ctx: Ctx) => ctx.perfectCorp.script('deleteTask', new PerfectCorpUnavailableError('vendor said SECRET-VENDOR-TEXT-7741'), new PerfectCorpUnavailableError('vendor said SECRET-VENDOR-TEXT-7741'))

  it('deletes the analysis task, and leaves a Fitzpatrick task that may still complete, when the photo is refused and the profile has no type yet', async () => {
    const ctx = setup()
    const { id, analysisTask } = await withBothTasks(ctx)
    ctx.perfectCorp.script('getSkinAnalysis', new PerfectCorpRejectedPhotoError('too-dark'))

    await fetchStep(ctx, id)

    expect(await rowOf(ctx, id)).toMatchObject({ state: 'needs-retake', reason: 'too-dark' })
    expect(deletedTasks(ctx)).toEqual([analysisTask])
  })

  it('deletes the Fitzpatrick task too when the photo is refused and the profile already has a type, because nothing waits for it', async () => {
    const ctx = setup()
    const { id, both } = await withBothTasks(ctx)
    await ctx.repository.saveFitzpatrick({ profileId: PROFILE, userId: USER, fitzpatrick: 'V', taskId: 'earlier-task', createdAt: T0 })
    ctx.perfectCorp.script('getSkinAnalysis', new PerfectCorpRejectedPhotoError('no-face'))

    await fetchStep(ctx, id)

    expect(deletedTasks(ctx)).toEqual(both)
  })

  it('deletes nothing when the photo is refused before any task exists', async () => {
    const ctx = setup()
    const id = await started(ctx)
    ctx.perfectCorp.script('createSkinAnalysis', new PerfectCorpRejectedPhotoError('no-face'))

    await upload(ctx, id)

    expect(await rowOf(ctx, id)).toMatchObject({ state: 'needs-retake' })
    expect(callsOf(ctx, 'deleteTask')).toEqual([])
  })

  it('still lets the Fitzpatrick task of a refused photo finish after a retake: its step stores the type and deletes it', async () => {
    const ctx = setup()
    const { id, fitzpatrickTask } = await withBothTasks(ctx)
    ctx.perfectCorp.script('getSkinAnalysis', new PerfectCorpRejectedPhotoError('move-closer'))
    await fetchStep(ctx, id)
    await retake(ctx, id, face(9))
    ctx.perfectCorp.script('getFitzpatrick', { status: 'success', fitzpatrick: 'IV' })

    await fitzpatrickStep(ctx, id)

    expect(await ctx.repository.fitzpatrickOf(PROFILE)).toMatchObject({ fitzpatrick: 'IV', taskId: fitzpatrickTask })
    expect(deletedTasks(ctx)).toContain(fitzpatrickTask)
  })

  it.each([
    ['has no credit', () => new PerfectCorpCreditError('no units'), true],
    ['calls the request bad', () => new PerfectCorpBadRequestError('expired'), false],
  ])('deletes both tasks when the scan fails because Perfect Corp %s', async (_label, error, _alert) => {
    const ctx = setup()
    const { id, both } = await withBothTasks(ctx)
    ctx.perfectCorp.script('getSkinAnalysis', error())

    expect(await errorOf(fetchStep(ctx, id))).toBeInstanceOf(PermanentJobError)

    expect(await rowOf(ctx, id)).toMatchObject({ state: 'failed', reason: 'unavailable' })
    expect(deletedTasks(ctx)).toEqual(both)
  })

  it('deletes both tasks when the reaper gives up on a scan after 2 hours', async () => {
    const ctx = setup()
    const { id, both } = await withBothTasks(ctx)

    await reap(ctx, new Date(T0.getTime() + FAIL_AFTER + 1))

    expect((await rowOf(ctx, id)).state).toBe('failed')
    expect(deletedTasks(ctx)).toEqual(both)
  })

  it('deletes both tasks when the queue gives up on a step of the scan (the dead letter), but none for a Fitzpatrick step, which leaves the scan alone', async () => {
    const ctx = setup()
    const { id, both } = await withBothTasks(ctx)

    await asSystem(() => ctx.service.giveUp({ faceScanId: id, step: 'fitzpatrick', at: T0.getTime() }))
    expect(callsOf(ctx, 'deleteTask')).toEqual([])
    expect((await rowOf(ctx, id)).state).toBe('analysing')

    await asSystem(() => ctx.service.giveUp({ faceScanId: id, step: 'fetch', at: T0.getTime() }))
    expect((await rowOf(ctx, id)).state).toBe('failed')
    expect(deletedTasks(ctx)).toEqual(both)
  })

  it('deletes the Fitzpatrick task a retaken scan still holds when the consent was withdrawn before its upload ran', async () => {
    const ctx = setup()
    const { id, fitzpatrickTask } = await withBothTasks(ctx)
    ctx.perfectCorp.script('getSkinAnalysis', new PerfectCorpRejectedPhotoError('too-dark'))
    await fetchStep(ctx, id)
    await retake(ctx, id, face(9))
    await asUser(() => ctx.service.withdrawConsent())
    ctx.perfectCorp.calls.length = 0

    await upload(ctx, id)

    expect(await rowOf(ctx, id)).toMatchObject({ state: 'failed', reason: 'consent-withdrawn' })
    expect(deletedTasks(ctx)).toEqual([fitzpatrickTask])
  })

  it('deletes nothing for a scan that fails before it has any task', async () => {
    const ctx = setup()
    const id = await started(ctx)

    await asSystem(() => ctx.service.markFailed(id))

    expect(callsOf(ctx, 'deleteTask')).toEqual([])
  })

  it('deletes no task when the scan had already moved on and the failure changed nothing', async () => {
    const ctx = setup()
    const { id } = await finished(ctx)
    ctx.perfectCorp.calls.length = 0

    await asSystem(() => ctx.service.markFailed(id))

    expect(callsOf(ctx, 'deleteTask')).toEqual([])
    expect((await rowOf(ctx, id)).state).toBe('ready')
  })

  it('deletes both tasks when the user deletes the scan, and the scan is gone as before', async () => {
    const ctx = setup()
    const { id, both } = await withBothTasks(ctx)

    await asUser(() => ctx.service.deleteFaceScan(id))

    expect(deletedTasks(ctx)).toEqual(both)
    expect(await ctx.repository.findFaceScan(id)).toBeNull()
    expect(ctx.photos.stored.size).toBe(0)
  })

  it('changes nothing else when Perfect Corp cannot delete the tasks of a scan that fails: it is failed, the stream is told, the message still ends as permanent, and only the error\'s name is logged', async () => {
    const ctx = setup()
    const { id } = await withBothTasks(ctx)
    ctx.perfectCorp.script('getSkinAnalysis', new PerfectCorpCreditError('no units'))
    twoDeleteFailures(ctx)

    const logged = await loggedDuring(async () => expect(await errorOf(fetchStep(ctx, id))).toBeInstanceOf(PermanentJobError))

    expect(await rowOf(ctx, id)).toMatchObject({ state: 'failed', reason: 'unavailable' })
    expect(ctx.events.eventsFor(id).slice(-2)).toEqual([{ type: 'face', faceScan: { id, state: 'failed', reason: 'unavailable' } }, { type: 'done' }])
    expect(opsAlertsRaised(ctx)).toEqual(['face-scan-account'])
    expect(deletedTasks(ctx)).toHaveLength(2)
    expect(logged).toContain('task-delete-failed')
    expect(logged).toContain('PerfectCorpUnavailableError')
    expect(logged).not.toContain('SECRET-VENDOR-TEXT-7741')
  })

  it('changes nothing else when Perfect Corp cannot delete the tasks of a refused photo', async () => {
    const ctx = setup()
    const { id } = await withBothTasks(ctx)
    await ctx.repository.saveFitzpatrick({ profileId: PROFILE, userId: USER, fitzpatrick: 'V', taskId: 'earlier-task', createdAt: T0 })
    ctx.perfectCorp.script('getSkinAnalysis', new PerfectCorpRejectedPhotoError('too-dark'))
    twoDeleteFailures(ctx)

    await loggedDuring(() => fetchStep(ctx, id))

    expect(await rowOf(ctx, id)).toMatchObject({ state: 'needs-retake', reason: 'too-dark' })
    expect(ctx.events.eventsFor(id).slice(-2)).toEqual([{ type: 'face', faceScan: { id, state: 'needs-retake', reason: 'too-dark' } }, { type: 'done' }])
  })

  it('changes nothing else when Perfect Corp cannot delete the tasks of a scan the user deletes: the scan and its photos are gone', async () => {
    const ctx = setup()
    const { id } = await withBothTasks(ctx)
    twoDeleteFailures(ctx)

    const logged = await loggedDuring(() => asUser(() => ctx.service.deleteFaceScan(id)))

    expect(await ctx.repository.findFaceScan(id)).toBeNull()
    expect(ctx.photos.stored.size).toBe(0)
    expect(logged).toContain('PerfectCorpUnavailableError')
    expect(logged).not.toContain('SECRET-VENDOR-TEXT-7741')
  })
})

describe('FaceScanService: races with the bucket', () => {
  it('leaves nothing in the bucket for a scan the user deletes while an analysis commits its masks between the key read and the row delete', async () => {
    const repository = new HookedRepository()
    const ctx = setup({ repository })
    const { id } = await uploaded(ctx)
    repository.afterKeysRead = async () => {
      ctx.perfectCorp.script('getSkinAnalysis', analysed())
      await fetchStep(ctx, id)
      expect(masksStored(ctx)).toHaveLength(3)
    }

    await asUser(() => ctx.service.deleteFaceScan(id))

    expect(await ctx.repository.findFaceScan(id)).toBeNull()
    expect(ctx.photos.stored.size).toBe(0)
  })

  it('leaves nothing in the bucket, extra masks included, for a scan deleted while an analysis commits all its measured masks between the key read and the row delete', async () => {
    const repository = new HookedRepository()
    const ctx = setup({ repository })
    const { id } = await uploaded(ctx, 'glow')
    repository.afterKeysRead = async () => {
      ctx.perfectCorp.script('getSkinAnalysis', analysisOf({ ...glowScores(65, 32, 35), ...coreScores(84, 58, 70, 70) }))
      await fetchStep(ctx, id)
      expect(masksStored(ctx)).toHaveLength(7)
    }

    await asUser(() => ctx.service.deleteFaceScan(id))

    expect(await ctx.repository.findFaceScan(id)).toBeNull()
    expect(ctx.photos.stored.size).toBe(0)
  })

  it.each([...GOALS])('empties the bucket when a ready %s scan with a mask for every measured concern is deleted', async (goal) => {
    const ctx = setup()
    const { id } = await uploaded(ctx, goal)
    ctx.perfectCorp.script('getSkinAnalysis', analysisOf(Object.fromEntries(measuredConcernsForGoal(goal).map((concern) => [concern, 50]))))
    await fetchStep(ctx, id)
    expect(masksStored(ctx)).toHaveLength(measuredConcernsForGoal(goal).length)

    await asUser(() => ctx.service.deleteFaceScan(id))

    expect(ctx.photos.stored.size).toBe(0)
  })

  it('removes the front photo it just wrote when the scan was deleted between its reading the scan and its moving it, and answers 404', async () => {
    const repository = new HookedRepository()
    const ctx = setup({ repository })
    const id = await started(ctx)
    ctx.perfectCorp.script('createSkinAnalysis', new PerfectCorpRejectedPhotoError('too-dark'))
    await upload(ctx, id)
    repository.afterPhotosRead = () => asUser(() => ctx.service.deleteFaceScan(id))

    const error = await errorOf(retake(ctx, id, face(9)))

    expect(error).toBeInstanceOf(NotFoundError)
    expect(error.code).toBe('FACE_SCAN_NOT_FOUND')
    expect(await ctx.repository.findFaceScan(id)).toBeNull()
    expect(ctx.photos.stored.size).toBe(0)
  })

  it('leaves the front photo in place, and answers 409, when the scan still exists but another retake moved it first', async () => {
    const repository = new HookedRepository()
    const ctx = setup({ repository })
    const id = await started(ctx)
    ctx.perfectCorp.script('createSkinAnalysis', new PerfectCorpRejectedPhotoError('too-dark'))
    await upload(ctx, id)
    repository.afterPhotosRead = async () => void (await repository.updateFaceScan(id, 'needs-retake', { state: 'analysing', reason: null, pcAnalysisTaskId: null, updatedAt: T0 }))

    const error = await errorOf(retake(ctx, id, face(9)))

    expect(error.code).toBe('FACE_SCAN_NOT_AWAITING_RETAKE')
    expect(ctx.photos.stored.has(frontKey(ctx, id))).toBe(true)
  })
})

describe('FaceScanService.watch: the live stream', () => {
  const watch = (ctx: Ctx, id: string, profileId = PROFILE) => asUser(() => ctx.service.watch(id), profileId)

  it('opens the stream with the scan as it is now: its id, state and reason', async () => {
    const ctx = setup()
    const id = await started(ctx)

    const res = await watch(ctx, id)

    expect(res.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8')
    expect(ctx.events.subscribed).toHaveLength(1)
    expect(ctx.events.subscribed[0]!.scanId).toBe(id)
    expect(ctx.events.subscribed[0]!.snapshot).toMatchObject({ id, state: 'analysing', reason: null })
  })

  it('does not say done for a scan that is still analysing', async () => {
    const ctx = setup()
    const id = await started(ctx)

    await watch(ctx, id)

    expect(ctx.events.eventsFor(id)).toEqual([])
  })

  it.each([
    ['ready', null],
    ['failed', 'unavailable'],
    ['needs-retake', 'too-dark'],
  ] as const)('says done straight away for a scan that is already %s, so the client does not wait for an event that has passed', async (state, reason) => {
    const ctx = setup()
    const id = await started(ctx)
    await upload(ctx, id)
    if (state === 'ready') {
      ctx.perfectCorp.script('getSkinAnalysis', analysed())
      await fetchStep(ctx, id)
    }
    if (state === 'failed') await asSystem(() => ctx.service.markFailed(id))
    if (state === 'needs-retake') {
      ctx.perfectCorp.script('getSkinAnalysis', new PerfectCorpRejectedPhotoError('too-dark'))
      await fetchStep(ctx, id)
    }
    const publishedBefore = ctx.events.published.length

    await watch(ctx, id)

    expect(ctx.events.subscribed[0]!.snapshot).toMatchObject({ id, state, reason })
    expect(ctx.events.published.slice(publishedBefore)).toEqual([{ scanId: id, event: { type: 'done' } }])
  })

  it('is 404 FACE_SCAN_NOT_FOUND for a scan that does not exist and for another profile\'s scan, and opens no stream', async () => {
    const ctx = setup()
    const id = await started(ctx)

    for (const attempt of [watch(ctx, 'no-such-scan'), watch(ctx, id, OTHER_PROFILE)]) {
      const error = await errorOf(attempt)
      expect(error).toBeInstanceOf(NotFoundError)
      expect(error.code).toBe('FACE_SCAN_NOT_FOUND')
    }
    expect(ctx.events.subscribed).toEqual([])
  })

  it('is 401 for a caller who is not signed in', async () => {
    const ctx = setup()
    const id = await started(ctx)

    const error = await errorOf(runAs({ kind: 'public' }, () => ctx.service.watch(id)))

    expect(error).toBeInstanceOf(UnauthorizedError)
  })
})

describe('FaceScanService: a guest may run the scan flow, and the stream carries status only', () => {
  // A guest (status 'anonymous') may give consent, start a scan, retake it and follow it live; a verified user may too. Whoever watches, every `face` frame
  // and the snapshot is exactly { id, state, reason }: where the scan has got to and why, never the result, the scores, the skin type or age, the overlays,
  // the photo links or the goal. The result is only for GET /scans/faces/{id}, which is for verified users.
  const actors = [
    ['a guest', 'anonymous'],
    ['a verified user', 'verified'],
  ] as const
  const asStatus = (status: 'anonymous' | 'verified') => <T>(fn: () => Promise<T>) => runAs({ kind: 'user', userId: USER, status, profileId: PROFILE }, fn)
  const STATUS_KEYS = ['id', 'reason', 'state']

  /** Consent, a goal and the front photo, all as `run` would do them. Resolves to the scan's id. */
  const startedBy = async (ctx: Ctx, run: ReturnType<typeof asStatus>, goal: Goal = 'glow'): Promise<string> => {
    await run(() => ctx.service.giveConsent(CURRENT_FACE_CONSENT_VERSION))
    await run(() => ctx.goals.set({ goal }))
    return (await run(() => ctx.service.create({ front: face(1) }))).id
  }
  const faceFramesOf = (ctx: Ctx, id: string) => ctx.events.eventsFor(id).flatMap((event) => (event.type === 'face' ? [event.faceScan] : []))
  const snapshotsOf = (ctx: Ctx, id: string) => ctx.events.subscribed.filter((s) => s.scanId === id).map((s) => s.snapshot)
  const expectStatusOnly = (ctx: Ctx, id: string) => {
    const frames = [...faceFramesOf(ctx, id), ...snapshotsOf(ctx, id)]
    expect(frames.length).toBeGreaterThan(0)
    for (const frame of frames) expect(Object.keys(frame).sort()).toEqual(STATUS_KEYS)
  }

  describe.each(actors)('%s', (_who, status) => {
    const run = asStatus(status)

    it('starts a scan, follows it to ready, and sees only id, state and reason in the snapshots and the frames, though the scan has a full result', async () => {
      const ctx = setup()
      const id = await startedBy(ctx, run)
      await run(() => ctx.service.watch(id))
      await upload(ctx, id)
      ctx.perfectCorp.script('getSkinAnalysis', analysed())
      await fetchStep(ctx, id)

      await run(() => ctx.service.watch(id))

      expect(snapshotsOf(ctx, id)).toStrictEqual([
        { id, state: 'analysing', reason: null },
        { id, state: 'ready', reason: null },
      ])
      expect(ctx.events.eventsFor(id)).toStrictEqual([
        { type: 'face', faceScan: { id, state: 'analysing', reason: null } },
        { type: 'face', faceScan: { id, state: 'ready', reason: null } },
        { type: 'done' },
        { type: 'done' },
      ])
      expectStatusOnly(ctx, id)
      // The result exists, for a verified reader: it is the frames that leave it out.
      expect((await getScan(ctx, id)).result).not.toBeNull()
    })

    it('sees only id, state and reason when the photo needs a retake, through the retake and on to ready', async () => {
      const ctx = setup()
      const id = await startedBy(ctx, run)
      ctx.perfectCorp.script('createSkinAnalysis', new PerfectCorpRejectedPhotoError('too-dark'))
      await upload(ctx, id)
      await run(() => ctx.service.watch(id))

      const retaken = await run(() => ctx.service.retake(id, { front: face(9) }))
      await upload(ctx, id)
      ctx.perfectCorp.script('getSkinAnalysis', analysed())
      await fetchStep(ctx, id)

      expect(retaken).toMatchObject({ id, state: 'analysing', reason: null })
      expect(snapshotsOf(ctx, id)).toStrictEqual([{ id, state: 'needs-retake', reason: 'too-dark' }])
      expect(ctx.events.eventsFor(id)).toStrictEqual([
        { type: 'face', faceScan: { id, state: 'needs-retake', reason: 'too-dark' } },
        { type: 'done' },
        { type: 'done' },
        { type: 'face', faceScan: { id, state: 'analysing', reason: null } },
        { type: 'face', faceScan: { id, state: 'ready', reason: null } },
        { type: 'done' },
      ])
      expectStatusOnly(ctx, id)
    })

    it('sees only id, state and reason when the scan fails, and when it follows a scan that has already failed', async () => {
      const ctx = setup()
      const id = await startedBy(ctx, run)
      await upload(ctx, id)
      await asSystem(() => ctx.service.markFailed(id))

      await run(() => ctx.service.watch(id))

      expect(snapshotsOf(ctx, id)).toStrictEqual([{ id, state: 'failed', reason: 'unavailable' }])
      expect(faceFramesOf(ctx, id)).toStrictEqual([
        { id, state: 'analysing', reason: null },
        { id, state: 'failed', reason: 'unavailable' },
      ])
      expectStatusOnly(ctx, id)
    })
  })

  it('moves a guest\'s scan that needed a retake to analysing, replaces the front photo and queues the upload again', async () => {
    const ctx = setup()
    const guest = asStatus('anonymous')
    const id = await startedBy(ctx, guest)
    ctx.perfectCorp.script('createSkinAnalysis', new PerfectCorpRejectedPhotoError('no-face'))
    await upload(ctx, id)
    clearQueue(ctx)

    const view = await guest(() => ctx.service.retake(id, { front: face(9) }))

    expect(view).toMatchObject({ id, state: 'analysing', reason: null })
    expect(await rowOf(ctx, id)).toMatchObject({ state: 'analysing', reason: null, pcAnalysisTaskId: null })
    expect(Array.from(ctx.photos.stored.get(frontKey(ctx, id))!.bytes)).toEqual(Array.from(face(9).bytes))
    expect(queuedSteps(ctx)).toEqual([{ faceScanId: id, step: 'upload', at: ctx.now().getTime() }])
  })

  it('refuses a guest the result with 403 VERIFICATION_REQUIRED, though its scan is ready', async () => {
    const ctx = setup()
    const guest = asStatus('anonymous')
    const id = await startedBy(ctx, asStatus('verified'))
    await upload(ctx, id)
    ctx.perfectCorp.script('getSkinAnalysis', analysed())
    await fetchStep(ctx, id)

    const error = await errorOf(guest(() => ctx.service.getFaceScan(id)))

    expect(error.code).toBe('VERIFICATION_REQUIRED')
    expect((await getScan(ctx, id)).result).not.toBeNull()
  })
})


// --- PR 4: the result view ---
//
// A ready scan shows what the analysis stored: the goal's concerns that can be seen, with links to their masks, the skin type and skin age, and
// how each concern has moved since day one. Everything is worked out when the scan is read, from the stored rows. Scans here are made ready the
// real way (the upload step, then the fetch step over a scripted Perfect Corp result), so every row is one the product would have written.
//
// A goal's chase gets ONE scan, plus ONE wider check-in scan once it reaches its review point, six weeks after its day one (issue #145). Switching
// away and back inside the 90-day resume window carries on the same chase and makes nothing due, so there are only two ways to a second scan under
// one goal, and the fixtures below take them as a person would:
//   - move the clock to the chase's review point and take the check-in (`checkInReadyUnder`);
//   - leave the goal for longer than the resume window, which starts it fresh with a new day one (`FRESH_GAP`).

const DAY = 24 * HOUR
/** A new chase's day-one scan needs the profile's last day-one scan, under any goal, 30 days back (issue #145, written out here). */
const SCAN_SPACING = 30 * DAY
const PHOTO_LINK_LIFETIME = 5 * MINUTE
const LINK = /\/photos\/([A-Za-z0-9_-]+)$/

/** Perfect Corp's whole-face answer for the concerns given (HD name to raw_score), each with a mask named for the concern. */
const analysisOf = (scores: Record<string, number>, over: Partial<Extract<SkinAnalysisResult, { status: 'success' }>> = {}): SkinAnalysisResult =>
  analysed({
    concerns: Object.entries(scores).map(([concern, rawScore]) => ({ concern, region: 'whole', rawScore, uiScore: rawScore + 10, maskUrls: [maskUrl(concern.replace('hd_', ''))] })),
    ...over,
  })
const glowScores = (radiance: number, moisture: number, texture: number) => ({ hd_radiance: radiance, hd_moisture: moisture, hd_texture: texture })
/** The core extras (age spot, acne, pore, oiliness) as scores, in core order. */
const coreScores = (ageSpot: number, acne: number, pore: number, oiliness: number) => ({ hd_age_spot: ageSpot, hd_acne: acne, hd_pore: pore, hd_oiliness: oiliness })
const brighterScores = (radiance: number, darkCircle: number, ageSpot: number) => ({ hd_radiance: radiance, hd_dark_circle: darkCircle, hd_age_spot: ageSpot })

/** A scan under `goal` taken a scan spacing (30 days) after the last, and sent to Perfect Corp: analysing, with its task. */
const takenUnder = async (ctx: Ctx, goal: Goal): Promise<string> => {
  ctx.advanceClock(SCAN_SPACING)
  return (await uploaded(ctx, goal)).id
}
/** A scan under `goal` taken a scan spacing after the last, and made ready from `analysis`. */
const readyUnder = async (ctx: Ctx, goal: Goal, analysis: SkinAnalysisResult): Promise<string> => {
  const id = await takenUnder(ctx, goal)
  ctx.perfectCorp.script('getSkinAnalysis', analysis)
  await fetchStep(ctx, id)
  return id
}

/** Six weeks: every goal's review point, when its chase's check-in scan falls due (issue #145, written out here). */
const REVIEW_POINT = 42 * DAY
/** Longer than the 90-day resume window: a goal left this long starts fresh, with a day one of its own (issue #145, written out here). */
const FRESH_GAP = 90 * DAY + DAY
/** Moves the clock on to `when`, which is never earlier than now in these fixtures. */
const advanceTo = (ctx: Ctx, when: Date) => ctx.advanceClock(when.getTime() - ctx.now().getTime())
/** The chase's review point: six weeks after the day-one scan was taken (not after it became ready). */
const reviewPointOf = async (ctx: Ctx, dayOne: string) => new Date((await rowOf(ctx, dayOne)).createdAt.getTime() + REVIEW_POINT)
/**
 * The check-in scan of the chase `dayOne` started, taken at exactly the chase's review point and made ready from `analysis`. The one way to a second
 * ready scan in a chase: the clock moves to the review point, so the scan the service takes there is the check-in.
 */
const checkInReadyUnder = async (ctx: Ctx, goal: Goal, analysis: SkinAnalysisResult, dayOne: string): Promise<string> => {
  // `readyUnder` moves the clock on a scan spacing of its own before it takes the scan.
  advanceTo(ctx, new Date((await reviewPointOf(ctx, dayOne)).getTime() - SCAN_SPACING))
  return readyUnder(ctx, goal, analysis)
}
/** The check-in scan of the chase `dayOne` started, taken at its review point and sent to Perfect Corp: analysing, with its tasks. */
const checkInTakenUnder = async (ctx: Ctx, goal: Goal, dayOne: string) => {
  advanceTo(ctx, new Date((await reviewPointOf(ctx, dayOne)).getTime() - SCAN_SPACING))
  ctx.advanceClock(SCAN_SPACING)
  return uploaded(ctx, goal)
}
const failScan = (ctx: Ctx, id: string) => asSystem(() => ctx.service.markFailed(id))
const resultOf = async (ctx: Ctx, id: string) => (await getScan(ctx, id)).result
const tokenOfLink = (url: string) => LINK.exec(url)![1]!
const bytesBehind = async (ctx: Ctx, url: string) => new TextDecoder().decode((await asUser(() => ctx.service.photoForLink(tokenOfLink(url)))).bytes)

describe('FaceScanService.getFaceScan: also noticed', () => {
  // glow measures radiance, moisture, texture, then the core extras in core order: age_spot (marks), acne (spots), pore (pores), oiliness (shine).
  it('lists the visible extras in core order with their words, leaves out the faint one, and keeps the goal\'s own three in seen', async () => {
    const ctx = setup()
    const id = await readyUnder(ctx, 'glow', analysisOf({ ...glowScores(65, 32, 35), ...coreScores(84, 58, 70, 90) }))

    const result = await resultOf(ctx, id)

    expect(result.seen.map((item: { concern: string }) => item.concern)).toEqual(['glow', 'dryness', 'texture'])
    // pore 70 and oiliness 90 are above their cut-offs: faint, so left out.
    expect(result.alsoNoticed).toEqual([
      { concern: 'marks', region: 'whole', level: 'a-little', words: 'A few faint dark marks', overlay: { url: expect.stringMatching(LINK) } },
      { concern: 'spots', region: 'whole', level: 'some', words: 'Some spots and breakouts across the face', overlay: { url: expect.stringMatching(LINK) } },
    ])
  })

  it('gives each listed extra a signed link that opens its own mask, and no link at all for a faint extra', async () => {
    const ctx = setup()
    const id = await readyUnder(ctx, 'glow', analysisOf({ ...glowScores(65, 32, 35), ...coreScores(84, 58, 70, 70) }))

    const { alsoNoticed } = await resultOf(ctx, id)

    expect(alsoNoticed.map((item: { concern: string }) => item.concern)).toEqual(['marks', 'spots', 'shine'])
    expect(await Promise.all(alsoNoticed.map((item: { overlay: { url: string } }) => bytesBehind(ctx, item.overlay.url)))).toEqual([maskUrl('age_spot'), maskUrl('acne'), maskUrl('oiliness')])
    const links = [...JSON.stringify(await getScan(ctx, id)).matchAll(/\/photos\/([A-Za-z0-9_-]+)/g)].map((match) => match[1]!)
    const opened = await Promise.all(links.map(async (token) => new TextDecoder().decode((await asUser(() => ctx.service.photoForLink(token))).bytes)))
    expect(opened).not.toContain(maskUrl('pore'))
  })

  it('gives an extra link the life and the profile claim of a photo link: good for 5 minutes, then PHOTO_NOT_FOUND', async () => {
    const ctx = setup()
    const id = await readyUnder(ctx, 'glow', analysisOf({ ...glowScores(65, 32, 35), ...coreScores(84, 58, 70, 70) }))
    const { url } = (await resultOf(ctx, id)).alsoNoticed[0].overlay

    ctx.advanceClock(PHOTO_LINK_LIFETIME - SECOND)
    await expect(asUser(() => ctx.service.photoForLink(tokenOfLink(url)))).resolves.toMatchObject({ mediaType: 'image/png' })

    ctx.advanceClock(2 * SECOND)
    expect((await errorOf(asUser(() => ctx.service.photoForLink(tokenOfLink(url))))).code).toBe('PHOTO_NOT_FOUND')
  })

  it('is [] for a scan taken before the core extras were measured (three concerns and their masks only)', async () => {
    const ctx = setup()
    const id = await readyUnder(ctx, 'glow', analysisOf(glowScores(65, 32, 35)))

    const result = await resultOf(ctx, id)

    expect(result.alsoNoticed).toEqual([])
    expect(result.seen).toHaveLength(3)
  })

  it('leaves out a measured extra Perfect Corp did not return, and keeps the ones it did', async () => {
    const ctx = setup()
    const id = await readyUnder(ctx, 'glow', analysisOf({ ...glowScores(65, 32, 35), hd_oiliness: 70 }))

    expect((await resultOf(ctx, id)).alsoNoticed.map((item: { concern: string }) => item.concern)).toEqual(['shine'])
  })

  it('is [] when every extra is faint, and then says nothing about them: the scan keeps its own nothing-stands-out rule', async () => {
    const ctx = setup()
    const id = await readyUnder(ctx, 'glow', analysisOf({ ...glowScores(76, 90, 100), ...coreScores(95, 90, 90, 95) }))

    const result = await resultOf(ctx, id)

    expect(result.alsoNoticed).toEqual([])
    expect(result.nothingStandsOut).toBe('Nothing stands out for your goal right now')
  })

  it('is on every scan of a list and on the one view, the same', async () => {
    const ctx = setup()
    const id = await readyUnder(ctx, 'glow', analysisOf({ ...glowScores(65, 32, 35), ...coreScores(84, 58, 70, 70) }))

    const listed = await asUser(() => ctx.service.listFaceScans())

    expect(listed.find((scan: { id: string }) => scan.id === id)!.result!.alsoNoticed.map((item: { concern: string }) => item.concern)).toEqual(['marks', 'spots', 'shine'])
  })
})

describe('FaceScanService.getFaceScan: the result of a ready scan', () => {
  it('shows what can be seen for the goal, with the skin type and skin age, and no change since day one for the first scan', async () => {
    const ctx = setup()
    const { id } = await finished(ctx, 'glow')

    const view = await getScan(ctx, id)

    // analysed(): radiance 41.5 is "clear", moisture 62 and texture 55 are faint (above their cut-offs, still shown); a mask for radiance and moisture, none for texture.
    // acne (80, faint) is measured as a core extra, so it is stored but not listed in alsoNoticed.
    expect(view.result).toEqual({
      seen: [
        { concern: 'glow', region: 'whole', level: 'clear', words: 'Less glow across most of the face', overlay: { url: expect.stringMatching(LINK) } },
        { concern: 'dryness', region: 'whole', level: 'faint', words: 'Hardly any dry patches', overlay: { url: expect.stringMatching(LINK) } },
        { concern: 'texture', region: 'whole', level: 'faint', words: 'Skin looks smooth', overlay: null },
      ],
      alsoNoticed: [],
      nothingStandsOut: null,
      skinType: 'dry',
      skinAge: { years: 31, words: 'Your skin looks about 31' },
      sinceDayOne: null,
      tablesVersion: TABLES_VERSION,
    })
  })

  it('gives each shown concern a link that opens to the bytes of its own mask', async () => {
    const ctx = setup()
    const { id } = await finished(ctx, 'glow')

    const { seen } = (await getScan(ctx, id)).result

    expect(await bytesBehind(ctx, seen[0].overlay.url)).toBe(maskUrl('radiance'))
    const opened = await asUser(() => ctx.service.photoForLink(tokenOfLink(seen[0].overlay.url)))
    expect(opened.mediaType).toBe('image/png')
  })

  it('gives the overlay links the life of a photo link: good for 5 minutes, then PHOTO_NOT_FOUND', async () => {
    const ctx = setup()
    const { id } = await finished(ctx, 'glow')
    const { url } = (await getScan(ctx, id)).result.seen[0].overlay

    ctx.advanceClock(PHOTO_LINK_LIFETIME - SECOND)
    await expect(asUser(() => ctx.service.photoForLink(tokenOfLink(url)))).resolves.toMatchObject({ mediaType: 'image/png' })

    ctx.advanceClock(2 * SECOND)
    const error = await errorOf(asUser(() => ctx.service.photoForLink(tokenOfLink(url))))
    expect(error).toBeInstanceOf(NotFoundError)
    expect(error.code).toBe('PHOTO_NOT_FOUND')
  })

  it('links the mask of a faint concern but of no concern outside the goal: hd_moisture (62, above the line) opens its mask, hd_acne (not a glow concern) opens none', async () => {
    const ctx = setup()
    const { id } = await finished(ctx, 'glow')

    const view = await getScan(ctx, id)

    const links = [...JSON.stringify(view).matchAll(/\/photos\/([A-Za-z0-9_-]+)/g)].map((match) => match[1]!)
    expect(links.length).toBeGreaterThanOrEqual(2)
    const opened = await Promise.all(links.map(async (token) => new TextDecoder().decode((await asUser(() => ctx.service.photoForLink(token))).bytes)))
    expect(opened).toContain(maskUrl('radiance'))
    expect(opened).toContain(maskUrl('moisture'))
    expect(opened).not.toContain(maskUrl('acne'))
  })

  it('shows texture as faint, in "Skin looks smooth", with a link that opens its mask, when it scored above its cut-off of 40', async () => {
    const ctx = setup()
    const id = await readyUnder(ctx, 'glow', analysisOf(glowScores(65, 32, 88)))

    const { seen } = await resultOf(ctx, id)

    expect(seen.map((item: { concern: string; level: string }) => [item.concern, item.level])).toEqual([
      ['glow', 'some'],
      ['dryness', 'a-little'],
      ['texture', 'faint'],
    ])
    expect(seen[2]).toEqual({ concern: 'texture', region: 'whole', level: 'faint', words: 'Skin looks smooth', overlay: { url: expect.stringMatching(LINK) } })
    expect(await bytesBehind(ctx, seen[2].overlay.url)).toBe(maskUrl('texture'))
  })

  it('shows all three as faint and says nothing stands out, with a link to each mask, when every concern of the goal scored above its cut-off', async () => {
    const ctx = setup()
    const id = await readyUnder(ctx, 'glow', analysisOf(glowScores(76, 90, 100)))

    const result = await resultOf(ctx, id)

    expect(result.seen.map((item: { level: string; words: string }) => [item.level, item.words])).toEqual([
      ['faint', 'An even glow across the face'],
      ['faint', 'Hardly any dry patches'],
      ['faint', 'Skin looks smooth'],
    ])
    expect(result.nothingStandsOut).toBe('Nothing stands out for your goal right now')
    const opened = await Promise.all(result.seen.map((item: { overlay: { url: string } }) => bytesBehind(ctx, item.overlay.url)))
    expect(opened).toEqual([maskUrl('radiance'), maskUrl('moisture'), maskUrl('texture')])
  })

  it('says nothing stands out, and shows nothing, when Perfect Corp returned none of the goal\'s concerns', async () => {
    const ctx = setup()
    const id = await readyUnder(ctx, 'glow', analysisOf({ hd_acne: 10 }))

    const result = await resultOf(ctx, id)

    expect(result.seen).toEqual([])
    expect(result.nothingStandsOut).toBe('Nothing stands out for your goal right now')
    expect(JSON.stringify(result)).not.toMatch(LINK)
  })

  it('has no skin type and no skin age when Perfect Corp read none, and is still ready', async () => {
    const ctx = setup()
    const id = await readyUnder(ctx, 'glow', analysed({ skinTypes: [], skinAge: null }))

    const view = await getScan(ctx, id)

    expect(view.state).toBe('ready')
    expect(view.result).toMatchObject({ skinType: null, skinAge: null })
    expect(view.result.seen.length).toBeGreaterThan(0)
  })

  it('rounds the skin age to a whole number of years', async () => {
    const ctx = setup()
    const id = await readyUnder(ctx, 'glow', analysed({ skinAge: 28.6 }))

    expect((await resultOf(ctx, id)).skinAge).toEqual({ years: 29, words: 'Your skin looks about 29' })
  })

  it('reads the whole-face score for a concern that Perfect Corp also scored by region', async () => {
    const ctx = setup()
    const id = await readyUnder(
      ctx,
      'glow',
      analysed({
        concerns: [
          { concern: 'hd_radiance', region: 'left_cheek', rawScore: 20, uiScore: 25, maskUrls: [] },
          { concern: 'hd_radiance', region: 'whole', rawScore: 70, uiScore: 75, maskUrls: [maskUrl('radiance')] },
        ],
      }),
    )

    expect((await resultOf(ctx, id)).seen).toEqual([{ concern: 'glow', region: 'whole', level: 'a-little', words: 'A little less glow in places', overlay: { url: expect.stringMatching(LINK) } }])
  })

  it('names the version of the rules in force now, not the one the scan was stored under: the words are worked out when read', async () => {
    const ctx = setup()
    const { id } = await finished(ctx, 'glow')
    await ctx.repository.updateFaceScan(id, 'ready', { tablesVersion: 'concerns:0,visibility:0,wording:0,skin-type:0,change:0', updatedAt: ctx.now() })

    expect((await resultOf(ctx, id)).tablesVersion).toBe(TABLES_VERSION)
  })

  it.each([
    ['analysing', async (ctx: Ctx) => (await uploaded(ctx)).id],
    ['needs-retake', async (ctx: Ctx) => {
      const { id } = await uploaded(ctx)
      ctx.perfectCorp.script('getSkinAnalysis', new PerfectCorpRejectedPhotoError('too-dark'))
      await fetchStep(ctx, id)
      return id
    }],
    ['failed', async (ctx: Ctx) => {
      const { id } = await uploaded(ctx)
      await failScan(ctx, id)
      return id
    }],
  ] as const)('has result null for a scan that is %s', async (state, make) => {
    const ctx = setup()
    const id = await make(ctx)

    const view = await getScan(ctx, id)

    expect(view.state).toBe(state)
    expect(view.result).toBeNull()
  })

  it('answers a new scan with result null, and a retaken one too', async () => {
    const ctx = setup()
    await giveConsent(ctx)
    await setGoal(ctx, 'glow')
    const created = await asUser(() => ctx.service.create({ front: face(1) }))
    ctx.perfectCorp.script('createSkinAnalysis', new PerfectCorpRejectedPhotoError('no-face'))
    await upload(ctx, created.id)

    const retaken = await retake(ctx, created.id, face(9))

    expect(created).toHaveProperty('result', null)
    expect(retaken).toHaveProperty('result', null)
  })
})

describe('FaceScanService.getFaceScan: the change since day one', () => {
  // Day one is the profile's earliest READY scan under the scan's goal within the chase the scan's own time falls in: the chase comes from the goal
  // history (a goal left and taken up again within 90 days is the same chase), and a scan under another goal never ends one. The second ready scan of
  // a chase is its check-in, taken at the review point.

  it('has no change for the first ready scan, and has one for the chase\'s check-in, worked out against the first', async () => {
    const ctx = setup()
    const first = await readyUnder(ctx, 'glow', analysisOf(glowScores(40, 50, 55), { skinAge: 31 }))
    // readyUnder moves the clock on a scan spacing before it makes the scan.
    const firstAt = new Date(T0.getTime() + SCAN_SPACING)
    await takenUnder(ctx, 'brighter')
    const second = await checkInReadyUnder(ctx, 'glow', analysisOf(glowScores(46, 44, 55), { skinAge: 34 }), first)

    expect((await resultOf(ctx, first)).sinceDayOne).toBeNull()
    expect((await resultOf(ctx, second)).sinceDayOne).toEqual({
      dayOneScanId: first,
      dayOneAt: firstAt,
      concerns: [
        { concern: 'glow', change: 'fainter', words: 'More glow than on day one' },
        { concern: 'dryness', change: 'more-visible', words: 'Skin looks drier than on day one' },
        { concern: 'texture', change: 'no-clear-change', words: 'No clear change in smoothness since day one' },
      ],
      skinAge: { change: 'older', words: 'Your skin looks about 3 years older than on day one' },
    })
  })

  it('does not change the first scan\'s own view when a later one is taken', async () => {
    const ctx = setup()
    const first = await readyUnder(ctx, 'glow', analysisOf(glowScores(40, 50, 55)))
    const before = await getScan(ctx, first)
    // A link lives 5 minutes from its read and the later scans are days on, so what the earlier links open is read now, while they are good.
    const bytesBefore = await Promise.all(before.result.seen.map(async (item: { overlay: { url: string } }) => bytesBehind(ctx, item.overlay.url)))
    await takenUnder(ctx, 'brighter')
    await checkInReadyUnder(ctx, 'glow', analysisOf(glowScores(46, 44, 55)), first)

    const after = await getScan(ctx, first)

    // Each read signs fresh overlay links that live 5 minutes from that read, so only the token differs; everything the links point to stays.
    const withoutTokens = (result: unknown) => JSON.parse(JSON.stringify(result).replace(/\/photos\/[A-Za-z0-9_-]+/g, '/photos/<token>')) as unknown
    expect(withoutTokens(after.result)).toEqual(withoutTokens(before.result))
    // The stripped comparison cannot tell a link to the right mask from a link to another one: open both and compare the bytes.
    const overlaid = before.result.seen.filter((item: { overlay: unknown }) => item.overlay !== null)
    expect(overlaid.length).toBeGreaterThan(0)
    for (const [index, item] of before.result.seen.entries()) {
      expect(after.result.seen[index].concern).toBe(item.concern)
      if (item.overlay === null) {
        expect(after.result.seen[index].overlay).toBeNull()
        continue
      }
      expect(await bytesBehind(ctx, after.result.seen[index].overlay.url)).toBe(bytesBefore[index])
    }
  })

  it('reads all three of the goal\'s concerns, shown now or not, and leaves out one that is missing on either scan', async () => {
    const ctx = setup()
    const first = await readyUnder(ctx, 'glow', analysisOf({ hd_radiance: 50, hd_texture: 50 }))
    await takenUnder(ctx, 'brighter')
    const second = await checkInReadyUnder(ctx, 'glow', analysisOf({ hd_radiance: 80, hd_moisture: 20 }), first)

    const { sinceDayOne } = await resultOf(ctx, second)

    expect(sinceDayOne.dayOneScanId).toBe(first)
    expect(sinceDayOne.concerns).toEqual([{ concern: 'glow', change: 'fainter', words: 'More glow than on day one' }])
  })

  it('has no skin age change when the day-one scan had no skin age', async () => {
    const ctx = setup()
    const first = await readyUnder(ctx, 'glow', analysisOf(glowScores(40, 50, 55), { skinAge: null }))
    await takenUnder(ctx, 'brighter')
    const second = await checkInReadyUnder(ctx, 'glow', analysisOf(glowScores(46, 44, 55), { skinAge: 34 }), first)

    const { sinceDayOne } = await resultOf(ctx, second)

    expect(sinceDayOne.skinAge).toBeNull()
    expect(sinceDayOne.concerns).toHaveLength(3)
  })

  it('counts a change of exactly the noise as no clear change, and one point more as a change', async () => {
    const ctx = setup()
    const first = await readyUnder(ctx, 'glow', analysisOf(glowScores(40, 50, 55), { skinAge: 31 }))
    await takenUnder(ctx, 'brighter')
    // radiance +5 exactly, moisture -5.5, texture +5.5; skin age +2 exactly.
    const second = await checkInReadyUnder(ctx, 'glow', analysisOf(glowScores(45, 44.5, 60.5), { skinAge: 33 }), first)

    const { sinceDayOne } = await resultOf(ctx, second)

    expect(sinceDayOne.concerns.map((concern: { change: string }) => concern.change)).toEqual(['no-clear-change', 'more-visible', 'fainter'])
    expect(sinceDayOne.skinAge).toEqual({ change: 'no-clear-change', words: 'No clear change in skin age since day one' })
  })

  it('does not count a scan that is still analysing, or one that failed, as a day one or as a break in the run', async () => {
    const ctx = setup()
    const first = await readyUnder(ctx, 'glow', analysisOf(glowScores(40, 50, 55)))
    const other = await takenUnder(ctx, 'brighter')
    const second = await checkInReadyUnder(ctx, 'glow', analysisOf(glowScores(46, 44, 55)), first)

    // Still analysing, then failed: both leave the second scan compared with the first.
    expect((await resultOf(ctx, second)).sinceDayOne.dayOneScanId).toBe(first)
    await failScan(ctx, other)
    expect((await resultOf(ctx, second)).sinceDayOne.dayOneScanId).toBe(first)
  })

  it('does not count a scan that needs a retake as a break in the run', async () => {
    const ctx = setup()
    const first = await readyUnder(ctx, 'glow', analysisOf(glowScores(40, 50, 55)))
    const other = await takenUnder(ctx, 'brighter')
    ctx.perfectCorp.script('getSkinAnalysis', new PerfectCorpRejectedPhotoError('turn-to-camera'))
    await fetchStep(ctx, other)
    expect(await rowOf(ctx, other)).toMatchObject({ state: 'needs-retake' })
    const second = await checkInReadyUnder(ctx, 'glow', analysisOf(glowScores(46, 44, 55)), first)

    expect((await resultOf(ctx, second)).sinceDayOne.dayOneScanId).toBe(first)
  })

  it('never takes a failed scan for the day one: the first scan that is ready is its own', async () => {
    const ctx = setup()
    const failed = await takenUnder(ctx, 'glow')
    await failScan(ctx, failed)
    const ready = await readyUnder(ctx, 'glow', analysisOf(glowScores(40, 50, 55)))

    expect((await rowOf(ctx, failed)).state).toBe('failed')
    expect((await resultOf(ctx, ready)).sinceDayOne).toBeNull()
  })

  // The chase, not the scans, decides the day one (issue #145): a short detour to another goal is a break in the chase, not the end of it, so the
  // progress the user had on the goal they come back to still counts. The goal history says when the goal was left and taken up again.
  it('keeps the day one across a short detour: the scan under the new goal has none of its own, and the check-in after going back still compares with the first', async () => {
    const ctx = setup()
    const glowFirst = await readyUnder(ctx, 'glow', analysisOf(glowScores(40, 50, 55)))
    const brighter = await readyUnder(ctx, 'brighter', analysisOf(brighterScores(40, 50, 55)))
    const glowAgain = await checkInReadyUnder(ctx, 'glow', analysisOf(glowScores(46, 44, 55)), glowFirst)

    expect((await resultOf(ctx, glowFirst)).sinceDayOne).toBeNull()
    // Brighter's own chase starts with this scan, so it has nothing to compare with.
    expect((await resultOf(ctx, brighter)).sinceDayOne).toBeNull()
    // Glow was left for six weeks, inside the 90-day window, so its chase never ended and its first scan is still day one.
    expect((await resultOf(ctx, glowAgain)).sinceDayOne).toMatchObject({ dayOneScanId: glowFirst })
  })

  it('starts a fresh day one for a goal taken up again more than 90 days after it was left, and leaves the older chase as it was', async () => {
    const ctx = setup()
    const first = await readyUnder(ctx, 'glow', analysisOf(glowScores(40, 50, 55)))
    await readyUnder(ctx, 'brighter', analysisOf(brighterScores(40, 50, 55)))
    const second = await checkInReadyUnder(ctx, 'glow', analysisOf(glowScores(46, 44, 55)), first)
    // Glow is left for brighter, and comes back more than 90 days later: the first chase is over and a new one begins with nothing to compare with.
    ctx.advanceClock(DAY)
    await takenUnder(ctx, 'brighter')
    ctx.advanceClock(FRESH_GAP - DAY)
    const freshStart = await readyUnder(ctx, 'glow', analysisOf(glowScores(50, 50, 55)))

    expect((await resultOf(ctx, freshStart)).sinceDayOne).toBeNull()
    // A scan is read against the chase its own time falls in, whatever chase the profile is in now.
    expect((await resultOf(ctx, second)).sinceDayOne).toMatchObject({ dayOneScanId: first })
  })

  it('compares the check-in with the first scan of its own chase, not with the scan taken just before it', async () => {
    const ctx = setup()
    // The chase's first scan reads differently from the scan just before the check-in, so which of them is day one shows in the words. The one just
    // before is under another goal, which also scores hd_radiance, so a day one taken by date alone would be it.
    const chaseStart = await readyUnder(ctx, 'glow', analysisOf(glowScores(90, 90, 90)))
    await readyUnder(ctx, 'brighter', analysisOf(brighterScores(40, 50, 55)))
    const latest = await checkInReadyUnder(ctx, 'glow', analysisOf(glowScores(50, 50, 55)), chaseStart)

    const { sinceDayOne } = await resultOf(ctx, latest)

    expect(sinceDayOne.dayOneScanId).toBe(chaseStart)
    // Radiance 90 on day one against 50 now is a fall, not the rise it would be against the 40 of the scan just before.
    expect(sinceDayOne.concerns[0]).toEqual({ concern: 'glow', change: 'more-visible', words: 'Less glow than on day one' })
  })

  // Nothing about day one is stored: it is the earliest ready scan of the chase that is still there when the result is read. A chase holds its day
  // one and its check-in, so deleting the day one leaves the check-in with nothing to compare with.
  it('leaves the check-in its own day one when the day-one scan is deleted', async () => {
    const ctx = setup()
    const first = await readyUnder(ctx, 'glow', analysisOf(glowScores(90, 90, 90)))
    await takenUnder(ctx, 'brighter')
    const checkIn = await checkInReadyUnder(ctx, 'glow', analysisOf(glowScores(50, 50, 55)), first)
    expect((await resultOf(ctx, checkIn)).sinceDayOne.dayOneScanId).toBe(first)

    await asUser(() => ctx.service.deleteFaceScan(first))

    expect((await resultOf(ctx, checkIn)).sinceDayOne).toBeNull()
  })

  it('does not compare with another profile\'s scan', async () => {
    const ctx = setup()
    // Another profile of the same account has a ready scan under the same goal, taken earlier.
    await giveConsent(ctx, OTHER_PROFILE)
    ctx.advanceClock(DAY)
    await setGoal(ctx, 'glow', OTHER_PROFILE)
    const others = (await asUser(() => ctx.service.create({ front: face(5) }), OTHER_PROFILE)).id
    await upload(ctx, others)
    ctx.perfectCorp.script('getSkinAnalysis', analysisOf(glowScores(40, 50, 55)))
    await fetchStep(ctx, others)
    expect((await rowOf(ctx, others)).state).toBe('ready')

    const mine = await readyUnder(ctx, 'glow', analysisOf(glowScores(46, 44, 55)))

    expect((await resultOf(ctx, mine)).sinceDayOne).toBeNull()
  })
})

// The check-in scan at a chase's review point looks wider than a normal scan: it asks Perfect Corp for every concern the app can show plus the skin
// type (10 actions, 20 units, against the 5 to 8 actions and 16 units of a normal scan), whatever the goal, and every score it reads is stored. What
// it SHOWS is unchanged (issue #145): the goal's own three concerns as `seen`, the measured core extras that can be seen as `alsoNoticed`, and the
// concerns outside what the goal measures never, however plainly they could be seen. Those serve the next-goal rule alone.
describe('FaceScanService: the check-in scan at the review point', () => {
  /**
   * Perfect Corp's answer to a glow check-in: all nine concerns, whole face, each with a mask of its own. Glow measures radiance, moisture and texture
   * (its own) then the core age spot, acne, pore and oiliness; redness and the dark circle are outside that, and are scored here well inside their
   * visible cut-offs, so only the rule can be keeping them out of the view. Acne and pore are above theirs, which is the faint rule, not this one.
   */
  const checkInScores = {
    hd_radiance: 44,
    hd_moisture: 32,
    hd_texture: 40,
    hd_age_spot: 52,
    hd_acne: 70,
    hd_pore: 65,
    hd_oiliness: 58,
    hd_redness: 48,
    hd_dark_circle: 36,
  }
  /** The ten actions a check-in asks for, written out from the issue: every concern the app can show, then the skin type. */
  const CHECK_IN_ACTIONS = [
    'hd_acne',
    'hd_pore',
    'hd_oiliness',
    'hd_age_spot',
    'hd_redness',
    'hd_radiance',
    'hd_texture',
    'hd_dark_circle',
    'hd_moisture',
    'hd_skin_type',
  ]
  /** What a normal glow scan asks for: its own three, then the core concerns it lacks, then the skin type. */
  const GLOW_ACTIONS = ['hd_radiance', 'hd_moisture', 'hd_texture', 'hd_age_spot', 'hd_acne', 'hd_pore', 'hd_oiliness', 'hd_skin_type']
  /** The concerns outside what glow measures, by their public ids: a check-in reads them and the API never returns them. */
  const OUTSIDE_GLOW = /"(redness|under-eyes)"/

  it('asks for every concern plus the skin type at the check-in, where a normal glow scan asks for its three, the core extras and the skin type', async () => {
    const ctx = setup()
    const dayOne = await readyUnder(ctx, 'glow', analysisOf(glowScores(40, 50, 55)))

    await checkInTakenUnder(ctx, 'glow', dayOne)

    expect(callsOf(ctx, 'createSkinAnalysis').map((call) => (call.args[0] as { actions: string[] }).actions)).toEqual([GLOW_ACTIONS, CHECK_IN_ACTIONS])
  })

  it('asks for the same ten actions at a check-in whatever the goal: a clear-skin check-in reads the whole nine too', async () => {
    const ctx = setup()
    const dayOne = await readyUnder(ctx, 'clear-skin', analysisOf({ hd_acne: 60, hd_pore: 40, hd_oiliness: 70, hd_age_spot: 80 }))

    await checkInTakenUnder(ctx, 'clear-skin', dayOne)

    expect((callsOf(ctx, 'createSkinAnalysis')[1]!.args[0] as { actions: string[] }).actions).toEqual(CHECK_IN_ACTIONS)
  })

  it('records 20 units for the check-in, against the 16 of a normal scan, each keyed by its own task', async () => {
    const ctx = setup()
    const dayOne = await uploaded(ctx, 'glow')
    ctx.perfectCorp.script('getSkinAnalysis', analysisOf(glowScores(40, 50, 55)))
    await fetchStep(ctx, dayOne.id)
    const checkIn = await checkInTakenUnder(ctx, 'glow', dayOne.id)
    ctx.perfectCorp.script('getSkinAnalysis', analysisOf(checkInScores))

    await fetchStep(ctx, checkIn.id)

    expect(ctx.aiUsage.recorded).toEqual([
      { vendor: 'perfect-corp', job: 'face-analysis', units: 16, key: dayOne.analysisTask },
      { vendor: 'perfect-corp', job: 'face-analysis', units: 20, key: checkIn.analysisTask },
    ])
  })

  it('shows the goal\'s three concerns as seen on the check-in\'s result, and the core extras that can be seen as also noticed', async () => {
    const ctx = setup()
    const dayOne = await readyUnder(ctx, 'glow', analysisOf(glowScores(40, 50, 55)))
    const checkIn = await checkInReadyUnder(ctx, 'glow', analysisOf(checkInScores), dayOne)

    const result = await resultOf(ctx, checkIn)

    expect(result.seen.map((item: { concern: string }) => item.concern)).toEqual(['glow', 'dryness', 'texture'])
    // Core order: marks (52, clear) and shine (58, clear); spots (70) and pores (65) are above their cut-offs, so they are faint and not noticed.
    expect(result.alsoNoticed.map((item: { concern: string }) => item.concern)).toEqual(['marks', 'shine'])
    expect(result.sinceDayOne.concerns.map((item: { concern: string }) => item.concern)).toEqual(['glow', 'dryness', 'texture'])
  })

  it('never returns the concerns outside what the goal measures, though the check-in read them well inside their visible cut-offs', async () => {
    const ctx = setup()
    const dayOne = await readyUnder(ctx, 'glow', analysisOf(glowScores(40, 50, 55)))
    const checkIn = await checkInReadyUnder(ctx, 'glow', analysisOf(checkInScores), dayOne)

    const view = await getScan(ctx, checkIn)

    expect(JSON.stringify(view)).not.toMatch(OUTSIDE_GLOW)
    for (const item of [...view.result.seen, ...view.result.alsoNoticed]) expect(['redness', 'under-eyes']).not.toContain(item.concern)
  })

  it('keeps a mask for the concerns the goal measures, and none for those outside them, though Perfect Corp sent one for all nine', async () => {
    const ctx = setup()
    const dayOne = await readyUnder(ctx, 'glow', analysisOf(glowScores(40, 50, 55)))
    const checkIn = await checkInReadyUnder(ctx, 'glow', analysisOf(checkInScores), dayOne)

    const concerns = (await ctx.repository.masksOf(checkIn)).map((mask) => mask.concern)

    expect(concerns.sort()).toEqual([...measuredConcernsForGoal('glow')].sort())
    expect(concerns).not.toContain('hd_redness')
    expect(concerns).not.toContain('hd_dark_circle')
    expect(masksStored(ctx).filter((key) => key.includes(checkIn))).toHaveLength(measuredConcernsForGoal('glow').length)
  })

  // The concerns outside the goal are stored like any other score, so the next-goal rule has them to read; the view above is what proves they are never
  // shown. The stored rows are read here directly because by design nothing in the API exposes them.
  it('stores every concern the check-in read, the ones outside the goal included', async () => {
    const ctx = setup()
    const dayOne = await readyUnder(ctx, 'glow', analysisOf(glowScores(40, 50, 55)))
    const checkIn = await checkInReadyUnder(ctx, 'glow', analysisOf(checkInScores), dayOne)

    const rows = await ctx.repository.resultsOf(checkIn)

    expect(rows.map((row) => row.concern).sort()).toEqual([...Object.keys(checkInScores), 'all'].sort())
    expect(rows.find((row) => row.concern === 'hd_redness')).toMatchObject({ region: 'whole', rawScore: 48 })
    expect(rows.find((row) => row.concern === 'hd_dark_circle')).toMatchObject({ region: 'whole', rawScore: 36 })
  })
})

describe('FaceScanService.getFaceScan: what the result never shows', () => {
  /** Every number in a value, by where it is. */
  const numbersIn = (value: unknown, path = ''): string[] =>
    typeof value === 'number'
      ? [path]
      : value !== null && typeof value === 'object'
        ? Object.entries(value).flatMap(([key, inner]) => numbersIn(inner, `${path}.${key}`))
        : []

  /** A scan with a change since day one, a skin age change, a skin type, masks, and a Fitzpatrick type of 'V' on the profile. */
  const withEverything = async (ctx: Ctx) => {
    const first = await readyUnder(ctx, 'glow', analysisOf(glowScores(40, 50, 55), { skinAge: 31, all: 63 }))
    ctx.perfectCorp.script('getFitzpatrick', { status: 'success', fitzpatrick: 'V' })
    await fitzpatrickStep(ctx, first)
    await takenUnder(ctx, 'brighter')
    const second = await checkInReadyUnder(ctx, 'glow', analysisOf(glowScores(46, 44, 55), { skinAge: 34, all: 71 }), first)
    expect((await ctx.repository.fitzpatrickOf(PROFILE))?.fitzpatrick).toBe('V')
    return second
  }

  it('holds no Perfect Corp name, no score, no overall score, no Fitzpatrick type and no condition anywhere in the view', async () => {
    const ctx = setup()
    const id = await withEverything(ctx)

    const view = await getScan(ctx, id)
    // The link tokens are random base64url text, which could hold "hd_" by chance; they are not what is being looked at.
    const text = JSON.stringify(view).replace(/\/photos\/[A-Za-z0-9_-]+/g, '/photos/<token>')

    expect(view.result.sinceDayOne).not.toBeNull()
    expect(text).not.toMatch(/hd_|raw_?score|ui_?score|fitzpatrick|skin_?type_?label/i)
    expect(text).not.toMatch(/"all"/)
    expect(text).not.toMatch(/"(?:I|II|III|IV|V|VI)"/)
    expect(text).not.toMatch(/you have|diagnos|melasma|rosacea|acne|eczema/i)
  })

  it('holds no number but the skin age in years', async () => {
    const ctx = setup()
    const id = await withEverything(ctx)

    const view = JSON.parse(JSON.stringify(await getScan(ctx, id)))

    expect(numbersIn(view.result)).toEqual(['.skinAge.years'])
  })

  it('puts no digit in the seen-words, in the change words or in nothing-stands-out', async () => {
    const ctx = setup()
    const id = await withEverything(ctx)
    const { result } = await getScan(ctx, id)

    const words = [...result.seen.map((seen: { words: string }) => seen.words), ...result.sinceDayOne.concerns.map((concern: { words: string }) => concern.words)]

    expect(words.length).toBeGreaterThan(2)
    for (const text of words) expect(text).not.toMatch(/\d/)
    expect(JSON.stringify(result.seen.map((seen: { region: string }) => seen.region))).not.toMatch(/\d/)
  })

  it('names each concern by its public id and nothing else', async () => {
    const ctx = setup()
    const id = await withEverything(ctx)
    const { result } = await getScan(ctx, id)

    expect(result.seen.map((seen: { concern: string }) => seen.concern)).toEqual(['glow', 'dryness', 'texture'])
    expect(result.sinceDayOne.concerns.map((concern: { concern: string }) => concern.concern)).toEqual(['glow', 'dryness', 'texture'])
  })
})


// --- the profile's list of face scans ---
//
// `listFaceScans()` is `GET /scans/faces`: the current profile's scans, latest first, each the very view `getFaceScan` gives, every state included, cut
// at 20. Scans are made the way a person makes them and brought to the state a test needs by the pipeline's own steps. None of the scans here is ever
// ready, so a chase that has had its scan has no day one and so no check-in to take either: the way to the next scan is the goal starting fresh, which
// it does once it has been left for longer than the 90-day resume window (issue #145).

/** The cap the brief sets: the latest 20 scans. Written out here so the test does not take it from the code it checks. */
const LIST_CAP = 20
const OTHER_USER = 'user-2'
const OTHER_ACCOUNT_PROFILE = 'profile-3'

const listScans = (ctx: Ctx, profileId = PROFILE): Promise<any[]> => asUser(() => ctx.service.listFaceScans(), profileId)
const asOtherAccount = <T>(fn: () => Promise<T>) => runAs({ kind: 'user', userId: OTHER_USER, status: 'verified', profileId: OTHER_ACCOUNT_PROFILE }, fn)
/** A scan by a profile of the account (`profileId`) under `goal`: consent, the goal and the front photo, the way the create route takes it. Resolves to the scan's id. */
const startedBy = async (ctx: Ctx, profileId: string, goal: Goal): Promise<string> => {
  await giveConsent(ctx, profileId)
  await setGoal(ctx, goal, profileId)
  return (await asUser(() => ctx.service.create({ front: face(5) }), profileId)).id
}
const GOAL_CYCLE: Goal[] = ['glow', 'brighter']
/**
 * `count` scans under alternating goals, none finished, oldest first. Each is taken a whole resume window and a day after the last, so every goal
 * taken up again has started fresh and is due a scan of its own. Resolves to their ids.
 */
const manyScans = async (ctx: Ctx, count: number): Promise<string[]> => {
  const ids: string[] = []
  for (let n = 0; n < count; n += 1) {
    ctx.advanceClock(FRESH_GAP - DAY)
    ids.push(await takenUnder(ctx, GOAL_CYCLE[n % GOAL_CYCLE.length]!))
  }
  return ids
}
/** One scan in each state, oldest first: ready (glow), failed (brighter), needs-retake (clear-skin) and analysing (even-tone). */
const oneInEachState = async (ctx: Ctx) => {
  const ready = await readyUnder(ctx, 'glow', analysed())
  const failed = await takenUnder(ctx, 'brighter')
  await failScan(ctx, failed)
  const needsRetake = await takenUnder(ctx, 'clear-skin')
  ctx.perfectCorp.script('getSkinAnalysis', new PerfectCorpRejectedPhotoError('too-dark'))
  await fetchStep(ctx, needsRetake)
  const analysing = await takenUnder(ctx, 'even-tone')
  return { ready, failed, needsRetake, analysing }
}

describe('FaceScanService.listFaceScans', () => {
  it('lists the latest 20 scans, and the cap is exported as FACE_SCAN_LIST_LIMIT from the service module', () => {
    expect(FACE_SCAN_LIST_LIMIT).toBe(LIST_CAP)
  })

  it('lists nothing, without an error, for a profile that has no scans, no consent and no goal', async () => {
    const ctx = setup()

    expect(await listScans(ctx)).toEqual([])
  })

  it('refuses a caller who is not signed in with 401 AUTH_REQUIRED', async () => {
    const ctx = setup()

    const error = await errorOf(runAs({ kind: 'public' }, () => ctx.service.listFaceScans()))

    expect(error).toBeInstanceOf(UnauthorizedError)
    expect(error.code).toBe('AUTH_REQUIRED')
  })

  it('lists the profile\'s scans latest first', async () => {
    const ctx = setup()
    const [first, second, third] = await manyScans(ctx, 3)

    const listed = await listScans(ctx)

    expect(listed.map((scan) => scan.id)).toEqual([third, second, first])
    expect(listed.map((scan) => scan.goal)).toEqual(['glow', 'brighter', 'glow'])
  })

  it('lists exactly 20 scans when there are 20, and only the latest 20 when a 21st is taken: the oldest drops off', async () => {
    const ctx = setup()
    const ids = await manyScans(ctx, LIST_CAP)
    expect((await listScans(ctx)).map((scan) => scan.id)).toEqual([...ids].reverse())

    ctx.advanceClock(FRESH_GAP - DAY)
    ids.push(await takenUnder(ctx, GOAL_CYCLE[LIST_CAP % GOAL_CYCLE.length]!))

    const listed = (await listScans(ctx)).map((scan) => scan.id)
    expect(listed).toHaveLength(LIST_CAP)
    expect(listed).toEqual(ids.slice(1).reverse())
    expect(listed).not.toContain(ids[0])
  })

  it('lists a scan whatever state it is in: ready with its result, needs-retake and failed with their reasons, analysing with none', async () => {
    const ctx = setup()
    const { ready, failed, needsRetake, analysing } = await oneInEachState(ctx)

    const listed = await listScans(ctx)

    expect(listed.map((scan) => [scan.id, scan.state, scan.reason])).toEqual([
      [analysing, 'analysing', null],
      [needsRetake, 'needs-retake', 'too-dark'],
      [failed, 'failed', 'unavailable'],
      [ready, 'ready', null],
    ])
    expect(listed.map((scan) => scan.result !== null)).toEqual([false, false, false, true])
    expect(listed[3].result.seen.length).toBeGreaterThan(0)
  })

  it('shows each scan as getFaceScan shows it, links and rescanSuggested included', async () => {
    const ctx = setup()
    await oneInEachState(ctx)
    // The profile moves on to a goal none of its scans were taken under, so every view says a rescan is worth it.
    ctx.advanceClock(SCAN_SPACING)
    await setGoal(ctx, 'calm-repair')

    const listed = await listScans(ctx)

    expect(listed).toHaveLength(4)
    for (const scan of listed) expect(scan).toEqual(await getScan(ctx, scan.id))
    expect(listed.map((scan) => scan.rescanSuggested)).toEqual([true, true, true, true])
    expect(Object.keys(listed[0]).sort()).toEqual(['createdAt', 'goal', 'id', 'photos', 'reason', 'rescanSuggested', 'result', 'state'])
  })

  it('shows rescanSuggested false on every scan while the goal is the one the latest scan was taken under', async () => {
    const ctx = setup()
    await manyScans(ctx, 3)

    const listed = await listScans(ctx)

    expect(listed.map((scan) => scan.rescanSuggested)).toEqual([false, false, false])
    for (const scan of listed) expect(scan).toEqual(await getScan(ctx, scan.id))
  })

  it('shows the change since day one on a ready scan as getFaceScan does', async () => {
    const ctx = setup()
    const first = await readyUnder(ctx, 'glow', analysisOf(glowScores(40, 50, 55), { skinAge: 31 }))
    await takenUnder(ctx, 'brighter')
    const second = await checkInReadyUnder(ctx, 'glow', analysisOf(glowScores(46, 44, 55), { skinAge: 34 }), first)

    const listed = await listScans(ctx)

    expect(listed.map((scan) => scan.id)).toEqual([second, expect.any(String), first])
    expect(listed[0].result.sinceDayOne).toMatchObject({ dayOneScanId: first })
    expect(listed[0]).toEqual(await getScan(ctx, second))
    expect(listed[2].result.sinceDayOne).toBeNull()
  })

  // A chase holds its day one and its one check-in (issue #145), so the day one's scores are read twice for a list: once as its own result, and once
  // as the scan the check-in is compared with. The shared read this test was written for no longer shows, because no chase can hold a third ready
  // scan to share it with.
  it('reads the day-one scan\'s scores once as its own result and once for the check-in, and shows each scan as getFaceScan does', async () => {
    const repository = new ReadCountingRepository()
    const ctx = setup({ repository })
    const dayOne = await readyUnder(ctx, 'glow', analysisOf(glowScores(40, 50, 55)))
    await takenUnder(ctx, 'brighter')
    const checkIn = await checkInReadyUnder(ctx, 'glow', analysisOf(glowScores(46, 44, 55)), dayOne)
    repository.resultsRead.length = 0

    const listed = await listScans(ctx)

    expect(repository.resultsRead.filter((id) => id === dayOne)).toHaveLength(2)
    expect(listed.filter((scan) => scan.result?.sinceDayOne?.dayOneScanId === dayOne).map((scan) => scan.id)).toEqual([checkIn])
    for (const scan of listed) expect(scan).toEqual(await getScan(ctx, scan.id))
  })

  it('gives overlay and photo links that open, for the bytes of the mask and of the photo', async () => {
    const ctx = setup()
    const id = await readyUnder(ctx, 'glow', analysed())

    const [scan] = await listScans(ctx)

    expect(scan.id).toBe(id)
    expect(await bytesBehind(ctx, scan.result.seen[0].overlay.url)).toBe(maskUrl('radiance'))
    const photo = await asUser(() => ctx.service.photoForLink(tokenOfLink(scan.photos.front.url)))
    expect(photo.mediaType).toBe('image/jpeg')
  })

  it('lists only the current profile\'s scans: neither the account\'s other profile\'s nor another account\'s', async () => {
    const ctx = setup()
    const mine = await startedBy(ctx, PROFILE, 'glow')
    const sisters = await startedBy(ctx, OTHER_PROFILE, 'glow')
    await asOtherAccount(() => ctx.service.giveConsent(CURRENT_FACE_CONSENT_VERSION))
    await asOtherAccount(() => ctx.goals.set({ goal: 'glow' }))
    const strangers = (await asOtherAccount(() => ctx.service.create({ front: face(6) }))).id

    expect((await listScans(ctx)).map((scan) => scan.id)).toEqual([mine])
    expect((await listScans(ctx, OTHER_PROFILE)).map((scan) => scan.id)).toEqual([sisters])
    expect((await asOtherAccount(() => ctx.service.listFaceScans())).map((scan: { id: string }) => scan.id)).toEqual([strangers])
  })

  it('does not let another profile\'s scans use up the cap', async () => {
    const ctx = setup()
    const mine = await manyScans(ctx, 1)
    for (let n = 0; n < LIST_CAP + 1; n += 1) {
      ctx.advanceClock(FRESH_GAP)
      await startedBy(ctx, OTHER_PROFILE, GOAL_CYCLE[n % GOAL_CYCLE.length]!)
    }

    expect((await listScans(ctx)).map((scan) => scan.id)).toEqual(mine)
  })

  it('still lists the scans after the consent is withdrawn, so the user can find them and delete them', async () => {
    const ctx = setup()
    const [first, second] = await manyScans(ctx, 2)
    await asUser(() => ctx.service.withdrawConsent())

    const listed = await listScans(ctx)

    expect(listed.map((scan) => scan.id)).toEqual([second, first])
    for (const scan of listed) expect(scan).toEqual(await getScan(ctx, scan.id))
  })

  it('still lists the scans when the profile\'s goal is typed words nobody sorted into a goal, with rescanSuggested false', async () => {
    const ctx = setup()
    const [first, second] = await manyScans(ctx, 2)
    await asUser(() => ctx.goals.set({ text: 'something the reader finds no goal in' }))

    const listed = await listScans(ctx)

    expect(listed.map((scan) => [scan.id, scan.rescanSuggested])).toEqual([[second, false], [first, false]])
  })

  it('lists a scan no more once the user deletes it', async () => {
    const ctx = setup()
    const [first, second] = await manyScans(ctx, 2)

    await asUser(() => ctx.service.deleteFaceScan(second!))

    expect((await listScans(ctx)).map((scan) => scan.id)).toEqual([first])
  })
})

describe('FaceScanService: push notifications', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const pushes = (ctx: Ctx) => ctx.pushJobs.enqueued.map((entry) => entry.body as SendPushMessage)
  const pushKeys = (ctx: Ctx) => pushes(ctx).map((body) => sendPushSpec.key(body))
  const kinds = (ctx: Ctx) => pushes(ctx).map((body) => body.kind)
  const quiet = () => (['log', 'error'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => undefined))
  const REASONS = ['too-dark', 'turn-to-camera', 'move-closer', 'face-not-centred', 'no-face', 'image-size'] as const

  /** What a needs-retake push for `id` must carry, `at` being the instant the transition was stored. */
  const retakePush = (id: string, reason: (typeof REASONS)[number], at: number) => ({ kind: 'face-scan-needs-retake', userId: USER, profileId: PROFILE, faceScanId: id, reason, at })

  describe('when the scan becomes ready', () => {
    it('queues one face-scan-ready push for the scan\'s profile, keyed by the scan, when the fetch completes it', async () => {
      const ctx = setup()

      const { id } = await finished(ctx)

      expect(pushes(ctx)).toEqual([{ kind: 'face-scan-ready', userId: USER, profileId: PROFILE, faceScanId: id }])
      expect(pushKeys(ctx)).toEqual([`face-scan-ready:${id}`])
      expect(ctx.pushJobs.enqueued[0]!.job).toBe('send-push')
    })

    it('queues nothing before the scan is ready: not on create, not after the upload, not while the analysis is still running', async () => {
      const ctx = setup()
      const id = await started(ctx)
      expect(pushes(ctx)).toEqual([])

      await upload(ctx, id)
      expect(pushes(ctx)).toEqual([])

      await fetchStep(ctx, id)
      expect((await rowOf(ctx, id)).state).toBe('analysing')
      expect(pushes(ctx)).toEqual([])
    })

    it('queues no second push when a ready scan is fetched again (a webhook that comes twice)', async () => {
      const ctx = setup()
      const { id } = await finished(ctx)

      await fetchStep(ctx, id, 'wh-late-duplicate')
      await fetchStep(ctx, id, 'wh-late-duplicate-2')

      expect(kinds(ctx)).toEqual(['face-scan-ready'])
    })

    it('queues nothing when the completion loses because the user deleted the scan while the masks were being fetched', async () => {
      const ctx = setup()
      const { id } = await uploaded(ctx)
      ctx.perfectCorp.script('getSkinAnalysis', analysed())
      ctx.perfectCorp.duringDownload = () => asUser(() => ctx.service.deleteFaceScan(id))

      await fetchStep(ctx, id)

      expect(await ctx.repository.findFaceScan(id)).toBeNull()
      expect(pushes(ctx)).toEqual([])
    })

    it('queues nothing when the completion loses because the scan failed while the masks were being fetched', async () => {
      const ctx = setup()
      const { id } = await uploaded(ctx)
      ctx.perfectCorp.script('getSkinAnalysis', analysed())
      ctx.perfectCorp.duringDownload = () => ctx.service.markFailed(id)

      await fetchStep(ctx, id)

      expect((await rowOf(ctx, id)).state).toBe('failed')
      expect(pushes(ctx)).toEqual([])
    })

    it('queues the push once, by the retry, when a first fetch attempt failed before the scan was complete', async () => {
      const ctx = setup()
      const { id } = await uploaded(ctx)
      ctx.perfectCorp.script('getSkinAnalysis', analysed(), analysed())
      ctx.perfectCorp.script('downloadMask', new PerfectCorpUnavailableError('down'))

      expect(await errorOf(fetchStep(ctx, id))).toBeInstanceOf(PerfectCorpUnavailableError)
      expect(pushes(ctx)).toEqual([])
      await fetchStep(ctx, id)

      expect(pushKeys(ctx)).toEqual([`face-scan-ready:${id}`])
    })
  })

  describe('when the photo needs a retake', () => {
    it.each([
      ['uploadFile', 'image-size'],
      ['createSkinAnalysis', 'no-face'],
    ] as const)('queues one face-scan-needs-retake push, stamped with the stored update time, when the upload step is refused at %s', async (method, reason) => {
      const ctx = setup()
      const id = await started(ctx)
      ctx.advanceClock(3 * MINUTE)
      ctx.perfectCorp.script(method, new PerfectCorpRejectedPhotoError(reason))

      await upload(ctx, id)

      const stored = (await rowOf(ctx, id)).updatedAt.getTime()
      expect(stored).toBe(T0.getTime() + 3 * MINUTE)
      expect(pushes(ctx)).toEqual([retakePush(id, reason, stored)])
      expect(pushKeys(ctx)).toEqual([`face-scan-needs-retake:${id}:${stored}`])
    })

    it.each(REASONS)('queues one face-scan-needs-retake push carrying %s, stamped with the stored update time, when the fetch step is refused', async (reason) => {
      const ctx = setup()
      const { id } = await uploaded(ctx)
      ctx.advanceClock(7 * MINUTE)
      ctx.perfectCorp.script('getSkinAnalysis', new PerfectCorpRejectedPhotoError(reason))

      await fetchStep(ctx, id, 'wh-error')

      const stored = (await rowOf(ctx, id)).updatedAt.getTime()
      expect(stored).toBe(T0.getTime() + 7 * MINUTE)
      expect(pushes(ctx)).toEqual([retakePush(id, reason, stored)])
      expect(pushKeys(ctx)).toEqual([`face-scan-needs-retake:${id}:${stored}`])
    })

    it('queues nothing when a step is delivered again after the scan went to needs-retake (a message taken over after its lease)', async () => {
      const ctx = setup()
      const { id } = await uploaded(ctx)
      ctx.perfectCorp.script('getSkinAnalysis', new PerfectCorpRejectedPhotoError('too-dark'))
      await fetchStep(ctx, id, 'wh-error')
      expect(pushes(ctx)).toHaveLength(1)

      await fetchStep(ctx, id, 'wh-error')
      await upload(ctx, id)

      expect(pushes(ctx)).toHaveLength(1)
    })

    it('queues nothing when an upload step is delivered again after its first delivery was refused', async () => {
      const ctx = setup()
      const id = await started(ctx)
      ctx.perfectCorp.script('createSkinAnalysis', new PerfectCorpRejectedPhotoError('no-face'))
      await upload(ctx, id)

      await upload(ctx, id)

      expect(pushes(ctx)).toHaveLength(1)
    })

    it('queues one push, from the step that wins the transition, when two fetch steps of one scan are both refused', async () => {
      const ctx = setup()
      const { id } = await uploaded(ctx)
      ctx.perfectCorp.script('getSkinAnalysis', new PerfectCorpRejectedPhotoError('too-dark'), new PerfectCorpRejectedPhotoError('too-dark'))

      await Promise.all([fetchStep(ctx, id, 'wh-a'), fetchStep(ctx, id, 'wh-b')])

      expect(await rowOf(ctx, id)).toMatchObject({ state: 'needs-retake', reason: 'too-dark' })
      expect(kinds(ctx)).toEqual(['face-scan-needs-retake'])
    })

    it('queues a second push, under its own key, when the retaken photo is refused again', async () => {
      const ctx = setup()
      const id = await started(ctx)
      ctx.perfectCorp.script('createSkinAnalysis', new PerfectCorpRejectedPhotoError('too-dark'))
      await upload(ctx, id)
      const firstAt = (await rowOf(ctx, id)).updatedAt.getTime()
      ctx.advanceClock(4 * MINUTE)
      await retake(ctx, id, face(9))
      expect(pushes(ctx)).toHaveLength(1)
      ctx.advanceClock(1 * MINUTE)
      ctx.perfectCorp.script('createSkinAnalysis', new PerfectCorpRejectedPhotoError('no-face'))

      await upload(ctx, id)

      const secondAt = (await rowOf(ctx, id)).updatedAt.getTime()
      expect(secondAt).toBe(firstAt + 5 * MINUTE)
      expect(pushes(ctx)).toEqual([retakePush(id, 'too-dark', firstAt), retakePush(id, 'no-face', secondAt)])
      expect(pushKeys(ctx)).toEqual([`face-scan-needs-retake:${id}:${firstAt}`, `face-scan-needs-retake:${id}:${secondAt}`])
    })

    it('queues no push for the retake itself, and then the ready push when the retaken photo is accepted', async () => {
      const ctx = setup()
      const id = await started(ctx)
      ctx.perfectCorp.script('createSkinAnalysis', new PerfectCorpRejectedPhotoError('too-dark'))
      await upload(ctx, id)
      ctx.advanceClock(2 * MINUTE)

      await retake(ctx, id, face(9))
      expect(kinds(ctx)).toEqual(['face-scan-needs-retake'])
      await upload(ctx, id)
      expect(kinds(ctx)).toEqual(['face-scan-needs-retake'])
      ctx.perfectCorp.script('getSkinAnalysis', analysed())
      await fetchStep(ctx, id)

      expect(kinds(ctx)).toEqual(['face-scan-needs-retake', 'face-scan-ready'])
    })
  })

  describe('when the scan fails', () => {
    // Every way a scan reaches `failed`: each is driven through the step or sweep that does it, and none may queue a push.
    it.each([
      [
        'Perfect Corp has no credit at the upload',
        async (ctx: Ctx, id: string) => {
          ctx.perfectCorp.script('uploadFile', new PerfectCorpCreditError('no units'))
          expect(await errorOf(upload(ctx, id))).toBeInstanceOf(PermanentJobError)
        },
      ],
      [
        'Perfect Corp calls the upload request bad',
        async (ctx: Ctx, id: string) => {
          ctx.perfectCorp.script('createSkinAnalysis', new PerfectCorpBadRequestError('bad'))
          expect(await errorOf(upload(ctx, id))).toBeInstanceOf(PermanentJobError)
        },
      ],
      [
        'the consent was withdrawn before the upload',
        async (ctx: Ctx, id: string) => {
          await asUser(() => ctx.service.withdrawConsent())
          await upload(ctx, id)
        },
      ],
      [
        'the front photo is gone from the bucket',
        async (ctx: Ctx, id: string) => {
          await ctx.photos.delete(frontKey(ctx, id))
          await upload(ctx, id)
        },
      ],
      [
        'the queue gives up on the upload step (the dead letter)',
        async (ctx: Ctx, id: string) => {
          await asSystem(() => ctx.service.giveUp({ faceScanId: id, step: 'upload', at: T0.getTime() }))
        },
      ],
      [
        'the reaper gives up after 2 hours',
        async (ctx: Ctx) => {
          await reap(ctx, new Date(T0.getTime() + FAIL_AFTER + 1))
        },
      ],
      [
        'the scan is marked failed',
        async (ctx: Ctx, id: string) => {
          await ctx.service.markFailed(id)
        },
      ],
    ])('queues no push when %s', async (_label, fail) => {
      const ctx = setup()
      const id = await started(ctx)

      await fail(ctx, id)

      expect((await rowOf(ctx, id)).state).toBe('failed')
      expect(pushes(ctx)).toEqual([])
    })

    it.each([
      [
        'Perfect Corp has no credit at the fetch',
        async (ctx: Ctx, id: string) => {
          ctx.perfectCorp.script('getSkinAnalysis', new PerfectCorpCreditError('no units'))
          expect(await errorOf(fetchStep(ctx, id))).toBeInstanceOf(PermanentJobError)
        },
      ],
      [
        'Perfect Corp calls the fetch request bad',
        async (ctx: Ctx, id: string) => {
          ctx.perfectCorp.script('getSkinAnalysis', new PerfectCorpBadRequestError('expired'))
          expect(await errorOf(fetchStep(ctx, id))).toBeInstanceOf(PermanentJobError)
        },
      ],
      [
        'the queue gives up on the fetch step (the dead letter)',
        async (ctx: Ctx, id: string) => {
          await asSystem(() => ctx.service.giveUp({ faceScanId: id, step: 'fetch', at: T0.getTime() }))
        },
      ],
      [
        'the reaper gives up after 2 hours',
        async (ctx: Ctx) => {
          await reap(ctx, new Date(T0.getTime() + FAIL_AFTER + 1))
        },
      ],
    ])('queues no push for an uploaded scan when %s', async (_label, fail) => {
      const ctx = setup()
      const { id } = await uploaded(ctx)

      await fail(ctx, id)

      expect((await rowOf(ctx, id)).state).toBe('failed')
      expect(pushes(ctx)).toEqual([])
    })

    it('queues no push when the retaken scan fails, and its earlier needs-retake push stays the only one', async () => {
      const ctx = setup()
      const id = await started(ctx)
      ctx.perfectCorp.script('createSkinAnalysis', new PerfectCorpRejectedPhotoError('too-dark'))
      await upload(ctx, id)
      await retake(ctx, id, face(9))
      ctx.perfectCorp.script('createSkinAnalysis', new PerfectCorpBadRequestError('bad'))

      expect(await errorOf(upload(ctx, id))).toBeInstanceOf(PermanentJobError)

      expect((await rowOf(ctx, id)).state).toBe('failed')
      expect(kinds(ctx)).toEqual(['face-scan-needs-retake'])
    })
  })

  describe('the fitzpatrick step', () => {
    it('queues no push whatever it finds: not when it stores the type, not when it is refused for credit, not on a ready scan', async () => {
      const ctx = setup()
      const { id } = await uploaded(ctx)

      ctx.perfectCorp.script('getFitzpatrick', { status: 'success', fitzpatrick: 'IV' })
      await fitzpatrickStep(ctx, id)
      expect(pushes(ctx)).toEqual([])

      ctx.perfectCorp.script('getSkinAnalysis', analysed())
      await fetchStep(ctx, id)
      expect(kinds(ctx)).toEqual(['face-scan-ready'])

      await fitzpatrickStep(ctx, id)
      expect(kinds(ctx)).toEqual(['face-scan-ready'])
    })

    it('queues no push when the read is refused for credit or for the photo, and the scan stays as it was', async () => {
      const ctx = setup()
      const { id } = await uploaded(ctx)
      ctx.perfectCorp.script('getFitzpatrick', new PerfectCorpCreditError('no units'), new PerfectCorpRejectedPhotoError('too-dark'))

      await fitzpatrickStep(ctx, id)
      await fitzpatrickStep(ctx, id)

      expect((await rowOf(ctx, id)).state).toBe('analysing')
      expect(pushes(ctx)).toEqual([])
    })
  })

  describe('when the push cannot be queued', () => {
    it('leaves the ready scan exactly as it is, and the step does not throw', async () => {
      const ctx = setup()
      const { id, analysisTask } = await uploaded(ctx)
      ctx.perfectCorp.script('getSkinAnalysis', analysed())
      ctx.pushJobs.failNextWith(new Error('push queue is down'))
      quiet()

      await expect(fetchStep(ctx, id)).resolves.toBeUndefined()

      expect(await rowOf(ctx, id)).toMatchObject({ state: 'ready', reason: null, skinAge: 31 })
      expect(ctx.events.eventsFor(id).slice(-2)).toEqual([{ type: 'face', faceScan: { id, state: 'ready', reason: null } }, { type: 'done' }])
      expect(deletedTasks(ctx)).toContain(analysisTask)
      expect(pushes(ctx)).toEqual([])
    })

    it('leaves the scan at needs-retake exactly as it is, and the step does not throw', async () => {
      const ctx = setup()
      const { id, analysisTask } = await uploaded(ctx)
      ctx.perfectCorp.script('getSkinAnalysis', new PerfectCorpRejectedPhotoError('move-closer'))
      ctx.pushJobs.failNextWith(new Error('push queue is down'))
      quiet()

      await expect(fetchStep(ctx, id)).resolves.toBeUndefined()

      expect(await rowOf(ctx, id)).toMatchObject({ state: 'needs-retake', reason: 'move-closer' })
      expect(ctx.events.eventsFor(id).slice(-2)).toEqual([{ type: 'face', faceScan: { id, state: 'needs-retake', reason: 'move-closer' } }, { type: 'done' }])
      expect(deletedTasks(ctx)).toEqual([analysisTask])
      expect(pushes(ctx)).toEqual([])
    })

    it('does not fail or retry an upload step that was refused: it resolves with the scan at needs-retake', async () => {
      const ctx = setup()
      const id = await started(ctx)
      ctx.perfectCorp.script('uploadFile', new PerfectCorpRejectedPhotoError('image-size'))
      ctx.pushJobs.failNextWith(new Error('push queue is down'))
      quiet()

      await expect(upload(ctx, id)).resolves.toBeUndefined()

      expect(await rowOf(ctx, id)).toMatchObject({ state: 'needs-retake', reason: 'image-size' })
    })
  })
})

describe('FaceScanService.latestSkinType', () => {
  const latestSkinType = (ctx: Ctx, profileId = PROFILE) => asUser(() => ctx.service.latestSkinType(), profileId)
  /** What Perfect Corp reads for the whole face of a ready scan. */
  const reading = (skinType: string) => analysed({ skinTypes: [{ region: 'whole', skinType }] })
  /** A scan made ready the real way (uploaded, then fetched from a finished analysis) with this reading. */
  const readyWith = async (ctx: Ctx, goal: Goal, result: SkinAnalysisResult) => {
    const { id } = await uploaded(ctx, goal)
    ctx.perfectCorp.script('getSkinAnalysis', result)
    await fetchStep(ctx, id)
    return id
  }

  it('is null for a profile that never made a face scan', async () => {
    const ctx = setup()

    expect(await latestSkinType(ctx)).toBeNull()
  })

  it('is the label of the latest scan once it is ready: Perfect Corp\'s "Dry" for the whole face is dry', async () => {
    const ctx = setup()
    await finished(ctx)

    expect(await latestSkinType(ctx)).toBe('dry')
  })

  it.each([
    ['Oily', 'oily'],
    ['Combination', 'combination'],
    ['Normal', 'normal'],
  ])('reads a whole-face "%s" as %s', async (text, label) => {
    const ctx = setup()
    await readyWith(ctx, 'glow', reading(text))

    expect(await latestSkinType(ctx)).toBe(label)
  })

  it('is null while the latest scan is still being analysed', async () => {
    const ctx = setup()
    await started(ctx)

    expect(await latestSkinType(ctx)).toBeNull()
  })

  it('is null when the latest scan needs a retake: nothing was read from it', async () => {
    const ctx = setup()
    const id = await started(ctx)
    ctx.perfectCorp.script('createSkinAnalysis', new PerfectCorpRejectedPhotoError('too-dark'))
    await upload(ctx, id)
    expect(await rowOf(ctx, id)).toMatchObject({ state: 'needs-retake' })

    expect(await latestSkinType(ctx)).toBeNull()
  })

  it('is null when the latest scan is ready but Perfect Corp sent no skin type for it', async () => {
    const ctx = setup()
    await readyWith(ctx, 'glow', analysed({ skinTypes: [], skinAge: null, all: null }))

    expect(await latestSkinType(ctx)).toBeNull()
  })

  it('is the newest ready scan\'s label when there are several: a rescan under a new goal replaces the old reading', async () => {
    const ctx = setup()
    await readyWith(ctx, 'glow', reading('Dry'))
    ctx.advanceClock(SCAN_SPACING)
    await readyWith(ctx, 'clear-skin', reading('Oily'))

    expect(await latestSkinType(ctx)).toBe('oily')
  })

  it('is the newest READY scan\'s label, so a newer scan still being analysed does not hide an older ready one', async () => {
    const ctx = setup()
    await readyWith(ctx, 'glow', reading('Dry'))
    ctx.advanceClock(SCAN_SPACING)
    const newer = await started(ctx, 'clear-skin')
    expect(await rowOf(ctx, newer)).toMatchObject({ state: 'analysing' })

    expect(await latestSkinType(ctx)).toBe('dry')
  })

  it('is the newest ready scan\'s label when a newer scan needs a retake', async () => {
    const ctx = setup()
    await readyWith(ctx, 'glow', reading('Dry'))
    ctx.advanceClock(SCAN_SPACING)
    const newer = await started(ctx, 'clear-skin')
    ctx.perfectCorp.script('createSkinAnalysis', new PerfectCorpRejectedPhotoError('too-dark'))
    await upload(ctx, newer)
    expect(await rowOf(ctx, newer)).toMatchObject({ state: 'needs-retake' })

    expect(await latestSkinType(ctx)).toBe('dry')
  })

  it('is the newest ready scan\'s label, and a newer ready scan with no skin type does not fall back to an older reading: that scan is the newest ready one', async () => {
    const ctx = setup()
    await readyWith(ctx, 'glow', reading('Dry'))
    ctx.advanceClock(SCAN_SPACING)
    await readyWith(ctx, 'clear-skin', analysed({ skinTypes: [], skinAge: null, all: null }))

    expect(await latestSkinType(ctx)).toBeNull()
  })

  it('is the label of the caller\'s own profile\'s scan only: another profile of the account has none, and has its own', async () => {
    const ctx = setup()
    await finished(ctx)

    expect(await latestSkinType(ctx, OTHER_PROFILE)).toBeNull()
    expect(await latestSkinType(ctx, PROFILE)).toBe('dry')
  })

  it('needs a user: a caller with no session is UnauthorizedError', async () => {
    const ctx = setup()

    expect(await errorOf(runAs({ kind: 'public' }, () => ctx.service.latestSkinType()))).toBeInstanceOf(UnauthorizedError)
  })
})
