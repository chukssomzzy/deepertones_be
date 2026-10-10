import { afterEach, describe, expect, it, vi } from 'vitest'
import { parsePhoneNumber } from '../../lib/phone'
import { OtpDeliveryError } from './otp-delivery.provider'
import { MetaWhatsAppOtpDelivery } from './meta-whatsapp.otp-delivery'

const ACCESS_TOKEN = 'EAAG-super-secret-token'
const PHONE_NUMBER_ID = '1098765432'
const TO = parsePhoneNumber('0803 123 4567')

const SUCCESS_BODY = {
  messaging_product: 'whatsapp',
  contacts: [{ input: '2348031234567', wa_id: '2348031234567' }],
  messages: [{ id: 'wamid.X' }],
}

const metaError = (code: number, status: number) =>
  new Response(
    JSON.stringify({ error: { message: `Meta says ${code}`, type: 'OAuthException', code, fbtrace_id: 'trace' } }),
    { status, headers: { 'Content-Type': 'application/json' } },
  )

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

type Call = { url: string; init: RequestInit }

const make = (respond: () => Response | Promise<Response>, phoneNumberId = PHONE_NUMBER_ID) => {
  const calls: Call[] = []
  const stub = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return respond()
  }
  vi.stubGlobal('fetch', stub)
  const delivery = new MetaWhatsAppOtpDelivery({
    accessToken: ACCESS_TOKEN,
    phoneNumberId,
    templateName: 'otp_login',
    languageCode: 'en_US',
  })
  return { delivery, calls }
}

const caught = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the promise to reject')
}

describe('MetaWhatsAppOtpDelivery.send', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('posts the authentication template to the Graph API with the code in body and button', async () => {
    const { delivery, calls } = make(() => json(SUCCESS_BODY))

    await expect(delivery.send(TO, '482913')).resolves.toBeUndefined()

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.url).toBe(`https://graph.facebook.com/v25.0/${PHONE_NUMBER_ID}/messages`)
    expect(call.init.method).toBe('POST')
    const headers = new Headers(call.init.headers)
    expect(headers.get('Authorization')).toBe(`Bearer ${ACCESS_TOKEN}`)
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(JSON.parse(call.init.body as string)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '2348031234567',
      type: 'template',
      template: {
        name: 'otp_login',
        language: { code: 'en_US' },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: '482913' }] },
          { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '482913' }] },
        ],
      },
    })
  })

  it('reports unavailable when the network request fails', async () => {
    const { delivery } = make(() => Promise.reject(new TypeError('network down')))

    const error = await caught(delivery.send(TO, '482913'))

    expect(error).toBeInstanceOf(OtpDeliveryError)
    expect(error).toMatchObject({ reason: 'unavailable' })
  })

  it.each([
    ['HTTP 500', () => new Response('oops', { status: 500 })],
    ['HTTP 503', () => new Response('oops', { status: 503 })],
    ['HTTP 429', () => new Response('slow', { status: 429 })],
    ['Meta code 4 (app rate limit)', () => metaError(4, 400)],
    ['Meta code 80007 (WABA rate limit)', () => metaError(80007, 400)],
    ['Meta code 130429 (throughput)', () => metaError(130429, 400)],
    ['Meta code 131048 (spam rate limit)', () => metaError(131048, 400)],
    ['Meta code 131056 (pair rate limit)', () => metaError(131056, 400)],
  ])('reports unavailable on %s', async (_label, respond) => {
    const { delivery } = make(respond)

    const error = await caught(delivery.send(TO, '482913'))

    expect(error).toBeInstanceOf(OtpDeliveryError)
    expect(error).toMatchObject({ reason: 'unavailable' })
  })

  it.each([
    ['131026 (undeliverable)', 131026],
    ['131030 (recipient not in allowed list)', 131030],
  ])('reports recipient-rejected on Meta code %s', async (_label, code) => {
    const { delivery } = make(() => metaError(code, 400))

    const error = await caught(delivery.send(TO, '482913'))

    expect(error).toBeInstanceOf(OtpDeliveryError)
    expect(error).toMatchObject({ reason: 'recipient-rejected' })
  })

  it.each([
    ['a bad token', 190, 401],
    ['a missing template', 132001, 404],
  ])('throws a plain error with the Meta code for %s, never leaking the token', async (_label, code, status) => {
    const { delivery } = make(() => metaError(code, status))

    const error = await caught(delivery.send(TO, '482913'))

    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(OtpDeliveryError)
    expect((error as Error).message).toContain(String(code))
    expect((error as Error).message).not.toContain(ACCESS_TOKEN)
  })

  it.each([400, 401])('throws a plain error with the HTTP status for a non-JSON %i body, never leaking the token', async (status) => {
    const { delivery } = make(() => new Response('Bad Request', { status }))

    const error = await caught(delivery.send(TO, '482913'))

    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(OtpDeliveryError)
    expect((error as Error).message).toContain(String(status))
    expect((error as Error).message).not.toContain(ACCESS_TOKEN)
  })

  it('reports unavailable instead of hanging when Meta never answers', async () => {
    let signal: AbortSignal | null | undefined
    const hanging = (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        signal = init?.signal
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    vi.stubGlobal('fetch', hanging)
    const delivery = new MetaWhatsAppOtpDelivery({
      accessToken: ACCESS_TOKEN,
      phoneNumberId: PHONE_NUMBER_ID,
      templateName: 'otp_login',
      languageCode: 'en_US',
      timeoutMs: 10,
    })

    const error = await caught(delivery.send(TO, '482913'))

    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal!.aborted).toBe(true)
    expect(error).toBeInstanceOf(OtpDeliveryError)
    expect(error).toMatchObject({ reason: 'unavailable' })
  })

  describe('with an empty phone number id', () => {
    it('can be constructed', () => {
      expect(() => make(() => json(SUCCESS_BODY), '')).not.toThrow()
    })

    it('rejects send with a plain error naming WHATSAPP_PHONE_NUMBER_ID, without calling Meta', async () => {
      const { delivery, calls } = make(() => json(SUCCESS_BODY), '')

      const error = await caught(delivery.send(TO, '482913'))

      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(OtpDeliveryError)
      expect((error as Error).message).toContain('WHATSAPP_PHONE_NUMBER_ID')
      expect(calls).toEqual([])
    })
  })
})
