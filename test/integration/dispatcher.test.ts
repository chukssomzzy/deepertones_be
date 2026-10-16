import { createExecutionContext, createMessageBatch, getQueueResult } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DrizzleQueryError } from 'drizzle-orm/errors'
import { z } from 'zod'
import { createQueueHandler, createScheduledHandler } from '../../src/jobs/dispatcher'
import { defineJob, jobSpec, PermanentJobError, queueNames } from '../../src/jobs/job'
import { D1JobRunsRepository } from '../../src/jobs/job-runs.repository'
import { createDb } from '../../src/lib/db'
import { type Actor, currentActor } from '../../src/lib/context'
import { D1UsersRepository } from '../../src/modules/users/users.repository'

const NOW = new Date('2030-06-15T12:00:00.000Z')
const SECOND = 1000
const MINUTE = 60 * SECOND
const DAY = 24 * 60 * MINUTE
const LEASE_MS = 2 * MINUTE

const MAIN = 'deepertones-test-job-development'
const DEAD_LETTER = 'deepertones-test-job-dlq-development'

const runs = new D1JobRunsRepository(createDb(env.DB))

type Call = { body: { id: string }; actor: Actor; services: unknown; leaseUntilDuringRun: Date | null | undefined }
let handled: Call[]
let deadLettered: { id: string }[]
let behaviour: Map<string, () => Promise<void>>

const testSpec = jobSpec({
  name: 'test-job',
  queue: 'test-job',
  schema: z.object({ id: z.string() }),
  key: (body) => body.id,
  retry: { baseSeconds: 5, factor: 3, capSeconds: 135 },
})

const testJob = defineJob(testSpec, {
  handle: async (body, services) => {
    handled.push({
      body,
      actor: currentActor(),
      services,
      leaseUntilDuringRun: (await runs.get('test-job', body.id))?.leaseUntil,
    })
    await behaviour.get(body.id)?.()
  },
  onDeadLetter: async (body) => {
    deadLettered.push(body)
  },
})

let salt = 0
const freshId = () => `msg-${crypto.randomUUID().slice(0, 8)}-${salt++}`

const leaseToken = (claim: Awaited<ReturnType<typeof runs.claim>>) => {
  if (claim.outcome !== 'claimed') throw new Error(`expected a claimed run, got ${claim.outcome}`)
  return claim.token
}

type Message = { id?: string; attempts?: number; body: unknown }

/** Runs one batch through the handler; retry delays are captured because the harness drops retry options. */
const dispatch = async (
  queue: string,
  messages: Message[],
  options: { random?: () => number; now?: () => Date } = {},
) => {
  const batch = createMessageBatch(
    queue,
    messages.map((m, i) => ({ id: m.id ?? `m${i}`, timestamp: NOW, attempts: m.attempts ?? 1, body: m.body })),
  )
  const delays = new Map<string, number | undefined>()
  for (const message of batch.messages) {
    const original = message.retry.bind(message)
    vi.spyOn(message, 'retry').mockImplementation((opts) => {
      delays.set(message.id, opts?.delaySeconds)
      original(opts)
    })
  }
  const handler = createQueueHandler([testJob], { random: () => 0.999, now: () => NOW, ...options })
  const ctx = createExecutionContext()
  await handler(batch, env, ctx)
  const result = await getQueueResult(batch, ctx)
  return { result, delays }
}

beforeEach(() => {
  handled = []
  deadLettered = []
  behaviour = new Map()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('queueNames', () => {
  it('names the queue and its dead-letter queue per environment', () => {
    expect(queueNames('otp-delivery', 'staging')).toEqual({
      main: 'deepertones-otp-delivery-staging',
      deadLetter: 'deepertones-otp-delivery-dlq-staging',
    })
  })
})

describe('queue handler: main queue', () => {
  it('runs the handler for a new key as the job system actor, marks it done and acks', async () => {
    const id = freshId()

    const { result } = await dispatch(MAIN, [{ id: 'm', body: { id } }])

    expect(handled).toHaveLength(1)
    expect(handled[0]!.body).toEqual({ id })
    expect(handled[0]!.actor).toEqual({ kind: 'system', job: 'test-job' })
    expect(handled[0]!.services).toBeDefined()
    expect(result.explicitAcks).toEqual(['m'])
    expect(result.retryMessages).toEqual([])
    expect(await runs.get('test-job', id)).toMatchObject({ status: 'done', attempts: 1 })
  })

  it('holds a two minute lease while the handler runs', async () => {
    const id = freshId()

    await dispatch(MAIN, [{ body: { id } }])

    expect(handled[0]!.leaseUntilDuringRun!.getTime()).toBe(NOW.getTime() + LEASE_MS)
  })

  it('acks without running when the body fails the schema, leaving no run behind', async () => {
    const { result } = await dispatch(MAIN, [{ id: 'bad', body: { id: 123 } }])

    expect(handled).toEqual([])
    expect(result.explicitAcks).toEqual(['bad'])
    expect(result.retryMessages).toEqual([])
  })

  it.each(['done', 'failed'] as const)('acks a duplicate of a %s key without running the handler', async (status) => {
    const id = freshId()
    const claimed = await runs.claim('test-job', id, NOW, LEASE_MS)
    if (status === 'done') await runs.markDone('test-job', id, leaseToken(claimed), NOW)
    else await runs.markFailed('test-job', id, 'earlier', NOW)

    const { result } = await dispatch(MAIN, [{ id: 'dup', body: { id } }])

    expect(handled).toEqual([])
    expect(result.explicitAcks).toEqual(['dup'])
    expect((await runs.get('test-job', id))!.status).toBe(status)
  })

  it('retries, with a backoff delay and without running, a key that is running under a live lease', async () => {
    const id = freshId()
    await runs.claim('test-job', id, NOW, LEASE_MS)

    const { result, delays } = await dispatch(MAIN, [{ id: 'busy', attempts: 2, body: { id } }], {
      now: () => new Date(NOW.getTime() + 30 * SECOND),
    })

    expect(handled).toEqual([])
    expect(result.retryMessages).toEqual([{ msgId: 'busy' }])
    expect(result.explicitAcks).toEqual([])
    expect(delays.get('busy')).toBe(14)
  })

  it('re-claims and runs a key whose lease has expired', async () => {
    const id = freshId()
    await runs.claim('test-job', id, NOW, LEASE_MS)

    const { result } = await dispatch(MAIN, [{ id: 'm', body: { id } }], {
      now: () => new Date(NOW.getTime() + LEASE_MS + SECOND),
    })

    expect(handled).toHaveLength(1)
    expect(result.explicitAcks).toEqual(['m'])
    expect(await runs.get('test-job', id)).toMatchObject({ status: 'done', attempts: 2 })
  })

  it('records a permanent failure with its message and acks without retrying', async () => {
    const id = freshId()
    behaviour.set(id, async () => {
      throw new PermanentJobError('number is not on whatsapp')
    })

    const { result } = await dispatch(MAIN, [{ id: 'm', body: { id } }])

    expect(result.explicitAcks).toEqual(['m'])
    expect(result.retryMessages).toEqual([])
    expect(await runs.get('test-job', id)).toMatchObject({ status: 'failed', lastError: 'number is not on whatsapp' })
  })

  it('releases the run and retries on any other error', async () => {
    const id = freshId()
    behaviour.set(id, async () => {
      throw new Error('meta timed out')
    })

    const { result } = await dispatch(MAIN, [{ id: 'm', body: { id } }])

    expect(result.retryMessages).toEqual([{ msgId: 'm' }])
    expect(result.explicitAcks).toEqual([])
    const run = (await runs.get('test-job', id))!
    expect(run).toMatchObject({ status: 'running', attempts: 1, lastError: 'Error' })
    expect(run.leaseUntil!.getTime()).toBeLessThanOrEqual(NOW.getTime())
  })

  it('lets the released run be picked up again by the redelivery', async () => {
    const id = freshId()
    let calls = 0
    behaviour.set(id, async () => {
      if (calls++ === 0) throw new Error('flaky')
    })

    await dispatch(MAIN, [{ id: 'first', body: { id } }])
    const { result } = await dispatch(MAIN, [{ id: 'second', attempts: 2, body: { id } }])

    expect(handled).toHaveLength(2)
    expect(result.explicitAcks).toEqual(['second'])
    expect(await runs.get('test-job', id)).toMatchObject({ status: 'done', attempts: 2 })
  })

  it.each([
    [1, 4],
    [2, 14],
    [3, 44],
    [4, 134],
    [5, 134],
  ])('retries attempt %i after at most %i seconds (full jitter, capped at 135)', async (attempts, expected) => {
    const id = freshId()
    behaviour.set(id, async () => {
      throw new Error('boom')
    })

    const { delays } = await dispatch(MAIN, [{ id: 'm', attempts, body: { id } }], { random: () => 0.999 })

    expect(delays.get('m')).toBe(expected)
  })

  it.each([1, 2, 3, 5])('retries attempt %i immediately when the random draw is 0', async (attempts) => {
    const id = freshId()
    behaviour.set(id, async () => {
      throw new Error('boom')
    })

    const { delays } = await dispatch(MAIN, [{ id: 'm', attempts, body: { id } }], { random: () => 0 })

    expect(delays.get('m')).toBe(0)
  })

  it('keeps messages in a batch independent of each other', async () => {
    const [ok, flaky, permanent, fresh] = [freshId(), freshId(), freshId(), freshId()]
    behaviour.set(flaky, async () => {
      throw new Error('flaky')
    })
    behaviour.set(permanent, async () => {
      throw new PermanentJobError('nope')
    })

    const { result } = await dispatch(MAIN, [
      { id: 'ok', body: { id: ok } },
      { id: 'flaky', body: { id: flaky } },
      { id: 'permanent', body: { id: permanent } },
      { id: 'fresh', body: { id: fresh } },
    ])

    expect(result.explicitAcks).toEqual(['ok', 'permanent', 'fresh'])
    expect(result.retryMessages).toEqual([{ msgId: 'flaky' }])
    expect(handled).toHaveLength(4)
  })

  it('purges runs last updated more than seven days ago after the batch, keeping newer ones', async () => {
    const [stale, recent] = [freshId(), freshId()]
    await runs.markFailed('test-job', stale, 'x', new Date(NOW.getTime() - 7 * DAY - SECOND))
    await runs.markFailed('test-job', recent, 'x', new Date(NOW.getTime() - 6 * DAY))

    await dispatch(MAIN, [{ body: { id: freshId() } }])

    expect(await runs.get('test-job', stale)).toBeNull()
    expect(await runs.get('test-job', recent)).not.toBeNull()
  })
})

describe('queue handler: dead-letter queue', () => {
  it('runs the dead-letter hook, marks the run failed as dead-lettered and acks without running the handler', async () => {
    const id = freshId()
    await runs.claim('test-job', id, new Date(NOW.getTime() - LEASE_MS - SECOND), LEASE_MS)

    const { result } = await dispatch(DEAD_LETTER, [{ id: 'dl', attempts: 5, body: { id } }])

    expect(handled).toEqual([])
    expect(deadLettered).toEqual([{ id }])
    expect(result.explicitAcks).toEqual(['dl'])
    expect(await runs.get('test-job', id)).toMatchObject({ status: 'failed', lastError: 'dead-lettered' })
  })

  it('creates the failed run when the message never had one', async () => {
    const id = freshId()

    await dispatch(DEAD_LETTER, [{ body: { id } }])

    expect(await runs.get('test-job', id)).toMatchObject({ status: 'failed', lastError: 'dead-lettered' })
  })

  it('does not let a dead letter override a done run, nor run the hook', async () => {
    const id = freshId()
    await dispatch(MAIN, [{ id: 'ok', body: { id } }])

    const { result } = await dispatch(DEAD_LETTER, [{ id: 'dl', attempts: 5, body: { id } }])

    expect(deadLettered).toEqual([])
    expect(result.explicitAcks).toEqual(['dl'])
    expect(await runs.get('test-job', id)).toMatchObject({ status: 'done', lastError: null })
  })

  it('does not run the hook again for a permanently failed run, keeping its original error', async () => {
    const id = freshId()
    behaviour.set(id, async () => {
      throw new PermanentJobError('number is not on whatsapp')
    })
    await dispatch(MAIN, [{ id: 'first', body: { id } }])

    const { result } = await dispatch(DEAD_LETTER, [{ id: 'dl', attempts: 5, body: { id } }])

    expect(deadLettered).toEqual([])
    expect(result.explicitAcks).toEqual(['dl'])
    expect(await runs.get('test-job', id)).toMatchObject({ status: 'failed', lastError: 'number is not on whatsapp' })
  })

  it('runs the hook and fails a run that is still running when its message is dead-lettered', async () => {
    const id = freshId()
    behaviour.set(id, async () => {
      throw new Error('meta down')
    })
    await dispatch(MAIN, [{ id: 'first', body: { id } }])

    await dispatch(DEAD_LETTER, [{ id: 'dl', attempts: 5, body: { id } }])

    expect(deadLettered).toEqual([{ id }])
    expect(await runs.get('test-job', id)).toMatchObject({ status: 'failed', lastError: 'dead-lettered: meta down' })
  })

  it('keeps the last retry error in D1 but never writes it to the dead-letter log line', async () => {
    const id = freshId()
    behaviour.set(id, async () => {
      throw new Error('meta down')
    })
    await dispatch(MAIN, [{ id: 'first', body: { id } }])
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})

    await dispatch(DEAD_LETTER, [{ id: 'dl', attempts: 5, body: { id } }])

    expect(log).toHaveBeenCalledWith({ job: 'test-job', key: id, attempt: 5, outcome: 'dead-lettered' })
    expect(JSON.stringify(log.mock.calls)).not.toContain('meta down')
  })
})

describe('queue handler: dead letter for a run being worked on', () => {
  it('acks without the hook or a write while the run is claimed within its lease', async () => {
    const id = freshId()
    await runs.claim('test-job', id, NOW, LEASE_MS)

    const { result } = await dispatch(DEAD_LETTER, [{ id: 'dl', attempts: 5, body: { id } }], {
      now: () => new Date(NOW.getTime() + 30 * SECOND),
    })

    expect(deadLettered).toEqual([])
    expect(result.explicitAcks).toEqual(['dl'])
    expect(await runs.get('test-job', id)).toMatchObject({
      status: 'running',
      lastError: null,
      leaseUntil: new Date(NOW.getTime() + LEASE_MS),
    })
  })

  it('runs the hook once the lease has run out, because nobody is working on it any more', async () => {
    const id = freshId()
    await runs.claim('test-job', id, NOW, LEASE_MS)

    await dispatch(DEAD_LETTER, [{ id: 'dl', attempts: 5, body: { id } }], {
      now: () => new Date(NOW.getTime() + LEASE_MS),
    })

    expect(deadLettered).toEqual([{ id }])
    expect(await runs.get('test-job', id)).toMatchObject({ status: 'failed', lastError: 'dead-lettered' })
  })
})

describe('queue handler: errors never reach a job record or a log with their message', () => {
  const SECRET = 'param-secret-7f3a'
  const leaky = () =>
    new DrizzleQueryError('insert into t (a) values (?)', [SECRET], new TypeError(`constraint failed: ${SECRET}`))

  const spyOnConsole = () => {
    const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'error')]
    for (const spy of spies) spy.mockImplementation(() => {})
    return () => JSON.stringify(spies.flatMap((spy) => spy.mock.calls))
  }

  it('records and logs a handler error by name only', async () => {
    const logged = spyOnConsole()
    const id = freshId()
    behaviour.set(id, async () => {
      throw leaky()
    })

    await dispatch(MAIN, [{ body: { id } }])

    const run = (await runs.get('test-job', id))!
    expect(run.lastError).toBe('DrizzleQueryError (cause: TypeError)')
    expect(JSON.stringify(run)).not.toContain(SECRET)
    expect(logged()).not.toContain(SECRET)
  })

  it('logs a bookkeeping failure by name only', async () => {
    const logged = spyOnConsole()
    vi.spyOn(D1JobRunsRepository.prototype, 'claim').mockRejectedValueOnce(leaky())

    await dispatch(MAIN, [{ body: { id: freshId() } }])

    expect(logged()).toContain('DrizzleQueryError (cause: TypeError)')
    expect(logged()).not.toContain(SECRET)
  })

  it('logs a dead-letter hook failure by name only', async () => {
    const logged = spyOnConsole()
    const failing = defineJob(testSpec, {
      handle: async () => {},
      onDeadLetter: async () => {
        throw leaky()
      },
    })
    const batch = createMessageBatch(DEAD_LETTER, [{ id: 'dl', timestamp: NOW, attempts: 5, body: { id: freshId() } }])
    const ctx = createExecutionContext()

    await createQueueHandler([failing], { now: () => NOW })(batch, env, ctx)
    await getQueueResult(batch, ctx)

    expect(logged()).toContain('dispatcher-error')
    expect(logged()).not.toContain(SECRET)
  })

  it('logs a purge failure by name only', async () => {
    const logged = spyOnConsole()
    vi.spyOn(D1JobRunsRepository.prototype, 'purgeOlderThan').mockRejectedValueOnce(leaky())

    await dispatch(MAIN, [{ body: { id: freshId() } }])

    expect(logged()).toContain('purge-failed')
    expect(logged()).not.toContain(SECRET)
  })

  it('logs a failed scheduled run by name only, and still rethrows it', async () => {
    const logged = spyOnConsole()
    const error = leaky()
    vi.spyOn(D1UsersRepository.prototype, 'unreachableGuestIds').mockRejectedValueOnce(error)

    await expect(createScheduledHandler()({} as ScheduledController, env)).rejects.toBe(error)

    expect(logged()).toContain('DrizzleQueryError (cause: TypeError)')
    expect(logged()).not.toContain(SECRET)
  })
})

describe('queue handler: bookkeeping failures', () => {
  it.each(['claim', 'markDone'] as const)('retries the message with a delay when %s throws', async (method) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(D1JobRunsRepository.prototype, method).mockRejectedValueOnce(new Error('d1 is down'))

    const { result, delays } = await dispatch(MAIN, [{ id: 'm', body: { id: freshId() } }])

    expect(result.retryMessages).toEqual([{ msgId: 'm' }])
    expect(result.explicitAcks).toEqual([])
    expect(delays.get('m')).toEqual(expect.any(Number))
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'dispatcher-error' }))
  })
})

describe('queue handler: unknown queue', () => {
  it('logs an error and retries the whole batch so nothing is lost while misconfigured', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})

    const { result } = await dispatch('deepertones-unknown-development', [{ body: { id: freshId() } }])

    expect(result.retryBatch.retry).toBe(true)
    expect(handled).toEqual([])
    expect(log).toHaveBeenCalled()
  })
})
