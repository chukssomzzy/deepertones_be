/*
 * The labeller of `npm run eval:routine:auto-label` (#152): a model labels the routine eval's cases as a dermatologist experienced with skin of colour would, so a person
 * without that training does not have to. For each case it is shown the person, the shelf with its verdicts and each gap that has two or more candidates, with the facts
 * the label sheet shows, and answers which candidate is best and which others are acceptable. It never sees a routine, another case, evidence links or outcome hints. The
 * labels it makes are provisional, and a judge on the same model does not get to count its agreement with them (see selectJudge). It lives with the eval, not in
 * src/providers, because nothing in the product asks it anything.
 *
 * Two halves: AnthropicRoutineLabeller (the adapter, one Claude call per case) and runAutoLabel (the command's core, without the network, the clock or the disk).
 */
import { z } from 'zod'
import { ROUTINE_STEPS, type RoutineStep } from '../../src/modules/catalog/catalog.vocabulary'
import type { RoutineSkeleton } from '../../src/modules/routines/routines.types'
import { routineLabellerLabelRoutinePrompt } from '../../src/prompts/prompts.generated'
import { AiBudgetExceededError } from '../../src/providers/anthropic/ai-spend.provider'
import type { AnthropicClient } from '../../src/providers/anthropic/anthropic.client'
import { AnthropicConfigError, AnthropicRequestError } from '../../src/providers/anthropic/anthropic.provider'
import type { MemoryAiSpendLedger } from '../../src/providers/anthropic/memory.ai-spend-ledger'
import type { RoutineCase } from './routine-cases'
import { type GapLabel, type LabelSet, LabelSetError, LabelSheetError, labelSetPath, type SheetEntry } from './routine-labels'
import { classNameOf, usd } from './routine-run'
import { buildSkeleton } from './routine-skeleton'
import type { Snapshot } from './routine-snapshot'

export type LabellerInput = {
  skeleton: RoutineSkeleton
  country?: string
  currency?: string
}

export type CaseLabels = Partial<Record<RoutineStep, GapLabel>>

export interface RoutineLabeller {
  /** Labels the gaps of the case that have two or more candidates, and only those (none: {} and no call). Throws the client's errors, and AnthropicRequestError for a reply that would leave the case half-labelled or labelled wrongly. */
  label(input: LabellerInput): Promise<CaseLabels>
}

// Closed by zod's JSON schema; the codes are checked in code below, because structured outputs do not support the string constraints a code check would need.
const AnswerSchema = z.object({ gaps: z.array(z.object({ step: z.enum(ROUTINE_STEPS), best: z.string(), acceptable: z.array(z.string()) })) })

/** Labels a case with Claude. It has no tools, and sees only what the label sheet shows for the case. */
export class AnthropicRoutineLabeller implements RoutineLabeller {
  // Room for the answer and for the model's thinking, which counts against max_tokens.
  private static readonly MAX_TOKENS = 8192
  private static readonly LEAD_IN = 'Label this person:'

  private readonly client: AnthropicClient

  constructor(client: AnthropicClient) {
    this.client = client
  }

  async label({ skeleton, country, currency }: LabellerInput): Promise<CaseLabels> {
    // A gap with one candidate has nothing to choose and a gap with none is "use what you have": neither is the model's to label.
    const gaps = skeleton.gaps.filter((gap) => gap.candidates.length >= 2)
    if (gaps.length === 0) return {}

    const { person } = skeleton
    const shown = {
      goal: skeleton.goal,
      person,
      country,
      currency,
      // The shelf as the sheet's person columns and the verdicts show it; its source links are AI-only context and stay out.
      shelf: skeleton.shelf.map(({ id, brand, name, ingredients, step, verdict }) => ({ id, brand, name, ingredients, step, verdict })),
      gaps: gaps.map((gap) => ({
        step: gap.step,
        candidates: gap.candidates.map(({ code, brand, name, form, ingredients, skinConcerns, priceMin, priceMax, frequency }) => ({ code, brand, name, form, ingredients, skinConcerns, priceMin, priceMax, frequency })),
      })),
    }
    const answer = await this.client.structured(
      {
        max_tokens: AnthropicRoutineLabeller.MAX_TOKENS,
        system: routineLabellerLabelRoutinePrompt.text,
        messages: [{ role: 'user', content: [{ type: 'text', text: `${AnthropicRoutineLabeller.LEAD_IN}\n${JSON.stringify(shown)}` }] }],
      },
      AnswerSchema,
      { job: routineLabellerLabelRoutinePrompt.job },
    )

    // One entry for each gap sent and for no other, each code a candidate of its own gap, none twice, and the best not among the acceptable. Anything else is no label.
    const bad = (): never => {
      throw new AnthropicRequestError('Claude returned labels that do not fit the gaps it was sent')
    }
    if (answer.gaps.length !== gaps.length) bad()
    const labels: CaseLabels = {}
    for (const { step, best, acceptable } of answer.gaps) {
      const gap = gaps.find((g) => g.step === step)
      if (gap === undefined || labels[step] !== undefined) return bad()
      const codes = gap.candidates.map((c) => c.code)
      if (!codes.includes(best) || acceptable.some((code) => !codes.includes(code) || code === best) || new Set(acceptable).size !== acceptable.length) return bad()
      labels[step] = { candidates: [...codes].sort(), best, acceptable: [...acceptable].sort() }
    }
    return labels
  }
}

// --- the command's core ------------------------------------------------------------------------------------------------------------------------

export type AutoLabelIo = {
  log: (line: string) => void
  exists: (path: string) => Promise<boolean>
  saveLabelSet: (labels: LabelSet) => Promise<string>
  writeSheet: (path: string, entries: SheetEntry[], snapshotSha256: string, countries: readonly { code: string; currency: string }[], filled: LabelSet['cases']) => Promise<void>
}

export type AutoLabelArgs = {
  version: string
  cases: RoutineCase[]
  /** Label only the first N cases. */
  limit?: number
  /** The model the labeller runs on: it is written into the label set as `labelledBy`. */
  model: string
  snapshot: Snapshot
  deps: { labeller: RoutineLabeller; ledger: MemoryAiSpendLedger }
  io: AutoLabelIo
}

/** The filled copy of the label sheet that goes with a label set: for a person to spot-check or correct, then read back with `eval:routine:labels`. */
export const autoLabelSheetPath = (version: string, model: string): string => `eval-data/routine/label-sheet-${version}-${model}.xlsx`

/**
 * Labels each case once, on the capped ledger, one at a time. A gap with one candidate gets it as best and a gap with none is left out, as the sheet reader makes them.
 * If any case fails, or the cap stops the run, nothing is saved (exit 1: a half-labelled set must never exist); a rejected key is exit 2. A label set or sheet that
 * exists is never overwritten, and that is checked before anything is spent. The console prints ids, counts and costs, never what the model chose or said.
 */
export const runAutoLabel = async ({ version, cases: allCases, limit, model, snapshot, deps, io }: AutoLabelArgs): Promise<{ exitCode: number }> => {
  const { labeller, ledger } = deps
  const setPath = labelSetPath(version)
  const sheetPath = autoLabelSheetPath(version, model)
  for (const path of [setPath, sheetPath]) {
    if (await io.exists(path)) {
      io.log(`${path} exists already. A label set or sheet is never overwritten: pick a new version. Nothing was asked.`)
      return { exitCode: 2 }
    }
  }

  const cases = allCases.slice(0, limit)
  io.log(`Auto-label: ${cases.length} cases, version ${version}, cap ${usd(ledger.capMicros)}`)
  const labelled: LabelSet['cases'] = {}
  const entries: SheetEntry[] = []
  const failed: string[] = []
  let stopped: 'cap' | 'config' | null = null
  for (const c of cases) {
    const { skeleton } = await buildSkeleton(c, snapshot, { hintsShown: false })
    const spentBefore = ledger.spentMicros()
    try {
      const asked = await labeller.label({ skeleton, country: c.country, currency: snapshot.countries.find((country) => country.code === c.country)?.currency })
      const labels: CaseLabels = {}
      for (const gap of skeleton.gaps) {
        if (gap.candidates.length === 1) labels[gap.step] = { candidates: [gap.candidates[0]!.code], best: gap.candidates[0]!.code, acceptable: [] }
        else if (gap.candidates.length >= 2) {
          // A case is never half-labelled: a gap the labeller left out fails the case.
          if (asked[gap.step] === undefined) throw new AnthropicRequestError('The labeller left a gap out')
          labels[gap.step] = asked[gap.step]
        }
      }
      labelled[c.id] = labels
      entries.push({ id: c.id, country: c.country, skeleton })
      io.log(`${c.id}  ${Object.keys(labels).length} gaps  ${usd(ledger.spentMicros() - spentBefore)}`)
    } catch (error) {
      const cost = usd(ledger.spentMicros() - spentBefore)
      if (error instanceof AiBudgetExceededError) stopped = 'cap'
      else if (error instanceof AnthropicConfigError) stopped = 'config'
      else failed.push(c.id)
      io.log(`${c.id}  ${stopped !== null ? 'stopped' : `failed ${classNameOf(error)}`}  ${cost}`)
      if (stopped !== null) break
    }
  }

  io.log(`Spent ${usd(ledger.spentMicros())} of the ${usd(ledger.capMicros)} cap.`)
  if (stopped === 'config') {
    io.log('Stopped: Claude refused our key, billing or permissions. Fix the setup (ANTHROPIC_API_KEY and the account) and run again. Nothing was saved.')
    return { exitCode: 2 }
  }
  if (stopped === 'cap') {
    io.log('Stopped at the spend cap: the cases after this point were not labelled. Nothing was saved; raise --max-usd or label fewer cases with --limit.')
    return { exitCode: 1 }
  }
  if (failed.length > 0) {
    io.log(`Failed cases: ${failed.join(', ')}. Nothing was saved: a label set is never partial.`)
    return { exitCode: 1 }
  }

  try {
    const path = await io.saveLabelSet({ version, status: 'provisional', snapshotSha256: snapshot.sha256, labelledBy: model, cases: labelled })
    io.log(`Label set: ${path} (provisional, labelled by ${model})`)
  } catch (error) {
    if (!(error instanceof LabelSetError)) throw error
    io.log(error.message)
    return { exitCode: 2 }
  }
  try {
    await io.writeSheet(sheetPath, entries, snapshot.sha256, snapshot.countries, labelled)
    io.log(`Filled label sheet: ${sheetPath}. To spot-check, open it, correct the label column, and read it back as a new version with npm run eval:routine:labels.`)
  } catch (error) {
    if (!(error instanceof LabelSheetError)) throw error
    io.log(`The label set was saved, but the filled sheet was not: ${error.message}`)
    return { exitCode: 2 }
  }
  return { exitCode: 0 }
}
