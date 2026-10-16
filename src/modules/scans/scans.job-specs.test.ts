import { describe, expect, it } from 'vitest'
import { queueNames } from '../../jobs/job'
import { advanceScanItemSpec } from './scans.job-specs'

describe('advanceScanItemSpec', () => {
  it('is the advance-scan-item job on the scan-items queue, whose names match the wrangler config', () => {
    expect(advanceScanItemSpec.name).toBe('advance-scan-item')
    expect(advanceScanItemSpec.queue).toBe('scan-items')
    expect(queueNames(advanceScanItemSpec.queue, 'staging')).toEqual({ main: 'deepertones-scan-items-staging', deadLetter: 'deepertones-scan-items-dlq-staging' })
  })

  it('keys a message by item, step and the time the item entered the state the step works on', () => {
    expect(advanceScanItemSpec.key({ itemId: 'item-1', step: 'match', at: 1000 })).toBe('item-1:match:1000')
    expect(advanceScanItemSpec.key({ itemId: 'item-1', step: 'research', at: 1000 })).not.toBe(advanceScanItemSpec.key({ itemId: 'item-1', step: 'match', at: 1000 }))
    expect(advanceScanItemSpec.key({ itemId: 'item-2', step: 'match', at: 1000 })).not.toBe(advanceScanItemSpec.key({ itemId: 'item-1', step: 'match', at: 1000 }))
  })

  it('gives a redelivery the key of the original, and a deliberate re-send after an undo (a later entry into the state) a new one', () => {
    const original = { itemId: 'item-1', step: 'read-label', at: 1000 } as const

    expect(advanceScanItemSpec.key({ ...original })).toBe(advanceScanItemSpec.key(original))
    expect(advanceScanItemSpec.key({ ...original, at: 2000 })).not.toBe(advanceScanItemSpec.key(original))
  })

  it('retries with full-jitter backoff from 5 seconds, tripling, capped at 135', () => {
    expect(advanceScanItemSpec.retry).toEqual({ baseSeconds: 5, factor: 3, capSeconds: 135 })
  })

  it.each(['recognise', 'match', 'research', 'read-label', 'analyse'])('accepts the step %s', (step) => {
    expect(advanceScanItemSpec.schema.safeParse({ itemId: 'item-1', step, at: 1000 }).success).toBe(true)
  })

  it.each([
    ['an unknown step', { itemId: 'item-1', step: 'explode', at: 1000 }],
    ['no step', { itemId: 'item-1', at: 1000 }],
    ['no item', { step: 'match', at: 1000 }],
    ['an item that is not text', { itemId: 7, step: 'match', at: 1000 }],
    ['no time', { itemId: 'item-1', step: 'match' }],
    ['a time that is not a whole number', { itemId: 'item-1', step: 'match', at: 1000.5 }],
    ['a negative time', { itemId: 'item-1', step: 'match', at: -1 }],
    ['a time that is text', { itemId: 'item-1', step: 'match', at: '1000' }],
  ])('refuses a message with %s', (_label, body) => {
    expect(advanceScanItemSpec.schema.safeParse(body).success).toBe(false)
  })
})
