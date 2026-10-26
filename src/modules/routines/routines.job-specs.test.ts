import { describe, expect, it } from 'vitest'
import { queueNames } from '../../jobs/job'
import { buildRoutineSpec } from './routines.job-specs'

// The build of one profile's routine (spec #189, PR 3b). Shapes assumed (the contract this file pins):
//   export const buildRoutineSpec           in routines.job-specs.ts, name 'build-routine', queue 'routines'
//   body  { profileId: string, reason: <a routine_versions reason>, requestKey: string, requestedAt: int >= 0 (ms), waits: int >= 0, retry?: boolean }
//   key   build-routine:<profileId>:<requestKey>:<requestedAt>:<waits>, with ':retry' appended when body.retry

const BODY = { profileId: 'profile-amara-1', reason: 'first', requestKey: 'routine-fp-1', requestedAt: 1_000, waits: 0 } as const

// Written out, not read from the table: the message may carry exactly the reasons a version can be stored with.
const REASONS = ['first', 'shelf', 'goal', 'safety', 'verdict', 'review-point', 'catalog-retired', 'sold-here', 'got-it', 'writer-retry']

describe('buildRoutineSpec', () => {
  it('is the build-routine job on the routines queue, whose names match the wrangler config', () => {
    expect(buildRoutineSpec.name).toBe('build-routine')
    expect(buildRoutineSpec.queue).toBe('routines')
    expect(queueNames(buildRoutineSpec.queue, 'staging')).toEqual({ main: 'deepertones-routines-staging', deadLetter: 'deepertones-routines-dlq-staging' })
  })

  // Sharing the verdicts queue would make a bare verdict body already in flight at deploy time unroutable.
  it('is alone on a queue of its own, so a producer sends the bare body and not a { job, body } envelope', () => {
    expect(buildRoutineSpec.shared).toBeUndefined()
    expect(buildRoutineSpec.queue).not.toBe('verdicts')
  })

  it('retries as patiently as the verdict build: 30 seconds, tripling, up to 10 minutes', () => {
    expect(buildRoutineSpec.retry).toEqual({ baseSeconds: 30, factor: 3, capSeconds: 600 })
  })

  it('keys a message by profile, request key, the time it was requested and how many times it has waited', () => {
    expect(buildRoutineSpec.key(BODY)).toBe('build-routine:profile-amara-1:routine-fp-1:1000:0')
    expect(buildRoutineSpec.key({ ...BODY, requestedAt: 2_000, waits: 3 })).toBe('build-routine:profile-amara-1:routine-fp-1:2000:3')
    expect(buildRoutineSpec.key({ ...BODY, requestKey: 'review-point:scan-9' })).toBe('build-routine:profile-amara-1:review-point:scan-9:1000:0')
  })

  it('gives a redelivery the same key, and another request, time, wait or profile its own', () => {
    expect(buildRoutineSpec.key({ ...BODY })).toBe(buildRoutineSpec.key(BODY))
    expect(buildRoutineSpec.key({ ...BODY, requestKey: 'routine-fp-2' })).not.toBe(buildRoutineSpec.key(BODY))
    expect(buildRoutineSpec.key({ ...BODY, requestedAt: 1_001 })).not.toBe(buildRoutineSpec.key(BODY))
    expect(buildRoutineSpec.key({ ...BODY, waits: 1 })).not.toBe(buildRoutineSpec.key(BODY))
    expect(buildRoutineSpec.key({ ...BODY, profileId: 'profile-tolu-1' })).not.toBe(buildRoutineSpec.key(BODY))
  })

  // The dispatcher records a dead-lettered run as failed for good, so the second try after the dead letter needs a key of its own.
  it('keys the retry after a dead letter apart from the first run, with the suffix :retry', () => {
    expect(buildRoutineSpec.key({ ...BODY, retry: true })).toBe('build-routine:profile-amara-1:routine-fp-1:1000:0:retry')
    expect(buildRoutineSpec.key({ ...BODY, retry: false })).toBe(buildRoutineSpec.key(BODY))
  })

  it('accepts a body of ids, a reason and numbers, with or without the retry flag', () => {
    expect(buildRoutineSpec.schema.safeParse(BODY).success).toBe(true)
    expect(buildRoutineSpec.schema.safeParse({ ...BODY, retry: true }).success).toBe(true)
    expect(buildRoutineSpec.schema.safeParse({ ...BODY, requestedAt: 0, waits: 15 }).success).toBe(true)
  })

  it.each(REASONS)('accepts the reason %s', (reason) => {
    expect(buildRoutineSpec.schema.safeParse({ ...BODY, reason }).success).toBe(true)
  })

  it.each([
    ['no profile', { reason: 'first', requestKey: 'k', requestedAt: 1, waits: 0 }],
    ['a profile that is not text', { ...BODY, profileId: 7 }],
    ['no reason', { profileId: BODY.profileId, requestKey: 'k', requestedAt: 1, waits: 0 }],
    ['a reason a version is never stored with', { ...BODY, reason: 'whim' }],
    ['a reason that is not text', { ...BODY, reason: 1 }],
    ['no request key', { profileId: BODY.profileId, reason: 'first', requestedAt: 1, waits: 0 }],
    ['a request key that is not text', { ...BODY, requestKey: 7 }],
    ['no request time', { profileId: BODY.profileId, reason: 'first', requestKey: 'k', waits: 0 }],
    ['a request time that is not a whole number', { ...BODY, requestedAt: 1.5 }],
    ['a negative request time', { ...BODY, requestedAt: -1 }],
    ['a request time that is text', { ...BODY, requestedAt: '1000' }],
    ['no wait count', { profileId: BODY.profileId, reason: 'first', requestKey: 'k', requestedAt: 1 }],
    ['a wait count that is not a whole number', { ...BODY, waits: 0.5 }],
    ['a negative wait count', { ...BODY, waits: -1 }],
    ['a retry flag that is not a boolean', { ...BODY, retry: 'yes' }],
    ['no body', undefined],
  ])('refuses a message with %s', (_label, body) => {
    expect(buildRoutineSpec.schema.safeParse(body).success).toBe(false)
  })

  // The shelf, the goal and the safety words are personal; the message carries none of them, they are read from the database when the job runs.
  it('carries nothing but the ids, the reason and the numbers: a product name sent along is stripped', () => {
    const parsed = buildRoutineSpec.schema.safeParse({ ...BODY, name: 'Zorblax Megacream' })

    expect(parsed.success ? parsed.data : null).not.toHaveProperty('name')
  })
})
