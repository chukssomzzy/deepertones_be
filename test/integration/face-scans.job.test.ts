import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueueHandler } from '../../src/jobs/dispatcher'
import { D1JobRunsRepository } from '../../src/jobs/job-runs.repository'
import { jobs } from '../../src/jobs/registry'
import { createDb } from '../../src/lib/db'
import { D1FaceScansRepository } from '../../src/modules/face-scans/face-scans.repository'
import { FRONT_PHOTO, startFaceScan, type StartedFaceScan } from './face-scans.support'
import { fitzpatrickSuccess, glowOutput, noCredit, outage, queueRecorder, skinSuccess, stubPerfectCorp, taskError, type PerfectCorpStub, API } from './perfect-corp.stub'

// The analyse-face-scan job's steps (upload, fetch, fitzpatrick), driven through the REAL job in the real registry, the real dispatcher and the
// queue names wrangler.jsonc gives it, against real local D1 and R2. Perfect Corp is the stub in ./perfect-corp.stub (never the real API). A scan
// is made through the service (./face-scans.support), so its photo is in the bucket and its consent and goal are on record, and each state the
// tests look at is reached by running the steps. The face-scans queue's producer is a recorder: what a step or the service queues is read back
// from it and fed to the dispatcher by hand.

// The dispatcher's own clock (the run records' times); a fixed one keeps the lease arithmetic out of the way. The scans are made on the real clock.
const NOW = new Date('2030-06-15T12:00:00.000Z')
const MAIN = `deepertones-face-scans-${env.ENVIRONMENT}`
const DEAD_LETTER = `deepertones-face-scans-dlq-${env.ENVIRONMENT}`
const JOB = 'analyse-face-scan'

const recorder = queueRecorder()
// The push-delivery queue's producer is a recorder too: what the steps queue for the phone is read back from it (sending it is push.background.test.ts's concern).
const pushRecorder = queueRecorder()
const WORKER_ENV = { ...env, FACE_SCANS_QUEUE: recorder.queue, PUSH_DELIVERY_QUEUE: pushRecorder.queue }
const db = createDb(env.DB)
const faces = new D1FaceScansRepository(db)
const runs = new D1JobRunsRepository(db)

let perfectCorp: PerfectCorpStub
beforeEach(() => {
  perfectCorp = stubPerfectCorp()
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  recorder.messages.length = 0
  recorder.state.failing = false
  pushRecorder.messages.length = 0
})

const dispatch = async (queue: string, message: { id?: string; attempts?: number; body: unknown }) => {
  const batch = createMessageBatch(queue, [{ id: message.id ?? 'm', timestamp: NOW, attempts: message.attempts ?? 1, body: message.body }])
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  const ctx = createExecutionContext()
  await createQueueHandler(jobs, { random: () => 0.999, now: () => NOW })(batch, WORKER_ENV, ctx)
  return getQueueResult(batch, ctx)
}
type Step = 'upload' | 'fetch' | 'fitzpatrick'
let lastAt = 0
const nextAt = () => (lastAt = Math.max(Date.now(), lastAt + 1))
const message = (scan: { id: string }, step: Step, at = nextAt()) => ({ faceScanId: scan.id, step, at })
const keyOf = (scan: { id: string }, step: Step, at: number) => `${scan.id}:${step}:${at}`

/** A scan made through the service, with the message the create route queued for it taken off the recorder. */
const started = async (goal: 'glow' | 'clear-skin' = 'glow') => {
  const scan = await startFaceScan(WORKER_ENV, goal)
  const [queued] = recorder.messages.splice(0) as { faceScanId: string; step: string; at: number }[]
  expect(queued).toMatchObject({ faceScanId: scan.id, step: 'upload' })
  return { ...scan, queued: queued! }
}
const rowOf = async (scan: { id: string }) => (await faces.findFaceScan(scan.id))!
/** A scan whose upload step has run. */
const uploaded = async () => {
  const scan = await started()
  const result = await dispatch(MAIN, { id: 'upload', body: scan.queued })
  expect(result.explicitAcks).toEqual(['upload'])
  const row = await rowOf(scan)
  return { ...scan, analysisTask: row.pcAnalysisTaskId!, fitzpatrickTask: row.pcFitzpatrickTaskId! }
}
type Uploaded = Awaited<ReturnType<typeof uploaded>>
const countOf = async (table: string, column: string, value: string) => (await env.DB.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`).bind(value).first<{ n: number }>())!.n
const spendOf = (taskId: string) => env.DB.prepare('SELECT vendor, job, units, status FROM ai_usage WHERE id = ?').bind(`perfect-corp:${taskId}`).first<{ vendor: string; job: string; units: number; status: string }>()
const bucketKeysOf = async (scan: StartedFaceScan) => (await env.PRIVATE_PHOTOS.list({ prefix: `faces/${env.ENVIRONMENT}/${scan.userId}/` })).objects.map((object) => object.key).sort()
const isSkinPoll = (call: { method: string; url: string }) => call.method === 'GET' && call.url.startsWith(`${API}/s2s/v2.0/task/skin-analysis/`)

describe('the analyse-face-scan job in the registry', () => {
  it('is registered on the face-scans queue, with a hook for when its retries run out', () => {
    const job = jobs.find((j) => j.name === JOB)

    expect(job).toBeDefined()
    expect(job!.queue).toBe('face-scans')
    expect(job!.onDeadLetter).toBeTypeOf('function')
  })
})

describe('the upload step through the queue handler', () => {
  it('sends the front photo to Perfect Corp, starts the goal\'s HD analysis and a Fitzpatrick read, stores the task ids and the environment, and records the run as done', async () => {
    const scan = await started()

    const result = await dispatch(MAIN, { id: 'm', body: scan.queued })

    expect(result.explicitAcks).toEqual(['m'])
    expect(result.retryMessages).toEqual([])
    const row = await rowOf(scan)
    expect(row).toMatchObject({ state: 'analysing', reason: null, pcEnvironment: env.ENVIRONMENT })
    expect(row.pcAnalysisTaskId).toMatch(/^skin-/)
    expect(row.pcFitzpatrickTaskId).toMatch(/^fitz-/)
    expect(await runs.get(JOB, keyOf(scan, 'upload', scan.queued.at))).toMatchObject({ status: 'done' })

    const photo = FRONT_PHOTO()
    const [slot] = perfectCorp.callsTo('POST', '/s2s/v2.0/file')
    expect(slot!.body).toEqual({ files: [{ content_type: 'image/jpeg', file_name: 'front.jpg', file_size: photo.bytes.byteLength }] })
    const [put] = perfectCorp.calls.filter((call) => call.method === 'PUT')
    expect(new Uint8Array(put!.body as ArrayBuffer | Uint8Array)).toEqual(photo.bytes)
    const [analysis] = perfectCorp.callsTo('POST', '/s2s/v2.0/task/skin-analysis')
    expect(analysis!.body).toEqual({ src_file_id: expect.stringMatching(/^file-/), dst_actions: ['hd_radiance', 'hd_moisture', 'hd_texture', 'hd_skin_type'], format: 'json' })
    expect(perfectCorp.callsTo('POST', '/s2s/v2.0/task/fitzpatrick-scale-analyzer')).toHaveLength(1)
  })

  it('does not pay twice when the step runs again for the same scan: a second message makes no call and changes no task id', async () => {
    const scan = await uploaded()
    const calls = perfectCorp.calls.length

    const again = await dispatch(MAIN, { id: 'again', body: message(scan, 'upload') })

    expect(again.explicitAcks).toEqual(['again'])
    expect(perfectCorp.calls).toHaveLength(calls)
    expect((await rowOf(scan)).pcAnalysisTaskId).toBe(scan.analysisTask)
  })

  it('fails the scan as consent-withdrawn, calling nothing, when consent was withdrawn after the photo was taken', async () => {
    const scan = await started()
    await scan.asUser(() => scan.container.faceScans.withdrawConsent())

    const result = await dispatch(MAIN, { id: 'm', body: scan.queued })

    expect(result.explicitAcks).toEqual(['m'])
    expect(result.retryMessages).toEqual([])
    expect(await rowOf(scan)).toMatchObject({ state: 'failed', reason: 'consent-withdrawn' })
    expect(perfectCorp.calls).toEqual([])
  })

  it('fails the scan as unavailable, calling nothing, when the front photo is gone from the bucket', async () => {
    const scan = await started()
    await env.PRIVATE_PHOTOS.delete(scan.frontKey)

    const result = await dispatch(MAIN, { id: 'm', body: scan.queued })

    expect(result.explicitAcks).toEqual(['m'])
    expect(await rowOf(scan)).toMatchObject({ state: 'failed', reason: 'unavailable' })
    expect(perfectCorp.calls).toEqual([])
  })

  it('retries the message, and leaves the scan analysing, when Perfect Corp is down', async () => {
    const scan = await started()
    perfectCorp.override((call) => call.url === `${API}/s2s/v2.0/task/skin-analysis`, outage)

    const result = await dispatch(MAIN, { id: 'm', body: scan.queued })

    expect(result.retryMessages.map((retry) => retry.msgId)).toEqual(['m'])
    expect(result.explicitAcks).toEqual([])
    expect(await rowOf(scan)).toMatchObject({ state: 'analysing', reason: null })
  })

  it('fails the scan as unavailable and acks without a retry when Perfect Corp has no credit left, recording the run as failed', async () => {
    const scan = await started()
    perfectCorp.override((call) => call.url === `${API}/s2s/v2.0/file`, noCredit)

    const result = await dispatch(MAIN, { id: 'm', body: scan.queued })

    expect(result.explicitAcks).toEqual(['m'])
    expect(result.retryMessages).toEqual([])
    expect(await rowOf(scan)).toMatchObject({ state: 'failed', reason: 'unavailable' })
    expect(await runs.get(JOB, keyOf(scan, 'upload', scan.queued.at))).toMatchObject({ status: 'failed' })
  })

  it('still analyses the face when only the Fitzpatrick task cannot be created', async () => {
    const scan = await started()
    perfectCorp.override((call) => call.url === `${API}/s2s/v2.0/task/fitzpatrick-scale-analyzer`, outage)

    const result = await dispatch(MAIN, { id: 'm', body: scan.queued })

    expect(result.explicitAcks).toEqual(['m'])
    expect(await rowOf(scan)).toMatchObject({ state: 'analysing', pcFitzpatrickTaskId: null })
    expect((await rowOf(scan)).pcAnalysisTaskId).toMatch(/^skin-/)
  })
})

describe('the fetch step through the queue handler', () => {
  const finishedWith = async (scan: Uploaded) => {
    perfectCorp.answerSkin(scan.analysisTask, () => skinSuccess(glowOutput()))
    return dispatch(MAIN, { id: 'fetch', body: message(scan, 'fetch') })
  }

  it('copies a finished analysis into D1: the scan is ready with its skin type and skin age, and every concern and the overall score are stored with both scores', async () => {
    const scan = await uploaded()

    const result = await finishedWith(scan)

    expect(result.explicitAcks).toEqual(['fetch'])
    expect(await rowOf(scan)).toMatchObject({ state: 'ready', reason: null, skinType: 'dry', skinAge: 31 })
    const { results } = await env.DB.prepare('SELECT concern, region, raw_score, ui_score FROM face_results WHERE face_scan_id = ? ORDER BY concern, region').bind(scan.id).all()
    expect(results).toEqual([
      { concern: 'all', region: 'whole', raw_score: 70, ui_score: 70 },
      { concern: 'hd_moisture', region: 'whole', raw_score: 62, ui_score: 70 },
      { concern: 'hd_radiance', region: 'whole', raw_score: 41.5, ui_score: 52 },
      { concern: 'hd_texture', region: 'whole', raw_score: 55, ui_score: 63 },
    ])
  })

  it('stores each concern\'s mask as a PNG in the private bucket under its mask key, and lists those keys in face_masks', async () => {
    const scan = await uploaded()

    await finishedWith(scan)

    // hd_texture has no mask in the answer, so there are two.
    expect((await bucketKeysOf(scan)).filter((key) => key.includes('/mask-'))).toEqual([scan.maskKey('hd-moisture'), scan.maskKey('hd-radiance')])
    const radiance = await env.PRIVATE_PHOTOS.get(scan.maskKey('hd-radiance'))
    expect(radiance!.httpMetadata?.contentType).toBe('image/png')
    expect(new Uint8Array(await radiance!.arrayBuffer())).toEqual(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]))
    const { results } = await env.DB.prepare('SELECT concern, mask_key FROM face_masks WHERE face_scan_id = ? ORDER BY concern').bind(scan.id).all()
    expect(results).toEqual([
      { concern: 'hd_moisture', mask_key: scan.maskKey('hd-moisture') },
      { concern: 'hd_radiance', mask_key: scan.maskKey('hd-radiance') },
    ])
  })

  it('records the spend once, as 12 units of face-analysis keyed by the task, and deletes Perfect Corp\'s copy of the task', async () => {
    const scan = await uploaded()

    await finishedWith(scan)

    expect(await spendOf(scan.analysisTask)).toEqual({ vendor: 'perfect-corp', job: 'face-analysis', units: 12, status: 'settled' })
    expect(perfectCorp.callsTo('POST', '/s2s/v2.0/task/delete').map((call) => call.body)).toEqual([{ task_id: scan.analysisTask }])
  })

  it('leaves nothing in the bucket or the database when the ready scan is deleted', async () => {
    const scan = await uploaded()
    await finishedWith(scan)
    expect((await bucketKeysOf(scan)).length).toBe(3)

    await scan.asUser(() => scan.container.faceScans.deleteFaceScan(scan.id))

    expect(await bucketKeysOf(scan)).toEqual([])
    expect(await countOf('face_results', 'face_scan_id', scan.id)).toBe(0)
    expect(await countOf('face_masks', 'face_scan_id', scan.id)).toBe(0)
  })

  it('does nothing while Perfect Corp says the task is still running: the scan stays analysing, nothing is stored or recorded, and the message is acked', async () => {
    const scan = await uploaded()

    const result = await dispatch(MAIN, { id: 'fetch', body: message(scan, 'fetch') })

    expect(result.explicitAcks).toEqual(['fetch'])
    expect(await rowOf(scan)).toMatchObject({ state: 'analysing', skinType: null, skinAge: null })
    expect(await countOf('face_results', 'face_scan_id', scan.id)).toBe(0)
    expect(await spendOf(scan.analysisTask)).toBeNull()
    expect(perfectCorp.callsTo('POST', '/s2s/v2.0/task/delete')).toEqual([])
  })

  it('does not run twice for a scan that is ready: a second fetch polls nothing, stores nothing and records no second spend', async () => {
    const scan = await uploaded()
    await finishedWith(scan)
    const polls = perfectCorp.calls.filter(isSkinPoll).length

    const again = await dispatch(MAIN, { id: 'again', body: message(scan, 'fetch') })

    expect(again.explicitAcks).toEqual(['again'])
    expect(perfectCorp.calls.filter(isSkinPoll)).toHaveLength(polls)
    expect(await countOf('ai_usage', 'id', `perfect-corp:${scan.analysisTask}`)).toBe(1)
    expect(await countOf('face_results', 'face_scan_id', scan.id)).toBe(4)
  })

  it.each([
    ['error_lighting_dark', 'too-dark'],
    ['error_pose', 'turn-to-camera'],
    ['error_src_face_too_small', 'move-closer'],
    ['error_src_face_out_of_bound', 'face-not-centred'],
    ['error_no_face', 'no-face'],
    ['error_below_min_image_size', 'image-size'],
  ])('sends the scan to needs-retake with reason %s -> %s when the task ended on a photo problem, with no spend', async (code, reason) => {
    const scan = await uploaded()
    perfectCorp.answerSkin(scan.analysisTask, () => taskError(code))

    const result = await dispatch(MAIN, { id: 'fetch', body: message(scan, 'fetch') })

    expect(result.explicitAcks).toEqual(['fetch'])
    expect(await rowOf(scan)).toMatchObject({ state: 'needs-retake', reason })
    expect(await spendOf(scan.analysisTask)).toBeNull()
    expect(await countOf('face_results', 'face_scan_id', scan.id)).toBe(0)
  })

  it('retries the message and leaves the scan analysing when Perfect Corp is down', async () => {
    const scan = await uploaded()
    perfectCorp.answerSkin(scan.analysisTask, outage)

    const result = await dispatch(MAIN, { id: 'fetch', body: message(scan, 'fetch') })

    expect(result.retryMessages.map((retry) => retry.msgId)).toEqual(['fetch'])
    expect((await rowOf(scan)).state).toBe('analysing')
  })

  it('treats a task that ended in an outage on their side like an outage: the message is retried, not the scan failed', async () => {
    const scan = await uploaded()
    perfectCorp.answerSkin(scan.analysisTask, () => taskError('error_internal'))

    const result = await dispatch(MAIN, { id: 'fetch', body: message(scan, 'fetch') })

    expect(result.retryMessages.map((retry) => retry.msgId)).toEqual(['fetch'])
    expect((await rowOf(scan)).state).toBe('analysing')
  })

  it('is still ready when Perfect Corp\'s copy cannot be deleted', async () => {
    const scan = await uploaded()
    perfectCorp.override((call) => call.url === `${API}/s2s/v2.0/task/delete`, outage)

    const result = await finishedWith(scan)

    expect(result.explicitAcks).toEqual(['fetch'])
    expect((await rowOf(scan)).state).toBe('ready')
    expect(await spendOf(scan.analysisTask)).not.toBeNull()
  })
})

describe('the fitzpatrick step through the queue handler', () => {
  it('stores the Fitzpatrick type for the profile, records 10 units keyed by the task and deletes their copy, and leaves the scan as it was', async () => {
    const scan = await uploaded()
    perfectCorp.answerFitzpatrick(scan.fitzpatrickTask, () => fitzpatrickSuccess('V'))

    const result = await dispatch(MAIN, { id: 'fitz', body: message(scan, 'fitzpatrick') })

    expect(result.explicitAcks).toEqual(['fitz'])
    expect(await env.DB.prepare('SELECT fitzpatrick, task_id FROM profile_fitzpatrick WHERE profile_id = ?').bind(scan.profileId).first()).toEqual({ fitzpatrick: 'V', task_id: scan.fitzpatrickTask })
    expect(await spendOf(scan.fitzpatrickTask)).toEqual({ vendor: 'perfect-corp', job: 'fitzpatrick', units: 10, status: 'settled' })
    expect(perfectCorp.callsTo('POST', '/s2s/v2.0/task/delete').map((call) => call.body)).toEqual([{ task_id: scan.fitzpatrickTask }])
    expect(await rowOf(scan)).toMatchObject({ state: 'analysing', reason: null })
  })

  it('stores the type once when the step runs twice', async () => {
    const scan = await uploaded()
    perfectCorp.answerFitzpatrick(scan.fitzpatrickTask, () => fitzpatrickSuccess('V'))
    await dispatch(MAIN, { id: 'first', body: message(scan, 'fitzpatrick') })

    await dispatch(MAIN, { id: 'second', body: message(scan, 'fitzpatrick') })

    expect(await countOf('profile_fitzpatrick', 'profile_id', scan.profileId)).toBe(1)
    expect(await countOf('ai_usage', 'id', `perfect-corp:${scan.fitzpatrickTask}`)).toBe(1)
  })

  it('does nothing while the task is still running', async () => {
    const scan = await uploaded()

    const result = await dispatch(MAIN, { id: 'fitz', body: message(scan, 'fitzpatrick') })

    expect(result.explicitAcks).toEqual(['fitz'])
    expect(await countOf('profile_fitzpatrick', 'profile_id', scan.profileId)).toBe(0)
    expect(await spendOf(scan.fitzpatrickTask)).toBeNull()
  })
})

describe('the analyse-face-scan job on messages that no longer fit', () => {
  it('leaves a scan that has moved on alone: a late upload message does not touch a scan that is ready', async () => {
    const scan = await uploaded()
    perfectCorp.answerSkin(scan.analysisTask, () => skinSuccess(glowOutput()))
    await dispatch(MAIN, { id: 'fetch', body: message(scan, 'fetch') })
    const calls = perfectCorp.calls.length

    const result = await dispatch(MAIN, { id: 'late', body: message(scan, 'upload') })

    expect(result.explicitAcks).toEqual(['late'])
    expect(result.retryMessages).toEqual([])
    expect(await rowOf(scan)).toMatchObject({ state: 'ready', reason: null })
    expect(perfectCorp.calls).toHaveLength(calls)
  })

  it.each(['upload', 'fetch', 'fitzpatrick'] as const)('acks a %s message for a scan that is gone (deleted since it was queued) without retrying or calling anything', async (step) => {
    const scan = await started()
    await scan.asUser(() => scan.container.faceScans.deleteFaceScan(scan.id))

    const result = await dispatch(MAIN, { id: 'm', body: message(scan, step) })

    expect(result.explicitAcks).toEqual(['m'])
    expect(result.retryMessages).toEqual([])
    expect(await faces.findFaceScan(scan.id)).toBeNull()
    expect(perfectCorp.calls).toEqual([])
  })

  it('acks a message that is not the job\'s shape without touching any scan', async () => {
    const scan = await started()

    const result = await dispatch(MAIN, { id: 'm', body: { faceScanId: scan.id, step: 'explode', at: scan.queued.at } })

    expect(result.explicitAcks).toEqual(['m'])
    expect(result.retryMessages).toEqual([])
    expect(await rowOf(scan)).toMatchObject({ state: 'analysing' })
    expect(perfectCorp.calls).toEqual([])
  })

  it('does not run twice for one message redelivered: the second delivery is acked and calls nothing', async () => {
    const scan = await started()
    await dispatch(MAIN, { id: 'first', body: scan.queued })
    const calls = perfectCorp.calls.length

    const again = await dispatch(MAIN, { id: 'second', body: scan.queued })

    expect(again.explicitAcks).toEqual(['second'])
    expect(again.retryMessages).toEqual([])
    expect(perfectCorp.calls).toHaveLength(calls)
  })

  it('keys a webhook-driven step by the webhook id, so the same webhook id with another time is the same run', async () => {
    const scan = await uploaded()
    perfectCorp.answerSkin(scan.analysisTask, () => skinSuccess(glowOutput()))
    await dispatch(MAIN, { id: 'first', body: { ...message(scan, 'fetch'), webhookId: 'msg_dup' } })

    await dispatch(MAIN, { id: 'second', body: { ...message(scan, 'fetch'), webhookId: 'msg_dup' } })

    expect(await runs.get(JOB, `${scan.id}:fetch:wh:msg_dup`)).toMatchObject({ status: 'done' })
    expect(await countOf('ai_usage', 'id', `perfect-corp:${scan.analysisTask}`)).toBe(1)
  })
})

describe('the push notifications the steps queue, through the queue handler', () => {
  it('queues a face-scan-ready push for the scan\'s profile when the fetch step makes the scan ready, and none before', async () => {
    const scan = await uploaded()
    expect(pushRecorder.messages).toEqual([])
    perfectCorp.answerSkin(scan.analysisTask, () => skinSuccess(glowOutput()))

    const result = await dispatch(MAIN, { id: 'fetch', body: message(scan, 'fetch') })

    expect(result.explicitAcks).toEqual(['fetch'])
    expect((await rowOf(scan)).state).toBe('ready')
    expect(pushRecorder.messages).toEqual([{ kind: 'face-scan-ready', userId: scan.userId, profileId: scan.profileId, faceScanId: scan.id }])
  })

  it('queues a face-scan-needs-retake push, stamped with the update time stored in D1, when the task ended on a photo problem', async () => {
    const scan = await uploaded()
    perfectCorp.answerSkin(scan.analysisTask, () => taskError('error_lighting_dark'))

    await dispatch(MAIN, { id: 'fetch', body: message(scan, 'fetch') })

    const row = await rowOf(scan)
    expect(row).toMatchObject({ state: 'needs-retake', reason: 'too-dark' })
    expect(pushRecorder.messages).toEqual([
      { kind: 'face-scan-needs-retake', userId: scan.userId, profileId: scan.profileId, faceScanId: scan.id, reason: 'too-dark', at: row.updatedAt.getTime() },
    ])
  })

  it('does not fail or retry the step when the push cannot be queued: the scan is still ready and the message is acked', async () => {
    const scan = await uploaded()
    perfectCorp.answerSkin(scan.analysisTask, () => skinSuccess(glowOutput()))
    pushRecorder.state.failing = true

    const result = await dispatch(MAIN, { id: 'fetch', body: message(scan, 'fetch') })

    expect(result.explicitAcks).toEqual(['fetch'])
    expect(result.retryMessages).toEqual([])
    expect((await rowOf(scan)).state).toBe('ready')
    expect(pushRecorder.messages).toEqual([])
  })
})

describe('the analyse-face-scan job on its dead-letter queue', () => {
  it.each(['upload', 'fetch'] as const)('marks the scan failed as unavailable for a dead %s message, records the run as dead-lettered and acks', async (step) => {
    const scan = await started()
    const body = message(scan, step)

    const result = await dispatch(DEAD_LETTER, { id: 'dl', attempts: 5, body })

    expect(result.explicitAcks).toEqual(['dl'])
    expect(result.retryMessages).toEqual([])
    expect(await rowOf(scan)).toMatchObject({ state: 'failed', reason: 'unavailable' })
    expect(await runs.get(JOB, keyOf(scan, step, body.at))).toMatchObject({ status: 'failed', lastError: 'dead-lettered' })
  })

  it('leaves a scan that is ready alone', async () => {
    const scan = await uploaded()
    perfectCorp.answerSkin(scan.analysisTask, () => skinSuccess(glowOutput()))
    await dispatch(MAIN, { id: 'fetch', body: message(scan, 'fetch') })

    const result = await dispatch(DEAD_LETTER, { id: 'dl', attempts: 5, body: message(scan, 'fetch') })

    expect(result.explicitAcks).toEqual(['dl'])
    expect(await rowOf(scan)).toMatchObject({ state: 'ready' })
  })
})
