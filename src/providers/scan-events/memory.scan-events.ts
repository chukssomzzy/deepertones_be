import type { ScanEvent, ScanEvents } from './scan-events.provider'

/** Records every event published, in order, with the scan it was for. For tests. */
export class MemoryScanEvents implements ScanEvents {
  readonly published: { scanId: string; event: ScanEvent }[] = []

  async publish(scanId: string, event: ScanEvent): Promise<void> {
    this.published.push({ scanId, event })
  }

  /** The events published for one scan, in order. */
  eventsFor(scanId: string): ScanEvent[] {
    return this.published.filter((p) => p.scanId === scanId).map((p) => p.event)
  }
}
