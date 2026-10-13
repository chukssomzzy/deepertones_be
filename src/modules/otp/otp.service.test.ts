import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PermanentJobError } from '../../jobs/job'
import { NotFoundError, RateLimitedError, UnavailableError, ValidationError } from '../../lib/errors'
import { parsePhoneNumber } from '../../lib/phone'
import { MemoryJobQueue } from '../../providers/job-queue/memory.job-queue'
import { MemoryOtpDelivery } from '../../providers/otp-delivery/memory.otp-delivery'
import { OtpDeliveryError } from '../../providers/otp-delivery/otp-delivery.provider'
import { deliverOtpSpec } from './otp.job-specs'
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
  let jobs: MemoryJobQueue
  let service: OtpService

  const lastBody = () => jobs.enqueued.at(-1)!.body as { challengeId: string; sealedCode: string }
  const at = (msAfterT0: number) => {
    now = new Date(T0.getTime() + msAfterT0)
  }
  const build = (pepper = PEPPER) =>
    new OtpService({
      repository,
      delivery,
      jobs,
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
    jobs = new MemoryJobQueue()
    service = build()
  })

  describe('send', () => {
    it('returns the challenge id and the expiry ten minutes out, and stores the challenge as queued', async () => {
      const result = await service.send(LOCAL)

      expect(result).toEqual({ challengeId: expect.any(String), expiresAt: new Date(T0.getTime() + 10 * MINUTE) })
      expect(await repository.findById(result.challengeId)).toMatchObject({ phone: PHONE, deliveryStatus: 'queued' })
    })

    it('enqueues exactly one delivery job carrying no phone number, and does not call the provider', async () => {
      const { challengeId } = await service.send(LOCAL)

      expect(jobs.enqueued).toEqual([
        { job: deliverOtpSpec.name, body: { challengeId, sealedCode: expect.any(String) } },
      ])
      expect(delivery.sent).toEqual([])
      expect(JSON.stringify(jobs.enqueued)).not.toContain('8031234567')
    })

    it('keeps the plain code out of the queued message', async () => {
      await service.send(LOCAL)

      expect(JSON.stringify(jobs.enqueued)).not.toContain(CODE)
    })

    it('marks the challenge failed and answers 503 when the job cannot be enqueued', async () => {
      class DownQueue extends MemoryJobQueue {
        override async enqueue(): Promise<void> {
          throw new Error('queue is down')
        }
      }
      jobs = new DownQueue()
      service = build()

      const error = await errorOf(service.send(LOCAL))

      expect(error).toBeInstanceOf(UnavailableError)
      expect(error).toMatchObject({ code: 'OTP_DELIVERY_UNAVAILABLE' })
      expect((await repository.findLatest(PHONE))).toMatchObject({ deliveryStatus: 'failed', failureReason: 'unavailable' })
    })

    it('logs an enqueue failure as enqueue-failed, without the code', async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      class DownQueue extends MemoryJobQueue {
        override async enqueue(): Promise<void> {
          throw new Error('queue is down')
        }
      }
      jobs = new DownQueue()
      service = build()

      await errorOf(service.send(LOCAL))

      expect(log).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'enqueue-failed' }))
      expect(JSON.stringify(log.mock.calls)).not.toContain(CODE)
      log.mockRestore()
    })

    it('does not count enqueue failures toward the cooldown or the hourly cap', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      class DownQueue extends MemoryJobQueue {
        override async enqueue(): Promise<void> {
          throw new Error('queue is down')
        }
      }
      jobs = new DownQueue()
      service = build()
      for (let i = 0; i < OTP_POLICY.maxSendsPerHour + 1; i++) {
        expect(await errorOf(service.send(LOCAL))).toMatchObject({ code: 'OTP_DELIVERY_UNAVAILABLE' })
      }
      jobs = new MemoryJobQueue()
      service = build()

      await expect(service.send(LOCAL)).resolves.toBeDefined()
      vi.restoreAllMocks()
    })

    it('does not count a challenge that failed as unavailable toward the cooldown', async () => {
      const { challengeId } = await service.send(LOCAL)
      await service.markUndeliverable(challengeId)

      await expect(service.send(LOCAL)).resolves.toBeDefined()
    })

    it('counts a challenge whose recipient was rejected toward the cooldown', async () => {
      const { challengeId } = await service.send(LOCAL)
      delivery.failNextWith(new OtpDeliveryError('recipient-rejected', 'no'))
      await errorOf(service.deliver(lastBody()))
      expect((await repository.findById(challengeId))!.failureReason).toBe('recipient-rejected')
      at(15 * SECOND)

      expect(await errorOf(service.send(LOCAL))).toMatchObject({ code: 'OTP_COOLDOWN', details: { retryAfterSeconds: 45 } })
    })

    it('counts challenges whose recipient was rejected toward the hourly cap', async () => {
      for (let i = 0; i < OTP_POLICY.maxSendsPerHour; i++) {
        at(i * MINUTE)
        await service.send(LOCAL)
        delivery.failNextWith(new OtpDeliveryError('recipient-rejected', 'no'))
        await errorOf(service.deliver(lastBody()))
      }
      at(5 * MINUTE)

      expect(await errorOf(service.send(LOCAL))).toMatchObject({ code: 'OTP_SEND_LIMIT' })
    })

    it('hashes the same code differently per phone and per pepper', async () => {
      await service.send(E164)
      await service.send(OTHER_PHONE)
      const other = new FakeOtpRepository()
      await new OtpService({ repository: other, delivery, jobs, pepper: 'another-pepper', now: () => now, generateCode: () => CODE }).send(E164)

      const a = (await repository.findLatest(PHONE))!.codeHash
      const b = (await repository.findLatest(parsePhoneNumber(OTHER_PHONE)))!.codeHash
      const c = (await other.findLatest(PHONE))!.codeHash
      expect(new Set([a, b, c]).size).toBe(3)
    })

    it('uses a real random six digit code by default', async () => {
      const real = new OtpService({ repository, delivery, jobs, pepper: PEPPER })

      const { expiresAt } = await real.send(E164)
      await real.deliver(lastBody())

      expect(delivery.lastCodeFor(PHONE)).toMatch(/^\d{6}$/)
      expect(expiresAt.getTime()).toBeGreaterThan(Date.now())
    })

    it('rejects an invalid phone with INVALID_PHONE and enqueues nothing', async () => {
      const error = await errorOf(service.send('abc'))

      expect(error).toBeInstanceOf(ValidationError)
      expect(error).toMatchObject({ code: 'INVALID_PHONE' })
      expect(jobs.enqueued).toEqual([])
    })

    it('refuses a resend inside the cooldown and reports the seconds remaining', async () => {
      await service.send(LOCAL)
      at(15 * SECOND)

      const error = await errorOf(service.send(LOCAL))

      expect(error).toBeInstanceOf(RateLimitedError)
      expect(error).toMatchObject({ code: 'OTP_COOLDOWN', details: { retryAfterSeconds: 45 } })
      expect(jobs.enqueued).toHaveLength(1)
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

      await expect(service.send(LOCAL)).resolves.toEqual({
        challengeId: expect.any(String),
        expiresAt: new Date(T0.getTime() + 60 * SECOND + 10 * MINUTE),
      })
      expect(jobs.enqueued).toHaveLength(2)
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
        expect(jobs.enqueued).toHaveLength(5)
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
        expect(jobs.enqueued).toHaveLength(6)
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
  })

  describe('deliver', () => {
    it('sends the code to the phone and marks the challenge delivered', async () => {
      const { challengeId } = await service.send(LOCAL)

      await service.deliver(lastBody())

      expect(delivery.sent).toEqual([{ to: PHONE, code: CODE }])
      expect(await service.deliveryStatus(challengeId)).toEqual({ status: 'delivered', failureReason: null })
    })

    it('delivers the very code that verify accepts', async () => {
      codes.push('135790')
      await service.send(LOCAL)

      await service.deliver(lastBody())

      expect(delivery.lastCodeFor(PHONE)).toBe('135790')
      expect(await service.verify(LOCAL, delivery.lastCodeFor(PHONE)!)).toBe(PHONE)
    })

    it('lets verify succeed while delivery is still queued', async () => {
      const { challengeId } = await service.send(LOCAL)

      expect(await service.verify(LOCAL, CODE)).toBe(PHONE)
      expect((await service.deliveryStatus(challengeId)).status).toBe('queued')
    })

    it('drops a message whose challenge was superseded by a newer send', async () => {
      await service.send(LOCAL)
      const stale = lastBody()
      at(60 * SECOND)
      await service.send(LOCAL)

      await expect(service.deliver(stale)).resolves.toBeUndefined()

      expect(delivery.sent).toEqual([])
    })

    it('drops a message whose challenge has expired', async () => {
      await service.send(LOCAL)
      at(10 * MINUTE)

      await expect(service.deliver(lastBody())).resolves.toBeUndefined()

      expect(delivery.sent).toEqual([])
    })

    it('drops a message whose challenge was already used', async () => {
      await service.send(LOCAL)
      await service.verify(LOCAL, CODE)

      await expect(service.deliver(lastBody())).resolves.toBeUndefined()

      expect(delivery.sent).toEqual([])
    })

    it('drops a repeat of a message already delivered, without sending again', async () => {
      await service.send(LOCAL)
      await service.deliver(lastBody())

      await expect(service.deliver(lastBody())).resolves.toBeUndefined()

      expect(delivery.sent).toHaveLength(1)
    })

    it('drops a message for a challenge that does not exist', async () => {
      await service.send(LOCAL)
      const body = lastBody()

      await expect(service.deliver({ ...body, challengeId: crypto.randomUUID() })).resolves.toBeUndefined()

      expect(delivery.sent).toEqual([])
    })

    it('drops a message whose challenge already failed', async () => {
      const { challengeId } = await service.send(LOCAL)
      await service.markUndeliverable(challengeId)

      await expect(service.deliver(lastBody())).resolves.toBeUndefined()

      expect(delivery.sent).toEqual([])
    })

    it('fails a rejected recipient permanently and records why', async () => {
      const { challengeId } = await service.send(LOCAL)
      delivery.failNextWith(new OtpDeliveryError('recipient-rejected', 'not on whatsapp'))

      expect(await errorOf(service.deliver(lastBody()))).toBeInstanceOf(PermanentJobError)

      expect(await service.deliveryStatus(challengeId)).toEqual({ status: 'failed', failureReason: 'recipient-rejected' })
    })

    it.each([
      ['an unavailable provider', new OtpDeliveryError('unavailable', 'meta is down')],
      ['an unexpected error', new Error('bad token')],
    ])('rethrows %s unchanged and leaves the challenge queued so it can be retried', async (_label, failure) => {
      const { challengeId } = await service.send(LOCAL)
      delivery.failNextWith(failure)

      expect(await errorOf(service.deliver(lastBody()))).toBe(failure)
      expect((await service.deliveryStatus(challengeId)).status).toBe('queued')

      await service.deliver(lastBody())
      expect((await service.deliveryStatus(challengeId)).status).toBe('delivered')
      expect(delivery.sent).toEqual([{ to: PHONE, code: CODE }])
    })

    it('fails permanently and sends nothing when the sealed code was tampered with', async () => {
      await service.send(LOCAL)
      const body = lastBody()
      const i = 10
      const tampered = body.sealedCode.slice(0, i) + (body.sealedCode[i] === 'A' ? 'B' : 'A') + body.sealedCode.slice(i + 1)

      expect(await errorOf(service.deliver({ ...body, sealedCode: tampered }))).toBeInstanceOf(PermanentJobError)
      expect(delivery.sent).toEqual([])
    })

    it('fails permanently and sends nothing when the sealed code belongs to another challenge', async () => {
      await service.send(E164)
      const first = lastBody()
      await service.send(OTHER_PHONE)
      const second = lastBody()

      expect(await errorOf(service.deliver({ ...second, sealedCode: first.sealedCode }))).toBeInstanceOf(PermanentJobError)
      expect(delivery.sent).toEqual([])
    })
  })

  describe('markUndeliverable', () => {
    it('fails a queued challenge as unavailable', async () => {
      const { challengeId } = await service.send(LOCAL)

      await service.markUndeliverable(challengeId)

      expect(await service.deliveryStatus(challengeId)).toEqual({ status: 'failed', failureReason: 'unavailable' })
    })

    it('leaves a delivered challenge delivered', async () => {
      const { challengeId } = await service.send(LOCAL)
      await service.deliver(lastBody())

      await service.markUndeliverable(challengeId)

      expect(await service.deliveryStatus(challengeId)).toEqual({ status: 'delivered', failureReason: null })
    })
  })

  describe('deliveryStatus', () => {
    it('reports queued right after send', async () => {
      const { challengeId } = await service.send(LOCAL)

      expect(await service.deliveryStatus(challengeId)).toEqual({ status: 'queued', failureReason: null })
    })

    it('answers OTP_CHALLENGE_NOT_FOUND for an unknown challenge', async () => {
      const error = await errorOf(service.deliveryStatus(crypto.randomUUID()))

      expect(error).toBeInstanceOf(NotFoundError)
      expect(error).toMatchObject({ code: 'OTP_CHALLENGE_NOT_FOUND' })
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
