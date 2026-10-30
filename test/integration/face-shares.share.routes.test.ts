import { createExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { buildContainer } from '../../src/container'
import worker from '../../src/index'
import { type Actor, runAs } from '../../src/lib/context'
import { createDb } from '../../src/lib/db'
import type { EmailAddress } from '../../src/lib/email-address'
import { TokenService } from '../../src/modules/auth/tokens.service'
import { D1FaceScansRepository } from '../../src/modules/face-scans/face-scans.repository'
import { D1FaceSharesRepository } from '../../src/modules/face-shares/face-shares.repository'
import { D1ProfilesRepository } from '../../src/modules/profiles/profiles.repository'
import { ProfilesService } from '../../src/modules/profiles/profiles.service'
import { jpegPhoto } from '../../src/modules/scans/scans.photos.fake'
import { D1UsersRepository } from '../../src/modules/users/users.repository'
import { UsersService } from '../../src/modules/users/users.service'

// POST /api/v1/me/face-timeline/share (spec #259, C2) through the Worker's real entrypoint with real local D1 and real local buckets: the before-and-after card of the
// person's day-one face photo and a later one, answered as an image and never kept. The Cloudflare Images binding is not available locally, so the Worker is handed a
// stand-in for it through its env, the way the other route tests hand it recording queues: the project's real renderer runs over it, and it answers fixed bytes. What the
// card looks like is the layout test's job (and the staging check's); what is refused, and in what order, is the service test's. This file proves the wiring: that the
// route is there, signed-in only, reads the person's real scans and photos, and answers the bytes as a PNG with `Cache-Control: no-store`, recording one share.
//
// THE CONTRACT THIS FILE PINS (the brief gives the route, the codes and the headers; that the stand-in is an `IMAGES` binding in the env is the assumption):
//   POST /api/v1/me/face-timeline/share { afterScanId }
//     401 AUTH_REQUIRED with no session (before the body is read), 403 SIGNUP_REQUIRED for a guest, 409 SHARE_CONSENT_REQUIRED without a current face share consent,
//     404 FACE_SCAN_NOT_FOUND for a scan that is not an eligible later scan of the day-one chase,
//     200 with the card's bytes, `Content-Type: image/png` and `Cache-Control: no-store`; one face_shares row is recorded; nothing is added to either bucket.
//   The logo is the public object email/logo.png in the CATALOG_IMAGES bucket; the photos are read from PRIVATE_PHOTOS.
//   The stand-in accepts any chain of input/transform/draw/text calls and answers on output(): it does not check how the card is drawn.

const SHARE_PATH = '/api/v1/me/face-timeline/share'
const CONSENT_PATH = '/api/v1/me/face-share-consent'
const CURRENT_VERSION = 1
const DAY_MS = 24 * 60 * 60 * 1000
/** Far enough back that the chase is past its review point (six weeks), when the wider check-in scan is allowed, and more than 14 days before the second photo. */
const BACKDATE_MS = 50 * DAY_MS

/** What the stand-in answers: a PNG signature and a marker. */
const CARD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7, 7])
const LOGO = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5, 5])

/** A stand-in for env.IMAGES: every call on the chain returns the chain, and output() records the options and answers the fixed card. */
const standInImages = () => {
  const outputs: { format: string }[] = []
  const answer = (format: string) => ({
    response: (options?: { headers?: HeadersInit }) => new Response(CARD, { headers: { ...(options?.headers as Record<string, string> | undefined), 'content-type': format } }),
    image: () => new Response(CARD).body!,
    contentType: () => format,
  })
  const chain: unknown = new Proxy(
    {},
    {
      get: (_target, property) => {
        if (property === 'then') return undefined
        if (property === 'output') {
          return async (options: { format: string }) => {
            outputs.push(options)
            return answer(options.format)
          }
        }
        if (property === 'info') return async () => ({ format: 'image/jpeg', fileSize: 1, width: 1080, height: 1440 })
        return () => chain
      },
    },
  )
  return { binding: chain, outputs }
}
const images = standInImages()

const WORKER_ENV = {
  ...env,
  OTP_CHANNELS: 'email',
  IMAGES: images.binding as ImagesBinding,
  // Taking a face scan puts it on the analysis queue; nothing here runs the queue.
  FACE_SCANS_QUEUE: { send: async () => undefined, sendBatch: async () => undefined } as unknown as Queue,
}
const fetchWorker = (path: string, init?: RequestInit) => worker.fetch!(new Request(`http://deepertones.test${path}`, init) as never, WORKER_ENV, createExecutionContext())

const runSalt = String(Math.floor(Math.random() * 1e6))
let counter = 0
const next = () => counter++
const freshIp = () => {
  const n = next()
  return `10.${(Number(runSalt) + 13) % 250}.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`
}
const freshEmail = () => `Face-share-card-${runSalt}-${next()}@Example.com`

type Envelope<T> = { success: true; status: number; data: T } | { success: false; status: number; error: { code: string; details?: Record<string, unknown> } }
const errorCodeOf = async (res: Response) => {
  const body = (await res.json()) as Envelope<unknown>
  if (body.success) throw new Error(`expected an error, got ${res.status}`)
  return body.error.code
}

const db = createDb(env.DB)
const users = new UsersService({ repository: new D1UsersRepository(db) })
const profiles = new ProfilesService({ repository: new D1ProfilesRepository(db) })
const tokenService = new TokenService({ secret: env.JWT_SECRET })
const faceScanRows = new D1FaceScansRepository(db)
const shareRows = new D1FaceSharesRepository(db)

type Account = { userId: string; profileId: string; token: string }

const newVerified = async (): Promise<Account> => {
  const guest = await users.guestForDevice(`face-share-card-seed-${runSalt}-${next()}`, 'ios')
  const { user } = await users.promote(guest.id, { kind: 'email', email: freshEmail().toLowerCase() as EmailAddress })
  const profileId = (await profiles.defaultFor(user.id)).id
  return { userId: user.id, profileId, token: (await tokenService.issue(user, profileId)).accessToken }
}
const asGuestAgain = async (account: Account): Promise<Account> => {
  const { accessToken } = await tokenService.issue({ id: account.userId, status: 'anonymous', tokenVersion: 0 }, account.profileId)
  return { ...account, token: accessToken }
}

const call = (who: Account | undefined, path: string, method: string, body?: unknown) =>
  fetchWorker(path, {
    method,
    headers: { 'cf-connecting-ip': freshIp(), ...(who ? { Authorization: `Bearer ${who.token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
const putShareConsent = async (who: Account) => expect((await call(who, CONSENT_PATH, 'PUT', { version: CURRENT_VERSION })).status).toBe(200)
const postShare = (who: Account | undefined, body: unknown) => call(who, SHARE_PATH, 'POST', body)

const asUser = <T>(account: Account, fn: () => Promise<T>) => runAs({ kind: 'user', userId: account.userId, status: 'verified', profileId: account.profileId } satisfies Actor, fn)

const FRONT_PHOTO = () => jpegPhoto({ width: 1080, height: 1440 })

/**
 * A signed-up Amara with a face photo consent, a goal and two scans of that goal made through the product's own write path (consent, goal, `create`), each made ready by the
 * write the analysis makes: a day one, and a later one that is allowed as the chase's check-in because day one (and the goal row that opened its chase) is moved 50 days back,
 * the fixture move the face scan route tests make on their real clock.
 */
const withTwoPhotos = async () => {
  const account = await newVerified()
  const container = buildContainer(WORKER_ENV)
  await asUser(account, () => container.faceScans.giveConsent(1))
  await asUser(account, () => container.goals.set({ goal: 'glow' }))
  const makeReady = (faceScanId: string) =>
    faceScanRows.completeFaceScan(faceScanId, { results: [], masks: [], skinType: null, skinAge: null, tablesVersion: 'tables-under-test', updatedAt: new Date() })

  const dayOne = (await asUser(account, () => container.faceScans.create({ front: FRONT_PHOTO() }))).id as string
  await makeReady(dayOne)
  await env.DB.prepare('UPDATE profile_goals SET created_at = created_at - ? WHERE profile_id = ?').bind(BACKDATE_MS, account.profileId).run()
  await env.DB.prepare('UPDATE face_scans SET created_at = created_at - ? WHERE id = ?').bind(BACKDATE_MS, dayOne).run()
  const after = (await asUser(account, () => container.faceScans.create({ front: FRONT_PHOTO() }))).id as string
  await makeReady(after)
  return { account, dayOne, after }
}

const keysIn = async (bucket: R2Bucket) => (await bucket.list()).objects.map((object) => object.key).sort()

const putLogo = () => env.CATALOG_IMAGES.put('email/logo.png', LOGO, { httpMetadata: { contentType: 'image/png' } })

describe('POST /api/v1/me/face-timeline/share', () => {
  it('answers the card as a PNG that is never cached, records the share, and stores nothing', async () => {
    await putLogo()
    const { account, dayOne, after } = await withTwoPhotos()
    await putShareConsent(account)
    const privateKeys = await keysIn(env.PRIVATE_PHOTOS)
    const publicKeys = await keysIn(env.CATALOG_IMAGES)

    const res = await postShare(account, { afterScanId: after })

    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(res.headers.get('cache-control')).toContain('no-store')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(CARD)
    const shares = await shareRows.sharesOf(account.profileId)
    expect(shares).toHaveLength(1)
    expect(shares[0]).toMatchObject({ profileId: account.profileId, beforeScanId: dayOne, afterScanId: after, consentVersion: CURRENT_VERSION })
    expect(Math.abs(shares[0]!.createdAt.getTime() - Date.now())).toBeLessThan(60_000)
    expect(await keysIn(env.PRIVATE_PHOTOS)).toEqual(privateKeys)
    expect(await keysIn(env.CATALOG_IMAGES)).toEqual(publicKeys)
  })

  it('refuses a caller with no session with 401 AUTH_REQUIRED, even with a body that is not valid, and renders nothing', async () => {
    const rendered = images.outputs.length

    const res = await postShare(undefined, { nonsense: true })

    expect(res.status).toBe(401)
    expect(await errorCodeOf(res)).toBe('AUTH_REQUIRED')
    expect(images.outputs).toHaveLength(rendered)
  })

  it('refuses a guest with 403 SIGNUP_REQUIRED, and renders and records nothing', async () => {
    const { account, after } = await withTwoPhotos()
    await putShareConsent(account)
    const rendered = images.outputs.length

    const res = await postShare(await asGuestAgain(account), { afterScanId: after })

    expect(res.status).toBe(403)
    expect(await errorCodeOf(res)).toBe('SIGNUP_REQUIRED')
    expect(images.outputs).toHaveLength(rendered)
    expect(await shareRows.sharesOf(account.profileId)).toEqual([])
  })

  it('refuses a signed-up caller who never said yes with 409 SHARE_CONSENT_REQUIRED, and renders and records nothing', async () => {
    const { account, after } = await withTwoPhotos()
    const rendered = images.outputs.length

    const res = await postShare(account, { afterScanId: after })

    expect(res.status).toBe(409)
    expect(await errorCodeOf(res)).toBe('SHARE_CONSENT_REQUIRED')
    expect(images.outputs).toHaveLength(rendered)
    expect(await shareRows.sharesOf(account.profileId)).toEqual([])
  })

  it('refuses a scan that is not hers with 404 FACE_SCAN_NOT_FOUND, the same for an unknown id as for another account\'s scan', async () => {
    const mine = await withTwoPhotos()
    const theirs = await withTwoPhotos()
    await putShareConsent(mine.account)
    const rendered = images.outputs.length

    const unknown = await postShare(mine.account, { afterScanId: crypto.randomUUID() })
    const someoneElses = await postShare(mine.account, { afterScanId: theirs.after })

    for (const res of [unknown, someoneElses]) {
      expect(res.status).toBe(404)
      expect(await errorCodeOf(res)).toBe('FACE_SCAN_NOT_FOUND')
    }
    expect(images.outputs).toHaveLength(rendered)
    expect(await shareRows.sharesOf(mine.account.profileId)).toEqual([])
  })

  it('asks the stand-in for a PNG when it renders', async () => {
    await putLogo()
    const { account, after } = await withTwoPhotos()
    await putShareConsent(account)
    const rendered = images.outputs.length

    expect((await postShare(account, { afterScanId: after })).status).toBe(200)

    const asked = images.outputs.slice(rendered)
    expect(asked.length).toBeGreaterThan(0)
    expect(asked.every((options) => options.format === 'image/png')).toBe(true)
  })
})
