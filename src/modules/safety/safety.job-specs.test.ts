import { describe, expect, it } from 'vitest'
import { queueNames } from '../../jobs/job'
import { parseSafetySpec } from './safety.job-specs'

describe('the parse-safety job', () => {
  it('is named parse-safety on its own parse-safety queue', () => {
    expect(parseSafetySpec.name).toBe('parse-safety')
    expect(parseSafetySpec.queue).toBe('parse-safety')
  })

  it('gets the queue and dead-letter queue names the wrangler config binds, per environment', () => {
    expect(queueNames(parseSafetySpec.queue, 'staging')).toEqual({
      main: 'deepertones-parse-safety-staging',
      deadLetter: 'deepertones-parse-safety-dlq-staging',
    })
  })

  // Nobody waits for a parse and a spent AI budget needs spacing between tries, so it retries like the receipt check, not like a send.
  it('retries patiently: 30 seconds, tripling, up to 10 minutes', () => {
    expect(parseSafetySpec.retry).toEqual({ baseSeconds: 30, factor: 3, capSeconds: 600 })
  })

  it('accepts a body that is just the id of the safety row', () => {
    expect(parseSafetySpec.schema.safeParse({ safetyId: 'safety-1' }).success).toBe(true)
  })

  it.each([
    ['no id', {}],
    ['an id that is not a string', { safetyId: 7 }],
    ['a null id', { safetyId: null }],
    ['no body', undefined],
  ])('rejects %s', (_name, body) => {
    expect(parseSafetySpec.schema.safeParse(body).success).toBe(false)
  })

  // The text itself is personal, so it must never be a field the queue carries.
  it('carries nothing but the id: the words the person typed stay out of the queue message', () => {
    const parsed = parseSafetySpec.schema.safeParse({ safetyId: 'safety-1', reactionText: 'Caro White' })

    expect(parsed.success ? parsed.data : null).not.toHaveProperty('reactionText')
  })

  it('keys a message by the safety row, so a repeated message, or a repair after a lost one, is one run', () => {
    expect(parseSafetySpec.key({ safetyId: 'safety-1' })).toBe('parse-safety:safety-1')
    expect(parseSafetySpec.key({ safetyId: 'safety-1' })).toBe(parseSafetySpec.key({ safetyId: 'safety-1' }))
    expect(parseSafetySpec.key({ safetyId: 'safety-2' })).toBe('parse-safety:safety-2')
  })
})
