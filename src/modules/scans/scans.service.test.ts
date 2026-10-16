import { describe, expect, it, vi } from 'vitest'
import { PermanentJobError } from '../../jobs/job'
import { ConflictError, NotFoundError, RateLimitedError, UnauthorizedError, ValidationError } from '../../lib/errors'
import { runAs } from '../../lib/context'
import { PHOTO_LINK_TTL_SECONDS, signPhotoLink, verifyPhotoLink } from '../../lib/photo-link'
import { AiBudgetExceededError } from '../../providers/anthropic/ai-spend.provider'
import { AnthropicRefusalError, AnthropicRequestError, AnthropicUnavailableError } from '../../providers/anthropic/anthropic.provider'
import { MemoryCatalogImageStore } from '../../providers/catalog-images/memory.catalog-image-store'
import { MemoryJobQueue } from '../../providers/job-queue/memory.job-queue'
import { MemoryLabelReader } from '../../providers/label-reading/memory.label-reader'
import { MemoryPhotoStore } from '../../providers/photo-store/memory.photo-store'
import { MemoryProductAnalyst } from '../../providers/product-analysis/memory.product-analyst'
import type { ProductImage } from '../../providers/product-analysis/product-analyst.provider'
import { MemoryProductRecognizer } from '../../providers/product-recognition/memory.product-recognizer'
import type { Recognition } from '../../providers/product-recognition/product-recognizer.provider'
import { MemoryProductResearcher } from '../../providers/product-research/memory.product-researcher'
import type { ProductIdentity } from '../../providers/product-research/product-researcher.provider'
import { MemoryScanEvents } from '../../providers/scan-events/memory.scan-events'
import { identityKey } from '../catalog/catalog.identity'
import { FakeCatalogRepository } from '../catalog/catalog.repository.fake'
import { AnalysisInProgressError, ProductCatalogService, ResearchInProgressError } from '../catalog/catalog.service'
import { FRESH_FOR_DAYS } from '../catalog/catalog.vocabulary'
import { FakeProfilesRepository } from '../profiles/profiles.repository.fake'
import { advanceScanItemSpec, type AdvanceScanItemMessage } from './scans.job-specs'
import { garbagePhoto, jpegPhoto, markedJpeg, pngPhoto, webpPhoto } from './scans.photos.fake'
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
  const photos = options.photos ?? new MemoryPhotoStore({ environment: 'test' })
  const jobs = new MemoryJobQueue()
  const events = options.events?.(repository) ?? new MemoryScanEvents()
  const service = new ScanService({
    repository,
    catalog,
    recognizer,
    labelReader,
    photos,
    jobs,
    events,
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
    photos,
    jobs,
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
  ctx.researcher.respondWith(() => ({ found: true, ingredients, sourceUrl: SOURCE_URL, ...(imageUrl ? { imageUrl } : {}) }))
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

describe('SCAN_POLICY', () => {
  it('sets the photo, size, dimension, daily quota and confirmation limits', () => {
    expect(SCAN_POLICY).toEqual({
      maxPhotosPerScan: 10,
      maxPhotoBytes: 2_000_000,
      maxPhotoEdge: 1600,
      dailyPhotosPerUser: 30,
      dailyPhotosPerIp: 100,
      confirmBelowConfidence: 0.6,
      doneRepairWindowMs: 3 * HOUR,
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

  it('enqueues one recognise job per item and nothing else', async () => {
    const ctx = setup()

    const scan = await create(ctx, [markedJpeg(1), markedJpeg(2)])

    expect(queued(ctx)).toEqual(scan.items.map((i: { id: string }) => advanceMessage(i.id, 'recognise')))
  })

  it('shows each new item the owner\'s own photo through a signed link that opens that photo for 5 minutes', async () => {
    const ctx = setup()

    const scan = await create(ctx)

    const item = scan.items[0]
    expect(item.image).toEqual({ kind: 'user', url: expect.stringMatching(/^\/scans\/photos\/[A-Za-z0-9_-]+$/) })
    const token = item.image.url.replace('/scans/photos/', '')
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
      override async createScan(scan: Parameters<FakeScansRepository['createScan']>[0], items: Parameters<FakeScansRepository['createScan']>[1]): Promise<void> {
        for (const item of items) present.push((await this.store.get(item.photoKey)) !== null)
        return super.createScan(scan, items)
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
    ['a photo nothing can be read from', { classification: 'unreadable' }, 'unreadable'],
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
    expect(item.product).toEqual(await ctx.catalog.productView(formulationId))
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

    expect((await itemOf(ctx, scanId, itemId))).toMatchObject({ state: 'ready', product: { formulation: { id: old.formulationId } } })
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

describe('ScanService.advance: analyse', () => {
  it('makes the item ready with the analysed product', async () => {
    const ctx = setup()
    const { scanId, itemId } = await analysingItem(ctx)
    await run(ctx, itemId, 'analyse')

    const item = await itemOf(ctx, scanId, itemId)
    expect(item.state).toBe('ready')
    const stored = await ctx.repository.findItem(itemId)
    expect(item.product).toEqual(await ctx.catalog.productView(stored!.formulationId!))
    expect(item.product.formulation.analysedAt).toEqual(T0)
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
    ctx.recognizer.respondWith(() => ({ classification: 'unreadable' }))
    const scan = await create(ctx, [markedJpeg(1)])

    await run(ctx, scan.items[0].id, 'recognise')

    expect(ctx.events.eventsFor(scan.id).map((e) => e.type)).toEqual(['item', 'done'])
  })

  it('does not publish done while another item is still waiting, even if it is waiting for the user', async () => {
    const ctx = setup()
    ctx.recognizer.respondWith((image) => (image.bytes.at(-1) === 1 ? { classification: 'unreadable' } : seen({ confidence: 0.2 })))
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
    expect(item.image).toEqual({ kind: 'stock', url: item.product.product.imageUrl })
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
    expect(await itemOf(ctx, scanId, itemId)).toHaveProperty('product.formulation.ingredients', CLEAN)
  })

  it('links the user\'s own photo for 5 minutes at a time, signed for that user and that photo', async () => {
    const ctx = setup()
    const { scanId, itemId } = await scanOne(ctx)
    ctx.advance(10 * MINUTE)

    const item = await itemOf(ctx, scanId, itemId)

    const token = item.image.url.replace('/scans/photos/', '')
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
  const linkOf = async (ctx: Ctx, scanId: string, itemId: string) => (await itemOf(ctx, scanId, itemId)).image.url.replace('/scans/photos/', '') as string
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
    it('rejects a photo the model refused to look at as unreadable, deletes it, and does not throw', async () => {
      const ctx = setup()
      const { scanId, itemId } = await scanOne(ctx)
      ctx.recognizer.failNextWith(refused())

      await expect(run(ctx, itemId, 'recognise')).resolves.toBeUndefined()

      expect(await itemOf(ctx, scanId, itemId)).toMatchObject({ state: 'rejected', reason: 'unreadable', image: null })
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
    ['read-label', 'reading-label', (ctx: Ctx) => reach(ctx, 'reading-label'), { productId: null }],
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
    const ctx = setup({ policy: { dailyPhotosPerUser: 4 } })
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
    ctx.recognizer.respondWith(() => ({ classification: 'unreadable' }))
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
    ctx.recognizer.respondWith((image) => (image.bytes.at(-1) === 1 ? { classification: 'unreadable' } : seen({ confidence: 0.2 })))
    const scan = await create(ctx, [markedJpeg(1), markedJpeg(2)])
    await run(ctx, scan.items[0].id, 'recognise')
    await run(ctx, scan.items[1].id, 'recognise')
    const before = ctx.events.published.length

    await watch(ctx, scan.id)

    expect(ctx.events.published).toHaveLength(before)
  })

  it('follows the snapshot with done when every item is already final, whether ready, rejected or failed', async () => {
    const ctx = setup()
    ctx.recognizer.respondWith((image) => (image.bytes.at(-1) === 1 ? { classification: 'unreadable' } : seen()))
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
    ctx.recognizer.respondWith(() => ({ classification: 'unreadable' }))
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
      ctx.recognizer.respondWith((image) => (image.bytes.at(-1) === 1 ? { classification: 'unreadable' } : seen({ confidence: 0.2 })))
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
      expect(ctx.events.eventsFor(scan.id)).toMatchObject([{ type: 'item', item: { id: scan.items[0].id, state: 'rejected', reason: 'unreadable' } }, { type: 'done' }])
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
    ctx.recognizer.respondWith(() => ({ classification: 'unreadable' }))
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
    ctx.recognizer.respondWith((image) => (image.bytes.at(-1) === 1 ? { classification: 'unreadable' } : seen({ confidence: 0.2 })))
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
    ctx.recognizer.respondWith(() => ({ classification: 'unreadable' }))
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
    ctx.recognizer.respondWith(() => ({ classification: 'unreadable' }))
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
    await ctx.repository.createScan({ id: scanId, userId: owner, profileId: null as unknown as string, ipHash: 'ip', createdAt: ctx.now() }, [
      { id: 'orphan-item', scanId, userId: owner, position: 0, photoKey: 'photos/test/orphan.jpg', createdAt: ctx.now() },
    ])
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
