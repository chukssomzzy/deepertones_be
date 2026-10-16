import { env } from 'cloudflare:workers'
import { describe, expect, it } from 'vitest'
import { createDb } from '../../src/lib/db'
import { parseEmailAddress } from '../../src/lib/email-address'
import { parsePhoneNumber } from '../../src/lib/phone'
import { D1OtpRepository } from '../../src/modules/otp/otp.repository'
import { OTP_POLICY, OtpService } from '../../src/modules/otp/otp.service'
import type { OtpChannel, OtpRecipient } from '../../src/modules/otp/otp.types'
import { MemoryEmailSender } from '../../src/providers/email/memory.email'
import { MemoryJobQueue } from '../../src/providers/job-queue/memory.job-queue'
import { MemoryOtpDelivery } from '../../src/providers/otp-delivery/memory.otp-delivery'

const T0 = new Date('2030-06-15T12:00:00.000Z')
const CODE = '4829'
const WRONG = '0000'

const fresh = {
  whatsapp: () => '+23480' + String(Math.floor(Math.random() * 1e8)).padStart(8, '0'),
  email: () => `race-${crypto.randomUUID()}@example.com`,
} satisfies Record<OtpChannel, () => string>
const canonical = {
  whatsapp: (raw: string) => ({ channel: 'whatsapp', address: parsePhoneNumber(raw) }) as OtpRecipient,
  email: (raw: string) => ({ channel: 'email', address: parseEmailAddress(raw) }) as OtpRecipient,
}

describe('OtpService against D1 under concurrency', () => {
  it.each(['whatsapp', 'email'] as const)(
    'never lets a correct code be consumed on a challenge whose attempts are used up (%s)',
    async (channel) => {
      const repository = new D1OtpRepository(createDb(env.DB))
      const service = new OtpService({
        repository,
        whatsapp: new MemoryOtpDelivery(),
        email: new MemoryEmailSender(),
        channels: ['email', 'whatsapp'],
        jobs: new MemoryJobQueue(),
        pepper: 'test-pepper',
        now: () => T0,
        generateCode: () => CODE,
      })
      const address = fresh[channel]()
      await service.send({ channel, address })

      const results = await Promise.allSettled([
        ...Array.from({ length: 30 }, () => service.verify({ channel, address }, WRONG)),
        service.verify({ channel, address }, CODE),
      ])

      const row = await repository.findLatest(canonical[channel](address))
      expect(row!.attempts).toBeLessThanOrEqual(OTP_POLICY.maxAttempts)
      expect(row!.attempts >= OTP_POLICY.maxAttempts && row!.consumedAt !== null).toBe(false)
      const succeeded = results.filter((r) => r.status === 'fulfilled')
      expect(succeeded.length === 0 || row!.consumedAt !== null).toBe(true)
      expect(succeeded.length).toBeLessThanOrEqual(1)
    },
  )
})
