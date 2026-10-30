import { createExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import worker from '../../src/index'
import { createDb } from '../../src/lib/db'
import type { EmailAddress } from '../../src/lib/email-address'
import { TokenService } from '../../src/modules/auth/tokens.service'
import { D1ProfilesRepository } from '../../src/modules/profiles/profiles.repository'
import { D1UsersRepository } from '../../src/modules/users/users.repository'
import { UsersService } from '../../src/modules/users/users.service'
import { ProfilesService } from '../../src/modules/profiles/profiles.service'

// The face share consent routes (spec #259, C1) through the Worker's real entrypoint with real local D1: the person says yes once to sharing a before-and-after
// card of their face photos, the answer is remembered, and they can take it back. Nothing else is called.
//
// THE CONTRACT THIS FILE PINS (the brief gives the routes, codes and statuses; the guest code on GET and DELETE and the key sets are the assumptions):
//   PUT    /api/v1/me/face-share-consent { version }   200 { version, givenAt }; only the current version (1); any other is 400 FACE_SHARE_CONSENT_VERSION_MISMATCH with
//          details { current: 1 }. A body that is not { version: whole number } is 400 VALIDATION_FAILED. Again, or after a withdrawal, is 200 and starts it afresh.
//   GET    /api/v1/me/face-share-consent               200 { version, givenAt, withdrawnAt, current }; a withdrawn consent is still shown, with withdrawnAt and
//          current false. 404 FACE_SHARE_CONSENT_NOT_FOUND until the profile has given one.
//   DELETE /api/v1/me/face-share-consent               204 with no body: stamps withdrawn_at; 204 again when already withdrawn and 204 when there was never a consent.
//   All three: 401 AUTH_REQUIRED with no session (before the body of the PUT is looked at), 403 SIGNUP_REQUIRED for a guest (also before the version is looked at).
//   The consent belongs to the profile (the token's pid), not the account.
// "Given for an older version shows current false" cannot be reached over HTTP (the PUT refuses an older version); the service test pins it.

const WORKER_ENV = { ...env, OTP_CHANNELS: 'email' }

const SECOND = 1000
const MINUTE = 60 * SECOND
// The one clock for what the routes stamp: "now" is the real clock the Worker runs on.
const STARTED = Date.now()
const CURRENT_VERSION = 1
const PATH = '/api/v1/me/face-share-consent'

const fetchWorker = (path: string, init?: RequestInit) => worker.fetch!(new Request(`http://deepertones.test${path}`, init) as never, WORKER_ENV, createExecutionContext())

const runSalt = String(Math.floor(Math.random() * 1e6))
let counter = 0
const next = () => counter++
// A new IP per call keeps the rate limits (keyed by IP) from coupling tests.
const freshIp = () => {
  const n = next()
  return `10.${(Number(runSalt) + 11) % 250}.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`
}
const freshEmail = () => `Face-share-${runSalt}-${next()}@Example.com`

type Envelope<T> = { success: true; status: number; data: T } | { success: false; status: number; error: { code: string; details?: Record<string, unknown> } }
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

type ConsentView = { version: number; givenAt: string; withdrawnAt: string | null; current: boolean }

// Set-up shortcuts for accounts that already exist. They use the same services the Worker uses.
const db = createDb(env.DB)
const users = new UsersService({ repository: new D1UsersRepository(db) })
const profiles = new ProfilesService({ repository: new D1ProfilesRepository(db) })
const profileRows = new D1ProfilesRepository(db)
const tokenService = new TokenService({ secret: env.JWT_SECRET })

type Account = { userId: string; profileId: string; token: string }

/** A signed-up account, and an access token for its own default profile. */
const newVerified = async (): Promise<Account> => {
  const guest = await users.guestForDevice(`face-share-seed-${runSalt}-${next()}`, 'ios')
  const { user } = await users.promote(guest.id, { kind: 'email', email: freshEmail().toLowerCase() as EmailAddress })
  const profileId = (await profiles.defaultFor(user.id)).id
  return { userId: user.id, profileId, token: (await tokenService.issue(user, profileId)).accessToken }
}
/** The same account acting as a second profile of its own: a verified token that names a new profile. */
const asSecondProfile = async (account: Account): Promise<Account> => {
  const profile = { id: crypto.randomUUID(), userId: account.userId, displayName: null, isDefault: false, createdAt: new Date(STARTED + MINUTE) }
  await profileRows.insert(profile)
  const { accessToken } = await tokenService.issue({ id: account.userId, status: 'verified', tokenVersion: 0 }, profile.id)
  return { ...account, profileId: profile.id, token: accessToken }
}
/** The same account and profile with an `anonymous` token, as a guest of that account holds: what is refused is the status and nothing else. */
const asGuestAgain = async (account: Account): Promise<Account> => {
  const { accessToken } = await tokenService.issue({ id: account.userId, status: 'anonymous', tokenVersion: 0 }, account.profileId)
  return { ...account, token: accessToken }
}
/** A real guest, the way an install starts one. */
const newGuest = async (): Promise<Account> => {
  const guest = await users.guestForDevice(`face-share-guest-${runSalt}-${next()}`, 'ios')
  const profileId = (await profiles.defaultFor(guest.id)).id
  return { userId: guest.id, profileId, token: (await tokenService.issue(guest, profileId)).accessToken }
}

const call = (who: Account | undefined, method: string, body?: unknown) =>
  fetchWorker(PATH, {
    method,
    headers: { 'cf-connecting-ip': freshIp(), ...(who ? { Authorization: `Bearer ${who.token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
const putConsent = (who: Account | undefined, body: unknown = { version: CURRENT_VERSION }) => call(who, 'PUT', body)
const getConsent = (who: Account | undefined) => call(who, 'GET')
const deleteConsent = (who: Account | undefined) => call(who, 'DELETE')
const countOfShareConsents = async (profileId: string) => (await env.DB.prepare('SELECT count(*) AS n FROM face_share_consents WHERE profile_id = ?').bind(profileId).first<{ n: number }>())!.n

describe('PUT /api/v1/me/face-share-consent', () => {
  it('records consent for the current version and answers 200 with the version and when it was given', async () => {
    const account = await newVerified()

    const res = await putConsent(account)

    expect(res.status).toBe(200)
    const data = await dataOf<{ version: number; givenAt: string }>(res)
    expect(data.version).toBe(CURRENT_VERSION)
    expect(Object.keys(data).sort()).toEqual(['givenAt', 'version'])
    expect(Date.parse(data.givenAt)).toBeGreaterThanOrEqual(STARTED - SECOND)
    expect(Date.parse(data.givenAt)).toBeLessThanOrEqual(Date.now() + SECOND)
  })

  it('refuses a guest with 403 SIGNUP_REQUIRED, and records nothing: once the account is signed up it has no consent', async () => {
    const account = await newVerified()
    const guest = await asGuestAgain(account)

    const res = await putConsent(guest)

    expect(res.status).toBe(403)
    expect(await errorCodeOf(res)).toBe('SIGNUP_REQUIRED')
    expect(await countOfShareConsents(account.profileId)).toBe(0)
    expect((await getConsent(account)).status).toBe(404)
  })

  it('tells a guest 403 SIGNUP_REQUIRED even for a wrong version, a real guest included', async () => {
    const res = await putConsent(await newGuest(), { version: CURRENT_VERSION + 1 })

    expect(res.status).toBe(403)
    expect(await errorCodeOf(res)).toBe('SIGNUP_REQUIRED')
  })

  it('refuses a caller who is not signed in: 401 AUTH_REQUIRED, even for a body that is not valid', async () => {
    for (const body of [{ version: CURRENT_VERSION }, {}]) {
      const res = await putConsent(undefined, body)

      expect(res.status).toBe(401)
      expect(await errorCodeOf(res)).toBe('AUTH_REQUIRED')
    }
  })

  it.each([
    ['an older version', CURRENT_VERSION - 1],
    ['a version the app does not know yet', CURRENT_VERSION + 1],
  ])('refuses %s with 400 FACE_SHARE_CONSENT_VERSION_MISMATCH, saying which is current, and records nothing', async (_label, version) => {
    const account = await newVerified()

    const res = await putConsent(account, { version })

    expect(res.status).toBe(400)
    const error = await errorOf(res)
    expect(error.code).toBe('FACE_SHARE_CONSENT_VERSION_MISMATCH')
    expect(error.details).toEqual({ current: CURRENT_VERSION })
    expect((await getConsent(account)).status).toBe(404)
  })

  it.each([
    ['no body field', {}],
    ['a version that is text', { version: '1' }],
    ['a version that is not a whole number', { version: 1.5 }],
    ['a version that is null', { version: null }],
  ])('refuses %s with 400 VALIDATION_FAILED', async (_label, body) => {
    const account = await newVerified()

    const res = await putConsent(account, body)

    expect(res.status).toBe(400)
    expect(await errorCodeOf(res)).toBe('VALIDATION_FAILED')
  })

  it('giving consent twice is fine and keeps one consent', async () => {
    const account = await newVerified()
    expect((await putConsent(account)).status).toBe(200)

    expect((await putConsent(account)).status).toBe(200)

    expect((await dataOf<ConsentView>(await getConsent(account))).current).toBe(true)
    expect(await countOfShareConsents(account.profileId)).toBe(1)
  })

  it('giving consent after withdrawing is 200 and starts it afresh: current again, the withdrawal cleared, a time that is not the first one', async () => {
    const account = await newVerified()
    const first = await dataOf<{ givenAt: string }>(await putConsent(account))
    expect((await deleteConsent(account)).status).toBe(204)

    const res = await putConsent(account)

    expect(res.status).toBe(200)
    const again = await dataOf<{ version: number; givenAt: string }>(res)
    expect(Date.parse(again.givenAt)).toBeGreaterThanOrEqual(Date.parse(first.givenAt))
    expect(await dataOf<ConsentView>(await getConsent(account))).toEqual({ version: CURRENT_VERSION, givenAt: again.givenAt, withdrawnAt: null, current: true })
  })
})

describe('GET /api/v1/me/face-share-consent', () => {
  it('shows the version, when it was given, that it was not withdrawn, and that it is current', async () => {
    const account = await newVerified()
    const given = await dataOf<{ givenAt: string }>(await putConsent(account))

    const res = await getConsent(account)

    expect(res.status).toBe(200)
    expect(await dataOf<ConsentView>(res)).toEqual({ version: CURRENT_VERSION, givenAt: given.givenAt, withdrawnAt: null, current: true })
  })

  it('still shows a withdrawn consent, with when it was withdrawn and current false', async () => {
    const account = await newVerified()
    const given = await dataOf<{ givenAt: string }>(await putConsent(account))
    await deleteConsent(account)

    const res = await getConsent(account)

    expect(res.status).toBe(200)
    const shown = await dataOf<ConsentView>(res)
    expect(shown).toMatchObject({ version: CURRENT_VERSION, givenAt: given.givenAt, current: false })
    expect(Date.parse(shown.withdrawnAt!)).toBeGreaterThanOrEqual(STARTED - SECOND)
    expect(Date.parse(shown.withdrawnAt!)).toBeLessThanOrEqual(Date.now() + SECOND)
  })

  it('is 404 FACE_SHARE_CONSENT_NOT_FOUND until consent is given', async () => {
    const account = await newVerified()

    const res = await getConsent(account)

    expect(res.status).toBe(404)
    expect(await errorCodeOf(res)).toBe('FACE_SHARE_CONSENT_NOT_FOUND')
  })

  it('is not the face photo consent: giving that one does not give this one', async () => {
    const account = await newVerified()
    const photoConsent = await fetchWorker('/api/v1/me/face-consent', { method: 'PUT', headers: { 'cf-connecting-ip': freshIp(), Authorization: `Bearer ${account.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ version: 1 }) })
    expect(photoConsent.status).toBe(200)

    const res = await getConsent(account)

    expect(res.status).toBe(404)
    expect(await errorCodeOf(res)).toBe('FACE_SHARE_CONSENT_NOT_FOUND')
  })

  it('refuses a guest with 403 SIGNUP_REQUIRED, and a caller who is not signed in with 401 AUTH_REQUIRED', async () => {
    const account = await newVerified()
    await putConsent(account)

    const asGuest = await getConsent(await asGuestAgain(account))
    expect(asGuest.status).toBe(403)
    expect(await errorCodeOf(asGuest)).toBe('SIGNUP_REQUIRED')

    const unsigned = await getConsent(undefined)
    expect(unsigned.status).toBe(401)
    expect(await errorCodeOf(unsigned)).toBe('AUTH_REQUIRED')
  })

  it('belongs to the profile: the account\'s other profile has none, and another account has none', async () => {
    const first = await newVerified()
    const second = await asSecondProfile(first)
    const stranger = await newVerified()
    expect((await putConsent(first)).status).toBe(200)

    for (const who of [second, stranger]) {
      const res = await getConsent(who)

      expect(res.status).toBe(404)
      expect(await errorCodeOf(res)).toBe('FACE_SHARE_CONSENT_NOT_FOUND')
    }
    expect((await getConsent(first)).status).toBe(200)
  })
})

describe('DELETE /api/v1/me/face-share-consent', () => {
  it('withdraws consent with 204 and no body, and keeps it on record as withdrawn and no longer current', async () => {
    const account = await newVerified()
    const given = await dataOf<{ givenAt: string }>(await putConsent(account))

    const res = await deleteConsent(account)

    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
    const shown = await dataOf<ConsentView>(await getConsent(account))
    expect(shown).toMatchObject({ version: CURRENT_VERSION, givenAt: given.givenAt, current: false })
    expect(Date.parse(shown.withdrawnAt!)).toBeGreaterThanOrEqual(STARTED - SECOND)
  })

  it('is 204 again when it is already withdrawn, and the first withdrawal time stands', async () => {
    const account = await newVerified()
    await putConsent(account)
    await deleteConsent(account)
    const first = (await dataOf<ConsentView>(await getConsent(account))).withdrawnAt

    const res = await deleteConsent(account)

    expect(res.status).toBe(204)
    expect((await dataOf<ConsentView>(await getConsent(account))).withdrawnAt).toBe(first)
  })

  it('is 204 when there was never any consent, and makes no record of one', async () => {
    const account = await newVerified()

    const res = await deleteConsent(account)

    expect(res.status).toBe(204)
    expect((await getConsent(account)).status).toBe(404)
    expect(await countOfShareConsents(account.profileId)).toBe(0)
  })

  it('refuses a guest with 403 SIGNUP_REQUIRED and withdraws nothing, and a caller who is not signed in with 401 AUTH_REQUIRED', async () => {
    const account = await newVerified()
    await putConsent(account)

    const asGuest = await deleteConsent(await asGuestAgain(account))
    expect(asGuest.status).toBe(403)
    expect(await errorCodeOf(asGuest)).toBe('SIGNUP_REQUIRED')
    expect(await dataOf<ConsentView>(await getConsent(account))).toMatchObject({ withdrawnAt: null, current: true })

    const unsigned = await deleteConsent(undefined)
    expect(unsigned.status).toBe(401)
    expect(await errorCodeOf(unsigned)).toBe('AUTH_REQUIRED')
  })

  it('withdraws the active profile\'s consent only', async () => {
    const first = await newVerified()
    const second = await asSecondProfile(first)
    await putConsent(first)
    await putConsent(second)

    await deleteConsent(first)

    expect((await dataOf<ConsentView>(await getConsent(first))).current).toBe(false)
    expect((await dataOf<ConsentView>(await getConsent(second))).current).toBe(true)
  })

  it('leaves the face photo consent alone', async () => {
    const account = await newVerified()
    const photoConsent = (method: string) => fetchWorker('/api/v1/me/face-consent', { method, headers: { 'cf-connecting-ip': freshIp(), Authorization: `Bearer ${account.token}`, 'content-type': 'application/json' }, ...(method === 'PUT' ? { body: JSON.stringify({ version: 1 }) } : {}) })
    expect((await photoConsent('PUT')).status).toBe(200)
    expect((await putConsent(account)).status).toBe(200)

    expect((await deleteConsent(account)).status).toBe(204)

    expect((await dataOf<ConsentView>(await photoConsent('GET'))).current).toBe(true)
  })
})
