import { describe, expect, it } from 'vitest'
import { queueNames } from '../../jobs/job'
import { analyseFaceScanSpec } from './face-scans.job-specs'

describe('analyseFaceScanSpec', () => {
  it('is the analyse-face-scan job on the face-scans queue, whose names match the wrangler config', () => {
    expect(analyseFaceScanSpec.name).toBe('analyse-face-scan')
    expect(analyseFaceScanSpec.queue).toBe('face-scans')
    expect(queueNames(analyseFaceScanSpec.queue, 'staging')).toEqual({ main: 'deepertones-face-scans-staging', deadLetter: 'deepertones-face-scans-dlq-staging' })
  })

  it('is alone on its queue, so a producer sends the bare body and not a { job, body } envelope', () => {
    expect(analyseFaceScanSpec.shared).toBeUndefined()
  })

  it('keys a message by face scan, step and the time it was queued for, so a redelivery shares a key and a later re-send does not', () => {
    const original = { faceScanId: 'scan-1', step: 'upload', at: 1000 } as const

    expect(analyseFaceScanSpec.key({ ...original })).toBe(analyseFaceScanSpec.key(original))
    expect(analyseFaceScanSpec.key({ ...original, at: 2000 })).not.toBe(analyseFaceScanSpec.key(original))
    expect(analyseFaceScanSpec.key({ ...original, faceScanId: 'scan-2' })).not.toBe(analyseFaceScanSpec.key(original))
  })

  it('retries with full-jitter backoff that waits at least a second to begin with, never shrinks and has a cap', () => {
    const { baseSeconds, factor, capSeconds } = analyseFaceScanSpec.retry

    expect(baseSeconds).toBeGreaterThanOrEqual(1)
    expect(factor).toBeGreaterThanOrEqual(1)
    expect(capSeconds).toBeGreaterThanOrEqual(baseSeconds)
  })

  it('keys a webhook-driven message by the webhook\'s id and not the time, so a webhook delivered twice is one run', () => {
    const delivery = { faceScanId: 'scan-1', step: 'fetch', at: 1000, webhookId: 'msg_abc' } as const

    expect(analyseFaceScanSpec.key(delivery)).toBe('scan-1:fetch:wh:msg_abc')
    expect(analyseFaceScanSpec.key({ ...delivery, at: 999_999 })).toBe(analyseFaceScanSpec.key(delivery))
    expect(analyseFaceScanSpec.key({ ...delivery, webhookId: 'msg_def' })).not.toBe(analyseFaceScanSpec.key(delivery))
  })

  it('keys a step with no webhook id by face scan, step and time', () => {
    expect(analyseFaceScanSpec.key({ faceScanId: 'scan-1', step: 'upload', at: 1000 })).toBe('scan-1:upload:1000')
    expect(analyseFaceScanSpec.key({ faceScanId: 'scan-1', step: 'fetch', at: 2000 })).toBe('scan-1:fetch:2000')
  })

  it('keeps the steps of one scan apart even for one webhook id', () => {
    const fetchKey = analyseFaceScanSpec.key({ faceScanId: 'scan-1', step: 'fetch', at: 1, webhookId: 'msg_abc' })
    const fitzpatrickKey = analyseFaceScanSpec.key({ faceScanId: 'scan-1', step: 'fitzpatrick', at: 1, webhookId: 'msg_abc' })

    expect(fitzpatrickKey).not.toBe(fetchKey)
  })

  it.each(['upload', 'fetch', 'fitzpatrick'])('accepts the %s step', (step) => {
    expect(analyseFaceScanSpec.schema.safeParse({ faceScanId: 'scan-1', step, at: 1000 }).success).toBe(true)
  })

  it('accepts a webhook id on a step, and refuses one that is not text', () => {
    expect(analyseFaceScanSpec.schema.safeParse({ faceScanId: 'scan-1', step: 'fetch', at: 1000, webhookId: 'msg_abc' }).success).toBe(true)
    expect(analyseFaceScanSpec.schema.safeParse({ faceScanId: 'scan-1', step: 'fetch', at: 1000, webhookId: 5 }).success).toBe(false)
  })

  it.each([
    ['an unknown step', { faceScanId: 'scan-1', step: 'explode', at: 1000 }],
    ['no step', { faceScanId: 'scan-1', at: 1000 }],
    ['no face scan', { step: 'upload', at: 1000 }],
    ['a face scan that is not text', { faceScanId: 7, step: 'upload', at: 1000 }],
    ['no time', { faceScanId: 'scan-1', step: 'upload' }],
    ['a time that is not a whole number', { faceScanId: 'scan-1', step: 'upload', at: 1000.5 }],
    ['a negative time', { faceScanId: 'scan-1', step: 'upload', at: -1 }],
    ['a time that is text', { faceScanId: 'scan-1', step: 'upload', at: '1000' }],
  ])('refuses a message with %s', (_label, body) => {
    expect(analyseFaceScanSpec.schema.safeParse(body).success).toBe(false)
  })
})
