import { describe, expect, it } from 'vitest'
import type { Container } from '../container'
import { buildRoutine } from '../modules/routines/routines.jobs'
import { buildRoutineSpec } from '../modules/routines/routines.job-specs'
import { queueNames } from './job'
import { jobs } from './registry'

describe('the job registry', () => {
  it('lists the advance-scan-item job', () => {
    const job = jobs.find((j) => j.name === 'advance-scan-item')

    expect(job).toBeDefined()
    expect(job!.queue).toBe('scan-items')
    expect(job!.onDeadLetter).toBeTypeOf('function')
  })

  it('still lists the OTP delivery job', () => {
    expect(jobs.map((j) => j.name)).toContain('deliver-otp')
  })

  it('lists the send-push job on its own push-delivery queue', () => {
    const job = jobs.find((j) => j.name === 'send-push')

    expect(job).toBeDefined()
    expect(job!.queue).toBe('push-delivery')
  })

  it('lists the check-push-receipts job on its own push-receipts queue', () => {
    const job = jobs.find((j) => j.name === 'check-push-receipts')

    expect(job).toBeDefined()
    expect(job!.queue).toBe('push-receipts')
  })

  it('lists the parse-safety job on its own parse-safety queue, with a hook for when its retries run out', () => {
    const job = jobs.find((j) => j.name === 'parse-safety')

    expect(job).toBeDefined()
    expect(job!.queue).toBe('parse-safety')
    expect(job!.onDeadLetter).toBeTypeOf('function')
  })

  it('lists the build-verdict job on its own verdicts queue, with a hook for when its retries run out', () => {
    const job = jobs.find((j) => j.name === 'build-verdict')

    expect(job).toBeDefined()
    expect(job!.queue).toBe('verdicts')
    expect(job!.shared).toBeUndefined()
    expect(job!.onDeadLetter).toBeTypeOf('function')
  })

  it('lists the build-routine job on its own routines queue, apart from the verdicts queue, with a hook for when its retries run out', () => {
    const job = jobs.find((j) => j.name === 'build-routine')

    expect(job).toBeDefined()
    expect(job!.queue).toBe('routines')
    expect(job!.queue).not.toBe(jobs.find((j) => j.name === 'build-verdict')!.queue)
    expect(job!.shared).toBeUndefined()
    expect(job!.onDeadLetter).toBeTypeOf('function')
  })

  it('lists the send-ops-alert job on the shared email queue', () => {
    const job = jobs.find((j) => j.name === 'send-ops-alert')

    expect(job).toBeDefined()
    expect(job!.queue).toBe('email')
    expect(job!.shared).toBe(true)
  })

  it('gives every job its own name, because the dispatcher and the job_runs table tell jobs apart by it', () => {
    expect(new Set(jobs.map((j) => j.name)).size).toBe(jobs.length)
  })

  // A message on a shared queue names its job; the dispatcher accepts a bare body only on a queue that carries one job.
  it('flags every job of a queue as shared or none of them, and flags the jobs of a queue that carries several', () => {
    for (const [queue, onQueue] of Map.groupBy(jobs, (j) => j.queue)) {
      const flags = new Set(onQueue.map((j) => Boolean(j.shared)))

      expect(flags.size, queue).toBe(1)
      if (onQueue.length > 1) expect(flags.has(true), queue).toBe(true)
    }
  })

  it('gives every queue its own dead-letter queue, and no two queues the same names', () => {
    const queues = [...new Set(jobs.map((j) => j.queue))]
    const names = queues.flatMap((q) => Object.values(queueNames(q, 'test')))

    expect(new Set(names).size).toBe(queues.length * 2)
    for (const queue of queues) expect(queueNames(queue, 'test').deadLetter).not.toBe(queueNames(queue, 'test').main)
  })
})

// The build-routine handlers only call one service method each; the behaviour behind them is RoutineService's, tested there.
const recordingServices = () => {
  const calls: unknown[][] = []
  const services = {
    routines: {
      run: async (...args: unknown[]) => void calls.push(['run', ...args]),
      markBuildFailed: async (...args: unknown[]) => void calls.push(['markBuildFailed', ...args]),
    },
  } as unknown as Container
  return { calls, services }
}

const BUILD_ROUTINE_BODY = { profileId: 'profile-amara-1', reason: 'first', requestKey: 'routine-fp-1', requestedAt: 1_000, waits: 2 } as const

describe('buildRoutine job', () => {
  it('is the build-routine spec with its handlers attached', () => {
    expect(buildRoutine.name).toBe(buildRoutineSpec.name)
    expect(buildRoutine.queue).toBe(buildRoutineSpec.queue)
  })

  it('handles a message by running the routine service on the whole body', async () => {
    const { calls, services } = recordingServices()

    await buildRoutine.handle(BUILD_ROUTINE_BODY, services)

    expect(calls).toEqual([['run', BUILD_ROUTINE_BODY]])
  })

  it('handles a dead letter by marking the build failed, with the whole body', async () => {
    const { calls, services } = recordingServices()

    await buildRoutine.onDeadLetter!({ ...BUILD_ROUTINE_BODY, retry: true }, services)

    expect(calls).toEqual([['markBuildFailed', { ...BUILD_ROUTINE_BODY, retry: true }]])
  })
})
