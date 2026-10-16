import type { z } from 'zod'
import { buildContainer, buildJobRuntime, type Container } from '../container'
import { runAs } from '../lib/context'
import { type JobDefinition, PermanentJobError, queueNames } from './job'

const LEASE_MS = 2 * 60 * 1000
const KEEP_RUNS_MS = 7 * 24 * 60 * 60 * 1000

type Options = {
  /** Injectable so tests can pin the jitter. */
  random?: () => number
  now?: () => Date
}

/**
 * The Worker's `queue` export: one handler for every job queue and dead-letter queue.
 * Per message: validate, claim the idempotency key, run the handler as a system actor,
 * then ack or retry. Message bodies are never logged: they may carry secrets.
 */
export const createQueueHandler = (jobs: JobDefinition<z.ZodType, Container>[], { random = Math.random, now = () => new Date() }: Options = {}) => {
  return async (batch: MessageBatch<unknown>, env: CloudflareBindings, _ctx?: ExecutionContext): Promise<void> => {
    const route = new Map<string, { job: JobDefinition<z.ZodType, Container>; deadLetter: boolean }>()
    for (const job of jobs) {
      const names = queueNames(job.queue, env.ENVIRONMENT)
      route.set(names.main, { job, deadLetter: false })
      route.set(names.deadLetter, { job, deadLetter: true })
    }
    const target = route.get(batch.queue)
    if (!target) {
      console.error({ outcome: 'unknown-queue', queue: batch.queue })
      batch.retryAll()
      return
    }

    const { services, jobRuns } = buildJobRuntime(env)
    const { job, deadLetter } = target
    const delaySeconds = (attempts: number) => {
      const { baseSeconds, factor, capSeconds } = job.retry
      return Math.floor(random() * Math.min(capSeconds, baseSeconds * factor ** (attempts - 1)))
    }
    const log = (level: 'log' | 'error', key: string | undefined, attempt: number, outcome: string) =>
      console[level]({ job: job.name, key, attempt, outcome })

    for (const message of batch.messages) {
      const attempt = message.attempts
      let key: string | undefined
      try {
        const parsed = job.schema.safeParse(message.body)
        if (!parsed.success) {
          log('error', undefined, attempt, 'invalid-message')
          message.ack()
          continue
        }
        const body = parsed.data
        key = job.key(body)
        const actor = { kind: 'system', job: job.name } as const

        if (deadLetter) {
          // A dead letter never overrides a finished run (e.g. a duplicate delivery that succeeded).
          const run = await jobRuns.get(job.name, key)
          if (run?.status === 'done' || run?.status === 'failed') {
            log('log', key, attempt, 'dead-letter-ignored')
            message.ack()
            continue
          }
          await runAs(actor, () => job.onDeadLetter?.(body, services))
          await jobRuns.markDeadLettered(job.name, key, now())
          log('error', key, attempt, 'dead-lettered')
          message.ack()
          continue
        }

        const claim = await jobRuns.claim(job.name, key, now(), LEASE_MS)
        if (claim.outcome !== 'claimed') {
          if (claim.outcome === 'busy') {
            log('log', key, attempt, 'busy')
            message.retry({ delaySeconds: delaySeconds(attempt) })
          } else {
            log('log', key, attempt, `duplicate-${claim.outcome}`)
            message.ack()
          }
          continue
        }

        try {
          await runAs(actor, () => job.handle(body, services))
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error)
          if (error instanceof PermanentJobError) {
            await jobRuns.markFailed(job.name, key, reason, now())
            log('error', key, attempt, 'permanent-failure')
            message.ack()
          } else {
            // False means our lease was taken over; the new owner's run is untouched either way.
            await jobRuns.release(job.name, key, claim.token, reason, now())
            log('error', key, attempt, 'retry')
            message.retry({ delaySeconds: delaySeconds(attempt) })
          }
          continue
        }
        const applied = await jobRuns.markDone(job.name, key, claim.token, now())
        log('log', key, attempt, applied ? 'done' : 'lease-lost')
        message.ack()
      } catch (error) {
        // The bookkeeping itself failed (D1 down, hook threw): let the queue redeliver.
        console.error({ job: job.name, key, attempt, outcome: 'dispatcher-error', error: String(error) })
        message.retry({ delaySeconds: delaySeconds(attempt) })
      }
    }

    try {
      await jobRuns.purgeOlderThan(new Date(now().getTime() - KEEP_RUNS_MS))
    } catch (error) {
      console.error({ job: job.name, outcome: 'purge-failed', error: String(error) })
    }
  }
}

/**
 * The Worker's `scheduled` export: the daily guest cleanup. Runs as a system actor. A failure is logged and
 * rethrown so Cloudflare records the run as failed; the next day's run picks up where this one stopped.
 * Lives here, not in its own file, because this is the one jobs entry the context-only-in-services rule lets call runAs.
 */
export const createScheduledHandler = () => {
  return async (_controller: ScheduledController, env: CloudflareBindings, _ctx?: ExecutionContext): Promise<void> => {
    const job = 'guest-cleanup'
    try {
      const { deleted } = await runAs({ kind: 'system', job }, () => buildContainer(env).users.purgeUnreachableGuests())
      console.log({ job, outcome: 'done', deleted })
    } catch (error) {
      console.error({ job, outcome: 'failed', error: String(error) })
      throw error
    }
  }
}
