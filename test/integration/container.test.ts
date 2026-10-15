import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { buildContainer } from '../../src/container'
import { TokenService } from '../../src/modules/auth/tokens.service'
import { OtpService } from '../../src/modules/otp/otp.service'

describe('buildContainer', () => {
  it('builds the OTP service from the environment bindings', () => {
    expect(env.OTP_PEPPER).toBeTruthy()
    expect(env.WHATSAPP_ACCESS_TOKEN).toBeTruthy()
    expect(env.ZEPTOMAIL_API_KEY).toBeTruthy()

    expect(buildContainer(env).otp).toBeInstanceOf(OtpService)
  })

  it('builds the token service from JWT_SECRET, accepting tokens signed with JWT_SECRET_PREVIOUS', async () => {
    expect(env.JWT_SECRET).toBeTruthy()
    const tokens = buildContainer(env).tokens
    expect(tokens).toBeInstanceOf(TokenService)

    const { accessToken } = await tokens.issue({ id: 'u_1', status: 'anonymous', tokenVersion: 0 })
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
})
