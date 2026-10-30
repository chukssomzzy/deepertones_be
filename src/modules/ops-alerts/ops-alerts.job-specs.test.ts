import { describe, expect, it } from 'vitest'
import { queueNames } from '../../jobs/job'
import { sendOpsAlertSpec } from './ops-alerts.job-specs'

describe('sendOpsAlertSpec', () => {
  it('is the send-ops-alert job on the shared email queue, whose names match the wrangler config', () => {
    expect(sendOpsAlertSpec.name).toBe('send-ops-alert')
    expect(sendOpsAlertSpec.queue).toBe('email')
    expect(sendOpsAlertSpec.shared).toBe(true)
    expect(queueNames(sendOpsAlertSpec.queue, 'staging')).toEqual({ main: 'deepertones-email-staging', deadLetter: 'deepertones-email-dlq-staging' })
  })

  it('keys a message by its kind and window, so a redelivery is one email and the next window is another', () => {
    expect(sendOpsAlertSpec.key({ kind: 'ai-account', windowStart: 1000 })).toBe('ai-account:1000')
    expect(sendOpsAlertSpec.key({ kind: 'ai-account', windowStart: 1000 })).toBe(sendOpsAlertSpec.key({ kind: 'ai-account', windowStart: 1000 }))
    expect(sendOpsAlertSpec.key({ kind: 'ai-account', windowStart: 2000 })).not.toBe(sendOpsAlertSpec.key({ kind: 'ai-account', windowStart: 1000 }))
    expect(sendOpsAlertSpec.key({ kind: 'ai-spend-cap', windowStart: 1000 })).not.toBe(sendOpsAlertSpec.key({ kind: 'ai-account', windowStart: 1000 }))
  })

  // An email that fails to send is retried for a while; the next window's raise sends a fresh one anyway.
  it('retries with full-jitter backoff from 5 seconds, tripling, capped at 135', () => {
    expect(sendOpsAlertSpec.retry).toEqual({ baseSeconds: 5, factor: 3, capSeconds: 135 })
  })

  it.each(['ai-account', 'ai-spend-cap', 'research-budget', 'analysis-budget', 'verdict-report', 'wrong-match-report', 'share-render-quota'])('accepts the kind %s', (kind) => {
    expect(sendOpsAlertSpec.schema.safeParse({ kind, windowStart: 1000 }).success).toBe(true)
  })

  it.each([
    ['an unknown kind', { kind: 'disk-full', windowStart: 1000 }],
    ['no kind', { windowStart: 1000 }],
    ['no window', { kind: 'ai-account' }],
    ['a window that is text', { kind: 'ai-account', windowStart: '1000' }],
    ['a window that is not a whole number', { kind: 'ai-account', windowStart: 1000.5 }],
    ['a negative window', { kind: 'ai-account', windowStart: -1 }],
  ])('refuses a message with %s', (_label, body) => {
    expect(sendOpsAlertSpec.schema.safeParse(body).success).toBe(false)
  })
})
