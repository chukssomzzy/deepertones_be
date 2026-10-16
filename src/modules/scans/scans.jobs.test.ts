import { describe, expect, it } from 'vitest'
import type { Container } from '../../container'
import { advanceScanItem } from './scans.jobs'
import { advanceScanItemSpec } from './scans.job-specs'

// The handlers only call one service method each; the behaviour behind them is ScanService's, tested there.
const recordingServices = () => {
  const calls: unknown[][] = []
  const services = {
    scans: {
      advance: async (...args: unknown[]) => void calls.push(['advance', ...args]),
      markItemFailed: async (...args: unknown[]) => void calls.push(['markItemFailed', ...args]),
    },
  } as unknown as Container
  return { calls, services }
}

describe('advanceScanItem job', () => {
  it('is the advance-scan-item spec with its handlers attached', () => {
    expect(advanceScanItem.name).toBe(advanceScanItemSpec.name)
    expect(advanceScanItem.queue).toBe(advanceScanItemSpec.queue)
  })

  it('handles a message by advancing the item by that step', async () => {
    const { calls, services } = recordingServices()

    await advanceScanItem.handle({ itemId: 'item-1', step: 'research', at: 1000 }, services)

    expect(calls).toEqual([['advance', 'item-1', 'research']])
  })

  it('handles a dead letter by marking the item failed', async () => {
    const { calls, services } = recordingServices()

    await advanceScanItem.onDeadLetter!({ itemId: 'item-1', step: 'research', at: 1000 }, services)

    expect(calls).toEqual([['markItemFailed', 'item-1']])
  })
})
