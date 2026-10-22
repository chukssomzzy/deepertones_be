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
const photoEvent = (photo: Record<string, unknown>) => ({ type: 'photo', photo }) as unknown as ScanEvent
const DONE = { type: 'done' } as ScanEvent
const faceEvent = (faceScan: Record<string, unknown>) => ({ type: 'face', faceScan }) as unknown as ScanEvent

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

  it('does not wait for a client that stopped reading, and that client does not hold back the others', { timeout: 15 * SECOND }, async () => {
    const scanId = freshScanId()
    const stalled = await subscribe(scanId) // never read
    const healthy = await subscribe(scanId)
    await healthy.stream.read(1)
    const total = 30
    const arriving = healthy.stream.read(total, 10 * SECOND)

    // If publish awaited the stalled client's write it would hang for good, since that client never reads. So the bound only
    // has to be far above any loaded run, not tight: a hang is unbounded.
    const publishing = (async () => {
      for (let n = 0; n < total; n++) await stubFor(scanId).publish(itemEvent({ id: 'item-1', n }))
      return 'published' as const
    })()
    let timer: ReturnType<typeof setTimeout> | undefined
    const outcome = await Promise.race([publishing, new Promise<'blocked'>((resolve) => (timer = setTimeout(() => resolve('blocked'), 6 * SECOND)))])
    clearTimeout(timer)

    expect(outcome, 'publish blocked on the stalled client').toBe('published')
    const { frames } = await arriving
    expect(frames.map((frame) => (parseFrame(frame).data as { n: number }).n)).toEqual(Array.from({ length: total }, (_, n) => n))
    void stalled
  })

  it('drops a client whose backlog grows past 20 frames, and keeps the one that reads', { timeout: 15 * SECOND }, async () => {
    const scanId = freshScanId()
    await subscribe(scanId) // never read
    const healthy = await subscribe(scanId)
    await healthy.stream.read(1)
    const total = 40
    const arriving = healthy.stream.read(total, 10 * SECOND)

    for (let n = 0; n < total; n++) await stubFor(scanId).publish(itemEvent({ id: 'item-1', n }))
    await arriving

    expect(await clientCount(scanId)).toBe(1)
  })

  it('keeps a client that is only a few frames behind', { timeout: 15 * SECOND }, async () => {
    const scanId = freshScanId()
    await subscribe(scanId) // never read
    const healthy = await subscribe(scanId)
    await healthy.stream.read(1)
    const arriving = healthy.stream.read(10, 10 * SECOND)

    for (let n = 0; n < 10; n++) await stubFor(scanId).publish(itemEvent({ id: 'item-1', n }))
    await arriving

    expect(await clientCount(scanId)).toBe(2)
  })
})

describe('ScanStream photo events', () => {
  const PHOTO = { id: 'photo-1', position: 0, state: 'recognised', skipped: { notBeauty: 2, unreadable: 0, overLimit: 1, dailyLimit: 0 } }

  it('writes a photo event as an event named photo whose data is the photo, not as an item', async () => {
    const scanId = freshScanId()
    const { stream } = await subscribe(scanId)
    await stream.read(1)

    await stubFor(scanId).publish(photoEvent(PHOTO))

    expect((await stream.read(1)).frames).toEqual([`event: photo\ndata: ${JSON.stringify(PHOTO)}`])
  })

  it('keeps photo and item frames in the order published, each under its own event name', async () => {
    const scanId = freshScanId()
    const { stream } = await subscribe(scanId)
    await stream.read(1)
    const item = { id: 'item-1', photoId: 'photo-1', state: 'matching' }

    await stubFor(scanId).publish(photoEvent(PHOTO))
    await stubFor(scanId).publish(itemEvent(item))
    await stubFor(scanId).publish(DONE)

    const { frames, ended } = await stream.read(4)
    const parsed = frames.map(parseFrame)
    expect(parsed.map((frame) => frame.event)).toEqual(['photo', 'item', 'done'])
    expect(parsed[0]!.data).toEqual(PHOTO)
    expect(parsed[1]!.data).toEqual(item)
    expect(ended).toBe(true)
  })

  it('writes a photo event to every client of the scan', async () => {
    const scanId = freshScanId()
    const first = await subscribe(scanId)
    const second = await subscribe(scanId)

    await stubFor(scanId).publish(photoEvent(PHOTO))

    for (const { stream } of [first, second]) {
      const { frames } = await stream.read(2)
      expect(frames.map((frame) => parseFrame(frame).event)).toEqual(['snapshot', 'photo'])
    }
  })
})

describe('ScanStream face scan frames', () => {
  it('writes a face scan frame as a `face` event carrying the scan\'s id, state and reason, then ends the stream on done', async () => {
    const scanId = freshScanId()
    const { stream } = await subscribe(scanId, { id: scanId, state: 'analysing', reason: null })
    await stream.read(1)
    const frame = { id: scanId, state: 'needs-retake', reason: 'too-dark' }

    await stubFor(scanId).publish(faceEvent(frame))
    await stubFor(scanId).publish(DONE)

    const { frames, ended } = await stream.read(3)
    expect(frames).toEqual([`event: face\ndata: ${JSON.stringify(frame)}`, 'event: done\ndata: {}'])
    expect(ended).toBe(true)
  })

  it('does not write it as an item or a photo', async () => {
    const scanId = freshScanId()
    const { stream } = await subscribe(scanId)
    await stream.read(1)

    await stubFor(scanId).publish(faceEvent({ id: scanId, state: 'ready', reason: null }))

    expect(parseFrame((await stream.read(1)).frames[0]!).event).toBe('face')
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

  // Aborting the writer of a client that already left errors a response body that workerd is still reading, with nobody to
  // receive the error: workerd logs `uncaught exception; source = Uncaught (in promise); exception = undefined`, no test
  // fails, and the vitest workers pool stops making progress. That rejection is not visible to JS (no unhandledrejection
  // event fires for it), so the only thing a test can pin is that a gone client is closed and never aborted.
  it('closes the stream of a client that left instead of aborting it, so nothing is left rejected', async () => {
    const abort = vi.spyOn(WritableStreamDefaultWriter.prototype, 'abort')
    try {
      const scanId = freshScanId()
      const leaving = await subscribe(scanId)
      await leaving.stream.read(1)

      await leaving.stream.cancel()
      await vi.waitFor(async () => expect(await clientCount(scanId)).toBe(0), { timeout: 2 * SECOND, interval: 20 })
      await stubFor(scanId).publish(itemEvent({ id: 'item-1', state: 'matching' }))

      expect(abort).not.toHaveBeenCalled()
    } finally {
      abort.mockRestore()
    }
  })

  it('does not abort a client that left while pings keep being written to it', async () => {
    const abort = vi.spyOn(WritableStreamDefaultWriter.prototype, 'abort')
    try {
      const scanId = freshScanId()
      Object.assign(SCAN_STREAM_TIMING, { pingMs: 50 })
      const leaving = await subscribe(scanId)
      await leaving.stream.read(1)

      await leaving.stream.cancel()
      await vi.waitFor(async () => expect(await clientCount(scanId)).toBe(0), { timeout: 2 * SECOND, interval: 20 })
      await new Promise((resolve) => setTimeout(resolve, 150))

      expect(abort).not.toHaveBeenCalled()
    } finally {
      abort.mockRestore()
    }
  })

  it('ends a client dropped for lagging with a real error as the reason, never with undefined', { timeout: 15 * SECOND }, async () => {
    const abort = vi.spyOn(WritableStreamDefaultWriter.prototype, 'abort')
    try {
      const scanId = freshScanId()
      await subscribe(scanId) // never read
      const healthy = await subscribe(scanId)
      await healthy.stream.read(1)
      const total = 40
      const arriving = healthy.stream.read(total, 10 * SECOND)

      for (let n = 0; n < total; n++) await stubFor(scanId).publish(itemEvent({ id: 'item-1', n }))
      await arriving

      expect(abort).toHaveBeenCalledTimes(1)
      expect(abort.mock.calls[0]![0]).toBeInstanceOf(Error)
    } finally {
      abort.mockRestore()
    }
  })
})

describe('ScanStream keep-alive', () => {
  it('writes a ": ping" comment to an idle client every ping interval', { timeout: 15 * SECOND }, async () => {
    SCAN_STREAM_TIMING.pingMs = 50
    const { stream } = await subscribe(freshScanId())

    const { frames } = await stream.read(3, 5 * SECOND)

    expect(frames.map((frame) => parseFrame(frame).event ?? frame)).toEqual(['snapshot', ': ping', ': ping'])
  })

  it('does not ping before the interval has passed', async () => {
    SCAN_STREAM_TIMING.pingMs = 30 * SECOND
    const { stream } = await subscribe(freshScanId())
    await stream.read(1)

    const { frames } = await stream.read(1, 300)

    expect(frames).toEqual([])
  })
})

describe('ScanStream lifetime', () => {
  it('ends a stream when the maximum lifetime has passed, whatever the client does', { timeout: 15 * SECOND }, async () => {
    SCAN_STREAM_TIMING.maxLifetimeMs = 100
    const scanId = freshScanId()
    const { stream } = await subscribe(scanId)

    const { frames, ended } = await stream.read(5, 5 * SECOND)

    expect(frames.map((frame) => parseFrame(frame).event)).toEqual(['snapshot'])
    expect(ended).toBe(true)
    expect(await clientCount(scanId)).toBe(0)
  })

  it('counts the lifetime from when each client connected, not from when the scan\'s first one did', { timeout: 15 * SECOND }, async () => {
    // The lifetimes differ on purpose: a scan-level timer started by `early` would close `late` at ~200ms, far inside its own 60s.
    SCAN_STREAM_TIMING.maxLifetimeMs = 200
    const scanId = freshScanId()
    const early = await subscribe(scanId)
    await early.stream.read(1)
    SCAN_STREAM_TIMING.maxLifetimeMs = 60_000
    const late = await subscribe(scanId)

    expect((await early.stream.read(5, 5 * SECOND)).ended).toBe(true)

    expect((await late.stream.read(5, 300)).ended).toBe(false)
    expect(await clientCount(scanId)).toBe(1)
    await late.stream.cancel()
  })
})
