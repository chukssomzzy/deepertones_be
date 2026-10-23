import { describe, expect, it } from 'vitest'
import { runAs } from '../../lib/context'
import { ConflictError, NotFoundError, RateLimitedError, UnauthorizedError, ValidationError } from '../../lib/errors'
import { PHOTO_LINK_TTL_SECONDS, signPhotoLink, verifyPhotoLink } from '../../lib/photo-link'
import { MemoryGoalReader } from '../../providers/goal-reading/memory.goal-reader'
import { MemoryJobQueue } from '../../providers/job-queue/memory.job-queue'
import { MemoryMentionReader } from '../../providers/mention-reading/memory.mention-reader'
import { MemoryEmailSender } from '../../providers/email/memory.email'
import { MemoryPerfectCorpClient } from '../../providers/perfect-corp/memory.perfect-corp'
import { MemoryPhotoStore } from '../../providers/photo-store/memory.photo-store'
import { MemoryScanEvents } from '../../providers/scan-events/memory.scan-events'
import type { ProductImage } from '../../providers/product-analysis/product-analyst.provider'
import { FakeGoalsRepository } from '../goals/goals.repository.fake'
import { GoalsService } from '../goals/goals.service'
import type { Goal } from '../goals/goals.vocabulary'
import { FakeOpsAlertsRepository } from '../ops-alerts/ops-alerts.repository.fake'
import { OpsAlertsService } from '../ops-alerts/ops-alerts.service'
import { FakeSafetyRepository } from '../safety/safety.repository.fake'
import { SafetyService } from '../safety/safety.service'
import { garbagePhoto, jpegPhoto, pngPhoto, webpPhoto } from '../scans/scans.photos.fake'
import { CURRENT_FACE_CONSENT_VERSION } from './face-scans.consent'
import { analyseFaceScanSpec } from './face-scans.job-specs'
import { FakeFaceScansRepository } from './face-scans.repository.fake'
import { FaceScanService } from './face-scans.service'
import { FakeVendorSpendLedger } from './face-scans.vendor-spend.fake'

// The one clock every test hangs off; fixtures are offsets from it.
const T0 = new Date('2030-06-15T12:00:00.000Z')
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
/** A goal left and taken up again within 90 days of leaving carries on the same chase; a longer gap starts the goal fresh (issue #145, written out here). */
const RESUME_WINDOW = 90 * DAY
/** A goal's review point, when its wider check-in scan becomes due: six weeks after the chase's day one (issue #145, written out here). */
const REVIEW_POINT = 42 * DAY

const PHOTO_SECRET = 'photo-link-secret-for-tests'
const USER = 'user-1'
const OTHER_USER = 'user-2'
// Two profiles of one account (USER): consent, goal and face scans belong to the profile.
const PROFILE = 'profile-1'
const OTHER_PROFILE = 'profile-2'

/** What a face photo may be: at most this many bytes, a short side of at least 1080 px and a long side of at most 4096 px. */
const MAX_FACE_PHOTO_BYTES = 6_000_000
const MIN_SHORT_SIDE = 1080
const MAX_LONG_SIDE = 4096

// Amara has one account with a consent and a goal. The goals service is the real one over its fake repository: the goal is set the way a
// user sets it, so "the goal changed" is reached by the real path.
const NO_CATALOG = {
  resolve: async () => {
    throw new Error('the face scan tests never reach the catalog')
  },
  research: async () => {
    throw new Error('the face scan tests never reach the catalog')
  },
}

type SetupOptions = { repository?: FakeFaceScansRepository; photos?: MemoryPhotoStore }

const setup = (options: SetupOptions = {}) => {
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
  const photos = options.photos ?? new MemoryPhotoStore({ environment: 'test' })
  const jobs = new MemoryJobQueue()
  const service = new FaceScanService({
    repository,
    goals,
    photos,
    jobs,
    // The analysis pipeline's collaborators (its behaviour is face-scans.pipeline.test.ts's); nothing here reaches them.
    perfectCorp: new MemoryPerfectCorpClient(),
    aiUsage: new FakeVendorSpendLedger(),
    events: new MemoryScanEvents(),
    // The pushes are the pipeline tests' concern; nothing here reaches them.
    notifications: { faceScanReady: async () => undefined, faceScanNeedsRetake: async () => undefined },
    opsAlerts: new OpsAlertsService({ repository: new FakeOpsAlertsRepository(), jobs: new MemoryJobQueue(), email: new MemoryEmailSender(), recipient: '', environment: 'test', now: () => clock }),
    photoLinkSecret: PHOTO_SECRET,
    environment: 'test',
    now: () => clock,
    newId: () => `id-${++n}`,
  })
  return {
    service,
    repository,
    goals,
    goalReader,
    photos,
    jobs,
    advance: (ms: number) => (clock = new Date(clock.getTime() + ms)),
    now: () => clock,
  }
}
type Ctx = ReturnType<typeof setup>

const user = (userId = USER, profileId = PROFILE) => ({ kind: 'user', userId, status: 'anonymous', profileId }) as const
const asUser = <T>(fn: () => Promise<T>, userId = USER, profileId = PROFILE) => runAs(user(userId, profileId), fn)
const asPublic = <T>(fn: () => Promise<T>) => runAs({ kind: 'public' }, fn)

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error as Error & { code?: string; details?: Record<string, unknown> }
  }
  throw new Error('expected the promise to reject')
}

type Who = { userId?: string; profileId?: string }
const as = (who: Who = {}) => ({ userId: who.userId ?? USER, profileId: who.profileId ?? PROFILE })
const giveConsent = (ctx: Ctx, who: Who = {}, version = CURRENT_FACE_CONSENT_VERSION) => asUser(() => ctx.service.giveConsent(version), as(who).userId, as(who).profileId)
const withdrawConsent = (ctx: Ctx, who: Who = {}) => asUser(() => ctx.service.withdrawConsent(), as(who).userId, as(who).profileId)
const consentOf = (ctx: Ctx, who: Who = {}) => asUser(() => ctx.service.consent(), as(who).userId, as(who).profileId)
const setGoal = (ctx: Ctx, goal: Goal, who: Who = {}) => asUser(() => ctx.goals.set({ goal }), as(who).userId, as(who).profileId)

// A face photo: a JPEG whose header says 1080 x 1440 (a phone portrait) unless a test says otherwise, with a marker byte at the end so two photos can be told apart in storage.
const face = (shape: { width?: number; height?: number; size?: number } = {}, marker = 1): ProductImage => {
  const photo = jpegPhoto({ width: 1080, height: 1440, ...shape })
  photo.bytes[photo.bytes.length - 1] = marker
  return photo
}
type Photos = { front: ProductImage; right?: ProductImage; left?: ProductImage }
const three = (): Required<Photos> => ({ front: face({}, 1), right: face({}, 2), left: face({}, 3) })

/** Consent for the current version and a goal: a profile that may scan (until it has). */
const ready = async (ctx: Ctx, goal: Goal = 'glow', who: Who = {}) => {
  await giveConsent(ctx, who)
  await setGoal(ctx, goal, who)
}
const create = (ctx: Ctx, photos: Photos = { front: face() }, who: Who = {}): Promise<any> => asUser(() => ctx.service.create(photos), as(who).userId, as(who).profileId)

/**
 * Makes a scan ready an hour after it was taken, with the very write the analysis step makes (`completeFaceScan`), so a chase has a day one to
 * measure its review point from. The hour is there so a test can tell the day one's own time from the time it became ready.
 */
const becomeReady = async (ctx: Ctx, id: string) => {
  ctx.advance(HOUR)
  await ctx.repository.completeFaceScan(id, { results: [], masks: [], skinType: null, skinAge: null, tablesVersion: 'tables-under-test', updatedAt: ctx.now() })
}

/**
 * A profile whose current chase of `goal` has a ready day one, taken at T0, with the clock standing at exactly its review point (T0 plus six
 * weeks). Resolves to the day-one scan's view.
 */
const atReviewPoint = async (ctx: Ctx, goal: Goal = 'glow'): Promise<any> => {
  await ready(ctx, goal)
  const dayOne = await create(ctx)
  await becomeReady(ctx, dayOne.id)
  ctx.advance(REVIEW_POINT - HOUR)
  return dayOne
}

/** When the check-in of a chase whose day one was taken at `dayOneAt` falls due, as the 429 says it. */
const checkInDueAt = (dayOneAt: Date) => new Date(dayOneAt.getTime() + REVIEW_POINT).toISOString()
const getScan = (ctx: Ctx, id: string, who: Who = {}): Promise<any> => asUser(() => ctx.service.getFaceScan(id), as(who).userId, as(who).profileId)
const deleteScan = (ctx: Ctx, id: string, who: Who = {}) => asUser(() => ctx.service.deleteFaceScan(id), as(who).userId, as(who).profileId)

const keyOf = (scanId: string, position: string, who: Who = {}) => `faces/test/${as(who).userId}/${as(who).profileId}/${scanId}/${position}.jpg`
const nothingStored = (ctx: Ctx) => {
  expect(ctx.photos.stored.size).toBe(0)
  expect(ctx.jobs.enqueued).toEqual([])
}

describe('FaceScanService consent', () => {
  it('records consent for the current version at the time it was given, and answers both', async () => {
    const ctx = setup()

    const given = await giveConsent(ctx)

    expect(given).toEqual({ version: CURRENT_FACE_CONSENT_VERSION, givenAt: T0 })
    expect(await consentOf(ctx)).toEqual({ version: CURRENT_FACE_CONSENT_VERSION, givenAt: T0, withdrawnAt: null, current: true })
  })

  it('has no consent to show until one is given: 404 FACE_CONSENT_NOT_FOUND', async () => {
    const ctx = setup()

    const error = await errorOf(consentOf(ctx))

    expect(error).toBeInstanceOf(NotFoundError)
    expect(error.code).toBe('FACE_CONSENT_NOT_FOUND')
  })

  it.each([
    ['an older version', CURRENT_FACE_CONSENT_VERSION - 1],
    ['a newer version than the app knows', CURRENT_FACE_CONSENT_VERSION + 1],
  ])('refuses consent to %s with 400 FACE_CONSENT_VERSION_MISMATCH, saying which is current, and stores nothing', async (_label, version) => {
    const ctx = setup()

    const error = await errorOf(giveConsent(ctx, {}, version))

    expect(error).toBeInstanceOf(ValidationError)
    expect(error.code).toBe('FACE_CONSENT_VERSION_MISMATCH')
    expect(error.details).toEqual({ current: CURRENT_FACE_CONSENT_VERSION })
    expect((await errorOf(consentOf(ctx))).code).toBe('FACE_CONSENT_NOT_FOUND')
  })

  it('withdraws consent by stamping the time and keeping the row: it is still shown, no longer current', async () => {
    const ctx = setup()
    await giveConsent(ctx)
    ctx.advance(5 * MINUTE)

    await withdrawConsent(ctx)

    expect(await consentOf(ctx)).toEqual({ version: CURRENT_FACE_CONSENT_VERSION, givenAt: T0, withdrawnAt: new Date(T0.getTime() + 5 * MINUTE), current: false })
  })

  it('answers a withdrawal when there is no consent to withdraw, and makes none', async () => {
    const ctx = setup()

    await expect(withdrawConsent(ctx)).resolves.toBeUndefined()

    expect((await errorOf(consentOf(ctx))).code).toBe('FACE_CONSENT_NOT_FOUND')
  })

  it('makes consent current again when it is given again after a withdrawal, from the new time', async () => {
    const ctx = setup()
    await giveConsent(ctx)
    ctx.advance(MINUTE)
    await withdrawConsent(ctx)
    ctx.advance(MINUTE)

    const given = await giveConsent(ctx)

    expect(given.givenAt).toEqual(new Date(T0.getTime() + 2 * MINUTE))
    expect(await consentOf(ctx)).toEqual({ version: CURRENT_FACE_CONSENT_VERSION, givenAt: new Date(T0.getTime() + 2 * MINUTE), withdrawnAt: null, current: true })
  })

  it('says a consent given for an older version is not current, though it was never withdrawn', async () => {
    const ctx = setup()
    // The wording moved on after this profile consented: an older version is what a bump of CURRENT_FACE_CONSENT_VERSION leaves behind.
    await ctx.repository.giveConsent({ profileId: PROFILE, userId: USER, version: CURRENT_FACE_CONSENT_VERSION - 1, at: T0 })

    expect(await consentOf(ctx)).toEqual({ version: CURRENT_FACE_CONSENT_VERSION - 1, givenAt: T0, withdrawnAt: null, current: false })
  })

  it('belongs to the profile: the account\'s other profile has none, and withdrawing one does not withdraw the other', async () => {
    const ctx = setup()
    await giveConsent(ctx)

    expect((await errorOf(consentOf(ctx, { profileId: OTHER_PROFILE }))).code).toBe('FACE_CONSENT_NOT_FOUND')
    await giveConsent(ctx, { profileId: OTHER_PROFILE })
    await withdrawConsent(ctx)

    expect((await consentOf(ctx)).current).toBe(false)
    expect((await consentOf(ctx, { profileId: OTHER_PROFILE })).current).toBe(true)
  })

  it('belongs to the profile of the account, not to every account: another user has none', async () => {
    const ctx = setup()
    await giveConsent(ctx)

    expect((await errorOf(consentOf(ctx, { userId: OTHER_USER, profileId: 'profile-9' }))).code).toBe('FACE_CONSENT_NOT_FOUND')
  })

  it.each([
    ['give', (ctx: Ctx) => asPublic(() => ctx.service.giveConsent(CURRENT_FACE_CONSENT_VERSION))],
    ['withdraw', (ctx: Ctx) => asPublic(() => ctx.service.withdrawConsent())],
    ['read', (ctx: Ctx) => asPublic(() => ctx.service.consent())],
  ])('refuses to %s consent for a caller who is not signed in: 401 AUTH_REQUIRED', async (_label, call) => {
    const ctx = setup()

    const error = await errorOf(call(ctx))

    expect(error).toBeInstanceOf(UnauthorizedError)
    expect(error.code).toBe('AUTH_REQUIRED')
  })
})

describe('FaceScanService.create: the checks, in order', () => {
  it('refuses a caller who is not signed in with 401 AUTH_REQUIRED, before anything else, storing and queueing nothing', async () => {
    const ctx = setup()

    const error = await errorOf(asPublic(() => ctx.service.create({ front: face() })))

    expect(error).toBeInstanceOf(UnauthorizedError)
    expect(error.code).toBe('AUTH_REQUIRED')
    nothingStored(ctx)
  })

  it('needs consent: with none on record it is 409 FACE_CONSENT_REQUIRED, and nothing is stored or queued', async () => {
    const ctx = setup()
    await setGoal(ctx, 'glow')

    const error = await errorOf(create(ctx))

    expect(error).toBeInstanceOf(ConflictError)
    expect(error.code).toBe('FACE_CONSENT_REQUIRED')
    nothingStored(ctx)
    expect(await ctx.repository.latestForProfile(PROFILE)).toBeNull()
  })

  it('counts a withdrawn consent as none', async () => {
    const ctx = setup()
    await ready(ctx)
    await withdrawConsent(ctx)

    expect((await errorOf(create(ctx))).code).toBe('FACE_CONSENT_REQUIRED')
    nothingStored(ctx)
  })

  it('counts a consent for an older version as none', async () => {
    const ctx = setup()
    await ctx.repository.giveConsent({ profileId: PROFILE, userId: USER, version: CURRENT_FACE_CONSENT_VERSION - 1, at: T0 })
    await setGoal(ctx, 'glow')

    expect((await errorOf(create(ctx))).code).toBe('FACE_CONSENT_REQUIRED')
    nothingStored(ctx)
  })

  it('counts the consent of the account\'s other profile as none for this one', async () => {
    const ctx = setup()
    await giveConsent(ctx, { profileId: OTHER_PROFILE })
    await setGoal(ctx, 'glow')

    expect((await errorOf(create(ctx))).code).toBe('FACE_CONSENT_REQUIRED')
    nothingStored(ctx)
  })

  it('needs a goal, which the analysis depends on: 409 GOAL_REQUIRED, with nothing stored or queued', async () => {
    const ctx = setup()
    await giveConsent(ctx)

    const error = await errorOf(create(ctx))

    expect(error).toBeInstanceOf(ConflictError)
    expect(error.code).toBe('GOAL_REQUIRED')
    nothingStored(ctx)
  })

  it('does not count typed words that nobody could sort into a goal as a goal', async () => {
    const ctx = setup()
    await giveConsent(ctx)
    await asUser(() => ctx.goals.set({ text: 'something the reader finds no goal in' }))

    expect((await errorOf(create(ctx))).code).toBe('GOAL_REQUIRED')
    nothingStored(ctx)
  })

  it('asks for consent before the goal, and before it looks at the photos', async () => {
    const ctx = setup()

    const error = await errorOf(create(ctx, { front: webpPhoto({ width: 1080, height: 1440 }) }))

    expect(error.code).toBe('FACE_CONSENT_REQUIRED')
  })

  it('asks for the goal before it looks at the photos', async () => {
    const ctx = setup()
    await giveConsent(ctx)

    const error = await errorOf(create(ctx, { front: webpPhoto({ width: 1080, height: 1440 }) }))

    expect(error.code).toBe('GOAL_REQUIRED')
  })

  it('asks whether a scan is due before it looks at the photos', async () => {
    const ctx = setup()
    await ready(ctx)
    await create(ctx)

    const error = await errorOf(create(ctx, { front: webpPhoto({ width: 1080, height: 1440 }) }))

    expect(error.code).toBe('FACE_SCAN_NOT_DUE')
  })

  it('looks at the photos last: with everything else right, a bad photo is a 400', async () => {
    const ctx = setup()
    await ready(ctx)

    const error = await errorOf(create(ctx, { front: webpPhoto({ width: 1080, height: 1440 }) }))

    expect(error).toBeInstanceOf(ValidationError)
    nothingStored(ctx)
  })
})

describe('FaceScanService.create: when a profile may scan', () => {
  it('refuses a second scan under the goal of the profile\'s latest one: 429 FACE_SCAN_NOT_DUE with the reason, and nothing more is stored or queued', async () => {
    const ctx = setup()
    await ready(ctx, 'glow')
    const first = await create(ctx)
    const storedBefore = ctx.photos.stored.size

    const error = await errorOf(create(ctx, { front: face({}, 9) }))

    expect(error).toBeInstanceOf(RateLimitedError)
    expect(error.code).toBe('FACE_SCAN_NOT_DUE')
    expect(error.details).toMatchObject({ reason: 'already-scanned-for-goal' })
    expect(ctx.photos.stored.size).toBe(storedBefore)
    expect(ctx.jobs.enqueued).toHaveLength(1)
    expect((await ctx.repository.latestForProfile(PROFILE))!.id).toBe(first.id)
  })

  it('allows a scan when the goal has changed since the latest one', async () => {
    const ctx = setup()
    await ready(ctx, 'glow')
    await create(ctx)
    ctx.advance(MINUTE)
    await setGoal(ctx, 'brighter')

    const second = await create(ctx, { front: face({}, 9) })

    expect(second.goal).toBe('brighter')
    expect(ctx.jobs.enqueued).toHaveLength(2)
  })

  // The goal's own chase decides, not the latest scan (issue #145): glow, then brighter, then glow again inside the resume window is the SAME glow
  // chase, and it has had its scan. Switching back and forth can never unlock a paid scan.
  it('refuses going back to glow inside the resume window: that chase has already had its scan', async () => {
    const ctx = setup()
    await ready(ctx, 'glow')
    await create(ctx)
    ctx.advance(MINUTE)
    await setGoal(ctx, 'brighter')
    await create(ctx, { front: face({}, 2) })
    ctx.advance(MINUTE)
    await setGoal(ctx, 'glow')

    const error = await errorOf(create(ctx, { front: face({}, 3) }))

    expect(error).toBeInstanceOf(RateLimitedError)
    expect(error.code).toBe('FACE_SCAN_NOT_DUE')
    expect(error.details).toMatchObject({ reason: 'already-scanned-for-goal' })
  })

  it('refuses going back to glow exactly 90 days after it was left, the last moment of the resume window', async () => {
    const ctx = setup()
    await ready(ctx, 'glow')
    await create(ctx)
    await setGoal(ctx, 'brighter')
    ctx.advance(RESUME_WINDOW)
    await setGoal(ctx, 'glow')

    const error = await errorOf(create(ctx, { front: face({}, 3) }))

    expect(error.code).toBe('FACE_SCAN_NOT_DUE')
    expect(error.details).toMatchObject({ reason: 'already-scanned-for-goal' })
  })

  it('allows a scan a millisecond after the window closes: the goal starts fresh, with a new day one to take', async () => {
    const ctx = setup()
    await ready(ctx, 'glow')
    await create(ctx)
    await setGoal(ctx, 'brighter')
    ctx.advance(RESUME_WINDOW + 1)
    await setGoal(ctx, 'glow')

    const fresh = await create(ctx, { front: face({}, 3) })

    expect(fresh.goal).toBe('glow')
    expect((await ctx.repository.findFaceScan(fresh.id))!.checkIn).toBe(false)
    expect(ctx.jobs.enqueued).toHaveLength(2)
  })

  it('refuses a scan under the goal of the latest one again once it has been taken: the goal moving away and back does not reset it', async () => {
    const ctx = setup()
    await ready(ctx, 'glow')
    await create(ctx)
    ctx.advance(MINUTE)
    await setGoal(ctx, 'brighter')
    ctx.advance(MINUTE)
    await setGoal(ctx, 'glow')

    // Nothing was scanned under brighter, so the latest scan is still glow's.
    expect((await errorOf(create(ctx, { front: face({}, 2) }))).code).toBe('FACE_SCAN_NOT_DUE')
  })

  it('keeps the profiles of one account apart: the other profile has its own consent, goal and latest scan', async () => {
    const ctx = setup()
    await ready(ctx, 'glow')
    await ready(ctx, 'glow', { profileId: OTHER_PROFILE })
    await create(ctx)

    const theirs = await create(ctx, { front: face({}, 2) }, { profileId: OTHER_PROFILE })

    expect(theirs.goal).toBe('glow')
    expect(ctx.jobs.enqueued).toHaveLength(2)
  })

  it('does not count a scan that failed: the profile may try again under the same goal', async () => {
    const ctx = setup()
    await ready(ctx, 'glow')
    ctx.jobs.failNextWith(new Error('queue is down'))
    const failed = await create(ctx)
    expect(failed.state).toBe('failed')
    ctx.advance(MINUTE)

    const retry = await create(ctx, { front: face({}, 2) })

    expect(retry.state).toBe('analysing')
    expect(retry.id).not.toBe(failed.id)
  })

  it('allows a scan again after the profile deleted its latest one', async () => {
    const ctx = setup()
    await ready(ctx, 'glow')
    const first = await create(ctx)
    await deleteScan(ctx, first.id)

    const again = await create(ctx, { front: face({}, 2) })

    expect(again.state).toBe('analysing')
  })
})

// A chase gets one more scan when it reaches its review point, six weeks after its day one: the wider check-in scan (issue #145). It is taken
// once per chase, and until it is due the 429 says when it will be.
describe('FaceScanService.create: the check-in at the review point', () => {
  it('allows a scan at exactly the review point and marks it the chase\'s check-in, which the day one is not', async () => {
    const ctx = setup()
    const dayOne = await atReviewPoint(ctx, 'glow')

    const checkIn = await create(ctx, { front: face({}, 2) })

    expect(checkIn.goal).toBe('glow')
    expect(checkIn.state).toBe('analysing')
    // The flag is the policy's, never the app's: it is deliberately not in the view, so the stored row is where it can be read.
    expect((await ctx.repository.findFaceScan(checkIn.id))!.checkIn).toBe(true)
    expect((await ctx.repository.findFaceScan(dayOne.id))!.checkIn).toBe(false)
  })

  it('refuses a scan a millisecond before the review point, saying the check-in is not due yet and when it will be', async () => {
    const ctx = setup()
    await ready(ctx, 'glow')
    const dayOne = await create(ctx)
    await becomeReady(ctx, dayOne.id)
    ctx.advance(REVIEW_POINT - HOUR - 1)

    const error = await errorOf(create(ctx, { front: face({}, 2) }))

    expect(error).toBeInstanceOf(RateLimitedError)
    expect(error.code).toBe('FACE_SCAN_NOT_DUE')
    // Measured from the day one's own time (T0), not from the hour later when it became ready.
    expect(error.details).toEqual({ reason: 'check-in-not-due', checkInDueAt: checkInDueAt(T0) })
    expect(ctx.jobs.enqueued).toHaveLength(1)
  })

  it('refuses a scan while the chase\'s only scan is still being analysed, which is no day one yet', async () => {
    const ctx = setup()
    await ready(ctx, 'glow')
    await create(ctx)
    ctx.advance(REVIEW_POINT)

    const error = await errorOf(create(ctx, { front: face({}, 2) }))

    expect(error.details).toMatchObject({ reason: 'already-scanned-for-goal' })
    expect(error.details).not.toHaveProperty('checkInDueAt')
  })

  it('refuses a second check-in once the chase has had one, however long after the review point', async () => {
    const ctx = setup()
    await atReviewPoint(ctx, 'glow')
    await create(ctx, { front: face({}, 2) })
    ctx.advance(REVIEW_POINT)

    const error = await errorOf(create(ctx, { front: face({}, 3) }))

    expect(error).toBeInstanceOf(RateLimitedError)
    expect(error.code).toBe('FACE_SCAN_NOT_DUE')
    expect(error.details).toMatchObject({ reason: 'check-in-taken' })
  })

  it('does not count a check-in that failed: the user may take their check-in again', async () => {
    const ctx = setup()
    await atReviewPoint(ctx, 'glow')
    ctx.jobs.failNextWith(new Error('queue is down'))
    const failed = await create(ctx, { front: face({}, 2) })
    expect(failed.state).toBe('failed')

    const again = await create(ctx, { front: face({}, 3) })

    expect(again.state).toBe('analysing')
    expect((await ctx.repository.findFaceScan(again.id))!.checkIn).toBe(true)
  })

  it('gives the goal the profile has now its own review point: a goal taken up later is due its day one, not a check-in', async () => {
    const ctx = setup()
    await atReviewPoint(ctx, 'glow')
    await setGoal(ctx, 'brighter')

    const first = await create(ctx, { front: face({}, 2) })

    expect(first.goal).toBe('brighter')
    expect((await ctx.repository.findFaceScan(first.id))!.checkIn).toBe(false)
  })
})

describe('FaceScanService.create: the photos', () => {
  const refused = async (photos: Photos) => {
    const ctx = setup()
    await ready(ctx)
    const error = await errorOf(create(ctx, photos))
    return { ctx, error }
  }

  const positions = ['front', 'right', 'left'] as const
  const unsupported: [string, () => ProductImage][] = [
    ['a WebP', () => webpPhoto({ width: 1080, height: 1440 })],
    ['a PNG', () => pngPhoto({ width: 1080, height: 1440 })],
    ['bytes that are no image', () => garbagePhoto()],
    // The type is decided by the bytes, never by what the caller claims.
    ['a WebP that claims to be a JPEG', () => ({ ...webpPhoto({ width: 1080, height: 1440 }), mediaType: 'image/jpeg' as const })],
    ['a PNG that claims to be a JPEG', () => ({ ...pngPhoto({ width: 1080, height: 1440 }), mediaType: 'image/jpeg' as const })],
  ]

  it.each(unsupported.flatMap(([label, make]) => positions.map((position) => [label, position, make] as const)))(
    'refuses %s as the %s photo with 400 UNSUPPORTED_IMAGE, since a face photo is a JPEG, and stores none of the scan\'s photos',
    async (_label, position, make) => {
      const photos: Photos = { front: face(), right: face({}, 2), left: face({}, 3) }
      photos[position] = make()

      const { ctx, error } = await refused(photos)

      expect(error).toBeInstanceOf(ValidationError)
      expect(error.code).toBe('UNSUPPORTED_IMAGE')
      nothingStored(ctx)
    },
  )

  it.each([
    ['front', 1079, 1920],
    ['front', 1920, 1079],
    ['right', 1079, 1920],
    ['left', 1920, 1079],
  ] as const)('refuses the %s photo of %i x %i, one pixel short on its short side, with 400 IMAGE_TOO_SMALL, and stores none of the scan\'s photos', async (position, width, height) => {
    const photos: Photos = { front: face(), right: face({}, 2), left: face({}, 3) }
    photos[position] = face({ width, height }, 9)
    const { ctx, error } = await refused(photos)

    expect(error).toBeInstanceOf(ValidationError)
    expect(error.code).toBe('IMAGE_TOO_SMALL')
    nothingStored(ctx)
  })

  it.each([
    ['a portrait whose short side is exactly 1080', 1080, 1920],
    ['a landscape whose short side is exactly 1080', 1920, 1080],
    ['a square of exactly 1080', 1080, 1080],
    ['a photo whose long side is exactly 4096', 1080, 4096],
    ['a landscape whose long side is exactly 4096', 4096, 1080],
    ['a photo at both limits', 4096, 4096],
  ])('takes %s', async (_label, width, height) => {
    const ctx = setup()
    await ready(ctx)

    const view = await create(ctx, { front: face({ width, height }) })

    expect(view.state).toBe('analysing')
    expect(ctx.photos.stored.size).toBe(1)
  })

  it.each([
    ['front', 1080, 4097],
    ['right', 4097, 1080],
    ['left', 5000, 3000],
  ] as const)('refuses the %s photo of %i x %i, over 4096 on its long side, with a 400, and stores nothing', async (position, width, height) => {
    const photos: Photos = { front: face(), right: face({}, 2), left: face({}, 3) }
    photos[position] = face({ width, height }, 9)
    const { ctx, error } = await refused(photos)

    expect(error).toBeInstanceOf(ValidationError)
    // A header that claims more than 4096 is read as no image at all by the header reader, so which of the two codes it is is the implementation's.
    expect(['IMAGE_TOO_LARGE', 'UNSUPPORTED_IMAGE']).toContain(error.code)
    nothingStored(ctx)
  })

  it('takes a photo of exactly the byte cap, and refuses one byte over it with 400 IMAGE_TOO_LARGE', async () => {
    const ctx = setup()
    await ready(ctx)
    const over = await errorOf(create(ctx, { front: face({ size: MAX_FACE_PHOTO_BYTES + 1 }) }))
    expect(over).toBeInstanceOf(ValidationError)
    expect(over.code).toBe('IMAGE_TOO_LARGE')
    nothingStored(ctx)

    const view = await create(ctx, { front: face({ size: MAX_FACE_PHOTO_BYTES }) })

    expect(view.state).toBe('analysing')
    expect(ctx.photos.stored.get(keyOf(view.id, 'front'))!.bytes.length).toBe(MAX_FACE_PHOTO_BYTES)
  })

  it('checks every photo before it stores any: a bad left photo stores no front and no right', async () => {
    const { ctx, error } = await refused({ front: face(), right: face({}, 2), left: webpPhoto({ width: 1080, height: 1440 }) })

    expect(error.code).toBe('UNSUPPORTED_IMAGE')
    nothingStored(ctx)
    expect(await ctx.repository.latestForProfile(PROFILE)).toBeNull()
  })
})

describe('FaceScanService.create: a scan that is accepted', () => {
  it('stores the photos of the scan in the private bucket under a face key that names the environment, user, profile and scan, as the bytes that were sent', async () => {
    const ctx = setup()
    await ready(ctx)
    const photos = three()

    const view = await create(ctx, photos)

    expect([...ctx.photos.stored.keys()].sort()).toEqual([keyOf(view.id, 'front'), keyOf(view.id, 'left'), keyOf(view.id, 'right')].sort())
    for (const position of ['front', 'right', 'left'] as const) {
      expect(ctx.photos.stored.get(keyOf(view.id, position))).toEqual({ bytes: photos[position].bytes, mediaType: 'image/jpeg' })
    }
  })

  it('stores only the photos that were sent', async () => {
    const ctx = setup()
    await ready(ctx)

    const view = await create(ctx, { front: face(), right: face({}, 2) })

    expect([...ctx.photos.stored.keys()].sort()).toEqual([keyOf(view.id, 'front'), keyOf(view.id, 'right')].sort())
    expect((await ctx.repository.photosOf(view.id)).map((photo) => photo.position)).toEqual(['front', 'right'])
  })

  it('stores the scan as analysing under the profile and the goal it had at the time, with the time, and a photo row for each key', async () => {
    const ctx = setup()
    await ready(ctx, 'fade-dark-marks')

    const view = await create(ctx, three())

    const stored = await ctx.repository.findFaceScan(view.id)
    expect(stored).toMatchObject({ id: view.id, userId: USER, profileId: PROFILE, state: 'analysing', reason: null, goalAtScan: 'fade-dark-marks' })
    expect(stored!.createdAt).toEqual(T0)
    expect((await ctx.repository.photosOf(view.id)).map((photo) => photo.photoKey)).toEqual([keyOf(view.id, 'front'), keyOf(view.id, 'right'), keyOf(view.id, 'left')])
  })

  it('queues exactly one analyse-face-scan job, for the upload step, stamped with the time of the scan', async () => {
    const ctx = setup()
    await ready(ctx)
    ctx.advance(7 * SECOND)

    const view = await create(ctx, three())

    expect(ctx.jobs.enqueued).toEqual([{ job: analyseFaceScanSpec.name, body: { faceScanId: view.id, step: 'upload', at: ctx.now().getTime() } }])
    expect(analyseFaceScanSpec.schema.safeParse(ctx.jobs.enqueued[0]!.body).success).toBe(true)
  })

  it('answers the scan as it now is: analysing, no reason, its goal and time, and a link for each photo sent, and no other field', async () => {
    const ctx = setup()
    await ready(ctx, 'clear-skin')

    const view = await create(ctx, { front: face(), left: face({}, 3) })

    expect(Object.keys(view).sort()).toEqual(['createdAt', 'goal', 'id', 'photos', 'reason', 'rescanSuggested', 'result', 'state'])
    expect(view).toMatchObject({ state: 'analysing', reason: null, goal: 'clear-skin', createdAt: T0, rescanSuggested: false })
    expect(Object.keys(view.photos).sort()).toEqual(['front', 'left'])
    for (const photo of Object.values<{ url: string }>(view.photos)) expect(Object.keys(photo)).toEqual(['url'])
  })

  it('gives each photo a signed link to the face photo route, good for 5 minutes, for this user and profile and the key of that photo', async () => {
    const ctx = setup()
    await ready(ctx)

    const view = await create(ctx, three())

    for (const position of ['front', 'right', 'left'] as const) {
      const url: string = view.photos[position].url
      expect(url.startsWith('/api/v1/scans/faces/photos/')).toBe(true)
      const token = url.slice('/api/v1/scans/faces/photos/'.length)
      expect(await verifyPhotoLink(token, PHOTO_SECRET, T0)).toEqual({ key: keyOf(view.id, position), userId: USER, profileId: PROFILE })
      expect(await verifyPhotoLink(token, PHOTO_SECRET, new Date(T0.getTime() + (PHOTO_LINK_TTL_SECONDS - 1) * SECOND))).not.toBeNull()
      expect(await verifyPhotoLink(token, PHOTO_SECRET, new Date(T0.getTime() + PHOTO_LINK_TTL_SECONDS * SECOND))).toBeNull()
    }
  })

  it('has a null result while the scan is analysing: no concerns, skin type, skin age or score', async () => {
    const ctx = setup()
    await ready(ctx)

    const view = await create(ctx, three())

    expect(view).toHaveProperty('result', null)
    const text = JSON.stringify(view).toLowerCase()
    for (const word of ['skintype', 'skinage', 'shown', 'score', 'concern', 'mask', 'fitzpatrick']) expect(text).not.toContain(word)
  })
})

describe('FaceScanService.create: storage before the database, and when something fails', () => {
  it('puts the photos in the bucket before it writes the scan, so a saved scan never points at a photo that is not there', async () => {
    const photos = new MemoryPhotoStore({ environment: 'test' })
    class Watching extends FakeFaceScansRepository {
      keysInBucketAtWrite: string[] | undefined
      override async createFaceScan(...args: Parameters<FakeFaceScansRepository['createFaceScan']>): Promise<boolean> {
        this.keysInBucketAtWrite = [...photos.stored.keys()]
        return super.createFaceScan(...args)
      }
    }
    const repository = new Watching()
    const ctx = setup({ repository, photos })
    await ready(ctx)

    const view = await create(ctx, three())

    expect(repository.keysInBucketAtWrite!.sort()).toEqual([keyOf(view.id, 'front'), keyOf(view.id, 'left'), keyOf(view.id, 'right')].sort())
  })

  it('stores no scan, queues nothing and leaves no photo behind when one photo cannot be put', async () => {
    class PutFails extends MemoryPhotoStore {
      override async put(key: string, image: ProductImage): Promise<void> {
        if (key.endsWith('/right.jpg')) throw new Error('bucket is down')
        return super.put(key, image)
      }
    }
    const ctx = setup({ photos: new PutFails({ environment: 'test' }) })
    await ready(ctx)

    await expect(create(ctx, three())).rejects.toThrow('bucket is down')

    nothingStored(ctx)
    expect(await ctx.repository.latestForProfile(PROFILE)).toBeNull()
  })

  it('deletes the photos it put and queues nothing when the scan cannot be saved, and lets the error through', async () => {
    class SaveFails extends FakeFaceScansRepository {
      override async createFaceScan(): Promise<boolean> {
        throw new Error('database is down')
      }
    }
    const ctx = setup({ repository: new SaveFails() })
    await ready(ctx)

    await expect(create(ctx, three())).rejects.toThrow('database is down')

    nothingStored(ctx)
  })

  it('answers with the scan failed as unavailable when it cannot be queued, keeping the scan and its photos so the user can see and delete it', async () => {
    const ctx = setup()
    await ready(ctx)
    ctx.jobs.failNextWith(new Error('queue is down'))

    const view = await create(ctx, three())

    expect(view).toMatchObject({ state: 'failed', reason: 'unavailable' })
    expect(await ctx.repository.findFaceScan(view.id)).toMatchObject({ state: 'failed', reason: 'unavailable' })
    expect(ctx.photos.stored.size).toBe(3)
    expect(ctx.jobs.enqueued).toEqual([])
    expect(await getScan(ctx, view.id)).toMatchObject({ state: 'failed', reason: 'unavailable' })
  })

  it('still answers when it cannot queue the job and cannot mark the scan failed either', async () => {
    class MarkFails extends FakeFaceScansRepository {
      override async updateFaceScan(): Promise<boolean> {
        throw new Error('database is down')
      }
    }
    const ctx = setup({ repository: new MarkFails() })
    await ready(ctx)
    ctx.jobs.failNextWith(new Error('queue is down'))

    await expect(create(ctx)).resolves.toMatchObject({ id: expect.any(String) })
  })
})

describe('FaceScanService.getFaceScan', () => {
  it('shows the profile\'s own scan, with a link for each photo', async () => {
    const ctx = setup()
    await ready(ctx)
    const made = await create(ctx, three())

    const view = await getScan(ctx, made.id)

    expect(view).toMatchObject({ id: made.id, state: 'analysing', reason: null, goal: 'glow', createdAt: T0 })
    expect(Object.keys(view.photos).sort()).toEqual(['front', 'left', 'right'])
    expect(Object.keys(view).sort()).toEqual(['createdAt', 'goal', 'id', 'photos', 'reason', 'rescanSuggested', 'result', 'state'])
  })

  it.each([
    ['another user', { userId: OTHER_USER, profileId: 'profile-9' }],
    ['the account\'s other profile', { profileId: OTHER_PROFILE }],
    ['another user acting as a profile of the same id', { userId: OTHER_USER }],
  ])('is 404 FACE_SCAN_NOT_FOUND for %s, the same as a scan that does not exist', async (_label, who) => {
    const ctx = setup()
    await ready(ctx)
    const made = await create(ctx)

    const error = await errorOf(getScan(ctx, made.id, who))

    expect(error).toBeInstanceOf(NotFoundError)
    expect(error.code).toBe('FACE_SCAN_NOT_FOUND')
  })

  it('is 404 FACE_SCAN_NOT_FOUND for an id that was never made, and 401 for a caller who is not signed in', async () => {
    const ctx = setup()

    expect((await errorOf(getScan(ctx, 'nothing-here'))).code).toBe('FACE_SCAN_NOT_FOUND')
    expect((await errorOf(asPublic(() => ctx.service.getFaceScan('nothing-here')))).code).toBe('AUTH_REQUIRED')
  })

  it('shows a scan that failed with its reason', async () => {
    const ctx = setup()
    await ready(ctx)
    ctx.jobs.failNextWith(new Error('queue is down'))
    const made = await create(ctx)

    expect(await getScan(ctx, made.id)).toMatchObject({ state: 'failed', reason: 'unavailable' })
  })
})

describe('FaceScanService: rescanSuggested', () => {
  it('is false while the goal is the one the latest scan was taken under', async () => {
    const ctx = setup()
    await ready(ctx, 'glow')
    const made = await create(ctx)

    expect((await getScan(ctx, made.id)).rescanSuggested).toBe(false)
  })

  it('is true once the goal differs from the one the latest scan was taken under, and false again when it changes back', async () => {
    const ctx = setup()
    await ready(ctx, 'glow')
    const made = await create(ctx)
    ctx.advance(MINUTE)
    await setGoal(ctx, 'brighter')
    expect((await getScan(ctx, made.id)).rescanSuggested).toBe(true)
    ctx.advance(MINUTE)

    await setGoal(ctx, 'glow')

    expect((await getScan(ctx, made.id)).rescanSuggested).toBe(false)
  })

  it('keeps the goal the scan was taken under in the view, whatever the goal is now', async () => {
    const ctx = setup()
    await ready(ctx, 'glow')
    const made = await create(ctx)
    ctx.advance(MINUTE)
    await setGoal(ctx, 'brighter')

    expect((await getScan(ctx, made.id)).goal).toBe('glow')
  })

  // It is about the profile's latest scan, not the scan being looked at: an older scan is not a reason to scan again once the newer one has the goal.
  it('is worked out from the profile\'s latest scan: an older scan is no cause to rescan once a newer one was taken under the current goal', async () => {
    const ctx = setup()
    await ready(ctx, 'glow')
    const older = await create(ctx)
    ctx.advance(MINUTE)
    await setGoal(ctx, 'brighter')
    expect((await getScan(ctx, older.id)).rescanSuggested).toBe(true)
    await create(ctx, { front: face({}, 2) })

    expect((await getScan(ctx, older.id)).rescanSuggested).toBe(false)
  })

  it('is false when the profile has typed words that nobody sorted into a goal, rather than a reason to scan', async () => {
    const ctx = setup()
    await ready(ctx, 'glow')
    const made = await create(ctx)
    ctx.advance(MINUTE)
    await asUser(() => ctx.goals.set({ text: 'something the reader finds no goal in' }))

    expect((await getScan(ctx, made.id)).rescanSuggested).toBe(false)
  })

  // `rescanSuggested` is the due rule itself (issue #145): it says "a scan is due now", so the app never offers a scan that `create` would refuse.
  it('is false again once the goal is back inside its resume window, because that chase has had its scan', async () => {
    const ctx = setup()
    await ready(ctx, 'glow')
    const made = await create(ctx)
    ctx.advance(MINUTE)
    await setGoal(ctx, 'brighter')
    await create(ctx, { front: face({}, 2) })
    ctx.advance(MINUTE)
    await setGoal(ctx, 'glow')

    expect((await getScan(ctx, made.id)).rescanSuggested).toBe(false)
  })

  it('is true once the goal has been left for longer than the resume window and taken up again: that goal starts fresh', async () => {
    const ctx = setup()
    await ready(ctx, 'glow')
    const made = await create(ctx)
    await setGoal(ctx, 'brighter')
    ctx.advance(RESUME_WINDOW + 1)
    await setGoal(ctx, 'glow')

    expect((await getScan(ctx, made.id)).rescanSuggested).toBe(true)
  })

  it('is false before the chase\'s review point, true at it, and false again once the check-in is taken', async () => {
    const ctx = setup()
    await ready(ctx, 'glow')
    const dayOne = await create(ctx)
    await becomeReady(ctx, dayOne.id)
    ctx.advance(REVIEW_POINT - HOUR - 1)
    expect((await getScan(ctx, dayOne.id)).rescanSuggested).toBe(false)
    ctx.advance(1)
    expect((await getScan(ctx, dayOne.id)).rescanSuggested).toBe(true)

    await create(ctx, { front: face({}, 2) })

    expect((await getScan(ctx, dayOne.id)).rescanSuggested).toBe(false)
  })

  it('is worked out when it is read: nothing about it is stored on the scan', async () => {
    const ctx = setup()
    await ready(ctx, 'glow')
    const made = await create(ctx)
    ctx.advance(MINUTE)
    await setGoal(ctx, 'brighter')

    await getScan(ctx, made.id)

    expect(Object.keys((await ctx.repository.findFaceScan(made.id))!).sort()).not.toContain('rescanSuggested')
  })
})

describe('FaceScanService.deleteFaceScan', () => {
  it('deletes the scan\'s photos from the bucket and its rows, and a later read is 404 FACE_SCAN_NOT_FOUND', async () => {
    const ctx = setup()
    await ready(ctx)
    const made = await create(ctx, three())

    await deleteScan(ctx, made.id)

    expect(ctx.photos.stored.size).toBe(0)
    expect(await ctx.repository.findFaceScan(made.id)).toBeNull()
    expect(await ctx.repository.photosOf(made.id)).toEqual([])
    expect((await errorOf(getScan(ctx, made.id))).code).toBe('FACE_SCAN_NOT_FOUND')
  })

  it('deletes only that scan: the profile\'s other scans keep their photos and rows', async () => {
    const ctx = setup()
    await ready(ctx, 'glow')
    const first = await create(ctx, three())
    ctx.advance(MINUTE)
    await setGoal(ctx, 'brighter')
    const second = await create(ctx, { front: face({}, 5) })

    await deleteScan(ctx, first.id)

    expect([...ctx.photos.stored.keys()]).toEqual([keyOf(second.id, 'front')])
    expect(await getScan(ctx, second.id)).toMatchObject({ id: second.id })
  })

  it.each([
    ['another user', { userId: OTHER_USER, profileId: 'profile-9' }],
    ['the account\'s other profile', { profileId: OTHER_PROFILE }],
  ])('is 404 FACE_SCAN_NOT_FOUND for %s, and deletes nothing', async (_label, who) => {
    const ctx = setup()
    await ready(ctx)
    const made = await create(ctx, three())

    const error = await errorOf(deleteScan(ctx, made.id, who))

    expect(error).toBeInstanceOf(NotFoundError)
    expect(error.code).toBe('FACE_SCAN_NOT_FOUND')
    expect(ctx.photos.stored.size).toBe(3)
    expect(await ctx.repository.findFaceScan(made.id)).not.toBeNull()
  })

  it('is 404 for a scan that was never made, and 401 for a caller who is not signed in', async () => {
    const ctx = setup()

    expect((await errorOf(deleteScan(ctx, 'nothing-here'))).code).toBe('FACE_SCAN_NOT_FOUND')
    expect((await errorOf(asPublic(() => ctx.service.deleteFaceScan('nothing-here')))).code).toBe('AUTH_REQUIRED')
  })

  it('deletes the photos before the rows, so a bucket that fails leaves the scan to delete again', async () => {
    class DeleteFails extends MemoryPhotoStore {
      fail = false
      override async delete(key: string): Promise<void> {
        if (this.fail) throw new Error('bucket is down')
        return super.delete(key)
      }
      override async deleteMany(keys: string[]): Promise<void> {
        if (this.fail) throw new Error('bucket is down')
        return super.deleteMany(keys)
      }
    }
    const photos = new DeleteFails({ environment: 'test' })
    const ctx = setup({ photos })
    await ready(ctx)
    const made = await create(ctx, three())
    photos.fail = true

    await expect(deleteScan(ctx, made.id)).rejects.toThrow('bucket is down')

    expect(await ctx.repository.findFaceScan(made.id)).not.toBeNull()
    expect(await getScan(ctx, made.id)).toMatchObject({ id: made.id })
    photos.fail = false
    await deleteScan(ctx, made.id)
    expect(photos.stored.size).toBe(0)
    expect(await ctx.repository.findFaceScan(made.id)).toBeNull()
  })

  it('deletes a scan that failed, with its photos', async () => {
    const ctx = setup()
    await ready(ctx)
    ctx.jobs.failNextWith(new Error('queue is down'))
    const made = await create(ctx, three())

    await deleteScan(ctx, made.id)

    expect(ctx.photos.stored.size).toBe(0)
    expect(await ctx.repository.findFaceScan(made.id)).toBeNull()
  })
})

describe('FaceScanService.photoForLink', () => {
  const tokenOf = (view: any, position = 'front') => (view.photos[position].url as string).slice('/api/v1/scans/faces/photos/'.length)

  it('opens a link from a scan view as the JPEG that was sent, with no signed-in caller needed: the link is the credential', async () => {
    const ctx = setup()
    await ready(ctx)
    const photos = three()
    const made = await create(ctx, photos)

    const opened = await ctx.service.photoForLink(tokenOf(made, 'right'))

    expect(opened).toEqual({ bytes: photos.right.bytes, mediaType: 'image/jpeg' })
  })

  it('is 404 PHOTO_NOT_FOUND once the photo is deleted', async () => {
    const ctx = setup()
    await ready(ctx)
    const made = await create(ctx)
    const token = tokenOf(made)
    await deleteScan(ctx, made.id)

    const error = await errorOf(ctx.service.photoForLink(token))

    expect(error).toBeInstanceOf(NotFoundError)
    expect(error.code).toBe('PHOTO_NOT_FOUND')
  })

  it('is 404 PHOTO_NOT_FOUND for a link that has expired, and still opens one a second before it does', async () => {
    const ctx = setup()
    await ready(ctx)
    const made = await create(ctx)
    const token = tokenOf(made)

    ctx.advance((PHOTO_LINK_TTL_SECONDS - 1) * SECOND)
    await expect(ctx.service.photoForLink(token)).resolves.toMatchObject({ mediaType: 'image/jpeg' })
    ctx.advance(SECOND)

    expect((await errorOf(ctx.service.photoForLink(token))).code).toBe('PHOTO_NOT_FOUND')
  })

  it.each([
    ['garbage', 'not-a-token'],
    ['empty', ''],
  ])('is 404 PHOTO_NOT_FOUND for a token that is %s', async (_label, token) => {
    const ctx = setup()

    expect((await errorOf(ctx.service.photoForLink(token))).code).toBe('PHOTO_NOT_FOUND')
  })

  it('is 404 PHOTO_NOT_FOUND for a link signed with another secret', async () => {
    const ctx = setup()
    await ready(ctx)
    const made = await create(ctx)
    const forged = await signPhotoLink({ key: keyOf(made.id, 'front'), userId: USER, profileId: PROFILE, expiresAt: new Date(T0.getTime() + MINUTE) } as Parameters<typeof signPhotoLink>[0], 'another-secret', T0)

    expect((await errorOf(ctx.service.photoForLink(forged))).code).toBe('PHOTO_NOT_FOUND')
  })

  it('does not open a product photo, even with a link that is validly signed for it: this route serves face photos only', async () => {
    const ctx = setup()
    const productKey = `photos/test/${USER}/some-scan/some-item.jpg`
    await ctx.photos.put(productKey, face())
    const productLink = await signPhotoLink({ key: productKey, userId: USER, expiresAt: new Date(T0.getTime() + MINUTE) }, PHOTO_SECRET, T0)

    expect((await errorOf(ctx.service.photoForLink(productLink))).code).toBe('PHOTO_NOT_FOUND')
  })
})

// A double tap, or two devices, can send two scans for the same profile and goal together. Both read "no scan under this goal yet" before either
// has written one, so the check alone cannot stop them: the write itself must refuse the second (createFaceScan with { expectLatestId }, which answers
// false when the profile's latest scan is no longer the one that was seen). The loser is told the scan is not due, and its photos leave the bucket.
describe('FaceScanService.create: two at once for one profile and goal', () => {
  /**
   * Holds the first `callers` readers of what the profile has already scanned (its latest scan, and the scans of its goal's chase) until all have
   * read it, so each decides on the state from before any of them writes. `gating` is turned off while a test sets a profile up, so the setup's own
   * reads do not use up an arrival.
   */
  const gatedRepository = (callers: number) => {
    /** One meeting point: every caller waits until `callers` of them have arrived, and everyone after that walks through. */
    class Gate {
      private arrived = 0
      private release!: () => void
      private readonly allArrived = new Promise<void>((resolve) => (this.release = resolve))
      async wait() {
        if (this.arrived >= callers) return
        this.arrived += 1
        if (this.arrived === callers) this.release()
        await this.allArrived
      }
    }
    class Gated extends FakeFaceScansRepository {
      gating = true
      private readonly latestGate = new Gate()
      private readonly chaseGate = new Gate()
      override async latestForProfile(...args: Parameters<FakeFaceScansRepository['latestForProfile']>) {
        const latest = await super.latestForProfile(...args)
        if (this.gating) await this.latestGate.wait()
        return latest
      }
      override async scansUnderGoalSince(...args: Parameters<FakeFaceScansRepository['scansUnderGoalSince']>) {
        const scans = await super.scansUnderGoalSince(...args)
        if (this.gating) await this.chaseGate.wait()
        return scans
      }
    }
    return new Gated()
  }

  it('makes one scan and queues one job; the other is 429 FACE_SCAN_NOT_DUE and leaves none of its photos in the bucket', async () => {
    const ctx = setup({ repository: gatedRepository(2) })
    await ready(ctx)

    const results = await Promise.allSettled([create(ctx, { front: face({}, 1), right: face({}, 2) }), create(ctx, { front: face({}, 3), right: face({}, 4) })])

    const won = results.filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(1)
    expect(lost[0]!.reason).toBeInstanceOf(RateLimitedError)
    expect(lost[0]!.reason.code).toBe('FACE_SCAN_NOT_DUE')
    expect(lost[0]!.reason.details).toMatchObject({ reason: 'already-scanned-for-goal' })
    const scanId = won[0]!.value.id
    expect((await ctx.repository.latestForProfile(PROFILE))!.id).toBe(scanId)
    expect([...ctx.photos.stored.keys()].sort()).toEqual([keyOf(scanId, 'front'), keyOf(scanId, 'right')].sort())
    expect(ctx.jobs.enqueued).toEqual([{ job: analyseFaceScanSpec.name, body: { faceScanId: scanId, step: 'upload', at: ctx.now().getTime() } }])
  })

  it('keeps the winner\'s own bytes in the bucket, not the loser\'s', async () => {
    const ctx = setup({ repository: gatedRepository(2) })
    await ready(ctx)
    const photos = [face({}, 11), face({}, 22)]

    const results = await Promise.allSettled(photos.map((front) => create(ctx, { front })))

    const winner = results.findIndex((r) => r.status === 'fulfilled')
    const scanId = (results[winner] as PromiseFulfilledResult<any>).value.id
    expect(ctx.photos.stored.get(keyOf(scanId, 'front'))!.bytes).toEqual(photos[winner]!.bytes)
  })

  it('makes one scan out of five at once', async () => {
    const ctx = setup({ repository: gatedRepository(5) })
    await ready(ctx)

    const results = await Promise.allSettled([1, 2, 3, 4, 5].map((marker) => create(ctx, { front: face({}, marker) })))

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected' && (r.reason as { code?: string }).code === 'FACE_SCAN_NOT_DUE')).toHaveLength(4)
    expect(ctx.photos.stored.size).toBe(1)
    expect(ctx.jobs.enqueued).toHaveLength(1)
  })

  it('does not keep the loser from scanning later under a new goal: the refusal is about the goal, not the profile', async () => {
    const ctx = setup({ repository: gatedRepository(2) })
    await ready(ctx, 'glow')
    await Promise.allSettled([create(ctx, { front: face({}, 1) }), create(ctx, { front: face({}, 2) })])
    ctx.advance(MINUTE)
    await setGoal(ctx, 'brighter')

    const next = await create(ctx, { front: face({}, 3) })

    expect(next.goal).toBe('brighter')
  })

  // The write refuses only what the due rule refuses: it must not block a scan the rule allows because the expected latest scan was taken under
  // another goal. Going back to a goal left for longer than the resume window starts it fresh, and that scan is due.
  it('does not let the write refuse a scan under a goal that has started fresh, after a scan under another goal in between', async () => {
    const ctx = setup()
    await ready(ctx, 'glow')
    await create(ctx, { front: face({}, 1) })
    ctx.advance(MINUTE)
    await setGoal(ctx, 'brighter')
    await create(ctx, { front: face({}, 2) })
    ctx.advance(RESUME_WINDOW + 1)
    await setGoal(ctx, 'glow')

    await expect(create(ctx, { front: face({}, 3) })).resolves.toMatchObject({ goal: 'glow' })
  })

  // Two taps at the review point both read "no check-in yet" before either writes, so the write must refuse the second, and with the reason that
  // fits: the chase's check-in has been taken.
  it('makes one check-in out of two sent at once, and tells the other that the check-in has been taken', async () => {
    const repository = gatedRepository(2)
    repository.gating = false
    const ctx = setup({ repository })
    await atReviewPoint(ctx, 'glow')
    repository.gating = true

    const results = await Promise.allSettled([create(ctx, { front: face({}, 1) }), create(ctx, { front: face({}, 2) })])

    const won = results.filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
    const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(1)
    expect(lost[0]!.reason).toBeInstanceOf(RateLimitedError)
    expect(lost[0]!.reason.code).toBe('FACE_SCAN_NOT_DUE')
    expect(lost[0]!.reason.details).toMatchObject({ reason: 'check-in-taken' })
    expect((await ctx.repository.findFaceScan(won[0]!.value.id))!.checkIn).toBe(true)
    expect(ctx.jobs.enqueued).toHaveLength(2)
  })

  it('removes the photos and queues nothing when the write is refused, whatever the cause: a repository that answers false', async () => {
    class Refuses extends FakeFaceScansRepository {
      override async createFaceScan(): Promise<boolean> {
        return false
      }
    }
    const ctx = setup({ repository: new Refuses() })
    await ready(ctx)

    const error = await errorOf(create(ctx, three()))

    expect(error).toBeInstanceOf(RateLimitedError)
    expect(error.code).toBe('FACE_SCAN_NOT_DUE')
    nothingStored(ctx)
  })

  it('asks the write to expect the latest scan it read: none for a first scan, and the previous scan\'s id for the next', async () => {
    const seen: (string | null | undefined)[] = []
    class Recording extends FakeFaceScansRepository {
      override async createFaceScan(...args: Parameters<FakeFaceScansRepository['createFaceScan']>) {
        seen.push(args[2]?.expectLatestId)
        return super.createFaceScan(...args)
      }
    }
    const ctx = setup({ repository: new Recording() })
    await ready(ctx, 'glow')
    const first = await create(ctx, { front: face({}, 1) })
    ctx.advance(MINUTE)
    await setGoal(ctx, 'brighter')

    await create(ctx, { front: face({}, 2) })

    expect(seen).toEqual([null, first.id])
  })
})
