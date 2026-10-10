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
})
