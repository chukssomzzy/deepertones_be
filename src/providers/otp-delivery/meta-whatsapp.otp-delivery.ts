import { firstValueFrom } from 'rxjs'
import { type HttpResponse, HttpTransportError, requestJson$ } from '../../lib/http'
import type { PhoneNumber } from '../../lib/phone'
import { type OtpDelivery, OtpDeliveryError } from './otp-delivery.provider'

const GRAPH_API_VERSION = 'v25.0'
const DEFAULT_TIMEOUT_MS = 8000

/** Meta error codes meaning "this recipient cannot receive it": retrying the same number will not help. */
const RECIPIENT_REJECTED_CODES = new Set([
  131026, // message undeliverable (not on WhatsApp, or has not accepted the terms / old app version)
  131030, // recipient not in the allowed list (the app is in test mode)
])

/** Meta error codes meaning "slow down": the same request may succeed later. */
const RATE_LIMIT_CODES = new Set([
  4, // app-level API call rate limit
  80007, // WhatsApp Business Account rate limit
  130429, // Cloud API throughput limit reached
  131048, // spam rate limit hit
  131056, // too many messages from this business to this one recipient
])

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
  constructor(private readonly config: MetaWhatsAppOtpDeliveryConfig) {}

  async send(to: PhoneNumber, code: string): Promise<void> {
    const { accessToken, phoneNumberId, templateName, languageCode, timeoutMs = DEFAULT_TIMEOUT_MS } = this.config
    // Empty until someone copies it from Meta; fail here (a bug to fix) rather than build a bad URL.
    if (!phoneNumberId) throw new Error('WHATSAPP_PHONE_NUMBER_ID is not set')
    if (!accessToken) throw new Error('WHATSAPP_ACCESS_TOKEN is not set')
    let response: HttpResponse
    try {
      response = await firstValueFrom(
        requestJson$(`https://graph.facebook.com/${GRAPH_API_VERSION}/${phoneNumberId}/messages`, {
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

    const metaCode = metaErrorCode(response.body)
    if (metaCode !== undefined && RECIPIENT_REJECTED_CODES.has(metaCode)) {
      throw new OtpDeliveryError('recipient-rejected', `WhatsApp rejected the recipient (code ${metaCode})`)
    }
    if (response.status >= 500 || response.status === 429 || (metaCode !== undefined && RATE_LIMIT_CODES.has(metaCode))) {
      throw new OtpDeliveryError('unavailable', `WhatsApp unavailable (HTTP ${response.status}, code ${metaCode ?? 'none'})`)
    }
    // Our own configuration is wrong (bad token, missing template...): a bug, not a user problem.
    throw new Error(`WhatsApp send failed (HTTP ${response.status}, code ${metaCode ?? 'none'})`)
  }
}

const metaErrorCode = (body: unknown): number | undefined => {
  const code = (body as { error?: { code?: unknown } } | null)?.error?.code
  return typeof code === 'number' ? code : undefined
}
