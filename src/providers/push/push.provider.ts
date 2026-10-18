/** What a phone is told. Text is generic by decision: it shows on a lock screen. */
export type PushMessage = {
  /** The device's Expo push token; see `isExpoPushToken`. */
  to: string
  title: string
  body: string
  /** Handed to the app on tap. The provider does not look inside it; its shape belongs to the notifications module. */
  data: Record<string, unknown>
}

export type PushFailure =
  /** The token is dead (app uninstalled, token revoked): delete it. */
  | 'device-not-registered'
  /** Expo is throttling sends to this device; the same message may work later. */
  | 'rate-limited'
  /** The vendor could not take it right now (down, throttling us, unreachable); the same message may work later. */
  | 'unavailable'
  /** Our own setup is wrong (credentials, sender id), so retrying cannot help until someone fixes it. */
  | 'misconfigured'
  /** Any other per-message reason (too big, a reply we could not read, one Expo invented since). */
  | 'other'

/** Expo's immediate answer to one message. An `ok` id is what `receipts` is asked about later. */
export type PushTicket = { status: 'ok'; id: string } | { status: 'error'; reason: PushFailure }

/** Expo's later answer, once it has handed the message to Apple or Google. */
export type PushReceipt = { status: 'ok' } | { status: 'error'; reason: PushFailure }

/**
 * Sends push notifications. A failure that is about one message comes back in its ticket or receipt.
 * A failure of the call's FIRST request throws: PushUnavailableError when trying again later may
 * work, any other Error when our own setup is wrong and a human must fix it. Once a request has gone
 * out, a later failure no longer throws, since a retry would resend what already went: the messages it
 * covered come back as `unavailable` or `misconfigured` tickets (receipts: absent), so the caller
 * keeps what was sent.
 */
export interface PushSender {
  /** One ticket per message, in message order. */
  send(messages: PushMessage[]): Promise<PushTicket[]>
  /** Receipts by ticket id. An id the vendor has no receipt for yet, or whose request failed after the first, is left out. */
  receipts(ids: string[]): Promise<Record<string, PushReceipt>>
}

/** The vendor is down, throttling us, unreachable, or answered something unreadable; the same call may work later. */
export class PushUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PushUnavailableError'
  }
}

const EXPO_PUSH_TOKEN = /^Expo(?:nent)?PushToken\[[^\]\s]+\]$/
const MAX_PUSH_TOKEN_LENGTH = 256

/**
 * Whether `token` has the shape of an Expo push token: no whitespace anywhere, at most 256 characters.
 * Pure, and here so services can use it without importing an adapter.
 */
export const isExpoPushToken = (token: string): boolean =>
  token.length <= MAX_PUSH_TOKEN_LENGTH && EXPO_PUSH_TOKEN.test(token)
