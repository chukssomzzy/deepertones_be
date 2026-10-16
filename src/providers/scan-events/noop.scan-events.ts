import type { ScanEvent, ScanEvents } from './scan-events.provider'

/**
 * Publishes nothing. The production adapter until the Durable Object that holds a scan's open streams lands (PR 10):
 * clients read a scan's state with GET until then, and every change is already in the database.
 */
export class NoopScanEvents implements ScanEvents {
  async publish(_scanId: string, _event: ScanEvent): Promise<void> {}
}
