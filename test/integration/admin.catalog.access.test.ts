import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import {
  ADMIN_TOKEN,
  EXPORT_URL,
  IMPORT_URL,
  WORKER_ENV,
  adminHeaders,
  counts,
  errorOf,
  exportLive,
  fetchWorker,
  freshIp,
  guestToken,
  importRaw,
  read,
  xlsxBytes,
} from './admin.catalog.support'
import { BURST_NEEDS_MS, inOneRateWindow, RATE_TEST_TIMEOUT_MS } from './rate-window'

// Who may reach /api/v1/admin/*, through the Worker's real entrypoint. The door is X-Admin-Token, compared with ADMIN_API_TOKEN; a user's bearer
// token never opens it (a user cannot change the catalog), and the door is rate limited per address BEFORE the token is checked, so a guess
// costs an attempt. The comparison's own cases (every near miss, an unset secret) are in src/middleware/admin-token.test.ts.

describe('the admin token', () => {
  describe.each([
    ['GET the export', (headers: Record<string, string>) => fetchWorker(EXPORT_URL, { headers })],
    ['POST the import', (headers: Record<string, string>) => importRaw({ workbook: '{}', baseVersion: 1, headers })],
  ])('%s', (_, call) => {
    it('is refused with 401 ADMIN_TOKEN_INVALID when X-Admin-Token is missing', async () => {
      const res = await call({ 'cf-connecting-ip': freshIp() })

      expect(res.status).toBe(401)
      expect((await errorOf(res)).code).toBe('ADMIN_TOKEN_INVALID')
    })

    it('is refused with 401 ADMIN_TOKEN_INVALID when X-Admin-Token is wrong', async () => {
      const res = await call({ 'cf-connecting-ip': freshIp(), 'X-Admin-Token': `${ADMIN_TOKEN}x` })

      expect(res.status).toBe(401)
      expect((await errorOf(res)).code).toBe('ADMIN_TOKEN_INVALID')
    })

    it('is refused with 401 when the caller holds a valid user access token and no admin token: a user can never change the catalog', async () => {
      const bearer = await guestToken()

      const res = await call({ 'cf-connecting-ip': freshIp(), Authorization: `Bearer ${bearer}` })

      expect(res.status).toBe(401)
      expect((await errorOf(res)).code).toBe('ADMIN_TOKEN_INVALID')
    })

    it('is refused with 401 when the admin token is sent where a user token goes (Authorization: Bearer)', async () => {
      const res = await call({ 'cf-connecting-ip': freshIp(), Authorization: `Bearer ${ADMIN_TOKEN}` })

      expect(res.status).toBe(401)
      expect((await errorOf(res)).code).toBe('ADMIN_TOKEN_INVALID')
    })
  })

  it('opens the export to the correct token alone, with no user signed in', async () => {
    const res = await fetchWorker(EXPORT_URL, { headers: adminHeaders() })

    expect(res.status).toBe(200)
    expect(await read<unknown>(res)).toMatchObject({ success: true, status: 200 })
  })

  it('refuses the correct token when the Worker has no ADMIN_API_TOKEN set: an unset secret locks the door', async () => {
    const unset = { ...WORKER_ENV, ADMIN_API_TOKEN: '' } as unknown as typeof env

    const res = await fetchWorker(EXPORT_URL, { headers: { 'X-Admin-Token': '', 'cf-connecting-ip': freshIp() } }, unset)

    expect(res.status).toBe(401)
    expect((await errorOf(res)).code).toBe('ADMIN_TOKEN_INVALID')
  })

  it('checks the token before it reads the body: no token and an empty form is 401, and the right token and an empty form is 400', async () => {
    const without = await fetchWorker(IMPORT_URL, { method: 'POST', body: new FormData(), headers: { 'cf-connecting-ip': freshIp() } })
    const withToken = await fetchWorker(IMPORT_URL, { method: 'POST', body: new FormData(), headers: adminHeaders() })

    expect(without.status).toBe(401)
    expect(withToken.status).toBe(400)
  })

  it('writes nothing when the token is refused', async () => {
    const before = await counts()
    const live = await exportLive()

    const res = await importRaw({ workbook: live.workbook, baseVersion: live.catalogVersion, dryRun: false, file: xlsxBytes('refused'), headers: { 'cf-connecting-ip': freshIp() } })

    expect(res.status).toBe(401)
    expect(await counts()).toEqual(before)
  })
})

describe('the admin rate limit', () => {
  // The limiter is ADMIN_IP_LIMITER, 10 a minute per address, and it runs before the token is checked: wrong guesses use up the allowance, and
  // once it is gone even the right token is turned away. Another address has an allowance of its own.
  const LIMIT = 10

  it('allows 10 requests a minute from one address, whatever the token, and then answers 429 RATE_LIMITED with Retry-After, even to the correct token; another address is unaffected', async () => {
    const outcome = await inOneRateWindow(
      async () => {
        const ip = freshIp()
        const other = freshIp()
        const first: number[] = []
        for (let i = 0; i < LIMIT; i++) first.push((await fetchWorker(EXPORT_URL, { headers: { 'cf-connecting-ip': ip, 'X-Admin-Token': 'wrong-guess' } })).status)
        const over = await fetchWorker(EXPORT_URL, { headers: { 'cf-connecting-ip': ip, 'X-Admin-Token': ADMIN_TOKEN } })
        const elsewhere = await fetchWorker(EXPORT_URL, { headers: { 'cf-connecting-ip': other, 'X-Admin-Token': ADMIN_TOKEN } })
        return { first, over, elsewhere }
      },
      { needMs: BURST_NEEDS_MS },
    )

    expect(outcome.first).toEqual(Array(LIMIT).fill(401))
    expect(outcome.over.status).toBe(429)
    expect((await errorOf(outcome.over)).code).toBe('RATE_LIMITED')
    expect(outcome.over.headers.get('Retry-After')).toBe('60')
    expect(outcome.elsewhere.status).toBe(200)
  }, RATE_TEST_TIMEOUT_MS)

  it('counts the import as well as the export against the same address', async () => {
    const outcome = await inOneRateWindow(
      async () => {
        const ip = freshIp()
        for (let i = 0; i < LIMIT; i++) await fetchWorker(EXPORT_URL, { headers: { 'cf-connecting-ip': ip, 'X-Admin-Token': ADMIN_TOKEN } })
        return importRaw({ workbook: '{}', baseVersion: 1, headers: { 'cf-connecting-ip': ip, 'X-Admin-Token': ADMIN_TOKEN } })
      },
      { needMs: BURST_NEEDS_MS },
    )

    expect(outcome.status).toBe(429)
  }, RATE_TEST_TIMEOUT_MS)
})
