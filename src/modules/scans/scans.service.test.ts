import { describe, expect, it, vi } from 'vitest'
import { PermanentJobError } from '../../jobs/job'
import { ConflictError, NotFoundError, RateLimitedError, UnauthorizedError, UnavailableError, ValidationError } from '../../lib/errors'
import { runAs } from '../../lib/context'
import { PHOTO_LINK_TTL_SECONDS, signPhotoLink, verifyPhotoLink } from '../../lib/photo-link'
import { AiBudgetExceededError } from '../../providers/anthropic/ai-spend.provider'
import { AnthropicRefusalError, AnthropicRequestError, AnthropicUnavailableError } from '../../providers/anthropic/anthropic.provider'
import { MemoryCatalogImageStore } from '../../providers/catalog-images/memory.catalog-image-store'
import { MemoryJobQueue } from '../../providers/job-queue/memory.job-queue'
import { MemoryLabelReader } from '../../providers/label-reading/memory.label-reader'
import { MemoryNameSplitter } from '../../providers/name-splitting/memory.name-splitter'
import { MemoryPhotoStore } from '../../providers/photo-store/memory.photo-store'
import { MemoryProductAnalyst } from '../../providers/product-analysis/memory.product-analyst'
import type { LabelReading } from '../../providers/label-reading/label-reader.provider'
import type { DraftConcern, ProductImage } from '../../providers/product-analysis/product-analyst.provider'
import { MemoryProductRecognizer } from '../../providers/product-recognition/memory.product-recognizer'
import type { Recognition, ShelfProduct, ShelfRecognition } from '../../providers/product-recognition/product-recognizer.provider'
import { MemoryProductResearcher } from '../../providers/product-research/memory.product-researcher'
import { MemoryPushSender } from '../../providers/push/memory.push'
import type { ProductIdentity } from '../../providers/product-research/product-researcher.provider'
import { MemoryScanEvents } from '../../providers/scan-events/memory.scan-events'
import { identityKey } from '../catalog/catalog.identity'
import { FakeCatalogRepository } from '../catalog/catalog.repository.fake'
import { AnalysisInProgressError, CatalogBusyError, ProductCatalogService, ResearchInProgressError } from '../catalog/catalog.service'
import { REFERENCE_VERSION } from '../catalog/catalog.reference'
import { ANALYSIS_VERSION, FRESH_FOR_DAYS } from '../catalog/catalog.vocabulary'
import { FakeNotificationSettingsRepository } from '../notifications/notification-settings.repository.fake'
import { type SendPushMessage, sendPushSpec } from '../notifications/notifications.job-specs'
import { NotificationsService } from '../notifications/notifications.service'
import { FakePushTokensRepository } from '../notifications/push-tokens.repository.fake'
import { FakeProfilesRepository } from '../profiles/profiles.repository.fake'
import { advanceScanItemSpec, type AdvanceScanItemMessage } from './scans.job-specs'
import { garbagePhoto, jpegPhoto, markedJpeg, pngPhoto, webpPhoto } from './scans.photos.fake'
import { CAUTION_RULES_VERSION, cautionFor } from './scans.cautions'
import { toScanResponse } from './scans.presenter'
import { FakeScansRepository } from './scans.repository.fake'
import { SCAN_POLICY, ScanService } from './scans.service'

// The one clock every test hangs off; fixtures are offsets from it.
const T0 = new Date('2030-06-15T12:00:00.000Z')
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const PHOTO_SECRET = 'photo-link-secret-for-tests'
const IP_SECRET = 'ip-hash-secret-for-tests'
const USER = 'user-1'
const OTHER_USER = 'user-2'
// Two profiles of one account (USER): a scan belongs to the profile that made it.
const PROFILE = 'profile-1'
const OTHER_PROFILE = 'profile-2'
const IP = '203.0.113.7'
const OTHER_IP = '198.51.100.23'
const SOURCE_URL = 'https://www.cerave.com/hydrating-cleanser'
const IMAGE_URL = 'https://www.cerave.com/images/hydrating-cleanser.jpg'

/** Nothing here is in the seed reference data, so a formulation of these needs no concern. */
const CLEAN = ['Aqua', 'Glycerin', 'Cetearyl Alcohol']
/** "Mercury" is a banned substance in the seed reference data: an analysis with no concerns is rejected. */
const WITH_MERCURY = ['Aqua', 'Mercury', 'Glycerin']

const CERAVE: ProductIdentity = { brand: 'CeraVe', name: 'Hydrating Facial Cleanser', category: 'skin' }
const seen = (over: Partial<Extract<Recognition, { classification: 'beauty-product' }>> = {}): Recognition => ({
  classification: 'beauty-product',
  brand: CERAVE.brand,
  name: CERAVE.name,
  category: CERAVE.category,
  confidence: 0.9,
  ...over,
})

type Ctx = ReturnType<typeof setup>

type SetupOptions = {
  policy?: Partial<typeof SCAN_POLICY>
  repository?: FakeScansRepository
  photos?: MemoryPhotoStore
  events?: (repository: FakeScansRepository) => MemoryScanEvents
  ipHashSecret?: string
}

const setup = (options: SetupOptions = {}) => {
  let clock = T0
  let n = 0
  let c = 0
  const repository = options.repository ?? new FakeScansRepository()
  const catalogRepository = new FakeCatalogRepository()
  const researcher = new MemoryProductResearcher()
  const analyst = new MemoryProductAnalyst()
  const images = new MemoryCatalogImageStore()
  const catalog = new ProductCatalogService({
    repository: catalogRepository,
    researcher,
    analyst,
    images,
    imageKeyPrefix: 'catalog/test',
    now: () => clock,
    newId: () => `cat-${++c}`,
  })
  const recognizer = new MemoryProductRecognizer()
  recognizer.respondWith(() => seen())
  const labelReader = new MemoryLabelReader()
  const nameSplitter = new MemoryNameSplitter()
  const photos = options.photos ?? new MemoryPhotoStore({ environment: 'test' })
  const jobs = new MemoryJobQueue()
  // The push jobs go to a queue of their own: `queued`, `queuedWithTime` and `drain` read every message on `jobs` as a scan step.
  const pushJobs = new MemoryJobQueue()
  const notifications = new NotificationsService({
    pushTokens: new FakePushTokensRepository(),
    settings: new FakeNotificationSettingsRepository(),
    push: new MemoryPushSender(),
    jobs: pushJobs,
    deviceIdKey: 'device-key-for-tests',
    now: () => clock,
  })
  const events = options.events?.(repository) ?? new MemoryScanEvents()
  const service = new ScanService({
    repository,
    catalog,
    recognizer,
    labelReader,
    nameSplitter,
    photos,
    jobs,
    events,
    notifications,
    photoLinkSecret: PHOTO_SECRET,
    ipHashSecret: options.ipHashSecret ?? IP_SECRET,
    environment: 'test',
    now: () => clock,
    newId: () => `id-${++n}`,
    ...(options.policy ? { policy: { ...SCAN_POLICY, ...options.policy } } : {}),
  })
  return {
    service,
    repository,
    catalog,
    catalogRepository,
    researcher,
    analyst,
    images,
    recognizer,
    labelReader,
    nameSplitter,
    photos,
    jobs,
    pushJobs,
    events,
    advance: (ms: number) => (clock = new Date(clock.getTime() + ms)),
    now: () => clock,
    /** Index of the next queue message `drain` will run. */
    cursor: { next: 0 },
  }
}

const user = (userId = USER, profileId = PROFILE) => ({ kind: 'user', userId, status: 'anonymous', profileId }) as const
const asUser = <T>(fn: () => Promise<T>, userId = USER, profileId = PROFILE) => runAs(user(userId, profileId), fn)
const asJob = <T>(fn: () => Promise<T>) => runAs({ kind: 'system', job: advanceScanItemSpec.name }, fn)

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error as Error & { code?: string; details?: { retryAfterSeconds?: number } }
  }
  throw new Error('expected the promise to reject')
}

type Step = 'recognise' | 'match' | 'research' | 'read-label' | 'analyse'

// The views are loosely typed here on purpose: these tests read the public shape, and null checks on `image` would only add noise.
const create = (ctx: Ctx, photos: ProductImage[] = [markedJpeg(1)], over: { ip?: string; userId?: string; profileId?: string } = {}): Promise<any> =>
  asUser(() => ctx.service.create({ photos, clientIp: over.ip ?? IP }), over.userId ?? USER, over.profileId ?? PROFILE)
const getScan = (ctx: Ctx, scanId: string, userId = USER, profileId = PROFILE): Promise<any> => asUser(() => ctx.service.getScan(scanId), userId, profileId)
const run = (ctx: Ctx, itemId: string, step: Step) => asJob(() => ctx.service.advance(itemId, step))
/** The formulation the stored item points at (a scan's view carries the product's identity only, not its formulation). */
const formulationIdOf = async (ctx: Ctx, itemId: string) => (await ctx.repository.findItem(itemId))!.formulationId!
/** What the catalog holds for the item's formulation: its ingredients, source and concerns. */
const formulationViewOf = async (ctx: Ctx, itemId: string) => ctx.catalog.productView(await formulationIdOf(ctx, itemId))
const itemOf = async (ctx: Ctx, scanId: string, itemId: string): Promise<any> => (await getScan(ctx, scanId)).items.find((i: { id: string }) => i.id === itemId)!
const stateOf = async (ctx: Ctx, scanId: string, itemId: string) => {
  const item = await itemOf(ctx, scanId, itemId)
  return { state: item.state, reason: item.reason }
}
const photoKey = (scanId: string, itemId: string, extension = 'jpg', userId = USER) => `photos/test/${userId}/${scanId}/${itemId}.${extension}`
const backKey = (scanId: string, itemId: string, extension = 'jpg', userId = USER) => `photos/test/${userId}/${scanId}/${itemId}-back.${extension}`
// The time stamp (`at`) and any delay are checked by their own tests; here a message is the job, the item and the step.
const queued = (ctx: Ctx) =>
  ctx.jobs.enqueued.map((e) => {
    const { itemId, step } = e.body as { itemId: string; step: Step }
    return { job: e.job, itemId, step }
  })
/** The messages with the time stamp and the delay, for the tests about them. */
const queuedWithTime = (ctx: Ctx) => ctx.jobs.enqueued.map((e) => ({ ...(e.body as { itemId: string; step: Step; at: number }), ...(e.delaySeconds === undefined ? {} : { delaySeconds: e.delaySeconds }) }))
const advanceMessage = (itemId: string, step: Step) => ({ job: advanceScanItemSpec.name, itemId, step })

/** Runs the queue the way the dispatcher would, one message at a time, until nothing new is waiting. Returns the steps it ran. */
const drain = async (ctx: Ctx): Promise<string[]> => {
  const ran: string[] = []
  while (ctx.cursor.next < ctx.jobs.enqueued.length) {
    const { itemId, step } = ctx.jobs.enqueued[ctx.cursor.next++]!.body as { itemId: string; step: Step }
    await run(ctx, itemId, step)
    ran.push(step)
  }
  return ran
}

/** A one-photo scan, created. */
const scanOne = async (ctx: Ctx, photo: ProductImage = markedJpeg(1)) => {
  const scan = await create(ctx, [photo])
  return { scanId: scan.id as string, itemId: scan.items[0].id as string }
}

/** Puts a catalog product into the state a scan of it will find: researched and analysed (ready), or only researched (needs-analysis). */
const catalogued = async (ctx: Ctx, who: ProductIdentity = CERAVE, over: { ingredients?: string[]; analysed?: boolean; imageUrl?: string } = {}) => {
  const { ingredients = CLEAN, analysed = true, imageUrl } = over
  ctx.researcher.respondWith(() => ({ found: true, ingredients, sourceUrl: SOURCE_URL }))
  if (imageUrl) ctx.images.respondToPage(SOURCE_URL, imageUrl)
  const resolved = await ctx.catalog.resolve(who)
  if (resolved.kind !== 'needs-research') throw new Error(`expected needs-research, got ${resolved.kind}`)
  const found = await ctx.catalog.research(resolved.productId)
  if (found.kind !== 'found') throw new Error(`expected found, got ${found.kind}`)
  if (analysed) await ctx.catalog.analyse(found.formulationId)
  return { productId: resolved.productId, formulationId: found.formulationId }
}

/** A scan of one photo taken to the given state through the real steps. */
const reach = async (
  ctx: Ctx,
  target: 'needs-confirmation' | 'matching' | 'researching' | 'needs-back-photo' | 'reading-label',
) => {
  ctx.recognizer.respondWith(() => seen(target === 'needs-confirmation' ? { confidence: 0.3 } : {}))
  const { scanId, itemId } = await scanOne(ctx)
  await run(ctx, itemId, 'recognise')
  if (target === 'needs-confirmation' || target === 'matching') return { scanId, itemId }
  await run(ctx, itemId, 'match')
  if (target === 'researching') return { scanId, itemId }
  // The researcher finds nothing unless a test says otherwise, so the item now needs the back of the pack.
  await run(ctx, itemId, 'research')
  if (target === 'needs-back-photo') return { scanId, itemId }
  await asUser(() => ctx.service.addBackPhoto(scanId, itemId, markedJpeg(9), IP))
  return { scanId, itemId }
}

/** A scan item that has been researched (found) and is waiting for its analysis. */
const analysingItem = async (ctx: Ctx, ingredients: string[] = CLEAN) => {
  const taken = await reach(ctx, 'researching')
  ctx.researcher.respondWith(() => ({ found: true, ingredients, sourceUrl: SOURCE_URL }))
  await run(ctx, taken.itemId, 'research')
  return taken
}

const BLURRY: Recognition = { classification: 'unreadable' }
const TURNED_AWAY: Recognition = { classification: 'label-not-visible' }

const retake = (ctx: Ctx, scanId: string, itemId: string, photo: ProductImage = markedJpeg(20), over: { ip?: string; userId?: string; profileId?: string } = {}) =>
  asUser(() => ctx.service.retake(scanId, itemId, photo, over.ip ?? IP), over.userId ?? USER, over.profileId ?? PROFILE)

/**
 * A one-photo scan whose front photo (and then each retaken photo, markers 21, 22, ...) the recognizer answered with `reads`, in turn,
 * through the real steps: after the first unreadable read the item asks for a retake, and after the third it asks for identification.
 */
const failedFront = async (ctx: Ctx, reads: Recognition[]) => {
  const { scanId, itemId } = await scanOne(ctx)
  for (const [i, read] of reads.entries()) {
    ctx.recognizer.respondWith(() => read)
    if (i > 0) {
      ctx.advance(SECOND)
      await retake(ctx, scanId, itemId, markedJpeg(20 + i))
    }
    await run(ctx, itemId, 'recognise')
  }
  // The steps above were run by hand, so the queue's messages for them are spent: a later `drain` must not run them again.
  ctx.cursor.next = ctx.jobs.enqueued.length
  return { scanId, itemId }
}

describe('SCAN_POLICY', () => {
  it('sets the photo, size, dimension, front photo, back photo, daily quota, confirmation, shelf photo and items-per-scan limits', () => {
    expect(SCAN_POLICY).toEqual({
      maxPhotosPerScan: 10,
      maxPhotoBytes: 2_000_000,
      maxPhotoEdge: 1600,
      maxFrontPhotos: 3,
      maxBackPhotos: 3,
      dailyPhotosPerUser: 30,
      dailyPhotosPerIp: 100,
      confirmBelowConfidence: 0.6,
      doneRepairWindowMs: 3 * HOUR,
      maxShelfPhotos: 3,
      maxItemsPerScan: 20,
    })
  })
})

describe('ScanService secrets', () => {
  it('keeps the photo link and IP hash secrets out of the service when it is spread or listed', () => {
    const { service } = setup()

    const spread = { ...service }
    expect(Object.keys(spread)).toContain('environment')
    const values = Object.values(spread)
    expect(values).not.toContain(PHOTO_SECRET)
    expect(values).not.toContain(IP_SECRET)
  })
})

describe('ScanService.create', () => {
  it('makes a scan of one recognising item per photo, in photo order, and says when it was made', async () => {
    const ctx = setup()

    const scan = await create(ctx, [markedJpeg(1), webpPhoto(), markedJpeg(3)])

    expect(scan).toMatchObject({ id: expect.any(String), createdAt: T0 })
    expect(scan.items.map((i: { position: number; state: string; reason: unknown }) => [i.position, i.state, i.reason])).toEqual([
      [0, 'recognising', null],
      [1, 'recognising', null],
      [2, 'recognising', null],
    ])
    expect(new Set(scan.items.map((i: { id: string }) => i.id)).size).toBe(3)
    expect(scan.items[0]).not.toHaveProperty('product')
  })

  it('keeps each photo private at photos/<environment>/<user>/<scan>/<item>.<jpg|webp>, as the bytes and type it was sent', async () => {
    const ctx = setup()
    const [first, second] = [markedJpeg(1), webpPhoto()]

    const scan = await create(ctx, [first, second])

    const [a, b] = scan.items
    expect(ctx.photos.stored.get(photoKey(scan.id, a.id, 'jpg'))).toEqual(first)
    expect(ctx.photos.stored.get(photoKey(scan.id, b.id, 'webp'))).toEqual(second)
    expect(ctx.photos.stored.size).toBe(2)
  })

  it('makes every scan of this route a product scan', async () => {
    const ctx = setup()

    const scan = await create(ctx, [markedJpeg(1), markedJpeg(2)])

    expect((await ctx.repository.findScan(scan.id))!.kind).toBe('product')
  })

  it('records one photo per uploaded photo, in upload order, each still recognising and holding no image of its own', async () => {
    const ctx = setup()

    const scan = await create(ctx, [markedJpeg(1), webpPhoto(), markedJpeg(3)])

    const photos = await ctx.repository.photosOf(scan.id)
    expect(photos.map((p) => [p.position, p.state, p.photoKey, p.userId, p.scanId])).toEqual([
      [0, 'recognising', null, USER, scan.id],
      [1, 'recognising', null, USER, scan.id],
      [2, 'recognising', null, USER, scan.id],
    ])
    expect(new Set(photos.map((p) => p.id)).size).toBe(3)
    expect(photos.every((p) => p.createdAt.getTime() === T0.getTime())).toBe(true)
  })

  it('points each item at the photo it was made from, and keeps the image on the item', async () => {
    const ctx = setup()

    const scan = await create(ctx, [markedJpeg(1), webpPhoto()])

    const photos = await ctx.repository.photosOf(scan.id)
    const items = await ctx.repository.itemsOf(scan.id)
    expect(items.map((i) => i.photoId)).toEqual(photos.map((p) => p.id))
    expect(items.map((i) => i.photoKey)).toEqual([photoKey(scan.id, items[0]!.id, 'jpg'), photoKey(scan.id, items[1]!.id, 'webp')])
  })

  it('enqueues one recognise job per item and nothing else', async () => {
    const ctx = setup()

    const scan = await create(ctx, [markedJpeg(1), markedJpeg(2)])

    expect(queued(ctx)).toEqual(scan.items.map((i: { id: string }) => advanceMessage(i.id, 'recognise')))
  })

  it('shows each new item the owner\'s own photo through a signed link that opens that photo for 5 minutes', async () => {
    const ctx = setup()

    const scan = await create(ctx)

    const item = scan.items[0]
    expect(item.image).toEqual({ kind: 'user', url: expect.stringMatching(/^\/api\/v1\/scans\/products\/photos\/[A-Za-z0-9_-]+$/) })
    const token = item.image.url.replace('/api/v1/scans/products/photos/', '')
    const key = photoKey(scan.id, item.id)
    expect(await verifyPhotoLink(token, PHOTO_SECRET, T0)).toEqual({ key, userId: USER })
    expect(await verifyPhotoLink(token, PHOTO_SECRET, new Date(T0.getTime() + (PHOTO_LINK_TTL_SECONDS - 1) * SECOND))).toEqual({ key, userId: USER })
    expect(await verifyPhotoLink(token, PHOTO_SECRET, new Date(T0.getTime() + PHOTO_LINK_TTL_SECONDS * SECOND))).toBeNull()
  })

  it('answers the same view that getScan gives', async () => {
    const ctx = setup()

    const scan = await create(ctx, [markedJpeg(1), markedJpeg(2)])

    expect(await getScan(ctx, scan.id)).toEqual(scan)
  })

  it('refuses a public caller with AUTH_REQUIRED and keeps nothing', async () => {
    const ctx = setup()

    const error = await errorOf(runAs({ kind: 'public' }, () => ctx.service.create({ photos: [markedJpeg(1)], clientIp: IP })))

    expect(error).toBeInstanceOf(UnauthorizedError)
    expect(error.code).toBe('AUTH_REQUIRED')
    expect(ctx.photos.stored.size).toBe(0)
    expect(ctx.jobs.enqueued).toEqual([])
  })

  describe('photo rules', () => {
    const rejected = async (ctx: Ctx, photos: ProductImage[]) => {
      const error = await errorOf(create(ctx, photos))
      expect(error).toBeInstanceOf(ValidationError)
      // A refused upload leaves nothing behind.
      expect(ctx.photos.stored.size).toBe(0)
      expect(ctx.jobs.enqueued).toEqual([])
      return error
    }

    it('refuses a scan with no photo', async () => {
      await rejected(setup(), [])
    })

    it('accepts 10 photos and refuses 11 as TOO_MANY_IMAGES', async () => {
      const ctx = setup()
      const ten = Array.from({ length: 10 }, (_, i) => markedJpeg(i))

      expect((await create(ctx, ten)).items).toHaveLength(10)

      const error = await rejected(setup(), [...ten, markedJpeg(11)])
      expect(error.code).toBe('TOO_MANY_IMAGES')
    })

    it.each([
      ['a PNG', pngPhoto()],
      ['a PNG that says it is a JPEG', { ...pngPhoto(), mediaType: 'image/jpeg' as const }],
      ['bytes that are not an image', garbagePhoto()],
    ])('refuses %s as UNSUPPORTED_IMAGE', async (_label, photo) => {
      const error = await rejected(setup(), [photo])

      expect(error.code).toBe('UNSUPPORTED_IMAGE')
    })

    it('goes by the bytes, not by the type the caller claims: a JPEG sent as image/webp is kept as a JPEG', async () => {
      const ctx = setup()

      const scan = await create(ctx, [{ ...jpegPhoto(), mediaType: 'image/webp' }])

      const stored = ctx.photos.stored.get(photoKey(scan.id, scan.items[0].id, 'jpg'))
      expect(stored?.mediaType).toBe('image/jpeg')
    })

    it.each([
      ['wide', 1600, 600],
      ['tall', 600, 1600],
    ])('accepts a photo whose %s edge is exactly 1600 pixels', async (_label, width, height) => {
      const ctx = setup()

      await expect(create(ctx, [jpegPhoto({ width, height }), webpPhoto({ width, height })])).resolves.toMatchObject({ items: expect.any(Array) })
    })

    it.each([
      ['wide JPEG', () => jpegPhoto({ width: 1601, height: 600 })],
      ['tall JPEG', () => jpegPhoto({ width: 600, height: 1601 })],
      ['wide WebP', () => webpPhoto({ width: 1601, height: 600 })],
      ['tall WebP', () => webpPhoto({ width: 600, height: 1601 })],
    ])('refuses a %s with an edge of 1601 pixels as IMAGE_TOO_LARGE', async (_label, make) => {
      const error = await rejected(setup(), [make()])

      expect(error.code).toBe('IMAGE_TOO_LARGE')
    })

    it('accepts a photo of exactly 2,000,000 bytes and refuses one byte more as IMAGE_TOO_LARGE', async () => {
      await expect(create(setup(), [jpegPhoto({ size: 2_000_000 })])).resolves.toMatchObject({ items: expect.any(Array) })

      const error = await rejected(setup(), [jpegPhoto({ size: 2_000_001 })])
      expect(error.code).toBe('IMAGE_TOO_LARGE')
    })

    it('refuses the whole scan, storing none of its photos, when only one photo is bad', async () => {
      const error = await rejected(setup(), [markedJpeg(1), markedJpeg(2), pngPhoto()])

      expect(error.code).toBe('UNSUPPORTED_IMAGE')
    })
  })

  describe('daily quotas', () => {
    const limited = async (ctx: Ctx, count: number, over: { ip?: string; userId?: string } = {}) => {
      const error = await errorOf(create(ctx, Array.from({ length: count }, (_, i) => markedJpeg(i)), over))
      expect(error).toBeInstanceOf(RateLimitedError)
      expect(error.code).toBe('SCAN_DAILY_LIMIT')
      return error
    }
    const photosOf = (count: number) => Array.from({ length: count }, (_, i) => markedJpeg(i))
    /** Three scans of 10 from three different IPs: 30 photos for the user, at most 30 for any IP. */
    const thirty = async (ctx: Ctx, userId = USER) => {
      for (const ip of ['192.0.2.1', '192.0.2.2', '192.0.2.3']) await create(ctx, photosOf(10), { ip, userId })
    }

    it('lets a user take 30 photos in a day and refuses the 31st, storing and enqueuing nothing for the refused scan', async () => {
      const ctx = setup()
      await thirty(ctx)
      const stored = ctx.photos.stored.size
      const enqueued = ctx.jobs.enqueued.length

      await limited(ctx, 1)

      expect(ctx.photos.stored.size).toBe(stored)
      expect(ctx.jobs.enqueued).toHaveLength(enqueued)
    })

    it('counts the photos a scan would add: 29 photos taken, then 2 more is too many but 1 more is fine', async () => {
      const ctx = setup()
      await create(ctx, photosOf(10), { ip: '192.0.2.1' })
      await create(ctx, photosOf(10), { ip: '192.0.2.2' })
      await create(ctx, photosOf(9), { ip: '192.0.2.3' })

      await limited(ctx, 2)

      await expect(create(ctx, photosOf(1))).resolves.toMatchObject({ items: expect.any(Array) })
    })

    it('keeps each user\'s count apart', async () => {
      const ctx = setup()
      await thirty(ctx)

      await expect(create(ctx, photosOf(1), { userId: OTHER_USER, ip: '192.0.2.9' })).resolves.toMatchObject({ items: expect.any(Array) })
    })

    it.each([
      ['exactly 24 hours ago', DAY, true],
      ['24 hours and a millisecond ago', DAY + 1, false],
    ])('still counts photos taken %s only while they are within the last 24 hours', async (_label, elapsed, stillLimited) => {
      const ctx = setup()
      await thirty(ctx)
      ctx.advance(elapsed)

      const attempt = create(ctx, photosOf(1))

      if (stillLimited) await expect(attempt).rejects.toMatchObject({ code: 'SCAN_DAILY_LIMIT' })
      else await expect(attempt).resolves.toMatchObject({ items: expect.any(Array) })
    })

    it('tells the user how long to wait: until the oldest counted photo leaves the 24 hour window', async () => {
      const ctx = setup()
      await create(ctx, photosOf(10), { ip: '192.0.2.1' })
      ctx.advance(2 * HOUR)
      await create(ctx, photosOf(10), { ip: '192.0.2.2' })
      await create(ctx, photosOf(10), { ip: '192.0.2.3' })

      const error = await limited(ctx, 1)

      // The oldest photo was taken 2 hours ago, so it leaves the window in 22 hours (a second's slack for how the edge is counted).
      expect(error.details!.retryAfterSeconds).toBeGreaterThanOrEqual(22 * 3600)
      expect(error.details!.retryAfterSeconds).toBeLessThanOrEqual(22 * 3600 + 1)
    })

    describe('per IP address', () => {
      /** 99 photos from one address, by four users. */
      const ninetyNine = async (ctx: Ctx) => {
        await create(ctx, photosOf(10), { ip: IP, userId: 'ip-user-1' })
        await create(ctx, photosOf(10), { ip: IP, userId: 'ip-user-1' })
        await create(ctx, photosOf(10), { ip: IP, userId: 'ip-user-1' })
        for (const id of ['ip-user-2', 'ip-user-3']) {
          for (let i = 0; i < 3; i++) await create(ctx, photosOf(10), { ip: IP, userId: id })
        }
        await create(ctx, photosOf(9), { ip: IP, userId: 'ip-user-4' })
      }

      it('lets an address take 100 photos in a day, whoever takes them, and refuses the 101st', async () => {
        const ctx = setup()
        await ninetyNine(ctx)

        await expect(create(ctx, photosOf(1), { ip: IP, userId: 'ip-user-5' })).resolves.toMatchObject({ items: expect.any(Array) })

        await limited(ctx, 1, { ip: IP, userId: 'ip-user-6' })
      })

      it('counts the photos a scan would add against the address', async () => {
        const ctx = setup()
        await ninetyNine(ctx)

        await limited(ctx, 2, { ip: IP, userId: 'ip-user-5' })
      })

      it('does not count another address', async () => {
        const ctx = setup()
        await ninetyNine(ctx)

        await expect(create(ctx, photosOf(5), { ip: OTHER_IP, userId: 'ip-user-5' })).resolves.toMatchObject({ items: expect.any(Array) })
      })
    })
  })

  describe('the IP address', () => {
    it('is never stored as given: it appears nowhere in what is kept about the scan', async () => {
      const ctx = setup()

      const scan = await create(ctx, [markedJpeg(1)], { ip: IP })

      const stored = await ctx.repository.findScan(scan.id)
      expect(stored!.ipHash).toEqual(expect.any(String))
      expect(stored!.ipHash).not.toBe('')
      expect(JSON.stringify(stored)).not.toContain(IP)
      expect(JSON.stringify(await ctx.repository.itemsOf(scan.id))).not.toContain(IP)
      expect(JSON.stringify(scan)).not.toContain(IP)
    })

    it('hashes the same address to the same value and different addresses to different ones', async () => {
      const ctx = setup()

      const [a, b, c] = [await create(ctx, [markedJpeg(1)], { ip: IP }), await create(ctx, [markedJpeg(2)], { ip: IP }), await create(ctx, [markedJpeg(3)], { ip: OTHER_IP })]

      const hashes = [a, b, c].map(async (s) => (await ctx.repository.findScan(s.id))!.ipHash)
      const [ha, hb, hc] = await Promise.all(hashes)
      expect(ha).toBe(hb)
      expect(hc).not.toBe(ha)
    })

    it('depends on the secret, so a leaked table cannot be reversed by hashing every address', async () => {
      const first = setup()
      const second = setup({ ipHashSecret: 'a-different-secret' })

      const a = await create(first, [markedJpeg(1)], { ip: IP })
      const b = await create(second, [markedJpeg(1)], { ip: IP })

      expect((await first.repository.findScan(a.id))!.ipHash).not.toBe((await second.repository.findScan(b.id))!.ipHash)
    })
  })

  it('deletes the photos it already put when the scan cannot be saved, rethrows, and enqueues nothing', async () => {
    class SaveFails extends FakeScansRepository {
      override async createScan(): Promise<void> {
        throw new Error('database is down')
      }
    }
    const ctx = setup({ repository: new SaveFails() })

    await expect(create(ctx, [markedJpeg(1), webpPhoto()])).rejects.toThrow('database is down')

    expect(ctx.photos.stored.size).toBe(0)
    expect(ctx.jobs.enqueued).toEqual([])
  })

  it('puts the photos before it saves the scan, so a saved item never points at a missing photo', async () => {
    const present: boolean[] = []
    class Probe extends FakeScansRepository {
      constructor(private readonly store: MemoryPhotoStore) {
        super()
      }
      override async createScan(...[scan, photos, items]: Parameters<FakeScansRepository['createScan']>): Promise<void> {
        for (const item of items) present.push(item.photoKey !== null && (await this.store.get(item.photoKey)) !== null)
        return super.createScan(scan, photos, items)
      }
    }
    const photos = new MemoryPhotoStore({ environment: 'test' })
    const ctx = setup({ photos, repository: new Probe(photos) })

    await create(ctx, [markedJpeg(1), markedJpeg(2)])

    expect(present).toEqual([true, true])
  })
})

describe('ScanService.advance: recognise', () => {
  it('moves a clearly read beauty product on to matching and enqueues the match, keeping the photo', async () => {
    const ctx = setup()
    const { scanId, itemId } = await scanOne(ctx)

    await run(ctx, itemId, 'recognise')

    const item = await itemOf(ctx, scanId, itemId)
    expect(item).toMatchObject({ state: 'matching', reason: null, recognised: { brand: 'CeraVe', name: 'Hydrating Facial Cleanser', category: 'skin' } })
    expect(item.image.kind).toBe('user')
    expect(ctx.photos.stored.has(photoKey(scanId, itemId))).toBe(true)
    expect(queued(ctx).at(-1)).toEqual(advanceMessage(itemId, 'match'))
  })

  it('gives the recognizer the stored photo', async () => {
    const ctx = setup()
    const photo = markedJpeg(42)
    const { itemId } = await scanOne(ctx, photo)

    await run(ctx, itemId, 'recognise')

    expect(ctx.recognizer.calls).toEqual([photo])
  })

  it('records the variant when the label has one, and none when it does not', async () => {
    const ctx = setup()
    ctx.recognizer.respondWith((image) => (image.bytes.at(-1) === 1 ? seen({ variant: 'Night' }) : seen()))
    const scan = await create(ctx, [markedJpeg(1), markedJpeg(2)])
    const [a, b] = scan.items

    await run(ctx, a.id, 'recognise')
    await run(ctx, b.id, 'recognise')

    expect((await itemOf(ctx, scan.id, a.id)).recognised).toMatchObject({ variant: 'Night' })
    expect((await itemOf(ctx, scan.id, b.id)).recognised.variant ?? null).toBeNull()
  })

  it.each([
    ['0.6 is sure enough: it goes on to matching', 0.6, 'matching'],
    ['0.5999 is not: it waits for the user to confirm', 0.5999, 'needs-confirmation'],
    ['0.2 waits for the user to confirm', 0.2, 'needs-confirmation'],
    ['1 goes on to matching', 1, 'matching'],
  ])('confidence %s', async (_label, confidence, state) => {
    const ctx = setup()
    ctx.recognizer.respondWith(() => seen({ confidence }))
    const { scanId, itemId } = await scanOne(ctx)

    await run(ctx, itemId, 'recognise')

    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state, reason: null })
    expect(queued(ctx).filter((m) => m.step === 'match')).toHaveLength(state === 'matching' ? 1 : 0)
  })

  it('shows what it read while it waits for confirmation, and keeps the photo', async () => {
    const ctx = setup()
    ctx.recognizer.respondWith(() => seen({ confidence: 0.3, brand: 'Glo Co', name: 'Brite Serum' }))
    const { scanId, itemId } = await scanOne(ctx)

    await run(ctx, itemId, 'recognise')

    const item = await itemOf(ctx, scanId, itemId)
    expect(item.recognised).toMatchObject({ brand: 'Glo Co', name: 'Brite Serum' })
    expect(item.image.kind).toBe('user')
    expect(ctx.photos.stored.has(photoKey(scanId, itemId))).toBe(true)
  })

  it.each([
    ['a face or person', { classification: 'face-or-person' }, 'face-or-person'],
    ['a product that is not beauty or personal care', { classification: 'other-product' }, 'not-a-beauty-product'],
  ] as const)('rejects %s as %s and deletes the photo at once', async (_label, recognition, reason) => {
    const ctx = setup()
    ctx.recognizer.respondWith(() => recognition)
    const { scanId, itemId } = await scanOne(ctx)

    await run(ctx, itemId, 'recognise')

    const item = await itemOf(ctx, scanId, itemId)
    expect(item).toMatchObject({ state: 'rejected', reason, image: null })
    expect(ctx.photos.stored.size).toBe(0)
    expect((await ctx.repository.findItem(itemId))!.photoKey).toBeNull()
    expect(queued(ctx)).toEqual([advanceMessage(itemId, 'recognise')])
  })

  it('fails an item whose photo is missing as photo-missing, without asking the recognizer', async () => {
    const ctx = setup()
    const { scanId, itemId } = await scanOne(ctx)
    ctx.photos.stored.delete(photoKey(scanId, itemId))

    await run(ctx, itemId, 'recognise')

    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'failed', reason: 'photo-missing' })
    expect(ctx.recognizer.calls).toEqual([])
  })

  it('leaves the item recognising, and throws so the queue retries, when the recognizer fails', async () => {
    const ctx = setup()
    const { scanId, itemId } = await scanOne(ctx)
    const original = new Error('vision is down')
    ctx.recognizer.failNextWith(original)

    await expect(run(ctx, itemId, 'recognise')).rejects.toBe(original)

    expect((await stateOf(ctx, scanId, itemId)).state).toBe('recognising')
    expect(ctx.events.published).toEqual([])
  })

  it.each([
    ['matching', (ctx: Ctx) => reach(ctx, 'matching')],
    ['needs-confirmation', (ctx: Ctx) => reach(ctx, 'needs-confirmation')],
    ['needs-retake', (ctx: Ctx) => failedFront(ctx, [BLURRY])],
    ['needs-identification', (ctx: Ctx) => failedFront(ctx, [BLURRY, BLURRY, BLURRY])],
  ])('does nothing for an item that is already %s: no recognizer call, no new job, no event', async (state, arrange) => {
    const ctx = setup()
    const { scanId, itemId } = await arrange(ctx)
    const calls = ctx.recognizer.calls.length
    const jobs = ctx.jobs.enqueued.length
    const events = ctx.events.published.length

    await run(ctx, itemId, 'recognise')

    expect((await stateOf(ctx, scanId, itemId)).state).toBe(state)
    expect(ctx.recognizer.calls).toHaveLength(calls)
    expect(ctx.jobs.enqueued).toHaveLength(jobs)
    expect((ctx.events as MemoryScanEvents).published).toHaveLength(events)
  })

  it('does nothing for an item that no longer exists, such as one cleaned up with its guest', async () => {
    const ctx = setup()

    await expect(run(ctx, 'no-such-item', 'recognise')).resolves.toBeUndefined()

    expect(ctx.recognizer.calls).toEqual([])
  })
})

describe('ScanService.advance: recognise, a front photo that cannot be read', () => {
  const states = itemOf

  it.each([
    ['a photo that is blurry, dark or empty', 'unreadable', BLURRY],
    ['a beauty product whose label is turned away or covered', 'label-not-visible', TURNED_AWAY],
  ] as const)('asks for a retake of %s, with the reason %s, and deletes the photo at once', async (_label, reason, recognition) => {
    const ctx = setup()
    ctx.recognizer.respondWith(() => recognition)
    const { scanId, itemId } = await scanOne(ctx)

    await run(ctx, itemId, 'recognise')

    const item = await states(ctx, scanId, itemId)
    expect(item).toMatchObject({ state: 'needs-retake', reason, retakesLeft: 2, image: null })
    expect(ctx.photos.stored.size).toBe(0)
    expect((await ctx.repository.findItem(itemId))!.photoKey).toBeNull()
    expect(queued(ctx)).toEqual([advanceMessage(itemId, 'recognise')])
  })

  it('counts the retaken photos too: the second unreadable photo asks again, and the third sends the item to identification', async () => {
    const ctx = setup()
    const { scanId, itemId } = await failedFront(ctx, [BLURRY, TURNED_AWAY])

    expect(await states(ctx, scanId, itemId)).toMatchObject({ state: 'needs-retake', reason: 'label-not-visible', retakesLeft: 1, image: null })
    expect(ctx.photos.stored.size).toBe(0)

    ctx.advance(SECOND)
    await retake(ctx, scanId, itemId, markedJpeg(30))
    ctx.recognizer.respondWith(() => BLURRY)
    await run(ctx, itemId, 'recognise')

    expect(await states(ctx, scanId, itemId)).toMatchObject({ state: 'needs-identification', reason: 'unreadable', image: null })
    expect(ctx.photos.stored.size).toBe(0)
    expect((await ctx.repository.findItem(itemId))!.photoKey).toBeNull()
  })

  it.each([
    ['unreadable, then label-not-visible, then unreadable', 'unreadable', [BLURRY, TURNED_AWAY, BLURRY]],
    ['label-not-visible, then unreadable, then label-not-visible', 'label-not-visible', [TURNED_AWAY, BLURRY, TURNED_AWAY]],
    ['label-not-visible three times', 'label-not-visible', [TURNED_AWAY, TURNED_AWAY, TURNED_AWAY]],
  ] as const)('sends the item to identification on the third unreadable photo (%s), keeping the third photo\'s reason %s', async (_label, reason, reads) => {
    const ctx = setup()

    const { scanId, itemId } = await failedFront(ctx, [...reads])

    const item = await states(ctx, scanId, itemId)
    expect(item).toMatchObject({ state: 'needs-identification', reason, image: null })
    expect(ctx.photos.stored.size).toBe(0)
    // Nothing is queued for it: it waits for the user. Only the scan's own recognise, and one per retake, were ever sent.
    expect(queued(ctx).map((m) => m.step)).toEqual(['recognise', 'recognise', 'recognise'])
  })

  it('does not tell the app about retakes once there are none left: retakesLeft is left out of a needs-identification item', async () => {
    const ctx = setup()
    const { scanId, itemId } = await failedFront(ctx, [BLURRY, BLURRY, BLURRY])

    const item = await states(ctx, scanId, itemId)

    expect(item.state).toBe('needs-identification')
    expect(item).not.toHaveProperty('retakesLeft')
  })

  it('counts the tries per item: another item of the same scan with two unreadable photos does not use up this one\'s retakes', async () => {
    const ctx = setup()
    ctx.recognizer.respondWith(() => BLURRY)
    const scan = await create(ctx, [markedJpeg(1), markedJpeg(2)])
    const [a, b] = scan.items
    await run(ctx, a.id, 'recognise')
    ctx.advance(SECOND)
    await retake(ctx, scan.id, a.id, markedJpeg(21))
    await run(ctx, a.id, 'recognise')

    await run(ctx, b.id, 'recognise')

    expect(await states(ctx, scan.id, a.id)).toMatchObject({ state: 'needs-retake', retakesLeft: 1 })
    expect(await states(ctx, scan.id, b.id)).toMatchObject({ state: 'needs-retake', retakesLeft: 2 })
  })

  it.each([
    ['a face or person', 'face-or-person', { classification: 'face-or-person' }],
    ['a product that is not beauty or personal care', 'not-a-beauty-product', { classification: 'other-product' }],
  ] as const)('still rejects %s at once on a retaken photo, as %s, deleting it, however many tries the item has had', async (_label, reason, recognition) => {
    const ctx = setup()
    const { scanId, itemId } = await failedFront(ctx, [BLURRY, TURNED_AWAY])
    ctx.advance(SECOND)
    await retake(ctx, scanId, itemId, markedJpeg(40))
    ctx.recognizer.respondWith(() => recognition)

    await run(ctx, itemId, 'recognise')

    expect(await states(ctx, scanId, itemId)).toMatchObject({ state: 'rejected', reason, image: null })
    expect(ctx.photos.stored.size).toBe(0)
  })

  it('recognises a retaken photo that reads: the recognizer is asked about the new photo, and the item goes on to matching', async () => {
    const ctx = setup()
    const { scanId, itemId } = await failedFront(ctx, [BLURRY])
    const better = markedJpeg(50)
    ctx.advance(SECOND)
    await retake(ctx, scanId, itemId, better)
    ctx.recognizer.respondWith(() => seen())

    await run(ctx, itemId, 'recognise')

    expect(ctx.recognizer.calls.at(-1)).toEqual(better)
    expect(ctx.recognizer.calls).toHaveLength(2)
    expect(await states(ctx, scanId, itemId)).toMatchObject({ state: 'matching', reason: null, recognised: { brand: 'CeraVe', name: 'Hydrating Facial Cleanser' } })
    expect(queued(ctx).at(-1)).toEqual(advanceMessage(itemId, 'match'))
    expect(ctx.photos.stored.has(photoKey(scanId, itemId))).toBe(true)
  })

  it('shows retakesLeft on no item that is not asking for a retake', async () => {
    const ctx = setup()
    const recognising = await scanOne(ctx)
    const confirming = await reach(ctx, 'needs-confirmation')
    const matching = await reach(ctx, 'matching')

    for (const { scanId, itemId } of [recognising, confirming, matching]) expect(await states(ctx, scanId, itemId)).not.toHaveProperty('retakesLeft')
  })
})

describe('ScanService product form', () => {
  const sprayKey = identityKey({ ...CERAVE, form: 'spray' })

  it('stores the recognised form on the item and shows it, and shows null when the photo gave none', async () => {
    const ctx = setup()
    ctx.recognizer.respondWith((image) => (image.bytes.at(-1) === 1 ? seen({ form: 'spray' }) : seen()))
    const scan = await create(ctx, [markedJpeg(1), markedJpeg(2)])
    const [a, b] = scan.items

    await run(ctx, a.id, 'recognise')
    await run(ctx, b.id, 'recognise')

    expect((await itemOf(ctx, scan.id, a.id)).recognised).toMatchObject({ form: 'spray' })
    expect((await itemOf(ctx, scan.id, b.id)).recognised).toMatchObject({ form: null })
  })

  it('hands the recognised form to the catalog when it matches the item', async () => {
    const ctx = setup()
    ctx.recognizer.respondWith(() => seen({ form: 'spray' }))
    const { itemId } = await scanOne(ctx)
    await run(ctx, itemId, 'recognise')
    const resolve = vi.spyOn(ctx.catalog, 'resolve')

    await run(ctx, itemId, 'match')

    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ brand: CERAVE.brand, name: CERAVE.name, form: 'spray' }))
    expect(await ctx.catalogRepository.findProductByKey(sprayKey)).not.toBeNull()
    expect(await ctx.catalogRepository.findProductByKey(identityKey(CERAVE))).toBeNull()
  })

  it('hands the catalog no form when none was recognised', async () => {
    const ctx = setup()
    const { itemId } = await scanOne(ctx)
    await run(ctx, itemId, 'recognise')
    const resolve = vi.spyOn(ctx.catalog, 'resolve')

    await run(ctx, itemId, 'match')

    expect(resolve.mock.calls[0]![0]).not.toHaveProperty('form')
  })

  it('keeps the form of an earlier read when the recognise step runs again, without asking the recogniser', async () => {
    const ctx = setup()
    const { scanId, itemId } = await scanOne(ctx)
    await ctx.repository.updateItem(itemId, 'recognising', {
      recognisedBrand: CERAVE.brand,
      recognisedName: CERAVE.name,
      recognisedVariant: null,
      recognisedForm: 'spray',
      recognisedCategory: 'skin',
      recognisedConfidence: 0.9,
      updatedAt: ctx.now(),
    })

    await run(ctx, itemId, 'recognise')

    expect(ctx.recognizer.calls).toEqual([])
    expect(await itemOf(ctx, scanId, itemId)).toMatchObject({ state: 'matching', recognised: { form: 'spray' } })
  })

  it('confirm stores the form the user gave, and the corrected product is looked up with it', async () => {
    const ctx = setup()
    const { scanId, itemId } = await reach(ctx, 'needs-confirmation')

    await asUser(() => ctx.service.confirm(scanId, itemId, { ...CERAVE, form: 'roll-on' }))
    await drain(ctx)

    expect((await itemOf(ctx, scanId, itemId)).recognised).toMatchObject({ form: 'roll-on' })
    expect(await ctx.catalogRepository.findProductByKey(identityKey({ ...CERAVE, form: 'roll-on' }))).not.toBeNull()
  })

  it('confirm without a form clears the form that was read to null', async () => {
    const ctx = setup()
    ctx.recognizer.respondWith(() => seen({ confidence: 0.3, form: 'spray' }))
    const { scanId, itemId } = await scanOne(ctx)
    await run(ctx, itemId, 'recognise')
    expect((await itemOf(ctx, scanId, itemId)).recognised).toMatchObject({ form: 'spray' })

    await asUser(() => ctx.service.confirm(scanId, itemId, { ...CERAVE }))
    await drain(ctx)

    expect((await itemOf(ctx, scanId, itemId)).recognised).toMatchObject({ form: null })
    expect(await ctx.catalogRepository.findProductByKey(identityKey(CERAVE))).not.toBeNull()
    expect(await ctx.catalogRepository.findProductByKey(sprayKey)).toBeNull()
  })
})

describe('ScanService.advance: match', () => {
  it('makes an item ready, with the product the catalog already holds, when that product is analysed', async () => {
    const ctx = setup()
    const { productId, formulationId } = await catalogued(ctx)
    const { scanId, itemId } = await reach(ctx, 'matching')

    await run(ctx, itemId, 'match')

    const item = await itemOf(ctx, scanId, itemId)
    expect(item).toMatchObject({ state: 'ready', reason: null })
    expect(item.product).toEqual(await ctx.catalog.productSummary(formulationId))
    expect(await ctx.repository.findItem(itemId)).toMatchObject({ productId, formulationId })
    expect(ctx.researcher.calls).toHaveLength(1)
    expect(ctx.analyst.calls.analyse).toHaveLength(1)
  })

  it('moves on to analysing, and enqueues the analysis, when the formulation was never analysed', async () => {
    const ctx = setup()
    await catalogued(ctx, CERAVE, { analysed: false })
    const { scanId, itemId } = await reach(ctx, 'matching')

    await run(ctx, itemId, 'match')

    expect((await stateOf(ctx, scanId, itemId)).state).toBe('analysing')
    expect(queued(ctx).at(-1)).toEqual(advanceMessage(itemId, 'analyse'))
  })

  it('moves on to researching, and enqueues the research, for a product the catalog has not got ingredients for', async () => {
    const ctx = setup()
    const { scanId, itemId } = await reach(ctx, 'matching')

    await run(ctx, itemId, 'match')

    expect((await stateOf(ctx, scanId, itemId)).state).toBe('researching')
    expect(queued(ctx).at(-1)).toEqual(advanceMessage(itemId, 'research'))
  })

  it('fails the item as analysis-failed when the catalog has given up analysing the product', async () => {
    const ctx = setup()
    const { formulationId } = await catalogued(ctx, CERAVE, { ingredients: WITH_MERCURY, analysed: false })
    // The analyst answers with nothing, which the catalog rejects (mercury must be explained): three rejections and it gives up.
    for (let i = 0; i < 3; i++) await ctx.catalog.analyse(formulationId).catch(() => undefined)
    const { scanId, itemId } = await reach(ctx, 'matching')

    await run(ctx, itemId, 'match')

    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'failed', reason: 'analysis-failed' })
  })

  it('fails the item as research-busy, without throwing, when the catalog is busy', async () => {
    const ctx = setup()
    await catalogued(ctx, { brand: 'Acme', name: 'Radiance Serum Vitamin Glow', category: 'skin' })
    // A near miss the catalog must ask the model about, while the AI spend cap is spent.
    ctx.recognizer.respondWith(() => seen({ brand: 'Acme', name: 'Radiance Serum Vitamin Glow Booster' }))
    const { scanId, itemId } = await scanOne(ctx)
    await run(ctx, itemId, 'recognise')
    ctx.analyst.failNextWith(new AiBudgetExceededError('cap'))

    await run(ctx, itemId, 'match')

    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'failed', reason: 'research-busy' })
  })

  it('keeps the photo of an item that failed as research-busy, so the user can try again', async () => {
    const ctx = setup()
    await catalogued(ctx, { brand: 'Acme', name: 'Radiance Serum Vitamin Glow', category: 'skin' })
    ctx.recognizer.respondWith(() => seen({ brand: 'Acme', name: 'Radiance Serum Vitamin Glow Booster' }))
    const { scanId, itemId } = await scanOne(ctx)
    await run(ctx, itemId, 'recognise')
    ctx.analyst.failNextWith(new AiBudgetExceededError('cap'))

    await run(ctx, itemId, 'match')

    expect(ctx.photos.stored.has(photoKey(scanId, itemId))).toBe(true)
    expect((await itemOf(ctx, scanId, itemId)).image.kind).toBe('user')
  })

  it('does nothing for an item that is not matching: the catalog is not asked', async () => {
    const ctx = setup()
    const { scanId, itemId } = await scanOne(ctx)
    const resolve = vi.spyOn(ctx.catalog, 'resolve')

    await run(ctx, itemId, 'match')

    expect((await stateOf(ctx, scanId, itemId)).state).toBe('recognising')
    expect(resolve).not.toHaveBeenCalled()
  })

  it('does nothing the second time: an item already researching is not moved or enqueued again', async () => {
    const ctx = setup()
    const { scanId, itemId } = await reach(ctx, 'researching')
    const jobs = ctx.jobs.enqueued.length

    await run(ctx, itemId, 'match')

    expect((await stateOf(ctx, scanId, itemId)).state).toBe('researching')
    expect(ctx.jobs.enqueued).toHaveLength(jobs)
  })
})

describe('ScanService.advance: research', () => {
  const STALE = FRESH_FOR_DAYS * DAY + 1

  it('moves on to analysing, and enqueues the analysis, when the ingredients are found', async () => {
    const ctx = setup()
    const { scanId, itemId } = await reach(ctx, 'researching')
    ctx.researcher.respondWith(() => ({ found: true, ingredients: CLEAN, sourceUrl: SOURCE_URL }))

    await run(ctx, itemId, 'research')

    expect((await stateOf(ctx, scanId, itemId)).state).toBe('analysing')
    expect(queued(ctx).at(-1)).toEqual(advanceMessage(itemId, 'analyse'))
  })

  it('asks for a photo of the back when the ingredients cannot be found and there is no earlier answer to show', async () => {
    const ctx = setup()
    const { scanId, itemId } = await reach(ctx, 'researching')

    await run(ctx, itemId, 'research')

    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'needs-back-photo', reason: null })
    expect(queued(ctx).filter((m) => m.step === 'analyse')).toEqual([])
  })

  it('shows the earlier analysed formulation as ready when fresh research finds nothing', async () => {
    const ctx = setup()
    const old = await catalogued(ctx)
    ctx.advance(STALE)
    const { scanId, itemId } = await reach(ctx, 'matching')
    await run(ctx, itemId, 'match')
    expect((await stateOf(ctx, scanId, itemId)).state).toBe('researching')
    ctx.researcher.respondWith(() => ({ found: false }))

    await run(ctx, itemId, 'research')

    expect((await itemOf(ctx, scanId, itemId))).toMatchObject({ state: 'ready', product: { id: old.productId } })
    expect(await ctx.repository.findItem(itemId)).toMatchObject({ productId: old.productId, formulationId: old.formulationId })
  })

  it('shows the earlier analysed formulation as ready when the AI spend cap stops the new research', async () => {
    const ctx = setup()
    const old = await catalogued(ctx)
    ctx.advance(STALE)
    const { scanId, itemId } = await reach(ctx, 'matching')
    await run(ctx, itemId, 'match')
    ctx.researcher.failNextWith(new AiBudgetExceededError('cap'))

    await run(ctx, itemId, 'research')

    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'ready', reason: null })
    expect(await ctx.repository.findItem(itemId)).toMatchObject({ formulationId: old.formulationId })
  })

  it('fails the item as research-busy, without throwing, when the spend cap stops research and there is nothing earlier to show', async () => {
    const ctx = setup()
    const { scanId, itemId } = await reach(ctx, 'researching')
    ctx.researcher.failNextWith(new AiBudgetExceededError('cap'))

    await run(ctx, itemId, 'research')

    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'failed', reason: 'research-busy' })
  })

  it('does nothing for an item that is not researching: the researcher is not asked', async () => {
    const ctx = setup()
    const { scanId, itemId } = await reach(ctx, 'matching')

    await run(ctx, itemId, 'research')

    expect((await stateOf(ctx, scanId, itemId)).state).toBe('matching')
    expect(ctx.researcher.calls).toEqual([])
  })

  it('throws, leaving the item researching so the queue retries, when the researcher fails', async () => {
    const ctx = setup()
    const { scanId, itemId } = await reach(ctx, 'researching')
    const original = new Error('search is down')
    ctx.researcher.failNextWith(original)

    await expect(run(ctx, itemId, 'research')).rejects.toBe(original)

    expect((await stateOf(ctx, scanId, itemId)).state).toBe('researching')
  })
})

describe('ScanService.advance: read-label', () => {
  const labelled = (ctx: Ctx, ingredients: string[] = CLEAN) => ctx.labelReader.respondWith(() => ({ readable: true, ingredients }))

  it('stores the ingredients read from the back photo, moves on to analysing and enqueues the analysis', async () => {
    const ctx = setup()
    const { scanId, itemId } = await reach(ctx, 'reading-label')
    labelled(ctx, ['Aqua', 'Glycerin', 'Phenoxyethanol'])

    await run(ctx, itemId, 'read-label')

    expect((await stateOf(ctx, scanId, itemId)).state).toBe('analysing')
    expect(queued(ctx).at(-1)).toEqual(advanceMessage(itemId, 'analyse'))
    const resolved = await ctx.catalog.resolve(CERAVE)
    expect(resolved).toMatchObject({ kind: 'needs-analysis', formulationId: expect.any(String) })
    const view = await ctx.catalog.productView((resolved as { formulationId: string }).formulationId)
    expect(view.formulation).toMatchObject({ ingredients: ['Aqua', 'Glycerin', 'Phenoxyethanol'], source: { kind: 'label', url: null } })
  })

  it('gives the label reader the back photo that was uploaded', async () => {
    const ctx = setup()
    const { scanId, itemId } = await reach(ctx, 'reading-label')
    labelled(ctx)

    await run(ctx, itemId, 'read-label')

    expect(ctx.labelReader.calls).toEqual([markedJpeg(9)])
  })

  it('deletes the back photo once its label is read, and forgets its key, so a photo of ingredients is not kept for long', async () => {
    const ctx = setup()
    const { scanId, itemId } = await reach(ctx, 'reading-label')
    labelled(ctx)

    await run(ctx, itemId, 'read-label')

    expect(ctx.photos.stored.has(backKey(scanId, itemId))).toBe(false)
    expect((await ctx.repository.findItem(itemId))!.backPhotoKey).toBeNull()
    expect((await stateOf(ctx, scanId, itemId)).state).toBe('analysing')
  })

  it('logs the ids, and still moves the item on, when the read back photo cannot be deleted', async () => {
    class DeleteFails extends MemoryPhotoStore {
      override async delete(): Promise<void> {
        throw new Error('bucket is down')
      }
    }
    const ctx = setup({ photos: new DeleteFails({ environment: 'test' }) })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { scanId, itemId } = await reach(ctx, 'reading-label')
    labelled(ctx)

    await expect(run(ctx, itemId, 'read-label')).resolves.toBeUndefined()

    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'analysing', reason: null })
    expect((await ctx.repository.findItem(itemId))!.backPhotoKey).toBeNull()
    expect(logged).toHaveBeenCalledWith({ outcome: 'photo-cleanup-failed', scanId, itemId })
    logged.mockRestore()
  })

  it('keeps the back photo, and the item reading its label, when the analysis cannot be queued', async () => {
    const ctx = setup()
    const { scanId, itemId } = await reach(ctx, 'reading-label')
    labelled(ctx)
    const outage = new Error('queue is down')
    ctx.jobs.failNextWith(outage)

    await expect(run(ctx, itemId, 'read-label')).rejects.toBe(outage)

    expect((await stateOf(ctx, scanId, itemId)).state).toBe('reading-label')
    expect((await ctx.repository.findItem(itemId))!.backPhotoKey).toBe(backKey(scanId, itemId))
    expect(ctx.photos.stored.has(backKey(scanId, itemId))).toBe(true)
  })

  it.each([
    ['the reader cannot read the label', (ctx: Ctx) => ctx.labelReader.respondWith(() => ({ readable: false }))],
    ['the list it read is refused by the catalog (it carries a link)', (ctx: Ctx) => ctx.labelReader.respondWith(() => ({ readable: true, ingredients: ['Aqua', 'see https://evil.example'] }))],
    ['the list it read is empty', (ctx: Ctx) => ctx.labelReader.respondWith(() => ({ readable: true, ingredients: [] }))],
  ])('asks again for a photo of the back, as label-unreadable, and deletes that back photo, when %s', async (_label, arrange) => {
    const ctx = setup()
    const { scanId, itemId } = await reach(ctx, 'reading-label')
    arrange(ctx)

    await run(ctx, itemId, 'read-label')

    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'needs-back-photo', reason: 'label-unreadable' })
    expect(ctx.photos.stored.has(backKey(scanId, itemId))).toBe(false)
    expect((await ctx.repository.findItem(itemId))!.backPhotoKey).toBeNull()
    expect(queued(ctx).filter((m) => m.step === 'analyse')).toEqual([])
  })

  it('lets the user send another back photo after an unreadable one', async () => {
    const ctx = setup()
    const { scanId, itemId } = await reach(ctx, 'reading-label')
    ctx.labelReader.respondWith(() => ({ readable: false }))
    await run(ctx, itemId, 'read-label')

    await asUser(() => ctx.service.addBackPhoto(scanId, itemId, markedJpeg(10), IP))

    expect((await stateOf(ctx, scanId, itemId)).state).toBe('reading-label')
    expect(ctx.photos.stored.get(backKey(scanId, itemId))).toEqual(markedJpeg(10))
  })

  it('queues the second read under a key of its own, so the job runner does not drop it as a repeat of the first', async () => {
    const ctx = setup()
    const { scanId, itemId } = await reach(ctx, 'reading-label')
    ctx.labelReader.respondWith(() => ({ readable: false }))
    await run(ctx, itemId, 'read-label')
    ctx.advance(SECOND)

    await asUser(() => ctx.service.addBackPhoto(scanId, itemId, markedJpeg(10), IP))

    const reads = ctx.jobs.enqueued.filter((e) => (e.body as { step: string }).step === 'read-label')
    expect(reads).toHaveLength(2)
    const keys = reads.map((e) => advanceScanItemSpec.key(e.body as AdvanceScanItemMessage))
    expect(new Set(keys).size).toBe(2)
  })

  it('does nothing for an item that is not reading its label: the reader is not asked', async () => {
    const ctx = setup()
    const { scanId, itemId } = await reach(ctx, 'needs-back-photo')

    await run(ctx, itemId, 'read-label')

    expect((await stateOf(ctx, scanId, itemId)).state).toBe('needs-back-photo')
    expect(ctx.labelReader.calls).toEqual([])
  })

  it('throws, leaving the item reading its label so the queue retries, when the reader fails', async () => {
    const ctx = setup()
    const { scanId, itemId } = await reach(ctx, 'reading-label')
    const original = new Error('vision is down')
    ctx.labelReader.failNextWith(original)

    await expect(run(ctx, itemId, 'read-label')).rejects.toBe(original)

    expect((await stateOf(ctx, scanId, itemId)).state).toBe('reading-label')
    expect(ctx.photos.stored.has(backKey(scanId, itemId))).toBe(true)
  })
})

describe('ScanService.advance: the cap on back photos per item', () => {
  const unreadable = (ctx: Ctx) => ctx.labelReader.respondWith(() => ({ readable: false }))
  const refused = () => new AnthropicRefusalError('Claude refused to answer')
  const unusable = () => new AnthropicRequestError('Claude returned text that is not valid JSON')
  const addBack = (ctx: Ctx, scanId: string, itemId: string, marker: number) =>
    asUser(() => ctx.service.addBackPhoto(scanId, itemId, markedJpeg(marker), IP))
  /** Reads the back photo the item holds as unreadable, then (if the item asked again) uploads the next one. Returns once the item is reading again. */
  const failOneRead = async (ctx: Ctx, scanId: string, itemId: string, marker: number) => {
    unreadable(ctx)
    await run(ctx, itemId, 'read-label')
    await addBack(ctx, scanId, itemId, marker)
  }
  /** An item whose `n`th back photo (1-based) has just been uploaded, the first `n - 1` having been read as unreadable. */
  const readingBackPhoto = async (ctx: Ctx, n: number) => {
    const { scanId, itemId } = await reach(ctx, 'reading-label')
    for (let i = 1; i < n; i++) await failOneRead(ctx, scanId, itemId, 10 + i)
    return { scanId, itemId }
  }

  it.each([1, 2])('asks again for a back photo, as label-unreadable, when the unreadable one is the %ith', async (n) => {
    const ctx = setup()
    const { scanId, itemId } = await readingBackPhoto(ctx, n)
    unreadable(ctx)

    await run(ctx, itemId, 'read-label')

    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'needs-back-photo', reason: 'label-unreadable' })
    expect(ctx.photos.stored.has(backKey(scanId, itemId))).toBe(false)
  })

  it('ends the item as failed with label-unreadable when the 3rd back photo is unreadable, deleting the back photo and queueing nothing more', async () => {
    const ctx = setup()
    const { scanId, itemId } = await readingBackPhoto(ctx, 3)
    unreadable(ctx)
    const queuedBefore = ctx.jobs.enqueued.length

    await run(ctx, itemId, 'read-label')

    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'failed', reason: 'label-unreadable' })
    expect(ctx.photos.stored.has(backKey(scanId, itemId))).toBe(false)
    expect((await ctx.repository.findItem(itemId))!.backPhotoKey).toBeNull()
    expect(ctx.jobs.enqueued).toHaveLength(queuedBefore)
  })

  // The other final failures (fail(), e.g. research-busy, analysis-failed) keep the front photo: only a rejected photo is deleted. This mirrors them,
  // so the failed item still shows the user's own photo.
  it('keeps the front photo of an item it ends, as the other failures do', async () => {
    const ctx = setup()
    const { scanId, itemId } = await readingBackPhoto(ctx, 3)
    unreadable(ctx)

    await run(ctx, itemId, 'read-label')

    expect(ctx.photos.stored.has(photoKey(scanId, itemId))).toBe(true)
    expect((await ctx.repository.findItem(itemId))!.photoKey).toBe(photoKey(scanId, itemId))
    expect((await itemOf(ctx, scanId, itemId)).image).toMatchObject({ kind: 'user' })
  })

  it('still analyses the item when the 3rd back photo is readable: the cap applies only to a failure', async () => {
    const ctx = setup()
    const { scanId, itemId } = await readingBackPhoto(ctx, 3)
    ctx.labelReader.respondWith(() => ({ readable: true, ingredients: CLEAN }))

    await run(ctx, itemId, 'read-label')

    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'analysing', reason: null })
    expect(queued(ctx).at(-1)).toEqual(advanceMessage(itemId, 'analyse'))
  })

  it.each([
    ['the reader cannot read the label', (ctx: Ctx) => unreadable(ctx)],
    ['the list it read is refused by the catalog (it carries a link)', (ctx: Ctx) => ctx.labelReader.respondWith(() => ({ readable: true, ingredients: ['Aqua', 'see https://evil.example'] }))],
    ['the list it read is empty', (ctx: Ctx) => ctx.labelReader.respondWith(() => ({ readable: true, ingredients: [] }))],
    ['the model refuses', (ctx: Ctx) => ctx.labelReader.failNextWith(refused())],
    ['the model sends an unusable answer', (ctx: Ctx) => ctx.labelReader.failNextWith(unusable())],
    ['the back photo is gone from the store', (ctx: Ctx, scanId: string, itemId: string) => void ctx.photos.stored.delete(backKey(scanId, itemId))],
  ])('ends the item as failed with label-unreadable on the 3rd back photo when %s', async (_label, arrange) => {
    const ctx = setup()
    const { scanId, itemId } = await readingBackPhoto(ctx, 3)
    arrange(ctx, scanId, itemId)

    await expect(run(ctx, itemId, 'read-label')).resolves.toBeUndefined()

    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'failed', reason: 'label-unreadable' })
    expect((await ctx.repository.findItem(itemId))!.backPhotoKey).toBeNull()
    expect(queued(ctx).filter((m) => m.step === 'analyse')).toEqual([])
  })

  it.each([
    ['the back photo is gone from the store', (ctx: Ctx, scanId: string, itemId: string) => void ctx.photos.stored.delete(backKey(scanId, itemId))],
    ['the reader cannot read the label', (ctx: Ctx) => unreadable(ctx)],
  ])('asks again on the 2nd back photo when %s', async (_label, arrange) => {
    const ctx = setup()
    const { scanId, itemId } = await readingBackPhoto(ctx, 2)
    arrange(ctx, scanId, itemId)

    await run(ctx, itemId, 'read-label')

    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'needs-back-photo', reason: 'label-unreadable' })
  })

  it('counts back photos per item: another item of the same scan with two unreadable ones does not use up this one\'s allowance', async () => {
    const ctx = setup()
    let recognised = 0
    ctx.recognizer.respondWith(() => seen({ name: `Cleanser ${++recognised}` }))
    const scan = await create(ctx, [markedJpeg(1), markedJpeg(2)])
    const [a, b] = scan.items.map((i: { id: string }) => i.id) as [string, string]
    for (const id of [a, b]) {
      await run(ctx, id, 'recognise')
      await run(ctx, id, 'match')
      await run(ctx, id, 'research')
      await addBack(ctx, scan.id, id, 9)
    }
    await failOneRead(ctx, scan.id, a, 11)
    await failOneRead(ctx, scan.id, a, 12)

    unreadable(ctx)
    await run(ctx, b, 'read-label')

    expect(await stateOf(ctx, scan.id, b)).toEqual({ state: 'needs-back-photo', reason: 'label-unreadable' })
    await run(ctx, a, 'read-label')
    expect(await stateOf(ctx, scan.id, a)).toEqual({ state: 'failed', reason: 'label-unreadable' })
  })

  it('refuses a further back photo for an item it has ended, with ITEM_NOT_AWAITING_BACK_PHOTO', async () => {
    const ctx = setup()
    const { scanId, itemId } = await readingBackPhoto(ctx, 3)
    unreadable(ctx)
    await run(ctx, itemId, 'read-label')

    const error = await errorOf(addBack(ctx, scanId, itemId, 13))

    expect(error).toBeInstanceOf(ConflictError)
    expect(error.code).toBe('ITEM_NOT_AWAITING_BACK_PHOTO')
    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'failed', reason: 'label-unreadable' })
  })
})

describe('ScanService: what a ready item shows of its product', () => {
  it('shows only the product\'s identity, with no formulation, concerns or reference, in the scan and in the published item event', async () => {
    const ctx = setup()
    const { productId } = await catalogued(ctx)
    const { scanId, itemId } = await reach(ctx, 'matching')

    await run(ctx, itemId, 'match')

    const item = await itemOf(ctx, scanId, itemId)
    expect(Object.keys(item.product).sort()).toEqual(['brand', 'category', 'form', 'id', 'imageUrl', 'kind', 'name', 'variant'])
    expect(item.product).toMatchObject({ id: productId, brand: CERAVE.brand, name: CERAVE.name })
    expect(item.product).not.toHaveProperty('product')
    const published = ctx.events.published.map((p) => p.event).filter((event) => event.type === 'item' && event.item.id === itemId && event.item.state === 'ready')
    expect(published).toHaveLength(1)
    const sent = (published[0] as { item: typeof item }).item
    expect(Object.keys(sent.product).sort()).toEqual(['brand', 'category', 'form', 'id', 'imageUrl', 'kind', 'name', 'variant'])
  })
})

describe('ScanService.advance: analyse', () => {
  it('makes the item ready with the analysed product', async () => {
    const ctx = setup()
    const { scanId, itemId } = await analysingItem(ctx)
    await run(ctx, itemId, 'analyse')

    const item = await itemOf(ctx, scanId, itemId)
    expect(item.state).toBe('ready')
    const stored = await ctx.repository.findItem(itemId)
    expect(item.product).toEqual(await ctx.catalog.productSummary(stored!.formulationId!))
  })

  it('fails the item as research-busy, without throwing, when the catalog cannot analyse today', async () => {
    const ctx = setup()
    const { scanId, itemId } = await analysingItem(ctx)
    ctx.analyst.failNextWith(new AiBudgetExceededError('cap'))

    await expect(run(ctx, itemId, 'analyse')).resolves.toBeUndefined()

    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'failed', reason: 'research-busy' })
  })

  it('throws, leaving the item analysing so the queue retries, when the analysis is rejected but may yet pass', async () => {
    const ctx = setup()
    const { scanId, itemId } = await analysingItem(ctx, WITH_MERCURY)

    await expect(run(ctx, itemId, 'analyse')).rejects.toMatchObject({ code: 'ANALYSIS_REJECTED' })

    expect((await stateOf(ctx, scanId, itemId)).state).toBe('analysing')
  })

  it('fails the item as analysis-failed, and still throws, when the catalog gives up (the third rejection)', async () => {
    const ctx = setup()
    const { scanId, itemId } = await analysingItem(ctx, WITH_MERCURY)
    await run(ctx, itemId, 'analyse').catch(() => undefined)
    await run(ctx, itemId, 'analyse').catch(() => undefined)

    const error = await errorOf(run(ctx, itemId, 'analyse'))

    expect(error).toBeInstanceOf(PermanentJobError)
    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'failed', reason: 'analysis-failed' })
  })

  it('does nothing for an item that is not analysing: the analyst is not asked', async () => {
    const ctx = setup()
    const { scanId, itemId } = await reach(ctx, 'researching')

    await run(ctx, itemId, 'analyse')

    expect((await stateOf(ctx, scanId, itemId)).state).toBe('researching')
    expect(ctx.analyst.calls.analyse).toEqual([])
  })

  it('does nothing the second time: a ready item stays ready and the analyst is asked once', async () => {
    const ctx = setup()
    const { scanId, itemId } = await analysingItem(ctx)
    await run(ctx, itemId, 'analyse')
    const events = ctx.events.published.length

    await run(ctx, itemId, 'analyse')

    expect((await stateOf(ctx, scanId, itemId)).state).toBe('ready')
    expect(ctx.analyst.calls.analyse).toHaveLength(1)
    expect(ctx.events.published).toHaveLength(events)
  })
})

describe('ScanService.advance: events', () => {
  class StateAtPublish extends MemoryScanEvents {
    readonly stored: { published: string; stored: string | undefined }[] = []
    constructor(private readonly repository: FakeScansRepository) {
      super()
    }
    override async publish(scanId: string, event: Parameters<MemoryScanEvents['publish']>[1]): Promise<void> {
      if (event.type === 'item') this.stored.push({ published: event.item.state, stored: (await this.repository.findItem(event.item.id))?.state })
      return super.publish(scanId, event)
    }
  }

  it('publishes the item as it now is after every change, and only after the change has been written', async () => {
    let probe!: StateAtPublish
    const ctx = setup({ events: (repository) => (probe = new StateAtPublish(repository)) })
    const { scanId, itemId } = await scanOne(ctx)

    await run(ctx, itemId, 'recognise')
    await run(ctx, itemId, 'match')

    expect(probe.stored).toEqual([
      { published: 'matching', stored: 'matching' },
      { published: 'researching', stored: 'researching' },
    ])
    expect(ctx.events.published.map((p) => p.scanId)).toEqual([scanId, scanId])
    expect(ctx.events.published[1]!.event).toEqual({ type: 'item', item: await itemOf(ctx, scanId, itemId) })
  })

  it('publishes nothing for a step that does nothing', async () => {
    const ctx = setup()
    const { itemId } = await scanOne(ctx)

    await run(ctx, itemId, 'match')

    expect(ctx.events.published).toEqual([])
  })

  it('follows the last item reaching a final state with one done event, and not before', async () => {
    const ctx = setup()
    ctx.recognizer.respondWith((image) => (image.bytes.at(-1) === 1 ? { classification: 'face-or-person' } : seen()))
    await catalogued(ctx)
    const scan = await create(ctx, [markedJpeg(1), markedJpeg(2)])
    const [face, product] = scan.items

    await run(ctx, face.id, 'recognise')
    expect(ctx.events.eventsFor(scan.id).map((e) => e.type)).toEqual(['item'])

    await run(ctx, product.id, 'recognise')
    await run(ctx, product.id, 'match')

    const events = ctx.events.eventsFor(scan.id)
    expect(events.map((e) => e.type)).toEqual(['item', 'item', 'item', 'done'])
    expect(events.at(-1)).toEqual({ type: 'done' })
    expect(events[0]).toMatchObject({ item: { id: face.id, state: 'rejected', reason: 'face-or-person' } })
    expect(events[2]).toMatchObject({ item: { id: product.id, state: 'ready' } })
  })

  it('counts a rejected item as final for the done event', async () => {
    const ctx = setup()
    ctx.recognizer.respondWith(() => ({ classification: 'face-or-person' }))
    const scan = await create(ctx, [markedJpeg(1)])

    await run(ctx, scan.items[0].id, 'recognise')

    expect(ctx.events.eventsFor(scan.id).map((e) => e.type)).toEqual(['item', 'done'])
  })

  it('does not publish done while another item is still waiting, even if it is waiting for the user', async () => {
    const ctx = setup()
    ctx.recognizer.respondWith((image) => (image.bytes.at(-1) === 1 ? { classification: 'face-or-person' } : seen({ confidence: 0.2 })))
    const scan = await create(ctx, [markedJpeg(1), markedJpeg(2)])

    await run(ctx, scan.items[0].id, 'recognise')
    await run(ctx, scan.items[1].id, 'recognise')

    expect(ctx.events.eventsFor(scan.id).map((e) => e.type)).toEqual(['item', 'item'])
  })

  it('does not fail the step, and still moves the item and enqueues the next job, when publishing throws', async () => {
    class PublishFails extends MemoryScanEvents {
      override async publish(): Promise<void> {
        throw new Error('stream is down')
      }
    }
    const ctx = setup({ events: () => new PublishFails() })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const { scanId, itemId } = await scanOne(ctx)

    await expect(run(ctx, itemId, 'recognise')).resolves.toBeUndefined()

    expect((await stateOf(ctx, scanId, itemId)).state).toBe('matching')
    expect(queued(ctx).at(-1)).toEqual(advanceMessage(itemId, 'match'))
    expect(logged).toHaveBeenCalled()
    logged.mockRestore()
  })
})

describe('ScanService.advance: whole scans through the queue', () => {
  it('takes a product the catalog already holds from photo to ready with one vision call and no research or analysis', async () => {
    const ctx = setup()
    await catalogued(ctx)
    const researches = ctx.researcher.calls.length
    const analyses = ctx.analyst.calls.analyse.length
    const { scanId, itemId } = await scanOne(ctx)

    const steps = await drain(ctx)

    expect(steps).toEqual(['recognise', 'match'])
    expect((await stateOf(ctx, scanId, itemId)).state).toBe('ready')
    expect(ctx.recognizer.calls).toHaveLength(1)
    expect(ctx.researcher.calls).toHaveLength(researches)
    expect(ctx.analyst.calls.analyse).toHaveLength(analyses)
  })

  it('researches and analyses a new product, then makes it ready', async () => {
    const ctx = setup()
    ctx.researcher.respondWith(() => ({ found: true, ingredients: CLEAN, sourceUrl: SOURCE_URL }))
    const { scanId, itemId } = await scanOne(ctx)

    const steps = await drain(ctx)

    expect(steps).toEqual(['recognise', 'match', 'research', 'analyse'])
    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'ready', reason: null })
    expect(ctx.researcher.calls).toHaveLength(1)
  })

  it('shows the product\'s stock image once it is ready, in place of the user\'s photo', async () => {
    const ctx = setup()
    ctx.images.respondTo(IMAGE_URL, jpegPhoto())
    ctx.analyst.imageShowsProductWith(() => true)
    await catalogued(ctx, CERAVE, { imageUrl: IMAGE_URL })
    const { scanId, itemId } = await scanOne(ctx)

    await drain(ctx)

    const item = await itemOf(ctx, scanId, itemId)
    expect(item.image).toEqual({ kind: 'stock', url: item.product.imageUrl })
    expect(item.image.url).toMatch(/^https:\/\/images\.test\/catalog\/test\/products\//)
  })

  it('shows the user\'s own photo for a ready product that has no stock image', async () => {
    const ctx = setup()
    await catalogued(ctx)
    const { scanId, itemId } = await scanOne(ctx)

    await drain(ctx)

    const item = await itemOf(ctx, scanId, itemId)
    expect(item).toMatchObject({ state: 'ready', image: { kind: 'user' } })
  })

  it('waits for the user to confirm a doubtful read, then carries on with the corrected product', async () => {
    const ctx = setup()
    ctx.recognizer.respondWith(() => seen({ confidence: 0.3, brand: 'Ceravee', name: 'Hydrating Cleanser' }))
    await catalogued(ctx)
    const { scanId, itemId } = await scanOne(ctx)
    expect(await drain(ctx)).toEqual(['recognise'])
    expect((await stateOf(ctx, scanId, itemId)).state).toBe('needs-confirmation')

    await asUser(() => ctx.service.confirm(scanId, itemId, { brand: 'CeraVe', name: 'Hydrating Facial Cleanser', category: 'skin' }))
    const steps = await drain(ctx)

    expect(steps).toEqual(['match'])
    expect((await stateOf(ctx, scanId, itemId)).state).toBe('ready')
  })

  it('asks for the back of the pack when the ingredients cannot be found, reads it, and makes the product ready', async () => {
    const ctx = setup()
    const { scanId, itemId } = await scanOne(ctx)
    expect(await drain(ctx)).toEqual(['recognise', 'match', 'research'])
    expect((await stateOf(ctx, scanId, itemId)).state).toBe('needs-back-photo')
    ctx.labelReader.respondWith(() => ({ readable: true, ingredients: CLEAN }))

    await asUser(() => ctx.service.addBackPhoto(scanId, itemId, markedJpeg(9), IP))
    const steps = await drain(ctx)

    expect(steps).toEqual(['read-label', 'analyse'])
    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'ready', reason: null })
  })

  it('lets one bad photo fail without stopping the others in the scan', async () => {
    const ctx = setup()
    await catalogued(ctx)
    const scan = await create(ctx, [markedJpeg(1), markedJpeg(2), markedJpeg(3)])
    const [first, second, third] = scan.items
    ctx.photos.stored.delete(photoKey(scan.id, second.id))
    ctx.recognizer.respondWith((image) => (image.bytes.at(-1) === 3 ? { classification: 'face-or-person' } : seen()))

    await drain(ctx)

    expect(await stateOf(ctx, scan.id, first.id)).toEqual({ state: 'ready', reason: null })
    expect(await stateOf(ctx, scan.id, second.id)).toEqual({ state: 'failed', reason: 'photo-missing' })
    expect(await stateOf(ctx, scan.id, third.id)).toEqual({ state: 'rejected', reason: 'face-or-person' })
    expect(ctx.events.eventsFor(scan.id).filter((e) => e.type === 'done')).toHaveLength(1)
    expect(ctx.events.eventsFor(scan.id).at(-1)).toEqual({ type: 'done' })
  })
})

describe('ScanService.markItemFailed', () => {
  it.each([
    ['recognising', async (ctx: Ctx) => scanOne(ctx)],
    ['matching', (ctx: Ctx) => reach(ctx, 'matching')],
    ['researching', (ctx: Ctx) => reach(ctx, 'researching')],
    ['reading-label', (ctx: Ctx) => reach(ctx, 'reading-label')],
    ['analysing', (ctx: Ctx) => analysingItem(ctx)],
  ])('marks an item that is still %s as failed, unavailable, and publishes it', async (_state, arrange) => {
    const ctx = setup()
    const { scanId, itemId } = await arrange(ctx)
    const events = ctx.events.published.length

    await asJob(() => ctx.service.markItemFailed(itemId))

    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'failed', reason: 'unavailable' })
    const items = ctx.events.published.slice(events).filter((p) => p.event.type === 'item')
    expect(items.map((p) => p.event)).toEqual([{ type: 'item', item: await itemOf(ctx, scanId, itemId) }])
  })

  it.each([
    ['needs-confirmation', (ctx: Ctx) => reach(ctx, 'needs-confirmation')],
    ['needs-back-photo', (ctx: Ctx) => reach(ctx, 'needs-back-photo')],
    ['needs-retake', (ctx: Ctx) => failedFront(ctx, [BLURRY])],
    ['needs-identification', (ctx: Ctx) => failedFront(ctx, [BLURRY, TURNED_AWAY, BLURRY])],
  ])('leaves an item waiting for the user (%s) exactly as it was, and publishes nothing: no message of ours is owed', async (state, arrange) => {
    const ctx = setup()
    const { scanId, itemId } = await arrange(ctx)
    const before = await itemOf(ctx, scanId, itemId)
    const events = ctx.events.published.length

    await asJob(() => ctx.service.markItemFailed(itemId))

    expect(await itemOf(ctx, scanId, itemId)).toEqual(before)
    expect(before).toMatchObject({ state })
    expect(ctx.events.published).toHaveLength(events)
  })

  it('leaves an item that is already ready, rejected or failed exactly as it was, and publishes nothing', async () => {
    const ctx = setup()
    await catalogued(ctx)
    ctx.recognizer.respondWith((image) => (image.bytes.at(-1) === 2 ? { classification: 'face-or-person' } : seen()))
    const scan = await create(ctx, [markedJpeg(1), markedJpeg(2), markedJpeg(3)])
    const [ready, rejected, failed] = scan.items
    ctx.photos.stored.delete(photoKey(scan.id, failed.id))
    await drain(ctx)
    const before = await getScan(ctx, scan.id)
    const events = ctx.events.published.length

    for (const item of [ready, rejected, failed]) await asJob(() => ctx.service.markItemFailed(item.id))

    expect(await getScan(ctx, scan.id)).toEqual(before)
    expect(before.items.map((i: { state: string; reason: string | null }) => [i.state, i.reason])).toEqual([
      ['ready', null],
      ['rejected', 'face-or-person'],
      ['failed', 'photo-missing'],
    ])
    expect(ctx.events.published).toHaveLength(events)
  })

  it('does nothing for an item that no longer exists', async () => {
    const ctx = setup()

    await expect(asJob(() => ctx.service.markItemFailed('no-such-item'))).resolves.toBeUndefined()
  })
})

describe('ScanService.confirm', () => {
  const FIXED = { brand: 'CeraVe', name: 'Hydrating Facial Cleanser', category: 'skin' } as const
  const confirm = (ctx: Ctx, scanId: string, itemId: string, fields: Record<string, unknown> = FIXED, userId = USER) =>
    asUser(() => ctx.service.confirm(scanId, itemId, fields as never), userId)

  it('takes the user\'s corrected product, moves the item on to matching and enqueues the match', async () => {
    const ctx = setup()
    const { scanId, itemId } = await reach(ctx, 'needs-confirmation')

    await confirm(ctx, scanId, itemId, { brand: 'Glow Co', name: 'Bright Tone Serum', variant: 'Extra Strength', category: 'skin' })

    const item = await itemOf(ctx, scanId, itemId)
    expect(item).toMatchObject({ state: 'matching', reason: null, recognised: { brand: 'Glow Co', name: 'Bright Tone Serum', variant: 'Extra Strength', category: 'skin' } })
    expect(queued(ctx).at(-1)).toEqual(advanceMessage(itemId, 'match'))
  })

  it('looks the corrected product up, not the one that was read', async () => {
    const ctx = setup()
    const { scanId, itemId } = await reach(ctx, 'needs-confirmation')

    await confirm(ctx, scanId, itemId, { brand: 'Glow Co', name: 'Bright Tone Serum', category: 'skin' })
    await drain(ctx)

    const corrected: ProductIdentity = { brand: 'Glow Co', name: 'Bright Tone Serum', category: 'skin' }
    expect(await ctx.catalogRepository.findProductByKey(identityKey(corrected))).not.toBeNull()
    expect(await ctx.catalogRepository.findProductByKey(identityKey(CERAVE))).toBeNull()
  })

  it('trims every field, and lets variant be left out', async () => {
    const ctx = setup()
    const { scanId, itemId } = await reach(ctx, 'needs-confirmation')

    await confirm(ctx, scanId, itemId, { brand: '  Glow Co ', name: ' Bright Tone Serum  ', category: 'skin' })

    const { recognised } = await itemOf(ctx, scanId, itemId)
    expect(recognised).toMatchObject({ brand: 'Glow Co', name: 'Bright Tone Serum' })
    expect(recognised.variant ?? null).toBeNull()
  })

  it('accepts fields of exactly 120 characters', async () => {
    const ctx = setup()
    const { scanId, itemId } = await reach(ctx, 'needs-confirmation')
    const long = 'a'.repeat(120)

    await confirm(ctx, scanId, itemId, { brand: long, name: long, variant: long, category: 'skin' })

    expect((await itemOf(ctx, scanId, itemId)).recognised).toMatchObject({ brand: long, name: long, variant: long })
  })

  it.each([
    ['a brand of 121 characters', { brand: 'a'.repeat(121) }],
    ['a name of 121 characters', { name: 'a'.repeat(121) }],
    ['a variant of 121 characters', { variant: 'a'.repeat(121) }],
    ['a brand of 121 characters once trimmed', { brand: `  ${'a'.repeat(121)}  ` }],
    ['an empty brand', { brand: '   ' }],
    ['an empty name', { name: '' }],
    ['a link in the brand', { brand: 'Buy at https://evil.example' }],
    ['a www link in the name', { name: 'see www.evil.example' }],
    ['a link in the variant', { variant: 'http://evil.example' }],
    ['markup in the name', { name: '<script>evil()</script>' }],
    ['markup in the brand', { brand: 'Glow <b>Co' }],
    ['markup in the variant', { variant: '</i>' }],
  ])('refuses %s, leaving the item waiting for confirmation', async (_label, bad) => {
    const ctx = setup()
    const { scanId, itemId } = await reach(ctx, 'needs-confirmation')
    const jobs = ctx.jobs.enqueued.length

    const error = await errorOf(confirm(ctx, scanId, itemId, { ...FIXED, ...bad }))

    expect(error).toBeInstanceOf(ValidationError)
    expect((await stateOf(ctx, scanId, itemId)).state).toBe('needs-confirmation')
    expect(ctx.jobs.enqueued).toHaveLength(jobs)
  })

  it.each([
    ['recognising', (ctx: Ctx) => scanOne(ctx)],
    ['matching', (ctx: Ctx) => reach(ctx, 'matching')],
    ['researching', (ctx: Ctx) => reach(ctx, 'researching')],
  ])('refuses an item that is %s with ITEM_NOT_AWAITING_CONFIRMATION', async (state, arrange) => {
    const ctx = setup()
    const { scanId, itemId } = await arrange(ctx)

    const error = await errorOf(confirm(ctx, scanId, itemId))

    expect(error).toBeInstanceOf(ConflictError)
    expect(error.code).toBe('ITEM_NOT_AWAITING_CONFIRMATION')
    expect((await stateOf(ctx, scanId, itemId)).state).toBe(state)
  })

  it('refuses a second confirmation of the same item, and enqueues the match only once', async () => {
    const ctx = setup()
    const { scanId, itemId } = await reach(ctx, 'needs-confirmation')
    await confirm(ctx, scanId, itemId)

    const error = await errorOf(confirm(ctx, scanId, itemId))

    expect(error.code).toBe('ITEM_NOT_AWAITING_CONFIRMATION')
    expect(queued(ctx).filter((m) => m.step === 'match')).toHaveLength(1)
  })

  describe('ownership', () => {
    it.each([
      ['another user\'s scan', (s: string, i: string) => [s, i, OTHER_USER] as const],
      ['an unknown scan', (_s: string, i: string) => ['no-such-scan', i, USER] as const],
      ['an unknown item', (s: string) => [s, 'no-such-item', USER] as const],
    ])('answers SCAN_NOT_FOUND for %s, changing nothing', async (_label, aim) => {
      const ctx = setup()
      const { scanId, itemId } = await reach(ctx, 'needs-confirmation')
      const [s, i, u] = aim(scanId, itemId)

      const error = await errorOf(confirm(ctx, s, i, FIXED, u))

      expect(error).toBeInstanceOf(NotFoundError)
      expect(error.code).toBe('SCAN_NOT_FOUND')
      expect((await stateOf(ctx, scanId, itemId)).state).toBe('needs-confirmation')
    })

    it('answers SCAN_NOT_FOUND for an item that belongs to a different scan, even the caller\'s own', async () => {
      const ctx = setup()
      const mine = await reach(ctx, 'needs-confirmation')
      const other = await scanOne(ctx)

      const error = await errorOf(confirm(ctx, other.scanId, mine.itemId))

      expect(error.code).toBe('SCAN_NOT_FOUND')
    })

    it('answers AUTH_REQUIRED to a public caller', async () => {
      const ctx = setup()
      const { scanId, itemId } = await reach(ctx, 'needs-confirmation')

      const error = await errorOf(runAs({ kind: 'public' }, () => ctx.service.confirm(scanId, itemId, FIXED)))

      expect(error).toBeInstanceOf(UnauthorizedError)
      expect(error.code).toBe('AUTH_REQUIRED')
    })
  })
})

describe('ScanService.addBackPhoto', () => {
  const addBack = (ctx: Ctx, scanId: string, itemId: string, photo: ProductImage = markedJpeg(9), over: { ip?: string; userId?: string } = {}) =>
    asUser(() => ctx.service.addBackPhoto(scanId, itemId, photo, over.ip ?? IP), over.userId ?? USER)

  it('keeps the photo privately next to the front one, moves the item to reading-label and enqueues the read', async () => {
    const ctx = setup()
    const { scanId, itemId } = await reach(ctx, 'needs-back-photo')
    const photo = webpPhoto()

    await addBack(ctx, scanId, itemId, photo)

    expect((await stateOf(ctx, scanId, itemId)).state).toBe('reading-label')
    expect(ctx.photos.stored.get(backKey(scanId, itemId, 'webp'))).toEqual(photo)
    expect(queued(ctx).at(-1)).toEqual(advanceMessage(itemId, 'read-label'))
  })

  it.each([
    ['recognising', (ctx: Ctx) => scanOne(ctx)],
    ['researching', (ctx: Ctx) => reach(ctx, 'researching')],
    ['reading-label', (ctx: Ctx) => reach(ctx, 'reading-label')],
  ])('refuses an item that is %s with ITEM_NOT_AWAITING_BACK_PHOTO, storing nothing new', async (state, arrange) => {
    const ctx = setup()
    const { scanId, itemId } = await arrange(ctx)
    const stored = ctx.photos.stored.size
    const jobs = ctx.jobs.enqueued.length

    const error = await errorOf(addBack(ctx, scanId, itemId, markedJpeg(77)))

    expect(error).toBeInstanceOf(ConflictError)
    expect(error.code).toBe('ITEM_NOT_AWAITING_BACK_PHOTO')
    expect((await stateOf(ctx, scanId, itemId)).state).toBe(state)
    expect(ctx.photos.stored.size).toBe(stored)
    expect(ctx.jobs.enqueued).toHaveLength(jobs)
  })

  it.each([
    ['another user\'s scan', (s: string, i: string) => [s, i, OTHER_USER] as const],
    ['an unknown scan', (_s: string, i: string) => ['no-such-scan', i, USER] as const],
    ['an unknown item', (s: string) => [s, 'no-such-item', USER] as const],
  ])('answers SCAN_NOT_FOUND for %s, storing nothing', async (_label, aim) => {
    const ctx = setup()
    const { scanId, itemId } = await reach(ctx, 'needs-back-photo')
    const stored = ctx.photos.stored.size
    const [s, i, u] = aim(scanId, itemId)

    const error = await errorOf(addBack(ctx, s, i, markedJpeg(9), { userId: u }))

    expect(error).toBeInstanceOf(NotFoundError)
    expect(error.code).toBe('SCAN_NOT_FOUND')
    expect(ctx.photos.stored.size).toBe(stored)
  })

  it('answers AUTH_REQUIRED to a public caller', async () => {
    const ctx = setup()
    const { scanId, itemId } = await reach(ctx, 'needs-back-photo')

    const error = await errorOf(runAs({ kind: 'public' }, () => ctx.service.addBackPhoto(scanId, itemId, markedJpeg(9), IP)))

    expect(error.code).toBe('AUTH_REQUIRED')
  })

  it.each([
    ['a PNG', () => pngPhoto(), 'UNSUPPORTED_IMAGE'],
    ['bytes that are not an image', () => garbagePhoto(), 'UNSUPPORTED_IMAGE'],
    ['a photo with an edge of 1601 pixels', () => jpegPhoto({ width: 1601, height: 100 }), 'IMAGE_TOO_LARGE'],
    ['a photo of 2,000,001 bytes', () => jpegPhoto({ size: 2_000_001 }), 'IMAGE_TOO_LARGE'],
  ])('refuses %s as %s under the same rules as a front photo, leaving the item waiting', async (_label, make, code) => {
    const ctx = setup()
    const { scanId, itemId } = await reach(ctx, 'needs-back-photo')
    const stored = ctx.photos.stored.size

    const error = await errorOf(addBack(ctx, scanId, itemId, make()))

    expect(error).toBeInstanceOf(ValidationError)
    expect(error.code).toBe(code)
    expect((await stateOf(ctx, scanId, itemId)).state).toBe('needs-back-photo')
    expect(ctx.photos.stored.size).toBe(stored)
  })

  it('accepts a back photo of exactly 1600 pixels and 2,000,000 bytes', async () => {
    const ctx = setup()
    const { scanId, itemId } = await reach(ctx, 'needs-back-photo')

    await addBack(ctx, scanId, itemId, jpegPhoto({ width: 1600, height: 1600, size: 2_000_000 }))

    expect((await stateOf(ctx, scanId, itemId)).state).toBe('reading-label')
  })

  describe('daily quotas', () => {
    /** A user with `taken` (29 or 30) photos today, the last scan's first item waiting for its back photo. Three addresses keep the per-address quota out of it. */
    const withPhotosTaken = async (ctx: Ctx, taken: 29 | 30) => {
      const photos = (count: number) => Array.from({ length: count }, (_, i) => markedJpeg(i + 1))
      await create(ctx, photos(10), { ip: '192.0.2.1' })
      await create(ctx, photos(10), { ip: '192.0.2.2' })
      const scan = await create(ctx, photos(taken - 20), { ip: '192.0.2.3' })
      const itemId = scan.items[0].id as string
      await run(ctx, itemId, 'recognise')
      await run(ctx, itemId, 'match')
      await run(ctx, itemId, 'research')
      expect((await stateOf(ctx, scan.id, itemId)).state).toBe('needs-back-photo')
      return { scanId: scan.id as string, itemId }
    }

    it('counts a back photo as one photo: with 29 taken it fits as the 30th', async () => {
      const ctx = setup()
      const { scanId, itemId } = await withPhotosTaken(ctx, 29)

      await addBack(ctx, scanId, itemId)

      expect((await stateOf(ctx, scanId, itemId)).state).toBe('reading-label')
    })

    it('refuses a back photo as SCAN_DAILY_LIMIT when 30 photos were already taken, storing nothing and leaving the item waiting', async () => {
      const ctx = setup()
      const { scanId, itemId } = await withPhotosTaken(ctx, 30)
      const stored = ctx.photos.stored.size

      const error = await errorOf(addBack(ctx, scanId, itemId))

      expect(error).toBeInstanceOf(RateLimitedError)
      expect(error.code).toBe('SCAN_DAILY_LIMIT')
      expect(error.details!.retryAfterSeconds).toBeGreaterThan(0)
      expect((await stateOf(ctx, scanId, itemId)).state).toBe('needs-back-photo')
      expect(ctx.photos.stored.size).toBe(stored)
    })

    it('counts the back photo it just took towards the next one', async () => {
      const ctx = setup()
      const { scanId, itemId } = await withPhotosTaken(ctx, 29)
      await addBack(ctx, scanId, itemId)
      ctx.labelReader.respondWith(() => ({ readable: false }))
      await run(ctx, itemId, 'read-label')

      const error = await errorOf(addBack(ctx, scanId, itemId))

      expect(error.code).toBe('SCAN_DAILY_LIMIT')
    })
  })
})

describe('ScanService.retake', () => {
  /** A one-photo scan whose photo could not be read, so the item asks for a retake. */
  const awaitingRetake = (ctx: Ctx, read: Recognition = BLURRY) => failedFront(ctx, [read])

  it('keeps the new photo as the item\'s front photo, moves the item to recognising with no reason and enqueues the recognise', async () => {
    const ctx = setup()
    const { scanId, itemId } = await awaitingRetake(ctx, TURNED_AWAY)
    const photo = webpPhoto()
    ctx.advance(5 * MINUTE)

    const view = await retake(ctx, scanId, itemId, photo)

    expect(view).toMatchObject({ id: itemId, state: 'recognising', reason: null, image: { kind: 'user' } })
    expect(view).not.toHaveProperty('retakesLeft')
    expect(view).not.toHaveProperty('recognised')
    expect(ctx.photos.stored.get(photoKey(scanId, itemId, 'webp'))).toEqual(photo)
    expect((await ctx.repository.findItem(itemId))!.photoKey).toBe(photoKey(scanId, itemId, 'webp'))
    expect(queued(ctx).at(-1)).toEqual(advanceMessage(itemId, 'recognise'))
    // The message carries the time of the retake: the key of this run, apart from the first photo's.
    expect(queuedWithTime(ctx).at(-1)).toMatchObject({ itemId, step: 'recognise', at: T0.getTime() + 5 * MINUTE })
  })

  it('answers the same item that getScan gives', async () => {
    const ctx = setup()
    const { scanId, itemId } = await awaitingRetake(ctx)

    const view = await retake(ctx, scanId, itemId)

    expect(view).toEqual(await itemOf(ctx, scanId, itemId))
  })

  it('publishes the item as recognising, after needs-retake, so a client watching the scan sees both', async () => {
    const ctx = setup()
    const { scanId, itemId } = await awaitingRetake(ctx)

    await retake(ctx, scanId, itemId)

    expect(ctx.events.eventsFor(scanId)).toMatchObject([
      { type: 'item', item: { id: itemId, state: 'needs-retake' } },
      { type: 'item', item: { id: itemId, state: 'recognising', reason: null } },
    ])
  })

  it('does not send done, or mark the scan done, while the item waits for a retake or for identification', async () => {
    const ctx = setup()
    const asking = await awaitingRetake(ctx)
    const identifying = await failedFront(ctx, [BLURRY, BLURRY, BLURRY])

    for (const { scanId } of [asking, identifying]) {
      expect(ctx.events.eventsFor(scanId).length).toBeGreaterThan(0)
      expect(ctx.events.eventsFor(scanId).map((e) => e.type)).not.toContain('done')
    }
    expect((await ctx.repository.findScan(asking.scanId))!.doneAt).toBeNull()
    expect((await ctx.repository.findScan(identifying.scanId))!.doneAt).toBeNull()
  })

  it('goes on to ready when the retaken photo reads, through the same steps as a first photo', async () => {
    const ctx = setup()
    await catalogued(ctx)
    const { scanId, itemId } = await awaitingRetake(ctx)
    await retake(ctx, scanId, itemId)
    ctx.recognizer.respondWith(() => seen())

    await drain(ctx)

    expect((await itemOf(ctx, scanId, itemId)).state).toBe('ready')
  })

  it.each([
    ['recognising', (ctx: Ctx) => scanOne(ctx)],
    ['matching', (ctx: Ctx) => reach(ctx, 'matching')],
    ['needs-confirmation', (ctx: Ctx) => reach(ctx, 'needs-confirmation')],
    ['needs-back-photo', (ctx: Ctx) => reach(ctx, 'needs-back-photo')],
    // The boundary: after the third unreadable photo the item no longer takes a retake, it asks for identification.
    ['needs-identification', (ctx: Ctx) => failedFront(ctx, [BLURRY, BLURRY, BLURRY])],
  ])('refuses an item that is %s with ITEM_NOT_AWAITING_RETAKE, storing and queueing nothing and recording no photo', async (state, arrange) => {
    const ctx = setup()
    const { scanId, itemId } = await arrange(ctx)
    const stored = ctx.photos.stored.size
    const jobs = ctx.jobs.enqueued.length
    const counted = await ctx.repository.photosSince(USER, new Date(T0.getTime() - DAY))

    const error = await errorOf(retake(ctx, scanId, itemId, markedJpeg(77)))

    expect(error).toBeInstanceOf(ConflictError)
    expect(error.code).toBe('ITEM_NOT_AWAITING_RETAKE')
    expect((await stateOf(ctx, scanId, itemId)).state).toBe(state)
    expect(ctx.photos.stored.size).toBe(stored)
    expect(ctx.jobs.enqueued).toHaveLength(jobs)
    expect(await ctx.repository.photosSince(USER, new Date(T0.getTime() - DAY))).toEqual(counted)
  })

  it('refuses a rejected item with ITEM_NOT_AWAITING_RETAKE: a face is not given another try', async () => {
    const ctx = setup()
    ctx.recognizer.respondWith(() => ({ classification: 'face-or-person' }))
    const { scanId, itemId } = await scanOne(ctx)
    await run(ctx, itemId, 'recognise')

    const error = await errorOf(retake(ctx, scanId, itemId))

    expect(error.code).toBe('ITEM_NOT_AWAITING_RETAKE')
    expect((await stateOf(ctx, scanId, itemId)).state).toBe('rejected')
  })

  it('refuses a second retake of the same item with ITEM_NOT_AWAITING_RETAKE, and enqueues the recognise only once', async () => {
    const ctx = setup()
    const { scanId, itemId } = await awaitingRetake(ctx)
    await retake(ctx, scanId, itemId)
    const jobs = ctx.jobs.enqueued.length

    const error = await errorOf(retake(ctx, scanId, itemId, markedJpeg(21)))

    expect(error.code).toBe('ITEM_NOT_AWAITING_RETAKE')
    expect(ctx.jobs.enqueued).toHaveLength(jobs)
  })

  it.each([
    ['another user\'s scan', (s: string, i: string) => [s, i, OTHER_USER] as const],
    ['an unknown scan', (_s: string, i: string) => ['no-such-scan', i, USER] as const],
    ['an unknown item', (s: string) => [s, 'no-such-item', USER] as const],
  ])('answers SCAN_NOT_FOUND for %s, storing and queueing nothing', async (_label, aim) => {
    const ctx = setup()
    const { scanId, itemId } = await awaitingRetake(ctx)
    const stored = ctx.photos.stored.size
    const jobs = ctx.jobs.enqueued.length
    const [s, i, u] = aim(scanId, itemId)

    const error = await errorOf(retake(ctx, s, i, markedJpeg(21), { userId: u }))

    expect(error).toBeInstanceOf(NotFoundError)
    expect(error.code).toBe('SCAN_NOT_FOUND')
    expect(ctx.photos.stored.size).toBe(stored)
    expect(ctx.jobs.enqueued).toHaveLength(jobs)
  })

  it('answers SCAN_NOT_FOUND to another profile of the same user, changing nothing', async () => {
    const ctx = setup()
    const { scanId, itemId } = await awaitingRetake(ctx)
    const stored = ctx.photos.stored.size
    const jobs = ctx.jobs.enqueued.length

    const error = await errorOf(retake(ctx, scanId, itemId, markedJpeg(21), { profileId: OTHER_PROFILE }))

    expect(error).toBeInstanceOf(NotFoundError)
    expect(error.code).toBe('SCAN_NOT_FOUND')
    expect((await stateOf(ctx, scanId, itemId)).state).toBe('needs-retake')
    expect(ctx.photos.stored.size).toBe(stored)
    expect(ctx.jobs.enqueued).toHaveLength(jobs)
  })

  it('answers AUTH_REQUIRED to a public caller', async () => {
    const ctx = setup()
    const { scanId, itemId } = await awaitingRetake(ctx)

    const error = await errorOf(runAs({ kind: 'public' }, () => ctx.service.retake(scanId, itemId, markedJpeg(21), IP)))

    expect(error.code).toBe('AUTH_REQUIRED')
  })

  it.each([
    ['a PNG', 'UNSUPPORTED_IMAGE', () => pngPhoto()],
    ['bytes that are not an image', 'UNSUPPORTED_IMAGE', () => garbagePhoto()],
    ['a photo with an edge of 1601 pixels', 'IMAGE_TOO_LARGE', () => jpegPhoto({ width: 1601, height: 100 })],
    ['a photo of 2,000,001 bytes', 'IMAGE_TOO_LARGE', () => jpegPhoto({ size: 2_000_001 })],
  ])('refuses %s as %s under the same rules as a front photo, leaving the item waiting and the retake uncounted', async (_label, code, make) => {
    const ctx = setup()
    const { scanId, itemId } = await awaitingRetake(ctx)
    const jobs = ctx.jobs.enqueued.length

    const error = await errorOf(retake(ctx, scanId, itemId, make()))

    expect(error).toBeInstanceOf(ValidationError)
    expect(error.code).toBe(code)
    expect(await itemOf(ctx, scanId, itemId)).toMatchObject({ state: 'needs-retake', retakesLeft: 2 })
    expect(ctx.photos.stored.size).toBe(0)
    expect(ctx.jobs.enqueued).toHaveLength(jobs)
  })

  it('accepts a retaken photo of exactly 1600 pixels and 2,000,000 bytes', async () => {
    const ctx = setup()
    const { scanId, itemId } = await awaitingRetake(ctx)

    await retake(ctx, scanId, itemId, jpegPhoto({ width: 1600, height: 1600, size: 2_000_000 }))

    expect((await stateOf(ctx, scanId, itemId)).state).toBe('recognising')
  })

  describe('daily quotas', () => {
    /** A user with `taken` (29 or 30) photos today, the last scan's first item (photo 1) unreadable and asking for a retake. Three addresses keep the per-address quota out of it. */
    const withPhotosTaken = async (ctx: Ctx, taken: 29 | 30) => {
      const photos = (count: number) => Array.from({ length: count }, (_, i) => markedJpeg(i + 1))
      await create(ctx, photos(10), { ip: '192.0.2.1' })
      await create(ctx, photos(10), { ip: '192.0.2.2' })
      const scan = await create(ctx, photos(taken - 20), { ip: '192.0.2.3' })
      const itemId = scan.items[0].id as string
      ctx.recognizer.respondWith(() => BLURRY)
      await run(ctx, itemId, 'recognise')
      expect((await stateOf(ctx, scan.id, itemId)).state).toBe('needs-retake')
      return { scanId: scan.id as string, itemId }
    }

    it('counts a retake as one photo: with 29 taken it fits as the 30th', async () => {
      const ctx = setup()
      const { scanId, itemId } = await withPhotosTaken(ctx, 29)

      await retake(ctx, scanId, itemId)

      expect((await stateOf(ctx, scanId, itemId)).state).toBe('recognising')
    })

    it('refuses a retake as SCAN_DAILY_LIMIT when 30 photos were already taken, storing nothing and leaving the item waiting', async () => {
      const ctx = setup()
      const { scanId, itemId } = await withPhotosTaken(ctx, 30)
      const stored = ctx.photos.stored.size
      const jobs = ctx.jobs.enqueued.length

      const error = await errorOf(retake(ctx, scanId, itemId))

      expect(error).toBeInstanceOf(RateLimitedError)
      expect(error.code).toBe('SCAN_DAILY_LIMIT')
      expect(error.details!.retryAfterSeconds).toBeGreaterThan(0)
      expect((await stateOf(ctx, scanId, itemId)).state).toBe('needs-retake')
      expect(ctx.photos.stored.size).toBe(stored)
      expect(ctx.jobs.enqueued).toHaveLength(jobs)
    })

    it('counts the retake it just took towards the next one', async () => {
      const ctx = setup()
      const { scanId, itemId } = await withPhotosTaken(ctx, 29)
      await retake(ctx, scanId, itemId)
      await run(ctx, itemId, 'recognise')
      expect((await stateOf(ctx, scanId, itemId)).state).toBe('needs-retake')

      const error = await errorOf(retake(ctx, scanId, itemId))

      expect(error.code).toBe('SCAN_DAILY_LIMIT')
    })

    it('counts a retake for the address it came from, not for the address the scan was made from', async () => {
      const ctx = setup({ policy: { dailyPhotosPerIp: 2 } })
      const { scanId, itemId } = await awaitingRetake(ctx)

      await retake(ctx, scanId, itemId, markedJpeg(21), { ip: OTHER_IP })

      // IP has the front photo only, and OTHER_IP has the retake only: each can take one more, and no more.
      await expect(create(ctx, [markedJpeg(31)], { ip: IP })).resolves.toMatchObject({ items: expect.any(Array) })
      await expect(create(ctx, [markedJpeg(32)], { ip: OTHER_IP })).resolves.toMatchObject({ items: expect.any(Array) })
      expect((await errorOf(create(ctx, [markedJpeg(33)], { ip: OTHER_IP }))).code).toBe('SCAN_DAILY_LIMIT')
      expect((await errorOf(create(ctx, [markedJpeg(34)], { ip: IP }))).code).toBe('SCAN_DAILY_LIMIT')
    })

    it('counts the daily photos across the account\'s profiles, so a retake by one profile uses the other\'s allowance too', async () => {
      const ctx = setup({ policy: { dailyPhotosPerUser: 2 } })
      const { scanId, itemId } = await awaitingRetake(ctx)

      await retake(ctx, scanId, itemId)

      expect((await errorOf(create(ctx, [markedJpeg(31)], { profileId: OTHER_PROFILE }))).code).toBe('SCAN_DAILY_LIMIT')
    })
  })

  describe('a queue that fails', () => {
    const outage = () => new Error('queue is down')

    it('moves the item back to needs-retake with the reason it had, removes the new photo, and rethrows so the caller can try again', async () => {
      const ctx = setup()
      const { scanId, itemId } = await awaitingRetake(ctx, TURNED_AWAY)
      const failure = outage()
      ctx.jobs.failNextWith(failure)

      await expect(retake(ctx, scanId, itemId)).rejects.toBe(failure)

      expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'needs-retake', reason: 'label-not-visible' })
      expect((await ctx.repository.findItem(itemId))!.photoKey).toBeNull()
      expect(ctx.photos.stored.size).toBe(0)
    })

    it('still counts the photo that was sent against the daily quota, as a back photo is', async () => {
      const ctx = setup()
      const { scanId, itemId } = await awaitingRetake(ctx)
      ctx.jobs.failNextWith(outage())

      await retake(ctx, scanId, itemId).catch(() => undefined)

      // The front photo, and the retake the failed queueing did not take back.
      expect((await ctx.repository.photosSince(USER, new Date(T0.getTime() - DAY))).count).toBe(2)
    })

    it('never shows a negative retakesLeft: each failed queueing keeps its retake row, so the count bottoms out at 0', async () => {
      const ctx = setup()
      const { scanId, itemId } = await awaitingRetake(ctx)
      const left: (number | undefined)[] = []
      for (const marker of [21, 22, 23]) {
        ctx.jobs.failNextWith(outage())
        await retake(ctx, scanId, itemId, markedJpeg(marker)).catch(() => undefined)
        ctx.advance(SECOND)
        left.push((await itemOf(ctx, scanId, itemId)).retakesLeft)
      }

      expect(left).toEqual([1, 0, 0])
    })

    it('lets the user retake again after a failed queueing, and queues that recognise', async () => {
      const ctx = setup()
      const { scanId, itemId } = await awaitingRetake(ctx)
      ctx.jobs.failNextWith(outage())
      await retake(ctx, scanId, itemId).catch(() => undefined)
      ctx.advance(SECOND)

      await retake(ctx, scanId, itemId, markedJpeg(22))

      expect((await stateOf(ctx, scanId, itemId)).state).toBe('recognising')
      expect(queued(ctx).at(-1)).toEqual(advanceMessage(itemId, 'recognise'))
    })

    it('queues the retry under a key of its own, so the job runner does not drop it as a repeat of the one that never got queued', async () => {
      const ctx = setup()
      const { scanId, itemId } = await awaitingRetake(ctx)
      const attempts: AdvanceScanItemMessage[] = []
      const enqueue = ctx.jobs.enqueue.bind(ctx.jobs)
      vi.spyOn(ctx.jobs, 'enqueue').mockImplementation((job, body, options) => {
        attempts.push(body as AdvanceScanItemMessage)
        return enqueue(job, body, options)
      })
      ctx.jobs.failNextWith(outage())
      await retake(ctx, scanId, itemId).catch(() => undefined)
      ctx.advance(SECOND)

      await retake(ctx, scanId, itemId, markedJpeg(22))

      const [failed, retried] = attempts
      expect(failed).toMatchObject({ itemId, step: 'recognise' })
      expect(retried).toMatchObject({ itemId, step: 'recognise' })
      expect(advanceScanItemSpec.key(retried!)).not.toBe(advanceScanItemSpec.key(failed!))
    })
  })

  describe('two retakes at once', () => {
    it.each([
      ['two JPEGs, which share one key', () => [markedJpeg(21), markedJpeg(22)]],
      ['a JPEG and a WebP, which have keys of their own', () => [markedJpeg(21), webpPhoto()]],
    ])('lets one win and answers ITEM_NOT_AWAITING_RETAKE to the other, leaving the winner\'s photo in the bucket and one recognise queued (%s)', async (_label, photos) => {
      const ctx = setup()
      const { scanId, itemId } = await awaitingRetake(ctx)
      const jobs = ctx.jobs.enqueued.length
      const [a, b] = photos()

      const results = await Promise.allSettled([retake(ctx, scanId, itemId, a), retake(ctx, scanId, itemId, b)])

      const lost = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(lost).toHaveLength(1)
      expect((lost[0]!.reason as { code: string }).code).toBe('ITEM_NOT_AWAITING_RETAKE')
      const stored = await ctx.repository.findItem(itemId)
      expect(stored!.state).toBe('recognising')
      expect(ctx.photos.stored.has(stored!.photoKey!)).toBe(true)
      expect(ctx.photos.stored.size).toBe(1)
      expect(ctx.jobs.enqueued).toHaveLength(jobs + 1)
    })
  })
})

describe('ScanService.getScan', () => {
  it('shows the scan\'s id, when it was made and its items in photo order', async () => {
    const ctx = setup()
    const scan = await create(ctx, [markedJpeg(1), markedJpeg(2), markedJpeg(3)])
    ctx.advance(HOUR)

    const view = await getScan(ctx, scan.id)

    expect(view).toMatchObject({ id: scan.id, createdAt: T0 })
    expect(view.items.map((i: { id: string; position: number }) => [i.id, i.position])).toEqual(scan.items.map((i: { id: string; position: number }) => [i.id, i.position]))
  })

  it.each([
    ['another user', OTHER_USER, undefined],
    ['nobody (an unknown scan)', USER, 'no-such-scan'],
  ])('answers SCAN_NOT_FOUND to %s, with no hint that the scan exists', async (_label, userId, scanId) => {
    const ctx = setup()
    const scan = await create(ctx)

    const error = await errorOf(getScan(ctx, scanId ?? scan.id, userId))

    expect(error).toBeInstanceOf(NotFoundError)
    expect(error.code).toBe('SCAN_NOT_FOUND')
  })

  it('answers AUTH_REQUIRED to a public caller', async () => {
    const ctx = setup()
    const scan = await create(ctx)

    const error = await errorOf(runAs({ kind: 'public' }, () => ctx.service.getScan(scan.id)))

    expect(error.code).toBe('AUTH_REQUIRED')
  })

  it('shows what was read, once it is read, and the product only when the item is ready', async () => {
    const ctx = setup()
    await catalogued(ctx)
    const { scanId, itemId } = await scanOne(ctx)
    expect((await itemOf(ctx, scanId, itemId)).recognised).toBeUndefined()

    await run(ctx, itemId, 'recognise')
    const matching = await itemOf(ctx, scanId, itemId)
    expect(matching.recognised).toMatchObject({ brand: 'CeraVe', name: 'Hydrating Facial Cleanser' })
    expect(matching).not.toHaveProperty('product')

    await run(ctx, itemId, 'match')
    expect(await itemOf(ctx, scanId, itemId)).toHaveProperty('product.brand', CERAVE.brand)
  })

  it('links the user\'s own photo for 5 minutes at a time, signed for that user and that photo', async () => {
    const ctx = setup()
    const { scanId, itemId } = await scanOne(ctx)
    ctx.advance(10 * MINUTE)

    const item = await itemOf(ctx, scanId, itemId)

    const token = item.image.url.replace('/api/v1/scans/products/photos/', '')
    const issuedAt = ctx.now().getTime()
    expect(await verifyPhotoLink(token, PHOTO_SECRET, new Date(issuedAt + (PHOTO_LINK_TTL_SECONDS - 1) * SECOND))).toEqual({ key: photoKey(scanId, itemId), userId: USER })
    expect(await verifyPhotoLink(token, PHOTO_SECRET, new Date(issuedAt + PHOTO_LINK_TTL_SECONDS * SECOND))).toBeNull()
  })

  it('has no image once the photo is deleted and there is no stock image', async () => {
    const ctx = setup()
    ctx.recognizer.respondWith(() => ({ classification: 'face-or-person' }))
    const { scanId, itemId } = await scanOne(ctx)
    await run(ctx, itemId, 'recognise')

    expect((await itemOf(ctx, scanId, itemId)).image).toBeNull()
  })
})

describe('ScanService.photoForLink', () => {
  const linkOf = async (ctx: Ctx, scanId: string, itemId: string) => (await itemOf(ctx, scanId, itemId)).image.url.replace('/api/v1/scans/products/photos/', '') as string
  // No runAs: the link is the capability (an app image component cannot send an Authorization header), so opening one
  // needs no signed-in user and the service must not read a request context at all.
  const open = (ctx: Ctx, token: string) => ctx.service.photoForLink(token)

  it('gives whoever holds the link the photo it was signed for, with no request context user: its bytes and its media type', async () => {
    const ctx = setup()
    const photo = webpPhoto()
    const { scanId, itemId } = await scanOne(ctx, photo)

    const opened = await open(ctx, await linkOf(ctx, scanId, itemId))

    expect(opened).toEqual({ bytes: photo.bytes, mediaType: 'image/webp' })
  })

  it.each([
    ['still open one second before it expires', PHOTO_LINK_TTL_SECONDS - 1, true],
    ['expired at the 5 minute mark', PHOTO_LINK_TTL_SECONDS, false],
  ])('a link is %s', async (_label, afterSeconds, opens) => {
    const ctx = setup()
    const { scanId, itemId } = await scanOne(ctx)
    const token = await linkOf(ctx, scanId, itemId)
    ctx.advance(afterSeconds * SECOND)

    const attempt = open(ctx, token)

    if (opens) await expect(attempt).resolves.toMatchObject({ mediaType: 'image/jpeg' })
    else await expect(attempt).rejects.toMatchObject({ code: 'PHOTO_NOT_FOUND' })
  })

  it('answers PHOTO_NOT_FOUND for a token that is not a link, or was signed with another secret, or was changed', async () => {
    const ctx = setup()
    const { scanId, itemId } = await scanOne(ctx)
    const good = await linkOf(ctx, scanId, itemId)
    const forged = await signPhotoLink({ key: photoKey(scanId, itemId), userId: USER, expiresAt: new Date(T0.getTime() + MINUTE) }, 'some-other-secret', T0)
    const changed = good.slice(0, 20) + (good[20] === 'A' ? 'B' : 'A') + good.slice(21)

    for (const token of ['', 'not-a-token', forged, changed]) {
      const error = await errorOf(open(ctx, token))
      expect(error).toBeInstanceOf(NotFoundError)
      expect(error.code).toBe('PHOTO_NOT_FOUND')
    }
  })

  it('answers PHOTO_NOT_FOUND when the photo has been deleted since the link was made', async () => {
    const ctx = setup()
    ctx.recognizer.respondWith(() => ({ classification: 'face-or-person' }))
    const { scanId, itemId } = await scanOne(ctx)
    const token = await linkOf(ctx, scanId, itemId)
    await run(ctx, itemId, 'recognise')

    const error = await errorOf(open(ctx, token))

    expect(error).toBeInstanceOf(NotFoundError)
    expect(error.code).toBe('PHOTO_NOT_FOUND')
  })

  it('opens for a signed-in user other than the one it was signed for: the link itself is the capability', async () => {
    const ctx = setup()
    const { scanId, itemId } = await scanOne(ctx)
    const token = await linkOf(ctx, scanId, itemId)

    await expect(asUser(() => ctx.service.photoForLink(token), OTHER_USER)).resolves.toMatchObject({ mediaType: 'image/jpeg' })
  })
})

describe('ScanService: the time stamp on every queued step', () => {
  it('queues the first recognise at the time the item was created', async () => {
    const ctx = setup()
    ctx.advance(7 * MINUTE)

    const scan = await create(ctx)

    expect(queuedWithTime(ctx)).toEqual([{ itemId: scan.items[0].id, step: 'recognise', at: T0.getTime() + 7 * MINUTE }])
  })

  it.each([
    ['match', (ctx: Ctx) => scanOne(ctx), 'recognise'],
    ['research', (ctx: Ctx) => reach(ctx, 'matching'), 'match'],
    ['analyse', (ctx: Ctx) => reach(ctx, 'researching'), 'research'],
  ] as const)('queues %s at the time the item entered the state it works on: the updatedAt the move stored', async (next, arrange, from) => {
    const ctx = setup()
    ctx.researcher.respondWith(() => ({ found: true, ingredients: CLEAN, sourceUrl: SOURCE_URL }))
    const { itemId } = await arrange(ctx)
    ctx.advance(3 * MINUTE)

    await run(ctx, itemId, from)

    const stored = await ctx.repository.findItem(itemId)
    expect(queuedWithTime(ctx).at(-1)).toEqual({ itemId, step: next, at: stored!.updatedAt.getTime() })
    expect(stored!.updatedAt.getTime()).toBe(T0.getTime() + 3 * MINUTE)
  })

  it('queues the read of a back photo at the time it was uploaded', async () => {
    const ctx = setup()
    const { scanId, itemId } = await reach(ctx, 'needs-back-photo')
    ctx.advance(5 * MINUTE)

    await asUser(() => ctx.service.addBackPhoto(scanId, itemId, markedJpeg(9), IP))

    expect(queuedWithTime(ctx).at(-1)).toEqual({ itemId, step: 'read-label', at: T0.getTime() + 5 * MINUTE })
  })

  it('queues the confirmed match at the time of the confirmation', async () => {
    const ctx = setup()
    const { scanId, itemId } = await reach(ctx, 'needs-confirmation')
    ctx.advance(2 * MINUTE)

    await asUser(() => ctx.service.confirm(scanId, itemId, { brand: 'CeraVe', name: 'Hydrating Facial Cleanser', category: 'skin' }))

    expect(queuedWithTime(ctx).at(-1)).toEqual({ itemId, step: 'match', at: T0.getTime() + 2 * MINUTE })
  })
})

describe('ScanService: a queue that fails', () => {
  const outage = () => new Error('queue is down')

  it('fails every item of a new scan as unavailable when its recognise cannot be queued, and says so', async () => {
    const ctx = setup()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    ctx.jobs.failNextWith(outage())

    const scan = await create(ctx, [markedJpeg(1), markedJpeg(2)])

    // Only the first enqueue was failed; the second item was queued and goes on.
    expect(scan.items.map((i: { state: string; reason: string | null }) => [i.state, i.reason])).toEqual([
      ['failed', 'unavailable'],
      ['recognising', null],
    ])
    expect(queued(ctx)).toEqual([advanceMessage(scan.items[1].id, 'recognise')])
    expect(logged).toHaveBeenCalledWith({ outcome: 'enqueue-failed', scanId: scan.id, itemId: scan.items[0].id })
    logged.mockRestore()
  })

  it('moves the item back, and rethrows so the queue retries, when the next step cannot be queued', async () => {
    const ctx = setup()
    const { scanId, itemId } = await scanOne(ctx)
    const failure = outage()
    ctx.jobs.failNextWith(failure)

    await expect(run(ctx, itemId, 'recognise')).rejects.toBe(failure)

    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'recognising', reason: null })
    expect(ctx.events.published).toEqual([])
  })

  it('undoes the extra fields of a back-photo upload too: the key goes, and the reason the item had comes back', async () => {
    const ctx = setup()
    const { scanId, itemId } = await reach(ctx, 'reading-label')
    ctx.labelReader.respondWith(() => ({ readable: false }))
    await run(ctx, itemId, 'read-label')
    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'needs-back-photo', reason: 'label-unreadable' })
    const failure = outage()
    ctx.jobs.failNextWith(failure)

    await expect(asUser(() => ctx.service.addBackPhoto(scanId, itemId, markedJpeg(10), IP))).rejects.toBe(failure)

    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'needs-back-photo', reason: 'label-unreadable' })
    expect((await ctx.repository.findItem(itemId))!.backPhotoKey).toBeNull()
    expect(ctx.photos.stored.has(backKey(scanId, itemId))).toBe(false)
  })

  it('lets the user upload again after a failed queueing, and queues that read', async () => {
    const ctx = setup()
    const { scanId, itemId } = await reach(ctx, 'needs-back-photo')
    ctx.jobs.failNextWith(outage())
    await asUser(() => ctx.service.addBackPhoto(scanId, itemId, markedJpeg(10), IP)).catch(() => undefined)
    ctx.advance(SECOND)

    await asUser(() => ctx.service.addBackPhoto(scanId, itemId, markedJpeg(11), IP))

    expect((await stateOf(ctx, scanId, itemId)).state).toBe('reading-label')
    expect(queued(ctx).at(-1)).toEqual(advanceMessage(itemId, 'read-label'))
  })

  it('queues the retry of a step under a new key: the step is claimed again, not dropped as a repeat of the one that never got queued', async () => {
    const ctx = setup()
    const { itemId } = await scanOne(ctx)
    const attempts: AdvanceScanItemMessage[] = []
    const enqueue = ctx.jobs.enqueue.bind(ctx.jobs)
    vi.spyOn(ctx.jobs, 'enqueue').mockImplementation((job, body, options) => {
      attempts.push(body as AdvanceScanItemMessage)
      return enqueue(job, body, options)
    })
    ctx.jobs.failNextWith(outage())
    await run(ctx, itemId, 'recognise').catch(() => undefined)
    ctx.advance(SECOND)

    await run(ctx, itemId, 'recognise')

    const [failed, retried] = attempts
    expect(failed).toMatchObject({ itemId, step: 'match' })
    expect(retried).toMatchObject({ itemId, step: 'match' })
    expect(advanceScanItemSpec.key(retried!)).not.toBe(advanceScanItemSpec.key(failed!))
    expect(queued(ctx).at(-1)).toEqual(advanceMessage(itemId, 'match'))
  })
})

describe('ScanService.advance: what the model cannot or will not do', () => {
  const refused = () => new AnthropicRefusalError('Claude refused to answer')
  const unusable = () => new AnthropicRequestError('Claude returned text that is not valid JSON')
  const capped = () => new AiBudgetExceededError('cap')

  describe('recognise', () => {
    it('asks for a retake of a photo the model refused to look at, as unreadable, deletes it, and does not throw', async () => {
      const ctx = setup()
      const { scanId, itemId } = await scanOne(ctx)
      ctx.recognizer.failNextWith(refused())

      await expect(run(ctx, itemId, 'recognise')).resolves.toBeUndefined()

      expect(await itemOf(ctx, scanId, itemId)).toMatchObject({ state: 'needs-retake', reason: 'unreadable', retakesLeft: 2, image: null })
      expect(ctx.photos.stored.size).toBe(0)
      expect((await ctx.repository.findItem(itemId))!.photoKey).toBeNull()
      expect(queued(ctx)).toEqual([advanceMessage(itemId, 'recognise')])
    })

    it('fails an item as unavailable, then throws a PermanentJobError so no paid retry follows, when the answer was unusable', async () => {
      const ctx = setup()
      const { scanId, itemId } = await scanOne(ctx)
      ctx.recognizer.failNextWith(unusable())

      const error = await errorOf(run(ctx, itemId, 'recognise'))

      expect(error).toBeInstanceOf(PermanentJobError)
      expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'failed', reason: 'unavailable' })
    })

    it('fails the item as research-busy, keeps its photo, and does not throw, when the AI spend cap is spent', async () => {
      const ctx = setup()
      const { scanId, itemId } = await scanOne(ctx)
      ctx.recognizer.failNextWith(capped())

      await expect(run(ctx, itemId, 'recognise')).resolves.toBeUndefined()

      expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'failed', reason: 'research-busy' })
      expect(ctx.photos.stored.has(photoKey(scanId, itemId))).toBe(true)
      expect((await itemOf(ctx, scanId, itemId)).image.kind).toBe('user')
    })

    it('still throws when the model is merely unavailable, leaving the item recognising for the queue to retry', async () => {
      const ctx = setup()
      const { scanId, itemId } = await scanOne(ctx)
      const outage = new AnthropicUnavailableError('overloaded')
      ctx.recognizer.failNextWith(outage)

      await expect(run(ctx, itemId, 'recognise')).rejects.toBe(outage)

      expect((await stateOf(ctx, scanId, itemId)).state).toBe('recognising')
    })
  })

  describe('read-label', () => {
    it.each([
      ['refuses', refused],
      ['sends an unusable answer', unusable],
    ])('asks again for the back photo as label-unreadable, deletes the one it had, and does not throw, when the model %s', async (_label, failure) => {
      const ctx = setup()
      const { scanId, itemId } = await reach(ctx, 'reading-label')
      ctx.labelReader.failNextWith(failure())

      await expect(run(ctx, itemId, 'read-label')).resolves.toBeUndefined()

      expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'needs-back-photo', reason: 'label-unreadable' })
      expect(ctx.photos.stored.has(backKey(scanId, itemId))).toBe(false)
      expect((await ctx.repository.findItem(itemId))!.backPhotoKey).toBeNull()
    })

    it('fails the item as research-busy, keeps the back photo, and does not throw, when the AI spend cap is spent', async () => {
      const ctx = setup()
      const { scanId, itemId } = await reach(ctx, 'reading-label')
      ctx.labelReader.failNextWith(capped())

      await expect(run(ctx, itemId, 'read-label')).resolves.toBeUndefined()

      expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'failed', reason: 'research-busy' })
      expect(ctx.photos.stored.has(backKey(scanId, itemId))).toBe(true)
    })

    it('asks again for a photo of the back, rather than failing, when the back photo is gone', async () => {
      const ctx = setup()
      const { scanId, itemId } = await reach(ctx, 'reading-label')
      ctx.photos.stored.delete(backKey(scanId, itemId))

      await run(ctx, itemId, 'read-label')

      expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'needs-back-photo', reason: 'label-unreadable' })
      expect(ctx.labelReader.calls).toEqual([])
      expect((await ctx.repository.findItem(itemId))!.backPhotoKey).toBeNull()
    })
  })
})

describe('ScanService.advance: waiting for work another call is doing', () => {
  const waited = (ctx: Ctx, before: number) => queuedWithTime(ctx).slice(before)

  it('leaves a researching item as it is, queues the same step again 30 seconds later under a key of its own, and does not throw', async () => {
    const ctx = setup()
    const { scanId, itemId } = await reach(ctx, 'researching')
    const original = queuedWithTime(ctx).at(-1)!
    ctx.advance(MINUTE)
    vi.spyOn(ctx.catalog, 'research').mockRejectedValueOnce(new ResearchInProgressError())
    const before = ctx.jobs.enqueued.length
    const events = ctx.events.published.length

    await expect(run(ctx, itemId, 'research')).resolves.toBeUndefined()

    expect((await stateOf(ctx, scanId, itemId)).state).toBe('researching')
    expect(waited(ctx, before)).toEqual([{ itemId, step: 'research', at: ctx.now().getTime(), delaySeconds: 30 }])
    expect(advanceScanItemSpec.key(waited(ctx, before)[0]!)).not.toBe(advanceScanItemSpec.key(original))
    expect(ctx.events.published).toHaveLength(events)
  })

  it('does the same for an analysing item whose formulation is being analysed', async () => {
    const ctx = setup()
    const { scanId, itemId } = await analysingItem(ctx)
    ctx.advance(MINUTE)
    vi.spyOn(ctx.catalog, 'analyse').mockRejectedValueOnce(new AnalysisInProgressError())
    const before = ctx.jobs.enqueued.length

    await expect(run(ctx, itemId, 'analyse')).resolves.toBeUndefined()

    expect((await stateOf(ctx, scanId, itemId)).state).toBe('analysing')
    expect(waited(ctx, before)).toEqual([{ itemId, step: 'analyse', at: ctx.now().getTime(), delaySeconds: 30 }])
  })

  it('does not change the item\'s updatedAt, so the reaper\'s 2 hour limit counts from when it entered the state', async () => {
    const ctx = setup()
    const { itemId } = await reach(ctx, 'researching')
    const entered = (await ctx.repository.findItem(itemId))!.updatedAt
    ctx.advance(MINUTE)
    vi.spyOn(ctx.catalog, 'research').mockRejectedValueOnce(new ResearchInProgressError())

    await run(ctx, itemId, 'research')

    expect((await ctx.repository.findItem(itemId))!.updatedAt).toEqual(entered)
  })

  it('gives each wait its own key, so waiting twice queues two different runs', async () => {
    const ctx = setup()
    const { itemId } = await reach(ctx, 'researching')
    vi.spyOn(ctx.catalog, 'research').mockRejectedValue(new ResearchInProgressError())
    const before = ctx.jobs.enqueued.length
    ctx.advance(30 * SECOND)
    await run(ctx, itemId, 'research')
    ctx.advance(30 * SECOND)
    await run(ctx, itemId, 'research')

    const keys = waited(ctx, before).map((m) => advanceScanItemSpec.key(m))
    expect(keys).toHaveLength(2)
    expect(new Set(keys).size).toBe(2)
  })

  it('throws, for the queue to retry, when the waiting message cannot be queued', async () => {
    const ctx = setup()
    const { scanId, itemId } = await reach(ctx, 'researching')
    vi.spyOn(ctx.catalog, 'research').mockRejectedValueOnce(new ResearchInProgressError())
    const outage = new Error('queue is down')
    ctx.jobs.failNextWith(outage)

    await expect(run(ctx, itemId, 'research')).rejects.toBe(outage)

    expect((await stateOf(ctx, scanId, itemId)).state).toBe('researching')
  })
})

describe('ScanService.advance: an item that lacks what its step needs', () => {
  it.each([
    ['research', 'researching', (ctx: Ctx) => reach(ctx, 'researching'), { productId: null }],
    ['analyse', 'analysing', (ctx: Ctx) => analysingItem(ctx), { formulationId: null }],
  ] as const)('fails an item in %s with no product or formulation as unavailable, as match does, instead of leaving it for ever', async (step, state, arrange, missing) => {
    const ctx = setup()
    const { scanId, itemId } = await arrange(ctx)
    await ctx.repository.updateItem(itemId, state, { ...missing, updatedAt: ctx.now() })
    const researches = ctx.researcher.calls.length
    const analyses = ctx.analyst.calls.analyse.length

    await expect(run(ctx, itemId, step)).resolves.toBeUndefined()

    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'failed', reason: 'unavailable' })
    expect(ctx.labelReader.calls).toEqual([])
    expect(ctx.researcher.calls).toHaveLength(researches)
    expect(ctx.analyst.calls.analyse).toHaveLength(analyses)
  })
})

describe('ScanService.advance: recognise after a failed attempt', () => {
  it('reuses what the model already said and does not pay for the recogniser again', async () => {
    const ctx = setup()
    const { scanId, itemId } = await scanOne(ctx)
    ctx.jobs.failNextWith(new Error('queue is down'))
    await run(ctx, itemId, 'recognise').catch(() => undefined)
    expect(ctx.recognizer.calls).toHaveLength(1)
    expect((await stateOf(ctx, scanId, itemId)).state).toBe('recognising')
    ctx.advance(SECOND)

    await run(ctx, itemId, 'recognise')

    expect(ctx.recognizer.calls).toHaveLength(1)
    expect(await itemOf(ctx, scanId, itemId)).toMatchObject({ state: 'matching', recognised: { brand: 'CeraVe', name: 'Hydrating Facial Cleanser', category: 'skin' } })
    expect(queued(ctx).at(-1)).toEqual(advanceMessage(itemId, 'match'))
  })

  it('judges the stored confidence again: a doubtful earlier read still waits for the user', async () => {
    const ctx = setup()
    const { scanId, itemId } = await scanOne(ctx)
    await ctx.repository.updateItem(itemId, 'recognising', {
      recognisedBrand: 'Glo Co',
      recognisedName: 'Brite Serum',
      recognisedVariant: 'Night',
      recognisedCategory: 'skin',
      recognisedConfidence: 0.3,
      updatedAt: ctx.now(),
    })

    await run(ctx, itemId, 'recognise')

    expect(ctx.recognizer.calls).toEqual([])
    expect(await itemOf(ctx, scanId, itemId)).toMatchObject({ state: 'needs-confirmation', recognised: { brand: 'Glo Co', name: 'Brite Serum', variant: 'Night' } })
  })

  it('asks the recogniser as usual when nothing was stored', async () => {
    const ctx = setup()
    const { itemId } = await scanOne(ctx)

    await run(ctx, itemId, 'recognise')

    expect(ctx.recognizer.calls).toHaveLength(1)
  })
})

describe('ScanService: the daily quota counts every back photo', () => {
  const addBack = (ctx: Ctx, scanId: string, itemId: string, ip = IP, marker = 9) => asUser(() => ctx.service.addBackPhoto(scanId, itemId, markedJpeg(marker), ip))
  /** A back photo uploaded, read as unreadable, so the item asks again. */
  const sendAndFailToRead = async (ctx: Ctx, scanId: string, itemId: string, ip = IP, marker = 9) => {
    await addBack(ctx, scanId, itemId, ip, marker)
    ctx.labelReader.respondWith(() => ({ readable: false }))
    await run(ctx, itemId, 'read-label')
    ctx.advance(SECOND)
  }

  it('counts three uploads in a row on one item as three photos', async () => {
    const ctx = setup({ policy: { dailyPhotosPerUser: 4, maxBackPhotos: 10 } })
    const { scanId, itemId } = await reach(ctx, 'needs-back-photo')
    // The front photo is one; each of the next two uploads is one more.
    await sendAndFailToRead(ctx, scanId, itemId, IP, 1)
    await sendAndFailToRead(ctx, scanId, itemId, IP, 2)

    // 3 photos so far: a third upload is the 4th and fits, a 5th does not.
    await addBack(ctx, scanId, itemId, IP, 3)
    ctx.labelReader.respondWith(() => ({ readable: false }))
    await run(ctx, itemId, 'read-label')
    const error = await errorOf(addBack(ctx, scanId, itemId, IP, 4))

    expect(error.code).toBe('SCAN_DAILY_LIMIT')
    expect((await stateOf(ctx, scanId, itemId)).state).toBe('needs-back-photo')
  })

  it('counts a back photo for the address it came from, not for the address the scan was made from', async () => {
    const ctx = setup({ policy: { dailyPhotosPerIp: 2 } })
    const { scanId, itemId } = await reach(ctx, 'needs-back-photo')

    await addBack(ctx, scanId, itemId, OTHER_IP)

    // IP has the front photo only, and OTHER_IP has the back photo only: each can take one more, and no more.
    await expect(create(ctx, [markedJpeg(21)], { ip: IP })).resolves.toMatchObject({ items: expect.any(Array) })
    await expect(create(ctx, [markedJpeg(22)], { ip: OTHER_IP })).resolves.toMatchObject({ items: expect.any(Array) })
    expect((await errorOf(create(ctx, [markedJpeg(23)], { ip: OTHER_IP }))).code).toBe('SCAN_DAILY_LIMIT')
    expect((await errorOf(create(ctx, [markedJpeg(24)], { ip: IP }))).code).toBe('SCAN_DAILY_LIMIT')
  })
})

describe('ScanService.advance: exactly one done', () => {
  /** Holds every itemsOf call made after `arm()` until two have arrived, then lets both go: two finishing items then both see the scan as finished. */
  class Rendezvous extends FakeScansRepository {
    private armed = false
    private waiting: (() => void)[] = []
    arm() {
      this.armed = true
    }
    override async itemsOf(scanId: string) {
      if (!this.armed) return super.itemsOf(scanId)
      await new Promise<void>((release) => {
        this.waiting.push(release)
        if (this.waiting.length === 2) this.waiting.forEach((go) => go())
      })
      return super.itemsOf(scanId)
    }
  }

  it('publishes done once when the last two items of a scan finish together', async () => {
    const repository = new Rendezvous()
    const ctx = setup({ repository })
    await catalogued(ctx)
    const scan = await create(ctx, [markedJpeg(1), markedJpeg(2)])
    const [a, b] = scan.items
    await run(ctx, a.id, 'recognise')
    await run(ctx, b.id, 'recognise')
    const events = ctx.events.published.length
    repository.arm()

    await Promise.all([run(ctx, a.id, 'match'), run(ctx, b.id, 'match')])

    const published = ctx.events.published.slice(events).filter((p) => p.scanId === scan.id)
    expect(published.filter((p) => p.event.type === 'done')).toHaveLength(1)
    expect(published.filter((p) => p.event.type === 'item')).toHaveLength(2)
    expect((await ctx.repository.findScan(scan.id))!.doneAt).not.toBeNull()
  })

  it('does not publish done again for a scan already marked done', async () => {
    const ctx = setup()
    ctx.recognizer.respondWith(() => ({ classification: 'face-or-person' }))
    const scan = await create(ctx, [markedJpeg(1)])
    await run(ctx, scan.items[0].id, 'recognise')
    const events = ctx.events.published.length

    await asJob(() => ctx.service.markItemFailed(scan.items[0].id))

    expect(ctx.events.published).toHaveLength(events)
  })
})

describe('ScanService.reap', () => {
  const STALE = 15 * MINUTE + 1
  const reap = (ctx: Ctx) => asJob(() => ctx.service.reap(ctx.now()))

  const WORKING: [string, Step, (ctx: Ctx) => Promise<{ scanId: string; itemId: string }>][] = [
    ['recognising', 'recognise', (ctx) => scanOne(ctx)],
    ['matching', 'match', (ctx) => reach(ctx, 'matching')],
    ['researching', 'research', (ctx) => reach(ctx, 'researching')],
    ['reading-label', 'read-label', (ctx) => reach(ctx, 'reading-label')],
    ['analysing', 'analyse', (ctx) => analysingItem(ctx)],
  ]

  describe.each(WORKING)('an item that has been %s for over 15 minutes', (_state, step, arrange) => {
    it(`queues its ${step} step again, at the time it entered the state, under the key of the message that first queued it`, async () => {
      const ctx = setup()
      const { itemId } = await arrange(ctx)
      const entered = (await ctx.repository.findItem(itemId))!.updatedAt.getTime()
      const first = queuedWithTime(ctx).filter((m) => m.itemId === itemId).at(-1)!
      expect(first.step).toBe(step)
      ctx.advance(STALE)
      const before = ctx.jobs.enqueued.length

      await reap(ctx)

      expect(queuedWithTime(ctx).slice(before)).toEqual([{ itemId, step, at: entered }])
      expect(advanceScanItemSpec.key(queuedWithTime(ctx).at(-1)!)).toBe(advanceScanItemSpec.key(first))
    })

    it('leaves it alone at exactly 15 minutes', async () => {
      const ctx = setup()
      const { scanId, itemId } = await arrange(ctx)
      const stateBefore = await stateOf(ctx, scanId, itemId)
      ctx.advance(15 * MINUTE)
      const before = ctx.jobs.enqueued.length

      await reap(ctx)

      expect(ctx.jobs.enqueued).toHaveLength(before)
      expect(await stateOf(ctx, scanId, itemId)).toEqual(stateBefore)
    })

    it('fails it as unavailable, with an event, once it is over 2 hours old, and queues nothing', async () => {
      const ctx = setup()
      const { scanId, itemId } = await arrange(ctx)
      ctx.advance(2 * HOUR + 1)
      const before = ctx.jobs.enqueued.length
      const events = ctx.events.published.length

      await reap(ctx)

      expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'failed', reason: 'unavailable' })
      expect(ctx.jobs.enqueued).toHaveLength(before)
      expect(ctx.events.published.slice(events).map((p) => p.event)).toContainEqual({ type: 'item', item: await itemOf(ctx, scanId, itemId) })
    })

    it('still queues it again, rather than failing it, at exactly 2 hours', async () => {
      const ctx = setup()
      const { scanId, itemId } = await arrange(ctx)
      ctx.advance(2 * HOUR)
      const before = ctx.jobs.enqueued.length

      await reap(ctx)

      expect(ctx.jobs.enqueued).toHaveLength(before + 1)
      expect((await stateOf(ctx, scanId, itemId)).state).not.toBe('failed')
    })
  })

  it('leaves alone items that wait for the user and items that are finished, however old', async () => {
    const ctx = setup()
    const confirming = await reach(ctx, 'needs-confirmation')
    const photographing = await reach(ctx, 'needs-back-photo')
    ctx.recognizer.respondWith(() => ({ classification: 'face-or-person' }))
    const rejected = await scanOne(ctx, markedJpeg(5))
    await run(ctx, rejected.itemId, 'recognise')
    ctx.advance(3 * HOUR)
    const before = ctx.jobs.enqueued.length
    const states = async () =>
      Promise.all([confirming, photographing, rejected].map(async (x) => (await stateOf(ctx, x.scanId, x.itemId)).state))
    const expected = await states()

    const result = await reap(ctx)

    expect(await states()).toEqual(expected)
    expect(expected).toEqual(['needs-confirmation', 'needs-back-photo', 'rejected'])
    expect(ctx.jobs.enqueued).toHaveLength(before)
    expect(result).toEqual({ requeued: 0, failed: 0 })
  })

  it.each([
    ['needs-retake', (ctx: Ctx) => failedFront(ctx, [BLURRY])],
    ['needs-identification', (ctx: Ctx) => failedFront(ctx, [BLURRY, TURNED_AWAY, BLURRY])],
  ])('leaves an item waiting in %s alone however old: it queues nothing for it, does not fail it and publishes nothing', async (state, arrange) => {
    const ctx = setup()
    const { scanId, itemId } = await arrange(ctx)
    const before = await itemOf(ctx, scanId, itemId)
    const jobs = ctx.jobs.enqueued.length
    const events = ctx.events.published.length
    ctx.advance(3 * HOUR)

    const result = await reap(ctx)

    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state, reason: before.reason })
    expect(ctx.jobs.enqueued).toHaveLength(jobs)
    expect(ctx.events.published).toHaveLength(events)
    expect(result).toEqual({ requeued: 0, failed: 0 })
  })

  it('says how many it queued again and how many it failed', async () => {
    const ctx = setup()
    const old = await reach(ctx, 'researching')
    ctx.advance(2 * HOUR)
    const recent = await scanOne(ctx, markedJpeg(7))
    ctx.advance(20 * MINUTE)

    const result = await reap(ctx)

    expect(result).toEqual({ requeued: 1, failed: 1 })
    expect((await stateOf(ctx, old.scanId, old.itemId)).state).toBe('failed')
    expect((await stateOf(ctx, recent.scanId, recent.itemId)).state).toBe('recognising')
  })

  it('publishes done when failing a stuck item finishes its scan', async () => {
    const ctx = setup()
    const { scanId } = await reach(ctx, 'researching')
    ctx.advance(3 * HOUR)

    await reap(ctx)

    expect(ctx.events.eventsFor(scanId).map((e) => e.type)).toContain('done')
  })

  it('goes on with the other items, logging the ids, when one cannot be queued', async () => {
    const ctx = setup()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const first = await scanOne(ctx, markedJpeg(1))
    const second = await scanOne(ctx, markedJpeg(2))
    ctx.advance(STALE)
    ctx.jobs.failNextWith(new Error('queue is down'))
    const before = ctx.jobs.enqueued.length

    const result = await reap(ctx)

    expect(ctx.jobs.enqueued).toHaveLength(before + 1)
    expect(result).toEqual({ requeued: 1, failed: 0 })
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'reap-failed', itemId: expect.stringMatching(new RegExp(`${first.itemId}|${second.itemId}`)) }))
    logged.mockRestore()
  })

  it('needs no signed-in user: it runs as a job', async () => {
    const ctx = setup()
    await scanOne(ctx)
    ctx.advance(STALE)

    await expect(asJob(() => ctx.service.reap(ctx.now()))).resolves.toEqual({ requeued: 1, failed: 0 })
  })
})

describe('ScanService.watch', () => {
  const watch = (ctx: Ctx, scanId: string, userId = USER) => asUser(() => ctx.service.watch(scanId), userId)

  it('opens the stream with the scan as it now is, and answers the stream', async () => {
    const ctx = setup()
    const scan = await create(ctx, [markedJpeg(1), markedJpeg(2)])
    ctx.advance(MINUTE)

    const response = await watch(ctx, scan.id)

    expect(ctx.events.subscribed).toHaveLength(1)
    expect(ctx.events.subscribed[0]!.scanId).toBe(scan.id)
    expect(ctx.events.subscribed[0]!.snapshot).toMatchObject({ id: scan.id, createdAt: T0, items: [{ id: scan.items[0].id, state: 'recognising' }, { id: scan.items[1].id }] })
    expect(response.headers.get('Content-Type')).toContain('text/event-stream')
  })

  it('makes the snapshot, once it is JSON, exactly the scan the routes present, including a ready item with its product', async () => {
    const ctx = setup()
    await catalogued(ctx, CERAVE, { imageUrl: IMAGE_URL })
    const scan = await create(ctx)
    await run(ctx, scan.items[0].id, 'recognise')
    await run(ctx, scan.items[0].id, 'match')
    const shown = await asUser(() => ctx.service.getScan(scan.id))
    expect(shown.items[0]!.state).toBe('ready')

    await watch(ctx, scan.id)

    expect(JSON.parse(JSON.stringify(ctx.events.subscribed[0]!.snapshot))).toEqual(JSON.parse(JSON.stringify(toScanResponse(shown))))
  })

  it('publishes each item exactly as the routes present it, once it is JSON', async () => {
    const ctx = setup()
    await catalogued(ctx, CERAVE, { imageUrl: IMAGE_URL })
    const scan = await create(ctx)
    await run(ctx, scan.items[0].id, 'recognise')
    await run(ctx, scan.items[0].id, 'match')
    const shown = await asUser(() => ctx.service.getScan(scan.id))

    const published = ctx.events.eventsFor(scan.id).filter((e) => e.type === 'item').at(-1)!

    expect(JSON.parse(JSON.stringify(published.type === 'item' ? published.item : null))).toEqual(JSON.parse(JSON.stringify(toScanResponse(shown).items[0])))
  })

  it.each([
    ['another user', OTHER_USER, undefined],
    ['nobody (an unknown scan)', USER, 'no-such-scan'],
  ])('answers SCAN_NOT_FOUND to %s, and opens no stream', async (_label, userId, scanId) => {
    const ctx = setup()
    const scan = await create(ctx)

    const error = await errorOf(watch(ctx, scanId ?? scan.id, userId))

    expect(error).toBeInstanceOf(NotFoundError)
    expect(error.code).toBe('SCAN_NOT_FOUND')
    expect(ctx.events.subscribed).toEqual([])
  })

  it('answers AUTH_REQUIRED to a public caller', async () => {
    const ctx = setup()
    const scan = await create(ctx)

    const error = await errorOf(runAs({ kind: 'public' }, () => ctx.service.watch(scan.id)))

    expect(error.code).toBe('AUTH_REQUIRED')
  })

  it('sends nothing more while any item is still being worked on or waiting for the user', async () => {
    const ctx = setup()
    ctx.recognizer.respondWith((image) => (image.bytes.at(-1) === 1 ? { classification: 'face-or-person' } : seen({ confidence: 0.2 })))
    const scan = await create(ctx, [markedJpeg(1), markedJpeg(2)])
    await run(ctx, scan.items[0].id, 'recognise')
    await run(ctx, scan.items[1].id, 'recognise')
    const before = ctx.events.published.length

    await watch(ctx, scan.id)

    expect(ctx.events.published).toHaveLength(before)
  })

  it('sends nothing more to a client that connects while an item waits for a retake or for identification: those are not final', async () => {
    const ctx = setup()
    const asking = await failedFront(ctx, [BLURRY])
    const identifying = await failedFront(ctx, [BLURRY, TURNED_AWAY, BLURRY])
    const before = ctx.events.published.length

    await watch(ctx, asking.scanId)
    await watch(ctx, identifying.scanId)

    expect(ctx.events.published).toHaveLength(before)
    expect(ctx.events.subscribed).toHaveLength(2)
  })

  it('follows the snapshot with done when every item is already final, whether ready, rejected or failed', async () => {
    const ctx = setup()
    ctx.recognizer.respondWith((image) => (image.bytes.at(-1) === 1 ? { classification: 'face-or-person' } : seen()))
    const scan = await create(ctx, [markedJpeg(1), markedJpeg(2)])
    await run(ctx, scan.items[0].id, 'recognise')
    await run(ctx, scan.items[1].id, 'recognise')
    ctx.advance(HOUR)
    await asJob(() => ctx.service.markItemFailed(scan.items[1].id))
    const before = ctx.events.published.length

    await watch(ctx, scan.id)

    expect(ctx.events.subscribed).toHaveLength(1)
    expect(ctx.events.published.slice(before)).toEqual([{ scanId: scan.id, event: { type: 'done' } }])
  })

  it('still answers the stream, and logs, when done cannot be published', async () => {
    class DoneFails extends MemoryScanEvents {
      failing = false
      override async publish(scanId: string, event: Parameters<MemoryScanEvents['publish']>[1]): Promise<void> {
        if (this.failing) throw new Error('stream is down')
        return super.publish(scanId, event)
      }
    }
    let events!: DoneFails
    const ctx = setup({ events: () => (events = new DoneFails()) })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    ctx.recognizer.respondWith(() => ({ classification: 'face-or-person' }))
    const scan = await create(ctx)
    await run(ctx, scan.items[0].id, 'recognise')
    events.failing = true

    const response = await watch(ctx, scan.id)

    expect(response.headers.get('Content-Type')).toContain('text/event-stream')
    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'publish-failed', scanId: scan.id }))
    logged.mockRestore()
  })

  describe('a change stored while the stream is opening', () => {
    /**
     * Behaves like the Durable Object around a connecting client: what is published before `subscribe` returns reaches no
     * one, so it is not recorded. `meanwhile` runs at that moment, between the service's read of the scan and the stream
     * being open.
     */
    class RacyEvents extends MemoryScanEvents {
      meanwhile: (() => Promise<void>) | undefined
      failWhen: ((event: Parameters<MemoryScanEvents['publish']>[1]) => boolean) | undefined
      private connecting = false
      override async publish(scanId: string, event: Parameters<MemoryScanEvents['publish']>[1]): Promise<void> {
        if (this.connecting) return
        if (this.failWhen?.(event)) throw new Error('stream is down')
        return super.publish(scanId, event)
      }
      override async subscribe(scanId: string, snapshot: Parameters<MemoryScanEvents['subscribe']>[1]): Promise<Response> {
        this.connecting = true
        try {
          await this.meanwhile?.()
        } finally {
          this.connecting = false
        }
        return super.subscribe(scanId, snapshot)
      }
    }
    const racy = (photos = [markedJpeg(1)]) => {
      let events!: RacyEvents
      const ctx = setup({ events: () => (events = new RacyEvents()) })
      ctx.recognizer.respondWith((image) => (image.bytes.at(-1) === 1 ? { classification: 'face-or-person' } : seen({ confidence: 0.2 })))
      return { ctx, events, scan: create(ctx, photos) }
    }
    const finishDirectly = (ctx: Ctx, itemId: string) =>
      ctx.repository.updateItem(itemId, 'recognising', { state: 'failed', reason: 'unavailable', updatedAt: ctx.now() }).then(() => undefined)

    it('sends the final item and done, though the step published both before anyone was listening', async () => {
      const { ctx, events, scan: pending } = racy()
      const scan = await pending
      events.meanwhile = () => run(ctx, scan.items[0].id, 'recognise')

      await watch(ctx, scan.id)

      expect((await ctx.repository.findScan(scan.id))!.doneAt).not.toBeNull()
      expect(ctx.events.eventsFor(scan.id)).toMatchObject([{ type: 'item', item: { id: scan.items[0].id, state: 'rejected', reason: 'face-or-person' } }, { type: 'done' }])
    })

    it('sends the changed item, and no done, while another item is still being worked on', async () => {
      const { ctx, events, scan: pending } = racy([markedJpeg(1), markedJpeg(2)])
      const scan = await pending
      events.meanwhile = () => run(ctx, scan.items[0].id, 'recognise')

      await watch(ctx, scan.id)

      expect(ctx.events.eventsFor(scan.id)).toMatchObject([{ type: 'item', item: { id: scan.items[0].id, state: 'rejected' } }])
      expect((await ctx.repository.findScan(scan.id))!.doneAt).toBeNull()
    })

    it('sends an item whose time changed though its state did not, and only that one', async () => {
      const { ctx, events, scan: pending } = racy([markedJpeg(1), markedJpeg(2)])
      const scan = await pending
      events.meanwhile = async () => {
        ctx.advance(MINUTE)
        await ctx.repository.updateItem(scan.items[1].id, 'recognising', { state: 'recognising', updatedAt: ctx.now() })
      }

      await watch(ctx, scan.id)

      expect(ctx.events.eventsFor(scan.id)).toMatchObject([{ type: 'item', item: { id: scan.items[1].id, state: 'recognising' } }])
    })

    it('marks the scan done and sends done when the last item went final without the scan being marked', async () => {
      const { ctx, events, scan: pending } = racy()
      const scan = await pending
      events.meanwhile = () => finishDirectly(ctx, scan.items[0].id)

      await watch(ctx, scan.id)

      expect(ctx.events.eventsFor(scan.id)).toMatchObject([{ type: 'item', item: { id: scan.items[0].id, state: 'failed' } }, { type: 'done' }])
      expect((await ctx.repository.findScan(scan.id))!.doneAt).toEqual(ctx.now())
    })

    it('sends an item exactly as the snapshot would have shown it', async () => {
      const { ctx, events, scan: pending } = racy()
      const scan = await pending
      events.meanwhile = () => run(ctx, scan.items[0].id, 'recognise')

      await watch(ctx, scan.id)

      const shown = await getScan(ctx, scan.id)
      const sent = ctx.events.eventsFor(scan.id)[0]!
      expect(JSON.parse(JSON.stringify(sent.type === 'item' ? sent.item : null))).toEqual(JSON.parse(JSON.stringify(toScanResponse(shown).items[0])))
    })

    it('still answers the stream, logging ids only, when a catch-up item cannot be published, and goes on to done', async () => {
      const { ctx, events, scan: pending } = racy()
      const scan = await pending
      const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      events.meanwhile = async () => {
        await finishDirectly(ctx, scan.items[0].id)
        events.failWhen = (event) => event.type === 'item'
      }

      const response = await watch(ctx, scan.id)

      expect(response.headers.get('Content-Type')).toContain('text/event-stream')
      expect(logged).toHaveBeenCalledWith({ outcome: 'publish-failed', scanId: scan.id, itemId: scan.items[0].id })
      expect(ctx.events.eventsFor(scan.id)).toEqual([{ type: 'done' }])
      logged.mockRestore()
    })

    it('puts the done time back when the done it set could not be published, so the reaper sends it', async () => {
      const { ctx, events, scan: pending } = racy()
      const scan = await pending
      const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      events.meanwhile = async () => {
        await finishDirectly(ctx, scan.items[0].id)
        events.failWhen = (event) => event.type === 'done'
      }

      const response = await watch(ctx, scan.id)

      expect(response.headers.get('Content-Type')).toContain('text/event-stream')
      expect(logged).toHaveBeenCalledWith({ outcome: 'publish-failed', scanId: scan.id })
      expect((await ctx.repository.findScan(scan.id))!.doneAt).toBeNull()
      logged.mockRestore()
    })

    it('leaves the done time alone when done cannot be published for a scan that was marked before', async () => {
      const { ctx, events, scan: pending } = racy()
      const scan = await pending
      const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      events.meanwhile = async () => {
        await run(ctx, scan.items[0].id, 'recognise')
        events.failWhen = (event) => event.type === 'done'
      }
      const marked = ctx.now()

      await watch(ctx, scan.id)

      expect((await ctx.repository.findScan(scan.id))!.doneAt).toEqual(marked)
      logged.mockRestore()
    })
  })

  it('lets a failure to open the stream reach the caller', async () => {
    class SubscribeFails extends MemoryScanEvents {
      override async subscribe(): Promise<Response> {
        throw new Error('durable object unavailable')
      }
    }
    const ctx = setup({ events: () => new SubscribeFails() })
    const scan = await create(ctx)

    await expect(watch(ctx, scan.id)).rejects.toThrow('durable object unavailable')
  })
})

describe('ScanService.reap: a done that was lost', () => {
  const SETTLED = 5 * MINUTE
  /** Fails to publish while `failing`, the way a Durable Object that is down does. */
  class FlakyEvents extends MemoryScanEvents {
    failing = false
    override async publish(scanId: string, event: Parameters<MemoryScanEvents['publish']>[1]): Promise<void> {
      if (this.failing) throw new Error('stream is down')
      return super.publish(scanId, event)
    }
  }
  const reap = (ctx: Ctx) => asJob(() => ctx.service.reap(ctx.now()))
  const types = (ctx: Ctx, scanId: string) => ctx.events.eventsFor(scanId).map((e) => e.type)

  /** A one-photo scan whose only item was rejected while publishing was down, so its done was never sent. */
  const withLostDone = async (over: { photos?: ProductImage[] } = {}) => {
    let events!: FlakyEvents
    const ctx = setup({ events: () => (events = new FlakyEvents()) })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    ctx.recognizer.respondWith(() => ({ classification: 'face-or-person' }))
    const scan = await create(ctx, over.photos ?? [markedJpeg(1)])
    events.failing = true
    for (const item of scan.items) await run(ctx, item.id, 'recognise')
    events.failing = false
    logged.mockRestore()
    return { ctx, scanId: scan.id as string }
  }

  it('marks the scan done and sends done once its items have all been final for over 5 minutes', async () => {
    const { ctx, scanId } = await withLostDone()
    expect((await ctx.repository.findScan(scanId))!.doneAt).toBeNull()
    ctx.advance(SETTLED + 1)

    const result = await reap(ctx)

    expect(types(ctx, scanId)).toEqual(['done'])
    expect((await ctx.repository.findScan(scanId))!.doneAt).toEqual(ctx.now())
    expect(result).toEqual({ requeued: 0, failed: 0 })
  })

  it('leaves it alone before then, so it never races a publish still on its way', async () => {
    const { ctx, scanId } = await withLostDone()
    ctx.advance(SETTLED)

    await reap(ctx)

    expect(types(ctx, scanId)).toEqual([])
    expect((await ctx.repository.findScan(scanId))!.doneAt).toBeNull()
  })

  it('sends it once, however many sweeps follow', async () => {
    const { ctx, scanId } = await withLostDone()
    ctx.advance(SETTLED + 1)

    await reap(ctx)
    await reap(ctx)

    expect(types(ctx, scanId)).toEqual(['done'])
  })

  it('does nothing for a scan that already had its done, or that still has an item to wait for', async () => {
    const ctx = setup()
    ctx.recognizer.respondWith((image) => (image.bytes.at(-1) === 1 ? { classification: 'face-or-person' } : seen({ confidence: 0.2 })))
    const finished = await create(ctx, [markedJpeg(1)])
    await run(ctx, finished.items[0].id, 'recognise')
    const waiting = await create(ctx, [markedJpeg(1), markedJpeg(2)])
    await run(ctx, waiting.items[0].id, 'recognise')
    await run(ctx, waiting.items[1].id, 'recognise')
    ctx.advance(HOUR)
    const before = ctx.events.published.length

    await reap(ctx)

    expect(ctx.events.published).toHaveLength(before)
  })

  it('goes on to the next scan, logging the id, when one cannot be sent', async () => {
    const { ctx, scanId } = await withLostDone({ photos: [markedJpeg(1)] })
    const events = ctx.events as FlakyEvents
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    ctx.advance(SETTLED + 1)
    events.failing = true

    await expect(reap(ctx)).resolves.toEqual({ requeued: 0, failed: 0 })

    expect(logged).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'reap-done-failed', scanId }))
    logged.mockRestore()
  })
})

describe('ScanService: a done that cannot be published stays repairable', () => {
  const SETTLED = 5 * MINUTE
  /** Fails to publish a `done` while `failing`; items go through. */
  class DoneFlaky extends MemoryScanEvents {
    failing = false
    override async publish(scanId: string, event: Parameters<MemoryScanEvents['publish']>[1]): Promise<void> {
      if (this.failing && event.type === 'done') throw new Error('stream is down')
      return super.publish(scanId, event)
    }
  }
  const reap = (ctx: Ctx) => asJob(() => ctx.service.reap(ctx.now()))
  const types = (ctx: Ctx, scanId: string) => ctx.events.eventsFor(scanId).map((e) => e.type)

  const arrange = async () => {
    let events!: DoneFlaky
    const ctx = setup({ events: () => (events = new DoneFlaky()) })
    ctx.recognizer.respondWith(() => ({ classification: 'face-or-person' }))
    const scan = await create(ctx)
    return { ctx, events, scan }
  }

  it('clears the done time again when the step\'s done fails, logging ids only, and the reaper then sends it', async () => {
    const { ctx, events, scan } = await arrange()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    events.failing = true

    await run(ctx, scan.items[0].id, 'recognise')

    expect((await ctx.repository.findScan(scan.id))!.doneAt).toBeNull()
    expect(logged).toHaveBeenCalledWith({ outcome: 'publish-failed', scanId: scan.id, itemId: scan.items[0].id })
    events.failing = false
    ctx.advance(SETTLED + 1)
    await reap(ctx)
    expect(types(ctx, scan.id)).toEqual(['item', 'done'])
    expect((await ctx.repository.findScan(scan.id))!.doneAt).toEqual(ctx.now())
    logged.mockRestore()
  })

  it('clears the done time again when the reaper\'s done fails, logging ids only, and the next sweep sends it', async () => {
    const { ctx, events, scan } = await arrange()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    events.failing = true
    await run(ctx, scan.items[0].id, 'recognise')
    ctx.advance(SETTLED + 1)

    await reap(ctx)

    expect((await ctx.repository.findScan(scan.id))!.doneAt).toBeNull()
    expect(logged).toHaveBeenCalledWith({ outcome: 'reap-done-failed', scanId: scan.id })
    events.failing = false
    await reap(ctx)
    expect(types(ctx, scan.id)).toEqual(['item', 'done'])
    expect((await ctx.repository.findScan(scan.id))!.doneAt).not.toBeNull()
    logged.mockRestore()
  })

  it('does not clear a done time somebody else set meanwhile', async () => {
    const { ctx, events, scan } = await arrange()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const other = new Date(T0.getTime() + HOUR)
    // The failing publish is where a competing writer slips in: the scan is marked again, at another time.
    const publishItem = events.publish.bind(events)
    events.publish = async (scanId, event) => {
      if (event.type !== 'done') return publishItem(scanId, event)
      await ctx.repository.clearScanDone(scan.id, (await ctx.repository.findScan(scan.id))!.doneAt!)
      await ctx.repository.markScanDone(scan.id, other)
      throw new Error('stream is down')
    }

    await run(ctx, scan.items[0].id, 'recognise')

    expect((await ctx.repository.findScan(scan.id))!.doneAt).toEqual(other)
    logged.mockRestore()
  })
})

describe('ScanService.reap: how far back it repairs a done', () => {
  const reap = (ctx: Ctx) => asJob(() => ctx.service.reap(ctx.now()))

  const lostDone = async () => {
    const ctx = setup()
    ctx.recognizer.respondWith(() => ({ classification: 'face-or-person' }))
    const scan = await create(ctx)
    await run(ctx, scan.items[0].id, 'recognise')
    // The step's done is taken back, as if it had been lost.
    await ctx.repository.clearScanDone(scan.id, (await ctx.repository.findScan(scan.id))!.doneAt!)
    return { ctx, scanId: scan.id as string }
  }

  it('sends the done of a scan made up to 3 hours ago', async () => {
    const { ctx, scanId } = await lostDone()
    ctx.advance(3 * HOUR)

    await reap(ctx)

    expect((await ctx.repository.findScan(scanId))!.doneAt).not.toBeNull()
  })

  it('leaves a scan made over 3 hours ago alone: a client that connects later is sent done by watch', async () => {
    const { ctx, scanId } = await lostDone()
    ctx.advance(3 * HOUR + 1)
    const sent = ctx.events.eventsFor(scanId).length

    await reap(ctx)

    expect((await ctx.repository.findScan(scanId))!.doneAt).toBeNull()
    expect(ctx.events.eventsFor(scanId)).toHaveLength(sent)
  })
})

describe('ScanService.reap: scans the old Worker left without a profile', () => {
  const reap = (ctx: Ctx) => asJob(() => ctx.service.reap(ctx.now()))

  /** A repository that reads defaults from `profiles`, and one scan with no profile, as the old Worker wrote it during the rollout window. */
  const withOrphan = async (owner = USER) => {
    const profiles = new FakeProfilesRepository()
    const ctx = setup({ repository: new FakeScansRepository({ profiles }) })
    const scanId = 'orphan-scan'
    await ctx.repository.createScan(
      { id: scanId, kind: 'product', userId: owner, profileId: null as unknown as string, ipHash: 'ip', createdAt: ctx.now() },
      [{ id: 'orphan-photo', scanId, userId: owner, position: 0, photoKey: null, createdAt: ctx.now() }],
      [{ id: 'orphan-item', scanId, userId: owner, position: 0, photoId: 'orphan-photo', photoKey: 'photos/test/orphan.jpg', createdAt: ctx.now() }],
    )
    return { ctx, profiles, scanId }
  }
  const giveDefault = (profiles: FakeProfilesRepository, userId = USER) =>
    profiles.insert({ id: PROFILE, userId, displayName: null, isDefault: true, createdAt: T0 })

  it('gives such a scan its owner\'s default profile, and says how many in the log', async () => {
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { ctx, profiles, scanId } = await withOrphan()
    await giveDefault(profiles)

    await reap(ctx)

    expect((await ctx.repository.findScan(scanId))!.profileId).toBe(PROFILE)
    expect(logged).toHaveBeenCalledWith({ outcome: 'orphan-scans-adopted', count: 1 })
    logged.mockRestore()
  })

  it('leaves it as it is while the owner has no default profile, without logging', async () => {
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { ctx, scanId } = await withOrphan()

    await reap(ctx)

    expect((await ctx.repository.findScan(scanId))!.profileId).toBeNull()
    expect(logged).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'orphan-scans-adopted' }))
    logged.mockRestore()
  })

  it('adopts it on a later sweep, once the owner has a default profile', async () => {
    const { ctx, profiles, scanId } = await withOrphan()
    await reap(ctx)

    await giveDefault(profiles)
    await reap(ctx)

    expect((await ctx.repository.findScan(scanId))!.profileId).toBe(PROFILE)
  })

  it('asks for at most 500 scans a sweep', async () => {
    const { ctx } = await withOrphan()
    const adopt = vi.spyOn(ctx.repository, 'adoptOrphanScans')

    await reap(ctx)

    expect(adopt).toHaveBeenCalledWith(500)
  })

  it('logs a failure without ids and goes on with the rest of the sweep, whose answer is unchanged', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const ctx = setup()
    await scanOne(ctx)
    ctx.advance(15 * MINUTE + 1)
    vi.spyOn(ctx.repository, 'adoptOrphanScans').mockRejectedValue(new Error('D1 is down'))
    const before = ctx.jobs.enqueued.length

    await expect(reap(ctx)).resolves.toEqual({ requeued: 1, failed: 0 })

    expect(ctx.jobs.enqueued).toHaveLength(before + 1)
    expect(logged).toHaveBeenCalledWith({ outcome: 'orphan-adopt-failed', error: 'Error' })
    logged.mockRestore()
  })
})

describe('ScanService: a scan belongs to the profile that made it', () => {
  const photosOf = (count: number) => Array.from({ length: count }, (_, i) => markedJpeg(i))

  it('is stored with the profile of the caller who made it', async () => {
    const ctx = setup()

    const mine = await create(ctx)
    const theirs = await create(ctx, [markedJpeg(2)], { profileId: OTHER_PROFILE })

    // No view shows the profile, so this reads the stored scan.
    expect((await ctx.repository.findScan(mine.id))!.profileId).toBe(PROFILE)
    expect((await ctx.repository.findScan(theirs.id))!.profileId).toBe(OTHER_PROFILE)
  })

  it('shows each profile its own scan, and the account\'s other profile nothing of it', async () => {
    const ctx = setup()
    const mine = await create(ctx)
    const theirs = await create(ctx, [markedJpeg(2)], { profileId: OTHER_PROFILE })

    expect((await getScan(ctx, mine.id, USER, PROFILE)).id).toBe(mine.id)
    expect((await getScan(ctx, theirs.id, USER, OTHER_PROFILE)).id).toBe(theirs.id)
    expect((await errorOf(getScan(ctx, mine.id, USER, OTHER_PROFILE))).code).toBe('SCAN_NOT_FOUND')
    expect((await errorOf(getScan(ctx, theirs.id, USER, PROFILE))).code).toBe('SCAN_NOT_FOUND')
  })

  it('answers getScan with SCAN_NOT_FOUND, with no photo link, to another profile of the same user', async () => {
    const ctx = setup()
    const scan = await create(ctx)

    const error = await errorOf(getScan(ctx, scan.id, USER, OTHER_PROFILE))

    expect(error).toBeInstanceOf(NotFoundError)
    expect(error.code).toBe('SCAN_NOT_FOUND')
  })

  it('answers watch with SCAN_NOT_FOUND to another profile of the same user, opening no stream', async () => {
    const ctx = setup()
    const scan = await create(ctx)

    const error = await errorOf(asUser(() => ctx.service.watch(scan.id), USER, OTHER_PROFILE))

    expect(error).toBeInstanceOf(NotFoundError)
    expect(error.code).toBe('SCAN_NOT_FOUND')
    expect(ctx.events.subscribed).toHaveLength(0)
  })

  it('answers confirm with SCAN_NOT_FOUND to another profile of the same user, changing and queueing nothing', async () => {
    const ctx = setup()
    const { scanId, itemId } = await reach(ctx, 'needs-confirmation')
    const jobs = ctx.jobs.enqueued.length

    const error = await errorOf(
      asUser(() => ctx.service.confirm(scanId, itemId, { brand: 'Glow Co', name: 'Bright Tone Serum', category: 'skin' }), USER, OTHER_PROFILE),
    )

    expect(error).toBeInstanceOf(NotFoundError)
    expect(error.code).toBe('SCAN_NOT_FOUND')
    expect((await stateOf(ctx, scanId, itemId)).state).toBe('needs-confirmation')
    expect(ctx.jobs.enqueued).toHaveLength(jobs)
  })

  it('answers addBackPhoto with SCAN_NOT_FOUND to another profile of the same user, storing nothing', async () => {
    const ctx = setup()
    const { scanId, itemId } = await reach(ctx, 'needs-back-photo')
    const stored = ctx.photos.stored.size
    const jobs = ctx.jobs.enqueued.length

    const error = await errorOf(asUser(() => ctx.service.addBackPhoto(scanId, itemId, markedJpeg(9), IP), USER, OTHER_PROFILE))

    expect(error).toBeInstanceOf(NotFoundError)
    expect(error.code).toBe('SCAN_NOT_FOUND')
    expect((await stateOf(ctx, scanId, itemId)).state).toBe('needs-back-photo')
    expect(ctx.photos.stored.size).toBe(stored)
    expect(ctx.jobs.enqueued).toHaveLength(jobs)
  })

  it('counts the daily photo quota across the account\'s profiles: 29 taken by two profiles, then 2 more is too many but 1 more is fine', async () => {
    const ctx = setup()
    await create(ctx, photosOf(10), { ip: '192.0.2.1', profileId: PROFILE })
    await create(ctx, photosOf(10), { ip: '192.0.2.2', profileId: OTHER_PROFILE })
    await create(ctx, photosOf(9), { ip: '192.0.2.3', profileId: PROFILE })

    const tooMany = await errorOf(create(ctx, photosOf(2), { profileId: OTHER_PROFILE }))
    expect(tooMany).toBeInstanceOf(RateLimitedError)
    expect(tooMany.code).toBe('SCAN_DAILY_LIMIT')

    await expect(create(ctx, photosOf(1), { profileId: OTHER_PROFILE })).resolves.toMatchObject({ items: expect.any(Array) })
    expect((await errorOf(create(ctx, photosOf(1), { profileId: PROFILE }))).code).toBe('SCAN_DAILY_LIMIT')
  })
})

// ---------------------------------------------------------------------------------------------------------------------
// A back photo that identifies the product (an item that had no product at all)
// ---------------------------------------------------------------------------------------------------------------------

/** The regulation URL the seed reference data attaches to a banned substance: the one source an analysis of WITH_MERCURY may cite. */
const EUR_LEX = 'https://eur-lex.europa.eu/eli/reg/2009/1223/oj'
const MERCURY_CONCERN: DraftConcern = {
  kind: 'banned-substance',
  severity: 'high',
  ingredients: ['Mercury'],
  why: 'Mercury is prohibited in cosmetics and is a known poisoning risk.',
  whoShouldTakeCare: 'Everyone, and especially anyone pregnant.',
  traits: ['sensitive'],
  sources: [EUR_LEX],
}
/** The identity key of the product that holds a list nobody named. */
const CLEAN_UNNAMED_KEY = 'unnamed:aqua\nglycerin\ncetearyl alcohol'
const MERCURY_UNNAMED_KEY = 'unnamed:aqua\nmercury\nglycerin'

const GLOW = { brand: 'Glow Co', name: 'Bright Tone Serum', category: 'skin' } as const
/** A back label that prints a brand and a name beside its list. */
const readNamed = (ingredients: string[] = CLEAN, over: Partial<Extract<LabelReading, { readable: true }>> = {}): LabelReading => ({
  readable: true,
  ingredients,
  ...GLOW,
  ...over,
})
/** A back label that prints only the list. */
const readList = (ingredients: string[] = CLEAN): LabelReading => ({ readable: true, ingredients })

/** An item with no product, after three unreadable front photos: it offers identification. */
const identifying = (ctx: Ctx) => failedFront(ctx, [BLURRY, BLURRY, BLURRY])
const sendBack = (ctx: Ctx, scanId: string, itemId: string, marker = 9) => asUser(() => ctx.service.addBackPhoto(scanId, itemId, markedJpeg(marker), IP))
/** An item with no product whose back photo has just been uploaded, waiting for its label to be read. */
const readingUnidentified = async (ctx: Ctx, marker = 9) => {
  const taken = await identifying(ctx)
  ctx.advance(SECOND)
  await sendBack(ctx, taken.scanId, taken.itemId, marker)
  return taken
}
const sendBackOf = (ctx: Ctx, scanId: string, itemId: string, photo: ProductImage) => asUser(() => ctx.service.addBackPhoto(scanId, itemId, photo, IP))
const analyseSteps = (ctx: Ctx, itemId: string) => queued(ctx).filter((m) => m.itemId === itemId && m.step === 'analyse')

describe('ScanService.addBackPhoto: an item offering identification', () => {
  it('takes a back photo from needs-identification: keeps it privately next to the front one, moves the item to reading-label and enqueues the read', async () => {
    const ctx = setup()
    const { scanId, itemId } = await identifying(ctx)
    const photo = webpPhoto()

    const view = await sendBackOf(ctx, scanId, itemId, photo)

    expect(view).toMatchObject({ id: itemId, state: 'reading-label', reason: null })
    expect((await stateOf(ctx, scanId, itemId)).state).toBe('reading-label')
    expect(ctx.photos.stored.get(backKey(scanId, itemId, 'webp'))).toEqual(photo)
    expect(queued(ctx).at(-1)).toEqual(advanceMessage(itemId, 'read-label'))
    expect(await ctx.repository.countBackPhotos(itemId)).toBe(1)
  })

  it.each([
    ['needs-retake', (ctx: Ctx) => failedFront(ctx, [BLURRY])],
    ['needs-confirmation', (ctx: Ctx) => reach(ctx, 'needs-confirmation')],
    ['matching', (ctx: Ctx) => reach(ctx, 'matching')],
  ])('still refuses an item that is %s with ITEM_NOT_AWAITING_BACK_PHOTO, storing nothing new', async (state, arrange) => {
    const ctx = setup()
    const { scanId, itemId } = await arrange(ctx)
    const stored = ctx.photos.stored.size
    const jobs = ctx.jobs.enqueued.length

    const error = await errorOf(sendBack(ctx, scanId, itemId, 77))

    expect(error).toBeInstanceOf(ConflictError)
    expect(error.code).toBe('ITEM_NOT_AWAITING_BACK_PHOTO')
    expect((await stateOf(ctx, scanId, itemId)).state).toBe(state)
    expect(ctx.photos.stored.size).toBe(stored)
    expect(ctx.jobs.enqueued).toHaveLength(jobs)
  })

  it('refuses a second back photo while the first is being read, as ITEM_NOT_AWAITING_BACK_PHOTO', async () => {
    const ctx = setup()
    const { scanId, itemId } = await readingUnidentified(ctx)

    const error = await errorOf(sendBack(ctx, scanId, itemId, 78))

    expect(error.code).toBe('ITEM_NOT_AWAITING_BACK_PHOTO')
    expect(await ctx.repository.countBackPhotos(itemId)).toBe(1)
  })

  it('refuses a back photo of a PNG under the same rules as any photo, leaving the item offering identification', async () => {
    const ctx = setup()
    const { scanId, itemId } = await identifying(ctx)

    const error = await errorOf(sendBackOf(ctx, scanId, itemId, pngPhoto()))

    expect(error).toBeInstanceOf(ValidationError)
    expect(error.code).toBe('UNSUPPORTED_IMAGE')
    expect((await stateOf(ctx, scanId, itemId)).state).toBe('needs-identification')
  })
})

describe('ScanService.advance: read-label, an item with no product, whose back names the product', () => {
  it('creates the product the label names, with no research, and takes the item to analysing with the analysis queued', async () => {
    const ctx = setup()
    const { scanId, itemId } = await readingUnidentified(ctx)
    ctx.labelReader.respondWith(() => readNamed(CLEAN, { variant: 'Night' }))

    await run(ctx, itemId, 'read-label')

    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'analysing', reason: null })
    expect(queued(ctx).at(-1)).toEqual(advanceMessage(itemId, 'analyse'))
    expect(ctx.researcher.calls).toEqual([])
    const stored = (await ctx.repository.findItem(itemId))!
    expect(await ctx.catalogRepository.findProductByKey('glow co|bright tone serum|night|')).toMatchObject({ id: stored.productId, kind: 'named', brand: 'Glow Co', category: 'skin' })
    expect(await ctx.catalogRepository.findFormulation(stored.formulationId!)).toMatchObject({ productId: stored.productId, ingredients: CLEAN, sourceKind: 'label' })
  })

  it('shows the label\'s brand, name, variant and category as what the item was recognised as', async () => {
    const ctx = setup()
    const { scanId, itemId } = await readingUnidentified(ctx)
    ctx.labelReader.respondWith(() => readNamed(CLEAN, { variant: 'Night', category: 'hair' }))

    await run(ctx, itemId, 'read-label')

    expect(await itemOf(ctx, scanId, itemId)).toMatchObject({ recognised: { brand: 'Glow Co', name: 'Bright Tone Serum', variant: 'Night', category: 'hair' } })
  })

  it('shows a null variant, not a missing one, when the label printed none', async () => {
    const ctx = setup()
    const { scanId, itemId } = await readingUnidentified(ctx)
    ctx.labelReader.respondWith(() => readNamed())

    await run(ctx, itemId, 'read-label')

    expect((await itemOf(ctx, scanId, itemId)).recognised).toEqual({ brand: 'Glow Co', name: 'Bright Tone Serum', variant: null, form: null, category: 'skin' })
  })

  it('gives the label reader the back photo that was uploaded, and deletes it once its label is read', async () => {
    const ctx = setup()
    const { scanId, itemId } = await readingUnidentified(ctx, 31)
    ctx.labelReader.respondWith(() => readNamed())

    await run(ctx, itemId, 'read-label')

    expect(ctx.labelReader.calls).toEqual([markedJpeg(31)])
    expect(ctx.photos.stored.has(backKey(scanId, itemId))).toBe(false)
    expect((await ctx.repository.findItem(itemId))!.backPhotoKey).toBeNull()
  })

  it('makes the item ready, once analysed, with the new product named and its list from the label', async () => {
    const ctx = setup()
    const { scanId, itemId } = await readingUnidentified(ctx)
    ctx.labelReader.respondWith(() => readNamed())
    await run(ctx, itemId, 'read-label')

    await run(ctx, itemId, 'analyse')

    const item = await itemOf(ctx, scanId, itemId)
    expect(item.state).toBe('ready')
    expect(item.product).toMatchObject({ kind: 'named', brand: 'Glow Co', name: 'Bright Tone Serum', category: 'skin' })
    expect(item.product).not.toHaveProperty('formulation')
    expect((await formulationViewOf(ctx, itemId)).formulation).toMatchObject({ ingredients: CLEAN, source: { kind: 'label', url: null } })
    expect(ctx.researcher.calls).toEqual([])
  })

  it('goes straight to ready, queueing no analysis, when the product the label names is already analysed with that list', async () => {
    const ctx = setup()
    const known = await catalogued(ctx, { brand: 'Glow Co', name: 'Bright Tone Serum', category: 'skin' })
    const { scanId, itemId } = await readingUnidentified(ctx)
    const researches = ctx.researcher.calls.length
    const analyses = ctx.analyst.calls.analyse.length
    ctx.labelReader.respondWith(() => readNamed(CLEAN))

    await run(ctx, itemId, 'read-label')

    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'ready', reason: null })
    expect(await ctx.repository.findItem(itemId)).toMatchObject({ productId: known.productId, formulationId: known.formulationId })
    expect(analyseSteps(ctx, itemId)).toEqual([])
    expect(ctx.researcher.calls).toHaveLength(researches)
    expect(ctx.analyst.calls.analyse).toHaveLength(analyses)
  })

  it('analyses a materially different list for a known product: a new label formulation, with the analysis queued', async () => {
    const ctx = setup()
    const known = await catalogued(ctx, { brand: 'Glow Co', name: 'Bright Tone Serum', category: 'skin' })
    const { scanId, itemId } = await readingUnidentified(ctx)
    ctx.labelReader.respondWith(() => readNamed([...CLEAN, 'Phenoxyethanol']))

    await run(ctx, itemId, 'read-label')

    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'analysing', reason: null })
    const stored = (await ctx.repository.findItem(itemId))!
    expect(stored.productId).toBe(known.productId)
    expect(stored.formulationId).not.toBe(known.formulationId)
    expect(queued(ctx).at(-1)).toEqual(advanceMessage(itemId, 'analyse'))
  })

  it.each([
    ['an older analysis version', { analysisVersion: ANALYSIS_VERSION - 1, referenceVersion: REFERENCE_VERSION }],
    ['an older reference version', { analysisVersion: ANALYSIS_VERSION, referenceVersion: 'seed-old' }],
  ])('analyses again, rather than showing it as ready, when the product the label names was analysed by %s', async (_label, versions) => {
    const ctx = setup()
    const known = await catalogued(ctx, { brand: 'Glow Co', name: 'Bright Tone Serum', category: 'skin' }, { analysed: false })
    await ctx.catalogRepository.saveAnalysis(known.formulationId, { concerns: [], ...versions, analysedAt: ctx.now() })
    const { scanId, itemId } = await readingUnidentified(ctx)
    ctx.labelReader.respondWith(() => readNamed(CLEAN))

    await run(ctx, itemId, 'read-label')

    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'analysing', reason: null })
    expect(await ctx.repository.findItem(itemId)).toMatchObject({ productId: known.productId, formulationId: known.formulationId })
    expect(analyseSteps(ctx, itemId)).toHaveLength(1)
  })

  it('does nothing the second time: a redelivered read-label neither reads the photo nor queues anything again', async () => {
    const ctx = setup()
    const { scanId, itemId } = await readingUnidentified(ctx)
    ctx.labelReader.respondWith(() => readNamed())
    await run(ctx, itemId, 'read-label')
    const jobs = ctx.jobs.enqueued.length

    await run(ctx, itemId, 'read-label')

    expect(ctx.labelReader.calls).toHaveLength(1)
    expect(ctx.jobs.enqueued).toHaveLength(jobs)
    expect((await stateOf(ctx, scanId, itemId)).state).toBe('analysing')
  })
})

describe('ScanService.advance: read-label, an item with no product, whose back gives only a list', () => {
  it.each([
    ['no brand or name', readList()],
    ['a brand but no name', { ...readList(), brand: 'Glow Co' } as LabelReading],
    ['a name but no brand', { ...readList(), name: 'Bright Tone Serum' } as LabelReading],
  ])('keeps the list as an unnamed product when the label has %s, with no research, and queues the analysis', async (_label, reading) => {
    const ctx = setup()
    const { scanId, itemId } = await readingUnidentified(ctx)
    ctx.labelReader.respondWith(() => reading)

    await run(ctx, itemId, 'read-label')

    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'analysing', reason: null })
    expect(queued(ctx).at(-1)).toEqual(advanceMessage(itemId, 'analyse'))
    const stored = (await ctx.repository.findItem(itemId))!
    expect(await ctx.catalogRepository.findProductByKey(CLEAN_UNNAMED_KEY)).toMatchObject({ id: stored.productId, kind: 'unnamed' })
    expect(await ctx.catalogRepository.findFormulation(stored.formulationId!)).toMatchObject({ productId: stored.productId, sourceKind: 'label' })
    expect(ctx.researcher.calls).toEqual([])
    expect(ctx.analyst.calls.sameProduct).toEqual([])
  })

  it('shows nothing as recognised, because the label named nothing', async () => {
    const ctx = setup()
    const { scanId, itemId } = await readingUnidentified(ctx)
    ctx.labelReader.respondWith(() => readList())

    await run(ctx, itemId, 'read-label')

    expect(await itemOf(ctx, scanId, itemId)).not.toHaveProperty('recognised')
  })

  it('makes the item ready, once analysed, as an unnamed product with empty brand and name, and the concerns of its list', async () => {
    const ctx = setup()
    const { scanId, itemId } = await readingUnidentified(ctx)
    ctx.labelReader.respondWith(() => readList(WITH_MERCURY))
    ctx.analyst.analyseWith(() => [MERCURY_CONCERN])
    await run(ctx, itemId, 'read-label')

    await run(ctx, itemId, 'analyse')

    const item = await itemOf(ctx, scanId, itemId)
    expect(item.state).toBe('ready')
    expect(item.product).toMatchObject({ kind: 'unnamed', brand: '', name: '', variant: null, category: 'other' })
    expect(item.product).not.toHaveProperty('concerns')
    const view = await formulationViewOf(ctx, itemId)
    expect(view.formulation).toMatchObject({ ingredients: WITH_MERCURY, source: { kind: 'label', url: null } })
    expect(view.concerns).toHaveLength(1)
    expect(view.concerns[0]).toMatchObject({ kind: 'banned-substance', severity: 'high', ingredients: ['Mercury'] })
    // The front photo went at needs-identification and the back photo once read, and an unnamed product has no stock image.
    expect(item.image).toBeNull()
    expect(ctx.researcher.calls).toEqual([])
  })

  it('analyses a list once: a second item photographing the same list goes straight to ready with the first one\'s formulation, and the analyst is called once', async () => {
    const ctx = setup()
    const first = await readingUnidentified(ctx)
    ctx.labelReader.respondWith(() => readList(WITH_MERCURY))
    ctx.analyst.analyseWith(() => [MERCURY_CONCERN])
    await run(ctx, first.itemId, 'read-label')
    await run(ctx, first.itemId, 'analyse')
    const second = await readingUnidentified(ctx, 10)
    const jobs = ctx.jobs.enqueued.length

    await run(ctx, second.itemId, 'read-label')

    expect(await stateOf(ctx, second.scanId, second.itemId)).toEqual({ state: 'ready', reason: null })
    expect(analyseSteps(ctx, second.itemId)).toEqual([])
    expect(ctx.jobs.enqueued).toHaveLength(jobs)
    expect(ctx.analyst.calls.analyse).toHaveLength(1)
    const [a, b] = [await itemOf(ctx, first.scanId, first.itemId), await itemOf(ctx, second.scanId, second.itemId)]
    const [formulationA, formulationB] = [await formulationIdOf(ctx, first.itemId), await formulationIdOf(ctx, second.itemId)]
    expect(formulationB).toBe(formulationA)
    expect((await ctx.catalog.productView(formulationB)).concerns).toHaveLength(1)
    expect(b.product).toMatchObject({ kind: 'unnamed', id: a.product.id })
    expect(ctx.researcher.calls).toEqual([])
  })

  it('shares the analysis with a second item whose scan was made by someone else', async () => {
    const ctx = setup()
    const first = await readingUnidentified(ctx)
    ctx.labelReader.respondWith(() => readList())
    await run(ctx, first.itemId, 'read-label')
    await run(ctx, first.itemId, 'analyse')
    const otherScan = await create(ctx, [markedJpeg(1)], { ip: OTHER_IP, userId: OTHER_USER, profileId: OTHER_PROFILE })
    const other = { scanId: otherScan.id as string, itemId: otherScan.items[0].id as string }
    ctx.recognizer.respondWith(() => BLURRY)
    await run(ctx, other.itemId, 'recognise')
    for (const marker of [41, 42]) {
      ctx.advance(SECOND)
      await asUser(() => ctx.service.retake(other.scanId, other.itemId, markedJpeg(marker), OTHER_IP), OTHER_USER, OTHER_PROFILE)
      await run(ctx, other.itemId, 'recognise')
    }
    ctx.advance(SECOND)
    await asUser(() => ctx.service.addBackPhoto(other.scanId, other.itemId, markedJpeg(43), OTHER_IP), OTHER_USER, OTHER_PROFILE)

    await run(ctx, other.itemId, 'read-label')

    expect(await ctx.repository.findItem(other.itemId)).toMatchObject({ state: 'ready', formulationId: (await ctx.repository.findItem(first.itemId))!.formulationId })
    expect(ctx.analyst.calls.analyse).toHaveLength(1)
  })

  it('moves an item already shown as unnamed to the named product when a later item\'s label names that list', async () => {
    const ctx = setup()
    const first = await readingUnidentified(ctx)
    ctx.labelReader.respondWith(() => readList(WITH_MERCURY))
    ctx.analyst.analyseWith(() => [MERCURY_CONCERN])
    await run(ctx, first.itemId, 'read-label')
    await run(ctx, first.itemId, 'analyse')
    expect((await itemOf(ctx, first.scanId, first.itemId)).product).toMatchObject({ kind: 'unnamed' })
    const second = await readingUnidentified(ctx, 10)
    ctx.labelReader.respondWith(() => readNamed(WITH_MERCURY))

    await run(ctx, second.itemId, 'read-label')

    expect(await stateOf(ctx, second.scanId, second.itemId)).toEqual({ state: 'ready', reason: null })
    const [a, b] = [await itemOf(ctx, first.scanId, first.itemId), await itemOf(ctx, second.scanId, second.itemId)]
    expect(b.product).toMatchObject({ kind: 'named', brand: 'Glow Co', name: 'Bright Tone Serum' })
    expect(a.state).toBe('ready')
    expect(a.product).toMatchObject({ kind: 'named', id: b.product.id, brand: 'Glow Co' })
    expect(a.product).not.toHaveProperty('concerns')
    const formulationId = await formulationIdOf(ctx, second.itemId)
    expect(await formulationIdOf(ctx, first.itemId)).toBe(formulationId)
    expect((await ctx.catalog.productView(formulationId)).concerns).toHaveLength(1)
    expect(await ctx.catalogRepository.findProductByKey(MERCURY_UNNAMED_KEY)).toBeNull()
    expect(ctx.analyst.calls.analyse).toHaveLength(1)
    expect(ctx.researcher.calls).toEqual([])
  })
})

describe('ScanService.advance: read-label, an item with no product, whose back cannot be read', () => {
  const unreadable = (ctx: Ctx) => ctx.labelReader.respondWith(() => ({ readable: false }))
  const refused = () => new AnthropicRefusalError('Claude refused to answer')
  const unusable = () => new AnthropicRequestError('Claude returned text that is not valid JSON')
  /** An item that has had `n` back photos uploaded (the first `n - 1` read as unreadable), the last waiting to be read. */
  const readingBackPhoto = async (ctx: Ctx, n: number) => {
    const taken = await readingUnidentified(ctx)
    for (let i = 1; i < n; i++) {
      unreadable(ctx)
      await run(ctx, taken.itemId, 'read-label')
      ctx.advance(SECOND)
      await sendBack(ctx, taken.scanId, taken.itemId, 10 + i)
    }
    return taken
  }

  it.each([
    [1, '1st'],
    [2, '2nd'],
  ])('offers identification again, as label-unreadable, when the unreadable back photo is the %i (%s)', async (n) => {
    const ctx = setup()
    const { scanId, itemId } = await readingBackPhoto(ctx, n)
    unreadable(ctx)

    await run(ctx, itemId, 'read-label')

    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'needs-identification', reason: 'label-unreadable' })
    expect(ctx.photos.stored.has(backKey(scanId, itemId))).toBe(false)
    expect((await ctx.repository.findItem(itemId))!.backPhotoKey).toBeNull()
    expect(ctx.jobs.enqueued.filter((m) => (m.body as { step: string }).step === 'analyse')).toEqual([])
  })

  it('ends the item as failed with label-unreadable when the 3rd back photo is unreadable, deleting it and queueing nothing more', async () => {
    const ctx = setup()
    const { scanId, itemId } = await readingBackPhoto(ctx, 3)
    unreadable(ctx)
    const jobs = ctx.jobs.enqueued.length

    await run(ctx, itemId, 'read-label')

    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'failed', reason: 'label-unreadable' })
    expect(ctx.photos.stored.has(backKey(scanId, itemId))).toBe(false)
    expect((await ctx.repository.findItem(itemId))!.backPhotoKey).toBeNull()
    expect(ctx.jobs.enqueued).toHaveLength(jobs)
  })

  it('takes a further back photo after an unreadable one, and reads it', async () => {
    const ctx = setup()
    const { scanId, itemId } = await readingBackPhoto(ctx, 1)
    unreadable(ctx)
    await run(ctx, itemId, 'read-label')
    ctx.advance(SECOND)

    await sendBack(ctx, scanId, itemId, 55)
    ctx.labelReader.respondWith(() => readList())
    await run(ctx, itemId, 'read-label')

    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'analysing', reason: null })
    expect(ctx.labelReader.calls.at(-1)).toEqual(markedJpeg(55))
  })

  it('still analyses the item when the 3rd back photo is readable: the cap applies only to a failure', async () => {
    const ctx = setup()
    const { scanId, itemId } = await readingBackPhoto(ctx, 3)
    ctx.labelReader.respondWith(() => readList())

    await run(ctx, itemId, 'read-label')

    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'analysing', reason: null })
  })

  it('refuses a 4th back photo for an item it has ended, with ITEM_NOT_AWAITING_BACK_PHOTO', async () => {
    const ctx = setup()
    const { scanId, itemId } = await readingBackPhoto(ctx, 3)
    unreadable(ctx)
    await run(ctx, itemId, 'read-label')

    const error = await errorOf(sendBack(ctx, scanId, itemId, 13))

    expect(error).toBeInstanceOf(ConflictError)
    expect(error.code).toBe('ITEM_NOT_AWAITING_BACK_PHOTO')
  })

  it.each([
    ['the reader cannot read the label', (ctx: Ctx) => unreadable(ctx)],
    ['the list it read is refused by the catalog (it carries a link)', (ctx: Ctx) => ctx.labelReader.respondWith(() => readNamed(['Aqua', 'see https://evil.example']))],
    ['the list it read is empty', (ctx: Ctx) => ctx.labelReader.respondWith(() => readNamed([]))],
    ['the model refuses', (ctx: Ctx) => ctx.labelReader.failNextWith(refused())],
    ['the model sends an unusable answer', (ctx: Ctx) => ctx.labelReader.failNextWith(unusable())],
    ['the back photo is gone from the store', (ctx: Ctx, scanId: string, itemId: string) => void ctx.photos.stored.delete(backKey(scanId, itemId))],
  ])('offers identification again, as label-unreadable, creating no product, on the 1st back photo when %s', async (_label, arrange) => {
    const ctx = setup()
    const { scanId, itemId } = await readingBackPhoto(ctx, 1)
    arrange(ctx, scanId, itemId)

    await expect(run(ctx, itemId, 'read-label')).resolves.toBeUndefined()

    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'needs-identification', reason: 'label-unreadable' })
    expect(await ctx.repository.findItem(itemId)).toMatchObject({ productId: null, formulationId: null, backPhotoKey: null })
    expect(await ctx.catalogRepository.findProductByKey(CLEAN_UNNAMED_KEY)).toBeNull()
    expect(ctx.photos.stored.has(backKey(scanId, itemId))).toBe(false)
  })

  it('ends the item as failed with label-unreadable on the 3rd back photo when the catalog refuses its list', async () => {
    const ctx = setup()
    const { scanId, itemId } = await readingBackPhoto(ctx, 3)
    ctx.labelReader.respondWith(() => readNamed(['Aqua', 'see https://evil.example']))

    await run(ctx, itemId, 'read-label')

    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'failed', reason: 'label-unreadable' })
  })

  it('fails the item as research-busy, keeps the back photo and does not throw, when the AI spend cap is spent', async () => {
    const ctx = setup()
    const { scanId, itemId } = await readingUnidentified(ctx)
    ctx.labelReader.failNextWith(new AiBudgetExceededError('cap'))

    await expect(run(ctx, itemId, 'read-label')).resolves.toBeUndefined()

    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'failed', reason: 'research-busy' })
    expect(ctx.photos.stored.has(backKey(scanId, itemId))).toBe(true)
  })
})

describe('ScanService: an item identified by its back photo, through the queue', () => {
  it('takes three unreadable photos and a named back photo to ready, with one vision call, one label read and one analysis, and no research', async () => {
    const ctx = setup()
    const { scanId, itemId } = await identifying(ctx)
    ctx.advance(SECOND)
    await sendBack(ctx, scanId, itemId)
    ctx.labelReader.respondWith(() => readNamed())

    const ran = await drain(ctx)

    expect(ran.slice(-2)).toEqual(['read-label', 'analyse'])
    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'ready', reason: null })
    expect(ctx.labelReader.calls).toHaveLength(1)
    expect(ctx.analyst.calls.analyse).toHaveLength(1)
    expect(ctx.researcher.calls).toEqual([])
  })

  it('takes an ingredients-only back photo to ready as an unnamed product', async () => {
    const ctx = setup()
    const { scanId, itemId } = await identifying(ctx)
    ctx.advance(SECOND)
    await sendBack(ctx, scanId, itemId)
    ctx.labelReader.respondWith(() => readList())

    await drain(ctx)

    const item = await itemOf(ctx, scanId, itemId)
    expect(item).toMatchObject({ state: 'ready', reason: null })
    expect(item.product).toMatchObject({ kind: 'unnamed', brand: '', name: '' })
    expect(ctx.researcher.calls).toEqual([])
  })
})

describe('ScanService.advance: read-label, an item with no product, when the AI spend cap stops the catalog\'s question', () => {
  const KNOWN = { brand: 'Acme', name: 'Radiance Serum Vitamin Glow', category: 'skin' } as const
  // Its name nearly matches KNOWN's, so the catalog asks the judge whether they are the same product.
  const NEAR_MISS = readNamed(CLEAN, { brand: 'Acme', name: 'Radiance Serum Vitamin Glow Booster', category: 'skin' })

  it('fails the item as research-busy without throwing, keeping the back photo, creating no product or alias and queueing nothing', async () => {
    const ctx = setup()
    await catalogued(ctx, KNOWN)
    const { scanId, itemId } = await readingUnidentified(ctx)
    ctx.labelReader.respondWith(() => NEAR_MISS)
    ctx.analyst.failNextWith(new AiBudgetExceededError('cap'))
    const jobs = ctx.jobs.enqueued.length

    await expect(run(ctx, itemId, 'read-label')).resolves.toBeUndefined()

    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'failed', reason: 'research-busy' })
    expect(await ctx.repository.findItem(itemId)).toMatchObject({ productId: null, formulationId: null })
    expect(await ctx.catalogRepository.findProductByKey(identityKey({ brand: 'Acme', name: 'Radiance Serum Vitamin Glow Booster' }))).toBeNull()
    expect(await ctx.catalogRepository.productsByBrandFamily('acme', 10)).toHaveLength(1)
    expect(ctx.jobs.enqueued).toHaveLength(jobs)
    expect(ctx.photos.stored.has(backKey(scanId, itemId))).toBe(true)
  })

  it('shows nothing as recognised for the failed item, because nothing was identified', async () => {
    const ctx = setup()
    await catalogued(ctx, KNOWN)
    const { scanId, itemId } = await readingUnidentified(ctx)
    ctx.labelReader.respondWith(() => NEAR_MISS)
    ctx.analyst.failNextWith(new AiBudgetExceededError('cap'))

    await run(ctx, itemId, 'read-label')

    expect(await itemOf(ctx, scanId, itemId)).not.toHaveProperty('recognised')
  })
})


// --- identifying an item by typing its name: a product picked from the catalog, or free text split into a product ---

// (ScanService already has a private `identify(reading)` for a back label's reading; this public one is `identifyByName`.)
describe('ScanService.identifyByName', () => {
  const SPLIT_CERAVE = { kind: 'product', brand: 'CeraVe', name: 'Hydrating Facial Cleanser', category: 'skin' } as const
  type Input = { productId: string } | { text: string }
  const identify = (ctx: Ctx, scanId: string, itemId: string, input: Input, userId = USER, profileId = PROFILE): Promise<any> =>
    asUser(() => ctx.service.identifyByName(scanId, itemId, input), userId, profileId)

  /** The two states a name may be typed in: while retakes are left, and once the 3rd front photo could not be read. */
  const AWAITING = [
    ['needs-retake', (ctx: Ctx) => failedFront(ctx, [BLURRY])],
    ['needs-identification', (ctx: Ctx) => failedFront(ctx, [BLURRY, TURNED_AWAY, BLURRY])],
  ] as const
  /** Every call that could cost: the recognizer, the label reader, the splitter, the web researcher and the analyst. */
  const aiCalls = (ctx: Ctx) =>
    ctx.recognizer.calls.length + ctx.labelReader.calls.length + ctx.nameSplitter.calls.length + ctx.researcher.calls.length + ctx.analyst.calls.analyse.length + ctx.analyst.calls.sameProduct.length

  describe.each(AWAITING)('a product picked from the catalog, for an item in %s', (state, arrange) => {
    it('moves an item whose product is analysed straight to ready with its product, showing the chosen product as what it was recognised as, and queues nothing', async () => {
      const ctx = setup()
      const { scanId, itemId } = await arrange(ctx)
      const { productId, formulationId } = await catalogued(ctx, { ...CERAVE, variant: 'Night' })
      const queuedBefore = queued(ctx)

      const view = await identify(ctx, scanId, itemId, { productId })

      expect(view).toMatchObject({
        id: itemId,
        state: 'ready',
        reason: null,
        recognised: { brand: 'CeraVe', name: 'Hydrating Facial Cleanser', variant: 'Night', category: 'skin' },
        product: { id: productId, kind: 'named', brand: 'CeraVe' },
      })
      expect(view).not.toHaveProperty('retakesLeft')
      expect(await itemOf(ctx, scanId, itemId)).toMatchObject({ state: 'ready', recognised: { variant: 'Night' } })
      expect(await ctx.repository.findItem(itemId)).toMatchObject({ productId, formulationId })
      expect(queued(ctx)).toEqual(queuedBefore)
    })

    it('shows the chosen product\'s form as what the item was recognised as, and keeps it on the item', async () => {
      const ctx = setup()
      const { scanId, itemId } = await arrange(ctx)
      const { productId } = await catalogued(ctx, { ...CERAVE, form: 'spray' })

      const view = await identify(ctx, scanId, itemId, { productId })

      expect(view.recognised).toEqual({ brand: 'CeraVe', name: 'Hydrating Facial Cleanser', variant: null, form: 'spray', category: 'skin' })
      expect(view.product).toMatchObject({ id: productId, form: 'spray' })
      expect((await itemOf(ctx, scanId, itemId)).recognised).toMatchObject({ form: 'spray' })
      expect(await ctx.repository.findItem(itemId)).toMatchObject({ recognisedForm: 'spray' })
    })

    it('shows a null form for a chosen product that has none', async () => {
      const ctx = setup()
      const { scanId, itemId } = await arrange(ctx)
      const { productId } = await catalogued(ctx)

      const view = await identify(ctx, scanId, itemId, { productId })

      expect(view.recognised).toEqual({ brand: 'CeraVe', name: 'Hydrating Facial Cleanser', variant: null, form: null, category: 'skin' })
      expect(await ctx.repository.findItem(itemId)).toMatchObject({ recognisedForm: null })
    })

    it('takes the form of the product picked, not of a sibling that differs only by form', async () => {
      const ctx = setup()
      const { scanId, itemId } = await arrange(ctx)
      await catalogued(ctx, { ...CERAVE, form: 'spray' })
      const rollOn = await catalogued(ctx, { ...CERAVE, form: 'roll-on' })

      const view = await identify(ctx, scanId, itemId, { productId: rollOn.productId })

      expect(view.recognised).toMatchObject({ form: 'roll-on' })
      expect(view.product).toMatchObject({ id: rollOn.productId, form: 'roll-on' })
    })

    it('shows the chosen product\'s form for a product that still has to be researched or analysed, too', async () => {
      const ctx = setup()
      const first = await arrange(ctx)
      const second = await arrange(ctx)
      const unresearched = await ctx.catalog.resolve({ ...CERAVE, form: 'spray' })
      const unanalysed = await catalogued(ctx, { ...CERAVE, form: 'roll-on' }, { analysed: false })

      const researching = await identify(ctx, first.scanId, first.itemId, { productId: unresearched.productId })
      const analysing = await identify(ctx, second.scanId, second.itemId, { productId: unanalysed.productId })

      expect(researching).toMatchObject({ state: 'researching', recognised: { form: 'spray' } })
      expect(analysing).toMatchObject({ state: 'analysing', recognised: { form: 'roll-on' } })
    })

    it('makes no AI call of any kind for an analysed product: no recognizer, splitter, researcher or analyst', async () => {
      const ctx = setup()
      const { scanId, itemId } = await arrange(ctx)
      const { productId } = await catalogued(ctx)
      const before = aiCalls(ctx)

      await identify(ctx, scanId, itemId, { productId })

      expect(aiCalls(ctx)).toBe(before)
      expect(ctx.nameSplitter.calls).toEqual([])
    })

    it('moves an item whose product has a formulation nobody analysed to analysing and queues the analyse step', async () => {
      const ctx = setup()
      const { scanId, itemId } = await arrange(ctx)
      const { productId, formulationId } = await catalogued(ctx, CERAVE, { analysed: false })

      const view = await identify(ctx, scanId, itemId, { productId })

      expect(view).toMatchObject({ state: 'analysing', reason: null, recognised: { brand: 'CeraVe', name: 'Hydrating Facial Cleanser', variant: null, category: 'skin' } })
      expect(await ctx.repository.findItem(itemId)).toMatchObject({ productId, formulationId })
      expect(queued(ctx).at(-1)).toEqual(advanceMessage(itemId, 'analyse'))
      expect(ctx.nameSplitter.calls).toEqual([])
    })

    it('moves an item whose product has no formulation yet to researching and queues the research step', async () => {
      const ctx = setup()
      const { scanId, itemId } = await arrange(ctx)
      const resolved = await ctx.catalog.resolve(CERAVE)

      const view = await identify(ctx, scanId, itemId, { productId: resolved.productId })

      expect(view).toMatchObject({ state: 'researching', reason: null, recognised: { brand: 'CeraVe', name: 'Hydrating Facial Cleanser' } })
      expect(await ctx.repository.findItem(itemId)).toMatchObject({ productId: resolved.productId, formulationId: null })
      expect(queued(ctx).at(-1)).toEqual(advanceMessage(itemId, 'research'))
    })

    it('moves an item whose product\'s formulation is older than FRESH_FOR_DAYS to researching, and keeps one that is exactly that old ready', async () => {
      const ctx = setup()
      const { scanId, itemId } = await arrange(ctx)
      const { productId } = await catalogued(ctx)
      ctx.advance(FRESH_FOR_DAYS * DAY)

      expect((await identify(ctx, scanId, itemId, { productId })).state).toBe('ready')

      const second = await arrange(ctx)
      ctx.advance(1)
      expect((await identify(ctx, second.scanId, second.itemId, { productId })).state).toBe('researching')
    })

    it('carries on through the queue: an item that was moved to analysing becomes ready once the analyse step runs', async () => {
      const ctx = setup()
      const { scanId, itemId } = await arrange(ctx)
      const { productId } = await catalogued(ctx, CERAVE, { analysed: false })
      await identify(ctx, scanId, itemId, { productId })

      const ran = await drain(ctx)

      expect(ran.at(-1)).toBe('analyse')
      expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'ready', reason: null })
    })

    it('leaves the retake record as it is: the photos already sent still count, and none is added', async () => {
      const ctx = setup()
      const { scanId, itemId } = await arrange(ctx)
      const retakes = await ctx.repository.countRetakes(itemId)
      const { productId } = await catalogued(ctx)

      await identify(ctx, scanId, itemId, { productId })

      expect(await ctx.repository.countRetakes(itemId)).toBe(retakes)
    })

    it('answers PRODUCT_NOT_FOUND for a product the catalog does not hold, leaving the item where it was', async () => {
      const ctx = setup()
      const { scanId, itemId } = await arrange(ctx)
      const jobs = ctx.jobs.enqueued.length

      const error = await errorOf(identify(ctx, scanId, itemId, { productId: 'no-such-product' }))

      expect(error).toBeInstanceOf(NotFoundError)
      expect(error.code).toBe('PRODUCT_NOT_FOUND')
      expect((await stateOf(ctx, scanId, itemId)).state).toBe(state)
      expect(ctx.jobs.enqueued).toHaveLength(jobs)
    })

    it('answers PRODUCT_NOT_FOUND for an unnamed product, which search never offers, leaving the item where it was', async () => {
      const ctx = setup()
      const { scanId, itemId } = await arrange(ctx)
      const unnamed = await ctx.catalog.fromLabel({ ingredients: CLEAN })

      const error = await errorOf(identify(ctx, scanId, itemId, { productId: unnamed.productId }))

      expect(error).toBeInstanceOf(NotFoundError)
      expect(error.code).toBe('PRODUCT_NOT_FOUND')
      expect((await stateOf(ctx, scanId, itemId)).state).toBe(state)
    })

    it('puts the item back and rethrows when the next step cannot be queued', async () => {
      const ctx = setup()
      const { scanId, itemId } = await arrange(ctx)
      const { productId } = await catalogued(ctx, CERAVE, { analysed: false })
      ctx.jobs.failNextWith(new Error('queue down'))

      await expect(identify(ctx, scanId, itemId, { productId })).rejects.toThrow('queue down')

      expect((await itemOf(ctx, scanId, itemId)).state).toBe(state)
    })

    it('fails the item as analysis-failed, exactly as the match step does, when the product\'s analysis has been rejected the maximum number of times', async () => {
      const ctx = setup()
      const { scanId, itemId } = await arrange(ctx)
      const { productId, formulationId } = await catalogued(ctx, CERAVE, { ingredients: WITH_MERCURY, analysed: false })
      // The analyst answers with nothing, which the catalog rejects (mercury must be explained): three rejections and it gives up.
      for (let i = 0; i < 3; i++) await ctx.catalog.analyse(formulationId).catch(() => undefined)
      const jobs = ctx.jobs.enqueued.length

      const view = await identify(ctx, scanId, itemId, { productId })

      expect(view).toMatchObject({ id: itemId, state: 'failed', reason: 'analysis-failed' })
      expect(await ctx.repository.findItem(itemId)).toMatchObject({ productId, formulationId })
      expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'failed', reason: 'analysis-failed' })
      expect(ctx.jobs.enqueued).toHaveLength(jobs)
    })
  })

  describe.each(AWAITING)('typed text, for an item in %s', (state, arrange) => {
    it('splits the text with exactly one call, then moves the item to matching as what the split found, and queues the match', async () => {
      const ctx = setup()
      const { scanId, itemId } = await arrange(ctx)
      ctx.nameSplitter.respondWith(() => ({ ...SPLIT_CERAVE, variant: 'Night' }))

      const view = await identify(ctx, scanId, itemId, { text: 'cerave hydrating facial cleanser night' })

      expect(ctx.nameSplitter.calls).toEqual(['cerave hydrating facial cleanser night'])
      expect(view).toMatchObject({ id: itemId, state: 'matching', reason: null, recognised: { brand: 'CeraVe', name: 'Hydrating Facial Cleanser', variant: 'Night', category: 'skin' } })
      expect(view).not.toHaveProperty('product')
      expect(queued(ctx).at(-1)).toEqual(advanceMessage(itemId, 'match'))
    })

    it('does the matching in the queue, not in the request: nothing is looked up in the catalog until the match step runs', async () => {
      const ctx = setup()
      const { scanId, itemId } = await arrange(ctx)
      ctx.nameSplitter.respondWith(() => SPLIT_CERAVE)

      await identify(ctx, scanId, itemId, { text: 'cerave cleanser' })

      expect(await ctx.catalogRepository.findProductByKey(identityKey(CERAVE))).toBeNull()
      expect(ctx.researcher.calls).toHaveLength(0)
    })

    it('trims the text before it is split', async () => {
      const ctx = setup()
      const { scanId, itemId } = await arrange(ctx)
      ctx.nameSplitter.respondWith(() => SPLIT_CERAVE)

      await identify(ctx, scanId, itemId, { text: '  cerave cleanser \n' })

      expect(ctx.nameSplitter.calls).toEqual(['cerave cleanser'])
    })

    it('answers a product the catalog already holds, once the match step runs, with no further model call: ready, and the one split call is all it cost', async () => {
      const ctx = setup()
      const { scanId, itemId } = await arrange(ctx)
      const { productId, formulationId } = await catalogued(ctx)
      ctx.nameSplitter.respondWith(() => SPLIT_CERAVE)
      const before = aiCalls(ctx)
      await identify(ctx, scanId, itemId, { text: 'cerave cleanser' })

      const ran = await drain(ctx)

      expect(ran).toEqual(['match'])
      expect(await itemOf(ctx, scanId, itemId)).toMatchObject({ state: 'ready', product: { id: productId } })
      expect(await ctx.repository.findItem(itemId)).toMatchObject({ productId, formulationId })
      expect(aiCalls(ctx)).toBe(before + 1)
      expect(ctx.nameSplitter.calls).toHaveLength(1)
    })

    it('leaves the form null, as the split gives none, and matches the form-less product though a sibling of another form is in the catalog', async () => {
      const ctx = setup()
      const { scanId, itemId } = await arrange(ctx)
      const spray = await catalogued(ctx, { ...CERAVE, form: 'spray' })
      const formless = await catalogued(ctx)
      ctx.nameSplitter.respondWith(() => SPLIT_CERAVE)
      const view = await identify(ctx, scanId, itemId, { text: 'cerave cleanser' })
      expect(view.recognised).toEqual({ brand: 'CeraVe', name: 'Hydrating Facial Cleanser', variant: null, form: null, category: 'skin' })
      const resolve = vi.spyOn(ctx.catalog, 'resolve')

      await drain(ctx)

      expect(resolve.mock.calls[0]![0]).not.toHaveProperty('form')
      expect(await itemOf(ctx, scanId, itemId)).toMatchObject({ state: 'ready', recognised: { form: null }, product: { id: formless.productId, form: null } })
      expect(formless.productId).not.toBe(spray.productId)
    })

    it('researches a product the catalog does not hold, as a confirmation does, and creates it under the split\'s brand, name and variant', async () => {
      const ctx = setup()
      const { scanId, itemId } = await arrange(ctx)
      ctx.nameSplitter.respondWith(() => ({ kind: 'product', brand: 'Glow Co', name: 'Bright Tone Serum', variant: 'Night', category: 'skin' }))
      ctx.researcher.respondWith(() => ({ found: true, ingredients: CLEAN, sourceUrl: SOURCE_URL }))
      await identify(ctx, scanId, itemId, { text: 'glow co bright tone serum night' })

      const ran = await drain(ctx)

      expect(ran).toEqual(['match', 'research', 'analyse'])
      expect(ctx.researcher.calls).toHaveLength(1)
      expect(await itemOf(ctx, scanId, itemId)).toMatchObject({
        state: 'ready',
        product: { kind: 'named', brand: 'Glow Co', name: 'Bright Tone Serum', variant: 'Night', category: 'skin' },
      })
      expect(await ctx.catalogRepository.findProductByKey(identityKey({ brand: 'Glow Co', name: 'Bright Tone Serum', variant: 'Night' }))).not.toBeNull()
    })

    it('asks the user for the back of the pack, as a confirmation does, when the product is new and research finds nothing', async () => {
      const ctx = setup()
      const { scanId, itemId } = await arrange(ctx)
      ctx.nameSplitter.respondWith(() => SPLIT_CERAVE)
      await identify(ctx, scanId, itemId, { text: 'cerave cleanser' })

      await drain(ctx)

      expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'needs-back-photo', reason: null })
    })

    it('leaves the retake record as it is', async () => {
      const ctx = setup()
      const { scanId, itemId } = await arrange(ctx)
      const retakes = await ctx.repository.countRetakes(itemId)
      ctx.nameSplitter.respondWith(() => SPLIT_CERAVE)

      await identify(ctx, scanId, itemId, { text: 'cerave cleanser' })

      expect(await ctx.repository.countRetakes(itemId)).toBe(retakes)
    })

    it('answers NOT_A_PRODUCT_NAME, queues nothing and leaves the item where it was, when the split says the text is not a product name', async () => {
      const ctx = setup()
      const { scanId, itemId } = await arrange(ctx)
      ctx.nameSplitter.respondWith(() => ({ kind: 'not-a-product' }))
      const jobs = ctx.jobs.enqueued.length

      const error = await errorOf(identify(ctx, scanId, itemId, { text: 'my cat is called Biscuit' }))

      expect(error).toBeInstanceOf(ValidationError)
      expect(error.code).toBe('NOT_A_PRODUCT_NAME')
      // A name is not always a beauty product's: the message says only that it could not be read as a name.
      expect(error.message).not.toMatch(/not a beauty product/i)
      expect(ctx.nameSplitter.calls).toHaveLength(1)
      expect(await itemOf(ctx, scanId, itemId)).toMatchObject({ state, reason: expect.any(String) })
      expect(await itemOf(ctx, scanId, itemId)).not.toHaveProperty('recognised')
      expect(ctx.jobs.enqueued).toHaveLength(jobs)
    })

    it('lets the user try again after NOT_A_PRODUCT_NAME', async () => {
      const ctx = setup()
      const { scanId, itemId } = await arrange(ctx)
      ctx.nameSplitter.respondWith((text) => (text === 'cerave cleanser' ? SPLIT_CERAVE : { kind: 'not-a-product' }))
      expect((await errorOf(identify(ctx, scanId, itemId, { text: 'hello' }))).code).toBe('NOT_A_PRODUCT_NAME')

      expect((await identify(ctx, scanId, itemId, { text: 'cerave cleanser' })).state).toBe('matching')
    })

    it('answers CatalogBusyError (CATALOG_BUSY), queues nothing and leaves the item where it was, when the AI spend cap stops the split', async () => {
      const ctx = setup()
      const { scanId, itemId } = await arrange(ctx)
      ctx.nameSplitter.failNextWith(new AiBudgetExceededError('cap'))
      const jobs = ctx.jobs.enqueued.length

      const error = await errorOf(identify(ctx, scanId, itemId, { text: 'cerave cleanser' }))

      expect(error).toBeInstanceOf(CatalogBusyError)
      expect(error.code).toBe('CATALOG_BUSY')
      expect((await stateOf(ctx, scanId, itemId)).state).toBe(state)
      expect(ctx.jobs.enqueued).toHaveLength(jobs)
    })

    it('puts the item back and rethrows when the match cannot be queued', async () => {
      const ctx = setup()
      const { scanId, itemId } = await arrange(ctx)
      ctx.nameSplitter.respondWith(() => SPLIT_CERAVE)
      ctx.jobs.failNextWith(new Error('queue down'))

      await expect(identify(ctx, scanId, itemId, { text: 'cerave cleanser' })).rejects.toThrow('queue down')

      expect((await itemOf(ctx, scanId, itemId)).state).toBe(state)
    })

    it('answers NOT_A_PRODUCT_NAME, as for any text that is not a product name, when the model refuses the split; the item stays and nothing is queued', async () => {
      const ctx = setup()
      const { scanId, itemId } = await arrange(ctx)
      ctx.nameSplitter.failNextWith(new AnthropicRefusalError('refused'))
      const jobs = ctx.jobs.enqueued.length

      const error = await errorOf(identify(ctx, scanId, itemId, { text: 'cerave cleanser' }))

      expect(error).toBeInstanceOf(ValidationError)
      expect(error.code).toBe('NOT_A_PRODUCT_NAME')
      // A name is not always a beauty product's: the message says only that it could not be read as a name.
      expect(error.message).not.toMatch(/not a beauty product/i)
      expect((await stateOf(ctx, scanId, itemId)).state).toBe(state)
      expect(ctx.jobs.enqueued).toHaveLength(jobs)
    })

    // A provider outage is not the daily limit: the user is told to try again, and the message must not blame a limit. The budget error above stays CATALOG_BUSY.
    it.each([
      ['unavailable', () => new AnthropicUnavailableError('overloaded')],
      ['rejects the request', () => new AnthropicRequestError('unusable answer')],
    ])('answers AI_UNAVAILABLE (503), not CATALOG_BUSY, when the provider %s; the item stays and nothing is queued', async (_label, failure) => {
      const ctx = setup()
      const { scanId, itemId } = await arrange(ctx)
      ctx.nameSplitter.failNextWith(failure())
      const jobs = ctx.jobs.enqueued.length

      const error = await errorOf(identify(ctx, scanId, itemId, { text: 'cerave cleanser' }))

      expect(error).toBeInstanceOf(UnavailableError)
      expect(error).not.toBeInstanceOf(CatalogBusyError)
      expect(error.code).toBe('AI_UNAVAILABLE')
      expect(error.message).not.toMatch(/limit/i)
      expect((await stateOf(ctx, scanId, itemId)).state).toBe(state)
      expect(ctx.jobs.enqueued).toHaveLength(jobs)
    })
  })

  describe('the typed text', () => {
    const typed = async (text: string) => {
      const ctx = setup()
      ctx.nameSplitter.respondWith(() => SPLIT_CERAVE)
      const { scanId, itemId } = await failedFront(ctx, [BLURRY])
      const jobs = ctx.jobs.enqueued.length
      return { ctx, scanId, itemId, jobs, run: () => identify(ctx, scanId, itemId, { text }) }
    }

    it.each([
      ['2 characters', 'ab'],
      ['120 characters', 'a'.repeat(120)],
      ['2 characters between spaces', '   ab   '],
      ['120 characters between spaces', `  ${'a'.repeat(120)}  `],
    ])('accepts %s', async (_label, text) => {
      const { ctx, run } = await typed(text)

      await run()

      expect(ctx.nameSplitter.calls).toEqual([text.trim()])
    })

    it.each([
      ['1 character', 'a'],
      ['1 character between spaces', '   a   '],
      ['nothing', ''],
      ['only spaces', '     '],
      ['121 characters', 'a'.repeat(121)],
      ['121 characters between spaces', `  ${'a'.repeat(121)}  `],
      ['a link', 'buy at https://evil.example now'],
      ['a www link', 'see www.evil.example'],
      ['markup', 'Glow <b>Co</b> serum'],
      ['a script', '<script>evil()</script>'],
      ['a closing tag', 'serum </i>'],
      ['a zero-width space', 'cerave​ cleanser'],
      ['a right-to-left override', 'cerave‮ cleanser'],
      ['a newline inside it', 'cerave\ncleanser'],
      ['a tab inside it', 'cerave\tcleanser'],
      ['a NUL', 'cerave\u0000cleanser'],
    ])('refuses %s with INVALID_PRODUCT_TEXT, without calling the splitter, leaving the item waiting', async (_label, text) => {
      const { ctx, scanId, itemId, jobs, run } = await typed(text)

      const error = await errorOf(run())

      expect(error).toBeInstanceOf(ValidationError)
      expect(error.code).toBe('INVALID_PRODUCT_TEXT')
      expect(ctx.nameSplitter.calls).toEqual([])
      expect((await stateOf(ctx, scanId, itemId)).state).toBe('needs-retake')
      expect(ctx.jobs.enqueued).toHaveLength(jobs)
    })

    it('accepts ordinary punctuation and accents in a name', async () => {
      const { ctx, run } = await typed("L'Oréal Paris Revitalift Crème SPF 50+ (night)")

      await run()

      expect(ctx.nameSplitter.calls).toEqual(["L'Oréal Paris Revitalift Crème SPF 50+ (night)"])
    })
  })

  describe('an item that is not waiting for a name', () => {
    const NOT_AWAITING = [
      ['recognising', (ctx: Ctx) => scanOne(ctx)],
      ['needs-confirmation', (ctx: Ctx) => reach(ctx, 'needs-confirmation')],
      ['matching', (ctx: Ctx) => reach(ctx, 'matching')],
      ['researching', (ctx: Ctx) => reach(ctx, 'researching')],
      ['needs-back-photo', (ctx: Ctx) => reach(ctx, 'needs-back-photo')],
      ['reading-label', (ctx: Ctx) => reach(ctx, 'reading-label')],
    ] as const

    it.each(NOT_AWAITING)('refuses an item that is %s with ITEM_NOT_AWAITING_IDENTIFICATION, for a picked product and for text, calling nothing', async (state, arrange) => {
      const ctx = setup()
      const { scanId, itemId } = await arrange(ctx)
      // Not the product the item was read as (some of these states have researched it already, and a researched product cannot be researched again for a week).
      const { productId } = await catalogued(ctx, { brand: 'Glow Co', name: 'Bright Tone Serum', category: 'skin' })
      ctx.nameSplitter.respondWith(() => SPLIT_CERAVE)
      const jobs = ctx.jobs.enqueued.length
      const before = aiCalls(ctx)

      for (const input of [{ productId }, { text: 'cerave cleanser' }]) {
        const error = await errorOf(identify(ctx, scanId, itemId, input))
        expect(error).toBeInstanceOf(ConflictError)
        expect(error.code).toBe('ITEM_NOT_AWAITING_IDENTIFICATION')
      }

      expect((await stateOf(ctx, scanId, itemId)).state).toBe(state)
      expect(ctx.jobs.enqueued).toHaveLength(jobs)
      expect(aiCalls(ctx)).toBe(before)
    })

    it('refuses an item that is already ready or failed', async () => {
      const ctx = setup()
      await catalogued(ctx)
      const ready = await scanOne(ctx)
      await run(ctx, ready.itemId, 'recognise')
      await drain(ctx)
      expect((await stateOf(ctx, ready.scanId, ready.itemId)).state).toBe('ready')
      const failed = await scanOne(ctx, markedJpeg(2))
      ctx.recognizer.respondWith(() => ({ classification: 'face-or-person' }))
      await run(ctx, failed.itemId, 'recognise')
      expect((await stateOf(ctx, failed.scanId, failed.itemId)).state).toBe('rejected')

      for (const { scanId, itemId } of [ready, failed]) {
        const error = await errorOf(identify(ctx, scanId, itemId, { text: 'cerave cleanser' }))
        expect(error.code).toBe('ITEM_NOT_AWAITING_IDENTIFICATION')
      }
      expect(ctx.nameSplitter.calls).toEqual([])
    })

    it('checks the state before the product: a wrong-state item with an unknown product is 409, not PRODUCT_NOT_FOUND', async () => {
      const ctx = setup()
      const { scanId, itemId } = await scanOne(ctx)

      const error = await errorOf(identify(ctx, scanId, itemId, { productId: 'no-such-product' }))

      expect(error).toBeInstanceOf(ConflictError)
      expect(error.code).toBe('ITEM_NOT_AWAITING_IDENTIFICATION')
    })

    it('refuses a second identification of the same item: the first moved it on, and only one split is paid for', async () => {
      const ctx = setup()
      const { scanId, itemId } = await failedFront(ctx, [BLURRY])
      ctx.nameSplitter.respondWith(() => SPLIT_CERAVE)
      await identify(ctx, scanId, itemId, { text: 'cerave cleanser' })

      const error = await errorOf(identify(ctx, scanId, itemId, { text: 'cerave cleanser' }))

      expect(error.code).toBe('ITEM_NOT_AWAITING_IDENTIFICATION')
      expect(ctx.nameSplitter.calls).toHaveLength(1)
      expect(queued(ctx).filter((m) => m.step === 'match')).toHaveLength(1)
    })
  })

  describe('ownership', () => {
    const inputs = (productId: string): [string, Input][] => [
      ['a picked product', { productId }],
      ['typed text', { text: 'cerave cleanser' }],
    ]

    it.each([
      ['another user\'s scan', (s: string, i: string) => [s, i, OTHER_USER, PROFILE] as const],
      ['another profile of the same account\'s scan', (s: string, i: string) => [s, i, USER, OTHER_PROFILE] as const],
      ['an unknown scan', (_s: string, i: string) => ['no-such-scan', i, USER, PROFILE] as const],
      ['an unknown item', (s: string) => [s, 'no-such-item', USER, PROFILE] as const],
    ])('answers SCAN_NOT_FOUND for %s, for a picked product and for text, changing and calling nothing', async (_label, aim) => {
      const ctx = setup()
      const { scanId, itemId } = await failedFront(ctx, [BLURRY])
      const { productId } = await catalogued(ctx)
      ctx.nameSplitter.respondWith(() => SPLIT_CERAVE)
      const [s, i, u, p] = aim(scanId, itemId)
      const jobs = ctx.jobs.enqueued.length
      const before = aiCalls(ctx)

      for (const [, input] of inputs(productId)) {
        const error = await errorOf(identify(ctx, s, i, input, u, p))
        expect(error).toBeInstanceOf(NotFoundError)
        expect(error.code).toBe('SCAN_NOT_FOUND')
      }

      expect((await stateOf(ctx, scanId, itemId)).state).toBe('needs-retake')
      expect(ctx.jobs.enqueued).toHaveLength(jobs)
      expect(aiCalls(ctx)).toBe(before)
    })

    it('answers SCAN_NOT_FOUND for an item that belongs to a different scan, even the caller\'s own', async () => {
      const ctx = setup()
      const mine = await failedFront(ctx, [BLURRY])
      const other = await scanOne(ctx, markedJpeg(5))
      ctx.nameSplitter.respondWith(() => SPLIT_CERAVE)

      const error = await errorOf(identify(ctx, other.scanId, mine.itemId, { text: 'cerave cleanser' }))

      expect(error.code).toBe('SCAN_NOT_FOUND')
      expect(ctx.nameSplitter.calls).toEqual([])
    })

    it('answers AUTH_REQUIRED to a public caller', async () => {
      const ctx = setup()
      const { scanId, itemId } = await failedFront(ctx, [BLURRY])

      const error = await errorOf(runAs({ kind: 'public' }, () => ctx.service.identifyByName(scanId, itemId, { text: 'cerave cleanser' })))

      expect(error).toBeInstanceOf(UnauthorizedError)
      expect(error.code).toBe('AUTH_REQUIRED')
      expect(ctx.nameSplitter.calls).toEqual([])
    })
  })
})

describe('ScanService.noLabel', () => {
  type Answers = { source: string; purpose: string; usedFor: string; description?: string }
  const ANSWERS = { source: 'market-vendor', purpose: 'lighten', usedFor: '6-months-2-years' } as const
  const noLabel = (ctx: Ctx, scanId: string, itemId: string, input: Answers = ANSWERS, userId = USER, profileId = PROFILE): Promise<any> =>
    asUser(() => ctx.service.noLabel(scanId, itemId, input as never), userId, profileId)
  /** An item whose 3rd front photo could not be read, so it offers identification (a back photo, a typed name, or no label). */
  const identifying = (ctx: Ctx) => failedFront(ctx, [BLURRY, TURNED_AWAY, BLURRY])
  /** Every call that could cost: the recognizer, the label reader, the splitter, the web researcher and the analyst. */
  const aiCalls = (ctx: Ctx) =>
    ctx.recognizer.calls.length + ctx.labelReader.calls.length + ctx.nameSplitter.calls.length + ctx.researcher.calls.length + ctx.analyst.calls.analyse.length + ctx.analyst.calls.sameProduct.length
  const itemEvents = (ctx: Ctx, scanId: string) => ctx.events.eventsFor(scanId).filter((e) => e.type === 'item')

  describe('an item offering identification', () => {
    it('moves it to unidentified and shows what was answered with the cautions for those answers, no product and no photo', async () => {
      const ctx = setup()
      const { scanId, itemId } = await identifying(ctx)

      const view = await noLabel(ctx, scanId, itemId)

      expect(view).toMatchObject({
        id: itemId,
        position: 0,
        state: 'unidentified',
        reason: null,
        image: null,
        noLabel: { source: 'market-vendor', purpose: 'lighten', usedFor: '6-months-2-years', rulesVersion: CAUTION_RULES_VERSION },
      })
      expect(view.noLabel.concerns).toEqual(cautionFor(ANSWERS))
      // Literal, so the wiring above is not the only thing pinning what a caution is: lightener + long use + the general one, substances first.
      expect(view.noLabel.concerns.map((c: { kind: string }) => c.kind)).toEqual(['banned-substance', 'hyperpigmentation-risk', 'irritation'])
      expect(view).not.toHaveProperty('product')
      expect(view).not.toHaveProperty('retakesLeft')
      expect(view.noLabel).not.toHaveProperty('description')
    })

    it('shows the same item when the scan is read afterwards, and stores the answers on the item', async () => {
      const ctx = setup()
      const { scanId, itemId } = await identifying(ctx)
      const view = await noLabel(ctx, scanId, itemId, { ...ANSWERS, description: 'A pink tub' })

      expect(await itemOf(ctx, scanId, itemId)).toEqual(view)
      expect(await ctx.repository.findItem(itemId)).toMatchObject({
        state: 'unidentified',
        reason: null,
        noLabelSource: 'market-vendor',
        noLabelPurpose: 'lighten',
        noLabelUsedFor: '6-months-2-years',
        noLabelDescription: 'A pink tub',
      })
      expect(view.noLabel.description).toBe('A pink tub')
    })

    it('forgets why the photo could not be read: the reason is cleared, whichever it was', async () => {
      const ctx = setup()
      const { scanId, itemId } = await failedFront(ctx, [BLURRY, BLURRY, TURNED_AWAY])
      expect((await itemOf(ctx, scanId, itemId)).reason).toBe('label-not-visible')

      const view = await noLabel(ctx, scanId, itemId)

      expect(view.reason).toBeNull()
    })

    it.each(['market-vendor', 'pharmacy', 'online', 'gift', 'not-sure'])('accepts the source %s', async (source) => {
      const ctx = setup()
      const { scanId, itemId } = await identifying(ctx)

      expect((await noLabel(ctx, scanId, itemId, { ...ANSWERS, source })).noLabel.source).toBe(source)
    })

    it.each(['lighten', 'moisturise', 'treat-spots', 'not-sure'])('accepts the purpose %s', async (purpose) => {
      const ctx = setup()
      const { scanId, itemId } = await identifying(ctx)

      expect((await noLabel(ctx, scanId, itemId, { ...ANSWERS, purpose })).noLabel.purpose).toBe(purpose)
    })

    it.each(['under-1-month', '1-6-months', '6-months-2-years', 'over-2-years'])('accepts the time used %s', async (usedFor) => {
      const ctx = setup()
      const { scanId, itemId } = await identifying(ctx)

      expect((await noLabel(ctx, scanId, itemId, { ...ANSWERS, usedFor })).noLabel.usedFor).toBe(usedFor)
    })

    it('costs nothing: no model call, no queued job, no photo in the daily quota and no retake counted', async () => {
      const ctx = setup()
      const { scanId, itemId } = await identifying(ctx)
      const day = new Date(ctx.now().getTime() - DAY)
      const photos = await ctx.repository.photosSince(USER, day)
      const retakes = await ctx.repository.countRetakes(itemId)
      const jobs = ctx.jobs.enqueued.length
      const calls = aiCalls(ctx)

      await noLabel(ctx, scanId, itemId)

      expect(ctx.jobs.enqueued).toHaveLength(jobs)
      expect(aiCalls(ctx)).toBe(calls)
      expect(await ctx.repository.photosSince(USER, day)).toEqual(photos)
      expect(await ctx.repository.countRetakes(itemId)).toBe(retakes)
    })

    it('is final: no other route takes the item on, and a late queue message for it does nothing', async () => {
      const ctx = setup()
      const { scanId, itemId } = await identifying(ctx)
      await noLabel(ctx, scanId, itemId)
      const before = await ctx.repository.findItem(itemId)
      const events = ctx.events.published.length
      ctx.nameSplitter.respondWith(() => ({ kind: 'product', brand: 'CeraVe', name: 'Hydrating Facial Cleanser', category: 'skin' }))

      expect((await errorOf(asUser(() => ctx.service.identifyByName(scanId, itemId, { text: 'cerave cleanser' })))).code).toBe('ITEM_NOT_AWAITING_IDENTIFICATION')
      expect((await errorOf(asUser(() => ctx.service.addBackPhoto(scanId, itemId, markedJpeg(9), IP)))).code).toBe('ITEM_NOT_AWAITING_BACK_PHOTO')
      expect((await errorOf(retake(ctx, scanId, itemId))).code).toBe('ITEM_NOT_AWAITING_RETAKE')
      expect((await errorOf(asUser(() => ctx.service.confirm(scanId, itemId, { brand: 'Glow Co', name: 'Serum', category: 'skin' })))).code).toBe('ITEM_NOT_AWAITING_CONFIRMATION')
      for (const step of ['recognise', 'match', 'research', 'read-label', 'analyse'] as const) await run(ctx, itemId, step)

      expect(await ctx.repository.findItem(itemId)).toEqual(before)
      expect(ctx.events.published).toHaveLength(events)
    })
  })

  describe('the description', () => {
    const described = async (description: string | undefined) => {
      const ctx = setup()
      const { scanId, itemId } = await identifying(ctx)
      const jobs = ctx.jobs.enqueued.length
      const events = ctx.events.published.length
      return { ctx, scanId, itemId, jobs, events, run: () => noLabel(ctx, scanId, itemId, { ...ANSWERS, ...(description === undefined ? {} : { description }) }) }
    }

    it.each([
      ['1 character', 'a'],
      ['200 characters', 'a'.repeat(200)],
      ['200 characters between spaces', `   ${'a'.repeat(200)}  `],
    ])('accepts %s, stored trimmed', async (_label, description) => {
      const { ctx, itemId, run } = await described(description)

      const view = await run()

      expect(view.noLabel.description).toBe(description.trim())
      expect((await ctx.repository.findItem(itemId))!.noLabelDescription).toBe(description.trim())
    })

    it.each([
      ['201 characters', 'a'.repeat(201)],
      ['201 characters between spaces', `  ${'a'.repeat(201)}  `],
      ['a link', 'bought at https://evil.example'],
      ['a www link', 'see www.evil.example'],
      ['markup', 'a <b>pink</b> tub'],
      ['a script', '<script>evil()</script>'],
      ['a zero-width space', 'pink​ tub'],
      ['a right-to-left override', 'pink‮ tub'],
      ['a newline inside it', 'pink\ntub'],
      ['a tab inside it', 'pink\ttub'],
      ['a NUL', 'pink\u0000tub'],
    ])('refuses %s with INVALID_PRODUCT_TEXT naming the description, leaving the item waiting and storing nothing', async (_label, description) => {
      const { ctx, scanId, itemId, jobs, events, run } = await described(description)

      const error = await errorOf(run())

      expect(error).toBeInstanceOf(ValidationError)
      expect(error.code).toBe('INVALID_PRODUCT_TEXT')
      expect(error.details).toMatchObject({ field: 'description' })
      expect((await stateOf(ctx, scanId, itemId)).state).toBe('needs-identification')
      expect(await ctx.repository.findItem(itemId)).toMatchObject({ noLabelSource: null, noLabelPurpose: null, noLabelUsedFor: null, noLabelDescription: null })
      expect(ctx.jobs.enqueued).toHaveLength(jobs)
      expect(ctx.events.published).toHaveLength(events)
    })

    it.each([
      ['left out', undefined],
      ['empty', ''],
      ['only spaces', '     '],
      ['only a tab and a newline between spaces', '  '],
    ])('treats a description that is %s as absent: nothing stored, nothing shown', async (_label, description) => {
      const { ctx, itemId, run } = await described(description)

      const view = await run()

      expect(view.state).toBe('unidentified')
      expect(view.noLabel).not.toHaveProperty('description')
      expect((await ctx.repository.findItem(itemId))!.noLabelDescription).toBeNull()
    })

    it('keeps ordinary punctuation and accents', async () => {
      const { run } = await described("Pot from Mama Ngozi's stall (Balogun) — ~₦3,000, <1 month old")

      expect((await run()).noLabel.description).toBe("Pot from Mama Ngozi's stall (Balogun) — ~₦3,000, <1 month old")
    })

    it('never puts the description into the cautions', async () => {
      const { run } = await described('SecretWordingFromTheUser')

      const view = await run()

      expect(JSON.stringify(view.noLabel.concerns)).not.toContain('SecretWordingFromTheUser')
    })
  })

  describe('an item that is not waiting to say it has no label', () => {
    const NOT_AWAITING = [
      ['recognising', (ctx: Ctx) => scanOne(ctx)],
      ['needs-confirmation', (ctx: Ctx) => reach(ctx, 'needs-confirmation')],
      ['matching', (ctx: Ctx) => reach(ctx, 'matching')],
      ['researching', (ctx: Ctx) => reach(ctx, 'researching')],
      ['needs-back-photo', (ctx: Ctx) => reach(ctx, 'needs-back-photo')],
      ['reading-label', (ctx: Ctx) => reach(ctx, 'reading-label')],
      // Still has retakes left: the label can wait for the next photo, the user has not run out of tries.
      ['needs-retake', (ctx: Ctx) => failedFront(ctx, [BLURRY])],
    ] as const

    it.each(NOT_AWAITING)('refuses an item that is %s with ITEM_NOT_AWAITING_NO_LABEL, changing and calling nothing', async (state, arrange) => {
      const ctx = setup()
      const { scanId, itemId } = await arrange(ctx)
      const before = await ctx.repository.findItem(itemId)
      const jobs = ctx.jobs.enqueued.length
      const events = ctx.events.published.length
      const calls = aiCalls(ctx)

      const error = await errorOf(noLabel(ctx, scanId, itemId))

      expect(error).toBeInstanceOf(ConflictError)
      expect(error.code).toBe('ITEM_NOT_AWAITING_NO_LABEL')
      expect((await stateOf(ctx, scanId, itemId)).state).toBe(state)
      expect(await ctx.repository.findItem(itemId)).toEqual(before)
      expect(ctx.jobs.enqueued).toHaveLength(jobs)
      expect(ctx.events.published).toHaveLength(events)
      expect(aiCalls(ctx)).toBe(calls)
    })

    it('refuses an item that is already ready, rejected or failed', async () => {
      const ctx = setup()
      await catalogued(ctx)
      const ready = await scanOne(ctx)
      await run(ctx, ready.itemId, 'recognise')
      await drain(ctx)
      const rejected = await scanOne(ctx, markedJpeg(2))
      ctx.recognizer.respondWith(() => ({ classification: 'face-or-person' }))
      await run(ctx, rejected.itemId, 'recognise')
      const failed = await scanOne(ctx, markedJpeg(3))
      ctx.photos.stored.delete(photoKey(failed.scanId, failed.itemId))
      await run(ctx, failed.itemId, 'recognise')
      expect(await Promise.all([ready, rejected, failed].map(async (x) => (await stateOf(ctx, x.scanId, x.itemId)).state))).toEqual(['ready', 'rejected', 'failed'])

      for (const { scanId, itemId } of [ready, rejected, failed]) {
        expect((await errorOf(noLabel(ctx, scanId, itemId))).code).toBe('ITEM_NOT_AWAITING_NO_LABEL')
      }
    })

    it('checks the state before the description: a wrong-state item with a bad description is 409, not INVALID_PRODUCT_TEXT', async () => {
      const ctx = setup()
      const { scanId, itemId } = await scanOne(ctx)

      const error = await errorOf(noLabel(ctx, scanId, itemId, { ...ANSWERS, description: 'see https://evil.example' }))

      expect(error).toBeInstanceOf(ConflictError)
      expect(error.code).toBe('ITEM_NOT_AWAITING_NO_LABEL')
    })

    it('refuses a second call on the same item with 409, even with different answers, and changes nothing: no new time, no new event', async () => {
      const ctx = setup()
      const { scanId, itemId } = await identifying(ctx)
      const first = await noLabel(ctx, scanId, itemId, { ...ANSWERS, description: 'first' })
      const stored = await ctx.repository.findItem(itemId)
      const events = ctx.events.published.length
      ctx.advance(MINUTE)

      const error = await errorOf(noLabel(ctx, scanId, itemId, { source: 'pharmacy', purpose: 'moisturise', usedFor: 'under-1-month', description: 'second' }))

      expect(error).toBeInstanceOf(ConflictError)
      expect(error.code).toBe('ITEM_NOT_AWAITING_NO_LABEL')
      expect(await ctx.repository.findItem(itemId)).toEqual(stored)
      expect(await itemOf(ctx, scanId, itemId)).toEqual(first)
      expect(ctx.events.published).toHaveLength(events)
    })

    it('lets exactly one of two simultaneous calls win, and publishes the item once', async () => {
      const ctx = setup()
      const { scanId, itemId } = await identifying(ctx)
      const events = itemEvents(ctx, scanId).length

      const results = await Promise.allSettled([
        noLabel(ctx, scanId, itemId, { ...ANSWERS, source: 'pharmacy' }),
        noLabel(ctx, scanId, itemId, { ...ANSWERS, source: 'gift' }),
      ])

      const won = results.filter((r) => r.status === 'fulfilled')
      const lost = results.filter((r) => r.status === 'rejected')
      expect(won).toHaveLength(1)
      expect(lost).toHaveLength(1)
      expect((lost[0] as PromiseRejectedResult).reason.code).toBe('ITEM_NOT_AWAITING_NO_LABEL')
      expect((await ctx.repository.findItem(itemId))!.noLabelSource).toBe((won[0] as PromiseFulfilledResult<any>).value.noLabel.source)
      expect(itemEvents(ctx, scanId)).toHaveLength(events + 1)
    })
  })

  describe('a back photo and a no-label answer racing for the same item', () => {
    const noLabelInput = { source: 'gift', purpose: 'moisturise', usedFor: '1-6-months' } as const
    const backPhoto = (ctx: Ctx, scanId: string, itemId: string): Promise<any> => asUser(() => ctx.service.addBackPhoto(scanId, itemId, markedJpeg(9), IP))

    it('lets the no-label answer win when it lands between the back photo\'s read and its write: the back photo answers 409, its file is deleted and nothing is counted', async () => {
      const ctx = setup()
      const { scanId, itemId } = await identifying(ctx)
      const day = new Date(ctx.now().getTime() - DAY)
      const quota = await ctx.repository.photosSince(USER, day)
      const jobs = ctx.jobs.enqueued.length
      // The photo is stored after addBackPhoto has read the item as needs-identification and before it moves it: the answer lands exactly then.
      const put = ctx.photos.put.bind(ctx.photos)
      ctx.photos.put = async (key, image) => {
        await put(key, image)
        await noLabel(ctx, scanId, itemId, noLabelInput)
      }

      const error = await errorOf(backPhoto(ctx, scanId, itemId))

      expect(error).toBeInstanceOf(ConflictError)
      expect(error.code).toBe('ITEM_NOT_AWAITING_BACK_PHOTO')
      expect(ctx.photos.stored.has(backKey(scanId, itemId))).toBe(false)
      expect(await ctx.repository.photosSince(USER, day)).toEqual(quota)
      expect(await ctx.repository.countBackPhotos(itemId)).toBe(0)
      expect(await ctx.repository.findItem(itemId)).toMatchObject({ state: 'unidentified', backPhotoKey: null, noLabelSource: 'gift' })
      expect(ctx.jobs.enqueued).toHaveLength(jobs)
    })

    it('lets the back photo win when it lands first: the no-label answer answers 409 and stores nothing', async () => {
      const ctx = setup()
      const { scanId, itemId } = await identifying(ctx)
      await backPhoto(ctx, scanId, itemId)

      const error = await errorOf(noLabel(ctx, scanId, itemId, noLabelInput))

      expect(error.code).toBe('ITEM_NOT_AWAITING_NO_LABEL')
      expect(await ctx.repository.findItem(itemId)).toMatchObject({ state: 'reading-label', noLabelSource: null, noLabelPurpose: null, noLabelUsedFor: null })
      expect(ctx.photos.stored.has(backKey(scanId, itemId))).toBe(true)
    })

    it('lets exactly one of two simultaneous calls win, and leaves the item in the winner\'s state alone', async () => {
      const ctx = setup()
      const { scanId, itemId } = await identifying(ctx)
      const day = new Date(ctx.now().getTime() - DAY)
      const before = await ctx.repository.photosSince(USER, day)

      const [photo, answer] = await Promise.allSettled([backPhoto(ctx, scanId, itemId), noLabel(ctx, scanId, itemId, noLabelInput)])

      expect([photo!.status, answer!.status].filter((s) => s === 'fulfilled')).toHaveLength(1)
      const stored = (await ctx.repository.findItem(itemId))!
      if (answer!.status === 'fulfilled') {
        expect(stored).toMatchObject({ state: 'unidentified', backPhotoKey: null, noLabelSource: 'gift' })
        expect(ctx.photos.stored.has(backKey(scanId, itemId))).toBe(false)
        expect(await ctx.repository.photosSince(USER, day)).toEqual(before)
        expect(await ctx.repository.countBackPhotos(itemId)).toBe(0)
      } else {
        expect(stored).toMatchObject({ state: 'reading-label', noLabelSource: null })
        expect(ctx.photos.stored.has(backKey(scanId, itemId))).toBe(true)
        expect(await ctx.repository.countBackPhotos(itemId)).toBe(1)
        expect((answer as PromiseRejectedResult).reason.code).toBe('ITEM_NOT_AWAITING_NO_LABEL')
      }
    })
  })

  describe('the item is final', () => {
    it('publishes the item as unidentified, exactly as it is shown, then done, and marks a one-item scan done', async () => {
      const ctx = setup()
      const { scanId, itemId } = await identifying(ctx)
      const before = ctx.events.published.length

      await noLabel(ctx, scanId, itemId)

      const published = ctx.events.published.slice(before).map((p) => p.event)
      expect(published.map((e) => e.type)).toEqual(['item', 'done'])
      expect(published[0]).toEqual({ type: 'item', item: await itemOf(ctx, scanId, itemId) })
      expect((published[0] as { item: { state: string } }).item.state).toBe('unidentified')
      expect((await ctx.repository.findScan(scanId))!.doneAt).toEqual(ctx.now())
    })

    it('sends no done while another item of the scan is still being worked on', async () => {
      const ctx = setup()
      const scan = await create(ctx, [markedJpeg(1), markedJpeg(2)])
      const [first, second] = scan.items
      ctx.recognizer.respondWith(() => BLURRY)
      await run(ctx, first.id, 'recognise')
      for (const marker of [21, 22]) {
        ctx.advance(SECOND)
        await retake(ctx, scan.id, first.id, markedJpeg(marker))
        await run(ctx, first.id, 'recognise')
      }
      expect((await stateOf(ctx, scan.id, first.id)).state).toBe('needs-identification')
      const before = ctx.events.published.length

      await noLabel(ctx, scan.id, first.id)

      expect(ctx.events.published.slice(before).map((p) => p.event.type)).toEqual(['item'])
      expect((await ctx.repository.findScan(scan.id))!.doneAt).toBeNull()
      expect((await stateOf(ctx, scan.id, second.id)).state).toBe('recognising')
    })

    it('sends done once the scan\'s last working item finishes after an item went unidentified', async () => {
      const ctx = setup()
      ctx.recognizer.respondWith((image) => (image.bytes.at(-1) === 2 ? { classification: 'face-or-person' } : BLURRY))
      const scan = await create(ctx, [markedJpeg(1), markedJpeg(2)])
      const [first, second] = scan.items
      await run(ctx, first.id, 'recognise')
      for (const marker of [21, 22]) {
        ctx.advance(SECOND)
        await retake(ctx, scan.id, first.id, markedJpeg(marker))
        ctx.recognizer.respondWith(() => BLURRY)
        await run(ctx, first.id, 'recognise')
      }
      await noLabel(ctx, scan.id, first.id)
      expect(ctx.events.eventsFor(scan.id).map((e) => e.type)).not.toContain('done')
      ctx.recognizer.respondWith(() => ({ classification: 'face-or-person' }))

      await run(ctx, second.id, 'recognise')

      expect(ctx.events.eventsFor(scan.id).map((e) => e.type).at(-1)).toBe('done')
      expect((await ctx.repository.findScan(scan.id))!.doneAt).not.toBeNull()
    })

    it('shows an unidentified item in watch\'s snapshot with its noLabel block, exactly as getScan does', async () => {
      const ctx = setup()
      const { scanId, itemId } = await identifying(ctx)
      await noLabel(ctx, scanId, itemId, { ...ANSWERS, description: 'A pink tub' })

      await asUser(() => ctx.service.watch(scanId))

      const snapshot = JSON.parse(JSON.stringify(ctx.events.subscribed[0]!.snapshot))
      expect(snapshot.items[0]).toMatchObject({ id: itemId, state: 'unidentified', noLabel: { source: 'market-vendor', description: 'A pink tub' } })
      expect(snapshot).toEqual(JSON.parse(JSON.stringify(toScanResponse(await getScan(ctx, scanId)))))
    })
  })

  describe('the cautions are worked out when the item is read, not stored', () => {
    it('shows the cautions for the answers on the row of an item that was moved by the repository alone', async () => {
      const ctx = setup()
      const { scanId, itemId } = await identifying(ctx)
      // The same write the service makes, without the service: nothing but the four answers is on the row, and the view still has the cautions.
      await ctx.repository.updateItem(itemId, 'needs-identification', {
        state: 'unidentified',
        reason: null,
        noLabelSource: 'pharmacy',
        noLabelPurpose: 'treat-spots',
        noLabelUsedFor: 'over-2-years',
        noLabelDescription: null,
        updatedAt: ctx.now(),
      })

      const item = await itemOf(ctx, scanId, itemId)

      expect(item.noLabel).toMatchObject({ source: 'pharmacy', purpose: 'treat-spots', usedFor: 'over-2-years', rulesVersion: CAUTION_RULES_VERSION })
      expect(item.noLabel.concerns.map((c: { kind: string }) => c.kind)).toEqual(['hyperpigmentation-risk', 'irritation'])
      expect(item.noLabel.concerns).toEqual(cautionFor({ source: 'pharmacy', purpose: 'treat-spots', usedFor: 'over-2-years' }))
    })

    it('leaves noLabel out of every item that is not unidentified', async () => {
      const ctx = setup()
      const identifyingItem = await identifying(ctx)
      const recognising = await scanOne(ctx, markedJpeg(7))

      for (const { scanId, itemId } of [identifyingItem, recognising]) {
        expect(await itemOf(ctx, scanId, itemId)).not.toHaveProperty('noLabel')
      }
    })
  })

  describe('ownership', () => {
    it.each([
      ['another user\'s scan', (s: string, i: string) => [s, i, OTHER_USER, PROFILE] as const],
      ['another profile of the same account\'s scan', (s: string, i: string) => [s, i, USER, OTHER_PROFILE] as const],
      ['an unknown scan', (_s: string, i: string) => ['no-such-scan', i, USER, PROFILE] as const],
      ['an unknown item', (s: string) => [s, 'no-such-item', USER, PROFILE] as const],
    ])('answers SCAN_NOT_FOUND for %s, changing nothing', async (_label, aim) => {
      const ctx = setup()
      const { scanId, itemId } = await identifying(ctx)
      const [s, i, u, p] = aim(scanId, itemId)
      const before = await ctx.repository.findItem(itemId)
      const jobs = ctx.jobs.enqueued.length
      const events = ctx.events.published.length

      const error = await errorOf(noLabel(ctx, s, i, ANSWERS, u, p))

      expect(error).toBeInstanceOf(NotFoundError)
      expect(error.code).toBe('SCAN_NOT_FOUND')
      expect(await ctx.repository.findItem(itemId)).toEqual(before)
      expect(ctx.jobs.enqueued).toHaveLength(jobs)
      expect(ctx.events.published).toHaveLength(events)
    })

    it('answers SCAN_NOT_FOUND, not ITEM_NOT_AWAITING_NO_LABEL, to another profile asking about an item in the wrong state', async () => {
      const ctx = setup()
      const { scanId, itemId } = await scanOne(ctx)

      const error = await errorOf(noLabel(ctx, scanId, itemId, ANSWERS, USER, OTHER_PROFILE))

      expect(error.code).toBe('SCAN_NOT_FOUND')
    })

    it('answers SCAN_NOT_FOUND for an item that belongs to a different scan, even the caller\'s own', async () => {
      const ctx = setup()
      const mine = await identifying(ctx)
      const other = await scanOne(ctx, markedJpeg(5))

      const error = await errorOf(noLabel(ctx, other.scanId, mine.itemId))

      expect(error.code).toBe('SCAN_NOT_FOUND')
    })

    it('lets the profile that made the scan do it, after the account\'s other profile was refused', async () => {
      const ctx = setup()
      const { scanId, itemId } = await identifying(ctx)
      await errorOf(noLabel(ctx, scanId, itemId, ANSWERS, USER, OTHER_PROFILE))

      expect((await noLabel(ctx, scanId, itemId, ANSWERS, USER, PROFILE)).state).toBe('unidentified')
    })

    it('answers AUTH_REQUIRED to a public caller', async () => {
      const ctx = setup()
      const { scanId, itemId } = await identifying(ctx)

      const error = await errorOf(runAs({ kind: 'public' }, () => ctx.service.noLabel(scanId, itemId, ANSWERS)))

      expect(error).toBeInstanceOf(UnauthorizedError)
      expect(error.code).toBe('AUTH_REQUIRED')
      expect((await stateOf(ctx, scanId, itemId)).state).toBe('needs-identification')
    })
  })
})

describe('ScanService: an unidentified item and the background jobs', () => {
  /** An item the user has said has no label, with the clock moved on 3 hours. */
  const unidentified = async (ctx: Ctx) => {
    const { scanId, itemId } = await failedFront(ctx, [BLURRY, TURNED_AWAY, BLURRY])
    await asUser(() => ctx.service.noLabel(scanId, itemId, { source: 'market-vendor', purpose: 'lighten', usedFor: 'over-2-years' } as never))
    return { scanId, itemId }
  }

  it('is left alone by the reaper however old: nothing queued, not failed, nothing published', async () => {
    const ctx = setup()
    const { scanId, itemId } = await unidentified(ctx)
    const before = await ctx.repository.findItem(itemId)
    const jobs = ctx.jobs.enqueued.length
    const events = ctx.events.published.length
    ctx.advance(3 * HOUR)

    const result = await asJob(() => ctx.service.reap(ctx.now()))

    expect(result).toEqual({ requeued: 0, failed: 0 })
    expect(await ctx.repository.findItem(itemId)).toEqual(before)
    expect((await stateOf(ctx, scanId, itemId)).state).toBe('unidentified')
    expect(ctx.jobs.enqueued).toHaveLength(jobs)
    expect(ctx.events.published).toHaveLength(events)
  })

  it('is left exactly as it was by the dead-letter hook, and nothing is published', async () => {
    const ctx = setup()
    const { itemId, scanId } = await unidentified(ctx)
    const before = await itemOf(ctx, scanId, itemId)
    const events = ctx.events.published.length

    await asJob(() => ctx.service.markItemFailed(itemId))

    expect(await itemOf(ctx, scanId, itemId)).toEqual(before)
    expect(before).toMatchObject({ state: 'unidentified' })
    expect(ctx.events.published).toHaveLength(events)
  })

  it('counts as final for the reaper\'s repair of a lost done: a scan whose only item is unidentified gets its done once it has settled', async () => {
    class FlakyEvents extends MemoryScanEvents {
      failing = false
      override async publish(scanId: string, event: Parameters<MemoryScanEvents['publish']>[1]): Promise<void> {
        if (this.failing) throw new Error('stream is down')
        return super.publish(scanId, event)
      }
    }
    let events!: FlakyEvents
    const ctx = setup({ events: () => (events = new FlakyEvents()) })
    const { scanId, itemId } = await failedFront(ctx, [BLURRY, TURNED_AWAY, BLURRY])
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    events.failing = true
    await asUser(() => ctx.service.noLabel(scanId, itemId, { source: 'gift', purpose: 'moisturise', usedFor: '1-6-months' } as never))
    events.failing = false
    logged.mockRestore()
    expect((await ctx.repository.findScan(scanId))!.doneAt).toBeNull()
    ctx.advance(5 * MINUTE + 1)
    const published = ctx.events.eventsFor(scanId).length

    await asJob(() => ctx.service.reap(ctx.now()))

    expect(ctx.events.eventsFor(scanId).slice(published).map((e) => e.type)).toEqual(['done'])
    expect((await ctx.repository.findScan(scanId))!.doneAt).toEqual(ctx.now())
  })
})

// What the person is told about a scan, through the push jobs the service queues: the bodies, and the keys that decide how many are sent.
describe('ScanService: push notifications', () => {
  const SETTLED = 5 * MINUTE
  const pushes = (ctx: Ctx) => ctx.pushJobs.enqueued.map((e) => e.body as SendPushMessage)
  const keys = (ctx: Ctx) => pushes(ctx).map((body) => sendPushSpec.key(body))
  const reap = (ctx: Ctx) => asJob(() => ctx.service.reap(ctx.now()))
  const watch = (ctx: Ctx, scanId: string) => asUser(() => ctx.service.watch(scanId))
  const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => undefined)

  /** Fails to publish a `done` while `failing`; items go through. */
  class DoneFlaky extends MemoryScanEvents {
    failing = false
    override async publish(scanId: string, event: Parameters<MemoryScanEvents['publish']>[1]): Promise<void> {
      if (this.failing && event.type === 'done') throw new Error('stream is down')
      return super.publish(scanId, event)
    }
  }
  /** Fails to publish anything while `failing`, as a stream that is down does. */
  class AllFlaky extends MemoryScanEvents {
    failing = false
    override async publish(scanId: string, event: Parameters<MemoryScanEvents['publish']>[1]): Promise<void> {
      if (this.failing) throw new Error('stream is down')
      return super.publish(scanId, event)
    }
  }
  /** Says what had been queued for push at the moment the live `done` went out. */
  class ProbeEvents extends MemoryScanEvents {
    onDone: (() => void) | undefined
    override async publish(scanId: string, event: Parameters<MemoryScanEvents['publish']>[1]): Promise<void> {
      if (event.type === 'done') this.onDone?.()
      return super.publish(scanId, event)
    }
  }

  describe('when an item needs a confirmation', () => {
    it('tells the profile that made the scan, once, with a key that is the scan and the need', async () => {
      const ctx = setup()
      ctx.recognizer.respondWith(() => seen({ confidence: 0.3 }))
      const scan = await create(ctx, [markedJpeg(1)], { userId: OTHER_USER, profileId: OTHER_PROFILE })
      const itemId = scan.items[0].id as string

      await run(ctx, itemId, 'recognise')

      expect(pushes(ctx)).toEqual([{ kind: 'scan-needs-you', userId: OTHER_USER, profileId: OTHER_PROFILE, scanId: scan.id, itemId, need: 'confirm' }])
      expect(keys(ctx)).toEqual([`scan-needs-you:${scan.id}:confirm`])
      expect(ctx.pushJobs.enqueued[0]!.job).toBe('send-push')
    })

    it('says nothing when the read is sure enough (exactly the confirmation threshold, 0.6)', async () => {
      const ctx = setup()
      ctx.recognizer.respondWith(() => seen({ confidence: SCAN_POLICY.confirmBelowConfidence }))
      const { itemId } = await scanOne(ctx)

      await run(ctx, itemId, 'recognise')

      expect(pushes(ctx)).toEqual([])
    })

    it('says it once when the same step is delivered twice', async () => {
      const ctx = setup()
      ctx.recognizer.respondWith(() => seen({ confidence: 0.3 }))
      const { itemId } = await scanOne(ctx)

      await run(ctx, itemId, 'recognise')
      await run(ctx, itemId, 'recognise')

      expect(pushes(ctx)).toHaveLength(1)
    })

    it('says nothing when another call moved the item first, so the guarded update did not apply', async () => {
      const ctx = setup()
      ctx.recognizer.respondWith(() => seen({ confidence: 0.3 }))
      const { itemId } = await scanOne(ctx)
      const read = ctx.recognizer.recognize.bind(ctx.recognizer)
      vi.spyOn(ctx.recognizer, 'recognize').mockImplementationOnce(async (image) => {
        const answer = await read(image)
        await ctx.repository.updateItem(itemId, 'recognising', { state: 'failed', reason: 'unavailable', updatedAt: ctx.now() })
        return answer
      })

      await run(ctx, itemId, 'recognise')

      expect(pushes(ctx)).toEqual([])
    })
  })

  describe('when an item needs identifying (the third unreadable front photo)', () => {
    const FACE: Recognition = { classification: 'face-or-person' }
    const OTHER_PRODUCT: Recognition = { classification: 'other-product' }
    const needsYouPushes = (ctx: Ctx) => pushes(ctx).filter((body) => body.kind === 'scan-needs-you')
    /** The first two photos of a scan made by `OTHER_USER`'s profile have been unreadable; a third has been retaken and waits to be read. */
    const thirdPhotoWaiting = async (ctx: Ctx) => {
      const scan = await create(ctx, [markedJpeg(1)], { userId: OTHER_USER, profileId: OTHER_PROFILE })
      const itemId = scan.items[0].id as string
      for (const [i, read] of [BLURRY, TURNED_AWAY, BLURRY].entries()) {
        ctx.recognizer.respondWith(() => read)
        if (i > 0) {
          ctx.advance(SECOND)
          await retake(ctx, scan.id, itemId, markedJpeg(20 + i), { userId: OTHER_USER, profileId: OTHER_PROFILE })
        }
        if (i < 2) await run(ctx, itemId, 'recognise')
      }
      return { scanId: scan.id as string, itemId }
    }

    it('tells the profile that made the scan, once, with a key that is the scan and the need', async () => {
      const ctx = setup()
      const { scanId, itemId } = await thirdPhotoWaiting(ctx)
      expect(pushes(ctx)).toEqual([])

      await run(ctx, itemId, 'recognise')

      expect((await ctx.repository.findItem(itemId))!.state).toBe('needs-identification')
      // Only this push: the scan is not done while an item waits for the person, so there is no finished push either.
      expect(pushes(ctx)).toEqual([{ kind: 'scan-needs-you', userId: OTHER_USER, profileId: OTHER_PROFILE, scanId, itemId, need: 'identify' }])
      expect(keys(ctx)).toEqual([`scan-needs-you:${scanId}:identify`])
      expect(ctx.pushJobs.enqueued[0]!.job).toBe('send-push')
    })

    it.each([
      ['the first', [BLURRY]],
      ['the second', [TURNED_AWAY, BLURRY]],
    ])('says nothing when %s photo is unreadable, since the item only asks for a retake', async (_which, reads) => {
      const ctx = setup()

      const { scanId, itemId } = await failedFront(ctx, reads)

      expect((await stateOf(ctx, scanId, itemId)).state).toBe('needs-retake')
      expect(pushes(ctx)).toEqual([])
    })

    it.each([
      ['a face on the first photo', [FACE]],
      ['another product on the first photo', [OTHER_PRODUCT]],
      ['a face on the third photo, after two unreadable ones', [BLURRY, BLURRY, FACE]],
      ['another product on the third photo, after two unreadable ones', [BLURRY, TURNED_AWAY, OTHER_PRODUCT]],
    ])('says nothing to identify for %s: a rejected photo is not an unreadable one', async (_label, reads) => {
      const ctx = setup()

      const { scanId, itemId } = await failedFront(ctx, reads)

      expect((await stateOf(ctx, scanId, itemId)).state).toBe('rejected')
      expect(needsYouPushes(ctx)).toEqual([])
    })

    it('says it once when the same step is delivered twice', async () => {
      const ctx = setup()
      const { itemId } = await failedFront(ctx, [BLURRY, BLURRY, BLURRY])

      await run(ctx, itemId, 'recognise')

      expect(pushes(ctx)).toHaveLength(1)
    })

    it('says nothing when another call moved the item first, so the guarded update did not apply', async () => {
      const ctx = setup()
      const { scanId, itemId } = await failedFront(ctx, [BLURRY, BLURRY])
      ctx.advance(SECOND)
      await retake(ctx, scanId, itemId, markedJpeg(30))
      ctx.recognizer.respondWith(() => BLURRY)
      const read = ctx.recognizer.recognize.bind(ctx.recognizer)
      vi.spyOn(ctx.recognizer, 'recognize').mockImplementationOnce(async (image) => {
        const answer = await read(image)
        await ctx.repository.updateItem(itemId, 'recognising', { state: 'failed', reason: 'unavailable', updatedAt: ctx.now() })
        return answer
      })

      await run(ctx, itemId, 'recognise')

      expect((await stateOf(ctx, scanId, itemId)).state).toBe('failed')
      expect(needsYouPushes(ctx)).toEqual([])
    })

    it('still moves the item to identification, and the step succeeds, when the push cannot be queued', async () => {
      const ctx = setup()
      const logged = quiet()
      const { scanId, itemId } = await failedFront(ctx, [BLURRY, BLURRY])
      ctx.advance(SECOND)
      await retake(ctx, scanId, itemId, markedJpeg(30))
      ctx.recognizer.respondWith(() => BLURRY)
      ctx.pushJobs.failNextWith(new Error('queue is down'))

      await expect(run(ctx, itemId, 'recognise')).resolves.toBeUndefined()

      expect(await stateOf(ctx, scanId, itemId)).toMatchObject({ state: 'needs-identification' })
      // The push was tried (and its failure logged by kind and scan), not skipped.
      expect(logged).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'push-enqueue-failed', kind: 'scan-needs-you', scanId }))
      expect(pushes(ctx)).toEqual([])
      logged.mockRestore()
    })
  })

  describe('when an item needs the back of the pack', () => {
    const unreadable = (ctx: Ctx) => ctx.labelReader.respondWith(() => ({ readable: false }))
    const addBack = (ctx: Ctx, scanId: string, itemId: string, marker: number) => asUser(() => ctx.service.addBackPhoto(scanId, itemId, markedJpeg(marker), IP))
    /** Reads the back photo the item holds as unreadable, then uploads the next one. */
    const failOneRead = async (ctx: Ctx, scanId: string, itemId: string, marker: number) => {
      unreadable(ctx)
      await run(ctx, itemId, 'read-label')
      await addBack(ctx, scanId, itemId, marker)
    }
    /** An item whose `n`th back photo (1-based) has just been uploaded, the first `n - 1` having been read as unreadable. */
    const readingBackPhoto = async (ctx: Ctx, n: number) => {
      const { scanId, itemId } = await reach(ctx, 'reading-label')
      for (let i = 1; i < n; i++) await failOneRead(ctx, scanId, itemId, 10 + i)
      return { scanId, itemId }
    }

    it('asks for it when the research finds no ingredients, with no ask number, keyed by the scan and the need', async () => {
      const ctx = setup()

      const { scanId, itemId } = await reach(ctx, 'needs-back-photo')

      expect(pushes(ctx)).toEqual([{ kind: 'scan-needs-you', userId: USER, profileId: PROFILE, scanId, itemId, need: 'back-photo' }])
      expect(keys(ctx)).toEqual([`scan-needs-you:${scanId}:back-photo`])
    })

    it('asks nothing of the person when the research found the ingredients', async () => {
      const ctx = setup()

      await analysingItem(ctx)

      expect(pushes(ctx)).toEqual([])
    })

    it('asks once when the same research step is delivered twice', async () => {
      const ctx = setup()
      const { itemId } = await reach(ctx, 'needs-back-photo')

      await run(ctx, itemId, 'research')

      expect(pushes(ctx)).toHaveLength(1)
    })

    it('asks nothing when another call moved the item first, so the guarded update did not apply', async () => {
      const ctx = setup()
      const { itemId } = await reach(ctx, 'researching')
      const research = ctx.catalog.research.bind(ctx.catalog)
      vi.spyOn(ctx.catalog, 'research').mockImplementationOnce(async (productId) => {
        const result = await research(productId)
        await ctx.repository.updateItem(itemId, 'researching', { state: 'failed', reason: 'unavailable', updatedAt: ctx.now() })
        return result
      })

      await run(ctx, itemId, 'research')

      expect(pushes(ctx)).toEqual([])
    })

    it.each([1, 2])('asks again as ask number %i when that many back photos have been unreadable, under a key of its own', async (n) => {
      const ctx = setup()
      const { scanId, itemId } = await readingBackPhoto(ctx, n)
      unreadable(ctx)

      await run(ctx, itemId, 'read-label')

      expect(pushes(ctx).at(-1)).toEqual({ kind: 'scan-needs-you', userId: USER, profileId: PROFILE, scanId, itemId, need: 'back-photo', ask: n })
      // The first ask keeps its key; each re-ask is one more push.
      expect(keys(ctx)).toEqual([`scan-needs-you:${scanId}:back-photo`, ...Array.from({ length: n }, (_, i) => `scan-needs-you:${scanId}:${itemId}:ask-${i + 1}`)])
    })

    it('does not ask a third time: the 3rd unreadable back photo ends the item as failed with no push', async () => {
      const ctx = setup()
      const { scanId, itemId } = await readingBackPhoto(ctx, 3)
      const before = keys(ctx)
      expect(before).toEqual([`scan-needs-you:${scanId}:back-photo`, `scan-needs-you:${scanId}:${itemId}:ask-1`, `scan-needs-you:${scanId}:${itemId}:ask-2`])
      unreadable(ctx)

      await run(ctx, itemId, 'read-label')

      expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'failed', reason: 'label-unreadable' })
      expect(keys(ctx).filter((key) => key.includes('needs-you'))).toEqual(before)
    })

    it('does not ask again when another call moved the item first, so the guarded update did not apply', async () => {
      const ctx = setup()
      const { itemId } = await readingBackPhoto(ctx, 1)
      const before = pushes(ctx).length
      vi.spyOn(ctx.labelReader, 'read').mockImplementationOnce(async () => {
        await ctx.repository.updateItem(itemId, 'reading-label', { state: 'failed', reason: 'unavailable', updatedAt: ctx.now() })
        return { readable: false }
      })

      await run(ctx, itemId, 'read-label')

      expect(pushes(ctx)).toHaveLength(before)
    })

    it('still moves the item on when the push cannot be queued', async () => {
      const ctx = setup()
      const logged = quiet()
      const { scanId, itemId } = await reach(ctx, 'researching')
      ctx.pushJobs.failNextWith(new Error('queue is down'))

      await expect(run(ctx, itemId, 'research')).resolves.toBeUndefined()

      expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'needs-back-photo', reason: null })
      logged.mockRestore()
    })
  })

  describe('when an item with no product has an unreadable back photo', () => {
    const unreadable = (ctx: Ctx) => ctx.labelReader.respondWith(() => ({ readable: false }))
    /** An item with no product that has had `n` back photos uploaded, the first `n - 1` read as unreadable, the last waiting to be read. */
    const readingBackPhoto = async (ctx: Ctx, n: number) => {
      const taken = await readingUnidentified(ctx)
      for (let i = 1; i < n; i++) {
        unreadable(ctx)
        await run(ctx, taken.itemId, 'read-label')
        ctx.advance(SECOND)
        await sendBack(ctx, taken.scanId, taken.itemId, 10 + i)
      }
      return taken
    }
    const needsYouKeys = (ctx: Ctx) => keys(ctx).filter((key) => key.startsWith('scan-needs-you'))

    it.each([1, 2])('asks it to be identified again, as ask number %i, not for another photo of the back, under an item-scoped key', async (n) => {
      const ctx = setup()
      const { scanId, itemId } = await readingBackPhoto(ctx, n)
      const before = pushes(ctx).length
      unreadable(ctx)

      await run(ctx, itemId, 'read-label')

      expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'needs-identification', reason: 'label-unreadable' })
      // Exactly one push is added by this read, and it is the identify need.
      expect(pushes(ctx).slice(before)).toEqual([{ kind: 'scan-needs-you', userId: USER, profileId: PROFILE, scanId, itemId, need: 'identify', ask: n }])
      expect(keys(ctx).at(-1)).toBe(`scan-needs-you:${scanId}:${itemId}:ask-${n}`)
    })

    it('does not ask a third time: the 3rd unreadable back photo ends the item as failed with no needs-you push', async () => {
      const ctx = setup()
      const { scanId, itemId } = await readingBackPhoto(ctx, 3)
      const before = needsYouKeys(ctx)
      expect(before.slice(-2)).toEqual([`scan-needs-you:${scanId}:${itemId}:ask-1`, `scan-needs-you:${scanId}:${itemId}:ask-2`])
      // The two asks so far were to identify the item, not for a photo of the back.
      expect(pushes(ctx).slice(-2).map((body) => body.kind === 'scan-needs-you' && body.need)).toEqual(['identify', 'identify'])
      const sent = pushes(ctx).length
      unreadable(ctx)

      await run(ctx, itemId, 'read-label')

      expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'failed', reason: 'label-unreadable' })
      expect(needsYouKeys(ctx)).toEqual(before)
      // The only push this read adds is the scan's own finish: its single item is now final.
      expect(pushes(ctx).slice(sent)).toEqual([{ kind: 'scan-finished', userId: USER, profileId: PROFILE, scanId, readyCount: 0 }])
    })
  })

  describe('when a scan is finished', () => {
    const recogniseAs = (ctx: Ctx, answer: (marker: number) => Recognition) => ctx.recognizer.respondWith((image) => answer(image.bytes.at(-1)!))

    it('tells the profile that made the scan, once, with readyCount 0 when nothing came out ready', async () => {
      const ctx = setup()
      ctx.recognizer.respondWith(() => ({ classification: 'face-or-person' }))
      const scan = await create(ctx)

      await run(ctx, scan.items[0].id, 'recognise')

      expect(pushes(ctx)).toEqual([{ kind: 'scan-finished', userId: USER, profileId: PROFILE, scanId: scan.id, readyCount: 0 }])
      expect(keys(ctx)).toEqual([`scan-finished:${scan.id}`])
    })

    it('counts only the items that are ready: 2 ready, 1 rejected and 1 failed make readyCount 2, sent by the last item to finish and no earlier', async () => {
      const ctx = setup()
      await catalogued(ctx)
      recogniseAs(ctx, (marker) => {
        if (marker === 3) return { classification: 'face-or-person' }
        if (marker === 4) throw new AiBudgetExceededError('cap')
        return seen()
      })
      const scan = await create(ctx, [markedJpeg(1), markedJpeg(2), markedJpeg(3), markedJpeg(4)])
      const [a, b, c, d] = scan.items.map((i: { id: string }) => i.id) as [string, string, string, string]
      for (const id of [a, b, c, d]) await run(ctx, id, 'recognise')
      expect(await stateOf(ctx, scan.id, c)).toEqual({ state: 'rejected', reason: 'face-or-person' })
      expect(await stateOf(ctx, scan.id, d)).toEqual({ state: 'failed', reason: 'research-busy' })
      await run(ctx, a, 'match')
      expect(pushes(ctx)).toEqual([])

      await run(ctx, b, 'match')

      expect(pushes(ctx)).toEqual([{ kind: 'scan-finished', userId: USER, profileId: PROFILE, scanId: scan.id, readyCount: 2 }])
    })

    it('queues the push before the live done goes out', async () => {
      let events!: ProbeEvents
      const ctx = setup({ events: () => (events = new ProbeEvents()) })
      let queuedWhenDoneWent = -1
      events.onDone = () => void (queuedWhenDoneWent = ctx.pushJobs.enqueued.length)
      ctx.recognizer.respondWith(() => ({ classification: 'face-or-person' }))
      const scan = await create(ctx)

      await run(ctx, scan.items[0].id, 'recognise')

      expect(queuedWhenDoneWent).toBe(1)
      expect(events.eventsFor(scan.id).map((e) => e.type)).toEqual(['item', 'done'])
    })

    it('queues the push though the live done cannot be published, and the step still succeeds', async () => {
      let events!: DoneFlaky
      const ctx = setup({ events: () => (events = new DoneFlaky()) })
      const logged = quiet()
      ctx.recognizer.respondWith(() => ({ classification: 'face-or-person' }))
      const scan = await create(ctx)
      events.failing = true

      await expect(run(ctx, scan.items[0].id, 'recognise')).resolves.toBeUndefined()

      expect(keys(ctx)).toEqual([`scan-finished:${scan.id}`])
      logged.mockRestore()
    })

    it('queues the same key again when the reaper re-claims a done whose live publish failed, so the job system sends it once', async () => {
      let events!: DoneFlaky
      const ctx = setup({ events: () => (events = new DoneFlaky()) })
      const logged = quiet()
      ctx.recognizer.respondWith(() => ({ classification: 'face-or-person' }))
      const scan = await create(ctx)
      events.failing = true
      await run(ctx, scan.items[0].id, 'recognise')
      expect((await ctx.repository.findScan(scan.id))!.doneAt).toBeNull()
      expect(pushes(ctx)).toHaveLength(1)
      events.failing = false
      ctx.advance(SETTLED + 1)

      await reap(ctx)

      expect((await ctx.repository.findScan(scan.id))!.doneAt).not.toBeNull()
      expect(pushes(ctx)).toHaveLength(2)
      expect(pushes(ctx)[1]).toEqual(pushes(ctx)[0])
      expect(keys(ctx)).toEqual([`scan-finished:${scan.id}`, `scan-finished:${scan.id}`])
      logged.mockRestore()
    })

    it('queues the push when the reaper sends a done that was lost with the item\'s own publish', async () => {
      let events!: AllFlaky
      const ctx = setup({ events: () => (events = new AllFlaky()) })
      const logged = quiet()
      ctx.recognizer.respondWith(() => ({ classification: 'face-or-person' }))
      const scan = await create(ctx)
      events.failing = true
      await run(ctx, scan.items[0].id, 'recognise')
      events.failing = false
      expect(pushes(ctx)).toEqual([])
      ctx.advance(SETTLED + 1)

      await reap(ctx)

      expect(pushes(ctx)).toEqual([{ kind: 'scan-finished', userId: USER, profileId: PROFILE, scanId: scan.id, readyCount: 0 }])
      logged.mockRestore()
    })

    it('queues the push when watch itself sets the done time of a scan whose last change went unpublished', async () => {
      let events!: AllFlaky
      const ctx = setup({ events: () => (events = new AllFlaky()) })
      const logged = quiet()
      ctx.recognizer.respondWith(() => ({ classification: 'face-or-person' }))
      const scan = await create(ctx)
      events.failing = true
      await run(ctx, scan.items[0].id, 'recognise')
      events.failing = false
      expect(pushes(ctx)).toEqual([])

      await watch(ctx, scan.id)

      expect(keys(ctx)).toEqual([`scan-finished:${scan.id}`])
      logged.mockRestore()
    })

    it('does not push again when watch re-sends done to a client of a scan that was already marked done', async () => {
      const ctx = setup()
      ctx.recognizer.respondWith(() => ({ classification: 'face-or-person' }))
      const scan = await create(ctx)
      await run(ctx, scan.items[0].id, 'recognise')
      expect(pushes(ctx)).toHaveLength(1)

      await watch(ctx, scan.id)

      expect(ctx.events.eventsFor(scan.id).filter((e) => e.type === 'done')).toHaveLength(2)
      expect(pushes(ctx)).toHaveLength(1)
    })

    it('sends the needs-you push but no finished one while an item still waits for the person', async () => {
      const ctx = setup()
      ctx.recognizer.respondWith((image) => (image.bytes.at(-1) === 1 ? { classification: 'face-or-person' } : seen({ confidence: 0.2 })))
      const scan = await create(ctx, [markedJpeg(1), markedJpeg(2)])

      await run(ctx, scan.items[0].id, 'recognise')
      await run(ctx, scan.items[1].id, 'recognise')

      expect(keys(ctx)).toEqual([`scan-needs-you:${scan.id}:confirm`])
    })

    it('finishes the scan, publishing done, though the push cannot be queued', async () => {
      const ctx = setup()
      const logged = quiet()
      ctx.recognizer.respondWith(() => ({ classification: 'face-or-person' }))
      const scan = await create(ctx)
      ctx.pushJobs.failNextWith(new Error('queue is down'))

      await expect(run(ctx, scan.items[0].id, 'recognise')).resolves.toBeUndefined()

      expect(ctx.events.eventsFor(scan.id).map((e) => e.type)).toEqual(['item', 'done'])
      expect((await ctx.repository.findScan(scan.id))!.doneAt).not.toBeNull()
      logged.mockRestore()
    })
  })

  // A problem with the push must never get in the way of the scan: the item stays moved, the live done goes out, and what is
  // owed is logged by id and left for the reaper.
  describe('when the push cannot be prepared', () => {
    const readFails = (ctx: Ctx) => vi.spyOn(ctx.repository, 'findScan').mockRejectedValueOnce(new Error('D1 is down'))

    it('still publishes done and resolves when the finished push\'s scan read throws, logging push-failed and clearing the done time', async () => {
      const ctx = setup()
      const logged = quiet()
      ctx.recognizer.respondWith(() => ({ classification: 'face-or-person' }))
      const scan = await create(ctx)
      readFails(ctx)

      await expect(run(ctx, scan.items[0].id, 'recognise')).resolves.toBeUndefined()

      expect(ctx.events.eventsFor(scan.id).map((e) => e.type)).toEqual(['item', 'done'])
      expect(logged).toHaveBeenCalledWith({ outcome: 'push-failed', scanId: scan.id })
      expect(logged).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: 'publish-failed' }))
      expect(pushes(ctx)).toEqual([])
      expect((await ctx.repository.findScan(scan.id))!.doneAt).toBeNull()
      logged.mockRestore()
    })

    it('has the reaper re-claim that done and queue the finished push under the same key', async () => {
      const ctx = setup()
      const logged = quiet()
      ctx.recognizer.respondWith(() => ({ classification: 'face-or-person' }))
      const scan = await create(ctx)
      readFails(ctx)
      await run(ctx, scan.items[0].id, 'recognise')
      ctx.advance(SETTLED + 1)

      await reap(ctx)

      expect(pushes(ctx)).toEqual([{ kind: 'scan-finished', userId: USER, profileId: PROFILE, scanId: scan.id, readyCount: 0 }])
      expect(keys(ctx)).toEqual([`scan-finished:${scan.id}`])
      expect((await ctx.repository.findScan(scan.id))!.doneAt).not.toBeNull()
      logged.mockRestore()
    })

    it('keeps the item moved, resolves and logs push-failed with the item when the needs-you push\'s scan read throws', async () => {
      const ctx = setup()
      const logged = quiet()
      ctx.recognizer.respondWith(() => seen({ confidence: 0.3 }))
      const { scanId, itemId } = await scanOne(ctx)
      readFails(ctx)

      await expect(run(ctx, itemId, 'recognise')).resolves.toBeUndefined()

      expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'needs-confirmation', reason: null })
      expect(logged).toHaveBeenCalledWith({ outcome: 'push-failed', scanId, itemId })
      expect(pushes(ctx)).toEqual([])
      logged.mockRestore()
    })
  })

  // Scans the old Worker wrote without a profile have no phones to tell until the reaper adopts them.
  describe('for a scan with no profile (written before profiles)', () => {
    const withOrphan = async () => {
      const ctx = setup()
      const scanId = 'orphan-scan'
      const itemId = 'orphan-item'
      const photoKey = 'photos/test/user-1/orphan-scan/orphan-item.jpg'
      await ctx.photos.put(photoKey, markedJpeg(1))
      await ctx.repository.createScan(
        { id: scanId, kind: 'product', userId: USER, profileId: null as unknown as string, ipHash: 'ip', createdAt: ctx.now() },
        [{ id: 'orphan-photo', scanId, userId: USER, position: 0, photoKey: null, createdAt: ctx.now() }],
        [{ id: itemId, scanId, userId: USER, position: 0, photoId: 'orphan-photo', photoKey, createdAt: ctx.now() }],
      )
      return { ctx, scanId, itemId }
    }

    it('skips the finished push, logging push-skipped-no-profile, and still publishes done', async () => {
      const { ctx, scanId, itemId } = await withOrphan()
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
      ctx.recognizer.respondWith(() => ({ classification: 'face-or-person' }))

      await expect(run(ctx, itemId, 'recognise')).resolves.toBeUndefined()

      expect(pushes(ctx)).toEqual([])
      expect(log).toHaveBeenCalledWith({ outcome: 'push-skipped-no-profile', scanId })
      expect(ctx.events.eventsFor(scanId).map((e) => e.type)).toEqual(['item', 'done'])
      log.mockRestore()
    })

    it('skips the needs-you push, logging push-skipped-no-profile, and still moves the item', async () => {
      const { ctx, scanId, itemId } = await withOrphan()
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
      ctx.recognizer.respondWith(() => seen({ confidence: 0.3 }))

      await expect(run(ctx, itemId, 'recognise')).resolves.toBeUndefined()

      expect(pushes(ctx)).toEqual([])
      expect(log).toHaveBeenCalledWith({ outcome: 'push-skipped-no-profile', scanId })
      expect((await ctx.repository.findItem(itemId))!.state).toBe('needs-confirmation')
      log.mockRestore()
    })

    it('skips the identify push, logging push-skipped-no-profile, and still moves the item to identification', async () => {
      const { ctx, scanId, itemId } = await withOrphan()
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined)
      ctx.recognizer.respondWith(() => BLURRY)
      await run(ctx, itemId, 'recognise')
      // Nobody owns an orphan, so the service cannot take a retake for it; the retakes are written the way the service writes them.
      for (const n of [1, 2]) {
        ctx.advance(SECOND)
        const key = `photos/test/${USER}/${scanId}/${itemId}.jpg`
        await ctx.photos.put(key, markedJpeg(20 + n))
        const retaken = { id: `retake-${n}`, itemId, userId: USER, ipHash: 'ip', uploadedAt: ctx.now() }
        await ctx.repository.updateItem(itemId, 'needs-retake', { state: 'recognising', reason: null, photoKey: key, updatedAt: ctx.now() }, undefined, retaken)
        await run(ctx, itemId, 'recognise')
      }

      expect(pushes(ctx)).toEqual([])
      expect(log).toHaveBeenCalledWith({ outcome: 'push-skipped-no-profile', scanId })
      expect((await ctx.repository.findItem(itemId))!.state).toBe('needs-identification')
      log.mockRestore()
    })
  })
})

// ---- shelf scans: one photo of several products (#74, part 3) ----

const createShelf = (ctx: Ctx, photos: ProductImage[] = [markedJpeg(1)], over: { ip?: string; userId?: string; profileId?: string } = {}): Promise<any> =>
  asUser(() => ctx.service.createShelf({ photos, clientIp: over.ip ?? IP }), over.userId ?? USER, over.profileId ?? PROFILE)

const shelfProduct = (name: string, confidence = 0.9, over: Partial<ShelfProduct> = {}): ShelfProduct => ({ brand: 'Glow Co', name, category: 'skin', confidence, ...over })
const shelfRead = (products: ShelfProduct[], over: Partial<ShelfRecognition> = {}): ShelfRecognition => ({
  classification: 'beauty-product',
  products,
  excluded: { otherProducts: 0, unreadable: 0 },
  ...over,
})
/** `count` distinct products, most confident first, as the recognizer lists them: Product 0 at 0.95, then 0.05 less each. */
const shelfList = (count: number): ShelfProduct[] => Array.from({ length: count }, (_, i) => shelfProduct(`Product ${i}`, Math.round((0.95 - i * 0.05) * 100) / 100))
const NOTHING_READ = (classification: 'other-product' | 'face-or-person' | 'unreadable', excluded = { otherProducts: 0, unreadable: 0 }): ShelfRecognition => ({ classification, products: [], excluded })

/** A shelf scan of the given photos, created. `itemIds` are the placeholders, one per photo. */
const shelfScan = async (ctx: Ctx, photos: ProductImage[] = [markedJpeg(1)], over: { ip?: string; userId?: string; profileId?: string } = {}) => {
  const scan = await createShelf(ctx, photos, over)
  const itemIds = scan.items.map((i: { id: string }) => i.id) as string[]
  return { scanId: scan.id as string, itemIds, itemId: itemIds[0]! }
}
const answerShelf = (ctx: Ctx, read: ShelfRecognition) => ctx.recognizer.respondToShelfWith(() => read)
/** position, recognised name and state of each item the scan holds, in position order. */
const shape = async (ctx: Ctx, scanId: string) => (await ctx.repository.itemsOf(scanId)).map((i) => [i.position, i.recognisedName, i.state])
const photoRow = async (ctx: Ctx, scanId: string, position = 0) => (await ctx.repository.photosOf(scanId))[position]!
const shelfKey = (scanId: string, photoId: string, extension = 'jpg', userId = USER) => `photos/test/${userId}/${scanId}/${photoId}.${extension}`
const matchesQueued = (ctx: Ctx) => queued(ctx).filter((m) => m.step === 'match').map((m) => m.itemId)

describe('SCAN_POLICY: shelf scans', () => {
  it('allows 3 shelf photos and 20 items in a scan', () => {
    expect(SCAN_POLICY.maxShelfPhotos).toBe(3)
    expect(SCAN_POLICY.maxItemsPerScan).toBe(20)
  })
})

describe('ScanService.createShelf', () => {
  it('makes a scan of kind shelf, with one recognising placeholder item per photo, in photo order, at slot positions 0, 5 and 10', async () => {
    const ctx = setup()

    const scan = await createShelf(ctx, [markedJpeg(1), webpPhoto(), markedJpeg(3)])

    expect(scan).toMatchObject({ id: expect.any(String), createdAt: T0 })
    expect(scan.items.map((i: { position: number; state: string; reason: unknown }) => [i.position, i.state, i.reason])).toEqual([
      [0, 'recognising', null],
      [5, 'recognising', null],
      [10, 'recognising', null],
    ])
    expect((await ctx.repository.findScan(scan.id))!.kind).toBe('shelf')
  })

  it('records one photo per uploaded photo at positions 0, 1, 2, each holding its own image under photos/<environment>/<user>/<scan>/<photoId>.<jpg|webp>', async () => {
    const ctx = setup()
    const [first, second] = [markedJpeg(1), webpPhoto()]

    const scan = await createShelf(ctx, [first, second])

    const photos = await ctx.repository.photosOf(scan.id)
    expect(photos.map((p) => [p.position, p.state, p.userId, p.scanId])).toEqual([
      [0, 'recognising', USER, scan.id],
      [1, 'recognising', USER, scan.id],
    ])
    expect(photos.map((p) => p.photoKey)).toEqual([shelfKey(scan.id, photos[0]!.id, 'jpg'), shelfKey(scan.id, photos[1]!.id, 'webp')])
    expect(ctx.photos.stored.get(photos[0]!.photoKey!)).toEqual(first)
    expect(ctx.photos.stored.get(photos[1]!.photoKey!)).toEqual(second)
    expect(ctx.photos.stored.size).toBe(2)
  })

  it('points each placeholder at its photo and gives it no image of its own', async () => {
    const ctx = setup()

    const scan = await createShelf(ctx, [markedJpeg(1), markedJpeg(2)])

    const photos = await ctx.repository.photosOf(scan.id)
    const items = await ctx.repository.itemsOf(scan.id)
    expect(items.map((i) => i.photoId)).toEqual(photos.map((p) => p.id))
    expect(items.map((i) => i.photoKey)).toEqual([null, null])
  })

  it('enqueues one recognise job per placeholder and nothing else', async () => {
    const ctx = setup()

    const scan = await createShelf(ctx, [markedJpeg(1), markedJpeg(2)])

    expect(queued(ctx)).toEqual(scan.items.map((i: { id: string }) => advanceMessage(i.id, 'recognise')))
  })

  it('accepts 3 photos and refuses 4 as TOO_MANY_IMAGES, naming 3, keeping nothing', async () => {
    const three = Array.from({ length: 3 }, (_, i) => markedJpeg(i))
    expect((await createShelf(setup(), three)).items).toHaveLength(3)

    const ctx = setup()
    const error = await errorOf(createShelf(ctx, [...three, markedJpeg(4)]))

    expect(error).toBeInstanceOf(ValidationError)
    expect(error.code).toBe('TOO_MANY_IMAGES')
    expect(error.message).toContain('3')
    expect(ctx.photos.stored.size).toBe(0)
    expect(ctx.jobs.enqueued).toEqual([])
  })

  it('refuses a scan with no photo as NO_IMAGES', async () => {
    const ctx = setup()

    const error = await errorOf(createShelf(ctx, []))

    expect(error).toBeInstanceOf(ValidationError)
    expect(error.code).toBe('NO_IMAGES')
  })

  it.each([
    ['a PNG', () => pngPhoto(), 'UNSUPPORTED_IMAGE'],
    ['a photo 1601 pixels wide', () => jpegPhoto({ width: 1601, height: 600 }), 'IMAGE_TOO_LARGE'],
    ['a photo one byte over 2,000,000', () => jpegPhoto({ size: 2_000_001 }), 'IMAGE_TOO_LARGE'],
  ])('refuses the whole scan, storing none of its photos, when one photo is %s', async (_label, make, code) => {
    const ctx = setup()

    const error = await errorOf(createShelf(ctx, [markedJpeg(1), make()]))

    expect(error.code).toBe(code)
    expect(ctx.photos.stored.size).toBe(0)
    expect(ctx.jobs.enqueued).toEqual([])
  })

  it('refuses a public caller with AUTH_REQUIRED and keeps nothing', async () => {
    const ctx = setup()

    const error = await errorOf(runAs({ kind: 'public' }, () => ctx.service.createShelf({ photos: [markedJpeg(1)], clientIp: IP })))

    expect(error).toBeInstanceOf(UnauthorizedError)
    expect(ctx.photos.stored.size).toBe(0)
  })

  describe('daily quotas, one per photo', () => {
    it('lets a user reach the daily limit with shelf photos and refuses the photo past it, keeping nothing of the refused scan', async () => {
      const ctx = setup({ policy: { dailyPhotosPerUser: 4 } })
      await createShelf(ctx, [markedJpeg(1), markedJpeg(2), markedJpeg(3)])
      const stored = ctx.photos.stored.size
      const enqueued = ctx.jobs.enqueued.length

      const error = await errorOf(createShelf(ctx, [markedJpeg(4), markedJpeg(5)]))

      expect(error).toBeInstanceOf(RateLimitedError)
      expect(error.code).toBe('SCAN_DAILY_LIMIT')
      expect(ctx.photos.stored.size).toBe(stored)
      expect(ctx.jobs.enqueued).toHaveLength(enqueued)
      // One photo takes the user to exactly 4: allowed.
      await expect(createShelf(ctx, [markedJpeg(6)])).resolves.toMatchObject({ id: expect.any(String) })
    })

    it('counts a photo for the address too: the daily limit per IP is reached by one photo per placeholder, whoever made the scans', async () => {
      const ctx = setup({ policy: { dailyPhotosPerIp: 3 } })
      await create(ctx, [markedJpeg(1)], { userId: OTHER_USER, profileId: OTHER_PROFILE })

      const error = await errorOf(createShelf(ctx, [markedJpeg(2), markedJpeg(3), markedJpeg(4)]))
      expect(error.code).toBe('SCAN_DAILY_LIMIT')

      await expect(createShelf(ctx, [markedJpeg(2), markedJpeg(3)])).resolves.toMatchObject({ id: expect.any(String) })
    })
  })

  it('deletes the photos it already put when the scan cannot be saved, rethrows, and enqueues nothing', async () => {
    class SaveFails extends FakeScansRepository {
      override async createScan(): Promise<void> {
        throw new Error('database is down')
      }
    }
    const ctx = setup({ repository: new SaveFails() })

    await expect(createShelf(ctx, [markedJpeg(1), webpPhoto()])).rejects.toThrow('database is down')

    expect(ctx.photos.stored.size).toBe(0)
    expect(ctx.jobs.enqueued).toEqual([])
  })

  it('puts the photos before it saves the scan, so a saved photo never points at a missing image', async () => {
    const present: boolean[] = []
    class Probe extends FakeScansRepository {
      constructor(private readonly store: MemoryPhotoStore) {
        super()
      }
      override async createScan(...[scan, photos, items]: Parameters<FakeScansRepository['createScan']>): Promise<void> {
        for (const photo of photos) present.push(photo.photoKey !== null && (await this.store.get(photo.photoKey)) !== null)
        return super.createScan(scan, photos, items)
      }
    }
    const photos = new MemoryPhotoStore({ environment: 'test' })
    const ctx = setup({ photos, repository: new Probe(photos) })

    await createShelf(ctx, [markedJpeg(1), markedJpeg(2)])

    expect(present).toEqual([true, true])
  })

  it('fails a placeholder as unavailable when its recognise job cannot be queued, and queues the others', async () => {
    const ctx = setup()
    ctx.jobs.failNextWith(new Error('queue is down'))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const scan = await createShelf(ctx, [markedJpeg(1), markedJpeg(2)])

    expect(scan.items.map((i: { state: string; reason: unknown }) => [i.state, i.reason])).toEqual([
      ['failed', 'unavailable'],
      ['recognising', null],
    ])
    expect(queued(ctx)).toEqual([advanceMessage(scan.items[1].id, 'recognise')])
  })
})

describe('ScanService.advance: recognise, a shelf photo with products', () => {
  it('turns a photo of 3 products into 3 items at slots 0, 1, 2, the placeholder taking the first, every one pointing at the photo', async () => {
    const ctx = setup()
    answerShelf(ctx, shelfRead(shelfList(3)))
    const { scanId, itemId } = await shelfScan(ctx)
    ctx.advance(SECOND)

    await run(ctx, itemId, 'recognise')

    expect(await shape(ctx, scanId)).toEqual([
      [0, 'Product 0', 'matching'],
      [1, 'Product 1', 'matching'],
      [2, 'Product 2', 'matching'],
    ])
    const items = await ctx.repository.itemsOf(scanId)
    expect(items[0]!.id).toBe(itemId)
    expect(new Set(items.map((i) => i.id)).size).toBe(3)
    const photo = await photoRow(ctx, scanId)
    expect(items.map((i) => i.photoId)).toEqual([photo.id, photo.id, photo.id])
    expect(items.map((i) => i.photoKey)).toEqual([null, null, null])
    expect(items.map((i) => i.recognisedBrand)).toEqual(['Glow Co', 'Glow Co', 'Glow Co'])
    expect(items.map((i) => i.recognisedConfidence)).toEqual([0.95, 0.9, 0.85])
    // A new item is made when it is read.
    expect(items.slice(1).map((i) => i.createdAt)).toEqual([new Date(T0.getTime() + SECOND), new Date(T0.getTime() + SECOND)])
  })

  it('reads the photo\'s own image once, and no product scan\'s recognizer', async () => {
    const ctx = setup()
    answerShelf(ctx, shelfRead(shelfList(2)))
    const shelfPhoto = markedJpeg(7)
    const { itemId } = await shelfScan(ctx, [shelfPhoto])

    await run(ctx, itemId, 'recognise')

    expect(ctx.recognizer.shelfCalls).toEqual([shelfPhoto])
    expect(ctx.recognizer.calls).toEqual([])
  })

  it('files each product\'s variant and form, and leaves them null when the product has none', async () => {
    const ctx = setup()
    answerShelf(ctx, shelfRead([shelfProduct('Serum', 0.9, { variant: 'Night', form: 'serum' }), shelfProduct('Plain Soap', 0.8)]))
    const { scanId, itemId } = await shelfScan(ctx)

    await run(ctx, itemId, 'recognise')

    const items = await ctx.repository.itemsOf(scanId)
    expect(items.map((i) => [i.recognisedVariant, i.recognisedForm, i.recognisedCategory])).toEqual([
      ['Night', 'serum', 'skin'],
      [null, null, 'skin'],
    ])
  })

  it('numbers the items of each photo from its own slot: photo 1\'s products are 5, 6, 7 and the other photos are left as they were', async () => {
    const ctx = setup()
    answerShelf(ctx, shelfRead(shelfList(3)))
    const { scanId, itemIds } = await shelfScan(ctx, [markedJpeg(1), markedJpeg(2), markedJpeg(3)])

    await run(ctx, itemIds[1]!, 'recognise')

    expect(await shape(ctx, scanId)).toEqual([
      [0, null, 'recognising'],
      [5, 'Product 0', 'matching'],
      [6, 'Product 1', 'matching'],
      [7, 'Product 2', 'matching'],
      [10, null, 'recognising'],
    ])
    const photos = await ctx.repository.photosOf(scanId)
    expect(photos.map((p) => p.state)).toEqual(['recognising', 'recognised', 'recognising'])
    expect((await ctx.repository.itemsOf(scanId)).filter((i) => i.position >= 5 && i.position <= 7).every((i) => i.photoId === photos[1]!.id)).toBe(true)
  })

  it('takes 3 photos of 5 products each to 15 items at positions 0-4, 5-9 and 10-14, none colliding, in any order of reading', async () => {
    const ctx = setup()
    answerShelf(ctx, shelfRead(shelfList(5)))
    const { scanId, itemIds } = await shelfScan(ctx, [markedJpeg(1), markedJpeg(2), markedJpeg(3)])

    for (const id of [itemIds[2]!, itemIds[0]!, itemIds[1]!]) await run(ctx, id, 'recognise')

    expect((await ctx.repository.itemsOf(scanId)).map((i) => i.position)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
  })

  it('marks the photo recognised, storing the recognizer\'s whole answer and the counts of what was left out', async () => {
    const ctx = setup()
    const read = shelfRead(shelfList(2), { excluded: { otherProducts: 2, unreadable: 3 } })
    answerShelf(ctx, read)
    const { scanId, itemId } = await shelfScan(ctx)
    ctx.advance(SECOND)

    await run(ctx, itemId, 'recognise')

    const photo = await photoRow(ctx, scanId)
    expect(photo).toMatchObject({ state: 'recognised', skippedNotBeauty: 2, skippedUnreadable: 3, skippedOverLimit: 0, skippedDailyLimit: 0, updatedAt: new Date(T0.getTime() + SECOND) })
    expect(JSON.parse(photo.recognition!)).toEqual(read)
  })

  it('announces every item of the photo (the placeholder and each new one) after all of them are stored, and no done', async () => {
    class Probe extends MemoryScanEvents {
      readonly storedAtEachEvent: number[] = []
      constructor(private readonly repo: FakeScansRepository) {
        super()
      }
      override async publish(scanId: string, event: Parameters<MemoryScanEvents['publish']>[1]): Promise<void> {
        this.storedAtEachEvent.push((await this.repo.itemsOf(scanId)).length)
        return super.publish(scanId, event)
      }
    }
    const ctx = setup({ events: (repository) => new Probe(repository) })
    answerShelf(ctx, shelfRead(shelfList(3)))
    const { scanId, itemId } = await shelfScan(ctx)

    await run(ctx, itemId, 'recognise')

    const events = ctx.events.eventsFor(scanId)
    const announced = events.flatMap((e) => (e.type === 'item' ? [e.item.id] : []))
    expect(new Set(announced)).toEqual(new Set((await ctx.repository.itemsOf(scanId)).map((i) => i.id)))
    expect(announced).toHaveLength(3)
    expect(events.some((e) => e.type === 'done')).toBe(false)
    expect((ctx.events as Probe).storedAtEachEvent.every((n) => n === 3)).toBe(true)
  })

  describe('identical products', () => {
    it('counts one product once however it is cased or spaced, keeping the first, and counts the repeat nowhere', async () => {
      const ctx = setup()
      answerShelf(
        ctx,
        shelfRead([
          shelfProduct('Bright Serum', 0.95, { brand: 'Glow Co', variant: 'Night' }),
          shelfProduct('Other Soap', 0.9),
          shelfProduct('  bright   SERUM ', 0.85, { brand: 'GLOW   co', variant: ' night' }),
        ]),
      )
      const { scanId, itemId } = await shelfScan(ctx)

      await run(ctx, itemId, 'recognise')

      expect(await shape(ctx, scanId)).toEqual([
        [0, 'Bright Serum', 'matching'],
        [1, 'Other Soap', 'matching'],
      ])
      expect(await photoRow(ctx, scanId)).toMatchObject({ skippedNotBeauty: 0, skippedUnreadable: 0, skippedOverLimit: 0, skippedDailyLimit: 0 })
    })

    it.each([
      ['brand', { brand: 'Other Co' }],
      ['name', { name: 'Bright Serum 2' }],
      ['variant', { variant: 'Day' }],
      ['form', { form: 'cream' as const }],
    ])('keeps two products that differ in %s', async (_field, change) => {
      const ctx = setup()
      const base = shelfProduct('Bright Serum', 0.95, { variant: 'Night', form: 'serum' })
      answerShelf(ctx, shelfRead([base, { ...base, ...change, confidence: 0.9 }]))
      const { scanId, itemId } = await shelfScan(ctx)

      await run(ctx, itemId, 'recognise')

      expect(await ctx.repository.itemsOf(scanId)).toHaveLength(2)
    })

    it('collapses before anything is counted against a limit: 5 products with 2 repeats are 3 items and use no allowance', async () => {
      const ctx = setup({ policy: { dailyPhotosPerUser: 3 } })
      const [a, b, c] = shelfList(3)
      answerShelf(ctx, shelfRead([a!, { ...a!, confidence: 0.9 }, b!, { ...b!, confidence: 0.8 }, c!]))
      const { scanId, itemId } = await shelfScan(ctx)

      await run(ctx, itemId, 'recognise')

      expect(await ctx.repository.itemsOf(scanId)).toHaveLength(3)
      expect(await photoRow(ctx, scanId)).toMatchObject({ skippedDailyLimit: 0, skippedOverLimit: 0 })
    })
  })

  describe('the cap on items in a scan', () => {
    it('skips the least confident products that would take the scan past its cap, and counts them as over the limit', async () => {
      const ctx = setup({ policy: { maxItemsPerScan: 6 } })
      answerShelf(ctx, shelfRead(shelfList(5)))
      const { scanId, itemIds } = await shelfScan(ctx, [markedJpeg(1), markedJpeg(2), markedJpeg(3)])

      await run(ctx, itemIds[0]!, 'recognise')

      // 3 placeholders already; 4 more products would make 7.
      expect((await shape(ctx, scanId)).map((row) => row[1])).toEqual(['Product 0', 'Product 1', 'Product 2', 'Product 3', null, null])
      expect(await photoRow(ctx, scanId)).toMatchObject({ skippedOverLimit: 1 })
    })

    it('skips nothing when the items come to exactly the cap', async () => {
      const ctx = setup({ policy: { maxItemsPerScan: 7 } })
      answerShelf(ctx, shelfRead(shelfList(5)))
      const { scanId, itemIds } = await shelfScan(ctx, [markedJpeg(1), markedJpeg(2), markedJpeg(3)])

      await run(ctx, itemIds[0]!, 'recognise')

      expect(await ctx.repository.itemsOf(scanId)).toHaveLength(7)
      expect(await photoRow(ctx, scanId)).toMatchObject({ skippedOverLimit: 0 })
    })

    it('counts the items the scan already has, whichever photo they came from', async () => {
      const ctx = setup({ policy: { maxItemsPerScan: 6 } })
      answerShelf(ctx, shelfRead(shelfList(3)))
      const { scanId, itemIds } = await shelfScan(ctx, [markedJpeg(1), markedJpeg(2)])
      await run(ctx, itemIds[0]!, 'recognise')

      await run(ctx, itemIds[1]!, 'recognise')

      // photo 0: 2 placeholders + 2 more = 4 items; photo 1: its 2 more would make 6, which is the cap.
      expect(await ctx.repository.itemsOf(scanId)).toHaveLength(6)
      expect((await ctx.repository.photosOf(scanId)).map((p) => p.skippedOverLimit)).toEqual([0, 0])
    })
  })

  describe('the daily allowance', () => {
    it('counts the placeholder, then keeps as many of the most confident extra products as the user has allowance left for, skipping the rest as over the daily limit', async () => {
      const ctx = setup({ policy: { dailyPhotosPerUser: 3 } })
      answerShelf(ctx, shelfRead(shelfList(5)))
      const { scanId, itemId } = await shelfScan(ctx)

      await run(ctx, itemId, 'recognise')

      expect((await shape(ctx, scanId)).map((row) => row[1])).toEqual(['Product 0', 'Product 1', 'Product 2'])
      expect(await photoRow(ctx, scanId)).toMatchObject({ skippedDailyLimit: 2, skippedOverLimit: 0 })
    })

    it('skips nothing when the extra products come to exactly the allowance left', async () => {
      const ctx = setup({ policy: { dailyPhotosPerUser: 5 } })
      answerShelf(ctx, shelfRead(shelfList(5)))
      const { scanId, itemId } = await shelfScan(ctx)

      await run(ctx, itemId, 'recognise')

      expect(await ctx.repository.itemsOf(scanId)).toHaveLength(5)
      expect(await photoRow(ctx, scanId)).toMatchObject({ skippedDailyLimit: 0 })
    })

    it('adds no item when the placeholder used the last of the allowance, and still reads the first product', async () => {
      const ctx = setup({ policy: { dailyPhotosPerUser: 1 } })
      answerShelf(ctx, shelfRead(shelfList(4)))
      const { scanId, itemId } = await shelfScan(ctx)

      await run(ctx, itemId, 'recognise')

      expect(await shape(ctx, scanId)).toEqual([[0, 'Product 0', 'matching']])
      expect(await photoRow(ctx, scanId)).toMatchObject({ skippedDailyLimit: 3 })
    })

    it('stops at the address\'s allowance too, counting what other accounts took from the same address', async () => {
      const ctx = setup({ policy: { dailyPhotosPerIp: 3 } })
      await create(ctx, [markedJpeg(9)], { userId: OTHER_USER, profileId: OTHER_PROFILE })
      answerShelf(ctx, shelfRead(shelfList(5)))
      const { scanId, itemId } = await shelfScan(ctx)

      await run(ctx, itemId, 'recognise')

      // 2 photos from this address (the other account's and this placeholder): 1 left.
      expect((await shape(ctx, scanId)).map((row) => row[1])).toEqual(['Product 0', 'Product 1'])
      expect(await photoRow(ctx, scanId)).toMatchObject({ skippedDailyLimit: 3 })
    })

    it('does not count what another address took', async () => {
      const ctx = setup({ policy: { dailyPhotosPerIp: 3 } })
      await create(ctx, [markedJpeg(9)], { userId: OTHER_USER, profileId: OTHER_PROFILE, ip: OTHER_IP })
      answerShelf(ctx, shelfRead(shelfList(5)))
      const { scanId, itemId } = await shelfScan(ctx)

      await run(ctx, itemId, 'recognise')

      expect(await ctx.repository.itemsOf(scanId)).toHaveLength(3)
      expect(await photoRow(ctx, scanId)).toMatchObject({ skippedDailyLimit: 2 })
    })

    it('uses the scan\'s own address, not the one of whoever runs the job', async () => {
      const ctx = setup({ policy: { dailyPhotosPerIp: 2 } })
      const { scanId, itemId } = await shelfScan(ctx, [markedJpeg(1)], { ip: OTHER_IP })
      answerShelf(ctx, shelfRead(shelfList(4)))

      await run(ctx, itemId, 'recognise')

      expect(await ctx.repository.itemsOf(scanId)).toHaveLength(2)
      expect(await photoRow(ctx, scanId)).toMatchObject({ skippedDailyLimit: 2 })
    })

    it('applies the cap first, then the allowance to what the cap left', async () => {
      const ctx = setup({ policy: { maxItemsPerScan: 3, dailyPhotosPerUser: 2 } })
      answerShelf(ctx, shelfRead(shelfList(5)))
      const { scanId, itemId } = await shelfScan(ctx)

      await run(ctx, itemId, 'recognise')

      expect((await shape(ctx, scanId)).map((row) => row[1])).toEqual(['Product 0', 'Product 1'])
      expect(await photoRow(ctx, scanId)).toMatchObject({ skippedOverLimit: 2, skippedDailyLimit: 1 })
    })

    it('counts the new items against the allowance of the next scan', async () => {
      const ctx = setup({ policy: { dailyPhotosPerUser: 4 } })
      answerShelf(ctx, shelfRead(shelfList(3)))
      const { itemId } = await shelfScan(ctx)
      await run(ctx, itemId, 'recognise')

      // 3 items so far: one more photo is the 4th, a second is the 5th.
      await expect(createShelf(ctx, [markedJpeg(2), markedJpeg(3)])).rejects.toBeInstanceOf(RateLimitedError)
      await expect(createShelf(ctx, [markedJpeg(2)])).resolves.toMatchObject({ id: expect.any(String) })
    })
  })

  describe('the next step of each new item', () => {
    it('queues a match for the placeholder and for each new item that is sure enough', async () => {
      const ctx = setup()
      answerShelf(ctx, shelfRead(shelfList(3)))
      const { scanId, itemId } = await shelfScan(ctx)

      await run(ctx, itemId, 'recognise')

      const ids = (await ctx.repository.itemsOf(scanId)).map((i) => i.id)
      expect(matchesQueued(ctx)).toEqual(ids)
      expect(queuedWithTime(ctx).filter((m) => m.step === 'match').map((m) => m.at)).toEqual([T0.getTime(), T0.getTime(), T0.getTime()])
    })

    it('asks the user to confirm products read below 0.6, with a match only for those at 0.6 or more', async () => {
      const ctx = setup()
      answerShelf(ctx, shelfRead([shelfProduct('A', 0.9), shelfProduct('B', 0.6), shelfProduct('C', 0.59), shelfProduct('D', 0.3)]))
      const { scanId, itemId } = await shelfScan(ctx)

      await run(ctx, itemId, 'recognise')

      expect(await shape(ctx, scanId)).toEqual([
        [0, 'A', 'matching'],
        [1, 'B', 'matching'],
        [2, 'C', 'needs-confirmation'],
        [3, 'D', 'needs-confirmation'],
      ])
      const items = await ctx.repository.itemsOf(scanId)
      expect(matchesQueued(ctx)).toEqual([items[0]!.id, items[1]!.id])
    })

    it('sends one "needs you" push for the photo, whoever of its products needs confirming and however many', async () => {
      const ctx = setup()
      answerShelf(ctx, shelfRead([shelfProduct('A', 0.9), shelfProduct('B', 0.5), shelfProduct('C', 0.4)]))
      const { scanId, itemId } = await shelfScan(ctx, [markedJpeg(1)], { userId: OTHER_USER, profileId: OTHER_PROFILE })

      await run(ctx, itemId, 'recognise')

      const pushes = ctx.pushJobs.enqueued.map((e) => e.body as SendPushMessage)
      expect(pushes).toEqual([{ kind: 'scan-needs-you', userId: OTHER_USER, profileId: OTHER_PROFILE, scanId, itemId: expect.any(String), need: 'confirm' }])
      const waiting = (await ctx.repository.itemsOf(scanId)).filter((i) => i.state === 'needs-confirmation').map((i) => i.id)
      expect(waiting).toContain((pushes[0] as { itemId: string }).itemId)
    })

    it('sends the push when only the placeholder\'s product needs confirming', async () => {
      const ctx = setup()
      answerShelf(ctx, shelfRead([shelfProduct('A', 0.5)]))
      const { itemId } = await shelfScan(ctx)

      await run(ctx, itemId, 'recognise')

      expect(ctx.pushJobs.enqueued).toHaveLength(1)
      expect(matchesQueued(ctx)).toEqual([])
    })

    it('sends no push when every product is sure enough', async () => {
      const ctx = setup()
      answerShelf(ctx, shelfRead(shelfList(3)))
      const { itemId } = await shelfScan(ctx)

      await run(ctx, itemId, 'recognise')

      expect(ctx.pushJobs.enqueued).toEqual([])
    })

    it('carries on, leaving the item matching for the reaper, when a new item\'s match cannot be queued', async () => {
      const ctx = setup()
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      answerShelf(ctx, shelfRead(shelfList(3)))
      const { scanId, itemId } = await shelfScan(ctx)
      const real = ctx.jobs.enqueue.bind(ctx.jobs)
      let calls = 0
      vi.spyOn(ctx.jobs, 'enqueue').mockImplementation((async (job: never, body: never, options: never) => {
        // 1st is the placeholder's match, 2nd the first new item's.
        if (++calls === 2) throw new Error('queue is down')
        return real(job, body, options)
      }) as never)

      await expect(run(ctx, itemId, 'recognise')).resolves.toBeUndefined()

      const items = await ctx.repository.itemsOf(scanId)
      expect(items.map((i) => i.state)).toEqual(['matching', 'matching', 'matching'])
      expect(matchesQueued(ctx)).toEqual([items[0]!.id, items[2]!.id])
      expect(error).toHaveBeenCalledWith(expect.objectContaining({ itemId: items[1]!.id }))
    })
  })

  describe('a match that cannot be queued for the placeholder', () => {
    const queueFails = async () => {
      const ctx = setup()
      vi.spyOn(console, 'error').mockImplementation(() => undefined)
      answerShelf(ctx, shelfRead(shelfList(3), { excluded: { otherProducts: 1, unreadable: 2 } }))
      const scan = await shelfScan(ctx)
      ctx.jobs.failNextWith(new Error('queue is down'))
      const error = await errorOf(run(ctx, scan.itemId, 'recognise'))
      return { ctx, error, ...scan }
    }

    it('puts the placeholder back to recognising and rethrows, with the other items and the photo\'s answer kept', async () => {
      const { ctx, error, scanId, itemId } = await queueFails()

      expect(error.message).toBe('queue is down')
      expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'recognising', reason: null })
      const items = await ctx.repository.itemsOf(scanId)
      expect(items.map((i) => [i.position, i.state])).toEqual([
        [0, 'recognising'],
        [1, 'matching'],
        [2, 'matching'],
      ])
      expect(items.slice(1).map((i) => i.recognisedName)).toEqual(['Product 1', 'Product 2'])
      expect(await photoRow(ctx, scanId)).toMatchObject({ state: 'recognised', skippedNotBeauty: 1, skippedUnreadable: 2 })
    })

    it('is retried for free: no second call to the model, no duplicate items, the same counts, and the placeholder moves on', async () => {
      const { ctx, scanId, itemId } = await queueFails()
      const before = await photoRow(ctx, scanId)
      ctx.advance(SECOND)

      await run(ctx, itemId, 'recognise')

      expect(ctx.recognizer.shelfCalls).toHaveLength(1)
      expect(await shape(ctx, scanId)).toEqual([
        [0, 'Product 0', 'matching'],
        [1, 'Product 1', 'matching'],
        [2, 'Product 2', 'matching'],
      ])
      expect(await photoRow(ctx, scanId)).toEqual(before)
      expect(matchesQueued(ctx)).toContain(itemId)
    })
  })

  describe('a match that cannot be queued for the placeholder: the keys of the retry', () => {
    it('stamps each new item\'s match with its own stored time (the first attempt\'s, the reaper\'s key) and the placeholder\'s with the retry\'s', async () => {
      const ctx = setup()
      vi.spyOn(console, 'error').mockImplementation(() => undefined)
      answerShelf(ctx, shelfRead(shelfList(3)))
      const { scanId, itemId } = await shelfScan(ctx)
      ctx.jobs.failNextWith(new Error('queue is down'))
      await errorOf(run(ctx, itemId, 'recognise'))
      ctx.advance(SECOND)

      await run(ctx, itemId, 'recognise')

      const items = await ctx.repository.itemsOf(scanId)
      const stamped = new Map(queuedWithTime(ctx).filter((m) => m.step === 'match').map((m) => [m.itemId, m.at]))
      expect(items[1]!.updatedAt.getTime()).toBe(T0.getTime())
      expect(stamped.get(items[1]!.id)).toBe(items[1]!.updatedAt.getTime())
      expect(stamped.get(items[2]!.id)).toBe(items[2]!.updatedAt.getTime())
      expect(stamped.get(itemId)).toBe(items[0]!.updatedAt.getTime())
      expect(items[0]!.updatedAt.getTime()).toBe(T0.getTime() + SECOND)
    })
  })

  describe('one stored answer per photo', () => {
    it('files the first stored answer when a second delivery\'s model answer differs: no extra items from the other answer', async () => {
      const ctx = setup()
      const { scanId, itemId } = await shelfScan(ctx)
      const first = shelfRead(shelfList(2))
      const second = shelfRead(shelfList(4).map((p) => ({ ...p, name: `Other ${p.name}` })))
      let calls = 0
      vi.spyOn(ctx.recognizer, 'recognizeShelf').mockImplementation((async () => {
        // The 1st delivery's model call is still out when the 2nd delivery runs to the end with its own answer.
        if (++calls === 1) {
          await run(ctx, itemId, 'recognise')
          return second
        }
        return first
      }) as never)

      await run(ctx, itemId, 'recognise')

      expect(calls).toBe(2)
      expect(await shape(ctx, scanId)).toEqual([
        [0, 'Product 0', 'matching'],
        [1, 'Product 1', 'matching'],
      ])
      expect(JSON.parse((await photoRow(ctx, scanId)).recognition!)).toEqual(first)
    })

    it('retries a rejection whose filing failed after the image was deleted into the same rejection, not photo-missing', async () => {
      const ctx = setup()
      answerShelf(ctx, NOTHING_READ('other-product', { otherProducts: 2, unreadable: 0 }))
      const { scanId, itemId } = await shelfScan(ctx)
      vi.spyOn(ctx.repository, 'fanOut').mockRejectedValueOnce(new Error('database is down'))

      await expect(run(ctx, itemId, 'recognise')).rejects.toThrow('database is down')
      expect(ctx.photos.stored.size).toBe(0)
      await run(ctx, itemId, 'recognise')

      expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'rejected', reason: 'not-a-beauty-product' })
      expect(await photoRow(ctx, scanId)).toMatchObject({ state: 'rejected', photoKey: null, skippedNotBeauty: 2 })
      expect(ctx.recognizer.shelfCalls).toHaveLength(1)
    })
  })

  describe('a repeated delivery after the photo was read', () => {
    it('adds nothing and calls nothing: no model call, no duplicate items, the same counts', async () => {
      const ctx = setup()
      answerShelf(ctx, shelfRead(shelfList(3), { excluded: { otherProducts: 1, unreadable: 0 } }))
      const { scanId, itemId } = await shelfScan(ctx)
      await run(ctx, itemId, 'recognise')
      const items = await ctx.repository.itemsOf(scanId)
      const photo = await photoRow(ctx, scanId)
      const pushes = ctx.pushJobs.enqueued.length
      const matches = matchesQueued(ctx).length
      ctx.advance(SECOND)

      await run(ctx, itemId, 'recognise')

      expect(ctx.recognizer.shelfCalls).toHaveLength(1)
      expect(await ctx.repository.itemsOf(scanId)).toEqual(items)
      expect(await photoRow(ctx, scanId)).toEqual(photo)
      expect(ctx.pushJobs.enqueued).toHaveLength(pushes)
      expect(matchesQueued(ctx)).toHaveLength(matches)
    })
  })
})

describe('ScanService.advance: recognise, a shelf photo with no product', () => {
  it.each([
    ['other-product', 'not-a-beauty-product'],
    ['face-or-person', 'face-or-person'],
    ['unreadable', 'unreadable'],
  ] as const)('rejects the placeholder as %s -> %s, rejects the photo, and deletes the image, never asking for a retake', async (classification, reason) => {
    const ctx = setup()
    answerShelf(ctx, NOTHING_READ(classification, { otherProducts: 2, unreadable: 1 }))
    const { scanId, itemId } = await shelfScan(ctx)
    const key = (await photoRow(ctx, scanId)).photoKey!
    expect(ctx.photos.stored.has(key)).toBe(true)
    ctx.advance(SECOND)

    await run(ctx, itemId, 'recognise')

    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'rejected', reason })
    expect(await photoRow(ctx, scanId)).toMatchObject({
      state: 'rejected',
      photoKey: null,
      skippedNotBeauty: 2,
      skippedUnreadable: 1,
      updatedAt: new Date(T0.getTime() + SECOND),
    })
    expect(JSON.parse((await photoRow(ctx, scanId)).recognition!)).toEqual(NOTHING_READ(classification, { otherProducts: 2, unreadable: 1 }))
    expect(ctx.photos.stored.has(key)).toBe(false)
    expect(await ctx.repository.itemsOf(scanId)).toHaveLength(1)
    expect(matchesQueued(ctx)).toEqual([])
    expect(await ctx.repository.countRetakes(itemId)).toBe(0)
  })

  it('treats a refusal to look at the photo as unreadable: rejected, not a retake, the image deleted', async () => {
    const ctx = setup()
    const { scanId, itemId } = await shelfScan(ctx)
    ctx.recognizer.failNextWith(new AnthropicRefusalError('Claude refused to answer'))

    await expect(run(ctx, itemId, 'recognise')).resolves.toBeUndefined()

    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'rejected', reason: 'unreadable' })
    expect(await photoRow(ctx, scanId)).toMatchObject({ state: 'rejected', photoKey: null, skippedNotBeauty: 0, skippedUnreadable: 0 })
    expect(ctx.photos.stored.size).toBe(0)
  })

  it('finishes the scan: the rejected placeholder was its only item', async () => {
    const ctx = setup()
    answerShelf(ctx, NOTHING_READ('face-or-person'))
    const { scanId, itemId } = await shelfScan(ctx)

    await run(ctx, itemId, 'recognise')

    expect(ctx.events.eventsFor(scanId).map((e) => e.type)).toEqual(['item', 'done'])
  })

  it('deletes the image before it says anything is rejected: a failed delete leaves the photo and the placeholder as they were', async () => {
    class DeleteFails extends MemoryPhotoStore {
      failing = false
      override async delete(key: string): Promise<void> {
        if (this.failing) throw new Error('bucket is down')
        return super.delete(key)
      }
      override async deleteMany(keys: string[]): Promise<void> {
        if (this.failing) throw new Error('bucket is down')
        return super.deleteMany(keys)
      }
    }
    const photos = new DeleteFails({ environment: 'test' })
    const ctx = setup({ photos })
    answerShelf(ctx, NOTHING_READ('other-product'))
    const { scanId, itemId } = await shelfScan(ctx)
    photos.failing = true

    await expect(run(ctx, itemId, 'recognise')).rejects.toThrow('bucket is down')

    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'recognising', reason: null })
    expect(await photoRow(ctx, scanId)).toMatchObject({ state: 'recognising' })
    expect(photos.stored.size).toBe(1)
  })
})

describe('ScanService.advance: recognise, a shelf photo the model cannot or will not read', () => {
  const noSiblings = async (ctx: Ctx, scanId: string) => expect(await ctx.repository.itemsOf(scanId)).toHaveLength(1)

  it('fails the placeholder as research-busy, keeping the image, with no other item, when the AI spend cap is spent', async () => {
    const ctx = setup()
    const { scanId, itemId } = await shelfScan(ctx)
    ctx.recognizer.failNextWith(new AiBudgetExceededError('cap'))

    await expect(run(ctx, itemId, 'recognise')).resolves.toBeUndefined()

    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'failed', reason: 'research-busy' })
    expect(ctx.photos.stored.size).toBe(1)
    expect(await photoRow(ctx, scanId)).toMatchObject({ state: 'recognising' })
    await noSiblings(ctx, scanId)
  })

  it('fails the placeholder as unavailable and throws a PermanentJobError when the answer was unusable', async () => {
    const ctx = setup()
    const { scanId, itemId } = await shelfScan(ctx)
    ctx.recognizer.failNextWith(new AnthropicRequestError('Claude returned text that is not valid JSON'))

    const error = await errorOf(run(ctx, itemId, 'recognise'))

    expect(error).toBeInstanceOf(PermanentJobError)
    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'failed', reason: 'unavailable' })
    await noSiblings(ctx, scanId)
  })

  it('throws, leaving the placeholder recognising for the queue to retry, when the model is merely unavailable', async () => {
    const ctx = setup()
    const { scanId, itemId } = await shelfScan(ctx)
    const outage = new AnthropicUnavailableError('overloaded')
    ctx.recognizer.failNextWith(outage)

    await expect(run(ctx, itemId, 'recognise')).rejects.toBe(outage)

    expect((await stateOf(ctx, scanId, itemId)).state).toBe('recognising')
    await noSiblings(ctx, scanId)
  })

  it('fails the placeholder as photo-missing, without calling the model, when the photo\'s image is gone', async () => {
    const ctx = setup()
    const { scanId, itemId } = await shelfScan(ctx)
    ctx.photos.stored.clear()

    await run(ctx, itemId, 'recognise')

    expect(await stateOf(ctx, scanId, itemId)).toEqual({ state: 'failed', reason: 'photo-missing' })
    expect(ctx.recognizer.shelfCalls).toEqual([])
    await noSiblings(ctx, scanId)
  })
})

describe('ScanService.advance: recognise, a product scan is not a shelf scan', () => {
  it('gives a product photo ONE item through the single-product recognizer, even if the shelf recognizer would have listed several', async () => {
    const ctx = setup()
    answerShelf(ctx, shelfRead(shelfList(3)))
    const { scanId, itemId } = await scanOne(ctx)

    await run(ctx, itemId, 'recognise')

    expect(ctx.recognizer.calls).toHaveLength(1)
    expect(ctx.recognizer.shelfCalls).toEqual([])
    expect(await ctx.repository.itemsOf(scanId)).toHaveLength(1)
    expect(await itemOf(ctx, scanId, itemId)).toMatchObject({ state: 'matching', recognised: { brand: 'CeraVe' } })
    expect(await photoRow(ctx, scanId)).toMatchObject({ state: 'recognising', photoKey: null })
  })
})
