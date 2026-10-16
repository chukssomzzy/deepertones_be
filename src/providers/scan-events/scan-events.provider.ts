/**
 * What a scan's live stream carries. `item` is an item exactly as the HTTP responses show it; the provider forwards it
 * and never reads past its id and state, so it is typed by that much and the scan module keeps the full shape.
 */
export type ScanEventItem = { id: string; state: string; [field: string]: unknown }

export type ScanEvent =
  /** An item changed; carries the item as it now is. */
  | { type: 'item'; item: ScanEventItem }
  /** Every item of the scan is in a final state. Sent once the last one gets there. */
  | { type: 'done' }

/**
 * Pushes a scan's changes to whoever is watching it. Publishing is best effort: the change is already in the database
 * and a client that missed the event sees it in the full state it gets when it reconnects, so callers log a failure
 * and carry on.
 */
export interface ScanEvents {
  publish(scanId: string, event: ScanEvent): Promise<void>
}
