import { describe, expect, it } from 'vitest'
import { queueNames } from '../../jobs/job'
import { buildVerdictSpec } from './verdicts.job-specs'

// The build of one profile's shelf verdict (spec #171, D2b). Shapes assumed (the contract this file pins):
//   export const buildVerdictSpec           in verdicts.job-specs.ts, name 'build-verdict', queue 'verdicts'
//   body  { profileId: string, fingerprint: string, requestedAt: int >= 0 (ms), waits: int >= 0, retry?: boolean }
//   key   build-verdict:<profileId>:<requestedAt>:<waits>, with ':retry' appended when body.retry

const BODY = { profileId: 'profile-amara-1', fingerprint: 'f'.repeat(64), requestedAt: 1_000, waits: 0 } as const

describe('buildVerdictSpec', () => {
  it('is the build-verdict job on the verdicts queue, whose names match the wrangler config', () => {
    expect(buildVerdictSpec.name).toBe('build-verdict')
    expect(buildVerdictSpec.queue).toBe('verdicts')
    expect(queueNames(buildVerdictSpec.queue, 'staging')).toEqual({ main: 'deepertones-verdicts-staging', deadLetter: 'deepertones-verdicts-dlq-staging' })
  })

  it('is alone on its queue, so a producer sends the bare body and not a { job, body } envelope', () => {
    expect(buildVerdictSpec.shared).toBeUndefined()
  })

  // A nobody-is-waiting-in-a-request job whose fit call may hit a spent AI budget: it retries patiently, like the safety parse.
  it('retries patiently: 30 seconds, tripling, up to 10 minutes', () => {
    expect(buildVerdictSpec.retry).toEqual({ baseSeconds: 30, factor: 3, capSeconds: 600 })
  })

  it('keys a message by profile, the time it was requested and how many times it has waited', () => {
    expect(buildVerdictSpec.key(BODY)).toBe('build-verdict:profile-amara-1:1000:0')
    expect(buildVerdictSpec.key({ ...BODY, requestedAt: 2_000, waits: 3 })).toBe('build-verdict:profile-amara-1:2000:3')
  })

  it('gives a redelivery the same key, and a later request, another wait or another profile its own', () => {
    expect(buildVerdictSpec.key({ ...BODY })).toBe(buildVerdictSpec.key(BODY))
    expect(buildVerdictSpec.key({ ...BODY, requestedAt: 1_001 })).not.toBe(buildVerdictSpec.key(BODY))
    expect(buildVerdictSpec.key({ ...BODY, waits: 1 })).not.toBe(buildVerdictSpec.key(BODY))
    expect(buildVerdictSpec.key({ ...BODY, profileId: 'profile-tolu-1' })).not.toBe(buildVerdictSpec.key(BODY))
  })

  // The dispatcher records a dead-lettered run as failed for good, so the second try after the dead letter needs a key of its own.
  it('keys the retry after a dead letter apart from the first run, with the suffix :retry', () => {
    expect(buildVerdictSpec.key({ ...BODY, retry: true })).toBe('build-verdict:profile-amara-1:1000:0:retry')
    expect(buildVerdictSpec.key({ ...BODY, retry: false })).toBe(buildVerdictSpec.key(BODY))
  })

  it('accepts a body of ids, a hash and numbers, with or without the retry flag', () => {
    expect(buildVerdictSpec.schema.safeParse(BODY).success).toBe(true)
    expect(buildVerdictSpec.schema.safeParse({ ...BODY, retry: true }).success).toBe(true)
    expect(buildVerdictSpec.schema.safeParse({ ...BODY, requestedAt: 0, waits: 15 }).success).toBe(true)
  })

  it.each([
    ['no profile', { fingerprint: BODY.fingerprint, requestedAt: 1, waits: 0 }],
    ['a profile that is not text', { ...BODY, profileId: 7 }],
    ['no fingerprint', { profileId: BODY.profileId, requestedAt: 1, waits: 0 }],
    ['a fingerprint that is not text', { ...BODY, fingerprint: 7 }],
    ['no request time', { profileId: BODY.profileId, fingerprint: BODY.fingerprint, waits: 0 }],
    ['a request time that is not a whole number', { ...BODY, requestedAt: 1.5 }],
    ['a negative request time', { ...BODY, requestedAt: -1 }],
    ['a request time that is text', { ...BODY, requestedAt: '1000' }],
    ['no wait count', { profileId: BODY.profileId, fingerprint: BODY.fingerprint, requestedAt: 1 }],
    ['a wait count that is not a whole number', { ...BODY, waits: 0.5 }],
    ['a negative wait count', { ...BODY, waits: -1 }],
    ['a retry flag that is not a boolean', { ...BODY, retry: 'yes' }],
    ['no body', undefined],
  ])('refuses a message with %s', (_label, body) => {
    expect(buildVerdictSpec.schema.safeParse(body).success).toBe(false)
  })

  // The shelf, the goal and the safety words are personal; the message carries none of them, they are read from the database when the job runs.
  it('carries nothing but the ids, the hash and the numbers: a product name sent along is stripped', () => {
    const parsed = buildVerdictSpec.schema.safeParse({ ...BODY, name: 'Zorblax Megacream' })

    expect(parsed.success ? parsed.data : null).not.toHaveProperty('name')
  })
})
