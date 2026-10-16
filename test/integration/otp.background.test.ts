import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { D1JobRunsRepository } from '../../src/jobs/job-runs.repository'
import { createDb } from '../../src/lib/db'
import { D1OtpRepository } from '../../src/modules/otp/otp.repository'
import { OtpService } from '../../src/modules/otp/otp.service'
import { MemoryEmailSender } from '../../src/providers/email/memory.email'
import { MemoryJobQueue } from '../../src/providers/job-queue/memory.job-queue'
import { MemoryOtpDelivery } from '../../src/providers/otp-delivery/memory.otp-delivery'
import worker from '../../src/index'

const CODE = '4829'
const MAIN = 'deepertones-otp-delivery-development'
const DEAD_LETTER = 'deepertones-otp-delivery-dlq-development'
const ZEPTO_URL = 'https://zeptomail.test/v1.1/email'
// Set here rather than read from wrangler.jsonc, so the test says what the Worker is configured with.
const WORKER_ENV = {
  ...env,
  WHATSAPP_PHONE_NUMBER_ID: '123',
  OTP_CHANNELS: 'email,whatsapp',
  EMAIL_FROM_ADDRESS: 'noreply@deepertones.test',
  EMAIL_FROM_NAME: 'Deeper Tones',
  ZEPTOMAIL_API_URL: ZEPTO_URL,
  ZEPTOMAIL_API_KEY: 'test-key',
}

const SUCCESS = { messaging_product: 'whatsapp', contacts: [{ input: 'x', wa_id: 'x' }], messages: [{ id: 'wamid.X' }] }
const metaError = (code: number, status: number) =>
  Response.json({ error: { message: `Meta says ${code}`, type: 'OAuthException', code, fbtrace_id: 't' } }, { status })

let phoneCounter = 0
const runSalt = String(Math.floor(Math.random() * 1e5)).padStart(5, '0')
const freshPhone = () => `+234807${runSalt}${String(phoneCounter++).padStart(2, '0')}`

let emailCounter = 0
const freshEmail = () => `Background-${runSalt}-${emailCounter++}@Example.com`

const ZEPTO_SUCCESS = { data: [{ code: 'EM_104', message: 'Email request received' }], message: 'OK', request_id: 'r' }
const zeptoRejectsRecipient = () =>
  Response.json(
    { error: { code: 'TM_3201', message: 'Invalid Data', request_id: 'r', details: [{ code: 'SM_113', target: 'to', message: 'bad' }] } },
    { status: 400 },
  )

const zeptoRejectsSenderDomain = () =>
  Response.json(
    { error: { code: 'TM_4001', message: 'Invalid Data', request_id: 'r', details: [{ code: 'SM_111', message: 'Sender domain not verified' }] } },
    { status: 400 },
  )

const metaCalls: { body: { to: string; template: { components: { parameters: { text: string }[] }[] } } }[] = []
const zeptoCalls: { body: { to: { email_address: { address: string } }[]; subject: string; htmlbody: string; textbody: string; client_reference: string } }[] = []

// The only two hosts the Worker may call; anything else fails the test. Each defaults to "not reachable in this test".
const stubProviders = (providers: { meta?: () => Response; zepto?: () => Response }) => {
  vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
    if (String(url) === ZEPTO_URL && providers.zepto) {
      zeptoCalls.push({ body: JSON.parse(init!.body as string) })
      return providers.zepto()
    }
    if (String(url).startsWith('https://graph.facebook.com/') && providers.meta) {
      metaCalls.push({ body: JSON.parse(init!.body as string) })
      return providers.meta()
    }
    throw new Error(`unexpected outbound request to ${String(url)}`)
  })
}
const stubMeta = (respond: () => Response) => stubProviders({ meta: respond })
const stubZepto = (respond: () => Response) => stubProviders({ zepto: respond })

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  metaCalls.length = 0
  zeptoCalls.length = 0
})

const makeService = () => {
  const jobs = new MemoryJobQueue()
  const service = new OtpService({
    repository: new D1OtpRepository(createDb(env.DB)),
    whatsapp: new MemoryOtpDelivery(),
    email: new MemoryEmailSender(),
    channels: ['email', 'whatsapp'],
    jobs,
    pepper: env.OTP_PEPPER,
    generateCode: () => CODE,
  })
  return { service, jobs }
}

const lastBody = (jobs: MemoryJobQueue) => jobs.enqueued.at(-1)!.body

const runQueue = async (queue: string, body: unknown, attempts = 1) => {
  const batch = createMessageBatch(queue, [{ id: 'm', timestamp: new Date(), attempts, body }])
  const retries = new Map<string, number | undefined>()
  for (const message of batch.messages) {
    const original = message.retry.bind(message)
    vi.spyOn(message, 'retry').mockImplementation((opts) => {
      retries.set(message.id, opts?.delaySeconds)
      original(opts)
    })
  }
  const ctx = createExecutionContext()
  await worker.queue!(batch, WORKER_ENV, ctx)
  const result = await getQueueResult(batch, ctx)
  return { result, retries }
}

describe('background WhatsApp OTP delivery through the Worker queue handler', () => {
  it('sends the code to WhatsApp, marks the challenge delivered and lets verify accept the code', async () => {
    const { service, jobs } = makeService()
    const phone = freshPhone()
    const { challengeId } = await service.send({ channel: 'whatsapp', address: phone })
    stubMeta(() => Response.json(SUCCESS))

    const { result } = await runQueue(MAIN, lastBody(jobs))

    expect(result.explicitAcks).toEqual(['m'])
    expect(metaCalls).toHaveLength(1)
    expect(metaCalls[0]!.body.to).toBe(phone.slice(1))
    expect(metaCalls[0]!.body.template.components[0]!.parameters[0]!.text).toBe(CODE)
    expect(await service.deliveryStatus(challengeId)).toEqual({ status: 'delivered', failureReason: null })
    expect(await service.verify({ channel: 'whatsapp', address: phone }, CODE)).toEqual({ channel: 'whatsapp', address: phone })
  })

  it('acks a second delivery of the same message without calling Meta again', async () => {
    const { service, jobs } = makeService()
    await service.send({ channel: 'whatsapp', address: freshPhone() })
    stubMeta(() => Response.json(SUCCESS))
    await runQueue(MAIN, lastBody(jobs))

    const { result } = await runQueue(MAIN, lastBody(jobs), 2)

    expect(result.explicitAcks).toEqual(['m'])
    expect(metaCalls).toHaveLength(1)
  })

  it('acks and records failure when Meta says the recipient cannot receive messages (131026)', async () => {
    const { service, jobs } = makeService()
    const { challengeId } = await service.send({ channel: 'whatsapp', address: freshPhone() })
    stubMeta(() => metaError(131026, 400))

    const { result } = await runQueue(MAIN, lastBody(jobs))

    expect(result.explicitAcks).toEqual(['m'])
    expect(result.retryMessages).toEqual([])
    expect(await service.deliveryStatus(challengeId)).toEqual({ status: 'failed', failureReason: 'recipient-rejected' })
  })

  it('retries with a numeric delay and keeps the challenge queued when Meta is down (503)', async () => {
    const { service, jobs } = makeService()
    const { challengeId } = await service.send({ channel: 'whatsapp', address: freshPhone() })
    stubMeta(() => new Response('unavailable', { status: 503 }))

    const { result, retries } = await runQueue(MAIN, lastBody(jobs))

    expect(result.retryMessages).toEqual([{ msgId: 'm' }])
    expect(result.explicitAcks).toEqual([])
    expect(retries.get('m')).toEqual(expect.any(Number))
    expect((await service.deliveryStatus(challengeId)).status).toBe('queued')
  })

  it('delivers on redelivery after a transient Meta failure', async () => {
    const { service, jobs } = makeService()
    const { challengeId } = await service.send({ channel: 'whatsapp', address: freshPhone() })
    stubMeta(() => new Response('unavailable', { status: 503 }))
    await runQueue(MAIN, lastBody(jobs))
    stubMeta(() => Response.json(SUCCESS))

    const { result } = await runQueue(MAIN, lastBody(jobs), 2)

    expect(result.explicitAcks).toEqual(['m'])
    expect((await service.deliveryStatus(challengeId)).status).toBe('delivered')
  })

  it('marks the challenge failed as unavailable when the message reaches the dead-letter queue', async () => {
    const { service, jobs } = makeService()
    const { challengeId } = await service.send({ channel: 'whatsapp', address: freshPhone() })
    stubMeta(() => Response.json(SUCCESS))

    const { result } = await runQueue(DEAD_LETTER, lastBody(jobs), 5)

    expect(result.explicitAcks).toEqual(['m'])
    expect(metaCalls).toEqual([])
    expect(await service.deliveryStatus(challengeId)).toEqual({ status: 'failed', failureReason: 'unavailable' })
  })

  it('acks a stale message without calling Meta when a newer code was requested for the phone', async () => {
    const { service, jobs } = makeService()
    const phone = freshPhone()
    await service.send({ channel: 'whatsapp', address: phone })
    const stale = lastBody(jobs)
    // The cooldown is real time here, so supersede through a second service with a later clock.
    const later = new OtpService({
      repository: new D1OtpRepository(createDb(env.DB)),
      whatsapp: new MemoryOtpDelivery(),
      email: new MemoryEmailSender(),
      channels: ['email', 'whatsapp'],
      jobs: new MemoryJobQueue(),
      pepper: env.OTP_PEPPER,
      generateCode: () => '999999',
      now: () => new Date(Date.now() + 2 * 60 * 1000),
    })
    await later.send({ channel: 'whatsapp', address: phone })
    stubMeta(() => Response.json(SUCCESS))

    const { result } = await runQueue(MAIN, stale)

    expect(result.explicitAcks).toEqual(['m'])
    expect(metaCalls).toEqual([])
  })

  it('acks a message for a challenge that has expired, without calling Meta', async () => {
    const jobs = new MemoryJobQueue()
    const past = new OtpService({
      repository: new D1OtpRepository(createDb(env.DB)),
      whatsapp: new MemoryOtpDelivery(),
      email: new MemoryEmailSender(),
      channels: ['email', 'whatsapp'],
      jobs,
      pepper: env.OTP_PEPPER,
      generateCode: () => CODE,
      now: () => new Date(Date.now() - 11 * 60 * 1000),
    })
    await past.send({ channel: 'whatsapp', address: freshPhone() })
    stubMeta(() => Response.json(SUCCESS))

    const { result } = await runQueue(MAIN, lastBody(jobs))

    expect(result.explicitAcks).toEqual(['m'])
    expect(metaCalls).toEqual([])
  })

  it('acks a message for a challenge that was already used, without calling Meta', async () => {
    const { service, jobs } = makeService()
    const phone = freshPhone()
    await service.send({ channel: 'whatsapp', address: phone })
    await service.verify({ channel: 'whatsapp', address: phone }, CODE)
    stubMeta(() => Response.json(SUCCESS))

    const { result } = await runQueue(MAIN, lastBody(jobs))

    expect(result.explicitAcks).toEqual(['m'])
    expect(metaCalls).toEqual([])
  })

  it('acks a message with a tampered sealed code as a permanent failure, without calling Meta', async () => {
    const { service, jobs } = makeService()
    await service.send({ channel: 'whatsapp', address: freshPhone() })
    const body = lastBody(jobs) as { challengeId: string; sealedCode: string }
    const i = 10
    const sealedCode = body.sealedCode.slice(0, i) + (body.sealedCode[i] === 'A' ? 'B' : 'A') + body.sealedCode.slice(i + 1)
    stubMeta(() => Response.json(SUCCESS))

    const { result } = await runQueue(MAIN, { ...body, sealedCode })

    expect(result.explicitAcks).toEqual(['m'])
    expect(result.retryMessages).toEqual([])
    expect(metaCalls).toEqual([])
    expect(await new D1JobRunsRepository(createDb(env.DB)).get('deliver-otp', body.challengeId)).toMatchObject({
      status: 'failed',
    })
  })

  it('keeps a delivered challenge delivered when a dead letter arrives for it', async () => {
    const { service, jobs } = makeService()
    const { challengeId } = await service.send({ channel: 'whatsapp', address: freshPhone() })
    stubMeta(() => Response.json(SUCCESS))
    await runQueue(MAIN, lastBody(jobs))

    const { result } = await runQueue(DEAD_LETTER, lastBody(jobs), 5)

    expect(result.explicitAcks).toEqual(['m'])
    expect(await service.deliveryStatus(challengeId)).toEqual({ status: 'delivered', failureReason: null })
  })
})

describe('background email OTP delivery through the Worker queue handler', () => {
  it('sends the code by ZeptoMail, marks the challenge delivered and lets verify accept the code', async () => {
    const { service, jobs } = makeService()
    const address = freshEmail()
    const { challengeId } = await service.send({ channel: 'email', address })
    stubZepto(() => Response.json(ZEPTO_SUCCESS))

    const { result } = await runQueue(MAIN, lastBody(jobs))

    expect(result.explicitAcks).toEqual(['m'])
    expect(zeptoCalls).toHaveLength(1)
    const sent = zeptoCalls[0]!.body
    expect(sent.to).toEqual([{ email_address: { address: address.toLowerCase() } }])
    expect(sent.client_reference).toBe(challengeId)
    expect(sent.subject).toBe(`${CODE} is your Deeper Tones sign-in code`)
    expect(sent.htmlbody).toContain(CODE)
    expect(sent.textbody).toContain(CODE)
    expect(sent.textbody).toContain('10 minutes')
    expect(metaCalls).toEqual([])
    expect(await service.deliveryStatus(challengeId)).toEqual({ status: 'delivered', failureReason: null })
    expect(await service.verify({ channel: 'email', address }, CODE)).toEqual({ channel: 'email', address: address.toLowerCase() })
  })

  it('acks a second delivery of the same message without calling ZeptoMail again', async () => {
    const { service, jobs } = makeService()
    await service.send({ channel: 'email', address: freshEmail() })
    stubZepto(() => Response.json(ZEPTO_SUCCESS))
    await runQueue(MAIN, lastBody(jobs))

    const { result } = await runQueue(MAIN, lastBody(jobs), 2)

    expect(result.explicitAcks).toEqual(['m'])
    expect(zeptoCalls).toHaveLength(1)
  })

  it('acks and records failure when ZeptoMail rejects the recipient address', async () => {
    const { service, jobs } = makeService()
    const { challengeId } = await service.send({ channel: 'email', address: freshEmail() })
    stubZepto(zeptoRejectsRecipient)

    const { result } = await runQueue(MAIN, lastBody(jobs))

    expect(result.explicitAcks).toEqual(['m'])
    expect(result.retryMessages).toEqual([])
    expect(await service.deliveryStatus(challengeId)).toEqual({ status: 'failed', failureReason: 'recipient-rejected' })
  })

  it('acks and records failure as unavailable when ZeptoMail reports a configuration error (SM_111)', async () => {
    const { service, jobs } = makeService()
    const { challengeId } = await service.send({ channel: 'email', address: freshEmail() })
    stubZepto(zeptoRejectsSenderDomain)

    const { result } = await runQueue(MAIN, lastBody(jobs))

    expect(result.explicitAcks).toEqual(['m'])
    expect(result.retryMessages).toEqual([])
    expect(zeptoCalls).toHaveLength(1)
    expect(await service.deliveryStatus(challengeId)).toEqual({ status: 'failed', failureReason: 'unavailable' })
    const run = await new D1JobRunsRepository(createDb(env.DB)).get('deliver-otp', challengeId)
    expect(run).toMatchObject({ status: 'failed' })
    expect(run!.lastError).toContain('SM_111')
  })

  it('retries and keeps the challenge queued when ZeptoMail is down (503)', async () => {
    const { service, jobs } = makeService()
    const { challengeId } = await service.send({ channel: 'email', address: freshEmail() })
    stubZepto(() => new Response('unavailable', { status: 503 }))

    const { result, retries } = await runQueue(MAIN, lastBody(jobs))

    expect(result.retryMessages).toEqual([{ msgId: 'm' }])
    expect(result.explicitAcks).toEqual([])
    expect(retries.get('m')).toEqual(expect.any(Number))
    expect((await service.deliveryStatus(challengeId)).status).toBe('queued')
  })

  it('marks an email challenge failed as unavailable when its message reaches the dead-letter queue', async () => {
    const { service, jobs } = makeService()
    const { challengeId } = await service.send({ channel: 'email', address: freshEmail() })
    stubZepto(() => Response.json(ZEPTO_SUCCESS))

    const { result } = await runQueue(DEAD_LETTER, lastBody(jobs), 5)

    expect(result.explicitAcks).toEqual(['m'])
    expect(zeptoCalls).toEqual([])
    expect(await service.deliveryStatus(challengeId)).toEqual({ status: 'failed', failureReason: 'unavailable' })
  })
})
