import { firstValueFrom } from 'rxjs'
import { type HttpResponse, HttpTransportError, requestJson$ } from '../../lib/http'
import type { PhoneNumber } from '../../lib/phone'
import { type OtpDelivery, OtpDeliveryError } from './otp-delivery.provider'

export type MetaWhatsAppOtpDeliveryConfig = {
  accessToken: string
  phoneNumberId: string
  templateName: string
  languageCode: string
  /** Give up on Meta after this long; default 8000. */
  timeoutMs?: number
}

/** Sends the code with an approved WhatsApp authentication template through the Cloud API. */
export class MetaWhatsAppOtpDelivery implements OtpDelivery {
  private static readonly GRAPH_API_VERSION = 'v25.0'
  private static readonly DEFAULT_TIMEOUT_MS = 8000

  /** Meta error codes meaning "this recipient cannot receive it": retrying the same number will not help. */
  private static readonly RECIPIENT_REJECTED_CODES = new Set([
    131026, // message undeliverable (not on WhatsApp, or has not accepted the terms / old app version)
    131030, // recipient not in the allowed list (the app is in test mode)
    130403, // blocked between the business and this user
    131021, // sender and recipient are the same number
  ])

  /** Meta error codes meaning "slow down": the same request may succeed later. */
  private static readonly RATE_LIMIT_CODES = new Set([
    4, // app-level API call rate limit
    80007, // WhatsApp Business Account rate limit
    130429, // Cloud API throughput limit reached
    131048, // spam rate limit hit
    131056, // too many messages from this business to this one recipient
  ])

  /** Meta error codes meaning a temporary problem on Meta's side: the same request may succeed later. */
  private static readonly TRANSIENT_CODES = new Set([
    1, // invalid request or possible server error; Meta says check platform status
    2, // temporary downtime or overload
    131000, // unknown error; Meta says retry
    131016, // service temporarily unavailable
    131057, // business account in maintenance mode
    133004, // server temporarily unavailable
    2494100, // phone number in maintenance mode
  ])

  // `#`, not `private`: it holds the access token, and a runtime-private field stays out of JSON.stringify and spreads.
  readonly #config: MetaWhatsAppOtpDeliveryConfig

  constructor(config: MetaWhatsAppOtpDeliveryConfig) {
    this.#config = config
  }

  async send(to: PhoneNumber, code: string): Promise<void> {
    const { accessToken, phoneNumberId, templateName, languageCode, timeoutMs = MetaWhatsAppOtpDelivery.DEFAULT_TIMEOUT_MS } = this.#config
    // Empty until someone copies it from Meta; fail here (misconfigured) rather than build a bad URL.
    if (!phoneNumberId) throw new OtpDeliveryError('misconfigured', 'WHATSAPP_PHONE_NUMBER_ID is not set')
    if (!accessToken) throw new OtpDeliveryError('misconfigured', 'WHATSAPP_ACCESS_TOKEN is not set')
    let response: HttpResponse
    try {
      response = await firstValueFrom(
        requestJson$(`https://graph.facebook.com/${MetaWhatsAppOtpDelivery.GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
          method: 'POST',
          timeoutMs,
          headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: to.slice(1),
            type: 'template',
            template: {
              name: templateName,
              language: { code: languageCode },
              components: [
                { type: 'body', parameters: [{ type: 'text', text: code }] },
                { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
              ],
            },
          }),
        }),
      )
    } catch (error) {
      if (error instanceof HttpTransportError) {
        throw new OtpDeliveryError('unavailable', 'WhatsApp request failed before a response')
      }
      throw error
    }
    if (response.ok) return

    const metaCode = MetaWhatsAppOtpDelivery.metaErrorCode(response.body)
    if (metaCode !== undefined && MetaWhatsAppOtpDelivery.RECIPIENT_REJECTED_CODES.has(metaCode)) {
      throw new OtpDeliveryError('recipient-rejected', `WhatsApp rejected the recipient (code ${metaCode})`)
    }
    if (
      response.status >= 500 ||
      response.status === 429 ||
      (metaCode !== undefined &&
        (MetaWhatsAppOtpDelivery.RATE_LIMIT_CODES.has(metaCode) || MetaWhatsAppOtpDelivery.TRANSIENT_CODES.has(metaCode)))
    ) {
      throw new OtpDeliveryError('unavailable', `WhatsApp unavailable (HTTP ${response.status}, code ${metaCode ?? 'none'})`)
    }
    // Anything else that is not the recipient or transient means our own setup is wrong (token,
    // permissions, template, phone number registration, billing, a policy restriction...): a human
    // must fix it, so the caller should not retry. That also catches codes we have not seen yet, so
    // a genuinely new, retryable Meta error would wrongly stop retrying until it is added to TRANSIENT_CODES.
    throw new OtpDeliveryError('misconfigured', `WhatsApp send failed (HTTP ${response.status}, code ${metaCode ?? 'none'})`)
  }

  private static metaErrorCode(body: unknown): number | undefined {
    const code = (body as { error?: { code?: unknown } } | null)?.error?.code
    return typeof code === 'number' ? code : undefined
  }
}
