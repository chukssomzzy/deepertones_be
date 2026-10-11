import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { buildContainer } from '../../src/container'
import { OtpService } from '../../src/modules/otp/otp.service'

describe('buildContainer', () => {
  it('builds the OTP service from the environment bindings', () => {
    expect(env.OTP_PEPPER).toBeTruthy()
    expect(env.WHATSAPP_ACCESS_TOKEN).toBeTruthy()

    expect(buildContainer(env).otp).toBeInstanceOf(OtpService)
  })

  it('sends a code through the real queue binding and leaves the challenge queued', async () => {
    const otp = buildContainer(env).otp
    const phone = `+234806${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`

    const { challengeId } = await otp.send(phone)

    expect(await otp.deliveryStatus(challengeId)).toEqual({ status: 'queued', failureReason: null })
  })
})
