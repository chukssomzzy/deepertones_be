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

// Meta's free text can echo the recipient and the message, so the stub does too: only the numeric code may reach our errors.
const metaError = (code: number, status: number) =>
  new Response(
    JSON.stringify({
      error: {
        message: `Meta says ${code} for 2348031234567`,
        type: 'OAuthException',
        code,
        error_data: { details: 'could not send 482913 to 2348031234567' },
        fbtrace_id: 'trace',
      },
    }),
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

  it('keeps the access token out of the delivery when it is serialised or spread', () => {
    const { delivery } = make(() => json(SUCCESS_BODY))

    expect(JSON.stringify(delivery)).not.toContain(ACCESS_TOKEN)
    expect(JSON.stringify({ ...delivery })).not.toContain(ACCESS_TOKEN)
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
    ['Meta code 1 (possible server error)', () => metaError(1, 400)],
    ['Meta code 2 (temporary downtime)', () => metaError(2, 400)],
    ['Meta code 131000 (unknown error, Meta says retry)', () => metaError(131000, 400)],
    ['Meta code 131016 (service temporarily unavailable)', () => metaError(131016, 400)],
    ['Meta code 131057 (account in maintenance mode)', () => metaError(131057, 400)],
    ['Meta code 133004 (server temporarily unavailable)', () => metaError(133004, 400)],
    ['Meta code 2494100 (phone number in maintenance mode)', () => metaError(2494100, 400)],
  ])('reports unavailable on %s', async (_label, respond) => {
    const { delivery } = make(respond)

    const error = await caught(delivery.send(TO, '482913'))

    expect(error).toBeInstanceOf(OtpDeliveryError)
    expect(error).toMatchObject({ reason: 'unavailable' })
  })

  it.each([
    ['131026 (undeliverable)', 131026],
    ['131030 (recipient not in allowed list)', 131030],
    ['130403 (blocked between the business and this user)', 130403],
    ['131021 (sender and recipient are the same number)', 131021],
  ])('reports recipient-rejected on Meta code %s', async (_label, code) => {
    const { delivery } = make(() => metaError(code, 400))

    const error = await caught(delivery.send(TO, '482913'))

    expect(error).toBeInstanceOf(OtpDeliveryError)
    expect(error).toMatchObject({ reason: 'recipient-rejected' })
  })

  it.each([
    ['a bad token', 190, 401],
    ['a missing template', 132001, 404],
    ['a messaging limit from template policy violations', 131064, 400],
    ['an unsupported or misspelled parameter', 100, 400],
    ['a business account restricted for a policy violation', 368, 400],
  ])(
    'reports misconfigured with the Meta code for %s, never leaking the token, the phone or the code',
    async (_label, code, status) => {
      const { delivery } = make(() => metaError(code, status))

      const error = await caught(delivery.send(TO, '482913'))

      expect(error).toBeInstanceOf(OtpDeliveryError)
      expect(error).toMatchObject({ reason: 'misconfigured' })
      const message = (error as Error).message
      expect(message).toContain(String(code))
      expect(message).toContain(String(status))
      expect(message).not.toContain(ACCESS_TOKEN)
      expect(message).not.toContain('2348031234567')
      expect(message).not.toContain('482913')
    },
  )

  it.each([400, 401, 403])(
    'reports misconfigured with the HTTP status for a non-JSON %i body, never leaking the token, the phone or the code',
    async (status) => {
      const { delivery } = make(() => new Response('Bad Request: 482913 to 2348031234567', { status }))

      const error = await caught(delivery.send(TO, '482913'))

      expect(error).toBeInstanceOf(OtpDeliveryError)
      expect(error).toMatchObject({ reason: 'misconfigured' })
      const message = (error as Error).message
      expect(message).toContain(String(status))
      expect(message).not.toContain(ACCESS_TOKEN)
      expect(message).not.toContain('2348031234567')
      expect(message).not.toContain('482913')
    },
  )

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

    it('reports misconfigured naming WHATSAPP_PHONE_NUMBER_ID, without calling Meta', async () => {
      const { delivery, calls } = make(() => json(SUCCESS_BODY), '')

      const error = await caught(delivery.send(TO, '482913'))

      expect(error).toBeInstanceOf(OtpDeliveryError)
      expect(error).toMatchObject({ reason: 'misconfigured' })
      expect((error as Error).message).toContain('WHATSAPP_PHONE_NUMBER_ID')
      expect(calls).toEqual([])
    })
  })

  describe('with an empty access token', () => {
    it('reports misconfigured naming WHATSAPP_ACCESS_TOKEN, without calling Meta', async () => {
      const { calls } = make(() => json(SUCCESS_BODY))
      const delivery = new MetaWhatsAppOtpDelivery({
        accessToken: '',
        phoneNumberId: PHONE_NUMBER_ID,
        templateName: 'otp_login',
        languageCode: 'en_US',
      })

      const error = await caught(delivery.send(TO, '482913'))

      expect(error).toBeInstanceOf(OtpDeliveryError)
      expect(error).toMatchObject({ reason: 'misconfigured' })
      expect((error as Error).message).toContain('WHATSAPP_ACCESS_TOKEN')
      expect(calls).toEqual([])
    })
  })
})
