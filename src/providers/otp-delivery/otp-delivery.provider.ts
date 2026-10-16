import type { PhoneNumber } from '../../lib/phone'

/** Sends a one-time code to a phone. Adapters throw OtpDeliveryError for failures the caller can act on. */
export interface OtpDelivery {
  send(to: PhoneNumber, code: string): Promise<void>
}

export type OtpDeliveryFailure =
  /** The provider is down, throttling us, or unreachable; the same request may work later. */
  | 'unavailable'
  /** The provider will not deliver to this number (not reachable, or not allowed). */
  | 'recipient-rejected'
  /** Our own setup or account is wrong (token, phone number id, template, billing); retrying will not help until someone fixes it. */
  | 'misconfigured'

export class OtpDeliveryError extends Error {
  constructor(
    readonly reason: OtpDeliveryFailure,
    message: string,
  ) {
    super(message)
    this.name = 'OtpDeliveryError'
  }
}
