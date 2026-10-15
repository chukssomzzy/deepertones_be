/*
 * The pure parts of `npm run eval:catalog`: scoring a result against its case, summing up, reading the command line
 * and finding the API key. Nothing here calls the API or prints, so all of it is tested (score.test.ts).
 */
import { readFileSync } from 'node:fs'
import { ingredientParts, normaliseIngredient } from '../../src/modules/catalog/catalog.ingredients'
import type { DraftConcernRow } from '../../src/modules/catalog/catalog.types'
import { SEVERITIES } from '../../src/modules/catalog/catalog.vocabulary'
import type { ResearchResult } from '../../src/providers/product-research/product-researcher.provider'
import { parseEnvFile } from '../secrets/plan'
import type { AnalysisCase, ResearchCase } from './cases'

/** A concern as checkAnalysis stores it. */
export type StoredDraft = DraftConcernRow

export type CaseResult = { id: string; pass: boolean; problems: string[] }

/** What happened when a case was run: stored by the checks, refused by them, or the adapter threw (its error name only). */
export type AnalysisOutcome = { stored: StoredDraft[] } | { rejected: string } | { error: string }

const result = (id: string, problems: string[]): CaseResult => ({ id, pass: problems.length === 0, problems })

/**
 * Problems are fixed codes, never model text: `rejected:<code>`, `error:<name>`, `missing:<kind>:<ingredient>` for a
 * flagged fact no stored concern covers, and `severity:<kind><<minimum>` for a concern milder than the case requires.
 */
export const scoreAnalysis = (c: AnalysisCase, outcome: AnalysisOutcome): CaseResult => {
  if ('rejected' in outcome) return result(c.id, [`rejected:${outcome.rejected}`])
  if ('error' in outcome) return result(c.id, [`error:${outcome.error}`])

  const { stored } = outcome
  const problems: string[] = []
  const missingKinds = new Set<string>()
  for (const { kind, ingredient } of c.expect.flagged) {
    const wanted = normaliseIngredient(ingredient)
    const covered = stored.some((s) => s.kind === kind && s.ingredients.some((name) => normaliseIngredient(name) === wanted))
    if (covered) continue
    missingKinds.add(kind)
    problems.push(`missing:${kind}:${ingredient}`)
  }
  for (const { kind, severity } of c.expect.severityAtLeast ?? []) {
    if (missingKinds.has(kind)) continue
    const minimum = SEVERITIES.indexOf(severity)
    if (!stored.some((s) => s.kind === kind && SEVERITIES.indexOf(s.severity) >= minimum)) problems.push(`severity:${kind}<${severity}`)
  }
  return result(c.id, problems)
}

export type ResearchOutcome = ResearchResult | { error: string }

export const scoreResearch = (c: ResearchCase, outcome: ResearchOutcome): CaseResult => {
  if ('error' in outcome) return result(c.id, [`error:${outcome.error}`])
  if (!outcome.found) return result(c.id, ['not-found'])

  // Compared by the catalog's own parts, so "Theobroma Cacao (Cocoa) Seed Butter" has both spellings.
  const present = new Set(outcome.ingredients.flatMap(ingredientParts))
  return result(
    c.id,
    c.expect.ingredientsInclude.filter((name) => !present.has(normaliseIngredient(name))).map((name) => `missing-ingredient:${name}`),
  )
}

export const summarise = (results: CaseResult[]): { total: number; passed: number; failed: number; passRate: number } => {
  const total = results.length
  const passed = results.filter((r) => r.pass).length
  return { total, passed, failed: total - passed, passRate: total === 0 ? 0 : passed / total }
}

export type Mode = 'analysis' | 'research' | 'all'
export type Args = { mode: Mode; limit: number | undefined; model: string | undefined }

const MODES: readonly Mode[] = ['analysis', 'research', 'all']
export const USAGE = 'Usage: npm run eval:catalog -- [--mode analysis|research|all] [--limit N] [--model NAME]'

/** Strict on purpose: a misspelt flag must stop the run before it spends money. Accepts `--flag value` and `--flag=value`. */
export const parseArgs = (argv: string[]): Args => {
  let mode: Mode = 'all'
  let limit: number | undefined
  let model: string | undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const equals = arg.startsWith('--') ? arg.indexOf('=') : -1
    const flag = equals === -1 ? arg : arg.slice(0, equals)
    if (flag !== '--mode' && flag !== '--limit' && flag !== '--model') throw new Error(`Unrecognised argument "${arg}". ${USAGE}`)

    const value = equals === -1 ? argv[++i] : arg.slice(equals + 1)
    if (value === undefined || value === '' || value.startsWith('-')) throw new Error(`${flag} needs a value. ${USAGE}`)

    if (flag === '--mode') {
      if (!MODES.includes(value as Mode)) throw new Error(`Unknown mode "${value}". ${USAGE}`)
      mode = value as Mode
    } else if (flag === '--limit') {
      if (!/^\d+$/.test(value) || Number(value) < 1) throw new Error(`--limit must be a whole number of at least 1. ${USAGE}`)
      limit = Number(value)
    } else {
      model = value
    }
  }
  return { mode, limit, model }
}

const DEFAULT_MODEL = 'claude-sonnet-5-5'

export type EnvInput = {
  env?: Record<string, string | undefined>
  /** Sync or async; a missing file is reported by an error whose `code` is ENOENT. */
  readFile?: (path: string) => string | Promise<string>
}

/**
 * The key and model: the environment first, then `.dev.vars` (the same file `wrangler dev` reads), then the
 * default model. A blank value is no value. The error names the variable and carries no value from either place.
 */
export const loadEnv = async ({
  env = process.env,
  readFile = (path) => readFileSync(path, 'utf8'),
}: EnvInput = {}): Promise<{ apiKey: string; model: string }> => {
  let apiKey = env.ANTHROPIC_API_KEY || undefined
  let model = env.ANTHROPIC_MODEL || undefined
  if (!apiKey || !model) {
    let file: Map<string, string> | undefined
    try {
      file = parseEnvFile(await readFile('.dev.vars'))
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== 'ENOENT') throw error
    }
    apiKey ||= file?.get('ANTHROPIC_API_KEY') || undefined
    model ||= file?.get('ANTHROPIC_MODEL') || undefined
  }
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set: export it, or put it in .dev.vars.')
  return { apiKey, model: model ?? DEFAULT_MODEL }
}
