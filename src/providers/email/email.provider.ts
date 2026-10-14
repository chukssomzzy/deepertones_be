import type { EmailAddress } from '../../lib/email-address'
import type { EmailContent } from '../../emails/html'

export type EmailMessage = EmailContent & {
  to: EmailAddress
  /** Our own id for this send (e.g. a challenge id), passed to the vendor so it shows up in their logs. */
  reference?: string
}

/** Sends one email. Adapters throw EmailDeliveryError for failures the caller can act on. */
export interface EmailSender {
  send(message: EmailMessage): Promise<void>
}

export type EmailDeliveryFailure =
  /** The provider is down, throttling us, or unreachable; the same request may work later. */
  | 'unavailable'
  /** The provider will not deliver to this address. */
  | 'recipient-rejected'

export class EmailDeliveryError extends Error {
  constructor(
    readonly reason: EmailDeliveryFailure,
    message: string,
  ) {
    super(message)
    this.name = 'EmailDeliveryError'
  }
}
