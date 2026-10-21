import { describe, expect, it, vi } from 'vitest'
import { PermanentJobError } from '../../jobs/job'
import { runAs } from '../../lib/context'
import { ConflictError, NotFoundError, UnauthorizedError, UnavailableError, ValidationError } from '../../lib/errors'
import { MemoryEmailSender } from '../../providers/email/memory.email'
import { MemoryGoalReader } from '../../providers/goal-reading/memory.goal-reader'
import { MemoryJobQueue } from '../../providers/job-queue/memory.job-queue'
import { MemoryMentionReader } from '../../providers/mention-reading/memory.mention-reader'
import { MemoryPerfectCorpClient } from '../../providers/perfect-corp/memory.perfect-corp'
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
import type { Goal } from '../goals/goals.vocabulary'
import { FakeOpsAlertsRepository } from '../ops-alerts/ops-alerts.repository.fake'
import { OpsAlertsService } from '../ops-alerts/ops-alerts.service'
import { FakeSafetyRepository } from '../safety/safety.repository.fake'
import { SafetyService } from '../safety/safety.service'
import { jpegPhoto } from '../scans/scans.photos.fake'
import { CURRENT_FACE_CONSENT_VERSION } from './face-scans.consent'
import { analyseFaceScanSpec } from './face-scans.job-specs'
import { FakeFaceScansRepository } from './face-scans.repository.fake'
import { FaceScanService } from './face-scans.service'
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
  const service = new FaceScanService({
    repository,
    goals,
    photos,
    jobs,
    perfectCorp,
    aiUsage,
    events,
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

const asUser = <T>(fn: () => Promise<T>, profileId = PROFILE) => runAs({ kind: 'user', userId: USER, status: 'anonymous', profileId }, fn)
const asSystem = <T>(fn: () => Promise<T>) => runAs({ kind: 'system', job: 'analyse-face-scan' }, fn)

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error as Error & { code?: string; details?: Record<string, unknown> }
  }
  throw new Error('expected the promise to reject')
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
  it('sends the front photo once and starts the goal\'s three HD concerns plus the skin type as one analysis, and a Fitzpatrick read for a profile that has none', async () => {
    const ctx = setup()
    const id = await started(ctx, 'glow')

    await upload(ctx, id)

    expect(methodsCalled(ctx)).toEqual(['uploadFile', 'createSkinAnalysis', 'createFitzpatrick'])
    const [bytes, options] = callsOf(ctx, 'uploadFile')[0]!.args as [Uint8Array, unknown]
    expect(Array.from(bytes)).toEqual(Array.from(face(1).bytes))
    expect(options).toEqual({ contentType: 'image/jpeg', fileName: 'front.jpg' })
    expect(callsOf(ctx, 'createSkinAnalysis')[0]!.args).toEqual([{ fileId: 'file-1', actions: ['hd_radiance', 'hd_moisture', 'hd_texture', 'hd_skin_type'] }])
    expect(callsOf(ctx, 'createFitzpatrick')[0]!.args).toEqual([{ fileId: 'file-1' }])
  })

  it('asks for the concerns of the goal the scan was taken under, not a fixed list', async () => {
    const ctx = setup()
    const id = await started(ctx, 'clear-skin')

    await upload(ctx, id)

    expect(callsOf(ctx, 'createSkinAnalysis')[0]!.args).toEqual([{ fileId: 'file-1', actions: ['hd_acne', 'hd_pore', 'hd_oiliness', 'hd_skin_type'] }])
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

  it('downloads the mask of each of the goal\'s concerns that has one, stores each as a PNG under its mask key with the bytes it got, and records the keys', async () => {
    const ctx = setup()
    const { id } = await uploaded(ctx)
    ctx.perfectCorp.script('getSkinAnalysis', analysed())

    await fetchStep(ctx, id)

    // hd_acne has a mask too, but it is not one of glow's concerns; hd_texture is and has none.
    expect(callsOf(ctx, 'downloadMask').map((call) => call.args[0]).sort()).toEqual([maskUrl('moisture'), maskUrl('radiance')])
    expect(masksStored(ctx)).toEqual([maskKey(ctx, id, 'hd-moisture'), maskKey(ctx, id, 'hd-radiance')])
    const radiance = ctx.photos.stored.get(maskKey(ctx, id, 'hd-radiance'))!
    expect(radiance.mediaType).toBe('image/png')
    expect(new TextDecoder().decode(radiance.bytes)).toBe(maskUrl('radiance'))
    expect(new TextDecoder().decode(ctx.photos.stored.get(maskKey(ctx, id, 'hd-moisture'))!.bytes)).toBe(maskUrl('moisture'))
    expect((await ctx.repository.masksOf(id)).sort((a, b) => a.concern.localeCompare(b.concern))).toEqual([
      { faceScanId: id, userId: USER, concern: 'hd_moisture', maskKey: maskKey(ctx, id, 'hd-moisture') },
      { faceScanId: id, userId: USER, concern: 'hd_radiance', maskKey: maskKey(ctx, id, 'hd-radiance') },
    ])
  })

  it('keeps the front photo and the masks listed for the scan, so deleting the scan empties the bucket', async () => {
    const ctx = setup()
    const { id } = await finished(ctx)

    await asUser(() => ctx.service.deleteFaceScan(id))

    expect(ctx.photos.stored.size).toBe(0)
  })

  it('records the spend once: face-analysis, 12 units for the 4 actions, keyed by the analysis task id', async () => {
    const ctx = setup()
    const { id, analysisTask } = await uploaded(ctx)
    ctx.perfectCorp.script('getSkinAnalysis', analysed())

    await fetchStep(ctx, id)

    expect(ctx.aiUsage.recorded).toEqual([{ vendor: 'perfect-corp', job: 'face-analysis', units: 12, key: analysisTask }])
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

    expect(spendWhenDownloading).toEqual([{ vendor: 'perfect-corp', job: 'face-analysis', units: 12, key: analysisTask }])
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
    expect(ctx.aiUsage.recorded).toEqual([{ vendor: 'perfect-corp', job: 'face-analysis', units: 12, key: analysisTask }])
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
    expect(ctx.aiUsage.recorded).toEqual([{ vendor: 'perfect-corp', job: 'face-analysis', units: 12, key: analysisTask }])
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
    expect(ctx.aiUsage.recorded).toEqual([{ vendor: 'perfect-corp', job: 'face-analysis', units: 12, key: analysisTask }])
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

  it('verifies the raw body and the headers exactly as they arrived', async () => {
    const ctx = setup()
    const raw = '{"data":  {"task_id":"t-1","task_status":"success"}}'
    ctx.perfectCorp.script('verifyWebhook', null)

    await errorOf(receive(ctx, raw, { 'webhook-id': 'wh-9', 'webhook-timestamp': '1', 'webhook-signature': 'v1,abc' }))

    const [body, headers] = callsOf(ctx, 'verifyWebhook')[0]!.args as [string, Headers]
    expect(body).toBe(raw)
    expect(headers.get('webhook-id')).toBe('wh-9')
    expect(headers.get('webhook-signature')).toBe('v1,abc')
  })

  it('queues the fetch step, stamped with now and carrying the webhook\'s id, for a task that is a scan\'s analysis', async () => {
    const ctx = setup()
    const { id, analysisTask } = await uploaded(ctx)
    clearQueue(ctx)
    ctx.advanceClock(3 * MINUTE)
    ctx.perfectCorp.script('verifyWebhook', { webhookId: 'wh-42', taskId: analysisTask, taskStatus: 'success' })

    await expect(receive(ctx)).resolves.toBeUndefined()

    expect(ctx.jobs.enqueued).toEqual([{ job: 'analyse-face-scan', body: { faceScanId: id, step: 'fetch', at: ctx.now().getTime(), webhookId: 'wh-42' } }])
  })

  it('queues the fitzpatrick step for a task that is a scan\'s Fitzpatrick read', async () => {
    const ctx = setup()
    const { id, fitzpatrickTask } = await uploaded(ctx)
    clearQueue(ctx)
    ctx.perfectCorp.script('verifyWebhook', { webhookId: 'wh-43', taskId: fitzpatrickTask!, taskStatus: 'success' })

    await receive(ctx)

    expect(ctx.jobs.enqueued).toEqual([{ job: 'analyse-face-scan', body: { faceScanId: id, step: 'fitzpatrick', at: ctx.now().getTime(), webhookId: 'wh-43' } }])
  })

  it('still queues the fetch step when the task ended in an error, so the step can find out why', async () => {
    const ctx = setup()
    const { id, analysisTask } = await uploaded(ctx)
    clearQueue(ctx)
    ctx.perfectCorp.script('verifyWebhook', { webhookId: 'wh-44', taskId: analysisTask, taskStatus: 'error' })

    await receive(ctx)

    expect(queuedSteps(ctx)).toEqual([{ faceScanId: id, step: 'fetch', at: ctx.now().getTime(), webhookId: 'wh-44' }])
  })

  it('answers and queues nothing for a task no scan holds (a deleted scan\'s, or a task from somewhere else)', async () => {
    const ctx = setup()
    await uploaded(ctx)
    clearQueue(ctx)
    ctx.perfectCorp.script('verifyWebhook', { webhookId: 'wh-45', taskId: 'task-from-nowhere', taskStatus: 'success' })

    await expect(receive(ctx)).resolves.toBeUndefined()

    expect(ctx.jobs.enqueued).toEqual([])
  })

  it('answers and queues nothing for a task that was made in another environment', async () => {
    const repository = new FakeFaceScansRepository()
    const production = setup({ repository, environment: 'production' })
    const { analysisTask } = await uploaded(production)
    const staging = setup({ repository, environment: 'staging' })
    staging.perfectCorp.script('verifyWebhook', { webhookId: 'wh-46', taskId: analysisTask, taskStatus: 'success' })

    await expect(receive(staging)).resolves.toBeUndefined()

    expect(staging.jobs.enqueued).toEqual([])
  })

  it('throws an UnavailableError, which the route answers 503 so Perfect Corp sends it again, when the step cannot be queued', async () => {
    const ctx = setup()
    const { analysisTask } = await uploaded(ctx)
    ctx.perfectCorp.script('verifyWebhook', { webhookId: 'wh-47', taskId: analysisTask, taskStatus: 'success' })
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
      expect(masksStored(ctx)).toHaveLength(2)
    }

    await asUser(() => ctx.service.deleteFaceScan(id))

    expect(await ctx.repository.findFaceScan(id)).toBeNull()
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
