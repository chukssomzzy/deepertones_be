// `npm run catalog:draft -- in.xlsx --out out.xlsx [--max-usd N] [--countries NG,GB] [--passes N]`. The logic is draftCli in scripts/catalog/draft-cli.ts; this only wires the real
// effects. Needs ANTHROPIC_API_KEY (environment, else .dev.vars) and makes real, billed Claude calls, counted by a MemoryAiSpendLedger capped at --max-usd.
// It never prints the key, a prompt or what Claude said: only the report, and the message of an error made for the person's own mistake (see draftCli).
// Exit: 0 drafted with nothing left to fix (or nothing to draft), 1 a problem, a failed product or the cap remains (the file is written all the same), 2 the
// run could not start or Claude refused our key, billing or permissions.
import { MemoryAiSpendLedger } from '../src/providers/anthropic/memory.ai-spend-ledger'
import { AnthropicClient } from '../src/providers/anthropic/anthropic.client'
import { AnthropicCatalogDrafter } from '../src/providers/catalog-drafting/anthropic.catalog-drafter'
import { AnthropicProductResearcher } from '../src/providers/product-research/anthropic.product-researcher'
import { DRAFTING_TIMEOUT_MS } from './catalog/draft'
import { draftCli } from './catalog/draft-cli'
import { DraftInputError } from './catalog/draft-input-error'
import { readWorkbookFile, writeWorkbookFile } from './catalog/xlsx'
import { DEFAULT_MODELS } from './eval/models'
import { loadEnv, MissingApiKeyError } from './eval/score'

process.exitCode = await draftCli(process.argv.slice(2), {
  loadApiKey: async () => {
    try {
      return (await loadEnv()).apiKey
    } catch (error) {
      throw error instanceof MissingApiKeyError ? new DraftInputError(error.message, { cause: error }) : error
    }
  },
  clients: ({ apiKey, maxUsd }) => {
    const ledger = new MemoryAiSpendLedger({ capMicros: Math.round(maxUsd * 1_000_000) })
    const client = new AnthropicClient({ apiKey, models: DEFAULT_MODELS, ledger, timeoutMs: DRAFTING_TIMEOUT_MS })
    return { researcher: new AnthropicProductResearcher(client), drafter: new AnthropicCatalogDrafter(client), ledger }
  },
  io: { readWorkbook: readWorkbookFile, writeWorkbook: writeWorkbookFile },
  log: console.log,
  error: console.error,
})
