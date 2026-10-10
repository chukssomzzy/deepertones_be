import { beforeEach, describe, expect, it } from 'vitest'
import { RateLimitedError, UnavailableError, ValidationError } from '../../lib/errors'
import { parsePhoneNumber } from '../../lib/phone'
import { MemoryOtpDelivery } from '../../providers/otp-delivery/memory.otp-delivery'
import { OtpDeliveryError } from '../../providers/otp-delivery/otp-delivery.provider'
import { FakeOtpRepository } from './otp.repository.fake'
import { otpRepositoryContract } from './otp.repository.contract'
import { OTP_POLICY, OtpService } from './otp.service'

otpRepositoryContract('fake', () => new FakeOtpRepository())

const T0 = new Date('2030-06-15T12:00:00.000Z')
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

const LOCAL = '0803 123 4567'
const E164 = '+2348031234567'
const PHONE = parsePhoneNumber(E164)
const OTHER_PHONE = '+447911123456'
const CODE = '482913'
const WRONG = '000000'
const PEPPER = 'test-pepper'

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error as Error & { code?: string; details?: Record<string, unknown> }
  }
  throw new Error('expected the promise to reject')
}

describe('OTP_POLICY', () => {
  it('is the agreed policy', () => {
    expect(OTP_POLICY).toEqual({ length: 6, ttlMinutes: 10, maxAttempts: 5, cooldownSeconds: 60, maxSendsPerHour: 5 })
  })
})

describe('OtpService', () => {
  let now: Date
  let codes: string[]
  let repository: FakeOtpRepository
  let delivery: MemoryOtpDelivery
  let service: OtpService

  const at = (msAfterT0: number) => {
    now = new Date(T0.getTime() + msAfterT0)
  }
  const build = (pepper = PEPPER) =>
    new OtpService({
      repository,
      delivery,
      pepper,
      now: () => now,
      generateCode: () => codes.shift() ?? CODE,
      newId: () => crypto.randomUUID(),
    })

  beforeEach(() => {
    now = T0
    codes = []
    repository = new FakeOtpRepository()
    delivery = new MemoryOtpDelivery()
    service = build()
  })

  describe('send', () => {
    it('delivers the generated code to the canonical phone and returns the expiry ten minutes out', async () => {
      const result = await service.send(LOCAL)

      expect(result).toEqual({ expiresAt: new Date(T0.getTime() + 10 * MINUTE) })
      expect(delivery.sent).toEqual([{ to: PHONE, code: CODE }])
    })

    it('stores a hash of the code, never the code itself', async () => {
      await service.send(LOCAL)

      const stored = await repository.findLatest(PHONE)
      expect(stored!.codeHash).not.toBe(CODE)
      expect(stored!.codeHash).not.toContain(CODE)
      expect(stored!.createdAt).toEqual(T0)
      expect(stored!.expiresAt).toEqual(new Date(T0.getTime() + 10 * MINUTE))
      expect(stored!.attempts).toBe(0)
      expect(stored!.consumedAt).toBeNull()
    })

    it('hashes the same code differently per phone and per pepper', async () => {
      await service.send(E164)
      await service.send(OTHER_PHONE)
      const other = new FakeOtpRepository()
      await new OtpService({ repository: other, delivery, pepper: 'another-pepper', now: () => now, generateCode: () => CODE }).send(E164)

      const a = (await repository.findLatest(PHONE))!.codeHash
      const b = (await repository.findLatest(parsePhoneNumber(OTHER_PHONE)))!.codeHash
      const c = (await other.findLatest(PHONE))!.codeHash
      expect(new Set([a, b, c]).size).toBe(3)
    })

    it('uses a real random six digit code by default', async () => {
      const real = new OtpService({ repository, delivery, pepper: PEPPER })

      const { expiresAt } = await real.send(E164)

      expect(delivery.lastCodeFor(PHONE)).toMatch(/^\d{6}$/)
      expect(expiresAt.getTime()).toBeGreaterThan(Date.now())
    })

    it('rejects an invalid phone with INVALID_PHONE and sends nothing', async () => {
      const error = await errorOf(service.send('abc'))

      expect(error).toBeInstanceOf(ValidationError)
      expect(error).toMatchObject({ code: 'INVALID_PHONE' })
      expect(delivery.sent).toEqual([])
    })

    it('refuses a resend inside the cooldown and reports the seconds remaining', async () => {
      await service.send(LOCAL)
      at(15 * SECOND)

      const error = await errorOf(service.send(LOCAL))

      expect(error).toBeInstanceOf(RateLimitedError)
      expect(error).toMatchObject({ code: 'OTP_COOLDOWN', details: { retryAfterSeconds: 45 } })
      expect(delivery.sent).toHaveLength(1)
    })

    it('rounds the remaining cooldown up to a whole second', async () => {
      await service.send(LOCAL)
      at(14_500)

      expect(await errorOf(service.send(LOCAL))).toMatchObject({ code: 'OTP_COOLDOWN', details: { retryAfterSeconds: 46 } })
    })

    it('still refuses one millisecond before the cooldown ends', async () => {
      await service.send(LOCAL)
      at(60 * SECOND - 1)

      expect(await errorOf(service.send(LOCAL))).toMatchObject({ code: 'OTP_COOLDOWN', details: { retryAfterSeconds: 1 } })
    })

    it('allows a resend exactly 60 seconds after the last send', async () => {
      await service.send(LOCAL)
      at(60 * SECOND)

      await expect(service.send(LOCAL)).resolves.toEqual({ expiresAt: new Date(T0.getTime() + 60 * SECOND + 10 * MINUTE) })
      expect(delivery.sent).toHaveLength(2)
    })

    it('does not apply the cooldown across different phones', async () => {
      await service.send(E164)

      await expect(service.send(OTHER_PHONE)).resolves.toBeDefined()
    })

    describe('hourly cap', () => {
      const sendFiveAtOneMinuteSpacing = async () => {
        for (let i = 0; i < OTP_POLICY.maxSendsPerHour; i++) {
          at(i * MINUTE)
          await service.send(LOCAL)
        }
      }

      it('refuses a sixth send in the hour with the seconds until the oldest leaves the window', async () => {
        await sendFiveAtOneMinuteSpacing()
        at(5 * MINUTE)

        const error = await errorOf(service.send(LOCAL))

        expect(error).toBeInstanceOf(RateLimitedError)
        expect(error).toMatchObject({ code: 'OTP_SEND_LIMIT', details: { retryAfterSeconds: 55 * 60 } })
        expect(delivery.sent).toHaveLength(5)
      })

      it('rounds the wait up to a whole second', async () => {
        await sendFiveAtOneMinuteSpacing()
        at(5 * MINUTE + 500)

        expect(await errorOf(service.send(LOCAL))).toMatchObject({
          code: 'OTP_SEND_LIMIT',
          details: { retryAfterSeconds: 55 * 60 },
        })
      })

      it('reports one second left just before the oldest send leaves the window', async () => {
        await sendFiveAtOneMinuteSpacing()
        at(HOUR - SECOND)

        expect(await errorOf(service.send(LOCAL))).toMatchObject({
          code: 'OTP_SEND_LIMIT',
          details: { retryAfterSeconds: 1 },
        })
      })

      it('allows a send once the oldest has left the window, so the window rolls', async () => {
        await sendFiveAtOneMinuteSpacing()
        at(HOUR + SECOND)

        await expect(service.send(LOCAL)).resolves.toBeDefined()
        expect(delivery.sent).toHaveLength(6)
      })

      it('reports the cooldown, not the cap, when the last send is also recent', async () => {
        await sendFiveAtOneMinuteSpacing()
        at(4 * MINUTE + 10 * SECOND)

        expect(await errorOf(service.send(LOCAL))).toMatchObject({
          code: 'OTP_COOLDOWN',
          details: { retryAfterSeconds: 50 },
        })
      })

      it('counts sends per phone', async () => {
        await sendFiveAtOneMinuteSpacing()
        at(5 * MINUTE)

        await expect(service.send(OTHER_PHONE)).resolves.toBeDefined()
      })
    })

    describe('delivery failures', () => {
      it('maps an unavailable provider to a 503 domain error and stores nothing', async () => {
        delivery.failNextWith(new OtpDeliveryError('unavailable', 'meta is down'))

        const error = await errorOf(service.send(LOCAL))

        expect(error).toBeInstanceOf(UnavailableError)
        expect(error).toMatchObject({ code: 'OTP_DELIVERY_UNAVAILABLE' })
        expect(await repository.findLatest(PHONE)).toBeNull()
      })

      it('maps a rejected recipient to PHONE_NOT_REACHABLE and stores nothing', async () => {
        delivery.failNextWith(new OtpDeliveryError('recipient-rejected', 'not on whatsapp'))

        const error = await errorOf(service.send(LOCAL))

        expect(error).toBeInstanceOf(ValidationError)
        expect(error).toMatchObject({ code: 'PHONE_NOT_REACHABLE' })
        expect(await repository.findLatest(PHONE)).toBeNull()
      })

      it('lets any other error propagate unchanged and stores nothing', async () => {
        const failure = new Error('bad token')
        delivery.failNextWith(failure)

        expect(await errorOf(service.send(LOCAL))).toBe(failure)
        expect(await repository.findLatest(PHONE)).toBeNull()
      })

      it('does not start a cooldown or count toward the cap when delivery fails', async () => {
        for (let i = 0; i < OTP_POLICY.maxSendsPerHour + 1; i++) {
          delivery.failNextWith(new OtpDeliveryError('unavailable', 'down'))
          expect(await errorOf(service.send(LOCAL))).toMatchObject({ code: 'OTP_DELIVERY_UNAVAILABLE' })
        }

        await expect(service.send(LOCAL)).resolves.toBeDefined()
        expect(delivery.sent).toHaveLength(1)
      })
    })
  })

  describe('verify', () => {
    it('returns the canonical phone for the correct code', async () => {
      await service.send(LOCAL)

      expect(await service.verify(LOCAL, CODE)).toBe(PHONE)
    })

    it('rejects an invalid phone with INVALID_PHONE', async () => {
      const error = await errorOf(service.verify('abc', CODE))

      expect(error).toBeInstanceOf(ValidationError)
      expect(error).toMatchObject({ code: 'INVALID_PHONE' })
    })

    it('treats a phone with no challenge as expired', async () => {
      const error = await errorOf(service.verify(LOCAL, CODE))

      expect(error).toBeInstanceOf(ValidationError)
      expect(error).toMatchObject({ code: 'OTP_EXPIRED' })
    })

    it('accepts a different format of the same number than the one sent to', async () => {
      await service.send(LOCAL)

      expect(await service.verify(E164, CODE)).toBe(PHONE)
    })

    it('works only once: a second verify with the same code is expired', async () => {
      await service.send(LOCAL)
      await service.verify(LOCAL, CODE)

      const error = await errorOf(service.verify(LOCAL, CODE))

      expect(error).toBeInstanceOf(ValidationError)
      expect(error).toMatchObject({ code: 'OTP_EXPIRED' })
    })

    it('accepts the code one millisecond before it expires', async () => {
      await service.send(LOCAL)
      at(10 * MINUTE - 1)

      expect(await service.verify(LOCAL, CODE)).toBe(PHONE)
    })

    it('rejects the code exactly when it expires', async () => {
      await service.send(LOCAL)
      at(10 * MINUTE)

      const error = await errorOf(service.verify(LOCAL, CODE))

      expect(error).toBeInstanceOf(ValidationError)
      expect(error).toMatchObject({ code: 'OTP_EXPIRED' })
    })

    it('counts down the attempts remaining on each wrong code', async () => {
      await service.send(LOCAL)

      for (const attemptsRemaining of [4, 3, 2, 1]) {
        const error = await errorOf(service.verify(LOCAL, WRONG))
        expect(error).toBeInstanceOf(ValidationError)
        expect(error).toMatchObject({ code: 'OTP_INVALID', details: { attemptsRemaining } })
      }
    })

    it('still accepts the correct code after four wrong tries', async () => {
      await service.send(LOCAL)
      for (let i = 0; i < 4; i++) await errorOf(service.verify(LOCAL, WRONG))

      expect(await service.verify(LOCAL, CODE)).toBe(PHONE)
    })

    it('kills the code on the fifth wrong try, which itself is rate limited without a retry hint', async () => {
      await service.send(LOCAL)
      for (let i = 0; i < 4; i++) await errorOf(service.verify(LOCAL, WRONG))

      const error = await errorOf(service.verify(LOCAL, WRONG))

      expect(error).toBeInstanceOf(RateLimitedError)
      expect(error).toMatchObject({ code: 'OTP_TOO_MANY_ATTEMPTS' })
      expect((error.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds).toBeUndefined()
    })

    it('rejects even the correct code once the attempts are used up', async () => {
      await service.send(LOCAL)
      for (let i = 0; i < 5; i++) await errorOf(service.verify(LOCAL, WRONG))

      const error = await errorOf(service.verify(LOCAL, CODE))

      expect(error).toBeInstanceOf(RateLimitedError)
      expect(error).toMatchObject({ code: 'OTP_TOO_MANY_ATTEMPTS' })
    })

    it('reports expired rather than too many attempts once a locked code has also expired', async () => {
      await service.send(LOCAL)
      for (let i = 0; i < 5; i++) await errorOf(service.verify(LOCAL, WRONG))
      at(10 * MINUTE)

      expect(await errorOf(service.verify(LOCAL, CODE))).toMatchObject({ code: 'OTP_EXPIRED' })
    })

    it('a new send supersedes the old code, which stops verifying', async () => {
      const first = '111111'
      const second = '222222'
      codes.push(first, second)
      await service.send(LOCAL)
      at(60 * SECOND)
      await service.send(LOCAL)

      expect(await errorOf(service.verify(LOCAL, first))).toMatchObject({ code: 'OTP_INVALID' })
      expect(await service.verify(LOCAL, second)).toBe(PHONE)
    })

    it('does not accept the code sent to one phone for another', async () => {
      codes.push('111111', '222222')
      await service.send(E164)
      await service.send(OTHER_PHONE)

      expect(await errorOf(service.verify(OTHER_PHONE, '111111'))).toMatchObject({ code: 'OTP_INVALID' })
      expect(await service.verify(OTHER_PHONE, '222222')).toBe(parsePhoneNumber(OTHER_PHONE))
    })

    it('reports too many attempts when the attempts run out between the read and the consume', async () => {
      class RacedByWrongGuesses extends FakeOtpRepository {
        override async consume(id: string, at: Date, maxAttempts: number) {
          for (let i = 0; i < maxAttempts; i++) await this.recordFailedAttempt(id, maxAttempts)
          return super.consume(id, at, maxAttempts)
        }
      }
      repository = new RacedByWrongGuesses()
      service = build()
      await service.send(LOCAL)

      const error = await errorOf(service.verify(LOCAL, CODE))

      expect(error).toBeInstanceOf(RateLimitedError)
      expect(error).toMatchObject({ code: 'OTP_TOO_MANY_ATTEMPTS' })
    })

    it('reports expired when the consume is refused for any other reason', async () => {
      class RefusesConsume extends FakeOtpRepository {
        override async consume() {
          return false
        }
      }
      repository = new RefusesConsume()
      service = build()
      await service.send(LOCAL)

      const error = await errorOf(service.verify(LOCAL, CODE))

      expect(error).toBeInstanceOf(ValidationError)
      expect(error).toMatchObject({ code: 'OTP_EXPIRED' })
    })

    it('does not accept the same code under a different pepper', async () => {
      await service.send(LOCAL)

      expect(await errorOf(build('another-pepper').verify(LOCAL, CODE))).toMatchObject({ code: 'OTP_INVALID' })
    })
  })
})
