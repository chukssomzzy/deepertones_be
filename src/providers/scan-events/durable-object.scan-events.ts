import type { ScanStream } from '../../realtime/scan-stream'
import type { FaceScanFrame, RoutineFrame, ScanEvent, ScanEvents, ScanSnapshot, VerdictFrame } from './scan-events.provider'

/**
 * Reaches a scan's Durable Object by the scan's id, so the Worker, the queue consumer and the reaper all find the same one
 * without a lookup. The class is a type-only import: it is exported from src/index.ts, and the binding is wired in the container.
 */
export class DurableObjectScanEvents implements ScanEvents {
  constructor(private readonly namespace: DurableObjectNamespace<ScanStream>) {}

  /** A failure reaches the caller, which decides what a lost event costs. */
  async publish(scanId: string, event: ScanEvent): Promise<void> {
    await this.stream(scanId).publish(event)
  }

  async subscribe(scanId: string, snapshot: ScanSnapshot | FaceScanFrame | VerdictFrame | RoutineFrame): Promise<Response> {
    const response = await this.stream(scanId).fetch(new Request('https://scan-stream/subscribe', { method: 'POST', body: JSON.stringify(snapshot) }))
    // A response from a stub has immutable headers, and the middleware that runs after the route (CORS, secure headers) sets some.
    return new Response(response.body, response)
  }

  private stream(scanId: string) {
    return this.namespace.get(this.namespace.idFromName(scanId))
  }
}
