import { describe, expect, it } from 'vitest'
import type { Container } from '../../container'
import { sendOpsAlertSpec } from './ops-alerts.job-specs'
import { sendOpsAlert } from './ops-alerts.jobs'

// The handler only calls one service method; the behaviour behind it is OpsAlertsService's, tested there.
describe('sendOpsAlert job', () => {
  it('is the send-ops-alert spec with its handler attached', () => {
    expect(sendOpsAlert.name).toBe(sendOpsAlertSpec.name)
    expect(sendOpsAlert.queue).toBe(sendOpsAlertSpec.queue)
  })

  it('handles a message by sending the alert for that kind and window', async () => {
    const calls: unknown[][] = []
    const services = { opsAlerts: { send: async (...args: unknown[]) => void calls.push(args) } } as unknown as Container

    await sendOpsAlert.handle({ kind: 'ai-account', windowStart: 1000 }, services)

    expect(calls).toEqual([[{ kind: 'ai-account', windowStart: 1000 }]])
  })
})
