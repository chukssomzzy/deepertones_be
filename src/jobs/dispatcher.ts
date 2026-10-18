import type { z } from 'zod'
import { buildContainer, buildJobRuntime, type Container } from '../container'
import { runAs } from '../lib/context'
import { type JobDefinition, PermanentJobError, queueNames } from './job'
import { describeError } from './safe-error'

const LEASE_MS = 2 * 60 * 1000
const KEEP_RUNS_MS = 7 * 24 * 60 * 60 * 1000

type Options = {
  /** Injectable so tests can pin the jitter. */
  random?: () => number
  now?: () => Date
}

type AnyJob = JobDefinition<z.ZodType, Container>

/** `{ job, body }` and nothing else: what a producer writes to a queue its jobs share (see JobSpec.shared). */
const asEnvelope = (message: unknown): { job: unknown; body: unknown } | undefined => {
  if (typeof message !== 'object' || message === null || Array.isArray(message)) return undefined
  const keys = Object.keys(message)
  if (keys.length !== 2 || !keys.includes('job') || !keys.includes('body')) return undefined
  return message as { job: unknown; body: unknown }
}

/**
 * Which job a message is for, and its body. A message that names its job goes to that job, if the queue carries it. A bare body goes
 * to the job of a queue that carries only one (what the last deploy sent, before the queue was shared). Anything else, a job this
 * queue does not carry or a bare body on a queue of several, can never succeed, so it is undefined and the caller acks it.
 */
const pick = (jobsOnQueue: Map<string, AnyJob>, message: unknown): { job: AnyJob; body: unknown } | undefined => {
  const envelope = asEnvelope(message)
  if (envelope) {
    const job = typeof envelope.job === 'string' ? jobsOnQueue.get(envelope.job) : undefined
    return job && { job, body: envelope.body }
  }
  const [only] = jobsOnQueue.values()
  return jobsOnQueue.size === 1 && only ? { job: only, body: message } : undefined
}

/**
 * The Worker's `queue` export: one handler for every job queue and dead-letter queue. A queue carries one job or several
 * (the jobs marked `shared`); a message on the latter names its job, and a dead letter is routed the same way.
 * Per message: validate, claim the idempotency key (per job), run the handler as a system actor,
 * then ack or retry. Message bodies are never logged: they may carry secrets.
 */
export const createQueueHandler = (jobs: AnyJob[], { random = Math.random, now = () => new Date() }: Options = {}) => {
  return async (batch: MessageBatch<unknown>, env: CloudflareBindings, _ctx?: ExecutionContext): Promise<void> => {
    const route = new Map<string, { jobs: Map<string, AnyJob>; deadLetter: boolean }>()
    for (const job of jobs) {
      const names = queueNames(job.queue, env.ENVIRONMENT)
      for (const [name, deadLetter] of [[names.main, false], [names.deadLetter, true]] as const) {
        const target = route.get(name) ?? { jobs: new Map<string, AnyJob>(), deadLetter }
        target.jobs.set(job.name, job)
        route.set(name, target)
      }
    }
    const target = route.get(batch.queue)
    if (!target) {
      console.error({ outcome: 'unknown-queue', queue: batch.queue })
      batch.retryAll()
      return
    }

    const { services, jobRuns } = buildJobRuntime(env)
    const { deadLetter } = target

    for (const message of batch.messages) {
      const attempt = message.attempts
      const picked = pick(target.jobs, message.body)
      if (!picked) {
        // Only the job's name is logged, never the body, and only when it is text of a plausible length.
        const named = asEnvelope(message.body)?.job
        console.error({ queue: batch.queue, attempt, outcome: 'unknown-job', named: typeof named === 'string' ? named.slice(0, 64) : undefined })
        message.ack()
        continue
      }
      const { job } = picked
      const delaySeconds = (attempts: number) => {
        const { baseSeconds, factor, capSeconds } = job.retry
        return Math.floor(random() * Math.min(capSeconds, baseSeconds * factor ** (attempts - 1)))
      }
      const log = (level: 'log' | 'error', key: string | undefined, attempt: number, outcome: string) =>
        console[level]({ job: job.name, key, attempt, outcome })
      let key: string | undefined
      try {
        const parsed = job.schema.safeParse(picked.body)
        if (!parsed.success) {
          log('error', undefined, attempt, 'invalid-message')
          message.ack()
          continue
        }
        const body = parsed.data
        key = job.key(body)
        const actor = { kind: 'system', job: job.name } as const

        if (deadLetter) {
          // A dead letter never overrides a finished run (e.g. a duplicate delivery that succeeded), nor one another
          // delivery of the same key is working on right now: failing that item would undo work about to succeed.
          // `>` mirrors claim's `<=`: a lease that ends exactly now is over.
          const run = await jobRuns.get(job.name, key)
          if (run?.status === 'done' || run?.status === 'failed') {
            log('log', key, attempt, 'dead-letter-ignored')
            message.ack()
            continue
          }
          if (run?.status === 'running' && run.leaseUntil && run.leaseUntil.getTime() > now().getTime()) {
            log('log', key, attempt, 'dead-letter-in-progress')
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
          const reason = describeError(error)
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
        console.error({ job: job.name, key, attempt, outcome: 'dispatcher-error', error: describeError(error) })
        message.retry({ delaySeconds: delaySeconds(attempt) })
      }
    }

    try {
      await jobRuns.purgeOlderThan(new Date(now().getTime() - KEEP_RUNS_MS))
    } catch (error) {
      console.error({ queue: batch.queue, outcome: 'purge-failed', error: describeError(error) })
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
      console.error({ job, outcome: 'failed', error: describeError(error) })
      throw error
    }
  }
}
