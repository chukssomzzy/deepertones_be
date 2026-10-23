import { abortAllDurableObjects, createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../../src/index'
import { createDb } from '../../src/lib/db'
import { TokenService } from '../../src/modules/auth/tokens.service'
import { TABLES_VERSION } from '../../src/modules/face-scans/face-scans.tables'
import { D1ProfilesRepository } from '../../src/modules/profiles/profiles.repository'
import { garbagePhoto, jpegPhoto, pngPhoto, webpPhoto } from '../../src/modules/scans/scans.photos.fake'
import type { ProductImage } from '../../src/providers/product-analysis/product-analyst.provider'
import { BURST_NEEDS_MS, inOneRateWindow, RATE_TEST_TIMEOUT_MS } from './rate-window'
import { fitzpatrickSuccess, glowOutput, maskUrl, skinSuccess, stubPerfectCorp, taskError } from './perfect-corp.stub'
import { parseFrame, sseReader, type SseReader } from './sse'

// The face scan HTTP routes (consent, create, read, delete, the photo link, retake, the live stream) through the Worker's real entrypoint, with real
// local D1 and R2. The face-scans queue's producer is a recorder: what the routes queue is read back from it, and where a test needs the analysis to
// have run it feeds that message to the Worker's queue handler by hand, with Perfect Corp stubbed at fetch (./perfect-corp.stub; the real API is never
// called). Nothing at all is called for the goal (a chip needs no model).

const SECOND = 1000
const MINUTE = 60 * SECOND
// The one clock for what the routes stamp: "now" is the real clock the Worker runs on.
const STARTED = Date.now()
const CONSENT_VERSION = 1
/** What a request is asked to hold at most: 3 photos of 6,000,000 bytes and 1,000,000 of multipart framing; one byte over is refused unread. */
const MAX_FACE_PHOTO_BYTES = 6_000_000
const OVER_FACE_BODY_BYTES = 3 * MAX_FACE_PHOTO_BYTES + 1_000_000 + 1

const queued: unknown[] = []
let queueFails = false
const WORKER_ENV = {
  ...env,
  FACE_SCANS_QUEUE: {
    send: async (body: unknown) => {
      if (queueFails) throw new Error('queue is down')
      queued.push(body)
    },
  } as unknown as Queue,
}

const fetchWorker = (path: string, init?: RequestInit) => worker.fetch!(new Request(`http://deepertones.test${path}`, init) as never, WORKER_ENV, createExecutionContext())

afterEach(() => {
  queued.length = 0
  queueFails = false
})

const runSalt = String(Math.floor(Math.random() * 1e6))
let counter = 0
const next = () => counter++
// A new IP per caller keeps the rate limits (keyed by IP) from coupling tests.
const freshIp = () => {
  const n = next()
  return `10.${(Number(runSalt) + 7) % 250}.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`
}

type Envelope<T> = { success: true; status: number; message: string; data: T } | { success: false; status: number; error: { code: string; details?: Record<string, unknown> } }
const read = async <T>(res: Response) => (await res.json()) as Envelope<T>
const dataOf = async <T>(res: Response): Promise<T> => {
  const body = await read<T>(res)
  if (!body.success) throw new Error(`expected a success, got ${res.status} ${body.error.code}`)
  return body.data
}
const errorOf = async (res: Response) => {
  const body = await read<unknown>(res)
  if (body.success) throw new Error(`expected an error, got ${res.status}`)
  return body.error
}
const errorCodeOf = async (res: Response) => (await errorOf(res)).code

type FaceScanView = {
  id: string
  state: string
  reason: string | null
  goal: string
  createdAt: string
  photos: { front: { url: string }; right?: { url: string }; left?: { url: string } }
  rescanSuggested: boolean
  result: FaceScanResultView | null
}
type FaceScanResultView = {
  seen: { concern: string; region: string; level: 'faint' | 'a-little' | 'some' | 'clear'; words: string; overlay: { url: string } | null }[]
  alsoNoticed: { concern: string; region: string; level: 'faint' | 'a-little' | 'some' | 'clear'; words: string; overlay: { url: string } | null }[]
  nothingStandsOut: string | null
  skinType: string | null
  skinAge: { years: number; words: string } | null
  sinceDayOne: null | {
    dayOneScanId: string
    dayOneAt: string
    concerns: { concern: string; change: string; words: string }[]
    skinAge: { change: string; words: string } | null
  }
  tablesVersion: string
}
type ConsentView = { version: number; givenAt: string; withdrawnAt: string | null; current: boolean }

/** A guest signed in from its own address. `headers()` is the guest at that address; `headers(ip)` is the same guest from another one. */
const newGuest = async () => {
  const ip = freshIp()
  const res = await fetchWorker('/api/v1/auth/anonymous', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
    body: JSON.stringify({ deviceId: `device-face-${runSalt}-${next()}`, platform: 'ios' }),
  })
  const session = await dataOf<{ tokens: { accessToken: string }; user: { id: string } }>(res)
  const token = session.tokens.accessToken
  // The active profile is the token's `pid` claim.
  const profileId = (JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as { pid: string }).pid
  return {
    userId: session.user.id,
    profileId,
    token,
    ip,
    headers: (from: string = ip): Record<string, string> => ({ 'cf-connecting-ip': from, Authorization: `Bearer ${token}` }),
  }
}
type Guest = Awaited<ReturnType<typeof newGuest>>

const profiles = new D1ProfilesRepository(createDb(env.DB))
const tokenService = new TokenService({ secret: env.JWT_SECRET })
/** The same account acting as a second profile of its own: a guest whose token names a new profile. */
const asSecondProfile = async (guest: Guest): Promise<Guest> => {
  const profile = { id: crypto.randomUUID(), userId: guest.userId, displayName: null, isDefault: false, createdAt: new Date(STARTED + MINUTE) }
  await profiles.insert(profile)
  const { accessToken } = await tokenService.issue({ id: guest.userId, status: 'anonymous', tokenVersion: 0 }, profile.id)
  return { ...guest, profileId: profile.id, token: accessToken, headers: (from: string = guest.ip) => ({ 'cf-connecting-ip': from, Authorization: `Bearer ${accessToken}` }) }
}

const json = (guest: Guest | undefined, method: string, path: string, body?: unknown, from?: string) =>
  fetchWorker(path, {
    method,
    headers: { ...(guest ? guest.headers(from) : { 'cf-connecting-ip': freshIp() }), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })

const CONSENT = '/api/v1/me/face-consent'
const FACES = '/api/v1/scans/faces'
const putConsent = (guest: Guest | undefined, body: unknown = { version: CONSENT_VERSION }) => json(guest, 'PUT', CONSENT, body)
const getConsent = (guest: Guest | undefined) => json(guest, 'GET', CONSENT)
const deleteConsent = (guest: Guest | undefined) => json(guest, 'DELETE', CONSENT)
const setGoal = async (guest: Guest, goal: string) => expect((await json(guest, 'PUT', '/api/v1/me/goal', { goal })).status).toBe(200)
/** A guest who has said yes to the face photo consent and picked a goal: one that may scan. */
const readyGuest = async (goal = 'glow') => {
  const guest = await newGuest()
  expect((await putConsent(guest)).status).toBe(200)
  await setGoal(guest, goal)
  return guest
}

// A face photo: a JPEG whose header says 1080 x 1440 unless a test says otherwise, with a marker byte at the end so two can be told apart.
const face = (shape: { width?: number; height?: number; size?: number } = {}, marker = 1): ProductImage => {
  const photo = jpegPhoto({ width: 1080, height: 1440, ...shape })
  photo.bytes[photo.bytes.length - 1] = marker
  return photo
}
const fileOf = (photo: ProductImage, name: string, mediaType: string = photo.mediaType) => new File([photo.bytes], `${name}.${mediaType === 'image/webp' ? 'webp' : mediaType === 'image/png' ? 'png' : 'jpg'}`, { type: mediaType })
const formOf = (fields: Record<string, File | undefined>) => {
  const form = new FormData()
  for (const [name, file] of Object.entries(fields)) if (file) form.append(name, file)
  return form
}
const createFace = (guest: Guest | undefined, fields: Record<string, File | undefined> = { front: fileOf(face(), 'front') }, from?: string) =>
  fetchWorker(FACES, { method: 'POST', body: formOf(fields), headers: guest ? guest.headers(from) : { 'cf-connecting-ip': from ?? freshIp() } })
const createdFace = async (guest: Guest, fields?: Record<string, File | undefined>) => {
  const res = await createFace(guest, fields)
  expect(res.status).toBe(202)
  return dataOf<FaceScanView>(res)
}
const getFace = (guest: Guest | undefined, id: string) => json(guest, 'GET', `${FACES}/${id}`)
const deleteFace = (guest: Guest | undefined, id: string) => json(guest, 'DELETE', `${FACES}/${id}`)
const openPhoto = (token: string, headers: Record<string, string> = {}) => fetchWorker(`${FACES}/photos/${token}`, { headers })
const tokenOf = (url: string) => url.replace(`${FACES}/photos/`, '')
const threeFiles = () => ({ front: fileOf(face({}, 1), 'front'), right: fileOf(face({}, 2), 'right'), left: fileOf(face({}, 3), 'left') })

/** Everything the bucket holds for the user's face scans. */
const bucketKeysOf = async (userId: string) => (await env.PRIVATE_PHOTOS.list({ prefix: `faces/${env.ENVIRONMENT}/${userId}/` })).objects.map((object) => object.key)
const countOf = async (table: string, userId: string) => (await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE user_id = ?`).bind(userId).first<{ n: number }>())!.n
const perfectCorpSpendRows = async () => (await env.DB.prepare("SELECT count(*) AS n FROM ai_usage WHERE vendor = 'perfect-corp'").first<{ n: number }>())!.n
const nothingKept = async (guest: Guest) => {
  expect(await bucketKeysOf(guest.userId)).toEqual([])
  expect(await countOf('face_scans', guest.userId)).toBe(0)
  expect(await countOf('face_scan_photos', guest.userId)).toBe(0)
}

describe('PUT /api/v1/me/face-consent', () => {
  it('records consent for the current version and answers 200 with the version and when it was given', async () => {
    const guest = await newGuest()

    const res = await putConsent(guest)

    expect(res.status).toBe(200)
    const data = await dataOf<{ version: number; givenAt: string }>(res)
    expect(data.version).toBe(CONSENT_VERSION)
    expect(Object.keys(data).sort()).toEqual(['givenAt', 'version'])
    expect(Date.parse(data.givenAt)).toBeGreaterThanOrEqual(STARTED - SECOND)
    expect(Date.parse(data.givenAt)).toBeLessThanOrEqual(Date.now() + SECOND)
  })

  it('refuses a caller who is not signed in: 401 AUTH_REQUIRED', async () => {
    const res = await putConsent(undefined)

    expect(res.status).toBe(401)
    expect(await errorCodeOf(res)).toBe('AUTH_REQUIRED')
  })

  it.each([
    ['an older version', 0],
    ['a version the app does not know yet', 2],
  ])('refuses %s with 400 FACE_CONSENT_VERSION_MISMATCH, saying which is current, and records nothing', async (_label, version) => {
    const guest = await newGuest()

    const res = await putConsent(guest, { version })

    expect(res.status).toBe(400)
    const error = await errorOf(res)
    expect(error.code).toBe('FACE_CONSENT_VERSION_MISMATCH')
    expect(error.details).toEqual({ current: CONSENT_VERSION })
    expect((await getConsent(guest)).status).toBe(404)
  })

  it.each([
    ['no body field', {}],
    ['a version that is text', { version: '1' }],
    ['a version that is not a whole number', { version: 1.5 }],
    ['a version that is null', { version: null }],
  ])('refuses %s with 400 VALIDATION_FAILED', async (_label, body) => {
    const guest = await newGuest()

    const res = await putConsent(guest, body)

    expect(res.status).toBe(400)
    expect(await errorCodeOf(res)).toBe('VALIDATION_FAILED')
  })

  it('giving consent twice is fine and keeps one consent', async () => {
    const guest = await newGuest()
    expect((await putConsent(guest)).status).toBe(200)

    expect((await putConsent(guest)).status).toBe(200)

    expect((await dataOf<ConsentView>(await getConsent(guest))).current).toBe(true)
  })
})

describe('GET /api/v1/me/face-consent', () => {
  it('shows the version, when it was given, that it was not withdrawn, and that it is current', async () => {
    const guest = await newGuest()
    const given = await dataOf<{ givenAt: string }>(await putConsent(guest))

    const res = await getConsent(guest)

    expect(res.status).toBe(200)
    expect(await dataOf<ConsentView>(res)).toEqual({ version: CONSENT_VERSION, givenAt: given.givenAt, withdrawnAt: null, current: true })
  })

  it('is 404 FACE_CONSENT_NOT_FOUND until consent is given', async () => {
    const guest = await newGuest()

    const res = await getConsent(guest)

    expect(res.status).toBe(404)
    expect(await errorCodeOf(res)).toBe('FACE_CONSENT_NOT_FOUND')
  })

  it('refuses a caller who is not signed in: 401 AUTH_REQUIRED', async () => {
    const res = await getConsent(undefined)

    expect(res.status).toBe(401)
    expect(await errorCodeOf(res)).toBe('AUTH_REQUIRED')
  })

  it('belongs to the profile: the account\'s other profile has none', async () => {
    const first = await newGuest()
    const second = await asSecondProfile(first)
    expect((await putConsent(first)).status).toBe(200)

    const res = await getConsent(second)

    expect(res.status).toBe(404)
    expect(await errorCodeOf(res)).toBe('FACE_CONSENT_NOT_FOUND')
    expect((await getConsent(first)).status).toBe(200)
  })
})

describe('DELETE /api/v1/me/face-consent', () => {
  it('withdraws consent with 204 and no body, and keeps it on record as withdrawn and no longer current', async () => {
    const guest = await newGuest()
    const given = await dataOf<{ givenAt: string }>(await putConsent(guest))

    const res = await deleteConsent(guest)

    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
    const shown = await dataOf<ConsentView>(await getConsent(guest))
    expect(shown).toMatchObject({ version: CONSENT_VERSION, givenAt: given.givenAt, current: false })
    expect(Date.parse(shown.withdrawnAt!)).toBeGreaterThanOrEqual(STARTED - SECOND)
  })

  it('is 204 again when it is already withdrawn, and 204 when there was never any consent', async () => {
    const guest = await newGuest()
    expect((await deleteConsent(guest)).status).toBe(204)
    expect((await getConsent(guest)).status).toBe(404)
    await putConsent(guest)
    await deleteConsent(guest)

    expect((await deleteConsent(guest)).status).toBe(204)
  })

  it('is cleared by giving consent again', async () => {
    const guest = await newGuest()
    await putConsent(guest)
    await deleteConsent(guest)

    await putConsent(guest)

    expect(await dataOf<ConsentView>(await getConsent(guest))).toMatchObject({ withdrawnAt: null, current: true })
  })

  it('refuses a caller who is not signed in: 401 AUTH_REQUIRED', async () => {
    const res = await deleteConsent(undefined)

    expect(res.status).toBe(401)
    expect(await errorCodeOf(res)).toBe('AUTH_REQUIRED')
  })

  it('withdraws the active profile\'s consent only', async () => {
    const first = await newGuest()
    const second = await asSecondProfile(first)
    await putConsent(first)
    await putConsent(second)

    await deleteConsent(second)

    expect((await dataOf<ConsentView>(await getConsent(first))).current).toBe(true)
    expect((await dataOf<ConsentView>(await getConsent(second))).current).toBe(false)
  })
})

describe('POST /api/v1/scans/faces: who may scan', () => {
  it('refuses a caller who is not signed in: 401 AUTH_REQUIRED', async () => {
    const res = await createFace(undefined)

    expect(res.status).toBe(401)
    expect(await errorCodeOf(res)).toBe('AUTH_REQUIRED')
  })

  it('needs consent: 409 FACE_CONSENT_REQUIRED, with nothing stored in the bucket or the database and nothing queued', async () => {
    const guest = await newGuest()
    await setGoal(guest, 'glow')

    const res = await createFace(guest)

    expect(res.status).toBe(409)
    expect(await errorCodeOf(res)).toBe('FACE_CONSENT_REQUIRED')
    await nothingKept(guest)
    expect(queued).toEqual([])
  })

  it('counts a withdrawn consent as none', async () => {
    const guest = await readyGuest()
    await deleteConsent(guest)

    const res = await createFace(guest)

    expect(res.status).toBe(409)
    expect(await errorCodeOf(res)).toBe('FACE_CONSENT_REQUIRED')
    await nothingKept(guest)
  })

  it('needs the consent of the profile: the account\'s other profile has none of its own, though the first has', async () => {
    const first = await readyGuest()
    const second = await asSecondProfile(first)
    await setGoal(second, 'glow')

    const res = await createFace(second)

    expect(res.status).toBe(409)
    expect(await errorCodeOf(res)).toBe('FACE_CONSENT_REQUIRED')
    await nothingKept(second)
  })

  it('needs a goal: 409 GOAL_REQUIRED, with nothing stored or queued', async () => {
    const guest = await newGuest()
    await putConsent(guest)

    const res = await createFace(guest)

    expect(res.status).toBe(409)
    expect(await errorCodeOf(res)).toBe('GOAL_REQUIRED')
    await nothingKept(guest)
    expect(queued).toEqual([])
  })

  it('asks for consent before the goal, and for both before it looks at the photos', async () => {
    const guest = await newGuest()

    const res = await createFace(guest, { front: fileOf(webpPhoto({ width: 1080, height: 1440 }), 'front') })

    expect(res.status).toBe(409)
    expect(await errorCodeOf(res)).toBe('FACE_CONSENT_REQUIRED')
  })

  it('refuses a second scan under the goal of the latest one: 429 FACE_SCAN_NOT_DUE with the reason, storing and queueing nothing more', async () => {
    const guest = await readyGuest('glow')
    await createdFace(guest, threeFiles())
    const keysBefore = await bucketKeysOf(guest.userId)
    queued.length = 0

    const res = await createFace(guest, { front: fileOf(face({}, 9), 'front') })

    expect(res.status).toBe(429)
    const error = await errorOf(res)
    expect(error.code).toBe('FACE_SCAN_NOT_DUE')
    expect(error.details).toMatchObject({ reason: 'already-scanned-for-goal' })
    expect(await bucketKeysOf(guest.userId)).toEqual(keysBefore)
    expect(await countOf('face_scans', guest.userId)).toBe(1)
    expect(queued).toEqual([])
  })

  it('allows a scan again once the goal has changed', async () => {
    const guest = await readyGuest('glow')
    await createdFace(guest)
    await setGoal(guest, 'brighter')

    const second = await createdFace(guest, { front: fileOf(face({}, 2), 'front') })

    expect(second.goal).toBe('brighter')
    expect(await countOf('face_scans', guest.userId)).toBe(2)
  })

  it('does not let a scan that ended failed stand in the way of trying again', async () => {
    const guest = await readyGuest('glow')
    queueFails = true
    const failed = await createdFace(guest)
    expect(failed).toMatchObject({ state: 'failed', reason: 'unavailable' })
    queueFails = false

    const retry = await createdFace(guest, { front: fileOf(face({}, 2), 'front') })

    expect(retry.state).toBe('analysing')
  })
})

describe('POST /api/v1/scans/faces: the photos', () => {
  it.each([
    ['a WebP', () => fileOf(webpPhoto({ width: 1080, height: 1440 }), 'front', 'image/webp')],
    ['a PNG', () => fileOf(pngPhoto({ width: 1080, height: 1440 }), 'front', 'image/png')],
    ['bytes that are no image', () => fileOf(garbagePhoto(), 'front')],
  ])('refuses %s with 400 UNSUPPORTED_IMAGE and stores nothing', async (_label, make) => {
    const guest = await readyGuest()

    const res = await createFace(guest, { front: make() })

    expect(res.status).toBe(400)
    expect(await errorCodeOf(res)).toBe('UNSUPPORTED_IMAGE')
    await nothingKept(guest)
    expect(queued).toEqual([])
  })

  it('refuses the whole scan, storing none of it, when one of the optional photos is bad', async () => {
    const guest = await readyGuest()

    const res = await createFace(guest, { front: fileOf(face(), 'front'), left: fileOf(pngPhoto({ width: 1080, height: 1440 }), 'left', 'image/png') })

    expect(res.status).toBe(400)
    expect(await errorCodeOf(res)).toBe('UNSUPPORTED_IMAGE')
    await nothingKept(guest)
  })

  it('refuses a photo one pixel short on its short side with 400 IMAGE_TOO_SMALL, and takes one of exactly 1080', async () => {
    const guest = await readyGuest()

    const small = await createFace(guest, { front: fileOf(face({ width: 1079, height: 1920 }), 'front') })
    expect(small.status).toBe(400)
    expect(await errorCodeOf(small)).toBe('IMAGE_TOO_SMALL')
    await nothingKept(guest)

    expect((await createFace(guest, { front: fileOf(face({ width: 1080, height: 1920 }), 'front') })).status).toBe(202)
  })

  it('refuses a photo over 4096 on its long side with a 400, and stores nothing', async () => {
    const guest = await readyGuest()

    const res = await createFace(guest, { front: fileOf(face({ width: 1080, height: 4097 }), 'front') })

    expect(res.status).toBe(400)
    expect(['IMAGE_TOO_LARGE', 'UNSUPPORTED_IMAGE']).toContain(await errorCodeOf(res))
    await nothingKept(guest)
  })

  it('refuses a photo one byte over 6,000,000 with 400 IMAGE_TOO_LARGE, and takes one of exactly 6,000,000', async () => {
    const guest = await readyGuest()

    const over = await createFace(guest, { front: fileOf(face({ size: MAX_FACE_PHOTO_BYTES + 1 }), 'front') })
    expect(over.status).toBe(400)
    expect(await errorCodeOf(over)).toBe('IMAGE_TOO_LARGE')
    await nothingKept(guest)

    expect((await createFace(guest, { front: fileOf(face({ size: MAX_FACE_PHOTO_BYTES }), 'front') })).status).toBe(202)
  }, 30_000)

  it('needs a front photo: 400 VALIDATION_FAILED when only a side photo is sent, and when nothing is', async () => {
    const guest = await readyGuest()

    for (const fields of [{ right: fileOf(face(), 'right') }, { left: fileOf(face(), 'left') }, {}]) {
      const res = await createFace(guest, fields)

      expect(res.status).toBe(400)
      expect(await errorCodeOf(res)).toBe('VALIDATION_FAILED')
    }
    await nothingKept(guest)
  })

  it('refuses a JSON body with 415', async () => {
    const guest = await readyGuest()

    const res = await fetchWorker(FACES, { method: 'POST', body: JSON.stringify({ front: 'x' }), headers: { ...guest.headers(), 'Content-Type': 'application/json' } })

    expect(res.status).toBe(415)
    expect(await errorCodeOf(res)).toBe('HTTP_415')
  })

  it('answers 413 on a Content-Length one byte over 3 photos plus 1,000,000 of framing, without reading the body', async () => {
    const guest = await readyGuest()

    const res = await fetchWorker(FACES, { method: 'POST', body: new FormData(), headers: { ...guest.headers(), 'Content-Length': String(OVER_FACE_BODY_BYTES) } })

    expect(res.status).toBe(413)
    expect(await errorCodeOf(res)).toBe('HTTP_413')
  })

  it('turns an unsigned caller away with 401 before the size of the body matters', async () => {
    const res = await fetchWorker(FACES, { method: 'POST', body: new FormData(), headers: { 'cf-connecting-ip': freshIp(), 'Content-Length': String(OVER_FACE_BODY_BYTES) } })

    expect(res.status).toBe(401)
    expect(await errorCodeOf(res)).toBe('AUTH_REQUIRED')
  })
})

describe('POST /api/v1/scans/faces: an accepted scan', () => {
  it('answers 202 with the scan analysing: its goal, its time and a link for each photo sent, and a null result', async () => {
    const guest = await readyGuest('clear-skin')

    const res = await createFace(guest, { front: fileOf(face({}, 1), 'front'), left: fileOf(face({}, 3), 'left') })

    expect(res.status).toBe(202)
    const view = await dataOf<FaceScanView>(res)
    expect(Object.keys(view).sort()).toEqual(['createdAt', 'goal', 'id', 'photos', 'reason', 'rescanSuggested', 'result', 'state'])
    expect(view).toMatchObject({ state: 'analysing', reason: null, goal: 'clear-skin', rescanSuggested: false })
    expect(Date.parse(view.createdAt)).toBeGreaterThanOrEqual(STARTED - SECOND)
    expect(Object.keys(view.photos).sort()).toEqual(['front', 'left'])
    expect(view.photos.front.url).toMatch(new RegExp(`^${FACES}/photos/[A-Za-z0-9_-]+$`))
  })

  it('keeps the photos in the private bucket under faces/<environment>/<user>/<profile>/<scan>/, as the bytes that were sent', async () => {
    const guest = await readyGuest()
    const sent = { front: face({}, 1), right: face({}, 2), left: face({}, 3) }

    const view = await createdFace(guest, { front: fileOf(sent.front, 'front'), right: fileOf(sent.right, 'right'), left: fileOf(sent.left, 'left') })

    const prefix = `faces/${env.ENVIRONMENT}/${guest.userId}/${guest.profileId}/${view.id}`
    expect((await bucketKeysOf(guest.userId)).sort()).toEqual([`${prefix}/front.jpg`, `${prefix}/left.jpg`, `${prefix}/right.jpg`])
    for (const position of ['front', 'right', 'left'] as const) {
      const stored = await env.PRIVATE_PHOTOS.get(`${prefix}/${position}.jpg`)
      expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(sent[position].bytes)
      expect(stored!.httpMetadata?.contentType).toBe('image/jpeg')
    }
  })

  it('writes the scan and a photo row for each photo, and queues exactly one analyse-face-scan message for the upload step', async () => {
    const guest = await readyGuest()

    const view = await createdFace(guest, threeFiles())

    expect(await countOf('face_scans', guest.userId)).toBe(1)
    expect(await countOf('face_scan_photos', guest.userId)).toBe(3)
    expect(queued).toEqual([{ faceScanId: view.id, step: 'upload', at: expect.any(Number) }])
    const at = (queued[0] as { at: number }).at
    expect(at).toBeGreaterThanOrEqual(STARTED - SECOND)
    expect(at).toBeLessThanOrEqual(Date.now() + SECOND)
  })

  it('records nothing in the spend ledger: Perfect Corp is paid for when a result comes back, not when a scan is taken', async () => {
    const guest = await readyGuest()
    const before = await perfectCorpSpendRows()

    await createdFace(guest, threeFiles())

    expect(await perfectCorpSpendRows()).toBe(before)
  })

  it('answers 202 with the scan failed as unavailable, keeping it, when the job cannot be queued', async () => {
    const guest = await readyGuest()
    queueFails = true

    const res = await createFace(guest, threeFiles())

    expect(res.status).toBe(202)
    const view = await dataOf<FaceScanView>(res)
    expect(view).toMatchObject({ state: 'failed', reason: 'unavailable' })
    expect(await dataOf<FaceScanView>(await getFace(guest, view.id))).toMatchObject({ state: 'failed', reason: 'unavailable' })
    expect(await bucketKeysOf(guest.userId)).toHaveLength(3)
  })
})

describe('GET /api/v1/scans/faces/{id}', () => {
  it('shows the profile\'s own scan as it was made, with a link for each photo, and a null result', async () => {
    const guest = await readyGuest('fade-dark-marks')
    const made = await createdFace(guest, threeFiles())

    const res = await getFace(guest, made.id)

    expect(res.status).toBe(200)
    const view = await dataOf<FaceScanView>(res)
    expect(view).toMatchObject({ id: made.id, state: 'analysing', reason: null, goal: 'fade-dark-marks', createdAt: made.createdAt, rescanSuggested: false })
    expect(Object.keys(view).sort()).toEqual(['createdAt', 'goal', 'id', 'photos', 'reason', 'rescanSuggested', 'result', 'state'])
    expect(Object.keys(view.photos).sort()).toEqual(['front', 'left', 'right'])
    const text = JSON.stringify(view).toLowerCase()
    for (const word of ['skintype', 'skinage', 'score', 'concern', 'mask', 'fitzpatrick']) expect(text).not.toContain(word)
  })

  it('refuses a caller who is not signed in: 401 AUTH_REQUIRED', async () => {
    const res = await getFace(undefined, crypto.randomUUID())

    expect(res.status).toBe(401)
    expect(await errorCodeOf(res)).toBe('AUTH_REQUIRED')
  })

  it('is 404 FACE_SCAN_NOT_FOUND for a scan that does not exist', async () => {
    const guest = await newGuest()

    const res = await getFace(guest, crypto.randomUUID())

    expect(res.status).toBe(404)
    expect(await errorCodeOf(res)).toBe('FACE_SCAN_NOT_FOUND')
  })

  it('is 404 FACE_SCAN_NOT_FOUND for another account\'s scan, the same as for one that does not exist', async () => {
    const owner = await readyGuest()
    const made = await createdFace(owner)
    const stranger = await newGuest()

    const res = await getFace(stranger, made.id)

    expect(res.status).toBe(404)
    expect(await errorCodeOf(res)).toBe('FACE_SCAN_NOT_FOUND')
  })

  it('shows a scan only to the profile that made it: the account\'s other profile gets 404 FACE_SCAN_NOT_FOUND, and the maker still sees it', async () => {
    const first = await readyGuest()
    const second = await asSecondProfile(first)
    const made = await createdFace(first)

    const res = await getFace(second, made.id)

    expect(res.status).toBe(404)
    expect(await errorCodeOf(res)).toBe('FACE_SCAN_NOT_FOUND')
    expect((await getFace(first, made.id)).status).toBe(200)
  })

  it('suggests a rescan once the goal is not the one the latest scan was taken under, and stops when it is again', async () => {
    const guest = await readyGuest('glow')
    const made = await createdFace(guest)
    expect((await dataOf<FaceScanView>(await getFace(guest, made.id))).rescanSuggested).toBe(false)

    await setGoal(guest, 'brighter')
    const changed = await dataOf<FaceScanView>(await getFace(guest, made.id))
    expect(changed.rescanSuggested).toBe(true)
    expect(changed.goal).toBe('glow')

    await setGoal(guest, 'glow')
    expect((await dataOf<FaceScanView>(await getFace(guest, made.id))).rescanSuggested).toBe(false)
  })
})

describe('GET /api/v1/scans/faces/photos/{token}', () => {
  it('serves the photo a link from a scan opens: the JPEG that was sent, never cached, with no sign-in needed', async () => {
    const guest = await readyGuest()
    const sent = face({}, 7)
    const made = await createdFace(guest, { front: fileOf(sent, 'front') })

    const res = await openPhoto(tokenOf(made.photos.front.url))

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/jpeg')
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(sent.bytes)
  })

  it('ignores any Authorization header: the link is the credential, whoever holds it', async () => {
    const guest = await readyGuest()
    const made = await createdFace(guest)
    const stranger = await newGuest()

    const res = await openPhoto(tokenOf(made.photos.front.url), { Authorization: `Bearer ${stranger.token}` })
    const garbled = await openPhoto(tokenOf(made.photos.front.url), { Authorization: 'Bearer not-a-token' })

    expect(res.status).toBe(200)
    expect(garbled.status).toBe(200)
  })

  it.each([
    ['garbage', 'not-a-token'],
    ['a token cut short', 'eyJ'],
  ])('is 404 PHOTO_NOT_FOUND for %s', async (_label, token) => {
    const res = await openPhoto(token)

    expect(res.status).toBe(404)
    expect(await errorCodeOf(res)).toBe('PHOTO_NOT_FOUND')
  })

  it('is 404 PHOTO_NOT_FOUND for a link whose last character was changed', async () => {
    const guest = await readyGuest()
    const made = await createdFace(guest)
    const token = tokenOf(made.photos.front.url)
    const tampered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')

    const res = await openPhoto(tampered)

    expect(res.status).toBe(404)
    expect(await errorCodeOf(res)).toBe('PHOTO_NOT_FOUND')
  })

  it('is 404 PHOTO_NOT_FOUND once the scan is deleted', async () => {
    const guest = await readyGuest()
    const made = await createdFace(guest)
    const token = tokenOf(made.photos.front.url)
    expect((await openPhoto(token)).status).toBe(200)
    await deleteFace(guest, made.id)

    const res = await openPhoto(token)

    expect(res.status).toBe(404)
    expect(await errorCodeOf(res)).toBe('PHOTO_NOT_FOUND')
  })

  it('does not open from the product scan photo route, nor a product link from this one', async () => {
    const guest = await readyGuest()
    const made = await createdFace(guest)

    const asProduct = await fetchWorker(`/api/v1/scans/products/photos/${tokenOf(made.photos.front.url)}`)

    expect(asProduct.status).toBe(404)
    expect(await errorCodeOf(asProduct)).toBe('PHOTO_NOT_FOUND')
  })
})

describe('DELETE /api/v1/scans/faces/{id}', () => {
  it('deletes the photos and the rows with 204 and no body, and a later read is 404 FACE_SCAN_NOT_FOUND', async () => {
    const guest = await readyGuest()
    const made = await createdFace(guest, threeFiles())
    expect(await bucketKeysOf(guest.userId)).toHaveLength(3)

    const res = await deleteFace(guest, made.id)

    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
    await nothingKept(guest)
    const later = await getFace(guest, made.id)
    expect(later.status).toBe(404)
    expect(await errorCodeOf(later)).toBe('FACE_SCAN_NOT_FOUND')
  })

  it('leaves the profile\'s consent, and lets it scan again under the same goal', async () => {
    const guest = await readyGuest('glow')
    const made = await createdFace(guest)
    await deleteFace(guest, made.id)

    expect((await dataOf<ConsentView>(await getConsent(guest))).current).toBe(true)
    expect((await createFace(guest, { front: fileOf(face({}, 2), 'front') })).status).toBe(202)
  })

  it('is 404 FACE_SCAN_NOT_FOUND the second time', async () => {
    const guest = await readyGuest()
    const made = await createdFace(guest)
    expect((await deleteFace(guest, made.id)).status).toBe(204)

    const again = await deleteFace(guest, made.id)

    expect(again.status).toBe(404)
    expect(await errorCodeOf(again)).toBe('FACE_SCAN_NOT_FOUND')
  })

  it('refuses a caller who is not signed in: 401 AUTH_REQUIRED', async () => {
    const res = await deleteFace(undefined, crypto.randomUUID())

    expect(res.status).toBe(401)
    expect(await errorCodeOf(res)).toBe('AUTH_REQUIRED')
  })

  it('is 404 FACE_SCAN_NOT_FOUND for another account\'s scan and for the account\'s other profile\'s, and deletes nothing', async () => {
    const first = await readyGuest()
    const second = await asSecondProfile(first)
    const stranger = await newGuest()
    const made = await createdFace(first, threeFiles())

    for (const other of [second, stranger]) {
      const res = await deleteFace(other, made.id)

      expect(res.status).toBe(404)
      expect(await errorCodeOf(res)).toBe('FACE_SCAN_NOT_FOUND')
    }
    expect(await bucketKeysOf(first.userId)).toHaveLength(3)
    expect((await getFace(first, made.id)).status).toBe(200)
  })

  it('deletes only that scan\'s photos', async () => {
    const guest = await readyGuest('glow')
    const first = await createdFace(guest, threeFiles())
    await setGoal(guest, 'brighter')
    const second = await createdFace(guest, { front: fileOf(face({}, 5), 'front') })

    await deleteFace(guest, first.id)

    expect(await bucketKeysOf(guest.userId)).toEqual([`faces/${env.ENVIRONMENT}/${guest.userId}/${guest.profileId}/${second.id}/front.jpg`])
    expect((await getFace(guest, second.id)).status).toBe(200)
  })
})

describe('rate limits on POST /api/v1/scans/faces', () => {
  // A request with no consent is refused with 409 once it has passed the limiters, so a burst of them counts every request without storing a photo.
  it('answers 429 RATE_LIMITED with Retry-After to the 21st request from one address in a minute, whoever sends it, even before it is known who sent it', async () => {
    const { statuses, limited } = await inOneRateWindow(async () => {
      const shared = freshIp()
      const statuses: number[] = []
      let limited: Response | undefined
      for (let i = 0; i < 21; i++) {
        const res = await createFace(undefined, { front: fileOf(face(), 'front') }, shared)
        statuses.push(res.status)
        if (res.status === 429) limited = res
      }
      return { statuses, limited }
    }, { needMs: BURST_NEEDS_MS })

    // The first 20 are turned away by signedIn (401); the address limiter comes before it, so the 21st never gets that far.
    expect(statuses.slice(0, 20)).toEqual(Array(20).fill(401))
    expect(statuses[20]).toBe(429)
    expect(await errorCodeOf(limited!)).toBe('RATE_LIMITED')
    expect(Number(limited!.headers.get('Retry-After'))).toBeGreaterThan(0)
  }, RATE_TEST_TIMEOUT_MS)

  it('answers 429 RATE_LIMITED to the 11th request of one user in a minute, from any address', async () => {
    const { statuses, limited } = await inOneRateWindow(async () => {
      const guest = await newGuest()
      const statuses: number[] = []
      let limited: Response | undefined
      for (let i = 0; i < 11; i++) {
        const res = await createFace(guest, { front: fileOf(face(), 'front') }, freshIp())
        statuses.push(res.status)
        if (res.status === 429) limited = res
      }
      return { statuses, limited }
    }, { needMs: BURST_NEEDS_MS })

    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(409))
    expect(statuses[10]).toBe(429)
    expect(await errorCodeOf(limited!)).toBe('RATE_LIMITED')
    expect(Number(limited!.headers.get('Retry-After'))).toBeGreaterThan(0)
  }, RATE_TEST_TIMEOUT_MS)
})

describe('POST /api/v1/scans/faces: two at once', () => {
  // A double tap, or the app on two devices: both requests read "no scan under this goal yet" before either has written one.
  it('makes one scan, queues one job and keeps one set of photos; the other request is 429 FACE_SCAN_NOT_DUE', async () => {
    const guest = await readyGuest('glow')
    const files = (marker: number) => ({ front: fileOf(face({}, marker), 'front'), right: fileOf(face({}, marker + 1), 'right'), left: fileOf(face({}, marker + 2), 'left') })

    const replies = await Promise.all([createFace(guest, files(10), freshIp()), createFace(guest, files(20), freshIp())])

    expect(replies.map((reply) => reply.status).sort()).toEqual([202, 429])
    const refused = replies.find((reply) => reply.status === 429)!
    const error = await errorOf(refused)
    expect(error.code).toBe('FACE_SCAN_NOT_DUE')
    expect(error.details).toMatchObject({ reason: 'already-scanned-for-goal' })
    const accepted = await dataOf<FaceScanView>(replies.find((reply) => reply.status === 202)!)
    expect(await countOf('face_scans', guest.userId)).toBe(1)
    expect(await countOf('face_scan_photos', guest.userId)).toBe(3)
    const prefix = `faces/${env.ENVIRONMENT}/${guest.userId}/${guest.profileId}/${accepted.id}`
    expect((await bucketKeysOf(guest.userId)).sort()).toEqual([`${prefix}/front.jpg`, `${prefix}/left.jpg`, `${prefix}/right.jpg`])
    expect(queued).toEqual([{ faceScanId: accepted.id, step: 'upload', at: expect.any(Number) }])
  })
})

// --- PR 3: the analysis pipeline reaches the routes: retake, and the live stream ---

const MAIN = `deepertones-face-scans-${env.ENVIRONMENT}`
/** The front photo is replaced under the same key, so the key says where to look. */
const frontKeyOf = (guest: Guest, scanId: string) => `faces/${env.ENVIRONMENT}/${guest.userId}/${guest.profileId}/${scanId}/front.jpg`
const bytesOfStored = async (key: string) => new Uint8Array(await (await env.PRIVATE_PHOTOS.get(key))!.arrayBuffer())
const rowOf = (scanId: string) => env.DB.prepare('SELECT state, reason, pc_analysis_task_id AS task, skin_age AS skinAge FROM face_scans WHERE id = ?').bind(scanId).first<{ state: string; reason: string | null; task: string | null; skinAge: number | null }>()

/** Runs one message through the Worker's queue handler, as the queue would deliver it. */
const runFaceJob = async (body: unknown) => {
  const batch = createMessageBatch(MAIN, [{ id: 'm', timestamp: new Date(), attempts: 1, body }])
  const ctx = createExecutionContext()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  await worker.queue!(batch, WORKER_ENV, ctx)
  return getQueueResult(batch, ctx)
}
let lastAt = 0
const nextAt = () => (lastAt = Math.max(Date.now(), lastAt + 1))
const stepOf = (scanId: string, step: 'upload' | 'fetch') => ({ faceScanId: scanId, step, at: nextAt() })

/** A scan that was analysed up to the point of asking for a retake: made by the route, its upload step run, and its finished task refused for the photo. */
const needingRetake = async (guest: Guest, reason = 'error_no_face') => {
  const stub = stubPerfectCorp()
  const view = await createdFace(guest)
  expect((await runFaceJob(queued.at(-1))).explicitAcks).toEqual(['m'])
  stub.answerSkin((await rowOf(view.id))!.task!, () => taskError(reason))
  expect((await runFaceJob(stepOf(view.id, 'fetch'))).explicitAcks).toEqual(['m'])
  expect(await rowOf(view.id)).toMatchObject({ state: 'needs-retake' })
  queued.length = 0
  return { view, stub }
}

const retakeFace = (guest: Guest | undefined, id: string, fields: Record<string, File | undefined> = { front: fileOf(face({}, 9), 'front') }, from?: string) =>
  fetchWorker(`${FACES}/${id}/retake`, { method: 'POST', body: formOf(fields), headers: guest ? guest.headers(from) : { 'cf-connecting-ip': from ?? freshIp() } })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('GET /api/v1/scans/faces/{id}: where the analysis has got to', () => {
  it('shows a scan that needs a retake with the reason, and the same fields as before', async () => {
    const guest = await readyGuest()
    const { view } = await needingRetake(guest, 'error_lighting_dark')

    const shown = await dataOf<FaceScanView>(await getFace(guest, view.id))

    expect(shown).toMatchObject({ id: view.id, state: 'needs-retake', reason: 'too-dark', result: null })
    expect(Object.keys(shown).sort()).toEqual(['createdAt', 'goal', 'id', 'photos', 'reason', 'rescanSuggested', 'result', 'state'])
  })

  it('shows a scan that is ready with a result: what can be seen, the skin type and skin age, and no change since day one for the first scan', async () => {
    const guest = await readyGuest()
    const stub = stubPerfectCorp()
    const view = await createdFace(guest)
    await runFaceJob(queued.at(-1))
    stub.answerSkin((await rowOf(view.id))!.task!, () => skinSuccess(glowOutput()))
    await runFaceJob(stepOf(view.id, 'fetch'))

    const shown = await dataOf<FaceScanView>(await getFace(guest, view.id))

    expect(shown).toMatchObject({ id: view.id, state: 'ready', reason: null })
    expect(Object.keys(shown).sort()).toEqual(['createdAt', 'goal', 'id', 'photos', 'reason', 'rescanSuggested', 'result', 'state'])
    // glowOutput(): radiance 41.5 is "clear", moisture 62 and texture 55 are faint (above their cut-offs, still shown); a mask for radiance and moisture, none for texture.
    expect(shown.result).toEqual({
      seen: [
        { concern: 'glow', region: 'whole', level: 'clear', words: 'Less glow across most of the face', overlay: { url: expect.stringMatching(new RegExp(`^${FACES}/photos/[A-Za-z0-9_-]+$`)) } },
        { concern: 'dryness', region: 'whole', level: 'faint', words: 'Hardly any dry patches', overlay: { url: expect.stringMatching(new RegExp(`^${FACES}/photos/[A-Za-z0-9_-]+$`)) } },
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

  it('shows the visible core extras as also noticed, in core order with a working overlay link each, and leaves out a faint one', async () => {
    const guest = await readyGuest('glow')
    const stub = stubPerfectCorp()
    const view = await createdFace(guest)
    await runFaceJob(queued.at(-1))
    // The upload asked for everything measured for glow: its own three, the four core concerns it lacks, and the skin type.
    const asked = (stub.callsTo('POST', '/s2s/v2.0/task/skin-analysis')[0]!.body as { dst_actions: string[] }).dst_actions
    expect(asked).toEqual(['hd_radiance', 'hd_moisture', 'hd_texture', 'hd_age_spot', 'hd_acne', 'hd_pore', 'hd_oiliness', 'hd_skin_type'])
    // age_spot 84 (a little), acne 58 (some), pore 70 (faint), oiliness 70 (some).
    const extra = (type: string, score: number) => ({ type, region: 'whole', raw_score: score, ui_score: score + 10, mask_urls: [maskUrl(type.replace('hd_', ''))] })
    stub.answerSkin((await rowOf(view.id))!.task!, () => skinSuccess([...glowOutput(), extra('hd_age_spot', 84), extra('hd_acne', 58), extra('hd_pore', 70), extra('hd_oiliness', 70)]))
    await runFaceJob(stepOf(view.id, 'fetch'))

    const { result } = await dataOf<FaceScanView>(await getFace(guest, view.id))

    expect(result!.alsoNoticed).toEqual([
      { concern: 'marks', region: 'whole', level: 'a-little', words: 'A few faint dark marks', overlay: { url: expect.stringMatching(new RegExp(`^${FACES}/photos/[A-Za-z0-9_-]+$`)) } },
      { concern: 'spots', region: 'whole', level: 'some', words: 'Some spots and breakouts across the face', overlay: { url: expect.stringMatching(new RegExp(`^${FACES}/photos/[A-Za-z0-9_-]+$`)) } },
      { concern: 'shine', region: 'whole', level: 'some', words: 'Some shine across the face', overlay: { url: expect.stringMatching(new RegExp(`^${FACES}/photos/[A-Za-z0-9_-]+$`)) } },
    ])
    expect(result!.seen.map((item) => item.concern)).toEqual(['glow', 'dryness', 'texture'])
    const opened = await openPhoto(tokenOf(result!.alsoNoticed[0]!.overlay!.url))
    expect(opened.status).toBe(200)
    expect(opened.headers.get('content-type')).toBe('image/png')
  })

  it('opens an overlay link to the mask PNG that was stored for the concern', async () => {
    const guest = await readyGuest()
    const stub = stubPerfectCorp()
    const view = await createdFace(guest)
    await runFaceJob(queued.at(-1))
    stub.answerSkin((await rowOf(view.id))!.task!, () => skinSuccess(glowOutput()))
    await runFaceJob(stepOf(view.id, 'fetch'))
    const shown = await dataOf<FaceScanView>(await getFace(guest, view.id))

    const res = await openPhoto(tokenOf(shown.result!.seen[0]!.overlay!.url))

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    // The stub's mask download: the 8-byte PNG signature and three more bytes.
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]))
  })
})

// A second scan under the same goal is not due until the goal has changed, so a profile gets there as a person does: scan under glow, change the goal and
// scan again (that scan is not finished here, so it neither counts nor cuts), change the goal back and scan under glow once more.
describe('GET /api/v1/scans/faces/{id}: the change since day one', () => {
  const glowAnalysis = ({ radiance, moisture, texture, skinAge, extras = [] }: { radiance: number; moisture: number; texture: number; skinAge: number; extras?: unknown[] }) => [
    { type: 'hd_radiance', region: 'whole', raw_score: radiance, ui_score: radiance + 10, mask_urls: [maskUrl('radiance')] },
    { type: 'hd_moisture', region: 'whole', raw_score: moisture, ui_score: moisture + 10, mask_urls: [maskUrl('moisture')] },
    { type: 'hd_texture', region: 'whole', raw_score: texture, ui_score: texture + 10, mask_urls: [] },
    { type: 'hd_skin_type', region: 'whole', skin_type: 'Dry' },
    { type: 'skin_age', score: skinAge },
    { type: 'all', score: 66 },
    ...extras,
  ]
  const messageFor = (scanId: string) => queued.find((body) => (body as { faceScanId: string }).faceScanId === scanId)
  /** Scans under `glow`, one after the other, with a scan under another goal still analysing between. Resolves to the first, the one between and the second. */
  const twoGlowScans = async (guest: Guest, stub: ReturnType<typeof stubPerfectCorp>, first: ReturnType<typeof glowAnalysis>, second: ReturnType<typeof glowAnalysis>) => {
    const day = await createdFace(guest)
    await runFaceJob(messageFor(day.id))
    stub.answerSkin((await rowOf(day.id))!.task!, () => skinSuccess(first))
    await runFaceJob(stepOf(day.id, 'fetch'))
    await setGoal(guest, 'brighter')
    const between = await createdFace(guest)
    await setGoal(guest, 'glow')
    const later = await createdFace(guest)
    await runFaceJob(messageFor(later.id))
    stub.answerSkin((await rowOf(later.id))!.task!, () => skinSuccess(second))
    await runFaceJob(stepOf(later.id, 'fetch'))
    return { day, between, later }
  }

  it('compares the second ready scan under a goal with the first: which scan, when, how each concern moved, and the skin age', async () => {
    const guest = await readyGuest('glow')
    const stub = stubPerfectCorp()

    const { day, between, later } = await twoGlowScans(
      guest,
      stub,
      glowAnalysis({ radiance: 41.5, moisture: 62, texture: 55, skinAge: 31 }),
      glowAnalysis({ radiance: 50, moisture: 55, texture: 57, skinAge: 34 }),
    )

    const first = await dataOf<FaceScanView>(await getFace(guest, day.id))
    const second = await dataOf<FaceScanView>(await getFace(guest, later.id))
    expect(first.result!.sinceDayOne).toBeNull()
    expect(second.state).toBe('ready')
    expect(second.result!.sinceDayOne).toEqual({
      dayOneScanId: day.id,
      dayOneAt: day.createdAt,
      concerns: [
        { concern: 'glow', change: 'fainter', words: 'More glow than on day one' },
        { concern: 'dryness', change: 'more-visible', words: 'Skin looks drier than on day one' },
        { concern: 'texture', change: 'no-clear-change', words: 'No clear change in smoothness since day one' },
      ],
      skinAge: { change: 'older', words: 'Your skin looks about 3 years older than on day one' },
    })
    expect(second.result!.seen.map((seen) => seen.concern)).toEqual(['glow', 'dryness', 'texture'])
    expect((await dataOf<FaceScanView>(await getFace(guest, between.id))).result).toBeNull()
  })

  it('holds no Perfect Corp name, no score, no overall score and no Fitzpatrick type in the body, and no number but the skin age in years', async () => {
    const guest = await readyGuest('glow')
    const stub = stubPerfectCorp()
    const first = await createdFace(guest)
    await runFaceJob(messageFor(first.id))
    const row = await env.DB.prepare('SELECT pc_fitzpatrick_task_id AS fitz FROM face_scans WHERE id = ?').bind(first.id).first<{ fitz: string }>()
    stub.answerFitzpatrick(row!.fitz, () => fitzpatrickSuccess('V'))
    await runFaceJob({ faceScanId: first.id, step: 'fitzpatrick', at: nextAt() })
    expect(await env.DB.prepare('SELECT fitzpatrick FROM profile_fitzpatrick WHERE profile_id = ?').bind(guest.profileId).first()).toEqual({ fitzpatrick: 'V' })
    stub.answerSkin((await rowOf(first.id))!.task!, () => skinSuccess(glowAnalysis({ radiance: 41.5, moisture: 62, texture: 55, skinAge: 31 })))
    await runFaceJob(stepOf(first.id, 'fetch'))
    await setGoal(guest, 'brighter')
    await createdFace(guest)
    await setGoal(guest, 'glow')
    const later = await createdFace(guest)
    await runFaceJob(messageFor(later.id))
    // The core extras: age spot, acne and oiliness are visible and listed in alsoNoticed, which the never-rules below cover too.
    const extra = (type: string, score: number) => ({ type, region: 'whole', raw_score: score, ui_score: score + 10, mask_urls: [maskUrl(type.replace('hd_', ''))] })
    const extras = [extra('hd_age_spot', 80), extra('hd_acne', 50), extra('hd_oiliness', 70)]
    stub.answerSkin((await rowOf(later.id))!.task!, () => skinSuccess(glowAnalysis({ radiance: 50, moisture: 55, texture: 57, skinAge: 34, extras })))
    await runFaceJob(stepOf(later.id, 'fetch'))

    const res = await getFace(guest, later.id)
    // The link tokens are random base64url text, which could hold "hd_" by chance; they are not what is being looked at.
    const body = (await res.text()).replace(/\/photos\/[A-Za-z0-9_-]+/g, '/photos/<token>')

    const { result } = (JSON.parse(body) as { data: FaceScanView }).data
    expect(result!.sinceDayOne).not.toBeNull()
    expect(result!.alsoNoticed.map((item) => item.concern)).toEqual(['marks', 'spots', 'shine'])
    expect(body).not.toMatch(/hd_|raw_?score|ui_?score|fitzpatrick/i)
    expect(body).not.toMatch(/"all"/)
    expect(body).not.toMatch(/"(?:I|II|III|IV|V|VI)"/)
    expect(body).not.toMatch(/you have|diagnos|melasma|rosacea|acne|eczema/i)
    const numbers = (value: unknown, path = ''): string[] =>
      typeof value === 'number' ? [path] : value !== null && typeof value === 'object' ? Object.entries(value).flatMap(([key, inner]) => numbers(inner, `${path}.${key}`)) : []
    expect(numbers(result)).toEqual(['.skinAge.years'])
    for (const text of [...result!.seen.map((seen) => seen.words), ...result!.alsoNoticed.map((noticed) => noticed.words), ...result!.sinceDayOne!.concerns.map((concern) => concern.words)]) expect(text).not.toMatch(/\d/)
  })
})

describe('POST /api/v1/scans/faces/{id}/retake', () => {
  it('answers 202 with the scan analysing again, no reason, and a link to the new front photo', async () => {
    const guest = await readyGuest()
    const { view } = await needingRetake(guest)

    const res = await retakeFace(guest, view.id, { front: fileOf(face({}, 9), 'front') })

    expect(res.status).toBe(202)
    const retaken = await dataOf<FaceScanView>(res)
    expect(retaken).toMatchObject({ id: view.id, state: 'analysing', reason: null, goal: 'glow', result: null })
    const link = await openPhoto(tokenOf(retaken.photos.front.url))
    expect(link.status).toBe(200)
    expect(new Uint8Array(await link.arrayBuffer())).toEqual(face({}, 9).bytes)
  })

  it('replaces the front photo under the same key, clears the reason and the old analysis task in the database, and stores no second photo', async () => {
    const guest = await readyGuest()
    const { view } = await needingRetake(guest)
    expect(new Uint8Array(await bytesOfStored(frontKeyOf(guest, view.id)))).toEqual(face({}, 1).bytes)

    await retakeFace(guest, view.id, { front: fileOf(face({}, 9), 'front') })

    expect(await bytesOfStored(frontKeyOf(guest, view.id))).toEqual(face({}, 9).bytes)
    expect(await bucketKeysOf(guest.userId)).toEqual([frontKeyOf(guest, view.id)])
    expect(await rowOf(view.id)).toEqual({ state: 'analysing', reason: null, task: null, skinAge: null })
    expect(await countOf('face_scan_photos', guest.userId)).toBe(1)
  })

  it('queues the upload step for the scan, and nothing else', async () => {
    const guest = await readyGuest()
    const { view } = await needingRetake(guest)

    await retakeFace(guest, view.id)

    expect(queued).toEqual([{ faceScanId: view.id, step: 'upload', at: expect.any(Number) }])
  })

  it('leads to a fresh analysis: the queued upload step sends the new photo and starts a new task', async () => {
    const guest = await readyGuest()
    const { view, stub } = await needingRetake(guest)
    const oldTask = (await rowOf(view.id))!.task
    await retakeFace(guest, view.id, { front: fileOf(face({}, 9), 'front') })
    const [uploadStep] = queued.splice(0)

    expect((await runFaceJob(uploadStep)).explicitAcks).toEqual(['m'])

    const row = (await rowOf(view.id))!
    expect(row.state).toBe('analysing')
    expect(row.task).toMatch(/^skin-/)
    expect(row.task).not.toBe(oldTask)
    const puts = stub.calls.filter((call) => call.method === 'PUT')
    expect(new Uint8Array(puts.at(-1)!.body as ArrayBuffer | Uint8Array)).toEqual(face({}, 9).bytes)
  })

  it('may be done again after another refusal: there is no limit on retakes', async () => {
    const guest = await readyGuest()
    const { view, stub } = await needingRetake(guest)
    for (const marker of [2, 3]) {
      expect((await retakeFace(guest, view.id, { front: fileOf(face({}, marker), 'front') })).status).toBe(202)
      expect((await runFaceJob(queued.splice(0)[0])).explicitAcks).toEqual(['m'])
      stub.answerSkin((await rowOf(view.id))!.task!, () => taskError('error_pose'))
      await runFaceJob(stepOf(view.id, 'fetch'))
      expect(await rowOf(view.id)).toMatchObject({ state: 'needs-retake', reason: 'turn-to-camera' })
    }
  })

  it('refuses a caller who is not signed in: 401 AUTH_REQUIRED', async () => {
    const res = await retakeFace(undefined, crypto.randomUUID())

    expect(res.status).toBe(401)
    expect(await errorCodeOf(res)).toBe('AUTH_REQUIRED')
  })

  it('is 404 FACE_SCAN_NOT_FOUND for a scan that does not exist and for another profile\'s scan, and changes nothing', async () => {
    const guest = await readyGuest()
    const { view } = await needingRetake(guest)
    const second = await asSecondProfile(guest)
    expect((await putConsent(second)).status).toBe(200)

    const unknown = await retakeFace(guest, crypto.randomUUID())
    const foreign = await retakeFace(second, view.id)

    for (const res of [unknown, foreign]) {
      expect(res.status).toBe(404)
      expect(await errorCodeOf(res)).toBe('FACE_SCAN_NOT_FOUND')
    }
    expect(await rowOf(view.id)).toMatchObject({ state: 'needs-retake' })
    expect(queued).toEqual([])
  })

  it('is 409 FACE_SCAN_NOT_AWAITING_RETAKE for a scan that is analysing, and leaves its photo and queue alone', async () => {
    const guest = await readyGuest()
    const view = await createdFace(guest)
    queued.length = 0

    const res = await retakeFace(guest, view.id)

    expect(res.status).toBe(409)
    expect(await errorCodeOf(res)).toBe('FACE_SCAN_NOT_AWAITING_RETAKE')
    expect(await bytesOfStored(frontKeyOf(guest, view.id))).toEqual(face({}, 1).bytes)
    expect(queued).toEqual([])
  })

  it('is 409 FACE_SCAN_NOT_AWAITING_RETAKE for a scan that is ready', async () => {
    const guest = await readyGuest()
    const stub = stubPerfectCorp()
    const view = await createdFace(guest)
    await runFaceJob(queued.splice(0)[0])
    stub.answerSkin((await rowOf(view.id))!.task!, () => skinSuccess(glowOutput()))
    await runFaceJob(stepOf(view.id, 'fetch'))

    const res = await retakeFace(guest, view.id)

    expect(res.status).toBe(409)
    expect(await errorCodeOf(res)).toBe('FACE_SCAN_NOT_AWAITING_RETAKE')
    expect(await rowOf(view.id)).toMatchObject({ state: 'ready' })
  })

  it('is 409 FACE_CONSENT_REQUIRED when the consent was withdrawn, and keeps the old photo', async () => {
    const guest = await readyGuest()
    const { view } = await needingRetake(guest)
    expect((await deleteConsent(guest)).status).toBe(204)

    const res = await retakeFace(guest, view.id)

    expect(res.status).toBe(409)
    expect(await errorCodeOf(res)).toBe('FACE_CONSENT_REQUIRED')
    expect(await bytesOfStored(frontKeyOf(guest, view.id))).toEqual(face({}, 1).bytes)
    expect(await rowOf(view.id)).toMatchObject({ state: 'needs-retake' })
  })

  it.each([
    { label: 'a PNG', file: () => fileOf(pngPhoto({ width: 1080, height: 1440 }), 'front', 'image/png'), code: 'UNSUPPORTED_IMAGE' },
    { label: 'bytes that are no image', file: () => fileOf(garbagePhoto(), 'front', 'image/jpeg'), code: 'UNSUPPORTED_IMAGE' },
    { label: 'a WebP', file: () => fileOf(webpPhoto({ width: 1080, height: 1440 }), 'front', 'image/webp'), code: 'UNSUPPORTED_IMAGE' },
    { label: 'a JPEG whose shorter side is one pixel under 1080', file: () => fileOf(face({ width: 1079, height: 1440 }), 'front'), code: 'IMAGE_TOO_SMALL' },
  ])('is 400 for $label, and keeps the old photo and the scan waiting for a retake', async ({ file, code }) => {
    const guest = await readyGuest()
    const { view } = await needingRetake(guest)

    const res = await retakeFace(guest, view.id, { front: file() })

    expect(res.status).toBe(400)
    expect(await errorCodeOf(res)).toBe(code)
    expect(await bytesOfStored(frontKeyOf(guest, view.id))).toEqual(face({}, 1).bytes)
    expect(await rowOf(view.id)).toMatchObject({ state: 'needs-retake' })
    expect(queued).toEqual([])
  })

  it('is 400 VALIDATION_FAILED without a front part', async () => {
    const guest = await readyGuest()
    const { view } = await needingRetake(guest)

    const res = await retakeFace(guest, view.id, {})

    expect(res.status).toBe(400)
    expect(await errorCodeOf(res)).toBe('VALIDATION_FAILED')
  })

  it('answers 413 on a Content-Length one byte over a photo plus 1,000,000 of framing', async () => {
    const guest = await readyGuest()
    const { view } = await needingRetake(guest)

    const res = await fetchWorker(`${FACES}/${view.id}/retake`, { method: 'POST', body: new FormData(), headers: { ...guest.headers(), 'Content-Length': String(MAX_FACE_PHOTO_BYTES + 1_000_000 + 1) } })

    expect(res.status).toBe(413)
    expect(await errorCodeOf(res)).toBe('HTTP_413')
  })

  it('answers 202 with the scan failed as unavailable, still, when the analysis cannot be queued', async () => {
    const guest = await readyGuest()
    const { view } = await needingRetake(guest)
    queueFails = true

    const res = await retakeFace(guest, view.id)

    expect(res.status).toBe(202)
    expect(await dataOf<FaceScanView>(res)).toMatchObject({ id: view.id, state: 'failed', reason: 'unavailable' })
    expect(await rowOf(view.id)).toMatchObject({ state: 'failed', reason: 'unavailable' })
  })
})

describe('GET /api/v1/scans/faces/{id}/events', () => {
  const opened: SseReader[] = []
  afterEach(async () => {
    await Promise.all(opened.splice(0).map((stream) => stream.cancel()))
    await abortAllDurableObjects()
  })
  const eventsOf = (guest: Guest | undefined, id: string) => json(guest, 'GET', `${FACES}/${id}/events`)
  const watch = async (guest: Guest, id: string) => {
    const res = await eventsOf(guest, id)
    expect(res.status).toBe(200)
    const stream = sseReader(res)
    opened.push(stream)
    return { res, stream }
  }

  it('refuses a caller who is not signed in: 401 AUTH_REQUIRED', async () => {
    const res = await eventsOf(undefined, crypto.randomUUID())

    expect(res.status).toBe(401)
    expect(await errorCodeOf(res)).toBe('AUTH_REQUIRED')
  })

  it('is 404 FACE_SCAN_NOT_FOUND for a scan that does not exist and for another profile\'s scan', async () => {
    const guest = await readyGuest()
    const view = await createdFace(guest)
    const second = await asSecondProfile(guest)

    for (const res of [await eventsOf(guest, crypto.randomUUID()), await eventsOf(second, view.id)]) {
      expect(res.status).toBe(404)
      expect(await errorCodeOf(res)).toBe('FACE_SCAN_NOT_FOUND')
    }
  })

  it('answers 200 as an event stream that no proxy buffers or rewrites, starting with a snapshot of the scan as it is: its id, state and reason', async () => {
    const guest = await readyGuest()
    const view = await createdFace(guest)

    const { res, stream } = await watch(guest, view.id)

    expect(res.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8')
    expect(res.headers.get('Cache-Control')).toBe('no-cache, no-transform')
    expect(res.headers.get('X-Accel-Buffering')).toBe('no')
    const first = parseFrame((await stream.read(1)).frames[0]!)
    expect(first.event).toBe('snapshot')
    expect(first.data).toMatchObject({ id: view.id, state: 'analysing', reason: null })
  })

  it('keeps an analysing scan\'s stream open: nothing but the snapshot comes, and it does not end', async () => {
    const guest = await readyGuest()
    const view = await createdFace(guest)
    const { stream } = await watch(guest, view.id)
    await stream.read(1)

    const quiet = await stream.read(1, 300)

    expect(quiet.frames).toEqual([])
    expect(quiet.ended).toBe(false)
  })

  it('tells a client that is watching when the scan is ready, with a face frame and then done, and ends the stream', async () => {
    const guest = await readyGuest()
    const stub = stubPerfectCorp()
    const view = await createdFace(guest)
    await runFaceJob(queued.splice(0)[0])
    stub.answerSkin((await rowOf(view.id))!.task!, () => skinSuccess(glowOutput()))
    const { stream } = await watch(guest, view.id)
    expect(parseFrame((await stream.read(1)).frames[0]!).event).toBe('snapshot')

    await runFaceJob(stepOf(view.id, 'fetch'))

    const { frames, ended } = await stream.read(2)
    const [face, done] = frames.map(parseFrame)
    expect(face).toMatchObject({ event: 'face', data: { id: view.id, state: 'ready', reason: null } })
    expect(done!.event).toBe('done')
    expect((await stream.read(1)).ended || ended).toBe(true)
  })

  it('tells a client that is watching when the scan needs a retake, with the reason', async () => {
    const guest = await readyGuest()
    const stub = stubPerfectCorp()
    const view = await createdFace(guest)
    await runFaceJob(queued.splice(0)[0])
    stub.answerSkin((await rowOf(view.id))!.task!, () => taskError('error_src_face_too_small'))
    const { stream } = await watch(guest, view.id)
    await stream.read(1)

    await runFaceJob(stepOf(view.id, 'fetch'))

    const frames = (await stream.read(2)).frames.map(parseFrame)
    expect(frames[0]).toMatchObject({ event: 'face', data: { id: view.id, state: 'needs-retake', reason: 'move-closer' } })
    expect(frames[1]!.event).toBe('done')
  })

  it('says done straight after the snapshot for a scan that has already ended, and then closes', async () => {
    const guest = await readyGuest()
    queueFails = true
    const failed = await createdFace(guest)
    queueFails = false
    expect(failed).toMatchObject({ state: 'failed', reason: 'unavailable' })

    const { stream } = await watch(guest, failed.id)

    const { frames, ended } = await stream.read(3)
    const parsed = frames.map(parseFrame)
    expect(parsed[0]).toMatchObject({ event: 'snapshot', data: { id: failed.id, state: 'failed', reason: 'unavailable' } })
    expect(parsed[1]!.event).toBe('done')
    expect(frames).toHaveLength(2)
    expect(ended).toBe(true)
  })
})

// --- the profile's list of face scans ---

const listFaces = (guest: Guest | undefined) => json(guest, 'GET', FACES)
type FaceScanList = { faceScans: FaceScanView[] }
/** Each read signs its own links, good for 5 minutes from that read, so two reads a millisecond apart differ in the token and in nothing else. */
const withoutTokens = (value: unknown) => JSON.parse(JSON.stringify(value).replace(/\/photos\/[A-Za-z0-9_-]+/g, '/photos/<token>')) as unknown
/** Two scans made a moment apart get different times, so which is latest never rests on a tie. */
const aMomentLater = () => new Promise((resolve) => setTimeout(resolve, 5))

describe('GET /api/v1/scans/faces', () => {
  it('refuses a caller who is not signed in: 401 AUTH_REQUIRED', async () => {
    const res = await listFaces(undefined)

    expect(res.status).toBe(401)
    expect(await errorCodeOf(res)).toBe('AUTH_REQUIRED')
  })

  it('answers 200 with an empty list, not 404, for a profile that has no scans, no consent and no goal', async () => {
    const guest = await newGuest()

    const res = await listFaces(guest)

    expect(res.status).toBe(200)
    expect(await dataOf<FaceScanList>(res)).toEqual({ faceScans: [] })
  })

  it('lists two scans newest first, each as GET /scans/faces/{id} shows it', async () => {
    const guest = await readyGuest('glow')
    const older = await createdFace(guest, threeFiles())
    await setGoal(guest, 'brighter')
    await aMomentLater()
    const newer = await createdFace(guest, { front: fileOf(face({}, 2), 'front') })

    const res = await listFaces(guest)

    expect(res.status).toBe(200)
    const { faceScans } = await dataOf<FaceScanList>(res)
    expect(faceScans.map((scan) => scan.id)).toEqual([newer.id, older.id])
    expect(faceScans.map((scan) => scan.goal)).toEqual(['brighter', 'glow'])
    expect(Object.keys(faceScans[0]!).sort()).toEqual(['createdAt', 'goal', 'id', 'photos', 'reason', 'rescanSuggested', 'result', 'state'])
    expect(Object.keys(faceScans[1]!.photos).sort()).toEqual(['front', 'left', 'right'])
    for (const scan of faceScans) expect(withoutTokens(scan)).toEqual(withoutTokens(await dataOf<FaceScanView>(await getFace(guest, scan.id))))
  })

  it('shows a ready scan with its result and an analysing one with a null result', async () => {
    const guest = await readyGuest('glow')
    const stub = stubPerfectCorp()
    const ready = await createdFace(guest)
    await runFaceJob(queued.at(-1))
    stub.answerSkin((await rowOf(ready.id))!.task!, () => skinSuccess(glowOutput()))
    await runFaceJob(stepOf(ready.id, 'fetch'))
    await setGoal(guest, 'brighter')
    await aMomentLater()
    const analysing = await createdFace(guest)

    const { faceScans } = await dataOf<FaceScanList>(await listFaces(guest))

    expect(faceScans.map((scan) => [scan.id, scan.state])).toEqual([[analysing.id, 'analysing'], [ready.id, 'ready']])
    expect(faceScans[0]!.result).toBeNull()
    expect(faceScans[1]!.result).toMatchObject({ skinType: 'dry', skinAge: { years: 31, words: 'Your skin looks about 31' }, sinceDayOne: null, tablesVersion: TABLES_VERSION })
    expect(faceScans[1]!.result!.seen.map((seen) => seen.concern)).toEqual(['glow', 'dryness', 'texture'])
  })

  it('shows a scan that needs a retake and one that failed, with their reasons', async () => {
    const guest = await readyGuest('glow')
    const { view: needsRetake } = await needingRetake(guest, 'error_lighting_dark')
    await setGoal(guest, 'brighter')
    queueFails = true
    await aMomentLater()
    const failed = await createdFace(guest)
    queueFails = false

    const { faceScans } = await dataOf<FaceScanList>(await listFaces(guest))

    expect(faceScans.map((scan) => [scan.id, scan.state, scan.reason])).toEqual([
      [failed.id, 'failed', 'unavailable'],
      [needsRetake.id, 'needs-retake', 'too-dark'],
    ])
  })

  it('lists only the caller\'s profile: not the account\'s other profile\'s scan, nor another account\'s', async () => {
    const owner = await readyGuest('glow')
    const mine = await createdFace(owner)
    const sister = await asSecondProfile(owner)
    expect((await putConsent(sister)).status).toBe(200)
    await setGoal(sister, 'glow')
    const sisters = await createdFace(sister)
    const stranger = await readyGuest('glow')
    const strangers = await createdFace(stranger)
    const nobody = await newGuest()

    expect((await dataOf<FaceScanList>(await listFaces(owner))).faceScans.map((scan) => scan.id)).toEqual([mine.id])
    expect((await dataOf<FaceScanList>(await listFaces(sister))).faceScans.map((scan) => scan.id)).toEqual([sisters.id])
    expect((await dataOf<FaceScanList>(await listFaces(stranger))).faceScans.map((scan) => scan.id)).toEqual([strangers.id])
    expect((await dataOf<FaceScanList>(await listFaces(nobody))).faceScans).toEqual([])
  })

  it('still lists the scans after the consent is withdrawn, so the user can find them and delete them', async () => {
    const guest = await readyGuest('glow')
    const made = await createdFace(guest)
    expect((await deleteConsent(guest)).status).toBe(204)

    const res = await listFaces(guest)

    expect(res.status).toBe(200)
    expect((await dataOf<FaceScanList>(res)).faceScans.map((scan) => scan.id)).toEqual([made.id])
    expect((await deleteFace(guest, made.id)).status).toBe(204)
    expect((await dataOf<FaceScanList>(await listFaces(guest))).faceScans).toEqual([])
  })

  it('leaves GET /scans/faces/{id} and GET /scans/faces/photos/{token} as they were: an id from the list opens that scan, and a photo link from the list opens its photo', async () => {
    const guest = await readyGuest('glow')
    const made = await createdFace(guest, threeFiles())
    const { faceScans } = await dataOf<FaceScanList>(await listFaces(guest))

    const byId = await getFace(guest, faceScans[0]!.id)
    const photo = await openPhoto(tokenOf(faceScans[0]!.photos.front.url))
    const notAToken = await openPhoto('not-a-token')

    expect(byId.status).toBe(200)
    expect((await dataOf<FaceScanView>(byId)).id).toBe(made.id)
    expect(photo.status).toBe(200)
    expect(photo.headers.get('content-type')).toBe('image/jpeg')
    expect(new Uint8Array(await photo.arrayBuffer())).toEqual(new Uint8Array(face({}, 1).bytes))
    expect(notAToken.status).toBe(404)
    expect(await errorCodeOf(notAToken)).toBe('PHOTO_NOT_FOUND')
  })
})
