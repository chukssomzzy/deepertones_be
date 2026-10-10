import type { PhoneNumber } from '../../lib/phone'
import type { OtpDelivery } from './otp-delivery.provider'

/** Records what would have been sent. For tests. */
export class MemoryOtpDelivery implements OtpDelivery {
  readonly sent: { to: PhoneNumber; code: string }[] = []
  private failure: Error | undefined

  /** The next send() rejects with `error` and records nothing. */
  failNextWith(error: Error) {
    this.failure = error
  }

  lastCodeFor(to: PhoneNumber): string | undefined {
    return this.sent.findLast((s) => s.to === to)?.code
  }

  async send(to: PhoneNumber, code: string): Promise<void> {
    if (this.failure) {
      const failure = this.failure
      this.failure = undefined
      throw failure
    }
    this.sent.push({ to, code })
  }
}
