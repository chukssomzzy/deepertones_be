import { abortAllDurableObjects, createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { hc } from 'hono/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker, { type AppType } from '../../src/index'
import { createDb } from '../../src/lib/db'
import { signPhotoLink } from '../../src/lib/photo-link'
import { TokenService } from '../../src/modules/auth/tokens.service'
import { D1ProfilesRepository } from '../../src/modules/profiles/profiles.repository'
import { garbagePhoto, jpegPhoto, markedJpeg, pngPhoto, webpPhoto } from '../../src/modules/scans/scans.photos.fake'
import { messageResponse, stubFetch, textBlock } from '../../src/providers/anthropic/messages-api.fake'
import type { ProductImage } from '../../src/providers/product-analysis/product-analyst.provider'

// The scan HTTP routes through the Worker's real entrypoint, with the frontend's typed client, real local D1 and R2.
// The scan queue's producer is replaced by a recorder and the steps are driven by hand through the Worker's queue
// handler (as scans.background.test.ts does), with only the outbound Anthropic call stubbed at fetch.

const SECOND = 1000
const MINUTE = 60 * SECOND
const DAY_SECONDS = 24 * 60 * 60
// The one clock for hand-made tokens: "now" is the real clock the Worker runs on, fixtures are offsets.
const NOW = Date.now()
const SCAN_QUEUE = 'deepertones-scan-items-development'
/** What a request is asked to hold at most, and what the service accepts per photo (SCAN_POLICY). */
const MAX_PHOTO_BYTES = 2_000_000
/** One byte over what POST /api/v1/scans/products accepts: 10 photos plus 1,000,000 of multipart framing. */
const OVER_SCAN_BODY_BYTES = 10 * MAX_PHOTO_BYTES + 1_000_000 + 1

const queued: unknown[] = []
const WORKER_ENV = {
  ...env,
  SCAN_ITEMS_QUEUE: { send: async (body: unknown) => void queued.push(body) } as unknown as Queue,
}

const fetchWorker = (input: RequestInfo | URL, init?: RequestInit) =>
  worker.fetch!(new Request(input, init) as never, WORKER_ENV, createExecutionContext())

const api = hc<AppType>('http://deepertones.test', { fetch: fetchWorker as typeof fetch })
// One place that reaches into the scans routes: until the routes are mounted in AppType this is the one line that fails to compile.
const scansApi = api.api.v1.scans.products

afterEach(() => {
  vi.unstubAllGlobals()
  queued.length = 0
})

const runSalt = String(Math.floor(Math.random() * 1e6))
let counter = 0
const next = () => counter++
// A new IP per caller keeps the rate limits and the daily per-address photo quota (both keyed by IP) from coupling tests.
const freshIp = () => {
  const n = next()
  return `10.${Number(runSalt) % 250}.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`
}
const freshBrand = () => `RoutesBrand${runSalt}x${next()}`

type Envelope<T> = { success: true; status: number; message: string; data: T } | { success: false; status: number; error: { code: string } }
type Reply = { json(): Promise<unknown>; status: number; headers: Headers }
type ItemView = {
  id: string
  position: number
  state: string
  reason: string | null
  retakesLeft?: number
  image: { kind: string; url: string } | null
  recognised?: { brand: string; name: string; variant?: string | null; category: string }
}
type ScanView = { id: string; createdAt: string; items: ItemView[] }

const read = async <T>(res: Reply) => (await res.json()) as Envelope<T>
const dataOf = async <T>(res: Reply): Promise<T> => {
  const body = await read<T>(res)
  if (!body.success) throw new Error(`expected a success, got ${res.status} ${body.error.code}`)
  return body.data
}
const errorCodeOf = async (res: Reply) => {
  const body = await read<unknown>(res)
  if (body.success) throw new Error(`expected an error, got ${res.status}`)
  return body.error.code
}
const retryAfterOf = (res: Reply) => Number(res.headers.get('Retry-After'))

/** A guest signed in from its own address. `headers()` is the guest at that address; `headers(ip)` is the same guest from another one. */
const newGuest = async () => {
  const ip = freshIp()
  const res = await api.api.v1.auth.anonymous.$post(
    { json: { deviceId: `device-routes-${runSalt}-${next()}`, platform: 'ios' } },
    { headers: { 'cf-connecting-ip': ip } },
  )
  const session = await dataOf<{ tokens: { accessToken: string }; user: { id: string } }>(res)
  const token = session.tokens.accessToken
  return {
    userId: session.user.id,
    token,
    ip,
    headers: (from: string = ip): Record<string, string> => ({ 'cf-connecting-ip': from, Authorization: `Bearer ${token}` }),
  }
}
type Guest = Awaited<ReturnType<typeof newGuest>>

const fileOf = (photo: ProductImage, name = 'photo', mediaType: string = photo.mediaType) =>
  new File([photo.bytes], `${name}.${mediaType === 'image/webp' ? 'webp' : 'jpg'}`, { type: mediaType })

const createScan = (guest: Guest, photos: File[], from?: string) => scansApi.$post({ form: { photos } }, { headers: guest.headers(from) })
const createdScan = async (guest: Guest, photos: ProductImage[] = [markedJpeg(1)]) =>
  dataOf<ScanView>(await createScan(guest, photos.map((p, i) => fileOf(p, `p${i}`))))
const getScan = (guest: Guest, scanId: string) => scansApi[':scanId'].$get({ param: { scanId } }, { headers: guest.headers() })
const confirm = (guest: Guest, scanId: string, itemId: string, body: Record<string, string> = { brand: 'Glow Co', name: 'Bright Tone Serum', category: 'skin' }) =>
  scansApi[':scanId'].items[':itemId'].confirmation.$post({ param: { scanId, itemId }, json: body as never }, { headers: guest.headers() })
const addBackPhoto = (guest: Guest, scanId: string, itemId: string, photo: File = fileOf(markedJpeg(9), 'back')) =>
  scansApi[':scanId'].items[':itemId']['back-photo'].$post({ param: { scanId, itemId }, form: { photo } }, { headers: guest.headers() })
const retake = (guest: Guest, scanId: string, itemId: string, photo: File = fileOf(markedJpeg(21), 'retake'), from?: string) =>
  scansApi[':scanId'].items[':itemId'].retake.$post({ param: { scanId, itemId }, form: { photo } }, { headers: guest.headers(from) })
const openPhoto = (token: string, headers: Record<string, string> = {}) => scansApi.photos[':token'].$get({ param: { token } }, { headers })
const tokenOf = (item: ItemView) => item.image!.url.replace('/api/v1/scans/products/photos/', '')
const bytesOf = async (res: { arrayBuffer(): Promise<ArrayBuffer> }) => new Uint8Array(await res.arrayBuffer())

// A plain request, only for what the typed client cannot express (a JSON body on a form route, or a form it would not type).
const plainPost = (path: string, body: BodyInit, headers: Record<string, string>) =>
  fetchWorker(`http://deepertones.test${path}`, { method: 'POST', body, headers })

// --- driving an item to a state, by the real steps ---

// A step is keyed by item, step and `at`, and a run with a key already seen is acknowledged and skipped: every run gets its own time, even
// when two land in the same millisecond (a retake runs `recognise` on one item again and again).
let lastAt = 0
const nextAt = () => (lastAt = Math.max(Date.now(), lastAt + 1))
const runStep = async (itemId: string, step: string) => {
  const batch = createMessageBatch(SCAN_QUEUE, [{ id: 'm', timestamp: new Date(), attempts: 1, body: { itemId, step, at: nextAt() } }])
  const ctx = createExecutionContext()
  await worker.queue!(batch, WORKER_ENV, ctx)
  const result = await getQueueResult(batch, ctx)
  expect(result.explicitAcks, `the ${step} step should be acknowledged`).toEqual(['m'])
}
// The Worker builds its own container per queue message, so the client cannot be handed a fetch here: the SDK picks up the global one when it is built.
const stubAnthropic = (...responders: Parameters<typeof stubFetch>) => {
  const { calls, fetch } = stubFetch(...responders)
  vi.stubGlobal('fetch', fetch)
  return calls
}
const recognisedAs = (brand: string, name: string, confidence: number) => () =>
  messageResponse({
    content: [textBlock(JSON.stringify({ classification: 'beauty-product', brand, name, variant: '', category: 'skin', confidence }))],
  })
// What the recognizer answers for a photo it cannot use: nothing to read, or a product whose label is turned away.
const classifiedAs = (classification: string) => () =>
  messageResponse({ content: [textBlock(JSON.stringify({ classification, brand: '', name: '', variant: '', category: 'other', confidence: 0 }))] })
const unreadable = classifiedAs('unreadable')
const labelNotVisible = classifiedAs('label-not-visible')
const researchFindsNothing = () =>
  messageResponse({ content: [textBlock(JSON.stringify({ found: false, ingredients: [], sourceUrl: null, imageUrl: null }))] })

const stateOf = async (guest: Guest, scanId: string, itemId: string) =>
  (await dataOf<ScanView>(await getScan(guest, scanId))).items.find((i) => i.id === itemId)!.state

/** A one-photo scan whose photo the recognizer could only half read (confidence 0.3): the item waits for the user to confirm. */
const awaitingConfirmation = async (guest: Guest) => {
  const scan = await createdScan(guest)
  const itemId = scan.items[0]!.id
  stubAnthropic(recognisedAs(freshBrand(), 'Hydrating Cleanser', 0.3))
  await runStep(itemId, 'recognise')
  expect(await stateOf(guest, scan.id, itemId)).toBe('needs-confirmation')
  return { scanId: scan.id, itemId }
}

/** A one-photo scan whose photo the recognizer could not read: the item asks for a retake. */
const awaitingRetake = async (guest: Guest, answer: typeof unreadable = unreadable) => {
  const scan = await createdScan(guest)
  const itemId = scan.items[0]!.id
  stubAnthropic(answer)
  await runStep(itemId, 'recognise')
  expect(await stateOf(guest, scan.id, itemId)).toBe('needs-retake')
  vi.unstubAllGlobals()
  return { scanId: scan.id, itemId }
}
const itemNow = async (guest: Guest, scanId: string, itemId: string) =>
  (await dataOf<ScanView>(await getScan(guest, scanId))).items.find((i) => i.id === itemId)!

/** A one-photo scan of a product nobody has the ingredients for: recognised, matched, researched without luck, so it asks for the back of the pack. */
const awaitingBackPhoto = async (guest: Guest) => {
  const scan = await createdScan(guest)
  const itemId = scan.items[0]!.id
  stubAnthropic(recognisedAs(freshBrand(), 'Hydrating Cleanser', 0.92), researchFindsNothing)
  await runStep(itemId, 'recognise')
  await runStep(itemId, 'match')
  await runStep(itemId, 'research')
  expect(await stateOf(guest, scan.id, itemId)).toBe('needs-back-photo')
  vi.unstubAllGlobals()
  return { scanId: scan.id, itemId }
}

describe('POST /api/v1/scans/products', () => {
  it('accepts one photo with 202, a scan of one recognising item, and a link to the photo that was sent', async () => {
    const guest = await newGuest()
    const photo = markedJpeg(7)

    const res = await createScan(guest, [fileOf(photo)])

    expect(res.status).toBe(202)
    const body = await read<ScanView>(res)
    expect(body).toMatchObject({
      success: true,
      status: 202,
      data: {
        id: expect.any(String),
        items: [{ id: expect.any(String), position: 0, state: 'recognising', reason: null, image: { kind: 'user', url: expect.stringMatching(/^\/api\/v1\/scans\/products\/photos\/[A-Za-z0-9_-]+$/) } }],
      },
    })
    const scan = (body as { data: ScanView }).data
    expect(Math.abs(new Date(scan.createdAt).getTime() - NOW)).toBeLessThan(5 * MINUTE)
    expect(await bytesOf(await openPhoto(tokenOf(scan.items[0]!)))).toEqual(photo.bytes)
  })

  it('makes one item per photo, in the order sent, each linking its own photo', async () => {
    const guest = await newGuest()
    const sent = [markedJpeg(1), webpPhoto(), markedJpeg(3)]

    const scan = await createdScan(guest, sent)

    expect(scan.items.map((i) => [i.position, i.state])).toEqual([[0, 'recognising'], [1, 'recognising'], [2, 'recognising']])
    expect(new Set(scan.items.map((i) => i.id)).size).toBe(3)
    for (const [i, item] of scan.items.entries()) {
      const res = await openPhoto(tokenOf(item))
      expect(await bytesOf(res)).toEqual(sent[i]!.bytes)
    }
  })

  it('puts one recognise job on the scan queue per photo', async () => {
    const guest = await newGuest()

    const scan = await createdScan(guest, [markedJpeg(1), markedJpeg(2)])

    expect(queued).toEqual(scan.items.map((i) => ({ itemId: i.id, step: 'recognise', at: expect.any(Number) })))
  })

  it('accepts 10 photos of 2,000,000 bytes each, a body of about 20 MB, and does not accept 11 photos', async () => {
    const guest = await newGuest()
    const big = (n: number) => Array.from({ length: n }, (_, i) => fileOf(jpegPhoto({ size: MAX_PHOTO_BYTES }), `big${i}`))

    const ten = await createScan(guest, big(10))
    expect(ten.status).toBe(202)
    expect((await dataOf<ScanView>(ten)).items).toHaveLength(10)

    const eleven = await createScan(await newGuest(), Array.from({ length: 11 }, (_, i) => fileOf(markedJpeg(i), `p${i}`)))
    expect(eleven.status).toBe(400)
    expect(await errorCodeOf(eleven)).toBe('TOO_MANY_IMAGES')
  })

  describe('what it refuses', () => {
    it('refuses a JSON body with 415', async () => {
      const guest = await newGuest()

      const res = await plainPost('/api/v1/scans/products', JSON.stringify({ photos: [] }), { ...guest.headers(), 'Content-Type': 'application/json' })

      expect(res.status).toBe(415)
      expect(await errorCodeOf(res)).toBe('HTTP_415')
    })

    // The service's NO_IMAGES is unreachable from a form: a multipart body with no `photos` part leaves the field missing, and the
    // schema (which no longer counts) rejects the missing field before the service is called.
    it('refuses a scan with no photo as VALIDATION_FAILED, for the missing field', async () => {
      const res = await createScan(await newGuest(), [])

      expect(res.status).toBe(400)
      expect(await errorCodeOf(res)).toBe('VALIDATION_FAILED')
    })

    it.each([
      ['a PNG', () => fileOf(pngPhoto(), 'shot', 'image/png')],
      ['a PNG that says it is a JPEG', () => fileOf(pngPhoto(), 'shot', 'image/jpeg')],
      ['bytes that are not an image', () => fileOf(garbagePhoto())],
    ])('refuses %s with 400 UNSUPPORTED_IMAGE', async (_label, make) => {
      const res = await createScan(await newGuest(), [fileOf(markedJpeg(1)), make()])

      expect(res.status).toBe(400)
      expect(await errorCodeOf(res)).toBe('UNSUPPORTED_IMAGE')
    })

    it('accepts a photo of exactly 2,000,000 bytes and refuses one byte more with 400', async () => {
      const exactly = await createScan(await newGuest(), [fileOf(jpegPhoto({ size: MAX_PHOTO_BYTES }))])
      expect(exactly.status).toBe(202)

      const over = await createScan(await newGuest(), [fileOf(jpegPhoto({ size: MAX_PHOTO_BYTES + 1 }))])
      expect(over.status).toBe(400)
      expect(await errorCodeOf(over)).toBe('IMAGE_TOO_LARGE')
    })

    it('refuses a photo with an edge of 1601 pixels as IMAGE_TOO_LARGE, and accepts one of 1600', async () => {
      const edge = await createScan(await newGuest(), [fileOf(jpegPhoto({ width: 1600, height: 1600 }))])
      expect(edge.status).toBe(202)

      const over = await createScan(await newGuest(), [fileOf(jpegPhoto({ width: 1601, height: 600 }))])
      expect(over.status).toBe(400)
      expect(await errorCodeOf(over)).toBe('IMAGE_TOO_LARGE')
    })

    it.each([
      ['a photos part that is text, not a file', () => { const form = new FormData(); form.append('photos', 'not a file'); return form }],
      ['one file and one text part among the photos', () => { const form = new FormData(); form.append('photos', fileOf(markedJpeg(1))); form.append('photos', 'not a file'); return form }],
    ])('refuses %s with 400 VALIDATION_FAILED', async (_label, makeForm) => {
      const guest = await newGuest()

      const res = await plainPost('/api/v1/scans/products', makeForm(), guest.headers())

      expect(res.status).toBe(400)
      expect(await errorCodeOf(res)).toBe('VALIDATION_FAILED')
    })

    it('answers 413 to a body of 24 MB, before reading it as a scan', async () => {
      const guest = await newGuest()
      const photos = Array.from({ length: 12 }, (_, i) => fileOf(jpegPhoto({ size: MAX_PHOTO_BYTES }), `big${i}`))

      const res = await createScan(guest, photos)

      expect(res.status).toBe(413)
      expect(await read<unknown>(res)).toMatchObject({ success: false, status: 413, error: { code: 'HTTP_413' } })
    })

    // A body that is small but claims to be large can only be refused from its Content-Length, so this is the fast path.
    it('answers 413 on a Content-Length over the limit, without reading the body', async () => {
      const guest = await newGuest()

      const res = await plainPost('/api/v1/scans/products', new FormData(), { ...guest.headers(), 'Content-Length': String(OVER_SCAN_BODY_BYTES) })

      expect(res.status).toBe(413)
      expect(await errorCodeOf(res)).toBe('HTTP_413')
    })
  })

  describe('daily quota', () => {
    it('lets a user take 30 photos in a day and answers 429 SCAN_DAILY_LIMIT with Retry-After to the 31st', async () => {
      const guest = await newGuest()
      const ten = () => Array.from({ length: 10 }, (_, i) => fileOf(markedJpeg(i), `p${i}`))
      for (let i = 0; i < 3; i++) expect((await createScan(guest, ten(), freshIp())).status).toBe(202)

      const res = await createScan(guest, [fileOf(markedJpeg(1))], freshIp())

      expect(res.status).toBe(429)
      expect(await errorCodeOf(res)).toBe('SCAN_DAILY_LIMIT')
      expect(retryAfterOf(res)).toBeGreaterThan(0)
      expect(retryAfterOf(res)).toBeLessThanOrEqual(DAY_SECONDS + 1)
    })

    // The only way to see which address the service was given is the per-address daily quota (100 photos), which counts every user at that address.
    it('counts photos per address from cf-connecting-ip, whoever sends them, and not for another address', async () => {
      const shared = freshIp()
      const ten = () => Array.from({ length: 10 }, (_, i) => fileOf(markedJpeg(i), `p${i}`))
      for (const scans of [3, 3, 3, 1]) {
        const guest = await newGuest()
        for (let i = 0; i < scans; i++) expect((await createScan(guest, ten(), shared)).status).toBe(202)
      }
      const late = await newGuest()

      const refused = await createScan(late, [fileOf(markedJpeg(1))], shared)
      const elsewhere = await createScan(late, [fileOf(markedJpeg(1))], freshIp())

      expect(refused.status).toBe(429)
      expect(await errorCodeOf(refused)).toBe('SCAN_DAILY_LIMIT')
      expect(retryAfterOf(refused)).toBeGreaterThan(0)
      expect(elsewhere.status).toBe(202)
    })
  })

  describe('rate limits', () => {
    it('answers 429 RATE_LIMITED with Retry-After to the 21st scan from one address in a minute, whoever sends it', async () => {
      const shared = freshIp()
      const statuses: number[] = []
      let limited: Awaited<ReturnType<typeof createScan>> | undefined
      for (let i = 0; i < 21; i++) {
        const res = await createScan(await newGuest(), [fileOf(markedJpeg(i))], shared)
        statuses.push(res.status)
        if (res.status === 429) limited = res
      }

      expect(statuses.slice(0, 20)).toEqual(Array(20).fill(202))
      expect(statuses[20]).toBe(429)
      expect(await errorCodeOf(limited!)).toBe('RATE_LIMITED')
      expect(retryAfterOf(limited!)).toBeGreaterThan(0)
    })

    it('answers 429 RATE_LIMITED to the 11th scan of one user in a minute, from any address', async () => {
      const guest = await newGuest()
      const statuses: number[] = []
      let limited: Awaited<ReturnType<typeof createScan>> | undefined
      for (let i = 0; i < 11; i++) {
        const res = await createScan(guest, [fileOf(markedJpeg(i))], freshIp())
        statuses.push(res.status)
        if (res.status === 429) limited = res
      }

      expect(statuses.slice(0, 10)).toEqual(Array(10).fill(202))
      expect(statuses[10]).toBe(429)
      expect(await errorCodeOf(limited!)).toBe('RATE_LIMITED')
      expect(retryAfterOf(limited!)).toBeGreaterThan(0)
    })
  })
})

describe('GET /api/v1/scans/products/{scanId}', () => {
  it('shows the owner their scan: its id and items in photo order', async () => {
    const guest = await newGuest()
    const created = await createdScan(guest, [markedJpeg(1), webpPhoto()])

    const res = await getScan(guest, created.id)

    expect(res.status).toBe(200)
    const scan = await dataOf<ScanView>(res)
    expect(scan.id).toBe(created.id)
    expect(scan.items.map((i) => [i.id, i.position, i.state])).toEqual(created.items.map((i) => [i.id, i.position, i.state]))
  })

  it('shows what the recognizer read once it has read it', async () => {
    const guest = await newGuest()
    const scan = await createdScan(guest)
    const brand = freshBrand()
    stubAnthropic(recognisedAs(brand, 'Hydrating Cleanser', 0.92))
    await runStep(scan.items[0]!.id, 'recognise')

    const shown = await dataOf<ScanView>(await getScan(guest, scan.id))

    expect(shown.items[0]).toMatchObject({ state: 'matching', recognised: { brand, name: 'Hydrating Cleanser', category: 'skin' } })
  })

  it.each([
    ['another user\'s scan', async () => ({ viewer: await newGuest(), scanId: (await createdScan(await newGuest())).id })],
    ['a scan that does not exist', async () => ({ viewer: await newGuest(), scanId: crypto.randomUUID() })],
  ])('answers 404 SCAN_NOT_FOUND for %s', async (_label, arrange) => {
    const { viewer, scanId } = await arrange()

    const res = await getScan(viewer, scanId)

    expect(res.status).toBe(404)
    expect(await errorCodeOf(res)).toBe('SCAN_NOT_FOUND')
  })
})

describe('POST /api/v1/scans/products/{scanId}/items/{itemId}/confirmation', () => {
  it('takes the corrected product with 202 and moves the item on to matching, queuing the match', async () => {
    const guest = await newGuest()
    const { scanId, itemId } = await awaitingConfirmation(guest)
    queued.length = 0

    const res = await confirm(guest, scanId, itemId, { brand: 'Glow Co', name: 'Bright Tone Serum', variant: 'Extra Strength', category: 'skin' })

    expect(res.status).toBe(202)
    expect(await read<ItemView>(res)).toMatchObject({
      success: true,
      status: 202,
      data: { id: itemId, state: 'matching', reason: null, recognised: { brand: 'Glow Co', name: 'Bright Tone Serum', variant: 'Extra Strength', category: 'skin' } },
    })
    expect(queued).toEqual([{ itemId, step: 'match', at: expect.any(Number) }])
    expect(await stateOf(guest, scanId, itemId)).toBe('matching')
  })

  it('answers 409 ITEM_NOT_AWAITING_CONFIRMATION for an item that is not waiting, and 409 again for a second confirmation', async () => {
    const guest = await newGuest()
    const fresh = await createdScan(guest)

    const early = await confirm(guest, fresh.id, fresh.items[0]!.id)
    expect(early.status).toBe(409)
    expect(await errorCodeOf(early)).toBe('ITEM_NOT_AWAITING_CONFIRMATION')

    const waiting = await awaitingConfirmation(guest)
    expect((await confirm(guest, waiting.scanId, waiting.itemId)).status).toBe(202)
    const again = await confirm(guest, waiting.scanId, waiting.itemId)
    expect(again.status).toBe(409)
    expect(await errorCodeOf(again)).toBe('ITEM_NOT_AWAITING_CONFIRMATION')
  })

  it.each([
    ['no brand', { name: 'Bright Tone Serum', category: 'skin' }],
    ['an empty name', { brand: 'Glow Co', name: '', category: 'skin' }],
    ['no category', { brand: 'Glow Co', name: 'Bright Tone Serum' }],
  ])('refuses %s with 400 VALIDATION_FAILED, leaving the item waiting', async (_label, body) => {
    const guest = await newGuest()
    const { scanId, itemId } = await awaitingConfirmation(guest)

    const res = await confirm(guest, scanId, itemId, body)

    expect(res.status).toBe(400)
    expect(await errorCodeOf(res)).toBe('VALIDATION_FAILED')
    expect(await stateOf(guest, scanId, itemId)).toBe('needs-confirmation')
  })

  it('answers 404 SCAN_NOT_FOUND to another user, changing nothing', async () => {
    const owner = await newGuest()
    const { scanId, itemId } = await awaitingConfirmation(owner)

    const res = await confirm(await newGuest(), scanId, itemId)

    expect(res.status).toBe(404)
    expect(await errorCodeOf(res)).toBe('SCAN_NOT_FOUND')
    expect(await stateOf(owner, scanId, itemId)).toBe('needs-confirmation')
  })
})

describe('POST /api/v1/scans/products/{scanId}/items/{itemId}/back-photo', () => {
  it('takes the back photo with 202, moves the item to reading-label and queues the read', async () => {
    const guest = await newGuest()
    const { scanId, itemId } = await awaitingBackPhoto(guest)
    queued.length = 0

    const res = await addBackPhoto(guest, scanId, itemId, fileOf(webpPhoto(), 'back'))

    expect(res.status).toBe(202)
    expect(await read<ItemView>(res)).toMatchObject({ success: true, status: 202, data: { id: itemId, state: 'reading-label', reason: null } })
    expect(queued).toEqual([{ itemId, step: 'read-label', at: expect.any(Number) }])
    expect(await stateOf(guest, scanId, itemId)).toBe('reading-label')
  })

  it('ends the item as failed/label-unreadable after 3 unreadable back photos, and answers 409 ITEM_NOT_AWAITING_BACK_PHOTO to a 4th', async () => {
    const guest = await newGuest()
    const { scanId, itemId } = await awaitingBackPhoto(guest)
    const unreadable = () => messageResponse({ content: [textBlock(JSON.stringify({ readable: false, ingredients: [] }))] })
    const itemNow = async () => (await dataOf<ScanView>(await getScan(guest, scanId))).items.find((i) => i.id === itemId)!

    for (const photo of [10, 11, 12]) {
      expect((await addBackPhoto(guest, scanId, itemId, fileOf(markedJpeg(photo), 'back'))).status).toBe(202)
      stubAnthropic(unreadable)
      await runStep(itemId, 'read-label')
      vi.unstubAllGlobals()
      if (photo < 12) expect(await itemNow()).toMatchObject({ state: 'needs-back-photo', reason: 'label-unreadable' })
    }

    expect(await itemNow()).toMatchObject({ state: 'failed', reason: 'label-unreadable' })
    const res = await addBackPhoto(guest, scanId, itemId, fileOf(markedJpeg(13), 'back'))
    expect(res.status).toBe(409)
    expect(await errorCodeOf(res)).toBe('ITEM_NOT_AWAITING_BACK_PHOTO')
  })

  it('answers 409 ITEM_NOT_AWAITING_BACK_PHOTO for an item that is not waiting for one', async () => {
    const guest = await newGuest()
    const scan = await createdScan(guest)

    const res = await addBackPhoto(guest, scan.id, scan.items[0]!.id)

    expect(res.status).toBe(409)
    expect(await errorCodeOf(res)).toBe('ITEM_NOT_AWAITING_BACK_PHOTO')
  })

  it('answers 404 SCAN_NOT_FOUND to another user', async () => {
    const owner = await newGuest()
    const scan = await createdScan(owner)

    const res = await addBackPhoto(await newGuest(), scan.id, scan.items[0]!.id)

    expect(res.status).toBe(404)
    expect(await errorCodeOf(res)).toBe('SCAN_NOT_FOUND')
  })

  describe('what it refuses', () => {
    const waiting = async () => {
      const guest = await newGuest()
      return { guest, ...(await awaitingBackPhoto(guest)) }
    }

    it('refuses a JSON body with 415', async () => {
      const { guest, scanId, itemId } = await waiting()

      const res = await plainPost(`/api/v1/scans/products/${scanId}/items/${itemId}/back-photo`, JSON.stringify({ photo: 'x' }), { ...guest.headers(), 'Content-Type': 'application/json' })

      expect(res.status).toBe(415)
    })

    // The typed client sends exactly one `photo`, so the shapes it cannot express are sent as a plain form.
    it('refuses two photos, and no photo, with 400 VALIDATION_FAILED, leaving the item waiting', async () => {
      const { guest, scanId, itemId } = await waiting()
      const path = `/api/v1/scans/products/${scanId}/items/${itemId}/back-photo`
      const two = new FormData()
      two.append('photo', fileOf(markedJpeg(1)))
      two.append('photo', fileOf(markedJpeg(2)))

      const tooMany = await plainPost(path, two, guest.headers())
      const none = await plainPost(path, new FormData(), guest.headers())

      for (const res of [tooMany, none]) {
        expect(res.status).toBe(400)
        expect(await errorCodeOf(res)).toBe('VALIDATION_FAILED')
      }
      expect(await stateOf(guest, scanId, itemId)).toBe('needs-back-photo')
    })

    it('refuses a photo part that is text, not a file, with 400 VALIDATION_FAILED, leaving the item waiting', async () => {
      const { guest, scanId, itemId } = await waiting()
      const form = new FormData()
      form.append('photo', 'not a file')

      const res = await plainPost(`/api/v1/scans/products/${scanId}/items/${itemId}/back-photo`, form, guest.headers())

      expect(res.status).toBe(400)
      expect(await errorCodeOf(res)).toBe('VALIDATION_FAILED')
      expect(await stateOf(guest, scanId, itemId)).toBe('needs-back-photo')
    })

    it('answers 413 on a Content-Length over the limit, without reading the body', async () => {
      const { guest, scanId, itemId } = await waiting()

      const res = await plainPost(`/api/v1/scans/products/${scanId}/items/${itemId}/back-photo`, new FormData(), {
        ...guest.headers(),
        'Content-Length': String(MAX_PHOTO_BYTES + 1_000_000 + 1),
      })

      expect(res.status).toBe(413)
      expect(await errorCodeOf(res)).toBe('HTTP_413')
    })

    it('refuses a PNG with 400 UNSUPPORTED_IMAGE, leaving the item waiting', async () => {
      const { guest, scanId, itemId } = await waiting()

      const res = await addBackPhoto(guest, scanId, itemId, fileOf(pngPhoto(), 'back', 'image/png'))

      expect(res.status).toBe(400)
      expect(await errorCodeOf(res)).toBe('UNSUPPORTED_IMAGE')
      expect(await stateOf(guest, scanId, itemId)).toBe('needs-back-photo')
    })
  })

  it('answers 429 RATE_LIMITED to the 11th back photo of one user in a minute, from any address', async () => {
    const guest = await newGuest()
    const statuses: number[] = []
    let limited: Awaited<ReturnType<typeof addBackPhoto>> | undefined
    for (let i = 0; i < 11; i++) {
      // Not the user's scan: the limit is counted before the route looks at which scan it is.
      const res = await scansApi[':scanId'].items[':itemId']['back-photo'].$post(
        { param: { scanId: crypto.randomUUID(), itemId: crypto.randomUUID() }, form: { photo: fileOf(markedJpeg(i)) } },
        { headers: guest.headers(freshIp()) },
      )
      statuses.push(res.status)
      if (res.status === 429) limited = res
    }

    expect(statuses.slice(0, 10)).not.toContain(429)
    expect(statuses[10]).toBe(429)
    expect(await errorCodeOf(limited!)).toBe('RATE_LIMITED')
    expect(retryAfterOf(limited!)).toBeGreaterThan(0)
  })

  it('answers 429 RATE_LIMITED to the 21st back photo from one address in a minute, whoever sends it', async () => {
    const shared = freshIp()
    const statuses: number[] = []
    let limited: Awaited<ReturnType<typeof addBackPhoto>> | undefined
    for (let i = 0; i < 21; i++) {
      // Another user each time, so only the address is shared; the scan is not theirs, as the limit is counted before it is looked up.
      const res = await scansApi[':scanId'].items[':itemId']['back-photo'].$post(
        { param: { scanId: crypto.randomUUID(), itemId: crypto.randomUUID() }, form: { photo: fileOf(markedJpeg(i)) } },
        { headers: (await newGuest()).headers(shared) },
      )
      statuses.push(res.status)
      if (res.status === 429) limited = res
    }

    expect(statuses.slice(0, 20)).not.toContain(429)
    expect(statuses[20]).toBe(429)
    expect(await errorCodeOf(limited!)).toBe('RATE_LIMITED')
    expect(retryAfterOf(limited!)).toBeGreaterThan(0)
  })
})

describe('POST /api/v1/scans/products/{scanId}/items/{itemId}/retake', () => {
  it('takes the retaken photo with 202, moves the item to recognising with no reason and queues the recognise', async () => {
    const guest = await newGuest()
    const { scanId, itemId } = await awaitingRetake(guest, labelNotVisible)
    queued.length = 0

    const res = await retake(guest, scanId, itemId, fileOf(webpPhoto(), 'retake'))

    expect(res.status).toBe(202)
    expect(await read<ItemView>(res)).toMatchObject({ success: true, status: 202, data: { id: itemId, state: 'recognising', reason: null, image: { kind: 'user' } } })
    expect(queued).toEqual([{ itemId, step: 'recognise', at: expect.any(Number) }])
    expect(await stateOf(guest, scanId, itemId)).toBe('recognising')
  })

  it('says how many retakes are left while the item asks for one, and asks for identification after the third unreadable photo', async () => {
    const guest = await newGuest()
    const { scanId, itemId } = await awaitingRetake(guest, unreadable)
    expect(await itemNow(guest, scanId, itemId)).toMatchObject({ state: 'needs-retake', reason: 'unreadable', retakesLeft: 2, image: null })

    expect((await retake(guest, scanId, itemId, fileOf(markedJpeg(22), 'retake'))).status).toBe(202)
    stubAnthropic(labelNotVisible)
    await runStep(itemId, 'recognise')
    vi.unstubAllGlobals()
    expect(await itemNow(guest, scanId, itemId)).toMatchObject({ state: 'needs-retake', reason: 'label-not-visible', retakesLeft: 1, image: null })

    expect((await retake(guest, scanId, itemId, fileOf(markedJpeg(23), 'retake'))).status).toBe(202)
    stubAnthropic(unreadable)
    await runStep(itemId, 'recognise')
    vi.unstubAllGlobals()
    const identifying = await itemNow(guest, scanId, itemId)
    expect(identifying).toMatchObject({ state: 'needs-identification', reason: 'unreadable', image: null })
    expect(identifying).not.toHaveProperty('retakesLeft')

    const fourth = await retake(guest, scanId, itemId, fileOf(markedJpeg(24), 'retake'))
    expect(fourth.status).toBe(409)
    expect(await errorCodeOf(fourth)).toBe('ITEM_NOT_AWAITING_RETAKE')
  })

  it('goes on to matching when the retaken photo reads', async () => {
    const guest = await newGuest()
    const { scanId, itemId } = await awaitingRetake(guest)
    expect((await retake(guest, scanId, itemId)).status).toBe(202)
    stubAnthropic(recognisedAs(freshBrand(), 'Hydrating Cleanser', 0.92))

    await runStep(itemId, 'recognise')

    expect(await itemNow(guest, scanId, itemId)).toMatchObject({ state: 'matching', reason: null })
  })

  it('answers 409 ITEM_NOT_AWAITING_RETAKE for an item that is not asking for one, and again for a second retake', async () => {
    const guest = await newGuest()
    const fresh = await createdScan(guest)
    const waiting = await awaitingRetake(guest)

    const notAsking = await retake(guest, fresh.id, fresh.items[0]!.id)
    expect(notAsking.status).toBe(409)
    expect(await errorCodeOf(notAsking)).toBe('ITEM_NOT_AWAITING_RETAKE')

    expect((await retake(guest, waiting.scanId, waiting.itemId)).status).toBe(202)
    const again = await retake(guest, waiting.scanId, waiting.itemId)
    expect(again.status).toBe(409)
    expect(await errorCodeOf(again)).toBe('ITEM_NOT_AWAITING_RETAKE')
  })

  it('answers 404 SCAN_NOT_FOUND to another user, changing nothing', async () => {
    const owner = await newGuest()
    const { scanId, itemId } = await awaitingRetake(owner)

    const res = await retake(await newGuest(), scanId, itemId)

    expect(res.status).toBe(404)
    expect(await errorCodeOf(res)).toBe('SCAN_NOT_FOUND')
    expect(await stateOf(owner, scanId, itemId)).toBe('needs-retake')
  })

  describe('what it refuses', () => {
    const waiting = async () => {
      const guest = await newGuest()
      return { guest, ...(await awaitingRetake(guest)) }
    }
    const path = (scanId: string, itemId: string) => `/api/v1/scans/products/${scanId}/items/${itemId}/retake`

    it('refuses a JSON body with 415', async () => {
      const { guest, scanId, itemId } = await waiting()

      const res = await plainPost(path(scanId, itemId), JSON.stringify({ photo: 'x' }), { ...guest.headers(), 'Content-Type': 'application/json' })

      expect(res.status).toBe(415)
    })

    it('refuses two photos, and no photo, with 400 VALIDATION_FAILED, leaving the item waiting', async () => {
      const { guest, scanId, itemId } = await waiting()
      const two = new FormData()
      two.append('photo', fileOf(markedJpeg(1)))
      two.append('photo', fileOf(markedJpeg(2)))

      const tooMany = await plainPost(path(scanId, itemId), two, guest.headers())
      const none = await plainPost(path(scanId, itemId), new FormData(), guest.headers())

      for (const res of [tooMany, none]) {
        expect(res.status).toBe(400)
        expect(await errorCodeOf(res)).toBe('VALIDATION_FAILED')
      }
      expect(await stateOf(guest, scanId, itemId)).toBe('needs-retake')
    })

    it('answers 413 on a Content-Length over 3,000,000 bytes, without reading the body', async () => {
      const { guest, scanId, itemId } = await waiting()

      const res = await plainPost(path(scanId, itemId), new FormData(), { ...guest.headers(), 'Content-Length': String(MAX_PHOTO_BYTES + 1_000_000 + 1) })

      expect(res.status).toBe(413)
      expect(await errorCodeOf(res)).toBe('HTTP_413')
    })

    it('refuses a PNG with 400 UNSUPPORTED_IMAGE, leaving the item waiting', async () => {
      const { guest, scanId, itemId } = await waiting()

      const res = await retake(guest, scanId, itemId, fileOf(pngPhoto(), 'retake', 'image/png'))

      expect(res.status).toBe(400)
      expect(await errorCodeOf(res)).toBe('UNSUPPORTED_IMAGE')
      expect(await stateOf(guest, scanId, itemId)).toBe('needs-retake')
    })

    it('refuses a photo with an edge of 1601 pixels as IMAGE_TOO_LARGE, and accepts one of 1600', async () => {
      const { guest, scanId, itemId } = await waiting()

      const tooBig = await retake(guest, scanId, itemId, fileOf(jpegPhoto({ width: 1601, height: 100 }), 'retake'))
      expect(tooBig.status).toBe(400)
      expect(await errorCodeOf(tooBig)).toBe('IMAGE_TOO_LARGE')

      expect((await retake(guest, scanId, itemId, fileOf(jpegPhoto({ width: 1600, height: 100 }), 'retake'))).status).toBe(202)
    })
  })

  describe('daily quota', () => {
    it('counts a retake as one of the 30 photos a day: the 30th is accepted and the 31st answers 429 SCAN_DAILY_LIMIT with Retry-After', async () => {
      const guest = await newGuest()
      const photos = (count: number) => Array.from({ length: count }, (_, i) => fileOf(markedJpeg(i + 1), `p${i}`))
      expect((await createScan(guest, photos(10), freshIp())).status).toBe(202)
      expect((await createScan(guest, photos(10), freshIp())).status).toBe(202)
      const last = await dataOf<ScanView>(await createScan(guest, photos(9), freshIp()))
      const itemId = last.items[0]!.id
      stubAnthropic(unreadable)
      await runStep(itemId, 'recognise')
      expect(await stateOf(guest, last.id, itemId)).toBe('needs-retake')

      const thirtieth = await retake(guest, last.id, itemId, fileOf(markedJpeg(31), 'retake'), freshIp())
      expect(thirtieth.status).toBe(202)
      await runStep(itemId, 'recognise')
      expect(await stateOf(guest, last.id, itemId)).toBe('needs-retake')
      const refused = await retake(guest, last.id, itemId, fileOf(markedJpeg(32), 'retake'), freshIp())

      expect(refused.status).toBe(429)
      expect(await errorCodeOf(refused)).toBe('SCAN_DAILY_LIMIT')
      expect(retryAfterOf(refused)).toBeGreaterThan(0)
      expect(retryAfterOf(refused)).toBeLessThanOrEqual(DAY_SECONDS + 1)
      expect(await stateOf(guest, last.id, itemId)).toBe('needs-retake')
    })
  })

  describe('rate limits', () => {
    const unknownItem = () => ({ scanId: crypto.randomUUID(), itemId: crypto.randomUUID() })

    it('answers 429 RATE_LIMITED to the 11th retake of one user in a minute, from any address', async () => {
      const guest = await newGuest()
      const statuses: number[] = []
      let limited: Awaited<ReturnType<typeof retake>> | undefined
      for (let i = 0; i < 11; i++) {
        // Not the user's scan: the limit is counted before the route looks at which scan it is.
        const { scanId, itemId } = unknownItem()
        const res = await retake(guest, scanId, itemId, fileOf(markedJpeg(i)), freshIp())
        statuses.push(res.status)
        if (res.status === 429) limited = res
      }

      expect(statuses.slice(0, 10)).not.toContain(429)
      expect(statuses[10]).toBe(429)
      expect(await errorCodeOf(limited!)).toBe('RATE_LIMITED')
      expect(retryAfterOf(limited!)).toBeGreaterThan(0)
    })

    it('answers 429 RATE_LIMITED to the 21st retake from one address in a minute, whoever sends it', async () => {
      const shared = freshIp()
      const statuses: number[] = []
      let limited: Awaited<ReturnType<typeof retake>> | undefined
      for (let i = 0; i < 21; i++) {
        const { scanId, itemId } = unknownItem()
        const res = await retake(await newGuest(), scanId, itemId, fileOf(markedJpeg(i)), shared)
        statuses.push(res.status)
        if (res.status === 429) limited = res
      }

      expect(statuses.slice(0, 20)).not.toContain(429)
      expect(statuses[20]).toBe(429)
      expect(await errorCodeOf(limited!)).toBe('RATE_LIMITED')
      expect(retryAfterOf(limited!)).toBeGreaterThan(0)
    })
  })
})

describe('GET /api/v1/scans/products/photos/{token}', () => {
  it.each([
    ['JPEG', () => markedJpeg(5), 'image/jpeg'],
    ['WebP', () => webpPhoto(), 'image/webp'],
  ])('gives the bytes of a %s photo to anyone holding the link, with its type and no caching, and no Authorization', async (_label, make, mediaType) => {
    const photo = make()
    const scan = await createdScan(await newGuest(), [photo])

    const res = await openPhoto(tokenOf(scan.items[0]!))

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe(mediaType)
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(await bytesOf(res)).toEqual(photo.bytes)
  })

  it('ignores an Authorization header that is broken or expired', async () => {
    const guest = await newGuest()
    const scan = await createdScan(guest)
    const expired = await new TokenService({ secret: env.JWT_SECRET, now: () => new Date(NOW - 16 * MINUTE) }).issue({ id: guest.userId, status: 'anonymous', tokenVersion: 0 }, 'any-profile')
    const token = tokenOf(scan.items[0]!)

    expect((await openPhoto(token, { Authorization: 'Bearer not.a.jwt' })).status).toBe(200)
    expect((await openPhoto(token, { Authorization: `Bearer ${expired.accessToken}` })).status).toBe(200)
  })

  describe('answers 404 PHOTO_NOT_FOUND, in the error envelope, to', () => {
    const arrange = async () => {
      const guest = await newGuest()
      const scan = await createdScan(guest)
      const item = scan.items[0]!
      const key = `photos/${env.ENVIRONMENT}/${guest.userId}/${scan.id}/${item.id}.jpg`
      return { guest, key, good: tokenOf(item) }
    }

    it.each([
      ['a token that is not a link', async () => 'not-a-token'],
      ['a token over 2048 characters', async () => 'a'.repeat(3000)],
      ['a link with one character changed', async () => {
        const { good } = await arrange()
        return good.slice(0, 20) + (good[20] === 'A' ? 'B' : 'A') + good.slice(21)
      }],
      ['a link signed with another secret', async () => {
        const { guest, key } = await arrange()
        return signPhotoLink({ key, userId: guest.userId, expiresAt: new Date(NOW + MINUTE) }, 'some-other-secret', new Date(NOW))
      }],
      ['a link that expired a second ago', async () => {
        const { guest, key } = await arrange()
        return signPhotoLink({ key, userId: guest.userId, expiresAt: new Date(NOW - SECOND) }, env.JWT_SECRET, new Date(NOW - 2 * SECOND))
      }],
    ])('%s', async (_label, tokenFor) => {
      const res = await openPhoto(await tokenFor())

      expect(res.status).toBe(404)
      expect(res.headers.get('Content-Type')).toContain('application/json')
      expect(await read<unknown>(res)).toMatchObject({ success: false, status: 404, error: { code: 'PHOTO_NOT_FOUND' } })
    })
  })
})

describe('signing in', () => {
  const ids = () => ({ param: { scanId: crypto.randomUUID(), itemId: crypto.randomUUID() } })
  // Each route is sent a valid request: the confirmation route checks its JSON body before the sign-in, so an empty one would be 400 or 415 and hide the 401.
  // (The two upload routes answer 401 first, whatever the body; see "on the upload routes" below.)
  const bearerRoutes: [string, (headers: Record<string, string>) => Promise<Reply>][] = [
    ['POST /api/v1/scans/products', (headers) => scansApi.$post({ form: { photos: [fileOf(markedJpeg(1))] } }, { headers })],
    ['GET /api/v1/scans/products/{scanId}', (headers) => scansApi[':scanId'].$get({ param: { scanId: crypto.randomUUID() } }, { headers })],
    ['POST /api/v1/scans/products/{scanId}/items/{itemId}/confirmation', (headers) =>
      scansApi[':scanId'].items[':itemId'].confirmation.$post({ ...ids(), json: { brand: 'Glow Co', name: 'Bright Tone Serum', category: 'skin' } as never }, { headers })],
    ['POST /api/v1/scans/products/{scanId}/items/{itemId}/back-photo', (headers) =>
      scansApi[':scanId'].items[':itemId']['back-photo'].$post({ ...ids(), form: { photo: fileOf(markedJpeg(9)) } }, { headers })],
    ['POST /api/v1/scans/products/{scanId}/items/{itemId}/retake', (headers) =>
      scansApi[':scanId'].items[':itemId'].retake.$post({ ...ids(), form: { photo: fileOf(markedJpeg(9)) } }, { headers })],
  ]

  it.each(bearerRoutes)('%s answers 401 AUTH_REQUIRED without a token', async (_route, call) => {
    const res = await call({ 'cf-connecting-ip': freshIp() })

    expect(res.status).toBe(401)
    expect(await errorCodeOf(res)).toBe('AUTH_REQUIRED')
  })

  it.each(bearerRoutes)('%s answers 401 TOKEN_EXPIRED for an access token past its 15 minutes', async (_route, call) => {
    const guest = await newGuest()
    const old = await new TokenService({ secret: env.JWT_SECRET, now: () => new Date(NOW - 16 * MINUTE) }).issue({ id: guest.userId, status: 'anonymous', tokenVersion: 0 }, 'any-profile')

    const res = await call({ 'cf-connecting-ip': freshIp(), Authorization: `Bearer ${old.accessToken}` })

    expect(res.status).toBe(401)
    expect(await errorCodeOf(res)).toBe('TOKEN_EXPIRED')
  })

  // An unsigned caller must not cost an upload parse: on both upload routes the sign-in is answered before the body is looked at,
  // so what would otherwise be 413, 415 or 400 is 401.
  describe('on the upload routes, before the body is looked at', () => {
    const itemPath = () => `/api/v1/scans/products/${crypto.randomUUID()}/items/${crypto.randomUUID()}/back-photo`
    const retakePath = () => `/api/v1/scans/products/${crypto.randomUUID()}/items/${crypto.randomUUID()}/retake`
    const uploads: [string, () => string, number][] = [
      ['POST /api/v1/scans/products', () => '/api/v1/scans/products', OVER_SCAN_BODY_BYTES],
      ['POST /api/v1/scans/products/{scanId}/items/{itemId}/back-photo', itemPath, MAX_PHOTO_BYTES + 1_000_000 + 1],
      ['POST /api/v1/scans/products/{scanId}/items/{itemId}/retake', retakePath, MAX_PHOTO_BYTES + 1_000_000 + 1],
    ]
    const textPart = () => { const form = new FormData(); form.append('photos', 'not a file'); form.append('photo', 'not a file'); return form }

    it.each(uploads)('%s answers 401 AUTH_REQUIRED, not 415, to a JSON body without a token', async (_route, path) => {
      const res = await plainPost(path(), JSON.stringify({ photos: [] }), { 'cf-connecting-ip': freshIp(), 'Content-Type': 'application/json' })

      expect(res.status).toBe(401)
      expect(await errorCodeOf(res)).toBe('AUTH_REQUIRED')
    })

    it.each(uploads)('%s answers 401 AUTH_REQUIRED, not 400, to a form that does not validate, without a token', async (_route, path) => {
      const res = await plainPost(path(), textPart(), { 'cf-connecting-ip': freshIp() })

      expect(res.status).toBe(401)
      expect(await errorCodeOf(res)).toBe('AUTH_REQUIRED')
    })

    it.each(uploads)('%s answers 401 AUTH_REQUIRED, not 413, to a Content-Length over the limit, without a token', async (_route, path, over) => {
      const res = await plainPost(path(), new FormData(), { 'cf-connecting-ip': freshIp(), 'Content-Length': String(over) })

      expect(res.status).toBe(401)
      expect(await errorCodeOf(res)).toBe('AUTH_REQUIRED')
    })

    it.each(uploads)('%s answers 401 TOKEN_EXPIRED, not 400, to an expired token with a form that does not validate', async (_route, path) => {
      const guest = await newGuest()
      const old = await new TokenService({ secret: env.JWT_SECRET, now: () => new Date(NOW - 16 * MINUTE) }).issue({ id: guest.userId, status: 'anonymous', tokenVersion: 0 }, 'any-profile')

      const res = await plainPost(path(), textPart(), { 'cf-connecting-ip': freshIp(), Authorization: `Bearer ${old.accessToken}` })

      expect(res.status).toBe(401)
      expect(await errorCodeOf(res)).toBe('TOKEN_EXPIRED')
    })

    it.each(uploads)('%s answers 401 TOKEN_INVALID to a token that is not ours', async (_route, path) => {
      const res = await plainPost(path(), textPart(), { 'cf-connecting-ip': freshIp(), Authorization: 'Bearer not.a.jwt' })

      expect(res.status).toBe(401)
      expect(await errorCodeOf(res)).toBe('TOKEN_INVALID')
    })

    // The address limit comes first, so a flood of unsigned requests from one address is still 429, not 401 for ever.
    it.each(uploads)('%s counts unsigned requests against the address limit before it answers 401', async (_route, path) => {
      const shared = freshIp()
      const statuses: number[] = []
      for (let i = 0; i < 21; i++) statuses.push((await plainPost(path(), new FormData(), { 'cf-connecting-ip': shared })).status)

      expect(statuses.slice(0, 20)).toEqual(Array(20).fill(401))
      expect(statuses[20]).toBe(429)
    })
  })

  it('needs no verification: a guest can use every route', async () => {
    const guest = await newGuest()

    const scan = await createdScan(guest)

    expect((await getScan(guest, scan.id)).status).toBe(200)
  })
})

describe('OpenAPI', () => {
  type Operation = {
    security?: Record<string, unknown>[]
    requestBody?: { required?: boolean; content: Record<string, unknown> }
    responses: Record<string, { content?: Record<string, unknown> }>
  }
  const documentOf = async () => {
    const res = await fetchWorker('http://deepertones.test/openapi.json')
    expect(res.status).toBe(200)
    return (await res.json()) as { paths: Record<string, Record<string, Operation>> }
  }
  const usesBearer = (operation?: Operation) => (operation?.security ?? []).some((requirement) => 'bearerAuth' in requirement)

  it('documents the sign-in each route needs: bearer everywhere but the public photo link', async () => {
    const { paths } = await documentOf()

    expect(usesBearer(paths['/api/v1/scans/products']?.post)).toBe(true)
    expect(usesBearer(paths['/api/v1/scans/products/{scanId}']?.get)).toBe(true)
    expect(usesBearer(paths['/api/v1/scans/products/{scanId}/items/{itemId}/confirmation']?.post)).toBe(true)
    expect(usesBearer(paths['/api/v1/scans/products/{scanId}/items/{itemId}/back-photo']?.post)).toBe(true)
    expect(usesBearer(paths['/api/v1/scans/products/{scanId}/items/{itemId}/retake']?.post)).toBe(true)
    expect(paths['/api/v1/scans/products/photos/{token}']?.get).toBeDefined()
    expect(usesBearer(paths['/api/v1/scans/products/photos/{token}']?.get)).toBe(false)
  })

  it('documents the uploads as multipart, the corrected product as JSON, and the photo as an image', async () => {
    const { paths } = await documentOf()

    expect(paths['/api/v1/scans/products']?.post?.requestBody).toMatchObject({ required: true, content: { 'multipart/form-data': expect.anything() } })
    expect(paths['/api/v1/scans/products/{scanId}/items/{itemId}/back-photo']?.post?.requestBody).toMatchObject({ required: true, content: { 'multipart/form-data': expect.anything() } })
    expect(paths['/api/v1/scans/products/{scanId}/items/{itemId}/retake']?.post?.requestBody).toMatchObject({ required: true, content: { 'multipart/form-data': expect.anything() } })
    expect(paths['/api/v1/scans/products/{scanId}/items/{itemId}/confirmation']?.post?.requestBody).toMatchObject({ required: true, content: { 'application/json': expect.anything() } })
    expect(Object.keys(paths['/api/v1/scans/products/photos/{token}']!.get!.responses['200']!.content!).sort()).toEqual(['image/jpeg', 'image/webp'])
  })

  it('lists the statuses the scan routes can answer with', async () => {
    const { paths } = await documentOf()
    const statuses = (path: string, method: string) => Object.keys(paths[path]![method]!.responses)

    expect(statuses('/api/v1/scans/products', 'post')).toEqual(expect.arrayContaining(['202', '400', '401', '413', '415', '429']))
    expect(statuses('/api/v1/scans/products/{scanId}', 'get')).toEqual(expect.arrayContaining(['200', '401', '404']))
    expect(statuses('/api/v1/scans/products/{scanId}/items/{itemId}/confirmation', 'post')).toEqual(expect.arrayContaining(['202', '400', '401', '404', '409']))
    expect(statuses('/api/v1/scans/products/{scanId}/items/{itemId}/back-photo', 'post')).toEqual(expect.arrayContaining(['202', '400', '401', '404', '409', '413', '415', '429']))
    expect(statuses('/api/v1/scans/products/{scanId}/items/{itemId}/retake', 'post')).toEqual(expect.arrayContaining(['202', '400', '401', '404', '409', '413', '415', '429']))
    expect(statuses('/api/v1/scans/products/photos/{token}', 'get')).toEqual(expect.arrayContaining(['200', '404']))
  })
})

// --- profiles: a scan belongs to the profile that made it ---
// There is no route to make a second profile yet, so one is inserted through the repository and a token for it is minted with
// the token service. The scan helpers above then work for either profile of the account.

describe('profiles', () => {
  const profiles = new D1ProfilesRepository(createDb(env.DB))
  const tokenService = new TokenService({ secret: env.JWT_SECRET })

  afterEach(() => abortAllDurableObjects())

  /** The same account acting as a second profile of its own: a guest whose token names a new profile. */
  const asSecondProfile = async (guest: Guest): Promise<Guest> => {
    const profile = { id: crypto.randomUUID(), userId: guest.userId, displayName: null, isDefault: false, createdAt: new Date(NOW + MINUTE) }
    await profiles.insert(profile)
    const { accessToken } = await tokenService.issue({ id: guest.userId, status: 'anonymous', tokenVersion: 0 }, profile.id)
    return { ...guest, token: accessToken, headers: (from: string = guest.ip) => ({ 'cf-connecting-ip': from, Authorization: `Bearer ${accessToken}` }) }
  }
  const watch = (guest: Guest, scanId: string) => fetchWorker(`http://deepertones.test/api/v1/scans/products/${scanId}/events`, { headers: guest.headers() })
  const expectNotFound = async (res: Reply) => {
    expect(res.status).toBe(404)
    expect(await errorCodeOf(res)).toBe('SCAN_NOT_FOUND')
  }

  it('shows a scan only to the profile that made it: the account\'s other profile gets 404 SCAN_NOT_FOUND, and the maker still sees it', async () => {
    const first = await newGuest()
    const second = await asSecondProfile(first)
    const scan = await createdScan(first)

    await expectNotFound(await getScan(second, scan.id))
    const shown = await getScan(first, scan.id)
    expect(shown.status).toBe(200)
    expect((await dataOf<ScanView>(shown)).id).toBe(scan.id)
  })

  it('files a scan under the active profile, not the default one: what the second profile makes, the first cannot see', async () => {
    const first = await newGuest()
    const second = await asSecondProfile(first)
    const scan = await createdScan(second)

    const own = await getScan(second, scan.id)
    expect(own.status).toBe(200)
    expect((await dataOf<ScanView>(own)).id).toBe(scan.id)
    await expectNotFound(await getScan(first, scan.id))
  })

  it('opens the live event stream only for the profile that made the scan; another profile of the account gets a plain 404', async () => {
    const first = await newGuest()
    const second = await asSecondProfile(first)
    const scan = await createdScan(first)

    const other = await watch(second, scan.id)
    expect(other.headers.get('Content-Type')).toContain('application/json')
    await expectNotFound(other)
    const own = await watch(first, scan.id)
    expect(own.status).toBe(200)
    expect(own.headers.get('Content-Type')).toContain('text/event-stream')
    await own.body!.cancel()
  })

  it('refuses another profile\'s confirmation with 404 SCAN_NOT_FOUND and changes nothing; the maker\'s confirmation is accepted', async () => {
    const first = await newGuest()
    const second = await asSecondProfile(first)
    const { scanId, itemId } = await awaitingConfirmation(first)

    await expectNotFound(await confirm(second, scanId, itemId))
    expect(await stateOf(first, scanId, itemId)).toBe('needs-confirmation')
    expect((await confirm(first, scanId, itemId)).status).toBe(202)
  })

  it('refuses another profile\'s back photo with 404 SCAN_NOT_FOUND and changes nothing; the maker\'s back photo is accepted', async () => {
    const first = await newGuest()
    const second = await asSecondProfile(first)
    const { scanId, itemId } = await awaitingBackPhoto(first)

    await expectNotFound(await addBackPhoto(second, scanId, itemId))
    expect(await stateOf(first, scanId, itemId)).toBe('needs-back-photo')
    expect((await addBackPhoto(first, scanId, itemId)).status).toBe(202)
  })

  it('refuses another profile\'s retake with 404 SCAN_NOT_FOUND and changes nothing; the maker\'s retake is accepted', async () => {
    const first = await newGuest()
    const second = await asSecondProfile(first)
    const { scanId, itemId } = await awaitingRetake(first)

    await expectNotFound(await retake(second, scanId, itemId))
    expect(await stateOf(first, scanId, itemId)).toBe('needs-retake')
    expect((await retake(first, scanId, itemId)).status).toBe(202)
  })

  describe('the daily quota', () => {
    const ten = () => Array.from({ length: 10 }, (_, i) => fileOf(markedJpeg(i), `p${i}`))

    // 20 photos from the first profile and 10 from the second are exactly the 30 an account may take in a day.
    // Counted per profile, the 31st photo would still be allowed.
    it('is shared by the account\'s profiles: 20 photos from one and 10 from another use up the 30, and the 31st is refused to either', async () => {
      const first = await newGuest()
      const second = await asSecondProfile(first)
      for (let i = 0; i < 2; i++) expect((await createScan(first, ten(), freshIp())).status).toBe(202)
      expect((await createScan(second, ten(), freshIp())).status).toBe(202)

      const refusedSecond = await createScan(second, [fileOf(markedJpeg(1))], freshIp())
      const refusedFirst = await createScan(first, [fileOf(markedJpeg(1))], freshIp())

      for (const res of [refusedSecond, refusedFirst]) {
        expect(res.status).toBe(429)
        expect(await errorCodeOf(res)).toBe('SCAN_DAILY_LIMIT')
        expect(retryAfterOf(res)).toBeGreaterThan(0)
      }
    })
  })
})
