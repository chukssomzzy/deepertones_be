import { abortAllDurableObjects, runInDurableObject } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseFrame, sseReader, type SseReader } from '../../test/integration/sse'
import type { ScanEvent } from '../providers/scan-events/scan-events.provider'
import { SCAN_STREAM_TIMING, ScanStream } from './scan-stream'

// The ScanStream Durable Object through the two doors the rest of the Worker uses: stub.fetch(snapshot) opens a client's
// event stream, and RPC stub.publish(event) pushes to every open client. Each test uses its own scan id, so one test's
// open streams never reach another's, and every stream a test opens is released afterwards.
//
// Time-based behaviour (pings, the lifetime cap) cannot be driven with fake timers here: a faked timer fires in the test's
// context, and workerd refuses I/O across Durable Object contexts. So the two intervals are one exported, mutable object,
// SCAN_STREAM_TIMING, which the Durable Object must read when a client CONNECTS (not once at module load). A test lowers
// it before opening a stream, and the afterEach restores it. The first test pins the real values so lowering can never ship.
//
// Closing a stream when its client goes away needs the `enable_request_signal` compatibility flag in wrangler.jsonc. The
// plugin reads flags from that file, so the abort test stays red until the flag is there.

const REAL_TIMING = { pingMs: 20_000, maxLifetimeMs: 10 * 60 * 1000 }
const SECOND = 1000

const SNAPSHOT = { id: 'scan-snapshot', createdAt: '2030-06-15T12:00:00.000Z', items: [{ id: 'item-1', position: 0, state: 'recognising', reason: null }] }
const itemEvent = (item: Record<string, unknown>) => ({ type: 'item', item }) as unknown as ScanEvent
const DONE = { type: 'done' } as ScanEvent

const stubFor = (scanId: string) => env.SCAN_STREAM.get(env.SCAN_STREAM.idFromName(scanId))
const freshScanId = () => `scan-stream-${crypto.randomUUID()}`

const opened: SseReader[] = []
/** Opens a client's stream the way the Worker does: POST the scan's current state to the scan's Durable Object. */
const subscribe = async (scanId: string, snapshot: unknown = SNAPSHOT) => {
  const res = await stubFor(scanId).fetch(new Request('https://scan-stream/subscribe', { method: 'POST', body: JSON.stringify(snapshot) }))
  const stream = sseReader(res)
  opened.push(stream)
  return { res, stream }
}
const clientCount = (scanId: string) => runInDurableObject(stubFor(scanId), (instance: ScanStream) => instance.clientCount())
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

afterEach(async () => {
  Object.assign(SCAN_STREAM_TIMING, REAL_TIMING)
  await Promise.all(opened.splice(0).map((stream) => stream.cancel()))
  await abortAllDurableObjects()
})

describe('ScanStream timing', () => {
  it('pings every 20 seconds and closes every stream after 10 minutes', () => {
    expect(SCAN_STREAM_TIMING).toEqual({ pingMs: 20_000, maxLifetimeMs: 600_000 })
  })
})

describe('ScanStream subscribe', () => {
  it('answers with an event stream that no proxy buffers or rewrites', async () => {
    const { res } = await subscribe(freshScanId())

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8')
    expect(res.headers.get('Cache-Control')).toBe('no-cache, no-transform')
    expect(res.headers.get('X-Accel-Buffering')).toBe('no')
  })

  it('sends the snapshot it was given as the first frame, as an event named snapshot', async () => {
    const { stream } = await subscribe(freshScanId())

    const { frames } = await stream.read(1)

    expect(frames).toEqual([`event: snapshot\ndata: ${JSON.stringify(SNAPSHOT)}`])
  })

  it('opens a stream for each client of one scan, each starting with its own snapshot', async () => {
    const scanId = freshScanId()
    const later = { ...SNAPSHOT, items: [{ ...SNAPSHOT.items[0], state: 'matching' }] }

    const first = await subscribe(scanId)
    const second = await subscribe(scanId, later)

    expect((await first.stream.read(1)).frames).toEqual([`event: snapshot\ndata: ${JSON.stringify(SNAPSHOT)}`])
    expect((await second.stream.read(1)).frames).toEqual([`event: snapshot\ndata: ${JSON.stringify(later)}`])
    expect(await clientCount(scanId)).toBe(2)
  })
})

describe('ScanStream publish', () => {
  it('writes an item event to an open client as an event named item whose data is the item', async () => {
    const scanId = freshScanId()
    const { stream } = await subscribe(scanId)
    await stream.read(1)
    const item = { id: 'item-1', position: 0, state: 'matching', reason: null }

    await stubFor(scanId).publish(itemEvent(item))

    expect((await stream.read(1)).frames).toEqual([`event: item\ndata: ${JSON.stringify(item)}`])
  })

  it('writes every event to every client of the scan, in the order published', async () => {
    const scanId = freshScanId()
    const first = await subscribe(scanId)
    const second = await subscribe(scanId)
    const states = ['matching', 'researching', 'analysing']

    for (const state of states) await stubFor(scanId).publish(itemEvent({ id: 'item-1', state }))

    for (const { stream } of [first, second]) {
      const { frames } = await stream.read(4)
      expect(frames.map((frame) => parseFrame(frame).event)).toEqual(['snapshot', 'item', 'item', 'item'])
      expect(frames.slice(1).map((frame) => (parseFrame(frame).data as { state: string }).state)).toEqual(states)
    }
  })

  it('writes to the clients of that scan only', async () => {
    const watched = freshScanId()
    const other = freshScanId()
    const mine = await subscribe(watched)
    await mine.stream.read(1)

    await stubFor(other).publish(itemEvent({ id: 'item-9', state: 'matching' }))

    const { frames, ended } = await mine.stream.read(1, 200)
    expect(frames).toEqual([])
    expect(ended).toBe(false)
  })

  it('has nothing to do, and does not fail, when nobody is connected to the scan', async () => {
    await stubFor(freshScanId()).publish(itemEvent({ id: 'item-1', state: 'matching' }))
    await stubFor(freshScanId()).publish(DONE)
  })

  it('does not wait for a client that stopped reading, and that client does not hold back the others', { timeout: 8 * SECOND }, async () => {
    const scanId = freshScanId()
    const stalled = await subscribe(scanId) // never read
    const healthy = await subscribe(scanId)
    await healthy.stream.read(1)
    const total = 30
    const arriving = healthy.stream.read(total, 5 * SECOND)

    const started = Date.now()
    for (let n = 0; n < total; n++) await stubFor(scanId).publish(itemEvent({ id: 'item-1', n }))
    const publishing = Date.now() - started

    expect(publishing).toBeLessThan(2 * SECOND)
    const { frames } = await arriving
    expect(frames.map((frame) => (parseFrame(frame).data as { n: number }).n)).toEqual(Array.from({ length: total }, (_, n) => n))
    void stalled
  })

  it('drops a client whose backlog grows past 20 frames, and keeps the one that reads', { timeout: 8 * SECOND }, async () => {
    const scanId = freshScanId()
    await subscribe(scanId) // never read
    const healthy = await subscribe(scanId)
    await healthy.stream.read(1)
    const total = 40
    const arriving = healthy.stream.read(total, 5 * SECOND)

    for (let n = 0; n < total; n++) await stubFor(scanId).publish(itemEvent({ id: 'item-1', n }))
    await arriving

    expect(await clientCount(scanId)).toBe(1)
  })

  it('keeps a client that is only a few frames behind', async () => {
    const scanId = freshScanId()
    await subscribe(scanId) // never read
    const healthy = await subscribe(scanId)
    await healthy.stream.read(1)
    const arriving = healthy.stream.read(10, 5 * SECOND)

    for (let n = 0; n < 10; n++) await stubFor(scanId).publish(itemEvent({ id: 'item-1', n }))
    await arriving

    expect(await clientCount(scanId)).toBe(2)
  })
})

describe('ScanStream done', () => {
  it('writes an event named done, then ends the stream', async () => {
    const scanId = freshScanId()
    const { stream } = await subscribe(scanId)
    await stream.read(1)

    await stubFor(scanId).publish(DONE)

    const read = await stream.read(2)
    expect(read.frames).toEqual(['event: done\ndata: {}'])
    expect(read.ended).toBe(true)
  })

  it('ends the stream of every client of the scan, and no one else\'s', async () => {
    const scanId = freshScanId()
    const first = await subscribe(scanId)
    const second = await subscribe(scanId)
    const bystander = await subscribe(freshScanId())

    await stubFor(scanId).publish(DONE)

    for (const { stream } of [first, second]) {
      const read = await stream.read(3)
      expect(read.frames.map((frame) => parseFrame(frame).event)).toEqual(['snapshot', 'done'])
      expect(read.ended).toBe(true)
    }
    expect((await bystander.stream.read(2, 200)).ended).toBe(false)
    expect(await clientCount(scanId)).toBe(0)
  })

  it('delivers the item events published before done ahead of it', async () => {
    const scanId = freshScanId()
    const { stream } = await subscribe(scanId)
    await stream.read(1)

    await stubFor(scanId).publish(itemEvent({ id: 'item-1', state: 'ready' }))
    await stubFor(scanId).publish(DONE)

    const { frames, ended } = await stream.read(3)
    expect(frames.map((frame) => parseFrame(frame).event)).toEqual(['item', 'done'])
    expect(ended).toBe(true)
  })
})

describe('ScanStream clients going away', () => {
  it('forgets a client that closes its stream, and keeps serving the others', async () => {
    const scanId = freshScanId()
    const leaving = await subscribe(scanId)
    const staying = await subscribe(scanId)
    await staying.stream.read(1)
    expect(await clientCount(scanId)).toBe(2)

    await leaving.stream.cancel()

    await vi.waitFor(async () => expect(await clientCount(scanId)).toBe(1), { timeout: 2 * SECOND, interval: 20 })
    await stubFor(scanId).publish(itemEvent({ id: 'item-1', state: 'matching' }))
    expect((await staying.stream.read(1)).frames).toHaveLength(1)
  })
})

describe('ScanStream keep-alive', () => {
  it('writes a ": ping" comment to an idle client every ping interval', async () => {
    SCAN_STREAM_TIMING.pingMs = 50
    const { stream } = await subscribe(freshScanId())

    const { frames } = await stream.read(3, 1500)

    expect(frames.map((frame) => parseFrame(frame).event ?? frame)).toEqual(['snapshot', ': ping', ': ping'])
  })

  it('does not ping before the interval has passed', async () => {
    SCAN_STREAM_TIMING.pingMs = 5 * SECOND
    const { stream } = await subscribe(freshScanId())
    await stream.read(1)

    const { frames } = await stream.read(1, 300)

    expect(frames).toEqual([])
  })
})

describe('ScanStream lifetime', () => {
  it('ends a stream when the maximum lifetime has passed, whatever the client does', async () => {
    SCAN_STREAM_TIMING.maxLifetimeMs = 100
    const scanId = freshScanId()
    const { stream } = await subscribe(scanId)

    const { frames, ended } = await stream.read(5, 1500)

    expect(frames.map((frame) => parseFrame(frame).event)).toEqual(['snapshot'])
    expect(ended).toBe(true)
    expect(await clientCount(scanId)).toBe(0)
  })

  it('counts the lifetime from when each client connected, not from when the scan\'s first one did', { timeout: 8 * SECOND }, async () => {
    SCAN_STREAM_TIMING.maxLifetimeMs = 800
    const scanId = freshScanId()
    const early = await subscribe(scanId)
    await sleep(400)
    const late = await subscribe(scanId)

    expect((await early.stream.read(5, 1500)).ended).toBe(true)

    const stillOpen = await late.stream.read(5, 100)
    expect(stillOpen.ended).toBe(false)
    expect(await clientCount(scanId)).toBe(1)
    expect((await late.stream.read(5, 1500)).ended).toBe(true)
  })
})
