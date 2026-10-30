import { describe, expect, it } from 'vitest'
import { runAs } from '../../lib/context'
import { MemoryEmailSender } from '../../providers/email/memory.email'
import { MemoryGoalReader } from '../../providers/goal-reading/memory.goal-reader'
import { MemoryJobQueue } from '../../providers/job-queue/memory.job-queue'
import { MemoryMentionReader } from '../../providers/mention-reading/memory.mention-reader'
import { MemoryPerfectCorpClient } from '../../providers/perfect-corp/memory.perfect-corp'
import { MemoryPhotoStore } from '../../providers/photo-store/memory.photo-store'
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
import { FakeFaceScansRepository } from './face-scans.repository.fake'
import { FaceScanService } from './face-scans.service'
import { FakeVendorSpendLedger } from './face-scans.vendor-spend.fake'

// What the before-and-after share card needs from the face scans (spec #259, C2): the current goal's day-one scan, and the asked-for scan when it is a later ready scan of
// the same chase, each with its front photo's key and its calendar date in the person's own zone. By profile id with no session, since the share asks. The face scans
// are made the way a person makes them (`create`, then the write the analysis makes), so day one is the real chase rule's answer and never a row written into place.
//
// THE CONTRACT THIS FILE PINS (the brief names the facts; the names are the assumptions):
//   new FaceScanService({ ...as before, reminders: { zoneFor(profileId): Promise<string | null> } })     the stored reminders zone (RemindersService.zoneFor)
//   beforeAndAfterFor(profileId, afterScanId): Promise<{ before: ShareScan | null; after: ShareScan | null }>
//     ShareScan = { scanId, frontPhotoKey, localDay }, localDay = 'YYYY-MM-DD' in `usableZone(now, storedZone)` (UTC when there is none or it is unusable).
//     before: the day-one scan of the current goal's chase (chaseStartFor over the goal history, then the earliest ready scan under the goal since the chase began),
//             with its front photo; null when there is no goal, no ready scan in the chase, or the day one has no front photo.
//     after:  the asked-for scan when it is `ready`, was taken under the current goal, after day one and inside the same chase, and has a front photo; else null, and
//             a scan that is unknown, another profile's, day one itself, still analysing, of another goal, of an earlier chase or without a front photo is not told apart.
//             null whenever `before` is. Never throws for any of these; reads only.

// The one clock every test hangs off. 23:30 UTC the evening before a Sunday: the day Europe/London's clocks go forward is the next morning, so this instant is
// 23:30 on the 30th in London (GMT) and in UTC, and already the 31st in Lagos (UTC+1, no change of clocks).
const T0 = new Date('2030-03-30T23:30:00.000Z')
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const RESUME_WINDOW = 90 * DAY
/** A goal's review point: when the chase's wider check-in scan is allowed, the only second ready scan a chase takes (issue #145, written out here). */
const REVIEW_POINT = 42 * DAY
const SCAN_SPACING = 30 * DAY

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

const setup = (zones: Record<string, string | null> = {}) => {
  let clock = T0
  let n = 0
  let g = 0
  const safety = new SafetyService({
    repository: new FakeSafetyRepository(),
    reader: new MemoryMentionReader(),
    catalog: NO_CATALOG,
    jobs: new MemoryJobQueue(),
    now: () => clock,
    newId: () => `safety-${crypto.randomUUID()}`,
  })
  const goals = new GoalsService({ repository: new FakeGoalsRepository(), reader: new MemoryGoalReader(), safety, now: () => clock, newId: () => `goal-${++g}` })
  const repository = new FakeFaceScansRepository()
  const service = new FaceScanService({
    repository,
    goals,
    photos: new MemoryPhotoStore({ environment: 'test' }),
    jobs: new MemoryJobQueue(),
    perfectCorp: new MemoryPerfectCorpClient(),
    aiUsage: new FakeVendorSpendLedger(),
    events: new MemoryScanEvents(),
    notifications: { faceScanReady: async () => undefined, faceScanNeedsRetake: async () => undefined, faceCheckInDue: async () => undefined },
    opsAlerts: new OpsAlertsService({ repository: new FakeOpsAlertsRepository(), jobs: new MemoryJobQueue(), email: new MemoryEmailSender(), recipient: '', environment: 'test', now: () => clock }),
    reminders: { zoneFor: async (profileId: string) => zones[profileId] ?? null },
    photoLinkSecret: PHOTO_SECRET,
    environment: 'test',
    now: () => clock,
    newId: () => `id-${++n}`,
  })
  return { service, repository, goals, advance: (ms: number) => (clock = new Date(clock.getTime() + ms)), now: () => clock }
}
type Ctx = ReturnType<typeof setup>

const asUser = <T>(fn: () => Promise<T>, profileId = PROFILE) => runAs({ kind: 'user', userId: USER, status: 'verified', profileId }, fn)
/** The share asks by profile id with no session. */
const asNobody = <T>(fn: () => Promise<T>) => runAs({ kind: 'public' }, fn)

const face = (): ProductImage => jpegPhoto({ width: 1080, height: 1440 })
const keyOf = (scanId: string, profileId = PROFILE) => `faces/test/${USER}/${profileId}/${scanId}/front.jpg`

const setGoal = (ctx: Ctx, goal: Goal, profileId = PROFILE) => asUser(() => ctx.goals.set({ goal }), profileId)
const ready = async (ctx: Ctx, goal: Goal = 'glow', profileId = PROFILE) => {
  await asUser(() => ctx.service.giveConsent(CURRENT_FACE_CONSENT_VERSION), profileId)
  await setGoal(ctx, goal, profileId)
}
const create = async (ctx: Ctx, profileId = PROFILE): Promise<string> => (await asUser(() => ctx.service.create({ front: face() }), profileId)).id as string
/** Makes the scan ready an hour later, with the very write the analysis step makes. */
const becomeReady = async (ctx: Ctx, id: string) => {
  ctx.advance(HOUR)
  await ctx.repository.completeFaceScan(id, { results: [], masks: [], skinType: null, skinAge: null, tablesVersion: 'tables-under-test', updatedAt: ctx.now() })
}
const read = (ctx: Ctx, afterScanId: string, profileId = PROFILE) => asNobody(() => ctx.service.beforeAndAfterFor(profileId, afterScanId))

/** A ready day one taken at T0, then the clock at the chase's review point, then a second scan (the check-in) taken there and made ready. */
const dayOneThenCheckIn = async (ctx: Ctx, goal: Goal = 'glow') => {
  await ready(ctx, goal)
  const dayOne = await create(ctx)
  await becomeReady(ctx, dayOne)
  ctx.advance(REVIEW_POINT - HOUR)
  const checkIn = await create(ctx)
  await becomeReady(ctx, checkIn)
  return { dayOne, checkIn }
}

describe('FaceScanService.beforeAndAfterFor', () => {
  it('answers the day-one scan and the asked-for later scan, each with its front photo key and its date', async () => {
    const ctx = setup()
    const { dayOne, checkIn } = await dayOneThenCheckIn(ctx)

    const answer = await read(ctx, checkIn)

    expect(answer).toEqual({
      before: { scanId: dayOne, frontPhotoKey: keyOf(dayOne), localDay: '2030-03-30' },
      after: { scanId: checkIn, frontPhotoKey: keyOf(checkIn), localDay: '2030-05-11' },
    })
  })

  it('answers for the fairer goal as for any other: every goal may share', async () => {
    const ctx = setup()
    const { dayOne, checkIn } = await dayOneThenCheckIn(ctx, 'brighter')

    const answer = await read(ctx, checkIn)

    expect(answer.before?.scanId).toBe(dayOne)
    expect(answer.after?.scanId).toBe(checkIn)
  })

  it('needs no session: it answers for the profile it is given', async () => {
    const ctx = setup()
    const { dayOne, checkIn } = await dayOneThenCheckIn(ctx)

    const answer = await asNobody(() => ctx.service.beforeAndAfterFor(PROFILE, checkIn))

    expect(answer.before?.scanId).toBe(dayOne)
    expect(answer.after?.scanId).toBe(checkIn)
  })

  it('reads the dates in the stored zone: Lagos is an hour ahead of UTC, so the evening scans are on the next date', async () => {
    const ctx = setup({ [PROFILE]: 'Africa/Lagos' })
    const { checkIn } = await dayOneThenCheckIn(ctx)

    const answer = await read(ctx, checkIn)

    expect(answer.before?.localDay).toBe('2030-03-31')
    expect(answer.after?.localDay).toBe('2030-05-12')
  })

  it('reads the dates across a change of clocks: London is on GMT at day one and on BST at the second scan, so only the second date moves on', async () => {
    const ctx = setup({ [PROFILE]: 'Europe/London' })
    const { checkIn } = await dayOneThenCheckIn(ctx)

    const answer = await read(ctx, checkIn)

    expect(answer.before?.localDay).toBe('2030-03-30')
    expect(answer.after?.localDay).toBe('2030-05-12')
  })

  it.each([
    ['no zone stored', null],
    ['a zone Intl does not know', 'Mars/Olympus_Mons'],
  ])('reads the dates in UTC with %s', async (_name, zone) => {
    const ctx = setup({ [PROFILE]: zone })
    const { checkIn } = await dayOneThenCheckIn(ctx)

    const answer = await read(ctx, checkIn)

    expect(answer.before?.localDay).toBe('2030-03-30')
    expect(answer.after?.localDay).toBe('2030-05-11')
  })

  it("uses the profile's own zone, not another profile's", async () => {
    const ctx = setup({ [PROFILE]: 'Africa/Lagos', [OTHER_PROFILE]: 'Europe/London' })
    const { checkIn } = await dayOneThenCheckIn(ctx)

    const answer = await read(ctx, checkIn)

    expect(answer.before?.localDay).toBe('2030-03-31')
  })
})

describe('FaceScanService.beforeAndAfterFor: when there is no day one', () => {
  it('answers nothing for a profile with no goal and no scans', async () => {
    const ctx = setup()

    expect(await read(ctx, 'id-1')).toEqual({ before: null, after: null })
  })

  it('answers nothing while the only scan of the chase is still being analysed', async () => {
    const ctx = setup()
    await ready(ctx)
    const first = await create(ctx)

    expect(await read(ctx, first)).toEqual({ before: null, after: null })
  })

  it('answers nothing for a day one with no front photo, even though the asked-for scan is a good one', async () => {
    const ctx = setup()
    await ready(ctx)
    // The product always stores a front photo, so a scan without one is made by the write alone.
    await ctx.repository.createFaceScan({ id: 'scan-no-front', userId: USER, profileId: PROFILE, goalAtScan: 'glow', createdAt: ctx.now() }, [])
    await becomeReady(ctx, 'scan-no-front')
    ctx.advance(REVIEW_POINT)
    const checkIn = await create(ctx)
    await becomeReady(ctx, checkIn)

    expect(await read(ctx, checkIn)).toEqual({ before: null, after: null })
  })

  it('answers nothing for another profile\'s scans: this profile has no day one of its own', async () => {
    const ctx = setup()
    await ready(ctx, 'glow', OTHER_PROFILE)
    const theirs = await create(ctx, OTHER_PROFILE)
    await becomeReady(ctx, theirs)
    await ready(ctx)

    expect(await read(ctx, theirs)).toEqual({ before: null, after: null })
  })
})

describe('FaceScanService.beforeAndAfterFor: the asked-for scan is not an eligible later scan', () => {
  const noAfter = (answer: { before: unknown; after: unknown }) => expect(answer.after).toBeNull()

  it('answers the day one and no after for an id nobody has', async () => {
    const ctx = setup()
    const { dayOne } = await dayOneThenCheckIn(ctx)

    const answer = await read(ctx, 'no-such-scan')

    expect(answer.before?.scanId).toBe(dayOne)
    noAfter(answer)
  })

  it('answers no after for the day one itself: it is not a later scan', async () => {
    const ctx = setup()
    const { dayOne } = await dayOneThenCheckIn(ctx)

    const answer = await read(ctx, dayOne)

    expect(answer.before?.scanId).toBe(dayOne)
    noAfter(answer)
  })

  it("answers no after for another profile's ready scan, even one taken after this profile's day one", async () => {
    const ctx = setup()
    const { dayOne } = await dayOneThenCheckIn(ctx)
    await ready(ctx, 'glow', OTHER_PROFILE)
    ctx.advance(SCAN_SPACING)
    const theirs = await create(ctx, OTHER_PROFILE)
    await becomeReady(ctx, theirs)

    const answer = await read(ctx, theirs)

    expect(answer.before?.scanId).toBe(dayOne)
    noAfter(answer)
  })

  it('answers no after for a later scan that is not ready yet', async () => {
    const ctx = setup()
    await ready(ctx)
    const dayOne = await create(ctx)
    await becomeReady(ctx, dayOne)
    ctx.advance(REVIEW_POINT - HOUR)
    const analysing = await create(ctx)

    const answer = await read(ctx, analysing)

    expect(answer.before?.scanId).toBe(dayOne)
    noAfter(answer)
  })

  it('answers no after for a scan taken under another goal inside the window, though it is later and ready', async () => {
    const ctx = setup()
    await ready(ctx, 'glow')
    const dayOne = await create(ctx)
    await becomeReady(ctx, dayOne)
    ctx.advance(SCAN_SPACING)
    await setGoal(ctx, 'brighter')
    const other = await create(ctx)
    await becomeReady(ctx, other)
    ctx.advance(2 * DAY)
    // Back to the first goal inside the resume window: the same chase, with the scan under the other goal in the middle of it.
    await setGoal(ctx, 'glow')

    const answer = await read(ctx, other)

    expect(answer.before?.scanId).toBe(dayOne)
    noAfter(answer)
  })

  it("answers no after for a scan of an earlier chase of the same goal, and the new chase's day one as before", async () => {
    const ctx = setup()
    await ready(ctx, 'glow')
    const earlier = await create(ctx)
    await becomeReady(ctx, earlier)
    ctx.advance(10 * DAY)
    await setGoal(ctx, 'brighter')
    // Back after more than the 90-day resume window: a new chase of the same goal.
    ctx.advance(RESUME_WINDOW + DAY)
    await setGoal(ctx, 'glow')
    const newDayOne = await create(ctx)
    await becomeReady(ctx, newDayOne)

    const answer = await read(ctx, earlier)

    expect(answer.before?.scanId).toBe(newDayOne)
    noAfter(answer)
  })

  it('answers no after for a later ready scan with no front photo', async () => {
    const ctx = setup()
    const { dayOne } = await dayOneThenCheckIn(ctx)
    // The product always stores a front photo, so a scan without one is made by the write alone.
    ctx.advance(DAY)
    await ctx.repository.createFaceScan({ id: 'scan-no-front', userId: USER, profileId: PROFILE, goalAtScan: 'glow', createdAt: ctx.now() }, [])
    await becomeReady(ctx, 'scan-no-front')

    const answer = await read(ctx, 'scan-no-front')

    expect(answer.before?.scanId).toBe(dayOne)
    noAfter(answer)
  })
})
