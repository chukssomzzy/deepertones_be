import type { FaceScanFrame, RoutineFrame, ScanEvent, ScanEvents, ScanSnapshot, VerdictFrame } from './scan-events.provider'

/** Records every event published, in order, with the scan it was for. For tests. */
export class MemoryScanEvents implements ScanEvents {
  readonly published: { scanId: string; event: ScanEvent }[] = []
  readonly subscribed: { scanId: string; snapshot: ScanSnapshot | FaceScanFrame | VerdictFrame | RoutineFrame }[] = []

  async publish(scanId: string, event: ScanEvent): Promise<void> {
    this.published.push({ scanId, event })
  }

  /** Records the subscription and answers an empty event stream. */
  async subscribe(scanId: string, snapshot: ScanSnapshot | FaceScanFrame | VerdictFrame | RoutineFrame): Promise<Response> {
    this.subscribed.push({ scanId, snapshot })
    return new Response('', { headers: { 'Content-Type': 'text/event-stream; charset=utf-8' } })
  }

  /** The events published for one scan, in order. */
  eventsFor(scanId: string): ScanEvent[] {
    return this.published.filter((p) => p.scanId === scanId).map((p) => p.event)
  }
}
