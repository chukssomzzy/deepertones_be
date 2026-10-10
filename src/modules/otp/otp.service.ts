import { hmacSha256Hex, randomDigits, timingSafeEqual } from '../../lib/crypto'
import { RateLimitedError, UnavailableError, ValidationError } from '../../lib/errors'
import { parsePhoneNumber, type PhoneNumber } from '../../lib/phone'
import { type OtpDelivery, OtpDeliveryError } from '../../providers/otp-delivery/otp-delivery.provider'
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

export type OtpServiceDeps = {
  repository: OtpRepository
  delivery: OtpDelivery
  /** Server secret mixed into every code hash, so a leaked table cannot be brute-forced offline. */
  pepper: string
  now?: () => Date
  generateCode?: () => string
  newId?: () => string
}

export class OtpService {
  private readonly repository: OtpRepository
  private readonly delivery: OtpDelivery
  private readonly pepper: string
  private readonly now: () => Date
  private readonly generateCode: () => string
  private readonly newId: () => string

  constructor(deps: OtpServiceDeps) {
    this.repository = deps.repository
    this.delivery = deps.delivery
    this.pepper = deps.pepper
    this.now = deps.now ?? (() => new Date())
    this.generateCode = deps.generateCode ?? (() => randomDigits(OTP_POLICY.length))
    this.newId = deps.newId ?? (() => crypto.randomUUID())
  }

  /** Sends a fresh code, superseding any earlier one. Failed deliveries leave no trace and use no quota. */
  async send(rawPhone: string): Promise<{ expiresAt: Date }> {
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
    // Deliver before storing: a failed delivery must not start a cooldown or count toward the cap.
    try {
      await this.delivery.send(phone, code)
    } catch (error) {
      if (error instanceof OtpDeliveryError) {
        if (error.reason === 'recipient-rejected') {
          throw new ValidationError('PHONE_NOT_REACHABLE', 'We could not send a code to that number')
        }
        throw new UnavailableError('OTP_DELIVERY_UNAVAILABLE', 'Could not send the code right now; try again shortly')
      }
      throw error
    }

    const expiresAt = new Date(now.getTime() + OTP_POLICY.ttlMinutes * 60 * SECOND)
    await this.repository.create({
      id: this.newId(),
      phone,
      codeHash: await this.hash(phone, code),
      createdAt: now,
      expiresAt,
    })
    return { expiresAt }
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
