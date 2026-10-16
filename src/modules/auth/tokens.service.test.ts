import { describe, expect, it } from 'vitest'
import { signJwt } from '../../lib/jwt'
import { ACCESS_TTL_SECONDS, REFRESH_TTL_SECONDS, TokenService } from './tokens.service'

// The one clock every test hangs off; fixtures are offsets from it.
const ISSUED = new Date('2030-01-01T00:00:00Z')
const after = (seconds: number) => new Date(ISSUED.getTime() + seconds * 1000)
const DAY = 24 * 3600

const USER = { id: 'u_1', status: 'anonymous', tokenVersion: 3 } as const

const serviceAt = (when: Date, secrets: { secret: string; previousSecret?: string } = { secret: 'secret-a' }) =>
  new TokenService({ ...secrets, now: () => when })

const issued = () => serviceAt(ISSUED).issue(USER)

describe('TokenService constants', () => {
  it('gives access tokens 15 minutes and refresh tokens 60 days', () => {
    expect(ACCESS_TTL_SECONDS).toBe(900)
    expect(REFRESH_TTL_SECONDS).toBe(60 * DAY)
  })
})

describe('TokenService secrets', () => {
  it('keeps the signing secrets out of the service when it is spread or serialised', () => {
    const service = serviceAt(ISSUED, { secret: 'secret-a', previousSecret: 'secret-b' })

    const spread = { ...service }
    expect(Object.keys(spread)).toContain('now')
    expect(JSON.stringify(spread)).not.toContain('secret-a')
    expect(JSON.stringify(spread)).not.toContain('secret-b')
  })
})

describe('TokenService.issue', () => {
  it('reports when each token expires', async () => {
    const tokens = await issued()

    expect(tokens.accessExpiresAt).toEqual(after(900))
    expect(tokens.refreshExpiresAt).toEqual(after(60 * DAY))
  })
})

describe('TokenService.verifyAccess', () => {
  it('returns the user id, status and token version of a fresh access token', async () => {
    const { accessToken } = await issued()

    expect(await serviceAt(after(1)).verifyAccess(accessToken)).toEqual({
      ok: true,
      userId: 'u_1',
      status: 'anonymous',
      version: 3,
    })
  })

  it('carries a verified status through', async () => {
    const { accessToken } = await serviceAt(ISSUED).issue({ id: 'u_2', status: 'verified', tokenVersion: 0 })

    expect(await serviceAt(after(1)).verifyAccess(accessToken)).toMatchObject({ ok: true, userId: 'u_2', status: 'verified', version: 0 })
  })

  it('is valid one second before 15 minutes and expired at 15 minutes plus one second', async () => {
    const { accessToken } = await issued()

    expect(await serviceAt(after(899)).verifyAccess(accessToken)).toMatchObject({ ok: true })
    expect(await serviceAt(after(901)).verifyAccess(accessToken)).toEqual({ ok: false, problem: 'expired' })
  })

  it('rejects a refresh token presented as an access token', async () => {
    const { refreshToken } = await issued()

    expect(await serviceAt(after(1)).verifyAccess(refreshToken)).toEqual({ ok: false, problem: 'invalid' })
  })

  it('rejects garbage', async () => {
    expect(await serviceAt(ISSUED).verifyAccess('garbage')).toEqual({ ok: false, problem: 'invalid' })
  })
})

describe('TokenService.verifyRefresh', () => {
  it('returns the user id and token version of a fresh refresh token', async () => {
    const { refreshToken } = await issued()

    expect(await serviceAt(after(1)).verifyRefresh(refreshToken)).toEqual({ ok: true, userId: 'u_1', version: 3 })
  })

  it('is valid one second before 60 days and expired at 60 days plus one second', async () => {
    const { refreshToken } = await issued()

    expect(await serviceAt(after(60 * DAY - 1)).verifyRefresh(refreshToken)).toMatchObject({ ok: true })
    expect(await serviceAt(after(60 * DAY + 1)).verifyRefresh(refreshToken)).toEqual({ ok: false, problem: 'expired' })
  })

  it('rejects an access token presented as a refresh token', async () => {
    const { accessToken } = await issued()

    expect(await serviceAt(after(1)).verifyRefresh(accessToken)).toEqual({ ok: false, problem: 'invalid' })
  })
})

describe('TokenService token version', () => {
  const claimsWith = (ver: unknown) =>
    signJwt({ sub: 'u_1', st: 'anonymous', ver, typ: 'access' }, { secret: 'secret-a', expiresInSeconds: 900, now: ISSUED })

  it.each([-1, 1.5, '3', null])('rejects version %s', async (ver) => {
    expect(await serviceAt(after(1)).verifyAccess(await claimsWith(ver))).toEqual({ ok: false, problem: 'invalid' })
  })
})

describe('TokenService secret rotation', () => {
  it('still verifies tokens signed with the previous secret', async () => {
    const { accessToken, refreshToken } = await serviceAt(ISSUED, { secret: 'secret-a' }).issue(USER)
    const rotated = serviceAt(after(1), { secret: 'secret-b', previousSecret: 'secret-a' })

    expect(await rotated.verifyAccess(accessToken)).toMatchObject({ ok: true, userId: 'u_1' })
    expect(await rotated.verifyRefresh(refreshToken)).toMatchObject({ ok: true, userId: 'u_1' })
  })

  it('works when the previous secret equals the current one', async () => {
    const same = serviceAt(ISSUED, { secret: 'secret-a', previousSecret: 'secret-a' })
    const { accessToken } = await same.issue(USER)

    expect(await same.verifyAccess(accessToken)).toMatchObject({ ok: true })
  })

  it('rejects tokens signed with a secret that is no longer configured', async () => {
    const { accessToken } = await serviceAt(ISSUED, { secret: 'secret-a' }).issue(USER)

    expect(await serviceAt(after(1), { secret: 'secret-b' }).verifyAccess(accessToken)).toEqual({ ok: false, problem: 'invalid' })
  })

  it('signs new tokens with the current secret, not the previous one', async () => {
    const { accessToken } = await serviceAt(ISSUED, { secret: 'secret-b', previousSecret: 'secret-a' }).issue(USER)

    expect(await serviceAt(after(1), { secret: 'secret-b' }).verifyAccess(accessToken)).toMatchObject({ ok: true })
    expect(await serviceAt(after(1), { secret: 'secret-a' }).verifyAccess(accessToken)).toEqual({ ok: false, problem: 'invalid' })
  })
})
