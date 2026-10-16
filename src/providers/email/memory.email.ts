import type { EmailAddress } from '../../lib/email-address'
import type { EmailMessage, EmailSender } from './email.provider'

/** Records what would have been sent. For tests. */
export class MemoryEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = []
  #failure: Error | undefined

  /** The next send() rejects with `error` and records nothing. */
  failNextWith(error: Error) {
    this.#failure = error
  }

  lastTo(to: EmailAddress): EmailMessage | undefined {
    return this.sent.findLast((m) => m.to === to)
  }

  async send(message: EmailMessage): Promise<void> {
    if (this.#failure) {
      const failure = this.#failure
      this.#failure = undefined
      throw failure
    }
    this.sent.push(message)
  }
}
