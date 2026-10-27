import { firstValueFrom } from 'rxjs'
import { type HttpResponse, HttpTransportError, requestJson$ } from '../../lib/http'
import {
  type PushFailure,
  type PushMessage,
  type PushReceipt,
  type PushSender,
  type PushTicket,
  PushUnavailableError,
} from './push.provider'

export type ExpoPushSenderConfig = {
  /** Expo robot-user access token; with enhanced push security on, Expo refuses sends without it. */
  accessToken: string
  /** Give up on Expo after this long, per request; default 8000. */
  timeoutMs?: number
}

/**
 * Sends through the Expo Push Service over `requestJson$`, not `expo-server-sdk`: the SDK imports
 * `fetch` from undici, which Workers cannot run, and it retries internally (see "Push notifications
 * (Expo)" in docs/architecture.md). No retries here; the job system retries.
 *
 * A request carries at most 100 messages (receipts: 1000 ids), so a larger call is split, and the calls
 * are at-most-once. Only the FIRST request's failure rejects the call: nothing has gone out yet, so the
 * job's retry resends safely. After a request has gone out, a retry would resend it, and a push cannot
 * be taken back, so a later request that fails is reported per message instead (`unavailable` for
 * transport, 429 and 5xx; `misconfigured` for any other status; receipts: the ids are left out). A 2xx
 * reply that cannot be read is `other` (Expo may well have sent them), never a throw. A notification
 * targets a handful of phones, so one request is the normal case.
 */
export class ExpoPushSender implements PushSender {
  private static readonly SEND_URL = 'https://exp.host/--/api/v2/push/send'
  private static readonly RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts'
  private static readonly SEND_BATCH = 100
  private static readonly RECEIPTS_BATCH = 1000
  private static readonly DEFAULT_TIMEOUT_MS = 8000

  // Vendor codes go into our error messages, so accept only code-shaped strings: a vendor that echoes
  // free text (a token, say) must never reach our logs.
  private static readonly CODE_SHAPE = /^[A-Z0-9_]{1,64}$/

  // `#`, not `private`: it holds the access token, and a runtime-private field stays out of JSON.stringify and spreads.
  readonly #config: ExpoPushSenderConfig

  constructor(config: ExpoPushSenderConfig) {
    this.#config = config
  }

  async send(messages: PushMessage[]): Promise<PushTicket[]> {
    this.requireAccessToken()
    const tickets: PushTicket[] = []
    for (const [index, batch] of ExpoPushSender.batches(messages, ExpoPushSender.SEND_BATCH).entries()) {
      let reply: unknown
      try {
        reply = await this.post(
          ExpoPushSender.SEND_URL,
          batch.map(({ to, title, body, data, categoryId }) => ({ to, title, body, data, sound: 'default', ...(categoryId === undefined ? {} : { categoryId }) })),
        )
      } catch (error) {
        if (index === 0) throw error
        const reason = error instanceof PushUnavailableError ? 'unavailable' : 'misconfigured'
        tickets.push(...batch.map((): PushTicket => ({ status: 'error', reason })))
        continue
      }
      // Unreadable although 2xx: Expo may well have sent them, so `other`, not a throw that would resend.
      const unreadable = batch.map((): PushTicket => ({ status: 'error', reason: 'other' }))
      tickets.push(...(ExpoPushSender.ticketsOf(reply, batch.length) ?? unreadable))
    }
    return tickets
  }

  async receipts(ids: string[]): Promise<Record<string, PushReceipt>> {
    this.requireAccessToken()
    const receipts: [string, PushReceipt][] = []
    for (const [index, batch] of ExpoPushSender.batches(ids, ExpoPushSender.RECEIPTS_BATCH).entries()) {
      let reply: unknown
      try {
        reply = await this.post(ExpoPushSender.RECEIPTS_URL, { ids: batch })
      } catch (error) {
        if (index === 0) throw error
        continue
      }
      const data = ExpoPushSender.dataOf(reply)
      if (typeof data !== 'object' || data === null || Array.isArray(data)) continue
      for (const [id, entry] of Object.entries(data)) {
        const receipt = ExpoPushSender.receiptOf(entry)
        if (receipt) receipts.push([id, receipt])
      }
    }
    // fromEntries defines own properties, so a ticket id of "__proto__" cannot reach the prototype.
    return Object.fromEntries(receipts)
  }

  /**
   * Empty until someone creates it in Expo; fail here (setup is wrong, retrying cannot help) rather than send a request Expo refuses.
   * Whitespace is refused too: a pasted newline would make an invalid header, and the message must not echo the value.
   */
  private requireAccessToken() {
    if (!this.#config.accessToken || /\s/.test(this.#config.accessToken)) {
      throw new Error('EXPO_ACCESS_TOKEN is not set or contains whitespace')
    }
  }

  /** POSTs `body` and returns the parsed reply of a 2xx; every other outcome throws. */
  private async post(url: string, body: unknown): Promise<unknown> {
    const { accessToken, timeoutMs = ExpoPushSender.DEFAULT_TIMEOUT_MS } = this.#config
    let response: HttpResponse
    try {
      response = await firstValueFrom(
        requestJson$(url, {
          method: 'POST',
          timeoutMs,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(body),
        }),
      )
    } catch (error) {
      if (error instanceof HttpTransportError) throw new PushUnavailableError('Expo request failed before a response')
      throw error
    }
    if (response.ok) return response.body

    const codes = ExpoPushSender.requestCodes(response.body).join(',') || 'none'
    if (response.status >= 500 || response.status === 429) {
      throw new PushUnavailableError(`Expo unavailable (HTTP ${response.status}, codes ${codes})`)
    }
    // A rejected token, a bad request: our own setup or code is wrong, so the caller should not retry.
    throw new Error(`Expo rejected the request (HTTP ${response.status}, codes ${codes})`)
  }

  private static batches<T>(items: T[], size: number): T[][] {
    return Array.from({ length: Math.ceil(items.length / size) }, (_, i) => items.slice(i * size, (i + 1) * size))
  }

  private static dataOf(body: unknown): unknown {
    return (body as { data?: unknown } | null)?.data
  }

  private static requestCodes(body: unknown): string[] {
    const errors = (body as { errors?: unknown } | null)?.errors
    if (!Array.isArray(errors)) return []
    return errors.flatMap((e) => {
      const code = (e as { code?: unknown } | null)?.code
      return typeof code === 'string' && ExpoPushSender.CODE_SHAPE.test(code) ? [code] : []
    })
  }

  /** One ticket per message, or undefined when the reply is not a well-formed answer for `count` messages. */
  private static ticketsOf(reply: unknown, count: number): PushTicket[] | undefined {
    const data = ExpoPushSender.dataOf(reply)
    if (!Array.isArray(data) || data.length !== count) return undefined
    const tickets = data.map((entry): PushTicket | undefined => {
      const { status, id } = (entry ?? {}) as { status?: unknown; id?: unknown }
      if (status === 'ok' && typeof id === 'string') return { status: 'ok', id }
      if (status === 'error') return { status: 'error', reason: ExpoPushSender.failureOf(entry) }
      return undefined
    })
    return tickets.every((t) => t !== undefined) ? tickets : undefined
  }

  private static receiptOf(entry: unknown): PushReceipt | undefined {
    const { status } = (entry ?? {}) as { status?: unknown }
    if (status === 'ok') return { status: 'ok' }
    if (status === 'error') return { status: 'error', reason: ExpoPushSender.failureOf(entry) }
    return undefined
  }

  /** Expo's `details.error` is the reason; its `message` is free text that echoes tokens, so it is never read. */
  private static failureOf(entry: unknown): PushFailure {
    const code = (entry as { details?: { error?: unknown } } | null)?.details?.error
    if (code === 'DeviceNotRegistered') return 'device-not-registered'
    if (code === 'MessageRateExceeded') return 'rate-limited'
    if (code === 'InvalidCredentials' || code === 'MismatchSenderId') return 'misconfigured'
    return 'other'
  }
}
