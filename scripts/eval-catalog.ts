// Runs the catalog's model-backed steps against fixed cases and reports how many held: `npm run eval:catalog`.
// Needs ANTHROPIC_API_KEY (environment, else .dev.vars) and makes real, billed calls. It is report-only, is never part
// of `npm test`, and never prints the key, a prompt or raw model output: only case ids, fixed problem codes and timings.
//   --mode analysis|research|goals|mentions|draft|all   (default all, which is the first four; goals is about 40 Haiku calls and mentions about 22, a few cents each)    --limit N   cases per mode
//   --max-usd N   stop spending at N dollars (default 2, and 5 for draft)    --model JOB=MODEL   run a job on another model (repeatable)
//   --set main|holdout|dev   draft only: the measurement set (default), the holdout set a drafter fix is checked on, or the dev set a drafter change is tuned on
//   --out-dir DIR   draft only: where report.json and draft.xlsx go (default .eval/draft-<timestamp>)
// --mode draft is its own run: it drafts the DRAFT_CASES products (or DRAFT_HOLDOUT with --set holdout, DRAFT_DEV with --set dev) through the real catalog drafter, has a judge check every drafted value against the page it
// cites, and gates on the result (see "Catalog eval" in docs/architecture.md). It is slow and costs real money, so it is never part of --mode all.
// A --limit trial that covers no trap prints `Gate: PASS (no traps covered)`: it is a trial, not the gate.
// Each job runs on the model wrangler.jsonc gives it (Haiku for research, vision and judging, Sonnet for the analysis)
// unless --model says otherwise. Spend is counted by a MemoryAiSpendLedger capped at --max-usd, so a runaway run cannot
// bill more; once the cap is reached the remaining cases fail as AiBudgetExceededError without calling the API.
// Exit: 0 every case passed (draft: the gate holds), 1 a case failed (draft: the gate does not hold), 2 the run could not start (bad arguments, missing key, rejected key).
import { mkdirSync, writeFileSync } from 'node:fs'
import { checkAnalysis } from '../src/modules/catalog/catalog.analysis'
import { REFERENCE } from '../src/modules/catalog/catalog.reference'
import { flagFacts } from '../src/modules/catalog/catalog.rules'
import { CONCERN_KINDS, SEVERITIES, TRAITS } from '../src/modules/catalog/catalog.vocabulary'
import type { AiJob } from '../src/providers/anthropic/ai-spend.provider'
import { AnthropicClient } from '../src/providers/anthropic/anthropic.client'
import { AnthropicConfigError } from '../src/providers/anthropic/anthropic.provider'
import { MemoryAiSpendLedger } from '../src/providers/anthropic/memory.ai-spend-ledger'
import { AnthropicCatalogDrafter } from '../src/providers/catalog-drafting/anthropic.catalog-drafter'
import { AnthropicGoalReader } from '../src/providers/goal-reading/anthropic.goal-reader'
import { AnthropicMentionReader } from '../src/providers/mention-reading/anthropic.mention-reader'
import { AnthropicProductAnalyst } from '../src/providers/product-analysis/anthropic.product-analyst'
import { AnthropicProductResearcher } from '../src/providers/product-research/anthropic.product-researcher'
import { writeWorkbookFile } from './catalog/xlsx'
import { ANALYSIS_CASES, GOAL_CASES, MENTION_CASES, RESEARCH_CASES } from './eval/cases'
import { DRAFT_CASES, type DraftCase } from './eval/draft-cases'
import { DRAFT_DEV } from './eval/draft-dev'
import { DRAFT_HOLDOUT } from './eval/draft-holdout'
import { HUMAN_CHECKS } from './eval/draft-human-checks'
import { AnthropicDraftJudge } from './eval/draft-judge'
import { runDraftEval } from './eval/draft-run'
import { DEFAULT_MODELS } from './eval/models'
import {
  type AnalysisOutcome,
  type CaseResult,
  type DraftSet,
  type GoalOutcome,
  loadEnv,
  type MentionOutcome,
  parseArgs,
  type ResearchOutcome,
  scoreAnalysis,
  scoreGoalReading,
  scoreMentions,
  scoreResearch,
  summarise,
} from './eval/score'

/** The cases `--set` picks; main when it is not given. */
const DRAFT_SET_CASES: Record<DraftSet, DraftCase[]> = { main: DRAFT_CASES, holdout: DRAFT_HOLDOUT, dev: DRAFT_DEV }

const usd = (micros: number): string => `$${(micros / 1_000_000).toFixed(4)}`

/** The run cannot go on and the cases say nothing about the code: exit 2, not 1. */
class SetupError extends Error {}

type Timed = CaseResult & { ms: number }

const errorName = (error: unknown): string => (error instanceof Error ? error.name : 'UnknownError')

/** Runs one call; a thrown error becomes its name (never its message). A rejected key stops the run. */
const attempt = async <T>(call: () => Promise<T>): Promise<T | { error: string }> => {
  try {
    return await call()
  } catch (error) {
    if (error instanceof AnthropicConfigError) throw new SetupError('Claude rejected the API key or the account (check ANTHROPIC_API_KEY and billing).')
    return { error: errorName(error) }
  }
}

// One at a time: web-search turns are slow and a burst would only trip rate limits.
const runEach = async <C extends { id: string }>(cases: C[], ledger: MemoryAiSpendLedger, run: (c: C) => Promise<CaseResult>): Promise<Timed[]> => {
  const results: Timed[] = []
  for (const c of cases) {
    const started = performance.now()
    const spentBefore = ledger.spentMicros()
    const scored = await run(c)
    results.push({ ...scored, costMicros: ledger.spentMicros() - spentBefore, ms: Math.round(performance.now() - started) })
  }
  return results
}

const printTable = (title: string, results: Timed[]) => {
  console.log(`\n${title}`)
  const width = Math.max('case'.length, ...results.map((r) => r.id.length))
  console.log(`${'case'.padEnd(width)}  pass  ${'ms'.padStart(6)}  ${'cost'.padStart(8)}  problems`)
  for (const r of results) {
    console.log(`${r.id.padEnd(width)}  ${(r.pass ? 'yes' : 'NO').padEnd(4)}  ${String(r.ms).padStart(6)}  ${usd(r.costMicros ?? 0).padStart(8)}  ${r.problems.join(', ')}`)
  }
  const { passed, total, passRate, costMicros } = summarise(results)
  console.log(`${passed}/${total} passed (${Math.round(passRate * 100)}%), ${usd(costMicros)}`)
}

const main = async (): Promise<number> => {
  let args, env
  try {
    args = parseArgs(process.argv.slice(2))
    env = await loadEnv()
  } catch (error) {
    console.error((error as Error).message)
    return 2
  }
  const models = { ...DEFAULT_MODELS, ...args.models }
  const ledger = new MemoryAiSpendLedger({ capMicros: Math.round(args.maxUsd * 1_000_000) })
  const client = new AnthropicClient({ apiKey: env.apiKey, models, ledger })
  const analyst = new AnthropicProductAnalyst(client)
  const researcher = new AnthropicProductResearcher(client)
  const goalReader = new AnthropicGoalReader(client)
  const mentionReader = new AnthropicMentionReader(client)

  const startedAt = new Date()
  if (args.mode === 'draft') {
    const draftModels = { research: models.research, 'draft-catalog-row': models['draft-catalog-row'], 'judge-draft': models['judge-draft'] }
    console.log(`Models: research ${draftModels.research}, draft-catalog-row ${draftModels['draft-catalog-row']}, judge-draft ${draftModels['judge-draft']}`)
    const { exitCode } = await runDraftEval({
      cases: DRAFT_SET_CASES[args.set ?? 'main'],
      set: args.set,
      humanChecks: HUMAN_CHECKS,
      limit: args.limit,
      outDir: args.outDir,
      startedAt,
      models: draftModels,
      deps: { researcher, drafter: new AnthropicCatalogDrafter(client), judge: new AnthropicDraftJudge(client), ledger },
      io: {
        log: (line) => console.log(line),
        mkdir: async (dir) => void mkdirSync(dir, { recursive: true }),
        writeFile: async (path, text) => writeFileSync(path, text),
        writeWorkbook: (path, workbook) => writeWorkbookFile(path, workbook, null),
      },
    })
    return exitCode
  }
  console.log(
    `Catalog eval: mode ${args.mode}${args.limit ? `, up to ${args.limit} cases per mode` : ''}, cap ${usd(ledger.capMicros)}`,
  )
  console.log(`Models: analysis ${models.analysis}, research ${models.research}, same-product ${models['same-product']}, image-check ${models['image-check']}`)

  const report: { startedAt: string; models: Record<AiJob, string>; maxUsd: number; mode: string; analysis?: Timed[]; research?: Timed[]; goals?: Timed[]; mentions?: Timed[] } = {
    startedAt: startedAt.toISOString(),
    models,
    maxUsd: args.maxUsd,
    mode: args.mode,
  }

  try {
    if (args.mode === 'all' || args.mode === 'analysis') {
      report.analysis = await runEach(ANALYSIS_CASES.slice(0, args.limit), ledger, async (c) => {
        const flaggedFacts = flagFacts(c.ingredients, REFERENCE)
        const outcome = await attempt<AnalysisOutcome>(async () => {
          const drafts = await analyst.analyse({
            product: c.product,
            ingredients: c.ingredients,
            flaggedFacts,
            kinds: CONCERN_KINDS,
            severities: SEVERITIES,
            traits: TRAITS,
          })
          const checked = checkAnalysis(drafts, c.ingredients, flaggedFacts)
          return checked.ok ? { stored: checked.concerns } : { rejected: checked.reason }
        })
        return scoreAnalysis(c, outcome)
      })
      printTable('Analysis', report.analysis)
    }
    if (args.mode === 'all' || args.mode === 'research') {
      report.research = await runEach(RESEARCH_CASES.slice(0, args.limit), ledger, async (c) =>
        scoreResearch(c, await attempt<ResearchOutcome>(() => researcher.research(c.product))),
      )
      printTable('Research', report.research)
    }
    if (args.mode === 'all' || args.mode === 'goals') {
      report.goals = await runEach(GOAL_CASES.slice(0, args.limit), ledger, async (c) =>
        scoreGoalReading(c, await attempt<GoalOutcome>(() => goalReader.read(c.text))),
      )
      printTable('Goals', report.goals)
    }
    if (args.mode === 'all' || args.mode === 'mentions') {
      report.mentions = await runEach(MENTION_CASES.slice(0, args.limit), ledger, async (c) =>
        scoreMentions(c, await attempt<MentionOutcome>(async () => ({ mentions: await mentionReader.read(c.text) }))),
      )
      printTable('Mentions', report.mentions)
    }
  } catch (error) {
    if (!(error instanceof SetupError)) throw error
    console.error(error.message)
    return 2
  }

  const all = [...(report.analysis ?? []), ...(report.research ?? []), ...(report.goals ?? []), ...(report.mentions ?? [])]
  const summary = summarise(all)
  console.log(`\nOverall: ${summary.passed}/${summary.total} passed, ${usd(summary.costMicros)} spent`)

  // No colons: actions/upload-artifact refuses them in a file name.
  const path = `.eval/catalog-${startedAt.toISOString().replace(/:/g, '-')}.json`
  mkdirSync('.eval', { recursive: true })
  writeFileSync(path, `${JSON.stringify({ ...report, summary }, null, 2)}\n`)
  console.log(`Report: ${path}`)
  return summary.failed > 0 ? 1 : 0
}

main().then(
  (code) => {
    process.exitCode = code
  },
  (error: unknown) => {
    console.error(`The eval stopped on an unexpected ${errorName(error)}.`)
    process.exitCode = 2
  },
)
