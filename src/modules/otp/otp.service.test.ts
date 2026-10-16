import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PermanentJobError } from '../../jobs/job'
import { NotFoundError, RateLimitedError, UnavailableError, ValidationError } from '../../lib/errors'
import { renderEmail } from '../../emails/registry'
import { EmailDeliveryError } from '../../providers/email/email.provider'
import { MemoryEmailSender } from '../../providers/email/memory.email'
import { MemoryJobQueue } from '../../providers/job-queue/memory.job-queue'
import { MemoryOtpDelivery } from '../../providers/otp-delivery/memory.otp-delivery'
import { OtpDeliveryError } from '../../providers/otp-delivery/otp-delivery.provider'
import { deliverOtpSpec } from './otp.job-specs'
import { FakeOtpRepository } from './otp.repository.fake'
import { otpRepositoryContract } from './otp.repository.contract'
import { OTP_POLICY, OtpService, parseOtpChannels } from './otp.service'
import type { OtpChannel, OtpRecipient } from './otp.types'

otpRepositoryContract('fake', () => new FakeOtpRepository())

const T0 = new Date('2030-06-15T12:00:00.000Z')
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

const CODE = '482913'
const WRONG = '000000'
const PEPPER = 'test-pepper'

/** One row per channel: how a caller writes the address, its canonical form, another recipient, a second spelling of the same one, and an invalid one. */
const CHANNELS = [
  {
    channel: 'email',
    raw: ' Ada@Example.com ',
    canonical: 'ada@example.com',
    otherRaw: 'bob@example.com',
    otherCanonical: 'bob@example.com',
    respelled: 'ADA@EXAMPLE.COM',
    invalid: 'not-an-email',
    invalidCode: 'INVALID_EMAIL',
  },
  {
    channel: 'whatsapp',
    raw: '0803 123 4567',
    canonical: '+2348031234567',
    otherRaw: '+447911123456',
    otherCanonical: '+447911123456',
    respelled: '+2348031234567',
    invalid: 'abc',
    invalidCode: 'INVALID_PHONE',
  },
] as const satisfies readonly { channel: OtpChannel; [key: string]: string }[]

const recipientOf = (channel: OtpChannel, address: string) => ({ channel, address }) as OtpRecipient

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error as Error & { code?: string; details?: Record<string, unknown> }
  }
  throw new Error('expected the promise to reject')
}

class DownQueue extends MemoryJobQueue {
  override async enqueue(): Promise<void> {
    throw new Error('queue is down')
  }
}

describe('OTP_POLICY', () => {
  it('is the agreed policy', () => {
    expect(OTP_POLICY).toEqual({ length: 6, ttlMinutes: 10, maxAttempts: 5, cooldownSeconds: 60, maxSendsPerHour: 5 })
  })
})

describe('OtpService secrets', () => {
  it('keeps the pepper out of the service when it is spread or listed', () => {
    const service = new OtpService({
      repository: new FakeOtpRepository(),
      whatsapp: new MemoryOtpDelivery(),
      email: new MemoryEmailSender(),
      jobs: new MemoryJobQueue(),
      channels: ['email', 'whatsapp'],
      pepper: PEPPER,
    })

    const spread = { ...service }
    expect(Object.keys(spread)).toContain('channels')
    expect(Object.values(spread)).not.toContain(PEPPER)
  })
})

describe('parseOtpChannels', () => {
  it('reads a single channel', () => {
    expect(parseOtpChannels('email')).toEqual(['email'])
  })

  it('trims whitespace around each name and keeps the order', () => {
    expect(parseOtpChannels(' email , whatsapp ')).toEqual(['email', 'whatsapp'])
  })

  it('reads an empty value as no channels', () => {
    expect(parseOtpChannels('')).toEqual([])
  })

  it('throws a plain error naming OTP_CHANNELS for an unknown channel, so a config bug is loud', () => {
    expect.assertions(3)
    try {
      parseOtpChannels('email,sms')
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(ValidationError)
      expect((error as Error).message).toContain('OTP_CHANNELS')
    }
  })
})

describe.each(CHANNELS)('OtpService over $channel', (c) => {
  const canonical = recipientOf(c.channel, c.canonical)
  const other = recipientOf(c.channel, c.otherCanonical)

  let now: Date
  let codes: string[]
  let repository: FakeOtpRepository
  let whatsapp: MemoryOtpDelivery
  let email: MemoryEmailSender
  let jobs: MemoryJobQueue
  let service: OtpService

  const lastBody = () => jobs.enqueued.at(-1)!.body as { challengeId: string; sealedCode: string }
  const at = (msAfterT0: number) => {
    now = new Date(T0.getTime() + msAfterT0)
  }
  const build = (overrides: { pepper?: string; channels?: readonly OtpChannel[] } = {}) =>
    new OtpService({
      repository,
      whatsapp,
      email,
      jobs,
      pepper: overrides.pepper ?? PEPPER,
      channels: overrides.channels ?? ['email', 'whatsapp'],
      now: () => now,
      generateCode: () => codes.shift() ?? CODE,
      newId: () => crypto.randomUUID(),
    })

  const send = (address: string = c.raw) => service.send({ channel: c.channel, address })
  const verify = (address: string, code: string) => service.verify({ channel: c.channel, address }, code)

  /** How many messages reached this channel's provider. */
  const sentCount = () => (c.channel === 'email' ? email.sent.length : whatsapp.sent.length)
  /** Whether the latest message on this channel went to `to` carrying `code` (anywhere in an email's subject, html and text). */
  const lastSentWas = (to: string, code: string) => {
    if (c.channel === 'whatsapp') return whatsapp.sent.at(-1)?.to === to && whatsapp.sent.at(-1)?.code === code
    const m = email.sent.at(-1)
    return m?.to === to && [m.subject, m.html, m.text].every((part) => part.includes(code))
  }
  const failNextWith = (reason: 'recipient-rejected' | 'unavailable') =>
    c.channel === 'email'
      ? email.failNextWith(new EmailDeliveryError(reason, reason))
      : whatsapp.failNextWith(new OtpDeliveryError(reason, reason))
  const failNextWithError = (error: Error) => (c.channel === 'email' ? email.failNextWith(error) : whatsapp.failNextWith(error))

  beforeEach(() => {
    now = T0
    codes = []
    repository = new FakeOtpRepository()
    whatsapp = new MemoryOtpDelivery()
    email = new MemoryEmailSender()
    jobs = new MemoryJobQueue()
    service = build()
  })

  describe('send', () => {
    it('returns the challenge id and the expiry ten minutes out, and stores the challenge as queued for the canonical recipient', async () => {
      const result = await send()

      expect(result).toEqual({ challengeId: expect.any(String), expiresAt: new Date(T0.getTime() + 10 * MINUTE) })
      expect(await repository.findById(result.challengeId)).toMatchObject({
        channel: c.channel,
        address: c.canonical,
        deliveryStatus: 'queued',
      })
    })

    it('enqueues exactly one delivery job carrying no address, and does not call any provider', async () => {
      const { challengeId } = await send()

      expect(jobs.enqueued).toEqual([{ job: deliverOtpSpec.name, body: { challengeId, sealedCode: expect.any(String) } }])
      expect(whatsapp.sent).toEqual([])
      expect(email.sent).toEqual([])
      expect(JSON.stringify(jobs.enqueued)).not.toContain(c.canonical)
    })

    it('keeps the plain code out of the queued message', async () => {
      await send()

      expect(JSON.stringify(jobs.enqueued)).not.toContain(CODE)
    })

    it('marks the challenge failed and answers 503 when the job cannot be enqueued', async () => {
      jobs = new DownQueue()
      service = build()

      const error = await errorOf(send())

      expect(error).toBeInstanceOf(UnavailableError)
      expect(error).toMatchObject({ code: 'OTP_DELIVERY_UNAVAILABLE' })
      expect(await repository.findLatest(canonical)).toMatchObject({ deliveryStatus: 'failed', failureReason: 'unavailable' })
    })

    it('logs an enqueue failure as enqueue-failed, without the code', async () => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      jobs = new DownQueue()
      service = build()

      await errorOf(send())

      expect(log).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'enqueue-failed' }))
      expect(JSON.stringify(log.mock.calls)).not.toContain(CODE)
      log.mockRestore()
    })

    it('does not count enqueue failures toward the cooldown or the hourly cap', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      jobs = new DownQueue()
      service = build()
      for (let i = 0; i < OTP_POLICY.maxSendsPerHour + 1; i++) {
        expect(await errorOf(send())).toMatchObject({ code: 'OTP_DELIVERY_UNAVAILABLE' })
      }
      jobs = new MemoryJobQueue()
      service = build()

      await expect(send()).resolves.toBeDefined()
      vi.restoreAllMocks()
    })

    it('does not count a challenge that failed as unavailable toward the cooldown', async () => {
      const { challengeId } = await send()
      await service.markUndeliverable(challengeId)

      await expect(send()).resolves.toBeDefined()
    })

    it('counts a challenge whose recipient was rejected toward the cooldown', async () => {
      const { challengeId } = await send()
      failNextWith('recipient-rejected')
      await errorOf(service.deliver(lastBody()))
      expect((await repository.findById(challengeId))!.failureReason).toBe('recipient-rejected')
      at(15 * SECOND)

      expect(await errorOf(send())).toMatchObject({ code: 'OTP_COOLDOWN', details: { retryAfterSeconds: 45 } })
    })

    it('counts challenges whose recipient was rejected toward the hourly cap', async () => {
      for (let i = 0; i < OTP_POLICY.maxSendsPerHour; i++) {
        at(i * MINUTE)
        await send()
        failNextWith('recipient-rejected')
        await errorOf(service.deliver(lastBody()))
      }
      at(5 * MINUTE)

      expect(await errorOf(send())).toMatchObject({ code: 'OTP_SEND_LIMIT' })
    })

    it('hashes the same code differently per recipient and per pepper', async () => {
      await send(c.canonical)
      await send(c.otherRaw)
      const otherRepository = new FakeOtpRepository()
      await new OtpService({
        repository: otherRepository,
        whatsapp,
        email,
        jobs,
        channels: ['email', 'whatsapp'],
        pepper: 'another-pepper',
        now: () => now,
        generateCode: () => CODE,
      }).send({ channel: c.channel, address: c.canonical })

      const a = (await repository.findLatest(canonical))!.codeHash
      const b = (await repository.findLatest(other))!.codeHash
      const d = (await otherRepository.findLatest(canonical))!.codeHash
      expect(new Set([a, b, d]).size).toBe(3)
    })

    it('uses a real random six digit code by default, and that code is the one verify accepts', async () => {
      const real = new OtpService({ repository, whatsapp, email, jobs, channels: ['email', 'whatsapp'], pepper: PEPPER })

      const { expiresAt } = await real.send({ channel: c.channel, address: c.canonical })
      await real.deliver(lastBody())

      // Only this test reads the code back out of what was sent; every other one injects generateCode.
      const delivered = c.channel === 'whatsapp' ? whatsapp.sent[0]!.code : email.sent[0]!.subject.match(/\d{6}/)![0]
      expect(delivered).toMatch(/^\d{6}$/)
      expect(expiresAt.getTime()).toBeGreaterThan(Date.now())
      await expect(real.verify({ channel: c.channel, address: c.canonical }, delivered)).resolves.toEqual(canonical)
    })

    it(`rejects an invalid address with ${c.invalidCode} and enqueues nothing`, async () => {
      const error = await errorOf(send(c.invalid))

      expect(error).toBeInstanceOf(ValidationError)
      expect(error).toMatchObject({ code: c.invalidCode })
      expect(jobs.enqueued).toEqual([])
    })

    it('refuses a resend inside the cooldown and reports the seconds remaining', async () => {
      await send()
      at(15 * SECOND)

      const error = await errorOf(send())

      expect(error).toBeInstanceOf(RateLimitedError)
      expect(error).toMatchObject({ code: 'OTP_COOLDOWN', details: { retryAfterSeconds: 45 } })
      expect(jobs.enqueued).toHaveLength(1)
    })

    it('applies the cooldown to a different spelling of the same address', async () => {
      await send()
      at(15 * SECOND)

      expect(await errorOf(send(c.respelled))).toMatchObject({ code: 'OTP_COOLDOWN' })
    })

    it('rounds the remaining cooldown up to a whole second', async () => {
      await send()
      at(14_500)

      expect(await errorOf(send())).toMatchObject({ code: 'OTP_COOLDOWN', details: { retryAfterSeconds: 46 } })
    })

    it('still refuses one millisecond before the cooldown ends', async () => {
      await send()
      at(60 * SECOND - 1)

      expect(await errorOf(send())).toMatchObject({ code: 'OTP_COOLDOWN', details: { retryAfterSeconds: 1 } })
    })

    it('allows a resend exactly 60 seconds after the last send', async () => {
      await send()
      at(60 * SECOND)

      await expect(send()).resolves.toEqual({
        challengeId: expect.any(String),
        expiresAt: new Date(T0.getTime() + 60 * SECOND + 10 * MINUTE),
      })
      expect(jobs.enqueued).toHaveLength(2)
    })

    it('does not apply the cooldown across different recipients on the same channel', async () => {
      await send(c.canonical)

      await expect(send(c.otherRaw)).resolves.toBeDefined()
    })

    describe('hourly cap', () => {
      const sendFiveAtOneMinuteSpacing = async () => {
        for (let i = 0; i < OTP_POLICY.maxSendsPerHour; i++) {
          at(i * MINUTE)
          await send()
        }
      }

      it('refuses a sixth send in the hour with the seconds until the oldest leaves the window', async () => {
        await sendFiveAtOneMinuteSpacing()
        at(5 * MINUTE)

        const error = await errorOf(send())

        expect(error).toBeInstanceOf(RateLimitedError)
        expect(error).toMatchObject({ code: 'OTP_SEND_LIMIT', details: { retryAfterSeconds: 55 * 60 } })
        expect(jobs.enqueued).toHaveLength(5)
      })

      it('rounds the wait up to a whole second', async () => {
        await sendFiveAtOneMinuteSpacing()
        at(5 * MINUTE + 500)

        expect(await errorOf(send())).toMatchObject({ code: 'OTP_SEND_LIMIT', details: { retryAfterSeconds: 55 * 60 } })
      })

      it('reports one second left just before the oldest send leaves the window', async () => {
        await sendFiveAtOneMinuteSpacing()
        at(HOUR - SECOND)

        expect(await errorOf(send())).toMatchObject({ code: 'OTP_SEND_LIMIT', details: { retryAfterSeconds: 1 } })
      })

      it('allows a send once the oldest has left the window, so the window rolls', async () => {
        await sendFiveAtOneMinuteSpacing()
        at(HOUR + SECOND)

        await expect(send()).resolves.toBeDefined()
        expect(jobs.enqueued).toHaveLength(6)
      })

      it('reports the cooldown, not the cap, when the last send is also recent', async () => {
        await sendFiveAtOneMinuteSpacing()
        at(4 * MINUTE + 10 * SECOND)

        expect(await errorOf(send())).toMatchObject({ code: 'OTP_COOLDOWN', details: { retryAfterSeconds: 50 } })
      })

      it('counts sends per recipient', async () => {
        await sendFiveAtOneMinuteSpacing()
        at(5 * MINUTE)

        await expect(send(c.otherRaw)).resolves.toBeDefined()
      })
    })
  })

  describe('deliver', () => {
    it('sends the code to the recipient and marks the challenge delivered', async () => {
      const { challengeId } = await send()

      await service.deliver(lastBody())

      expect(sentCount()).toBe(1)
      expect(lastSentWas(c.canonical, CODE)).toBe(true)
      expect(await service.deliveryStatus(challengeId)).toEqual({ status: 'delivered', failureReason: null })
    })

    it('delivers the very code that verify accepts', async () => {
      codes.push('135790')
      await send()

      await service.deliver(lastBody())

      expect(lastSentWas(c.canonical, '135790')).toBe(true)
      expect(await verify(c.raw, '135790')).toEqual(canonical)
    })

    it('lets verify succeed while delivery is still queued', async () => {
      const { challengeId } = await send()

      expect(await verify(c.raw, CODE)).toEqual(canonical)
      expect((await service.deliveryStatus(challengeId)).status).toBe('queued')
    })

    it('drops a message whose challenge was superseded by a newer send', async () => {
      await send()
      const stale = lastBody()
      at(60 * SECOND)
      await send()

      await expect(service.deliver(stale)).resolves.toBeUndefined()

      expect(sentCount()).toBe(0)
    })

    it('drops a message whose challenge has expired', async () => {
      await send()
      at(10 * MINUTE)

      await expect(service.deliver(lastBody())).resolves.toBeUndefined()

      expect(sentCount()).toBe(0)
    })

    it('drops a message whose challenge was already used', async () => {
      await send()
      await verify(c.raw, CODE)

      await expect(service.deliver(lastBody())).resolves.toBeUndefined()

      expect(sentCount()).toBe(0)
    })

    it('drops a repeat of a message already delivered, without sending again', async () => {
      await send()
      await service.deliver(lastBody())

      await expect(service.deliver(lastBody())).resolves.toBeUndefined()

      expect(sentCount()).toBe(1)
    })

    it('drops a message for a challenge that does not exist', async () => {
      await send()
      const body = lastBody()

      await expect(service.deliver({ ...body, challengeId: crypto.randomUUID() })).resolves.toBeUndefined()

      expect(sentCount()).toBe(0)
    })

    it('drops a message whose challenge already failed', async () => {
      const { challengeId } = await send()
      await service.markUndeliverable(challengeId)

      await expect(service.deliver(lastBody())).resolves.toBeUndefined()

      expect(sentCount()).toBe(0)
    })

    it('fails a rejected recipient permanently and records why', async () => {
      const { challengeId } = await send()
      failNextWith('recipient-rejected')

      expect(await errorOf(service.deliver(lastBody()))).toBeInstanceOf(PermanentJobError)

      expect(await service.deliveryStatus(challengeId)).toEqual({ status: 'failed', failureReason: 'recipient-rejected' })
    })

    it.each([
      ['an unavailable provider', () => (c.channel === 'email' ? new EmailDeliveryError('unavailable', 'down') : new OtpDeliveryError('unavailable', 'down'))],
      ['an unexpected error', () => new Error('a bug')],
    ])('rethrows %s unchanged and leaves the challenge queued so it can be retried', async (_label, makeFailure) => {
      const { challengeId } = await send()
      const failure = makeFailure()
      failNextWithError(failure)

      const thrown = await errorOf(service.deliver(lastBody()))
      expect(thrown).toBe(failure)
      expect(thrown).not.toBeInstanceOf(PermanentJobError)
      expect((await service.deliveryStatus(challengeId)).status).toBe('queued')

      await service.deliver(lastBody())
      expect((await service.deliveryStatus(challengeId)).status).toBe('delivered')
      expect(sentCount()).toBe(1)
      expect(lastSentWas(c.canonical, CODE)).toBe(true)
    })

    describe('when the provider is misconfigured', () => {
      const PROVIDER_MESSAGE =
        c.channel === 'email'
          ? 'ZeptoMail send failed (HTTP 401, code TM_3601, details SERR_157)'
          : 'WhatsApp send failed (HTTP 401, code 190)'
      const misconfigured = () =>
        c.channel === 'email'
          ? new EmailDeliveryError('misconfigured', PROVIDER_MESSAGE)
          : new OtpDeliveryError('misconfigured', PROVIDER_MESSAGE)

      it('fails permanently naming the channel and the provider error, and records the challenge as unavailable', async () => {
        const { challengeId } = await send()
        const failure = misconfigured()
        failNextWithError(failure)

        const thrown = await errorOf(service.deliver(lastBody()))

        expect(thrown).toBeInstanceOf(PermanentJobError)
        expect(thrown.message).toContain(`The ${c.channel} provider is misconfigured`)
        expect(thrown.message).toContain(PROVIDER_MESSAGE)
        expect(thrown.cause).toBe(failure)
        expect(await service.deliveryStatus(challengeId)).toEqual({ status: 'failed', failureReason: 'unavailable' })
      })

      it('does not send again when the same message is redelivered', async () => {
        await send()
        failNextWithError(misconfigured())
        await errorOf(service.deliver(lastBody()))

        await expect(service.deliver(lastBody())).resolves.toBeUndefined()

        expect(sentCount()).toBe(0)
      })

      it('does not count the failed challenge toward the cooldown', async () => {
        await send()
        failNextWithError(misconfigured())
        await errorOf(service.deliver(lastBody()))
        at(15 * SECOND)

        await expect(send()).resolves.toBeDefined()
      })
    })

    it('fails permanently and sends nothing when the sealed code was tampered with', async () => {
      await send()
      const body = lastBody()
      const i = 10
      const tampered = body.sealedCode.slice(0, i) + (body.sealedCode[i] === 'A' ? 'B' : 'A') + body.sealedCode.slice(i + 1)

      expect(await errorOf(service.deliver({ ...body, sealedCode: tampered }))).toBeInstanceOf(PermanentJobError)
      expect(sentCount()).toBe(0)
    })

    it('fails permanently and sends nothing when the sealed code belongs to another challenge', async () => {
      await send(c.canonical)
      const first = lastBody()
      await send(c.otherRaw)
      const second = lastBody()

      expect(await errorOf(service.deliver({ ...second, sealedCode: first.sealedCode }))).toBeInstanceOf(PermanentJobError)
      expect(sentCount()).toBe(0)
    })
  })

  describe('markUndeliverable', () => {
    it('fails a queued challenge as unavailable', async () => {
      const { challengeId } = await send()

      await service.markUndeliverable(challengeId)

      expect(await service.deliveryStatus(challengeId)).toEqual({ status: 'failed', failureReason: 'unavailable' })
    })

    it('leaves a delivered challenge delivered', async () => {
      const { challengeId } = await send()
      await service.deliver(lastBody())

      await service.markUndeliverable(challengeId)

      expect(await service.deliveryStatus(challengeId)).toEqual({ status: 'delivered', failureReason: null })
    })
  })

  describe('deliveryStatus', () => {
    it('reports queued right after send', async () => {
      const { challengeId } = await send()

      expect(await service.deliveryStatus(challengeId)).toEqual({ status: 'queued', failureReason: null })
    })

    it('answers OTP_CHALLENGE_NOT_FOUND for an unknown challenge', async () => {
      const error = await errorOf(service.deliveryStatus(crypto.randomUUID()))

      expect(error).toBeInstanceOf(NotFoundError)
      expect(error).toMatchObject({ code: 'OTP_CHALLENGE_NOT_FOUND' })
    })
  })

  describe('verify', () => {
    it('returns the canonical recipient for the correct code', async () => {
      await send()

      expect(await verify(c.raw, CODE)).toEqual({ channel: c.channel, address: c.canonical })
    })

    it(`rejects an invalid address with ${c.invalidCode}`, async () => {
      const error = await errorOf(verify(c.invalid, CODE))

      expect(error).toBeInstanceOf(ValidationError)
      expect(error).toMatchObject({ code: c.invalidCode })
    })

    it('treats a recipient with no challenge as expired', async () => {
      const error = await errorOf(verify(c.raw, CODE))

      expect(error).toBeInstanceOf(ValidationError)
      expect(error).toMatchObject({ code: 'OTP_EXPIRED' })
    })

    it('accepts a different spelling of the same address than the one sent to', async () => {
      await send()

      expect(await verify(c.respelled, CODE)).toEqual(canonical)
    })

    it('works only once: a second verify with the same code is expired', async () => {
      await send()
      await verify(c.raw, CODE)

      const error = await errorOf(verify(c.raw, CODE))

      expect(error).toBeInstanceOf(ValidationError)
      expect(error).toMatchObject({ code: 'OTP_EXPIRED' })
    })

    it('accepts the code one millisecond before it expires', async () => {
      await send()
      at(10 * MINUTE - 1)

      expect(await verify(c.raw, CODE)).toEqual(canonical)
    })

    it('rejects the code exactly when it expires', async () => {
      await send()
      at(10 * MINUTE)

      const error = await errorOf(verify(c.raw, CODE))

      expect(error).toBeInstanceOf(ValidationError)
      expect(error).toMatchObject({ code: 'OTP_EXPIRED' })
    })

    it('counts down the attempts remaining on each wrong code', async () => {
      await send()

      for (const attemptsRemaining of [4, 3, 2, 1]) {
        const error = await errorOf(verify(c.raw, WRONG))
        expect(error).toBeInstanceOf(ValidationError)
        expect(error).toMatchObject({ code: 'OTP_INVALID', details: { attemptsRemaining } })
      }
    })

    it('still accepts the correct code after four wrong tries', async () => {
      await send()
      for (let i = 0; i < 4; i++) await errorOf(verify(c.raw, WRONG))

      expect(await verify(c.raw, CODE)).toEqual(canonical)
    })

    it('kills the code on the fifth wrong try, which itself is rate limited without a retry hint', async () => {
      await send()
      for (let i = 0; i < 4; i++) await errorOf(verify(c.raw, WRONG))

      const error = await errorOf(verify(c.raw, WRONG))

      expect(error).toBeInstanceOf(RateLimitedError)
      expect(error).toMatchObject({ code: 'OTP_TOO_MANY_ATTEMPTS' })
      expect((error.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds).toBeUndefined()
    })

    it('rejects even the correct code once the attempts are used up', async () => {
      await send()
      for (let i = 0; i < 5; i++) await errorOf(verify(c.raw, WRONG))

      const error = await errorOf(verify(c.raw, CODE))

      expect(error).toBeInstanceOf(RateLimitedError)
      expect(error).toMatchObject({ code: 'OTP_TOO_MANY_ATTEMPTS' })
    })

    it('reports expired rather than too many attempts once a locked code has also expired', async () => {
      await send()
      for (let i = 0; i < 5; i++) await errorOf(verify(c.raw, WRONG))
      at(10 * MINUTE)

      expect(await errorOf(verify(c.raw, CODE))).toMatchObject({ code: 'OTP_EXPIRED' })
    })

    it('a new send supersedes the old code, which stops verifying', async () => {
      const first = '111111'
      const second = '222222'
      codes.push(first, second)
      await send()
      at(60 * SECOND)
      await send()

      expect(await errorOf(verify(c.raw, first))).toMatchObject({ code: 'OTP_INVALID' })
      expect(await verify(c.raw, second)).toEqual(canonical)
    })

    it('does not accept the code sent to one recipient for another', async () => {
      codes.push('111111', '222222')
      await send(c.canonical)
      await send(c.otherRaw)

      expect(await errorOf(verify(c.otherRaw, '111111'))).toMatchObject({ code: 'OTP_INVALID' })
      expect(await verify(c.otherRaw, '222222')).toEqual(other)
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
      await send()

      const error = await errorOf(verify(c.raw, CODE))

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
      await send()

      const error = await errorOf(verify(c.raw, CODE))

      expect(error).toBeInstanceOf(ValidationError)
      expect(error).toMatchObject({ code: 'OTP_EXPIRED' })
    })

    it('does not accept the same code under a different pepper', async () => {
      await send()

      expect(await errorOf(build({ pepper: 'another-pepper' }).verify({ channel: c.channel, address: c.raw }, CODE))).toMatchObject({
        code: 'OTP_INVALID',
      })
    })
  })
})

describe('OtpService channels', () => {
  const EMAIL_RAW = ' Ada@Example.com '
  const EMAIL = 'ada@example.com'
  const PHONE_RAW = '0803 123 4567'
  const PHONE = '+2348031234567'

  let now: Date
  let codes: string[]
  let repository: FakeOtpRepository
  let whatsapp: MemoryOtpDelivery
  let email: MemoryEmailSender
  let jobs: MemoryJobQueue
  let service: OtpService

  const lastBody = () => jobs.enqueued.at(-1)!.body as { challengeId: string; sealedCode: string }
  const build = (channels: readonly OtpChannel[] = ['email', 'whatsapp']) =>
    new OtpService({
      repository,
      whatsapp,
      email,
      jobs,
      pepper: PEPPER,
      channels,
      now: () => now,
      generateCode: () => codes.shift() ?? CODE,
    })

  beforeEach(() => {
    now = T0
    codes = []
    repository = new FakeOtpRepository()
    whatsapp = new MemoryOtpDelivery()
    email = new MemoryEmailSender()
    jobs = new MemoryJobQueue()
    service = build()
  })

  describe('availability', () => {
    it('refuses a channel that is not enabled with OTP_CHANNEL_UNAVAILABLE, storing and enqueuing nothing', async () => {
      service = build(['email'])

      const error = await errorOf(service.send({ channel: 'whatsapp', address: PHONE_RAW }))

      expect(error).toBeInstanceOf(ValidationError)
      expect(error).toMatchObject({ code: 'OTP_CHANNEL_UNAVAILABLE' })
      expect(jobs.enqueued).toEqual([])
      expect(await repository.findLatest({ channel: 'whatsapp', address: PHONE } as OtpRecipient)).toBeNull()
    })

    it('still sends on an enabled channel when another is disabled', async () => {
      service = build(['email'])

      await expect(service.send({ channel: 'email', address: EMAIL_RAW })).resolves.toBeDefined()
    })

    it('refuses an unknown channel name at runtime', async () => {
      const error = await errorOf(service.send({ channel: 'sms' as OtpChannel, address: PHONE_RAW }))

      expect(error).toMatchObject({ code: 'OTP_CHANNEL_UNAVAILABLE' })
      expect(jobs.enqueued).toEqual([])
    })

    it('refuses every channel when none is enabled', async () => {
      service = build([])

      expect(await errorOf(service.send({ channel: 'email', address: EMAIL_RAW }))).toMatchObject({ code: 'OTP_CHANNEL_UNAVAILABLE' })
    })

    it('checks the channel before the address, so a bad address on a disabled channel is reported as unavailable', async () => {
      service = build(['email'])

      expect(await errorOf(service.send({ channel: 'whatsapp', address: 'abc' }))).toMatchObject({ code: 'OTP_CHANNEL_UNAVAILABLE' })
    })

    it('still verifies a code that was issued before its channel was disabled', async () => {
      await service.send({ channel: 'whatsapp', address: PHONE_RAW })
      service = build(['email'])

      expect(await service.verify({ channel: 'whatsapp', address: PHONE_RAW }, CODE)).toEqual({ channel: 'whatsapp', address: PHONE })
    })

    it('still delivers a challenge queued before its channel was disabled', async () => {
      await service.send({ channel: 'whatsapp', address: PHONE_RAW })
      service = build(['email'])

      await service.deliver(lastBody())

      expect(whatsapp.sent).toEqual([{ to: PHONE, code: CODE }])
    })
  })

  describe('send across channels', () => {
    it('keeps an email and a phone number on independent cooldowns', async () => {
      await service.send({ channel: 'email', address: EMAIL_RAW })

      await expect(service.send({ channel: 'whatsapp', address: PHONE_RAW })).resolves.toBeDefined()
      expect(await errorOf(service.send({ channel: 'email', address: EMAIL_RAW }))).toMatchObject({ code: 'OTP_COOLDOWN' })
    })

    it('keeps an email and a phone number on independent hourly caps', async () => {
      for (let i = 0; i < OTP_POLICY.maxSendsPerHour; i++) {
        now = new Date(T0.getTime() + i * MINUTE)
        await service.send({ channel: 'email', address: EMAIL_RAW })
      }
      now = new Date(T0.getTime() + 5 * MINUTE)

      expect(await errorOf(service.send({ channel: 'email', address: EMAIL_RAW }))).toMatchObject({ code: 'OTP_SEND_LIMIT' })
      await expect(service.send({ channel: 'whatsapp', address: PHONE_RAW })).resolves.toBeDefined()
    })

    it('does not accept the code sent to an email for a phone, nor the reverse', async () => {
      codes.push('111111', '222222')
      await service.send({ channel: 'email', address: EMAIL_RAW })
      await service.send({ channel: 'whatsapp', address: PHONE_RAW })

      expect(await errorOf(service.verify({ channel: 'email', address: EMAIL }, '222222'))).toMatchObject({ code: 'OTP_INVALID' })
      expect(await errorOf(service.verify({ channel: 'whatsapp', address: PHONE }, '111111'))).toMatchObject({ code: 'OTP_INVALID' })
      expect(await service.verify({ channel: 'email', address: EMAIL }, '111111')).toEqual({ channel: 'email', address: EMAIL })
      expect(await service.verify({ channel: 'whatsapp', address: PHONE }, '222222')).toEqual({ channel: 'whatsapp', address: PHONE })
    })

    it('does not verify a code sent to an email on the whatsapp channel', async () => {
      await service.send({ channel: 'email', address: EMAIL_RAW })

      expect(await errorOf(service.verify({ channel: 'whatsapp', address: PHONE_RAW }, CODE))).toMatchObject({ code: 'OTP_EXPIRED' })
    })
  })

  describe('delivery by channel', () => {
    it('emails the code once, to the address, referencing the challenge, and never calls WhatsApp', async () => {
      codes.push('135790')
      const { challengeId } = await service.send({ channel: 'email', address: EMAIL_RAW })

      await service.deliver(lastBody())

      expect(whatsapp.sent).toEqual([])
      expect(email.sent).toHaveLength(1)
      const message = email.sent[0]!
      expect(message.to).toBe(EMAIL)
      expect(message.reference).toBe(challengeId)
      expect(message.subject).toBe('135790 is your Deeper Tones sign-in code')
      expect(message.html).toContain('135790')
      expect(message.text).toContain('135790')
      expect(message.text).toContain('10 minutes')
      const expected = renderEmail('otp-code', { code: '135790', ttlMinutes: 10 })
      expect({ subject: message.subject, html: message.html, text: message.text }).toEqual(expected)
      expect(await service.deliveryStatus(challengeId)).toEqual({ status: 'delivered', failureReason: null })
    })

    it('sends the whatsapp code to the phone and never sends an email', async () => {
      codes.push('135790')
      await service.send({ channel: 'whatsapp', address: PHONE_RAW })

      await service.deliver(lastBody())

      expect(whatsapp.sent).toEqual([{ to: PHONE, code: '135790' }])
      expect(email.sent).toEqual([])
    })

    it('fails permanently when the email provider rejects the recipient, and records it', async () => {
      const { challengeId } = await service.send({ channel: 'email', address: EMAIL_RAW })
      email.failNextWith(new EmailDeliveryError('recipient-rejected', 'bad mailbox'))

      expect(await errorOf(service.deliver(lastBody()))).toBeInstanceOf(PermanentJobError)

      expect(await service.deliveryStatus(challengeId)).toEqual({ status: 'failed', failureReason: 'recipient-rejected' })
    })

    describe('when the email provider is misconfigured', () => {
      const PROVIDER_MESSAGE = 'ZeptoMail send failed (HTTP 400, code TM_4001, details SM_111)'

      it('fails permanently naming the provider error, and records the challenge as unavailable', async () => {
        const { challengeId } = await service.send({ channel: 'email', address: EMAIL_RAW })
        const failure = new EmailDeliveryError('misconfigured', PROVIDER_MESSAGE)
        email.failNextWith(failure)

        const thrown = await errorOf(service.deliver(lastBody()))

        expect(thrown).toBeInstanceOf(PermanentJobError)
        expect(thrown.message).toContain('SM_111')
        expect(thrown.cause).toBe(failure)
        expect(await service.deliveryStatus(challengeId)).toEqual({ status: 'failed', failureReason: 'unavailable' })
      })

      it('does not send again when the same message is redelivered', async () => {
        await service.send({ channel: 'email', address: EMAIL_RAW })
        email.failNextWith(new EmailDeliveryError('misconfigured', PROVIDER_MESSAGE))
        await errorOf(service.deliver(lastBody()))

        await expect(service.deliver(lastBody())).resolves.toBeUndefined()

        expect(email.sent).toEqual([])
      })

      it('does not count the failed challenge toward the cooldown', async () => {
        await service.send({ channel: 'email', address: EMAIL_RAW })
        email.failNextWith(new EmailDeliveryError('misconfigured', PROVIDER_MESSAGE))
        await errorOf(service.deliver(lastBody()))
        now = new Date(T0.getTime() + 15 * SECOND)

        await expect(service.send({ channel: 'email', address: EMAIL_RAW })).resolves.toBeDefined()
      })
    })
  })
})
