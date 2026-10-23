/*
 * The port the Claude client uses to count what it spends. The client reserves the worst case of a request before
 * sending it, settles with the actual cost afterwards, and releases when nothing was billed. Implementations:
 * AiUsageService (D1, the daily cap) and MemoryAiSpendLedger (tests and the eval script).
 */

/**
 * What a call is for. Each job can run on its own model. The list is a value so the eval script and its drift tests use the same one.
 */
export const AI_JOBS = ['research', 'analysis', 'same-product', 'image-check', 'recognize', 'recognize-shelf', 'read-label', 'split-name', 'read-goal', 'read-mentions', 'draft-catalog-row', 'judge-draft'] as const
export type AiJob = (typeof AI_JOBS)[number]

/** What one API response used, in the API's own units. */
export type AiUsage = {
  inputTokens: number
  outputTokens: number
  cacheWriteTokens: number
  cacheReadTokens: number
  webSearches: number
}

/** The daily cap would be exceeded, so the call was not made. Nothing was sent; try again after the day rolls over. */
export class AiBudgetExceededError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AiBudgetExceededError'
  }
}

export interface AiSpendLedger {
  /** Sets money aside for one request. Resolves to the reservation's id, or throws AiBudgetExceededError when the cap would be passed. */
  reserve(input: { job: AiJob; model: string; estimateMicros: number }): Promise<string>
  /** Records what the call really cost. Only an open reservation can be settled; anything else is left as it is. */
  settle(reservationId: string, input: { usage: AiUsage; costMicros: number }): Promise<void>
  /** Gives the money back: nothing was billed. Only an open reservation can be released. */
  release(reservationId: string): Promise<void>
}
