import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../../src/index'
import { createQueueHandler } from '../../src/jobs/dispatcher'
import { D1JobRunsRepository } from '../../src/jobs/job-runs.repository'
import { jobs } from '../../src/jobs/registry'
import { createDb } from '../../src/lib/db'
import { D1FaceScansRepository } from '../../src/modules/face-scans/face-scans.repository'
import { D1UsersRepository } from '../../src/modules/users/users.repository'
import { startFaceScan } from './face-scans.support'
import { glowOutput, queueRecorder, signedWebhook, skinSuccess, stubPerfectCorp } from './perfect-corp.stub'

// POST /api/v1/webhooks/perfect-corp through the Worker's real entrypoint: the signature check, which scan a task belongs to, what is queued, and
// that a webhook delivered twice runs the analysis once. Perfect Corp's side is the stub in ./perfect-corp.stub (the webhook is signed here, by an
// independent signer, with the secret the Worker is configured with). The face-scans queue's producer is a recorder.

const URL_PATH = '/api/v1/webhooks/perfect-corp'
const MAIN = `deepertones-face-scans-${env.ENVIRONMENT}`
const JOB = 'analyse-face-scan'
/** The webhook route reads at most this many bytes, whatever the sender says. */
const MAX_WEBHOOK_BODY_BYTES = 64 * 1024

const queue = queueRecorder()
const WORKER_ENV = { ...env, FACE_SCANS_QUEUE: queue.queue }
const db = createDb(env.DB)
const users = new D1UsersRepository(db)
const faces = new D1FaceScansRepository(db)
const runs = new D1JobRunsRepository(db)

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  queue.messages.length = 0
  queue.state.failing = false
})

const runSalt = String(Math.floor(Math.random() * 1e6))
let counter = 0
const freshIp = () => {
  const n = counter++
  return `10.${(Number(runSalt) + 21) % 250}.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`
}

const fetchWorker = (path: string, init?: RequestInit) => worker.fetch!(new Request(`http://deepertones.test${path}`, init) as never, WORKER_ENV, createExecutionContext())
type Delivery = Awaited<ReturnType<typeof signedWebhook>>
const deliver = (delivery: Pick<Delivery, 'body' | 'headers'>, ip = freshIp()) =>
  fetchWorker(URL_PATH, { method: 'POST', body: delivery.body, headers: { ...delivery.headers, 'cf-connecting-ip': ip } })
/** The answer is `{ received: true }`, either bare or in the API's usual envelope. */
const receivedOf = async (res: Response) => {
  const body = (await res.json()) as { received?: boolean; data?: { received?: boolean } }
  return body.received ?? body.data?.received
}
const errorCodeOf = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code

/** A guest with an analysing face scan whose tasks Perfect Corp has been given: what the upload step leaves behind. */
const scanWithTasks = async (tasks: { analysis?: string; fitzpatrick?: string; environment?: string }) => {
  const userId = crypto.randomUUID()
  const profileId = crypto.randomUUID()
  const createdAt = new Date()
  await users.createGuestForDevice({ user: { id: userId, createdAt }, device: { deviceHash: `face-webhook-${userId}`, platform: 'ios' }, profile: { id: profileId } })
  const id = crypto.randomUUID()
  await faces.createFaceScan(
    { id, userId, profileId, goalAtScan: 'glow', createdAt },
    [{ faceScanId: id, userId, position: 'front', photoKey: `faces/${env.ENVIRONMENT}/${userId}/${profileId}/${id}/front.jpg`, createdAt }],
  )
  await faces.updateFaceScan(id, 'analysing', {
    ...(tasks.analysis ? { pcAnalysisTaskId: tasks.analysis } : {}),
    ...(tasks.fitzpatrick ? { pcFitzpatrickTaskId: tasks.fitzpatrick } : {}),
    pcEnvironment: tasks.environment ?? env.ENVIRONMENT,
    updatedAt: createdAt,
  })
  return { id, userId, profileId }
}
const taskId = (kind: string) => `${kind}-${crypto.randomUUID()}`

describe('POST /api/v1/webhooks/perfect-corp: a delivery that checks out', () => {
  it('answers 200 { received: true } and queues the fetch step for the scan whose analysis task it is, carrying the webhook id and the time it came', async () => {
    const analysis = taskId('skin')
    const scan = await scanWithTasks({ analysis })
    const delivery = await signedWebhook(analysis)
    const before = Date.now()

    const res = await deliver(delivery)

    expect(res.status).toBe(200)
    expect(await receivedOf(res)).toBe(true)
    expect(queue.messages).toHaveLength(1)
    expect(queue.messages[0]).toEqual({ faceScanId: scan.id, step: 'fetch', at: expect.any(Number), webhookId: delivery.webhookId })
    const { at } = queue.messages[0] as { at: number }
    expect(at).toBeGreaterThanOrEqual(before)
    expect(at).toBeLessThanOrEqual(Date.now())
  })

  it('queues the fetch step for a delivery in camelCase, taskId and taskStatus, which is how Perfect Corp really sends the body', async () => {
    const analysis = taskId('skin')
    const scan = await scanWithTasks({ analysis })
    const real = JSON.stringify({ created_at: Math.floor(Date.now() / 1000), data: { taskId: analysis, taskStatus: 'success' } })
    const delivery = await signedWebhook(analysis, { body: real })

    const res = await deliver(delivery)

    expect(res.status).toBe(200)
    expect(await receivedOf(res)).toBe(true)
    expect(queue.messages).toEqual([{ faceScanId: scan.id, step: 'fetch', at: expect.any(Number), webhookId: delivery.webhookId }])
  })

  it('queues the fitzpatrick step for the scan whose Fitzpatrick task it is', async () => {
    const fitzpatrick = taskId('fitz')
    const scan = await scanWithTasks({ analysis: taskId('skin'), fitzpatrick })
    const delivery = await signedWebhook(fitzpatrick)

    const res = await deliver(delivery)

    expect(res.status).toBe(200)
    expect(queue.messages).toEqual([{ faceScanId: scan.id, step: 'fitzpatrick', at: expect.any(Number), webhookId: delivery.webhookId }])
  })

  it('queues the fetch step too when the task ended in an error, so the step can find out whether the photo was the problem', async () => {
    const analysis = taskId('skin')
    const scan = await scanWithTasks({ analysis })

    const res = await deliver(await signedWebhook(analysis, { taskStatus: 'error' }))

    expect(res.status).toBe(200)
    expect(queue.messages).toEqual([expect.objectContaining({ faceScanId: scan.id, step: 'fetch' })])
  })

  it('changes nothing about the scan itself: the webhook only queues', async () => {
    const analysis = taskId('skin')
    const scan = await scanWithTasks({ analysis })

    await deliver(await signedWebhook(analysis))

    expect(await faces.findFaceScan(scan.id)).toMatchObject({ state: 'analysing', reason: null, pcAnalysisTaskId: analysis })
  })

  it('answers 200 and queues nothing for a task no scan holds (a deleted scan\'s, or one of another environment\'s)', async () => {
    const res = await deliver(await signedWebhook(taskId('skin')))

    expect(res.status).toBe(200)
    expect(await receivedOf(res)).toBe(true)
    expect(queue.messages).toEqual([])
  })

  it('answers 200 and queues nothing for a task made in another environment, though the scan holds it', async () => {
    const analysis = taskId('skin')
    await scanWithTasks({ analysis, environment: `not-${env.ENVIRONMENT}` })

    const res = await deliver(await signedWebhook(analysis))

    expect(res.status).toBe(200)
    expect(queue.messages).toEqual([])
  })

  it('answers 503, so Perfect Corp sends it again, when the step cannot be queued, and queues it when the same delivery comes again', async () => {
    const analysis = taskId('skin')
    const scan = await scanWithTasks({ analysis })
    const delivery = await signedWebhook(analysis)
    queue.state.failing = true
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const failed = await deliver(delivery)
    queue.state.failing = false
    const again = await deliver(delivery)

    expect(failed.status).toBe(503)
    expect(again.status).toBe(200)
    expect(queue.messages).toEqual([expect.objectContaining({ faceScanId: scan.id, step: 'fetch', webhookId: delivery.webhookId })])
  })
})

describe('POST /api/v1/webhooks/perfect-corp: a delivery that does not check out', () => {
  const refused = async (res: Response) => {
    expect(res.status).toBe(401)
    expect(await errorCodeOf(res)).toBe('WEBHOOK_SIGNATURE_INVALID')
    expect(queue.messages).toEqual([])
  }

  it('is 401 WEBHOOK_SIGNATURE_INVALID when it was signed with another secret, and queues nothing, though the task is a real scan\'s', async () => {
    const analysis = taskId('skin')
    await scanWithTasks({ analysis })

    await refused(await deliver(await signedWebhook(analysis, { secret: 'whsec_' + btoa('some-other-secret-entirely-1234567') })))
  })

  it('is 401 when the body was changed after it was signed', async () => {
    const analysis = taskId('skin')
    await scanWithTasks({ analysis })
    const delivery = await signedWebhook(analysis)

    await refused(await deliver({ ...delivery, body: delivery.body.replace('success', 'error') }))
  })

  it.each(['webhook-id', 'webhook-timestamp', 'webhook-signature'])('is 401 when the %s header is missing', async (header) => {
    const analysis = taskId('skin')
    await scanWithTasks({ analysis })
    const delivery = await signedWebhook(analysis)
    const { [header]: _left, ...headers } = delivery.headers

    await refused(await deliver({ body: delivery.body, headers }))
  })

  it('is 401 for a delivery signed more than 5 minutes ago, and 200 for one signed 4 minutes ago, so a recorded delivery cannot be replayed later', async () => {
    const analysis = taskId('skin')
    await scanWithTasks({ analysis })
    const now = Math.floor(Date.now() / 1000)

    await refused(await deliver(await signedWebhook(analysis, { timestampSeconds: now - 6 * 60 })))
    expect((await deliver(await signedWebhook(analysis, { timestampSeconds: now - 4 * 60 }))).status).toBe(200)
  })

  it('is 401 for a body that is not the webhook\'s shape, though it is correctly signed', async () => {
    await refused(await deliver(await signedWebhook('t', { body: '{"hello":"world"}' })))
  })

  it('is 413 for a body over 64 KB, before its signature is looked at', async () => {
    const analysis = taskId('skin')
    await scanWithTasks({ analysis })
    const padded = JSON.stringify({ data: { task_id: analysis, task_status: 'success' }, padding: 'x'.repeat(MAX_WEBHOOK_BODY_BYTES) })
    const delivery = await signedWebhook(analysis, { body: padded })

    const res = await deliver(delivery)

    expect(res.status).toBe(413)
    expect(queue.messages).toEqual([])
  })

  it('needs no sign-in, and answers an unsigned caller with the signature error and not AUTH_REQUIRED', async () => {
    const res = await fetchWorker(URL_PATH, { method: 'POST', body: '{}', headers: { 'cf-connecting-ip': freshIp() } })

    expect(res.status).toBe(401)
    expect(await errorCodeOf(res)).toBe('WEBHOOK_SIGNATURE_INVALID')
  })
})

describe('a webhook delivered twice', () => {
  const startedScan = () => startFaceScan(WORKER_ENV)

  const dispatch = async (id: string, body: unknown) => {
    const batch = createMessageBatch(MAIN, [{ id, timestamp: new Date(), attempts: 1, body }])
    const ctx = createExecutionContext()
    await createQueueHandler(jobs, { random: () => 0.999, now: () => new Date() })(batch, WORKER_ENV, ctx)
    return getQueueResult(batch, ctx)
  }
  const countOf = async (table: string, column: string, value: string) => (await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`).bind(value).first<{ n: number }>())!.n

  it('runs the fetch once: the second delivery of the same webhook id is acknowledged as a duplicate and pays nothing more', async () => {
    const perfectCorp = stubPerfectCorp()
    const scan = await startedScan()
    const created = queue.messages.splice(0)
    expect(created).toHaveLength(1)
    expect((await dispatch('upload', created[0])).explicitAcks).toEqual(['upload'])
    const analysis = (await faces.findFaceScan(scan.id))!.pcAnalysisTaskId!
    perfectCorp.answerSkin(analysis, () => skinSuccess(glowOutput()))
    const delivery = await signedWebhook(analysis)

    expect((await deliver(delivery)).status).toBe(200)
    expect((await deliver(delivery)).status).toBe(200)
    const [first, second] = queue.messages.splice(0) as { webhookId: string }[]
    expect(first!.webhookId).toBe(delivery.webhookId)
    expect(second!.webhookId).toBe(delivery.webhookId)
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined)

    const ran = await dispatch('first', first)
    const duplicate = await dispatch('second', second)

    expect(ran.explicitAcks).toEqual(['first'])
    expect(duplicate.explicitAcks).toEqual(['second'])
    expect(duplicate.retryMessages).toEqual([])
    expect(JSON.stringify(logged.mock.calls)).toContain('duplicate-done')
    expect(perfectCorp.callsTo('GET', /^\/s2s\/v2\.0\/task\/skin-analysis\//)).toHaveLength(1)
    expect(perfectCorp.callsTo('POST', '/s2s/v2.0/task/delete')).toHaveLength(1)
    expect(await countOf('ai_usage', 'id', `perfect-corp:${analysis}`)).toBe(1)
    expect(await countOf('face_results', 'face_scan_id', scan.id)).toBeGreaterThan(0)
    expect(await faces.findFaceScan(scan.id)).toMatchObject({ state: 'ready' })
    expect(await runs.get(JOB, `${scan.id}:fetch:wh:${delivery.webhookId}`)).toMatchObject({ status: 'done' })
  })

  it('runs a delivery with another webhook id as a step of its own, which finds the scan already ready and does nothing', async () => {
    const perfectCorp = stubPerfectCorp()
    const scan = await startedScan()
    await dispatch('upload', queue.messages.splice(0)[0])
    const analysis = (await faces.findFaceScan(scan.id))!.pcAnalysisTaskId!
    perfectCorp.answerSkin(analysis, () => skinSuccess(glowOutput()))
    await deliver(await signedWebhook(analysis))
    await dispatch('first', queue.messages.splice(0)[0])
    const polls = perfectCorp.callsTo('GET', /^\/s2s\/v2\.0\/task\/skin-analysis\//).length

    await deliver(await signedWebhook(analysis))
    const late = await dispatch('late', queue.messages.splice(0)[0])

    expect(late.explicitAcks).toEqual(['late'])
    expect(perfectCorp.callsTo('GET', /^\/s2s\/v2\.0\/task\/skin-analysis\//)).toHaveLength(polls)
    expect(await countOf('ai_usage', 'id', `perfect-corp:${analysis}`)).toBe(1)
  })
})
