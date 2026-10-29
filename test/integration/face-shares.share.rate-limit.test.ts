import { createExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import worker from '../../src/index'
import type { EmailAddress } from '../../src/lib/email-address'
import { TokenService } from '../../src/modules/auth/tokens.service'
import { D1ProfilesRepository } from '../../src/modules/profiles/profiles.repository'
import { ProfilesService } from '../../src/modules/profiles/profiles.service'
import { D1UsersRepository } from '../../src/modules/users/users.repository'
import { UsersService } from '../../src/modules/users/users.service'
import { createDb } from '../../src/lib/db'
import { BURST_NEEDS_MS, inOneRateWindow, RATE_TEST_TIMEOUT_MS } from './rate-window'

// POST /api/v1/me/face-timeline/share is limited per user (FACE_SHARE_USER_LIMITER, 10 a minute), because every card spends an Images transformation. The route's other
// behaviour is face-shares.share.routes.test.ts's; this file proves only the limit, with a signed-up user who has not said yes to sharing, so each attempt is a cheap 409.

const SHARE_PATH = '/api/v1/me/face-timeline/share'
const runSalt = String(Math.floor(Math.random() * 1e6))
let counter = 0
const next = () => counter++

const db = createDb(env.DB)
const users = new UsersService({ repository: new D1UsersRepository(db) })
const profiles = new ProfilesService({ repository: new D1ProfilesRepository(db) })
const tokenService = new TokenService({ secret: env.JWT_SECRET })

const newVerifiedToken = async () => {
  const guest = await users.guestForDevice(`face-share-limit-seed-${runSalt}-${next()}`, 'ios')
  const { user } = await users.promote(guest.id, { kind: 'email', email: `face-share-limit-${runSalt}-${next()}@example.com` as EmailAddress })
  const profileId = (await profiles.defaultFor(user.id)).id
  return (await tokenService.issue(user, profileId)).accessToken
}

const freshIp = () => {
  const n = next()
  return `10.${(Number(runSalt) + 29) % 250}.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`
}

const postShare = (token: string) =>
  worker.fetch!(
    new Request(`http://deepertones.test${SHARE_PATH}`, {
      method: 'POST',
      headers: { 'cf-connecting-ip': freshIp(), Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ afterScanId: 'scan-1' }),
    }) as never,
    { ...env, OTP_CHANNELS: 'email' },
    createExecutionContext(),
  )

describe('POST /api/v1/me/face-timeline/share: rate limit', () => {
  it('answers 429 RATE_LIMITED with Retry-After to the 11th request of one user in a minute, from any address', async () => {
    const { statuses, limited } = await inOneRateWindow(async () => {
      const token = await newVerifiedToken()
      const statuses: number[] = []
      let limited: Response | undefined
      for (let i = 0; i < 11; i++) {
        const res = await postShare(token)
        statuses.push(res.status)
        if (res.status === 429) limited = res
      }
      return { statuses, limited }
    }, { needMs: BURST_NEEDS_MS })

    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(409))
    expect(statuses[10]).toBe(429)
    const body = (await limited!.json()) as { error: { code: string } }
    expect(body.error.code).toBe('RATE_LIMITED')
    expect(Number(limited!.headers.get('Retry-After'))).toBeGreaterThan(0)
  }, RATE_TEST_TIMEOUT_MS)
})
