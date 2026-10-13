import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createDb } from '../../src/lib/db'
import { parsePhoneNumber } from '../../src/lib/phone'
import { D1OtpRepository } from '../../src/modules/otp/otp.repository'
import { OTP_POLICY, OtpService } from '../../src/modules/otp/otp.service'
import { MemoryJobQueue } from '../../src/providers/job-queue/memory.job-queue'
import { MemoryOtpDelivery } from '../../src/providers/otp-delivery/memory.otp-delivery'

const T0 = new Date('2030-06-15T12:00:00.000Z')
const CODE = '482913'
const WRONG = '000000'

describe('OtpService against D1 under concurrency', () => {
  it('never lets a correct code be consumed on a challenge whose attempts are used up', async () => {
    const repository = new D1OtpRepository(createDb(env.DB))
    const service = new OtpService({
      repository,
      delivery: new MemoryOtpDelivery(),
      jobs: new MemoryJobQueue(),
      pepper: 'test-pepper',
      now: () => T0,
      generateCode: () => CODE,
    })
    const phone = '+23480' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0')
    await service.send(phone)

    const results = await Promise.allSettled([
      ...Array.from({ length: 30 }, () => service.verify(phone, WRONG)),
      service.verify(phone, CODE),
    ])

    const row = await repository.findLatest(parsePhoneNumber(phone))
    expect(row!.attempts).toBeLessThanOrEqual(OTP_POLICY.maxAttempts)
    expect(row!.attempts >= OTP_POLICY.maxAttempts && row!.consumedAt !== null).toBe(false)
    const succeeded = results.filter((r) => r.status === 'fulfilled')
    expect(succeeded.length === 0 || row!.consumedAt !== null).toBe(true)
    expect(succeeded.length).toBeLessThanOrEqual(1)
  })
})
