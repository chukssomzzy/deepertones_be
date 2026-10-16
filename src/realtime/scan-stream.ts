import { DurableObject } from 'cloudflare:workers'
import type { ScanEvent } from '../providers/scan-events/scan-events.provider'

/**
 * Read when a client CONNECTS, not at module load, so a test can lower them before it opens a stream. A mutable object
 * because workerd refuses I/O across Durable Object contexts, so fake timers cannot drive these two clocks.
 */
export const SCAN_STREAM_TIMING = {
  /** An idle stream gets a `: ping` comment this often, so a proxy does not close it and a client that is gone fails a write. */
  pingMs: 20_000,
  /** A stream is closed this long after its client connected, abandoned or not; the app reconnects and the token is checked again. */
  maxLifetimeMs: 10 * 60 * 1000,
}

/** A client more than this many frames behind is dropped; it reconnects and gets a fresh snapshot. */
const MAX_QUEUED_FRAMES = 20

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  // no-transform and X-Accel-Buffering keep proxies from holding frames back or rewriting the stream.
  'Cache-Control': 'no-cache, no-transform',
  'X-Accel-Buffering': 'no',
}

const encoder = new TextEncoder()
const frame = (event: string, data: string) => encoder.encode(`event: ${event}\ndata: ${data}\n\n`)
const PING = encoder.encode(': ping\n\n')

type Client = { writer: WritableStreamDefaultWriter<Uint8Array>; stopTimers: () => void }

/**
 * The open event streams of one scan. The Worker opens one per client with `stub.fetch(snapshot)`; whatever changes the
 * scan calls `stub.publish(event)` over RPC. Everything is in memory: a deploy or an eviction drops the streams, and each
 * client reconnects to a new snapshot. Nothing is stored.
 */
export class ScanStream extends DurableObject<CloudflareBindings> {
  private readonly clients = new Set<Client>()

  /** The request body is the scan as JSON, sent to this client as its first frame. The response streams until `done`, the lifetime cap or the client leaving. */
  override async fetch(request: Request): Promise<Response> {
    const snapshot = await request.text()
    const { readable, writable } = new TransformStream<Uint8Array>()
    const writer = writable.getWriter()
    const { pingMs, maxLifetimeMs } = SCAN_STREAM_TIMING
    const ping = setInterval(() => this.send(client, PING), pingMs)
    const lifetime = setTimeout(() => this.end(client, null), maxLifetimeMs)
    const client: Client = {
      writer,
      stopTimers: () => {
        clearInterval(ping)
        clearTimeout(lifetime)
      },
    }
    this.clients.add(client)
    // Needs the enable_request_signal compatibility flag; without it nothing here learns that a client left.
    request.signal.addEventListener('abort', () => this.drop(client))
    this.send(client, frame('snapshot', snapshot))
    return new Response(readable, { headers: SSE_HEADERS })
  }

  async publish(event: ScanEvent): Promise<void> {
    if (event.type === 'done') {
      for (const client of [...this.clients]) this.end(client, frame('done', '{}'))
      return
    }
    const bytes = frame('item', JSON.stringify(event.item))
    for (const client of [...this.clients]) this.send(client, bytes)
  }

  clientCount(): number {
    return this.clients.size
  }

  /**
   * Never awaits the write: a client that stopped reading would hold publish, and with it the queue consumer and every
   * other client, for as long as it stays silent. Its backlog is bounded instead, and a client too far behind is dropped.
   */
  private send(client: Client, bytes: Uint8Array): void {
    if (!this.clients.has(client)) return
    if ((client.writer.desiredSize ?? 0) < -MAX_QUEUED_FRAMES) {
      this.drop(client)
      return
    }
    client.writer.write(bytes).catch(() => this.drop(client))
  }

  /** Writes the last frame, if any, and closes the stream after it. */
  private end(client: Client, last: Uint8Array | null): void {
    if (!this.clients.delete(client)) return
    client.stopTimers()
    if (last) client.writer.write(last).catch(() => {})
    client.writer.close().catch(() => {})
  }

  /** Forgets a client that is gone or too slow; abort discards whatever it had queued. */
  private drop(client: Client): void {
    if (!this.clients.delete(client)) return
    client.stopTimers()
    client.writer.abort().catch(() => {})
  }
}
