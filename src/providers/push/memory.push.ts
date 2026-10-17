import type { PushMessage, PushReceipt, PushSender, PushTicket } from './push.provider'

/** Records what would have been sent, and answers like Expo does. For tests. */
export class MemoryPushSender implements PushSender {
  readonly sent: PushMessage[] = []
  private failure: Error | undefined
  private receiptsFailure: Error | undefined
  private issued = 0
  private readonly tickets = new Map<string, PushTicket>()
  private readonly scriptedReceipts = new Map<string, PushReceipt>()
  private readonly issuedIds = new Set<string>()

  /** The next send() rejects with `error` and records nothing. */
  failNextWith(error: Error) {
    this.failure = error
  }

  /** The next receipts() rejects with `error`, then recovers. */
  failNextReceiptsWith(error: Error) {
    this.receiptsFailure = error
  }

  /** Messages to `token` get `ticket` instead of an ok one. */
  ticketFor(token: string, ticket: PushTicket) {
    this.tickets.set(token, ticket)
  }

  /** receipts() answers `receipt` for this ticket id instead of ok. */
  receiptFor(id: string, receipt: PushReceipt) {
    this.scriptedReceipts.set(id, receipt)
  }

  async send(messages: PushMessage[]): Promise<PushTicket[]> {
    if (this.failure) {
      const failure = this.failure
      this.failure = undefined
      throw failure
    }
    this.sent.push(...messages)
    return messages.map((message) => {
      const scripted = this.tickets.get(message.to)
      if (scripted) {
        if (scripted.status === 'ok') this.issuedIds.add(scripted.id)
        return scripted
      }
      const id = `ticket-${++this.issued}`
      this.issuedIds.add(id)
      return { status: 'ok', id }
    })
  }

  async receipts(ids: string[]): Promise<Record<string, PushReceipt>> {
    if (this.receiptsFailure) {
      const failure = this.receiptsFailure
      this.receiptsFailure = undefined
      throw failure
    }
    return Object.fromEntries(
      ids.filter((id) => this.issuedIds.has(id)).map((id) => [id, this.scriptedReceipts.get(id) ?? { status: 'ok' }]),
    )
  }
}
