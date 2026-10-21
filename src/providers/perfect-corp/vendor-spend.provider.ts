/*
 * The port a job uses to record what a per-unit vendor charged. Unlike AiSpendLedger it has no reserve step: Perfect Corp charges only
 * when a result succeeds, and nothing sweeps a reservation held open across a webhook wait, so the call is recorded once, already settled,
 * when the result is in. Implementation: AiUsageService (D1, the same table and the same daily alert as the Claude calls).
 * AI_JOBS stays Claude's own list; these jobs are not in it.
 */

export const VENDOR_JOBS = ['face-analysis', 'fitzpatrick'] as const
export type VendorJob = (typeof VENDOR_JOBS)[number]

export interface VendorSpendLedger {
  /**
   * Records one successful call: `units` is what the vendor charged (a positive whole number, else it throws), and the cost is units x the
   * configured price per unit. Never refuses; passing the daily figure alerts. Idempotent: `key` is the vendor's task id, and a task that is
   * recorded again (a redelivered job, a webhook that came twice) changes nothing and alerts nothing.
   */
  record(input: { vendor: 'perfect-corp'; job: VendorJob; units: number; key: string }): Promise<void>
}
