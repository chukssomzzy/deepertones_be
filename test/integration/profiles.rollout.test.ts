import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { hc } from 'hono/client'
import { describe, expect, it } from 'vitest'
import worker, { type AppType } from '../../src/index'
import { hmacSha256Hex } from '../../src/lib/crypto'
import { createDb } from '../../src/lib/db'
import { signJwt } from '../../src/lib/jwt'
import { SCAN_REAPER_CRON } from '../../src/jobs/scheduled'
import { D1ProfilesRepository } from '../../src/modules/profiles/profiles.repository'
import { ProfilesService } from '../../src/modules/profiles/profiles.service'
import { D1ScansRepository } from '../../src/modules/scans/scans.repository'

// The rollout gap, through the Worker's public surface. Deploys apply migrations 0011 (profiles + backfill) and 0012
// (scans.profile_id + backfill) BEFORE the new Worker goes live, and until a deploy succeeds the OLD Worker keeps creating
// users with no profile row and scans with profile_id NULL. The new Worker has to take both over: a profile-less user gets
// a default the moment a session is made for them, and the reaper cron gives the NULL scans their owner's default.
// The rows the old Worker would have written are inserted with raw SQL, because the new code cannot write them.

const NOW = Date.now()
const REFRESH_TTL_SECONDS = 60 * 24 * 60 * 60

const fetchWorker = (input: RequestInfo | URL, init?: RequestInit) => worker.fetch!(new Request(input, init) as never, env, createExecutionContext())
const api = hc<AppType>('http://deepertones.test', { fetch: fetchWorker as typeof fetch })

const runSalt = String(Math.floor(Math.random() * 1e6))
let counter = 0
const next = () => counter++
// A new IP per device keeps the rate limits (keyed by IP) from coupling tests to each other.
const freshIp = () => {
  const n = next()
  return `10.${(Number(runSalt) + 7) % 250}.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`
}

type Tokens = { accessToken: string; refreshToken: string }
type ProfileView = { id: string; displayName: string | null; isDefault: boolean; createdAt: string }
type MeView = { user: { id: string }; profile: ProfileView; profiles: ProfileView[] }
type Envelope<T> = { success: true; status: number; data: T } | { success: false; status: number; error: { code: string } }
type Reply = { json(): Promise<unknown>; status: number }

const dataOf = async <T>(res: Reply): Promise<T> => {
  const body = (await res.json()) as Envelope<T>
  if (!body.success) throw new Error(`expected a success, got ${res.status} ${body.error.code}`)
  return body.data
}
const sessionOf = (res: Reply) => dataOf<{ tokens: Tokens; user: { id: string } }>(res)

const pidOf = (jwt: string) => {
  const payload = jwt.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')
  return JSON.parse(atob(payload)).pid as unknown
}

const db = createDb(env.DB)
const profiles = new D1ProfilesRepository(db)
const scans = new D1ScansRepository(db)

/** What the old Worker did on a first launch: a users row and a devices row, and no profile. Returns the user and the device id the app would send. */
const profilelessUser = async () => {
  const userId = crypto.randomUUID()
  const deviceId = `device-rollout-${runSalt}-${next()}`
  const deviceHash = await hmacSha256Hex(env.DEVICE_ID_KEY, deviceId)
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users (id, status, token_version, created_at, last_seen_at) VALUES (?, ?, 0, ?, ?)').bind(userId, 'anonymous', NOW, NOW),
    env.DB.prepare('INSERT INTO devices (device_hash, platform, user_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)').bind(deviceHash, 'ios', userId, NOW, NOW),
  ])
  expect(await profiles.ofUser(userId)).toEqual([])
  return { userId, device: newDevice(deviceId) }
}

/** What the old Worker did on a scan: a row with profile_id NULL (and one item, so the scan reads like any other). */
const orphanScan = async (userId: string) => {
  const scanId = crypto.randomUUID()
  const itemId = crypto.randomUUID()
  await env.DB.batch([
    env.DB.prepare('INSERT INTO scans (id, user_id, profile_id, ip_hash, created_at) VALUES (?, ?, NULL, ?, ?)').bind(scanId, userId, `ip-${scanId}`, NOW),
    env.DB.prepare('INSERT INTO scan_items (id, scan_id, user_id, position, state, photo_key, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?)').bind(
      itemId,
      scanId,
      userId,
      'recognising',
      `photos/${env.ENVIRONMENT}/${userId}/${scanId}/${itemId}.jpg`,
      NOW,
      NOW,
    ),
  ])
  expect((await scans.findScan(scanId))!.profileId).toBeNull()
  return scanId
}

function newDevice(deviceId = `device-rollout-${runSalt}-${next()}`) {
  const headers = (bearer?: string): Record<string, string> => ({
    'cf-connecting-ip': freshIp(),
    ...(bearer === undefined ? {} : { Authorization: `Bearer ${bearer}` }),
  })
  return {
    bootstrap: () => api.auth.anonymous.$post({ json: { deviceId, platform: 'ios' } }, { headers: headers() }),
    refresh: (refreshToken: string) => api.auth.refresh.$post({ json: { refreshToken } }, { headers: headers() }),
    me: (bearer: string) => api.me.$get({}, { headers: headers(bearer) }),
    getScan: (bearer: string, scanId: string) => api.scans[':scanId'].$get({ param: { scanId } }, { headers: headers(bearer) }),
  }
}

// Tokens as the old Worker issued them: no `pid` claim. Signed with the real secret.
const refreshTokenWith = (claims: Record<string, unknown>) =>
  signJwt({ typ: 'refresh', ...claims }, { secret: env.JWT_SECRET, expiresInSeconds: REFRESH_TTL_SECONDS, now: new Date(NOW) })

const fire = async (cron: string) => {
  const ctx = createExecutionContext()
  await worker.scheduled!(createScheduledController({ scheduledTime: NOW, cron }), env, ctx)
  await waitOnExecutionContext(ctx)
}

describe('a user the old Worker made, with no profile', () => {
  it('gets a default profile when their device starts a session: 200, tokens with a pid, /me works, exactly one profile', async () => {
    const { userId, device } = await profilelessUser()

    const res = await device.bootstrap()

    expect(res.status).toBe(200)
    const { tokens, user } = await sessionOf(res)
    expect(user.id).toBe(userId)
    const [only, ...rest] = await profiles.ofUser(userId)
    expect(rest).toEqual([])
    expect(only).toMatchObject({ userId, displayName: null, isDefault: true })
    expect(pidOf(tokens.accessToken)).toBe(only!.id)
    expect(pidOf(tokens.refreshToken)).toBe(only!.id)
    const me = await device.me(tokens.accessToken)
    expect(me.status).toBe(200)
    expect((await dataOf<MeView>(me)).profile.id).toBe(only!.id)
  })

  it('keeps that one profile when the device starts another session', async () => {
    const { userId, device } = await profilelessUser()
    const first = await sessionOf(await device.bootstrap())

    const again = await sessionOf(await device.bootstrap())

    expect(pidOf(again.tokens.accessToken)).toBe(pidOf(first.tokens.accessToken))
    expect(await profiles.ofUser(userId)).toHaveLength(1)
  })

  it('refreshes a refresh token with no pid onto a default profile made on the spot, and the new access token works', async () => {
    const { userId, device } = await profilelessUser()

    const res = await device.refresh(await refreshTokenWith({ sub: userId, ver: 0 }))

    expect(res.status).toBe(200)
    const { tokens } = await sessionOf(res)
    const [only, ...rest] = await profiles.ofUser(userId)
    expect(rest).toEqual([])
    expect(pidOf(tokens.accessToken)).toBe(only!.id)
    expect((await dataOf<MeView>(await device.me(tokens.accessToken))).profile.id).toBe(only!.id)
  })

  it('refreshes a refresh token whose pid is not theirs onto the default made on the spot', async () => {
    const { userId, device } = await profilelessUser()

    const res = await device.refresh(await refreshTokenWith({ sub: userId, ver: 0, pid: crypto.randomUUID() }))

    expect(res.status).toBe(200)
    const { tokens } = await sessionOf(res)
    const [only, ...rest] = await profiles.ofUser(userId)
    expect(rest).toEqual([])
    expect(pidOf(tokens.accessToken)).toBe(only!.id)
    expect(pidOf(tokens.refreshToken)).toBe(only!.id)
  })

  it('ends up with one profile when two sessions are made at the same moment', async () => {
    const { userId } = await profilelessUser()
    const service = new ProfilesService({ repository: profiles })

    const [a, b] = await Promise.all([service.defaultFor(userId), service.defaultFor(userId)])

    expect(a.id).toBe(b.id)
    expect((await profiles.ofUser(userId)).map((p) => p.id)).toEqual([a.id])
  })

  it('is not given a profile for a user that does not exist: the foreign key refuses it', async () => {
    const service = new ProfilesService({ repository: profiles })

    await expect(service.defaultFor(crypto.randomUUID())).rejects.toThrow()
  })
})

describe('a scan the old Worker wrote with no profile', () => {
  it('cannot be read until the reaper cron has given it its owner\'s default profile, and then can', async () => {
    const device = newDevice()
    const { tokens, user } = await sessionOf(await device.bootstrap())
    const scanId = await orphanScan(user.id)
    expect((await device.getScan(tokens.accessToken, scanId)).status).toBe(404)

    await fire(SCAN_REAPER_CRON)

    expect((await scans.findScan(scanId))!.profileId).toBe(pidOf(tokens.accessToken))
    const res = await device.getScan(tokens.accessToken, scanId)
    expect(res.status).toBe(200)
    expect((await dataOf<{ id: string }>(res)).id).toBe(scanId)
  })

  it('stays without a profile while its owner has none, and is adopted once the owner\'s next session makes one', async () => {
    const { userId, device } = await profilelessUser()
    const scanId = await orphanScan(userId)

    await fire(SCAN_REAPER_CRON)
    expect((await scans.findScan(scanId))!.profileId).toBeNull()
    expect(await profiles.ofUser(userId)).toEqual([])

    const { tokens } = await sessionOf(await device.bootstrap())
    await fire(SCAN_REAPER_CRON)

    expect((await scans.findScan(scanId))!.profileId).toBe(pidOf(tokens.accessToken))
    expect((await device.getScan(tokens.accessToken, scanId)).status).toBe(200)
  })
})
