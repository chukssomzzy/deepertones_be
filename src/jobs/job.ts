import type { z } from 'zod'

/** Throw from a handler when retrying cannot help. The run is recorded as failed and the message acked. */
export class PermanentJobError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message)
    this.name = 'PermanentJobError'
    if (options) this.cause = options.cause
  }
}

/** Full-jitter exponential backoff: the delay is random in [0, min(capSeconds, baseSeconds * factor^(attempt-1))). */
export type RetryPolicy = { baseSeconds: number; factor: number; capSeconds: number }

/**
 * What producers and the dispatcher both need: identity, message shape, idempotency key, retry policy.
 * No handler, so a service can import a spec to enqueue without a path back to the container.
 */
export type JobSpec<S extends z.ZodType = z.ZodType> = {
  /** Names the job in logs, the job_runs table and the system actor. */
  name: string
  /** The queue's base name; see queueNames for the per-environment names. */
  queue: string
  schema: S
  /** Idempotency key derived from the message's own data, not the queue's message id. */
  key(body: z.infer<S>): string
  retry: RetryPolicy
}

/**
 * A spec plus its handler. Generic over `Services` so this file never imports the container
 * (container -> service -> job spec -> container would be a cycle). Methods, not properties, so a
 * JobDefinition for one schema fits the registry's list.
 */
export type JobDefinition<S extends z.ZodType = z.ZodType, Services = unknown> = JobSpec<S> & {
  /** Calls one service method, like a route. Must be safe to repeat. */
  handle(body: z.infer<S>, services: Services): Promise<void>
  /** Runs when the message exhausted its retries and reached the dead-letter queue. */
  onDeadLetter?(body: z.infer<S>, services: Services): Promise<void>
}

/** Identity function that makes the spec's fields typed from the schema. */
export const jobSpec = <S extends z.ZodType>(spec: JobSpec<S>): JobSpec<S> => spec

/** Attaches the handler to a spec; `handle` and `onDeadLetter` receive the schema's type. */
export const defineJob = <S extends z.ZodType, Services = unknown>(
  spec: JobSpec<S>,
  handlers: {
    handle(body: z.infer<S>, services: Services): Promise<void>
    onDeadLetter?(body: z.infer<S>, services: Services): Promise<void>
  },
): JobDefinition<S, Services> => ({ ...spec, ...handlers })

/** One queue and one dead-letter queue per job per environment. */
export const queueNames = (queue: string, environment: string) => ({
  main: `deepertones-${queue}-${environment}`,
  deadLetter: `deepertones-${queue}-dlq-${environment}`,
})
