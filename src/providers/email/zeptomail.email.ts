import { firstValueFrom } from 'rxjs'
import { type HttpResponse, HttpTransportError, requestJson$ } from '../../lib/http'
import { type EmailMessage, type EmailSender, EmailDeliveryError } from './email.provider'

/*
 * Codes meaning our own setup is wrong, so they surface as `misconfigured` (a bug or an account task,
 * not something the user can fix or a retry will cure). Any other rejection that is not the recipient
 * and not a 5xx or 429 is treated the same way:
 *   SERR_157         invalid API key
 *   SM_111           sender domain not verified
 *   LE_101, LE_102   no credits left / credits expired
 *   SM_128, SM_133   account not yet reviewed or approved to send
 */

export type ZeptoMailEmailSenderConfig = {
  /** Full send endpoint; the host depends on the ZeptoMail data centre the account lives in. */
  apiUrl: string
  apiKey: string
  fromAddress: string
  fromName: string
  /** Give up on ZeptoMail after this long; default 8000. */
  timeoutMs?: number
}

/** Sends through the ZeptoMail transactional email API. */
export class ZeptoMailEmailSender implements EmailSender {
  static readonly #DEFAULT_TIMEOUT_MS = 8000

  /** ZeptoMail detail code for a bad address; with target 'to' it is the recipient, otherwise our own sender. */
  static readonly #INVALID_ADDRESS_CODE = 'SM_113'

  // Vendor codes go into our error messages, so accept only code-shaped strings: a vendor that echoes
  // free text (an address, say) must never reach our logs.
  static readonly #CODE_SHAPE = /^[A-Z0-9_]{1,16}$/

  readonly #config: ZeptoMailEmailSenderConfig

  constructor(config: ZeptoMailEmailSenderConfig) {
    this.#config = config
  }

  async send(message: EmailMessage): Promise<void> {
    const { apiUrl, apiKey, fromAddress, fromName, timeoutMs = ZeptoMailEmailSender.#DEFAULT_TIMEOUT_MS } = this.#config
    // Empty until someone copies them from ZeptoMail; fail here (misconfigured) rather than send a bad request.
    if (!apiUrl) throw new EmailDeliveryError('misconfigured', 'ZEPTOMAIL_API_URL is not set')
    if (!apiKey) throw new EmailDeliveryError('misconfigured', 'ZEPTOMAIL_API_KEY is not set')
    let response: HttpResponse
    try {
      response = await firstValueFrom(
        requestJson$(apiUrl, {
          method: 'POST',
          timeoutMs,
          headers: {
            Authorization: `Zoho-enczapikey ${apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            from: { address: fromAddress, name: fromName },
            to: [{ email_address: { address: message.to } }],
            subject: message.subject,
            htmlbody: message.html,
            textbody: message.text,
            ...(message.reference !== undefined && { client_reference: message.reference }),
            track_opens: false,
            track_clicks: false,
          }),
        }),
      )
    } catch (error) {
      if (error instanceof HttpTransportError) {
        throw new EmailDeliveryError('unavailable', 'ZeptoMail request failed before a response')
      }
      throw error
    }
    if (response.ok) return

    const { code, details } = ZeptoMailEmailSender.#zeptoErrors(response.body)
    const codes = `code ${code ?? 'none'}, details ${details.map((d) => d.code).join(',') || 'none'}`
    if (details.some((d) => d.code === ZeptoMailEmailSender.#INVALID_ADDRESS_CODE && d.target === 'to')) {
      throw new EmailDeliveryError('recipient-rejected', `ZeptoMail rejected the recipient (HTTP ${response.status}, ${codes})`)
    }
    if (response.status >= 500 || response.status === 429) {
      throw new EmailDeliveryError('unavailable', `ZeptoMail unavailable (HTTP ${response.status}, ${codes})`)
    }
    // Anything else that is not the recipient means our own configuration or account is wrong (key, sender
    // domain, credits...): a human must fix it, so the caller should not retry.
    throw new EmailDeliveryError('misconfigured', `ZeptoMail send failed (HTTP ${response.status}, ${codes})`)
  }
  static #safeCode(value: unknown): string | undefined {
    return typeof value === 'string' && ZeptoMailEmailSender.#CODE_SHAPE.test(value) ? value : undefined
  }

  static #zeptoErrors(body: unknown): { code: string | undefined; details: { code: string; target?: string }[] } {
    const error = (body as { error?: { code?: unknown; details?: unknown } } | null)?.error
    const details = Array.isArray(error?.details) ? (error.details as unknown[]) : []
    return {
      code: ZeptoMailEmailSender.#safeCode(error?.code),
      details: details.flatMap((d) => {
        const { code, target } = (d ?? {}) as { code?: unknown; target?: unknown }
        const safe = ZeptoMailEmailSender.#safeCode(code)
        return safe ? [{ code: safe, ...(typeof target === 'string' && { target }) }] : []
      }),
    }
  }
}
