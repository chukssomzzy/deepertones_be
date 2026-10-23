// `npm run catalog:draft -- in.xlsx --out out.xlsx [--max-usd N] [--countries NG,GB] [--passes N]`. The logic is runDraft in scripts/catalog/draft.ts; this only wires the real
// effects. Needs ANTHROPIC_API_KEY (environment, else .dev.vars) and makes real, billed Claude calls, counted by a MemoryAiSpendLedger capped at --max-usd.
// It never prints the key, a prompt or what Claude said: only the report. Exit: 0 drafted with nothing left to fix, 1 a problem, a failed product or the cap
// remains (the file is written all the same), 2 the run could not start or Claude refused our key, billing or permissions.
import { MemoryAiSpendLedger } from '../src/providers/anthropic/memory.ai-spend-ledger'
import { AnthropicClient } from '../src/providers/anthropic/anthropic.client'
import { AnthropicCatalogDrafter } from '../src/providers/catalog-drafting/anthropic.catalog-drafter'
import { AnthropicProductResearcher } from '../src/providers/product-research/anthropic.product-researcher'
import { parseArgs } from './catalog/draft-args'
import { DRAFTING_TIMEOUT_MS, formatReport, runDraft } from './catalog/draft'
import { readWorkbookFile, writeWorkbookFile } from './catalog/xlsx'
import { DEFAULT_MODELS } from './eval/models'
import { loadEnv } from './eval/score'

const errorName = (error: unknown): string => (error instanceof Error ? error.name : 'UnknownError')

async function main(): Promise<number> {
  let args: ReturnType<typeof parseArgs>
  let apiKey: string
  try {
    args = parseArgs(process.argv.slice(2))
    ;({ apiKey } = await loadEnv())
  } catch (error) {
    console.error((error as Error).message)
    return 2
  }

  const ledger = new MemoryAiSpendLedger({ capMicros: Math.round(args.maxUsd * 1_000_000) })
  const client = new AnthropicClient({ apiKey, models: DEFAULT_MODELS, ledger, timeoutMs: DRAFTING_TIMEOUT_MS })
  try {
    const outcome = await runDraft(args, {
      researcher: new AnthropicProductResearcher(client),
      drafter: new AnthropicCatalogDrafter(client),
      ledger,
      io: { readWorkbook: readWorkbookFile, writeWorkbook: writeWorkbookFile },
    })
    console.log(formatReport(outcome))
    console.log(`Wrote ${args.out}`)
    if (outcome.stoppedBy === 'config') return 2
    return outcome.problems.length > 0 || outcome.failed.length > 0 || outcome.stoppedBy === 'cap' ? 1 : 0
  } catch (error) {
    // The message of a failed read or write can hold a path or a cell, so only its name is printed.
    console.error(`The draft stopped on an unexpected ${errorName(error)}. Nothing was written unless the line above says so.`)
    return 2
  }
}

process.exitCode = await main()
