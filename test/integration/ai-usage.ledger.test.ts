import { env } from 'cloudflare:workers'
import { createDb } from '../../src/lib/db'
import { D1AiUsageRepository } from '../../src/modules/ai-usage/ai-usage.repository'
import { AiUsageService } from '../../src/modules/ai-usage/ai-usage.service'
import { aiSpendLedgerContract } from '../../src/providers/anthropic/ai-spend-ledger.contract'

const DAY = 24 * 60 * 60 * 1000
const FIRST_DAY = Date.UTC(2031, 0, 1)
const runSalt = Math.floor(Math.random() * 36_500)
let counter = 0

/** The real ledger (service + D1 + the migration's table) must obey the same contract as the in-memory one. Each ledger gets a UTC day nobody else used, because the cap is per day. */
aiSpendLedgerContract('AiUsageService on D1', (capMicros) => {
  const today = new Date(FIRST_DAY + (runSalt + counter++) * DAY + 12 * 60 * 60 * 1000)
  return new AiUsageService({ repository: new D1AiUsageRepository(createDb(env.DB)), capMicros, now: () => today })
})
