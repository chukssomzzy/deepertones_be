import { abortAllDurableObjects } from 'cloudflare:test'
import { env } from 'cloudflare:workers'
import { afterEach, describe, expect, it } from 'vitest'
import { parseFrame, sseReader, type SseReader } from '../../../test/integration/sse'
import type { ScanStream } from '../../realtime/scan-stream'
import { DurableObjectScanEvents } from './durable-object.scan-events'
import type { ScanEvent } from './scan-events.provider'

// The ScanEvents adapter that reaches a scan's Durable Object by name. The real binding is used, so a published event
// is seen where a client would see it: on an open event stream of that scan.

const SNAPSHOT = { id: 'scan', items: [] }
const ITEM = { id: 'item-1', position: 0, state: 'matching', reason: null }
const itemEvent = { type: 'item', item: ITEM } as unknown as ScanEvent
const PHOTO = { id: 'photo-1', position: 0, state: 'rejected', skipped: { notBeauty: 1, unreadable: 0, overLimit: 0, dailyLimit: 0 } }
const photoEvent = { type: 'photo', photo: PHOTO } as unknown as ScanEvent
// A shelf verdict's stream is keyed `verdict:<profileId>` (spec #171, D3): the same Durable Object class, one per profile.
const VERDICT = { status: 'ready', fit: 'not-ready', products: [], tapers: [] }
const verdictEvent = { type: 'verdict', verdict: VERDICT } as unknown as ScanEvent
const DONE: ScanEvent = { type: 'done' }

const opened: SseReader[] = []
const watch = async (scanId: string) => {
  const res = await env.SCAN_STREAM.get(env.SCAN_STREAM.idFromName(scanId)).fetch(
    new Request('https://scan-stream/subscribe', { method: 'POST', body: JSON.stringify(SNAPSHOT) }),
  )
  const stream = sseReader(res)
  opened.push(stream)
  await stream.read(1) // the snapshot
  return stream
}
const freshScanId = () => `scan-events-${crypto.randomUUID()}`

afterEach(async () => {
  await Promise.all(opened.splice(0).map((stream) => stream.cancel()))
  await abortAllDurableObjects()
})

describe('DurableObjectScanEvents', () => {
  it('delivers a published item event to a client watching that scan', async () => {
    const scanId = freshScanId()
    const stream = await watch(scanId)

    await new DurableObjectScanEvents(env.SCAN_STREAM).publish(scanId, itemEvent)

    expect((await stream.read(1)).frames).toEqual([`event: item\ndata: ${JSON.stringify(ITEM)}`])
  })

  it('delivers a published photo event to a client watching that scan, as a photo frame', async () => {
    const scanId = freshScanId()
    const stream = await watch(scanId)

    await new DurableObjectScanEvents(env.SCAN_STREAM).publish(scanId, photoEvent)

    expect((await stream.read(1)).frames).toEqual([`event: photo\ndata: ${JSON.stringify(PHOTO)}`])
  })

  it('delivers a published verdict event to a client watching that profile\'s verdict stream, as a verdict frame, and to no other profile\'s', async () => {
    const profileId = crypto.randomUUID()
    const mine = await watch(`verdict:${profileId}`)
    const theirs = await watch(`verdict:${crypto.randomUUID()}`)

    await new DurableObjectScanEvents(env.SCAN_STREAM).publish(`verdict:${profileId}`, verdictEvent)

    expect((await mine.read(1)).frames).toEqual([`event: verdict\ndata: ${JSON.stringify(VERDICT)}`])
    expect((await theirs.read(1, 200)).frames).toEqual([])
  })

  it('delivers done to a client watching that scan, and the stream ends', async () => {
    const scanId = freshScanId()
    const stream = await watch(scanId)

    await new DurableObjectScanEvents(env.SCAN_STREAM).publish(scanId, DONE)

    const { frames, ended } = await stream.read(2)
    expect(frames.map((frame) => parseFrame(frame).event)).toEqual(['done'])
    expect(ended).toBe(true)
  })

  it('delivers to the scan it was given and to no other', async () => {
    const mine = freshScanId()
    const theirs = freshScanId()
    const watchingMine = await watch(mine)
    const watchingTheirs = await watch(theirs)

    await new DurableObjectScanEvents(env.SCAN_STREAM).publish(mine, itemEvent)

    expect((await watchingMine.read(1)).frames).toHaveLength(1)
    expect((await watchingTheirs.read(1, 200)).frames).toEqual([])
  })

  it('succeeds when nobody is watching the scan', async () => {
    await new DurableObjectScanEvents(env.SCAN_STREAM).publish(freshScanId(), itemEvent)
  })

  it('reaches the Durable Object by the scan\'s name, and passes the event through untouched', async () => {
    const reached: { name: string; event: unknown }[] = []
    let name = ''
    const namespace = {
      idFromName: (given: string) => {
        name = given
        return { given }
      },
      get: () => ({
        publish: async (event: unknown) => void reached.push({ name, event }),
      }),
    } as unknown as DurableObjectNamespace<ScanStream>

    await new DurableObjectScanEvents(namespace).publish('scan-abc', itemEvent)

    expect(reached).toEqual([{ name: 'scan-abc', event: itemEvent }])
  })

  it('lets a failure reach the caller, which decides what a lost event costs', async () => {
    const namespace = {
      idFromName: () => ({}),
      get: () => ({
        publish: async () => {
          throw new Error('durable object unavailable')
        },
      }),
    } as unknown as DurableObjectNamespace<ScanStream>

    await expect(new DurableObjectScanEvents(namespace).publish('scan-abc', itemEvent)).rejects.toThrow('durable object unavailable')
  })

  describe('subscribe', () => {
    const snapshot = { id: 'scan', items: [{ id: 'item-1', state: 'recognising' }] }

    it('opens an event stream on that scan that starts with the snapshot and then carries what is published', async () => {
      const scanId = freshScanId()
      const events = new DurableObjectScanEvents(env.SCAN_STREAM)

      const response = await events.subscribe(scanId, snapshot)
      const stream = sseReader(response)
      opened.push(stream)
      expect(response.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8')
      expect((await stream.read(1)).frames).toEqual([`event: snapshot\ndata: ${JSON.stringify(snapshot)}`])
      await events.publish(scanId, itemEvent)

      expect((await stream.read(1)).frames).toEqual([`event: item\ndata: ${JSON.stringify(ITEM)}`])
    })

    it('answers a response whose headers the middleware after the route can still set', async () => {
      const response = await new DurableObjectScanEvents(env.SCAN_STREAM).subscribe(freshScanId(), snapshot)
      opened.push(sseReader(response))

      expect(() => response.headers.set('X-Content-Type-Options', 'nosniff')).not.toThrow()
    })

    it('posts the snapshot as JSON to the Durable Object of the scan\'s name', async () => {
      const reached: { name: string; method: string; body: string }[] = []
      let name = ''
      const namespace = {
        idFromName: (given: string) => {
          name = given
          return {}
        },
        get: () => ({
          fetch: async (request: Request) => {
            reached.push({ name, method: request.method, body: await request.text() })
            return new Response('')
          },
        }),
      } as unknown as DurableObjectNamespace<ScanStream>

      await new DurableObjectScanEvents(namespace).subscribe('scan-abc', snapshot)

      expect(reached).toEqual([{ name: 'scan-abc', method: 'POST', body: JSON.stringify(snapshot) }])
    })
  })
})
