import { createExecutionContext } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { hc } from 'hono/client'
import { beforeAll, describe, expect, it } from 'vitest'
import worker, { type AppType } from '../../src/index'
import { createDb } from '../../src/lib/db'
import { D1ProfilesRepository } from '../../src/modules/profiles/profiles.repository'
import { D1RecommendationsRepository } from '../../src/modules/recommendations/recommendations.repository'
import { TokenService } from '../../src/modules/auth/tokens.service'
import { applyCatalogChange, countryRow, putCountry } from './catalog.workbook.support'
import { BURST_NEEDS_MS, inOneRateWindow, RATE_TEST_TIMEOUT_MS } from './rate-window'

// The shopping routes through the Worker's public surface, as the app uses them: the typed client against the real entrypoint and real local
// D1. The Countries tab is loaded the way the team loads it, through the admin import (PR 3), so these tests are red until PR 3 is merged in:
// without it there is no country to choose. NG is active; GB is a retired country (its row stays, and nobody can choose it).

const WORKER_ENV = { ...env, OTP_CHANNELS: 'email' }
const fetchWorker = (input: RequestInfo | URL, init?: RequestInit) => worker.fetch!(new Request(input, init) as never, WORKER_ENV, createExecutionContext())
const api = hc<AppType>('http://deepertones.test', { fetch: fetchWorker as typeof fetch })
// Every API route lives under /api/v1.
const v1 = api.api.v1

beforeAll(async () => {
  await applyCatalogChange(fetchWorker, (workbook) => {
    putCountry(workbook, countryRow('NG'))
    putCountry(workbook, countryRow('GB', { currency: 'GBP', low_max: 15, mid_max: 40, status: 'retired' }))
  })
})

const runSalt = String(Math.floor(Math.random() * 1e6))
let counter = 0
const next = () => counter++
// A new IP per call keeps the rate limits (keyed by IP) from coupling tests to each other.
const freshIp = () => {
  const n = next()
  return `10.${Number(runSalt) % 250}.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`
}

type Envelope<T> = { success: true; status: number; data: T } | { success: false; status: number; error: { code: string } }
type Reply = { json(): Promise<unknown>; status: number; headers: Headers }
type ShoppingBody = { country: string; budgetBand: string | null; updatedAt: string }

const dataOf = async <T>(res: Reply): Promise<T> => {
  const body = (await res.json()) as Envelope<T>
  if (!body.success) throw new Error(`expected a success, got ${res.status} ${body.error.code}`)
  return body.data
}
const errorCodeOf = async (res: Reply) => {
  const body = (await res.json()) as Envelope<unknown>
  if (body.success) throw new Error(`expected an error, got ${res.status}`)
  return body.error.code
}
const retryAfterOf = (res: Reply) => Number(res.headers.get('Retry-After'))

const headers = (bearer?: string): Record<string, string> => ({
  'cf-connecting-ip': freshIp(),
  ...(bearer === undefined ? {} : { Authorization: `Bearer ${bearer}` }),
})

/** A new guest session, the way an app install starts one. */
const newGuest = async () => {
  const deviceId = `device-shopping-${runSalt}-${next()}`
  const session = await dataOf<{ tokens: { accessToken: string }; user: { id: string } }>(await v1.auth.anonymous.$post({ json: { deviceId, platform: 'ios' } }, { headers: headers() }))
  return { accessToken: session.tokens.accessToken, userId: session.user.id }
}

const db = createDb(env.DB)
const tokenService = new TokenService({ secret: env.JWT_SECRET })

/** An access token for a second profile of the guest's account, as profile switching will issue one. */
const onSecondProfile = async (userId: string) => {
  const id = crypto.randomUUID()
  await new D1ProfilesRepository(db).insert({ id, userId, displayName: null, isDefault: false, createdAt: new Date() })
  return { profileId: id, accessToken: (await tokenService.issue({ id: userId, status: 'anonymous', tokenVersion: 0 }, id)).accessToken }
}
const profileIdOf = async (bearer: string) => (await dataOf<{ profile: { id: string } }>(await v1.me.$get({}, { headers: headers(bearer) }))).profile.id

const putShopping = (bearer: string | undefined, json: Record<string, unknown>, from?: string) =>
  v1.me.shopping.$put({ json: json as never }, { headers: { ...headers(bearer), ...(from === undefined ? {} : { 'cf-connecting-ip': from }) } })
const getShopping = (bearer: string | undefined) => v1.me.shopping.$get({}, { headers: headers(bearer) })

describe('PUT /api/v1/me/shopping', () => {
  it('answers 200 with the country, the band and when it was set, for a guest', async () => {
    const { accessToken } = await newGuest()
    const before = Date.now()

    const res = await putShopping(accessToken, { country: 'NG', budgetBand: 'mid' })

    expect(res.status).toBe(200)
    const body = await dataOf<ShoppingBody>(res)
    expect(body).toEqual({ country: 'NG', budgetBand: 'mid', updatedAt: expect.any(String) })
    const updatedAt = Date.parse(body.updatedAt)
    expect(new Date(updatedAt).toISOString()).toBe(body.updatedAt)
    expect(updatedAt).toBeGreaterThanOrEqual(before)
    expect(updatedAt).toBeLessThanOrEqual(Date.now())
  })

  it.each(['low', 'mid', 'high'])('accepts the %s band', async (band) => {
    const { accessToken } = await newGuest()

    expect(await dataOf<ShoppingBody>(await putShopping(accessToken, { country: 'NG', budgetBand: band }))).toMatchObject({ budgetBand: band })
  })

  it('answers a band of null when none is sent: the band is optional', async () => {
    const { accessToken } = await newGuest()

    const res = await putShopping(accessToken, { country: 'NG' })

    expect(res.status).toBe(200)
    expect(await dataOf<ShoppingBody>(res)).toMatchObject({ country: 'NG', budgetBand: null })
  })

  it('shows the same view from GET afterwards', async () => {
    const { accessToken } = await newGuest()
    const put = await dataOf<ShoppingBody>(await putShopping(accessToken, { country: 'NG', budgetBand: 'low' }))

    const res = await getShopping(accessToken)

    expect(res.status).toBe(200)
    expect(await dataOf(res)).toEqual(put)
  })

  it('keeps every change, and GET answers the newest: a band is taken back by sending the country alone', async () => {
    const { accessToken } = await newGuest()
    await putShopping(accessToken, { country: 'NG', budgetBand: 'high' })
    await putShopping(accessToken, { country: 'NG', budgetBand: 'low' })
    const last = await dataOf<ShoppingBody>(await putShopping(accessToken, { country: 'NG' }))

    expect(await dataOf(await getShopping(accessToken))).toEqual(last)
    const history = await new D1RecommendationsRepository(db).history(await profileIdOf(accessToken))
    expect(history.map((row) => [row.country, row.budgetBand])).toEqual([
      ['NG', null],
      ['NG', 'low'],
      ['NG', 'high'],
    ])
  })

  it('answers 400 UNKNOWN_COUNTRY for a country that is not in the Countries tab, and stores nothing', async () => {
    const { accessToken } = await newGuest()

    const res = await putShopping(accessToken, { country: 'ZZ', budgetBand: 'mid' })

    expect(res.status).toBe(400)
    expect(await errorCodeOf(res)).toBe('UNKNOWN_COUNTRY')
    expect((await getShopping(accessToken)).status).toBe(404)
  })

  it('answers 400 UNKNOWN_COUNTRY for a retired country: its row stays in the tab but it is no longer served', async () => {
    const { accessToken } = await newGuest()

    const res = await putShopping(accessToken, { country: 'GB' })

    expect(res.status).toBe(400)
    expect(await errorCodeOf(res)).toBe('UNKNOWN_COUNTRY')
    expect((await getShopping(accessToken)).status).toBe(404)
  })

  it('answers 400 UNKNOWN_BUDGET_BAND for a band that is not low, mid or high, and stores nothing', async () => {
    const { accessToken } = await newGuest()

    const res = await putShopping(accessToken, { country: 'NG', budgetBand: 'platinum' })

    expect(res.status).toBe(400)
    expect(await errorCodeOf(res)).toBe('UNKNOWN_BUDGET_BAND')
    expect((await getShopping(accessToken)).status).toBe(404)
  })

  it.each([
    ['no country', { budgetBand: 'mid' }],
    ['a country that is not text', { country: 4 }],
    ['a band that is not text', { country: 'NG', budgetBand: 4 }],
  ])('answers 400 VALIDATION_FAILED for %s, and stores nothing', async (_label, json) => {
    const { accessToken } = await newGuest()

    const res = await putShopping(accessToken, json)

    expect(res.status).toBe(400)
    expect(await errorCodeOf(res)).toBe('VALIDATION_FAILED')
    expect((await getShopping(accessToken)).status).toBe(404)
  })

  it('leaves the fact already set as it was when a later request is refused', async () => {
    const { accessToken } = await newGuest()
    const set = await dataOf<ShoppingBody>(await putShopping(accessToken, { country: 'NG', budgetBand: 'mid' }))

    expect((await putShopping(accessToken, { country: 'ZZ' })).status).toBe(400)

    expect(await dataOf(await getShopping(accessToken))).toEqual(set)
  })
})

describe('GET /api/v1/me/shopping', () => {
  it('answers 404 SHOPPING_NOT_SET before anything was set', async () => {
    const { accessToken } = await newGuest()

    const res = await getShopping(accessToken)

    expect(res.status).toBe(404)
    expect(await errorCodeOf(res)).toBe('SHOPPING_NOT_SET')
  })

  it('keeps one account\'s fact from another', async () => {
    const amara = await newGuest()
    const tolu = await newGuest()
    await putShopping(amara.accessToken, { country: 'NG', budgetBand: 'mid' })

    expect((await getShopping(tolu.accessToken)).status).toBe(404)
  })

  it('keeps one profile\'s fact from another profile of the same account, in both directions', async () => {
    const amara = await newGuest()
    await putShopping(amara.accessToken, { country: 'NG', budgetBand: 'mid' })
    const second = await onSecondProfile(amara.userId)

    const res = await getShopping(second.accessToken)

    expect(res.status).toBe(404)
    expect(await errorCodeOf(res)).toBe('SHOPPING_NOT_SET')
    await putShopping(second.accessToken, { country: 'NG', budgetBand: 'high' })
    expect(await dataOf(await getShopping(amara.accessToken))).toMatchObject({ budgetBand: 'mid' })
    expect(await dataOf(await getShopping(second.accessToken))).toMatchObject({ budgetBand: 'high' })
  })
})

describe('PUT /api/v1/me/shopping rate limits', () => {
  it('documents the statuses in the OpenAPI document, the 429 included', async () => {
    const res = await fetchWorker('http://deepertones.test/openapi.json')
    expect(res.status).toBe(200)
    const doc = (await res.json()) as { paths: Record<string, { put?: { responses: Record<string, unknown> }; get?: { responses: Record<string, unknown> } }> }

    expect(Object.keys(doc.paths['/api/v1/me/shopping']!.put!.responses)).toEqual(expect.arrayContaining(['200', '400', '401', '429']))
    expect(Object.keys(doc.paths['/api/v1/me/shopping']!.get!.responses)).toEqual(expect.arrayContaining(['200', '401', '404']))
  })

  it('answers 429 RATE_LIMITED with Retry-After to the 11th change of one user in a minute, from any address', async () => {
    const { statuses, limited } = await inOneRateWindow(async () => {
      const { accessToken } = await newGuest()
      const statuses: number[] = []
      let limited: Awaited<ReturnType<typeof putShopping>> | undefined
      for (let i = 0; i < 11; i++) {
        const res = await putShopping(accessToken, { country: 'NG', budgetBand: i % 2 === 0 ? 'low' : 'high' })
        statuses.push(res.status)
        if ((res.status as number) === 429) limited = res
      }
      return { statuses, limited }
    }, { needMs: BURST_NEEDS_MS })

    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(200))
    expect(statuses[10]).toBe(429)
    expect(await errorCodeOf(limited!)).toBe('RATE_LIMITED')
    expect(retryAfterOf(limited!)).toBeGreaterThan(0)
  }, RATE_TEST_TIMEOUT_MS)

  it('answers 429 RATE_LIMITED with Retry-After to the 21st change from one address in a minute, whoever sends it', async () => {
    const { statuses, limited } = await inOneRateWindow(async () => {
      const shared = freshIp()
      const statuses: number[] = []
      let limited: Awaited<ReturnType<typeof putShopping>> | undefined
      for (let i = 0; i < 21; i++) {
        const res = await putShopping((await newGuest()).accessToken, { country: 'NG' }, shared)
        statuses.push(res.status)
        if ((res.status as number) === 429) limited = res
      }
      return { statuses, limited }
    }, { needMs: BURST_NEEDS_MS })

    expect(statuses.slice(0, 20)).toEqual(Array(20).fill(200))
    expect(statuses[20]).toBe(429)
    expect(await errorCodeOf(limited!)).toBe('RATE_LIMITED')
    expect(retryAfterOf(limited!)).toBeGreaterThan(0)
  }, RATE_TEST_TIMEOUT_MS)

  it('leaves reading the fact alone once the limit is passed', async () => {
    const { statuses, got } = await inOneRateWindow(async () => {
      const { accessToken } = await newGuest()
      const statuses: number[] = []
      for (let i = 0; i < 11; i++) statuses.push((await putShopping(accessToken, { country: 'NG' })).status)
      return { statuses, got: await getShopping(accessToken) }
    }, { needMs: BURST_NEEDS_MS })

    expect(statuses[10]).toBe(429)
    expect(got.status).toBe(200)
  }, RATE_TEST_TIMEOUT_MS)
})

describe('the shopping routes without a session', () => {
  it('answers 401 AUTH_REQUIRED from PUT and GET', async () => {
    const put = await putShopping(undefined, { country: 'NG' })
    const got = await getShopping(undefined)

    for (const res of [put, got]) {
      expect(res.status).toBe(401)
      expect(await errorCodeOf(res)).toBe('AUTH_REQUIRED')
    }
  })

  it('answers 401 TOKEN_INVALID for a token that is not ours', async () => {
    const res = await getShopping('not-a-token')

    expect(res.status).toBe(401)
    expect(await errorCodeOf(res)).toBe('TOKEN_INVALID')
  })
})
