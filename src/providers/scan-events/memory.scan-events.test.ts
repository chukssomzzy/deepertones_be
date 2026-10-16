import { describe, expect, it } from 'vitest'
import { MemoryScanEvents } from './memory.scan-events'
import type { ScanEvent } from './scan-events.provider'

const DONE: ScanEvent = { type: 'done' }

describe('MemoryScanEvents', () => {
  it('starts with nothing published', () => {
    expect(new MemoryScanEvents().published).toEqual([])
  })

  it('records each event with its scan, in the order published', async () => {
    const events = new MemoryScanEvents()

    await events.publish('scan-1', DONE)
    await events.publish('scan-2', DONE)
    await events.publish('scan-1', DONE)

    expect(events.published.map((p) => p.scanId)).toEqual(['scan-1', 'scan-2', 'scan-1'])
    expect(events.published[0]).toEqual({ scanId: 'scan-1', event: DONE })
  })

  it('lists the events of one scan only', async () => {
    const events = new MemoryScanEvents()
    await events.publish('scan-1', DONE)
    await events.publish('scan-2', DONE)

    expect(events.eventsFor('scan-1')).toEqual([DONE])
    expect(events.eventsFor('scan-3')).toEqual([])
  })

  it('records each subscription with its scan and snapshot, and answers an event stream', async () => {
    const events = new MemoryScanEvents()
    const snapshot = { id: 'scan-1', items: [] }

    const response = await events.subscribe('scan-1', snapshot)

    expect(events.subscribed).toEqual([{ scanId: 'scan-1', snapshot }])
    expect(response.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8')
  })
})
