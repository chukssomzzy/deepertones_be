import { PermanentJobError } from '../../jobs/job'
import { hmacSha256Hex, openText, randomDigits, sealText, timingSafeEqual } from '../../lib/crypto'
import { NotFoundError, RateLimitedError, UnavailableError, ValidationError } from '../../lib/errors'
import { parsePhoneNumber, type PhoneNumber } from '../../lib/phone'
import type { JobQueue } from '../../providers/job-queue/job-queue.provider'
import { type OtpDelivery, OtpDeliveryError } from '../../providers/otp-delivery/otp-delivery.provider'
import { type DeliverOtpMessage, deliverOtpSpec } from './otp.job-specs'
import type { OtpRepository } from './otp.repository'

/** The WhatsApp template's code expiry must match ttlMinutes (set it in Meta's template editor). */
export const OTP_POLICY = {
  length: 6,
  ttlMinutes: 10,
  maxAttempts: 5,
  cooldownSeconds: 60,
  maxSendsPerHour: 5,
} as const

const SECOND = 1000
const HOUR = 60 * 60 * SECOND

// Names the sealing key. Differs from the HMAC use of the pepper, so the two keys are unrelated.
const QUEUE_SEAL_INFO = 'deepertones/otp-queue/v1'

export type OtpServiceDeps = {
  repository: OtpRepository
  delivery: OtpDelivery
  jobs: JobQueue
  /** Server secret mixed into every code hash, so a leaked table cannot be brute-forced offline. */
  pepper: string
  now?: () => Date
  generateCode?: () => string
  newId?: () => string
}

export class OtpService {
  private readonly repository: OtpRepository
  private readonly delivery: OtpDelivery
  private readonly jobs: JobQueue
  private readonly pepper: string
  private readonly now: () => Date
  private readonly generateCode: () => string
  private readonly newId: () => string

  constructor(deps: OtpServiceDeps) {
    this.repository = deps.repository
    this.delivery = deps.delivery
    this.jobs = deps.jobs
    this.pepper = deps.pepper
    this.now = deps.now ?? (() => new Date())
    this.generateCode = deps.generateCode ?? (() => randomDigits(OTP_POLICY.length))
    this.newId = deps.newId ?? (() => crypto.randomUUID())
  }

  /**
   * Issues a fresh code, superseding any earlier one, and queues its delivery. The challenge is
   * stored first (as `queued`) and the job carries the code sealed, so the person never waits on
   * WhatsApp and retries survive an outage. Failed challenges do not count toward the limits.
   */
  async send(rawPhone: string): Promise<{ challengeId: string; expiresAt: Date }> {
    const phone = parsePhoneNumber(rawPhone)
    const now = this.now()

    // +1 ms keeps a send exactly an hour old out of the window, so a wait is never 0 seconds.
    const recent = await this.repository.sendTimes(phone, new Date(now.getTime() - HOUR + 1))
    const last = recent[0]
    if (last) {
      const cooldownEnds = last.getTime() + OTP_POLICY.cooldownSeconds * SECOND
      if (now.getTime() < cooldownEnds) {
        throw new RateLimitedError('OTP_COOLDOWN', 'Wait before requesting another code', {
          retryAfterSeconds: Math.ceil((cooldownEnds - now.getTime()) / SECOND),
        })
      }
    }
    if (recent.length >= OTP_POLICY.maxSendsPerHour) {
      const windowFreesAt = recent[OTP_POLICY.maxSendsPerHour - 1]!.getTime() + HOUR
      throw new RateLimitedError('OTP_SEND_LIMIT', 'Too many codes requested; try again later', {
        retryAfterSeconds: Math.ceil((windowFreesAt - now.getTime()) / SECOND),
      })
    }

    const code = this.generateCode()
    const challengeId = this.newId()
    const expiresAt = new Date(now.getTime() + OTP_POLICY.ttlMinutes * 60 * SECOND)
    await this.repository.create({
      id: challengeId,
      phone,
      codeHash: await this.hash(phone, code),
      createdAt: now,
      expiresAt,
    })

    try {
      // Bound to the challenge: a sealed code copied into another message cannot be opened.
      const sealedCode = await sealText(this.pepper, QUEUE_SEAL_INFO, code, challengeId)
      await this.jobs.enqueue(deliverOtpSpec, { challengeId, sealedCode })
    } catch (error) {
      // Never log the code or the sealed code.
      console.error({ outcome: 'enqueue-failed', challengeId, error: String(error) })
      await this.repository.markFailed(challengeId, 'unavailable')
      throw new UnavailableError('OTP_DELIVERY_UNAVAILABLE', 'Could not send the code right now; try again shortly')
    }
    return { challengeId, expiresAt }
  }

  /**
   * The delivery job's body. Drops messages that no longer matter (unknown, superseded, expired, used, or
   * already settled; a dropped challenge keeps reporting `queued`). A rejected recipient fails permanently; any other error is rethrown so the
   * queue retries, and repeating a delivery just resends the same code.
   */
  async deliver(message: DeliverOtpMessage): Promise<void> {
    const challenge = await this.repository.findById(message.challengeId)
    if (!challenge || challenge.deliveryStatus !== 'queued') return
    if (challenge.consumedAt || challenge.expiresAt.getTime() <= this.now().getTime()) return
    const latest = await this.repository.findLatest(challenge.phone)
    if (latest?.id !== challenge.id) return

    let code: string
    try {
      code = await openText(this.pepper, QUEUE_SEAL_INFO, message.sealedCode, challenge.id)
    } catch (error) {
      await this.repository.markFailed(challenge.id, 'unavailable')
      throw new PermanentJobError('The sealed code could not be opened', { cause: error })
    }

    try {
      await this.delivery.send(challenge.phone, code)
    } catch (error) {
      if (error instanceof OtpDeliveryError && error.reason === 'recipient-rejected') {
        await this.repository.markFailed(challenge.id, 'recipient-rejected')
        throw new PermanentJobError('The recipient cannot receive WhatsApp messages', { cause: error })
      }
      throw error
    }
    await this.repository.markDelivered(challenge.id, this.now())
  }

  /** The delivery job ran out of retries. Never overrides a delivered challenge. */
  async markUndeliverable(challengeId: string): Promise<void> {
    await this.repository.markFailed(challengeId, 'unavailable')
  }

  async deliveryStatus(challengeId: string) {
    const challenge = await this.repository.findById(challengeId)
    if (!challenge) throw new NotFoundError('OTP_CHALLENGE_NOT_FOUND', 'No such code request')
    return { status: challenge.deliveryStatus, failureReason: challenge.failureReason }
  }

  /** Checks a code against the phone's latest challenge; a correct one is consumed. Returns the canonical phone. */
  async verify(rawPhone: string, code: string): Promise<PhoneNumber> {
    const phone = parsePhoneNumber(rawPhone)
    const now = this.now()

    const challenge = await this.repository.findLatest(phone)
    if (!challenge || challenge.consumedAt || challenge.expiresAt.getTime() <= now.getTime()) {
      throw expired()
    }
    if (challenge.attempts >= OTP_POLICY.maxAttempts) throw tooManyAttempts()

    const matches = timingSafeEqual(challenge.codeHash, await this.hash(phone, code))
    if (matches) {
      if (await this.repository.consume(challenge.id, now, OTP_POLICY.maxAttempts)) return phone
      // Refused: the guard failed between our read and the update. Say which rule, from a fresh read.
      const current = await this.repository.findLatest(phone)
      if (current && current.attempts >= OTP_POLICY.maxAttempts) throw tooManyAttempts()
      throw expired()
    }

    const attempts = await this.repository.recordFailedAttempt(challenge.id, OTP_POLICY.maxAttempts)
    if (attempts === null || attempts >= OTP_POLICY.maxAttempts) throw tooManyAttempts()
    throw new ValidationError('OTP_INVALID', 'That code is not correct', {
      attemptsRemaining: OTP_POLICY.maxAttempts - attempts,
    })
  }

  // Bound to the phone, so a code sent to one number never verifies for another.
  private hash(phone: PhoneNumber, code: string) {
    return hmacSha256Hex(this.pepper, `${phone}:${code}`)
  }
}

const expired = () => new ValidationError('OTP_EXPIRED', 'That code has expired; request a new one')
const tooManyAttempts = () => new RateLimitedError('OTP_TOO_MANY_ATTEMPTS', 'Too many wrong codes; request a new one')
