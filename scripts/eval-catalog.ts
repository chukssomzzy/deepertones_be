// Runs the catalog's model-backed steps against fixed cases and reports how many held: `npm run eval:catalog`.
// Needs ANTHROPIC_API_KEY (environment, else .dev.vars) and makes real, billed calls. It is report-only, is never part
// of `npm test`, and never prints the key, a prompt or raw model output: only case ids, fixed problem codes and timings.
//   --mode analysis|research|all   (default all)    --limit N   cases per mode    --model NAME   override ANTHROPIC_MODEL
// Exit: 0 every case passed, 1 a case failed, 2 the run could not start (bad arguments, missing key, rejected key).
import { mkdirSync, writeFileSync } from 'node:fs'
import { checkAnalysis } from '../src/modules/catalog/catalog.analysis'
import { flagFacts } from '../src/modules/catalog/catalog.rules'
import { CONCERN_KINDS, SEVERITIES, TRAITS } from '../src/modules/catalog/catalog.vocabulary'
import { AnthropicClient } from '../src/providers/anthropic/anthropic.client'
import { AnthropicConfigError } from '../src/providers/anthropic/anthropic.provider'
import { AnthropicProductAnalyst } from '../src/providers/product-analysis/anthropic.product-analyst'
import { AnthropicProductResearcher } from '../src/providers/product-research/anthropic.product-researcher'
import { ANALYSIS_CASES, RESEARCH_CASES } from './eval/cases'
import { type AnalysisOutcome, type CaseResult, loadEnv, parseArgs, type ResearchOutcome, scoreAnalysis, scoreResearch, summarise } from './eval/score'

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
const runEach = async <C extends { id: string }>(cases: C[], run: (c: C) => Promise<CaseResult>): Promise<Timed[]> => {
  const results: Timed[] = []
  for (const c of cases) {
    const started = performance.now()
    const scored = await run(c)
    results.push({ ...scored, ms: Math.round(performance.now() - started) })
  }
  return results
}

const printTable = (title: string, results: Timed[]) => {
  console.log(`\n${title}`)
  const width = Math.max('case'.length, ...results.map((r) => r.id.length))
  console.log(`${'case'.padEnd(width)}  pass  ${'ms'.padStart(6)}  problems`)
  for (const r of results) {
    console.log(`${r.id.padEnd(width)}  ${(r.pass ? 'yes' : 'NO').padEnd(4)}  ${String(r.ms).padStart(6)}  ${r.problems.join(', ')}`)
  }
  const { passed, total, passRate } = summarise(results)
  console.log(`${passed}/${total} passed (${Math.round(passRate * 100)}%)`)
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
  const model = args.model ?? env.model
  const client = new AnthropicClient({ apiKey: env.apiKey, model })
  const analyst = new AnthropicProductAnalyst(client)
  const researcher = new AnthropicProductResearcher(client)

  const startedAt = new Date()
  console.log(`Catalog eval: model ${model}, mode ${args.mode}${args.limit ? `, up to ${args.limit} cases per mode` : ''}`)

  const report: { startedAt: string; model: string; mode: string; analysis?: Timed[]; research?: Timed[] } = {
    startedAt: startedAt.toISOString(),
    model,
    mode: args.mode,
  }

  try {
    if (args.mode !== 'research') {
      report.analysis = await runEach(ANALYSIS_CASES.slice(0, args.limit), async (c) => {
        const flaggedFacts = flagFacts(c.ingredients)
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
    if (args.mode !== 'analysis') {
      report.research = await runEach(RESEARCH_CASES.slice(0, args.limit), async (c) =>
        scoreResearch(c, await attempt<ResearchOutcome>(() => researcher.research(c.product))),
      )
      printTable('Research', report.research)
    }
  } catch (error) {
    if (!(error instanceof SetupError)) throw error
    console.error(error.message)
    return 2
  }

  const all = [...(report.analysis ?? []), ...(report.research ?? [])]
  const summary = summarise(all)
  console.log(`\nOverall: ${summary.passed}/${summary.total} passed`)

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
