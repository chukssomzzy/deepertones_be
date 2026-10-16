import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseEmailAddress } from '../../lib/email-address'
import { EmailDeliveryError, type EmailMessage } from './email.provider'
import { ZeptoMailEmailSender } from './zeptomail.email'

const API_URL = 'https://api.zeptomail.example/v1.1/email'
const API_KEY = 'wSsVR-super-secret-key'
const TO = parseEmailAddress('Ada@Example.com')
const HTML = '<p>Private html body 482913</p>'
const TEXT = 'Private text body 482913'

const MESSAGE: EmailMessage = {
  to: TO,
  subject: 'Your code',
  html: HTML,
  text: TEXT,
  reference: 'challenge-1',
}

const SUCCESS_BODY = {
  data: [{ code: 'EM_104', additional_info: [], message: 'Email request received' }],
  message: 'OK',
  request_id: 'req-1',
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const zeptoError = (
  status: number,
  code: string,
  details: { code: string; target?: string; message?: string }[],
) =>
  json(
    {
      error: {
        code,
        details: details.map((d) => ({ message: 'Invalid value', target_value: 'x', ...d })),
        message: 'Invalid Data',
        request_id: 'r',
      },
    },
    status,
  )

type Call = { url: string; init: RequestInit }

const config = { apiUrl: API_URL, apiKey: API_KEY, fromAddress: 'noreply@deepertones.com', fromName: 'Deeper Tones' }

const make = (respond: () => Response | Promise<Response>, overrides: Partial<typeof config> = {}) => {
  const calls: Call[] = []
  const stub = async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return respond()
  }
  vi.stubGlobal('fetch', stub)
  const sender = new ZeptoMailEmailSender({ ...config, ...overrides })
  return { sender, calls }
}

const caught = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the promise to reject')
}

describe('ZeptoMailEmailSender.send', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('keeps the API key out of the sender when it is serialised or spread', () => {
    const { sender } = make(() => json(SUCCESS_BODY))

    expect(JSON.stringify(sender)).not.toContain(API_KEY)
    expect(JSON.stringify({ ...sender })).not.toContain(API_KEY)
  })

  it('posts the message to the ZeptoMail API with the expected headers and body', async () => {
    const { sender, calls } = make(() => json(SUCCESS_BODY))

    await expect(sender.send(MESSAGE)).resolves.toBeUndefined()

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.url).toBe(API_URL)
    expect(call.init.method).toBe('POST')
    const headers = new Headers(call.init.headers)
    expect(headers.get('Authorization')).toBe(`Zoho-enczapikey ${API_KEY}`)
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('Accept')).toBe('application/json')
    expect(JSON.parse(call.init.body as string)).toEqual({
      from: { address: 'noreply@deepertones.com', name: 'Deeper Tones' },
      to: [{ email_address: { address: TO } }],
      subject: 'Your code',
      htmlbody: HTML,
      textbody: TEXT,
      client_reference: 'challenge-1',
      track_opens: false,
      track_clicks: false,
    })
  })

  it('omits client_reference when there is no reference', async () => {
    const { sender, calls } = make(() => json(SUCCESS_BODY))

    await sender.send({ ...MESSAGE, reference: undefined })

    const body = JSON.parse(calls[0]!.init.body as string)
    expect('client_reference' in body).toBe(false)
  })

  it('reports recipient-rejected when ZeptoMail rejects the to address', async () => {
    const { sender } = make(() => zeptoError(400, 'TM_4001', [{ code: 'SM_113', target: 'to' }]))

    const error = await caught(sender.send(MESSAGE))

    expect(error).toBeInstanceOf(EmailDeliveryError)
    expect(error).toMatchObject({ reason: 'recipient-rejected' })
  })

  it('reports misconfigured when ZeptoMail rejects our from address (our config is wrong)', async () => {
    const { sender } = make(() => zeptoError(400, 'TM_4001', [{ code: 'SM_113', target: 'from' }]))

    const error = await caught(sender.send(MESSAGE))

    expect(error).toBeInstanceOf(EmailDeliveryError)
    expect(error).toMatchObject({ reason: 'misconfigured' })
  })

  it.each([
    ['HTTP 429', () => new Response('slow down', { status: 429 })],
    ['HTTP 500', () => new Response('oops', { status: 500 })],
    ['HTTP 503', () => new Response('oops', { status: 503 })],
  ])('reports unavailable on %s', async (_label, respond) => {
    const { sender } = make(respond)

    const error = await caught(sender.send(MESSAGE))

    expect(error).toBeInstanceOf(EmailDeliveryError)
    expect(error).toMatchObject({ reason: 'unavailable' })
  })

  it('reports unavailable when the network request fails', async () => {
    const { sender } = make(() => Promise.reject(new TypeError('network down')))

    const error = await caught(sender.send(MESSAGE))

    expect(error).toBeInstanceOf(EmailDeliveryError)
    expect(error).toMatchObject({ reason: 'unavailable' })
  })

  it('reports unavailable instead of hanging when ZeptoMail never answers', async () => {
    let signal: AbortSignal | null | undefined
    const hanging = (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        signal = init?.signal
        signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    vi.stubGlobal('fetch', hanging)
    const sender = new ZeptoMailEmailSender({ ...config, timeoutMs: 10 })

    const error = await caught(sender.send(MESSAGE))

    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal!.aborted).toBe(true)
    expect(error).toBeInstanceOf(EmailDeliveryError)
    expect(error).toMatchObject({ reason: 'unavailable' })
  })

  it('reports misconfigured with the HTTP status and ZeptoMail codes for a bad API key, never leaking secrets or content', async () => {
    const { sender } = make(() =>
      json(
        { error: { code: 'TM_3601', details: [{ code: 'SERR_157', message: 'Invalid API Token found' }] } },
        401,
      ),
    )

    const error = await caught(sender.send(MESSAGE))

    expect(error).toBeInstanceOf(EmailDeliveryError)
    expect(error).toMatchObject({ reason: 'misconfigured' })
    const message = (error as Error).message
    expect(message).toContain('401')
    expect(message).toContain('TM_3601')
    expect(message).toContain('SERR_157')
    expect(message).not.toContain(API_KEY)
    expect(message).not.toContain(TO)
    expect(message).not.toContain(HTML)
    expect(message).not.toContain(TEXT)
  })

  it.each([
    ['no credits', 'TM_5001', 'LE_101'],
    ['credits exhausted', 'TM_5001', 'LE_102'],
    ['domain not verified', 'TM_4001', 'SM_111'],
    ['account not approved (SM_128)', 'TM_4001', 'SM_128'],
    ['account not approved (SM_133)', 'TM_4001', 'SM_133'],
  ])('reports misconfigured with the codes when %s', async (_label, code, detailCode) => {
    const { sender } = make(() => zeptoError(400, code, [{ code: detailCode }]))

    const error = await caught(sender.send(MESSAGE))

    expect(error).toBeInstanceOf(EmailDeliveryError)
    expect(error).toMatchObject({ reason: 'misconfigured' })
    expect((error as Error).message).toContain(code)
    expect((error as Error).message).toContain(detailCode)
    expect((error as Error).message).not.toContain(API_KEY)
  })

  it('reports misconfigured for any other rejection, even one with no ZeptoMail codes', async () => {
    const { sender } = make(() => new Response('forbidden', { status: 403 }))

    const error = await caught(sender.send(MESSAGE))

    expect(error).toBeInstanceOf(EmailDeliveryError)
    expect(error).toMatchObject({ reason: 'misconfigured' })
    expect((error as Error).message).toContain('403')
  })

  it('reports misconfigured but drops vendor codes that are not code-shaped, so free text never reaches the message', async () => {
    const { sender } = make(() => zeptoError(400, 'ada@example.com', [{ code: 'ada@example.com' }]))

    const error = await caught(sender.send(MESSAGE))

    expect(error).toBeInstanceOf(EmailDeliveryError)
    expect(error).toMatchObject({ reason: 'misconfigured' })
    expect((error as Error).message).toContain('400')
    expect((error as Error).message).not.toContain('ada@example.com')
  })

  it.each([
    ['apiUrl', 'ZEPTOMAIL_API_URL'],
    ['apiKey', 'ZEPTOMAIL_API_KEY'],
  ] as const)('reports misconfigured naming the %s setting when it is empty, without calling ZeptoMail', async (key, setting) => {
    const { sender, calls } = make(() => json(SUCCESS_BODY), { [key]: '' })

    const error = await caught(sender.send(MESSAGE))

    expect(error).toBeInstanceOf(EmailDeliveryError)
    expect(error).toMatchObject({ reason: 'misconfigured' })
    expect((error as Error).message).toContain(setting)
    expect(calls).toEqual([])
  })
})
