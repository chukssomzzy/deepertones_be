import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createQueueHandler } from '../../src/jobs/dispatcher'
import { D1JobRunsRepository } from '../../src/jobs/job-runs.repository'
import { jobs } from '../../src/jobs/registry'
import { createDb } from '../../src/lib/db'
import { D1FaceScansRepository } from '../../src/modules/face-scans/face-scans.repository'
import { D1UsersRepository } from '../../src/modules/users/users.repository'

// Until the analysis pipeline lands, the analyse-face-scan job is a placeholder that ends a scan as unavailable rather than leaving it analysing for
// ever. These tests drive the REAL job, from the real registry, through the real dispatcher on the queue names wrangler.jsonc gives it, so they also
// show that it is registered and routed. Nothing reaches Perfect Corp.

const NOW = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000
const MAIN = `deepertones-face-scans-${env.ENVIRONMENT}`
const DEAD_LETTER = `deepertones-face-scans-dlq-${env.ENVIRONMENT}`
const JOB = 'analyse-face-scan'

const db = createDb(env.DB)
const users = new D1UsersRepository(db)
const faces = new D1FaceScansRepository(db)
const runs = new D1JobRunsRepository(db)

afterEach(() => {
  vi.restoreAllMocks()
})

/** A guest with a face scan that is analysing, written the way the create route writes it. */
const analysingScan = async () => {
  const userId = crypto.randomUUID()
  const profileId = crypto.randomUUID()
  await users.createGuestForDevice({ user: { id: userId, createdAt: NOW }, device: { deviceHash: `face-job-${userId}`, platform: 'ios' }, profile: { id: profileId } })
  const id = crypto.randomUUID()
  await faces.createFaceScan(
    { id, userId, profileId, goalAtScan: 'glow', createdAt: NOW },
    [{ faceScanId: id, userId, position: 'front', photoKey: `faces/${env.ENVIRONMENT}/${userId}/${profileId}/${id}/front.jpg`, createdAt: NOW }],
  )
  return { id, userId, profileId, at: NOW.getTime() + MINUTE }
}

const dispatch = async (queue: string, message: { id?: string; attempts?: number; body: unknown }) => {
  const batch = createMessageBatch(queue, [{ id: message.id ?? 'm', timestamp: NOW, attempts: message.attempts ?? 1, body: message.body }])
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  const ctx = createExecutionContext()
  await createQueueHandler(jobs, { random: () => 0.999, now: () => NOW })(batch, env, ctx)
  return getQueueResult(batch, ctx)
}
const upload = (scan: { id: string; at: number }) => ({ faceScanId: scan.id, step: 'upload', at: scan.at })
const keyOf = (scan: { id: string; at: number }) => `${scan.id}:upload:${scan.at}`

describe('the analyse-face-scan job in the registry', () => {
  it('is registered on the face-scans queue, with a hook for when its retries run out', () => {
    const job = jobs.find((j) => j.name === JOB)

    expect(job).toBeDefined()
    expect(job!.queue).toBe('face-scans')
    expect(job!.onDeadLetter).toBeTypeOf('function')
  })
})

describe('the analyse-face-scan job through the queue handler', () => {
  it('ends an analysing scan as failed and unavailable, records the run as failed and acks the message without retrying', async () => {
    const scan = await analysingScan()

    const result = await dispatch(MAIN, { id: 'm', body: upload(scan) })

    expect(result.explicitAcks).toEqual(['m'])
    expect(result.retryMessages).toEqual([])
    expect(await faces.findFaceScan(scan.id)).toMatchObject({ state: 'failed', reason: 'unavailable' })
    expect(await runs.get(JOB, keyOf(scan))).toMatchObject({ status: 'failed' })
  })

  it('leaves a scan that has moved on alone: a late message does not fail a scan that is ready', async () => {
    const scan = await analysingScan()
    expect(await faces.updateFaceScan(scan.id, 'analysing', { state: 'ready', updatedAt: NOW })).toBe(true)

    const result = await dispatch(MAIN, { id: 'm', body: upload(scan) })

    expect(result.explicitAcks).toEqual(['m'])
    expect(result.retryMessages).toEqual([])
    expect(await faces.findFaceScan(scan.id)).toMatchObject({ state: 'ready', reason: null })
  })

  it('acks a message for a scan that is gone (deleted since it was queued) without retrying', async () => {
    const scan = await analysingScan()
    await faces.deleteFaceScan(scan.id)

    const result = await dispatch(MAIN, { id: 'm', body: upload(scan) })

    expect(result.explicitAcks).toEqual(['m'])
    expect(result.retryMessages).toEqual([])
    expect(await faces.findFaceScan(scan.id)).toBeNull()
  })

  it('acks a message that is not the job\'s shape without touching any scan', async () => {
    const scan = await analysingScan()

    const result = await dispatch(MAIN, { id: 'm', body: { faceScanId: scan.id, step: 'explode', at: scan.at } })

    expect(result.explicitAcks).toEqual(['m'])
    expect(result.retryMessages).toEqual([])
    expect(await faces.findFaceScan(scan.id)).toMatchObject({ state: 'analysing' })
  })

  it('does not run twice for one message redelivered: the second delivery is acked and the scan stays failed', async () => {
    const scan = await analysingScan()
    await dispatch(MAIN, { id: 'first', body: upload(scan) })

    const again = await dispatch(MAIN, { id: 'second', body: upload(scan) })

    expect(again.explicitAcks).toEqual(['second'])
    expect(again.retryMessages).toEqual([])
    expect(await faces.findFaceScan(scan.id)).toMatchObject({ state: 'failed', reason: 'unavailable' })
  })
})

describe('the analyse-face-scan job on its dead-letter queue', () => {
  it('marks the scan failed as unavailable, records the run as dead-lettered and acks', async () => {
    const scan = await analysingScan()

    const result = await dispatch(DEAD_LETTER, { id: 'dl', attempts: 5, body: upload(scan) })

    expect(result.explicitAcks).toEqual(['dl'])
    expect(result.retryMessages).toEqual([])
    expect(await faces.findFaceScan(scan.id)).toMatchObject({ state: 'failed', reason: 'unavailable' })
    expect(await runs.get(JOB, keyOf(scan))).toMatchObject({ status: 'failed', lastError: 'dead-lettered' })
  })

  it('leaves a scan that is ready alone', async () => {
    const scan = await analysingScan()
    await faces.updateFaceScan(scan.id, 'analysing', { state: 'ready', updatedAt: NOW })

    const result = await dispatch(DEAD_LETTER, { id: 'dl', attempts: 5, body: upload(scan) })

    expect(result.explicitAcks).toEqual(['dl'])
    expect(await faces.findFaceScan(scan.id)).toMatchObject({ state: 'ready' })
  })
})
