import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { buildContainer } from '../../src/container'
import { runAs } from '../../src/lib/context'
import { createDb } from '../../src/lib/db'
import { TokenService } from '../../src/modules/auth/tokens.service'
import { AiUsageService } from '../../src/modules/ai-usage/ai-usage.service'
import { ProductCatalogService } from '../../src/modules/catalog/catalog.service'
import { OtpService } from '../../src/modules/otp/otp.service'
import { jpegPhoto } from '../../src/modules/scans/scans.photos.fake'
import { ScanService } from '../../src/modules/scans/scans.service'
import { D1UsersRepository } from '../../src/modules/users/users.repository'

describe('buildContainer', () => {
  it('builds the OTP service from the environment bindings', () => {
    expect(env.OTP_PEPPER).toBeTruthy()
    expect(env.WHATSAPP_ACCESS_TOKEN).toBeTruthy()
    expect(env.ZEPTOMAIL_API_KEY).toBeTruthy()

    expect(buildContainer(env).otp).toBeInstanceOf(OtpService)
  })

  it('builds the product catalog service from the environment bindings', () => {
    expect(env.ANTHROPIC_API_KEY).toBeTruthy()

    expect(buildContainer(env).catalog).toBeInstanceOf(ProductCatalogService)
  })

  it('builds the AI usage ledger from the environment bindings', () => {
    expect(buildContainer(env).aiUsage).toBeInstanceOf(AiUsageService)
  })

  // The price is read when a Perfect Corp call is recorded, not when the ledger is built: the same ledger serves every Claude call.
  it.each(['not-a-number', '', '0', '-0.05'])('builds the container and keeps the Claude ledger working with PERFECT_CORP_USD_PER_UNIT of "%s"; only recording a Perfect Corp call fails', async (price) => {
    const container = buildContainer({ ...env, PERFECT_CORP_USD_PER_UNIT: price })

    expect(container.aiUsage).toBeInstanceOf(AiUsageService)
    expect(container.catalog).toBeInstanceOf(ProductCatalogService)
    // Give the reservation back so the real day's spend in this database stays clean.
    const id = await container.aiUsage.reserve({ job: 'research', model: 'claude-sonnet-5-5', estimateMicros: 1 })
    await container.aiUsage.release(id)
    expect(id).toEqual(expect.any(String))
    await expect(container.aiUsage.record({ vendor: 'perfect-corp', job: 'face-analysis', units: 12, key: `container-${crypto.randomUUID()}` })).rejects.toThrow()
  })

  it('does not refuse a reservation past AI_DAILY_BUDGET_USD: the cap only alerts', async () => {
    const { aiUsage } = buildContainer({ ...env, AI_DAILY_BUDGET_USD: '1' })

    // One micro over a dollar, in an environment whose cap is a dollar. Give it back so the real day's spend in this database stays clean.
    const id = await aiUsage.reserve({ job: 'research', model: 'claude-sonnet-5-5', estimateMicros: 1_000_001 })
    await aiUsage.release(id)

    expect(id).toEqual(expect.any(String))
  })

  it('builds the token service from JWT_SECRET, accepting tokens signed with JWT_SECRET_PREVIOUS', async () => {
    expect(env.JWT_SECRET).toBeTruthy()
    const tokens = buildContainer(env).tokens
    expect(tokens).toBeInstanceOf(TokenService)

    const { accessToken } = await tokens.issue({ id: 'u_1', status: 'anonymous', tokenVersion: 0 }, 'p_1')
    expect(await tokens.verifyAccess(accessToken)).toMatchObject({ ok: true, userId: 'u_1' })

    const rotated = buildContainer({ ...env, JWT_SECRET: 'rotated-in', JWT_SECRET_PREVIOUS: env.JWT_SECRET }).tokens
    expect(await rotated.verifyAccess(accessToken)).toMatchObject({ ok: true })
    expect(await buildContainer({ ...env, JWT_SECRET: 'rotated-in' }).tokens.verifyAccess(accessToken)).toEqual({ ok: false, problem: 'invalid' })
  })

  it('sends an email code through the real queue binding and leaves the challenge queued', async () => {
    const otp = buildContainer(env).otp
    const address = `container-${crypto.randomUUID()}@example.com`

    const { challengeId } = await otp.send({ channel: 'email', address })

    expect(await otp.deliveryStatus(challengeId)).toEqual({ status: 'queued', failureReason: null })
  })

  it('refuses a WhatsApp send when OTP_CHANNELS enables only email', async () => {
    // Today's deployed config enables email only; WhatsApp switches on by adding it to OTP_CHANNELS.
    const enabled = buildContainer({ ...env, OTP_CHANNELS: 'email' })
    const phone = `+234806${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`

    await expect(enabled.otp.send({ channel: 'whatsapp', address: phone })).rejects.toMatchObject({ code: 'OTP_CHANNEL_UNAVAILABLE' })
  })

  it('sends a WhatsApp code through the real queue binding once OTP_CHANNELS includes whatsapp', async () => {
    const otp = buildContainer({ ...env, OTP_CHANNELS: 'email,whatsapp' }).otp
    const phone = `+234806${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`

    const { challengeId } = await otp.send({ channel: 'whatsapp', address: phone })

    expect(await otp.deliveryStatus(challengeId)).toEqual({ status: 'queued', failureReason: null })
  })

  it('builds the scan service from the environment bindings', () => {
    expect(buildContainer(env).scans).toBeInstanceOf(ScanService)
  })
})

describe('buildContainer guest cleanup', () => {
  // The one clock the fixtures hang off: ages are offsets from it.
  const NOW = Date.now()
  const DAY = 24 * 60 * 60 * 1000
  const photosOf = async (userId: string) => (await env.PRIVATE_PHOTOS.list({ prefix: `photos/${env.ENVIRONMENT}/${userId}/` })).objects

  it('removes a purged guest\'s scans and private photos, and leaves a recent guest\'s alone', async () => {
    const container = buildContainer(env)
    const users = new D1UsersRepository(createDb(env.DB))
    const salt = crypto.randomUUID()
    const longAgo = new Date(NOW - 120 * DAY)
    const guest = async (label: string, seenAt: Date) => {
      const id = crypto.randomUUID()
      await users.createGuestForDevice({ user: { id, createdAt: seenAt }, device: { deviceHash: `${label}-${salt}`, platform: 'ios' }, profile: { id: `profile-${id}` } })
      await users.touch(id, seenAt)
      await users.unlinkDevices(id)
      return id
    }
    const scanAs = (userId: string) =>
      runAs({ kind: 'user', userId, status: 'anonymous', profileId: `profile-${userId}` }, () => container.scans.create({ photos: [jpegPhoto()], clientIp: '203.0.113.9' }))
    const abandoned = await guest('abandoned', longAgo)
    const recent = await guest('recent', new Date(NOW - 10 * DAY))
    const abandonedScan = await scanAs(abandoned)
    const recentScan = await scanAs(recent)
    expect(await photosOf(abandoned)).toHaveLength(1)

    const { deleted } = await runAs({ kind: 'system', job: 'guest-cleanup' }, () => container.users.purgeUnreachableGuests())

    expect(deleted).toBeGreaterThanOrEqual(1)
    expect(await photosOf(abandoned)).toEqual([])
    await expect(runAs({ kind: 'user', userId: abandoned, status: 'anonymous', profileId: `profile-${abandoned}` }, () => container.scans.getScan(abandonedScan.id))).rejects.toMatchObject({ code: 'SCAN_NOT_FOUND' })
    expect(await photosOf(recent)).toHaveLength(1)
    await expect(runAs({ kind: 'user', userId: recent, status: 'anonymous', profileId: `profile-${recent}` }, () => container.scans.getScan(recentScan.id))).resolves.toMatchObject({ id: recentScan.id })
  })

  it('cleans up scans without building the catalog or the model clients: it works with the AI settings unusable', async () => {
    const users = new D1UsersRepository(createDb(env.DB))
    const id = crypto.randomUUID()
    const longAgo = new Date(NOW - 120 * DAY)
    await users.createGuestForDevice({ user: { id, createdAt: longAgo }, device: { deviceHash: `no-ai-${id}`, platform: 'ios' }, profile: { id: `profile-${id}` } })
    await users.touch(id, longAgo)
    await users.unlinkDevices(id)
    await runAs({ kind: 'user', userId: id, status: 'anonymous', profileId: `profile-${id}` }, () => buildContainer(env).scans.create({ photos: [jpegPhoto()], clientIp: '203.0.113.9' }))
    expect(await photosOf(id)).toHaveLength(1)
    // A budget that is not a number makes building the AI usage ledger throw, and the catalog, recogniser and label reader all sit behind it.
    const withoutAi = buildContainer({ ...env, AI_DAILY_BUDGET_USD: 'not-a-number' })

    await runAs({ kind: 'system', job: 'guest-cleanup' }, () => withoutAi.users.purgeUnreachableGuests())

    expect(await photosOf(id)).toEqual([])
  })
})
