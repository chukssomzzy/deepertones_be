/**
 * What a scan's live stream carries. `item` is an item exactly as the HTTP responses show it; the provider forwards it
 * and never reads past its id and state, so it is typed by that much and the scan module keeps the full shape.
 */
export type ScanEventItem = { id: string; state: string; [field: string]: unknown }

/** A scan photo exactly as the HTTP responses show it; typed by its id and state for the same reason. */
export type ScanEventPhoto = { id: string; state: string; [field: string]: unknown }

export type ScanEvent =
  /** An item changed; carries the item as it now is. */
  | { type: 'item'; item: ScanEventItem }
  /** A shelf photo was read; carries the photo as it now is, and goes out before the events of the items read from it. Product scans never send one. */
  | { type: 'photo'; photo: ScanEventPhoto }
  /** Every item of the scan is in a final state. Sent once the last one gets there. */
  | { type: 'done' }

/** The scan as a client first sees it: the full state, in the shape GET /api/v1/scans/products/{scanId} responds with once serialised as JSON (`kind`, `photos` and `items`). */
export type ScanSnapshot = { id: string; items: ScanEventItem[]; [field: string]: unknown }

/**
 * Pushes a scan's changes to whoever is watching it. Publishing is best effort: the change is already in the database
 * and a client that missed the event sees it in the full state it gets when it reconnects, so callers log a failure
 * and carry on.
 */
export interface ScanEvents {
  publish(scanId: string, event: ScanEvent): Promise<void>
  /**
   * Opens a client's event stream: a `text/event-stream` response that starts with `snapshot` and then carries what is
   * published for the scan, until `done`, until the stream has lived too long, or until the client goes. Unlike publish,
   * a failure here is the caller's: there is no stream without it.
   */
  subscribe(scanId: string, snapshot: ScanSnapshot): Promise<Response>
}
