import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { D1JobRunsRepository } from '../../src/jobs/job-runs.repository'
import { runAs } from '../../src/lib/context'
import { hmacSha256Hex } from '../../src/lib/crypto'
import { createDb } from '../../src/lib/db'
import { D1NotificationSettingsRepository, D1PushTokensRepository } from '../../src/modules/notifications/notifications.repository'
import { NotificationsService } from '../../src/modules/notifications/notifications.service'
import { D1ProfilesRepository } from '../../src/modules/profiles/profiles.repository'
import { D1UsersRepository } from '../../src/modules/users/users.repository'
import { MemoryJobQueue } from '../../src/providers/job-queue/memory.job-queue'
import { MemoryPushSender } from '../../src/providers/push/memory.push'
import worker from '../../src/index'

// The send-push and check-push-receipts jobs, driven through the Worker's real queue handler against local D1, with only Expo
// stubbed at fetch. The jobs' messages are built by hand (the triggers come later), and phones are registered through the real
// service. The receipts queue is replaced by a recorder so the receipt check the send job queues can be read back and then run.
const SEND_QUEUE = 'deepertones-push-delivery-development'
const RECEIPTS_QUEUE = 'deepertones-push-receipts-development'
const EXPO_SEND_URL = 'https://exp.host/--/api/v2/push/send'
const EXPO_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts'
// Set in vitest.config.ts for every test.
const EXPO_ACCESS_TOKEN = 'test-expo-token'
const RECEIPT_CHECK_DELAY_SECONDS = 900
const BASE = new Date('2030-06-15T12:00:00.000Z')

const db = createDb(env.DB)
const users = new D1UsersRepository(db)
const profiles = new D1ProfilesRepository(db)
const pushTokens = new D1PushTokensRepository(db)
const service = new NotificationsService({
  pushTokens,
  settings: new D1NotificationSettingsRepository(db),
  push: new MemoryPushSender(),
  jobs: new MemoryJobQueue(),
  deviceIdKey: env.DEVICE_ID_KEY,
})

type Account = { userId: string; profileId: string }
const account = async (): Promise<Account> => {
  const userId = crypto.randomUUID()
  const profileId = crypto.randomUUID()
  await users.createGuestForDevice({ user: { id: userId, createdAt: BASE }, device: { deviceHash: `push-bg-${userId}`, platform: 'ios' }, profile: { id: profileId } })
  return { userId, profileId }
}
const secondProfile = async (userId: string) => {
  const id = crypto.randomUUID()
  await profiles.insert({ id, userId, displayName: null, isDefault: false, createdAt: BASE })
  return id
}
const asAccount = <T>({ userId, profileId }: Account, fn: () => Promise<T>) => runAs({ kind: 'user', userId, status: 'anonymous', profileId }, fn)

/** Registers a phone the way the app does and returns what the tests need to find its row again. */
const registerPhone = async (who: Account) => {
  const deviceId = crypto.randomUUID()
  const token = `ExponentPushToken[${crypto.randomUUID()}]`
  await asAccount(who, () => service.register({ deviceId, platform: 'ios', token }))
  return { deviceId, token, deviceHash: await hmacSha256Hex(env.DEVICE_ID_KEY, deviceId) }
}

const sha256Hex = async (value: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))), (b) => b.toString(16).padStart(2, '0')).join('')

type ExpoMessage = { to: string; title: string; body: string; data: Record<string, unknown>; sound?: string }
type ExpoCall = { url: string; authorization: string | null; body: unknown }
const expoCalls: ExpoCall[] = []
const sendCalls = () => expoCalls.filter((call) => call.url === EXPO_SEND_URL)
const receiptCalls = () => expoCalls.filter((call) => call.url === EXPO_RECEIPTS_URL)

const deadTicket = { status: 'error', message: 'The recipient device is not registered', details: { error: 'DeviceNotRegistered' } }
const deadReceipt = deadTicket

type ExpoStub = {
  /** Answers a send request; by default every message gets an ok ticket with a fresh id. */
  send?: (messages: ExpoMessage[]) => Response
  receipts?: (ids: string[]) => Response
}
// The only two Expo endpoints the Worker may call; anything else fails the test.
const stubExpo = (stub: ExpoStub = {}) => {
  vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
    const call: ExpoCall = {
      url: String(url),
      authorization: new Headers(init?.headers).get('authorization'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    }
    if (call.url === EXPO_SEND_URL) {
      expoCalls.push(call)
      const messages = call.body as ExpoMessage[]
      return stub.send?.(messages) ?? Response.json({ data: messages.map(() => ({ status: 'ok', id: `ticket-${crypto.randomUUID()}` })) })
    }
    if (call.url === EXPO_RECEIPTS_URL && stub.receipts) {
      expoCalls.push(call)
      return stub.receipts((call.body as { ids: string[] }).ids)
    }
    throw new Error(`unexpected outbound request to ${call.url}`)
  })
}

// The Worker's producers: the receipts queue records what the send job queues; the delivery queue goes nowhere, since a real
// local queue would hand a message to whichever test is running by then.
const receiptMessages: { body: unknown; delaySeconds: number | undefined }[] = []
const recordingQueue = {
  send: async (body: unknown, options?: { delaySeconds?: number }) => {
    receiptMessages.push({ body, delaySeconds: options?.delaySeconds })
  },
  sendBatch: async () => {},
} as unknown as Queue
const quietQueue = { send: async () => {}, sendBatch: async () => {} } as unknown as Queue
const WORKER_ENV = { ...env, PUSH_DELIVERY_QUEUE: quietQueue, PUSH_RECEIPTS_QUEUE: recordingQueue } as typeof env

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  expoCalls.length = 0
  receiptMessages.length = 0
})

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

const finishedBody = (who: Account, scanId = crypto.randomUUID(), readyCount = 3) => ({
  kind: 'scan-finished',
  userId: who.userId,
  profileId: who.profileId,
  scanId,
  readyCount,
})

describe('background push delivery through the Worker queue handler', () => {
  it('sends a finished-scan push to the phone on the scan\'s profile, authenticated, and to no phone on another profile', async () => {
    const ada = await account()
    const phone = await registerPhone(ada)
    const otherProfile = { userId: ada.userId, profileId: await secondProfile(ada.userId) }
    await registerPhone(otherProfile)
    const scanId = crypto.randomUUID()
    stubExpo()

    const { result } = await runQueue(SEND_QUEUE, finishedBody(ada, scanId, 3))

    expect(result.explicitAcks).toEqual(['m'])
    expect(sendCalls()).toHaveLength(1)
    expect(sendCalls()[0]!.authorization).toBe(`Bearer ${EXPO_ACCESS_TOKEN}`)
    expect(sendCalls()[0]!.body).toEqual([
      {
        to: phone.token,
        title: 'Your scan is ready',
        body: '3 products analysed',
        sound: 'default',
        data: { url: `/scans/${scanId}`, kind: 'scan-finished', scanId, profileId: ada.profileId },
      },
    ])
  })

  it('queues one receipt check 15 minutes later for the accepted message, without the token', async () => {
    const ada = await account()
    const phone = await registerPhone(ada)
    stubExpo({ send: () => Response.json({ data: [{ status: 'ok', id: 'expo-ticket-1' }] }) })

    await runQueue(SEND_QUEUE, finishedBody(ada))

    expect(receiptMessages).toEqual([
      {
        body: { receipts: [{ ticketId: 'expo-ticket-1', deviceHash: phone.deviceHash, tokenHash: await sha256Hex(phone.token) }] },
        delaySeconds: RECEIPT_CHECK_DELAY_SECONDS,
      },
    ])
    expect(JSON.stringify(receiptMessages)).not.toContain(phone.token)
  })

  it('sends once when the same message is delivered twice', async () => {
    const ada = await account()
    await registerPhone(ada)
    const body = finishedBody(ada)
    stubExpo()
    await runQueue(SEND_QUEUE, body)

    const { result } = await runQueue(SEND_QUEUE, body, 2)

    expect(result.explicitAcks).toEqual(['m'])
    expect(sendCalls()).toHaveLength(1)
    expect(receiptMessages).toHaveLength(1)
  })

  it('sends nothing, and calls nobody, when the account turned finished-scan notifications off', async () => {
    const ada = await account()
    await registerPhone(ada)
    await asAccount(ada, () => service.updateSettings({ scanFinished: false }))
    stubExpo()

    const { result } = await runQueue(SEND_QUEUE, finishedBody(ada))

    expect(result.explicitAcks).toEqual(['m'])
    expect(result.retryMessages).toEqual([])
    expect(expoCalls).toEqual([])
    expect(receiptMessages).toEqual([])
  })

  it('deletes the phone Expo reports as not registered in its ticket, and keeps the account\'s other phone', async () => {
    const ada = await account()
    const dead = await registerPhone(ada)
    const alive = await registerPhone(ada)
    stubExpo({
      send: (messages) =>
        Response.json({ data: messages.map((message) => (message.to === dead.token ? deadTicket : { status: 'ok', id: `ticket-${crypto.randomUUID()}` })) }),
    })

    const { result } = await runQueue(SEND_QUEUE, finishedBody(ada))

    expect(result.explicitAcks).toEqual(['m'])
    expect(await pushTokens.find(dead.deviceHash)).toBeNull()
    expect(await pushTokens.find(alive.deviceHash)).toMatchObject({ token: alive.token })
  })

  it('retries, and sends nothing, when Expo is down (503)', async () => {
    const ada = await account()
    const phone = await registerPhone(ada)
    stubExpo({ send: () => new Response('unavailable', { status: 503 }) })

    const { result, retries } = await runQueue(SEND_QUEUE, finishedBody(ada))

    expect(result.retryMessages).toEqual([{ msgId: 'm' }])
    expect(result.explicitAcks).toEqual([])
    expect(retries.get('m')).toEqual(expect.any(Number))
    expect(receiptMessages).toEqual([])
    expect(await pushTokens.find(phone.deviceHash)).toMatchObject({ token: phone.token })
  })

  it('acks and records the run as failed, without retrying, when Expo refuses our access token (401)', async () => {
    const ada = await account()
    await registerPhone(ada)
    const body = finishedBody(ada)
    stubExpo({ send: () => Response.json({ errors: [{ code: 'UNAUTHORIZED', message: 'bad token' }] }, { status: 401 }) })

    const { result } = await runQueue(SEND_QUEUE, body)

    expect(result.explicitAcks).toEqual(['m'])
    expect(result.retryMessages).toEqual([])
    expect(await new D1JobRunsRepository(db).get('send-push', `scan-finished:${body.scanId}`)).toMatchObject({ status: 'failed' })
  })
})

describe('background push receipt checks through the Worker queue handler', () => {
  /** A send whose ticket is ok, then the receipt-check message the send job queued, as the queue would hand it over. */
  const sendAndTakeReceiptCheck = async (who: Account) => {
    const phone = await registerPhone(who)
    stubExpo({ send: () => Response.json({ data: [{ status: 'ok', id: `ticket-${crypto.randomUUID()}` }] }) })
    await runQueue(SEND_QUEUE, finishedBody(who))
    expect(receiptMessages).toHaveLength(1)
    return { phone, check: receiptMessages[0]!.body }
  }
  const receiptsSaying = (receipt: unknown) => (ids: string[]) => Response.json({ data: Object.fromEntries(ids.map((id) => [id, receipt])) })

  it('deletes the phone whose receipt says it is not registered', async () => {
    const ada = await account()
    const { phone, check } = await sendAndTakeReceiptCheck(ada)
    stubExpo({ receipts: receiptsSaying(deadReceipt) })

    const { result } = await runQueue(RECEIPTS_QUEUE, check)

    expect(result.explicitAcks).toEqual(['m'])
    expect(receiptCalls()).toHaveLength(1)
    expect(receiptCalls()[0]!.authorization).toBe(`Bearer ${EXPO_ACCESS_TOKEN}`)
    expect(receiptCalls()[0]!.body).toEqual({ ids: (check as { receipts: { ticketId: string }[] }).receipts.map((r) => r.ticketId) })
    expect(await pushTokens.find(phone.deviceHash)).toBeNull()
  })

  it('keeps a phone that registered a new token since the send', async () => {
    const ada = await account()
    const { phone, check } = await sendAndTakeReceiptCheck(ada)
    const fresh = `ExponentPushToken[${crypto.randomUUID()}]`
    await asAccount(ada, () => service.register({ deviceId: phone.deviceId, platform: 'ios', token: fresh }))
    stubExpo({ receipts: receiptsSaying(deadReceipt) })

    const { result } = await runQueue(RECEIPTS_QUEUE, check)

    expect(result.explicitAcks).toEqual(['m'])
    expect(await pushTokens.find(phone.deviceHash)).toMatchObject({ token: fresh })
  })

  it('keeps the phone when the receipt is ok', async () => {
    const ada = await account()
    const { phone, check } = await sendAndTakeReceiptCheck(ada)
    stubExpo({ receipts: receiptsSaying({ status: 'ok' }) })

    const { result } = await runQueue(RECEIPTS_QUEUE, check)

    expect(result.explicitAcks).toEqual(['m'])
    expect(await pushTokens.find(phone.deviceHash)).toMatchObject({ token: phone.token })
  })

  it('retries when Expo is down (503), and deletes the phone on the retry', async () => {
    const ada = await account()
    const { phone, check } = await sendAndTakeReceiptCheck(ada)
    stubExpo({ receipts: () => new Response('unavailable', { status: 503 }) })

    const first = await runQueue(RECEIPTS_QUEUE, check)
    expect(first.result.retryMessages).toEqual([{ msgId: 'm' }])
    expect(await pushTokens.find(phone.deviceHash)).toMatchObject({ token: phone.token })

    stubExpo({ receipts: receiptsSaying(deadReceipt) })
    const second = await runQueue(RECEIPTS_QUEUE, check, 2)

    expect(second.result.explicitAcks).toEqual(['m'])
    expect(await pushTokens.find(phone.deviceHash)).toBeNull()
  })
})
