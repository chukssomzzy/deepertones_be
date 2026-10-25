import { describe, expect, it } from 'vitest'
import type { RoutineStep } from '../../src/modules/catalog/catalog.vocabulary'
import type { RoutineSkeleton } from '../../src/modules/routines/routines.types'
import { routineLabellerLabelRoutinePrompt } from '../../src/prompts/prompts.generated'
import { AiBudgetExceededError, type AiJob } from '../../src/providers/anthropic/ai-spend.provider'
import { AnthropicClient } from '../../src/providers/anthropic/anthropic.client'
import { AnthropicConfigError, AnthropicRefusalError, AnthropicRequestError, AnthropicUnavailableError } from '../../src/providers/anthropic/anthropic.provider'
import { MemoryAiSpendLedger } from '../../src/providers/anthropic/memory.ai-spend-ledger'
import {
  API_KEY,
  BIG_CAP_MICROS,
  caught,
  errorResponse,
  MODEL,
  MODELS,
  messageResponse,
  requestText,
  stubFetch,
  textBlock,
} from '../../src/providers/anthropic/messages-api.fake'
import { type GapLabel, type LabelSet, LabelSetError, labelSetPath, type SheetEntry } from './routine-labels'
import { AnthropicRoutineLabeller, autoLabelSheetPath, type LabellerInput, runAutoLabel, type RoutineLabeller } from './routine-labeller'
import { usd } from './routine-run'
import { caseOf, candidate, offer, row, shelfProduct, skeletonOf, snapshotOf } from './routine.fixture'
import type { RoutineCase } from './routine-cases'

// The labeller of `npm run eval:routine:auto-label` (#152, follow-up to PR D2): Opus labels the eval's cases as a dermatologist experienced with skin of colour would, so a
// person without that training does not have to. This file holds its two halves.
//
// 1. AnthropicRoutineLabeller, the adapter. One Claude call per case, under the `label-routine` AI job, through client.structured like the judge. It is shown one case: the
//    person, the shelf with its verdicts, and each gap that has TWO OR MORE candidates with the candidate facts the label sheet shows (code, brand, name, form, ingredients,
//    skin concerns, price range, frequency). It never sees a routine, another case, evidence links, outcome hints or the limits. It answers `{ gaps: [{ step, best, acceptable }] }`
//    and the adapter checks the answer: one entry per gap sent, `best` and every `acceptable` a code of that gap, no duplicates, `best` not in `acceptable`. Anything else is an
//    AnthropicRequestError, so a case is never half-labelled. The labels it returns are only for those gaps, with candidates and acceptable sorted, as the sheet reader makes them.
//      interface RoutineLabeller { label(input: LabellerInput): Promise<Partial<Record<RoutineStep, GapLabel>>> }
//      type LabellerInput = { skeleton: RoutineSkeleton; country?: string; currency?: string }
//      class AnthropicRoutineLabeller implements RoutineLabeller { constructor(client: AnthropicClient) }
//      prompt: routineLabellerLabelRoutinePrompt in src/prompts/prompts.generated.ts, from src/prompts/routine-labeller.label-routine.md (job label-routine)
//    A case with no gap of two or more candidates has nothing to choose, so it costs no call and gets {}.
//
// 2. runAutoLabel, the command's core, without the network, the clock or the disk (the script injects them), with a memory labeller here. It builds each case's skeleton as the
//    label sheet does (buildSkeleton, hintsShown false), asks the labeller once per case, gives a gap with one candidate that candidate as best, leaves a gap with none out, and
//    saves a provisional label set with `labelledBy` and a filled copy of the sheet. If any case fails, or the cap stops the run, nothing is saved and the exit code is 1; a
//    rejected key is 2. The labelled set's path is eval-data/ (which tests never touch), so disk goes through `io`.
//      runAutoLabel({ version, cases, limit?, model, snapshot, deps: { labeller, ledger }, io }): Promise<{ exitCode: number }>
//        io = { log(line), exists(path): Promise<boolean>, saveLabelSet(labels: LabelSet): Promise<string>,
//               writeSheet(path, entries: SheetEntry[], snapshotSha256: string, countries, filled: LabelSet['cases']): Promise<void> }
//        deps.ledger: MemoryAiSpendLedger, the one the labeller's client spends on; its capMicros is the --max-usd cap
//      autoLabelSheetPath(version, model): string = `eval-data/routine/label-sheet-<version>-<model>.xlsx`
//    Before anything is spent it checks (io.exists) that neither the label set file (labelSetPath(version)) nor the sheet exists: a run that would be refused at the end must not
//    be paid for first. Exit 2 then, with nothing asked.

const LABEL_JOB = 'label-routine' as AiJob
const ROUTED_TO = 'claude-opus-5-5'

// --- the adapter -----------------------------------------------------------------------------------------------------------------------------------

const CANDIDATE_NAME = 'zzqx-unique-cleanser-name'
const SOLO_NAME = 'zzqx-solo-treatment-name'
const SOLO_CODE = 'T-SOLO-77'
const SHELF_NAME = 'zzqx-shelf-serum'
const EVIDENCE = 'EVIDENCE-SENTINEL'
const INGREDIENT_SOURCE = 'INGSRC-SENTINEL'

// cleanse: 2 candidates. treat: 1 (nothing to choose). moisturise: 3. protect: none.
const SKELETON: RoutineSkeleton = skeletonOf(
  [
    {
      step: 'cleanse',
      candidates: [
        candidate('C-A', {
          brand: 'Zzqx Brand',
          name: CANDIDATE_NAME,
          form: 'gel',
          ingredients: ['Aqua', 'Zzqx-Niacinamide'],
          skinConcerns: ['hd_age_spot'],
          priceMin: 1234,
          priceMax: 5678,
          frequency: 'alternate-days',
          evidenceUrls: [`https://evidence.example/${EVIDENCE}/a`],
          ingredientsSourceUrl: `https://ingredients.example/${INGREDIENT_SOURCE}`,
        }),
        candidate('C-B'),
      ],
    },
    { step: 'treat', candidates: [candidate(SOLO_CODE, { name: SOLO_NAME })] },
    { step: 'moisturise', candidates: [candidate('M-1'), candidate('M-2'), candidate('M-3')] },
    { step: 'protect', candidates: [] },
  ],
  {
    goal: 'even-tone',
    person: { seen: [{ concern: 'hd_age_spot', level: 'some' }], alsoNoticed: [{ concern: 'hd_acne', level: 'a-little' }], skinType: 'combination', lowConfidence: [], cautions: ['tapering'], budgetBand: 'low' },
    shelf: [shelfProduct('shelf-1', { name: SHELF_NAME, verdict: { kind: 'keep' } })],
  },
)
const INPUT: LabellerInput = { skeleton: SKELETON, country: 'NG', currency: 'NGN' }

/** What the model answers for SKELETON when it does well. */
const GOOD = {
  gaps: [
    { step: 'cleanse', best: 'C-A', acceptable: ['C-B'] },
    { step: 'moisturise', best: 'M-3', acceptable: ['M-2'] },
  ],
}
const withGaps = (gaps: unknown) => ({ gaps })

const labellerWith = (fetch: typeof globalThis.fetch, ledger = new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS }), models: Record<AiJob, string> = { ...MODELS, [LABEL_JOB]: MODEL } as Record<AiJob, string>) =>
  new AnthropicRoutineLabeller(new AnthropicClient({ apiKey: API_KEY, models, ledger, baseURL: 'https://anthropic.example', fetch }))

/** A labeller whose model answers `answer` (any value, so a test can break it); `calls` records the requests. */
const labellerAnswering = (answer: unknown = GOOD) => {
  const stub = stubFetch(() => messageResponse({ content: [textBlock(JSON.stringify(answer))] }))
  return { ...stub, labeller: labellerWith(stub.fetch) }
}

describe('AnthropicRoutineLabeller: the request', () => {
  it('sends the label-routine prompt as the system prompt, with no tools: it labels what it is shown and fetches nothing', async () => {
    const { calls, labeller } = labellerAnswering()

    await labeller.label(INPUT)

    expect(JSON.stringify(calls[0]!.body.system)).toContain(JSON.stringify(routineLabellerLabelRoutinePrompt.text).slice(1, -1))
    expect('tools' in calls[0]!.body).toBe(false)
    expect('tool_choice' in calls[0]!.body).toBe(false)
  })

  it('sends one case in one user message: the person, the shelf with its verdicts, and the country and currency', async () => {
    const { calls, labeller } = labellerAnswering()

    await labeller.label(INPUT)

    expect(calls[0]!.body.messages).toHaveLength(1)
    expect(calls[0]!.body.messages[0].role).toBe('user')
    const sent = requestText(calls[0]!.body)
    for (const part of ['even-tone', 'hd_age_spot', 'hd_acne', 'combination', 'tapering', 'low', 'NG', 'NGN', SHELF_NAME, 'keep']) expect(sent, part).toContain(part)
  })

  it('sends every gap that has two or more candidates with the candidate facts the label sheet shows', async () => {
    const { calls, labeller } = labellerAnswering()

    await labeller.label(INPUT)

    const sent = requestText(calls[0]!.body)
    for (const part of ['C-A', 'C-B', 'M-1', 'M-2', 'M-3', 'Zzqx Brand', CANDIDATE_NAME, 'gel', 'Zzqx-Niacinamide', 'hd_age_spot', '1234', '5678', 'alternate-days']) expect(sent, part).toContain(part)
  })

  it('sends nothing of a gap with a single candidate: there is nothing to choose, so it is not the model\'s to label', async () => {
    const { calls, labeller } = labellerAnswering()

    await labeller.label(INPUT)

    const sent = requestText(calls[0]!.body)
    expect(sent).not.toContain(SOLO_CODE)
    expect(sent).not.toContain(SOLO_NAME)
  })

  it('does not send what the label sheet does not show: no evidence links, no ingredients source', async () => {
    const { calls, labeller } = labellerAnswering()

    await labeller.label(INPUT)

    const sent = requestText(calls[0]!.body)
    expect(sent).not.toContain(EVIDENCE)
    expect(sent).not.toContain(INGREDIENT_SOURCE)
  })

  it('keeps the case out of the system prompt, so the instructions do not carry the data', async () => {
    const { calls, labeller } = labellerAnswering()

    await labeller.label(INPUT)

    for (const part of [CANDIDATE_NAME, SHELF_NAME, 'tapering']) expect(JSON.stringify(calls[0]!.body.system), part).not.toContain(part)
  })

  it('leaves room for the answer and for the model\'s thinking: max_tokens of at least 4096', async () => {
    const { calls, labeller } = labellerAnswering()

    await labeller.label(INPUT)

    expect(calls[0]!.body.max_tokens).toBeGreaterThanOrEqual(4096)
  })

  it('asks for a json_schema structured output of { gaps: [{ step, best, acceptable }] }, every object closed and every field required, and no oneOf', async () => {
    const { calls, labeller } = labellerAnswering()

    await labeller.label(INPUT)

    const format = calls[0]!.body.output_config.format
    expect(format.type).toBe('json_schema')
    expect(Object.keys(format.schema.properties)).toEqual(['gaps'])
    expect(format.schema.required).toEqual(['gaps'])
    expect(format.schema.additionalProperties).toBe(false)
    const item = format.schema.properties.gaps.items
    expect(Object.keys(item.properties).sort()).toEqual(['acceptable', 'best', 'step'])
    expect([...item.required].sort()).toEqual(['acceptable', 'best', 'step'])
    expect(item.additionalProperties).toBe(false)
    expect(JSON.stringify(format.schema)).not.toContain('"oneOf"')
  })

  it('makes exactly one request for a case', async () => {
    const { calls, labeller } = labellerAnswering()

    await labeller.label(INPUT)

    expect(calls).toHaveLength(1)
  })

  it('makes one request per case, and a case is never sent with another: the second request holds nothing of the first', async () => {
    const other = skeletonOf([{ step: 'cleanse', candidates: [candidate('X-1', { name: 'other-case-name' }), candidate('X-2')] }])
    const goodForOther = withGaps([{ step: 'cleanse', best: 'X-1', acceptable: [] }])
    const { calls, fetch } = stubFetch(() => messageResponse({ content: [textBlock(JSON.stringify(GOOD))] }), () => messageResponse({ content: [textBlock(JSON.stringify(goodForOther))] }))
    const labeller = labellerWith(fetch)

    await labeller.label(INPUT)
    await labeller.label({ skeleton: other })

    expect(calls).toHaveLength(2)
    const secondText = requestText(calls[1]!.body)
    expect(secondText).toContain('other-case-name')
    for (const part of [CANDIDATE_NAME, SHELF_NAME, 'tapering', 'M-3']) expect(secondText, part).not.toContain(part)
  })

  it('makes no request, and spends nothing, for a case with no gap of two or more candidates: it returns no labels', async () => {
    const ledger = new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS })
    const { calls, fetch } = stubFetch(() => messageResponse({ content: [textBlock(JSON.stringify(GOOD))] }))
    const nothingToChoose = skeletonOf([
      { step: 'cleanse', candidates: [candidate('C-ONLY')] },
      { step: 'treat', candidates: [] },
    ])

    const labels = await labellerWith(fetch, ledger).label({ skeleton: nothingToChoose })

    expect(labels).toEqual({})
    expect(calls).toHaveLength(0)
    expect(ledger.entries).toHaveLength(0)
  })
})

describe('AnthropicRoutineLabeller: the labels', () => {
  it('maps a good reply to the gap labels: each gap\'s candidates, its best and its acceptable, and only for the gaps it was shown', async () => {
    const { labeller } = labellerAnswering()

    await expect(labeller.label(INPUT)).resolves.toStrictEqual({
      cleanse: { candidates: ['C-A', 'C-B'], best: 'C-A', acceptable: ['C-B'] },
      moisturise: { candidates: ['M-1', 'M-2', 'M-3'], best: 'M-3', acceptable: ['M-2'] },
    })
  })

  it('reads the gaps in any order, and gives candidates and acceptable sorted by code', async () => {
    const { labeller } = labellerAnswering(
      withGaps([
        { step: 'moisturise', best: 'M-3', acceptable: ['M-2', 'M-1'] },
        { step: 'cleanse', best: 'C-B', acceptable: [] },
      ]),
    )

    await expect(labeller.label(INPUT)).resolves.toStrictEqual({
      cleanse: { candidates: ['C-A', 'C-B'], best: 'C-B', acceptable: [] },
      moisturise: { candidates: ['M-1', 'M-2', 'M-3'], best: 'M-3', acceptable: ['M-1', 'M-2'] },
    })
  })

  it('keeps only the labels\' own fields: any other text the model wrote goes no further', async () => {
    const answer = withGaps(GOOD.gaps.map((gap) => ({ ...gap, why: 'SENTINEL-WHY' })))

    const labels = await labellerAnswering({ ...answer, notes: 'SENTINEL-NOTES' }).labeller.label(INPUT)

    expect(JSON.stringify(labels)).not.toContain('SENTINEL')
    expect(Object.keys(labels.cleanse!).sort()).toEqual(['acceptable', 'best', 'candidates'])
  })

  // Each of these is a reply the model could give that would leave a case half-labelled or labelled wrongly: it is a throw, never a partial set of labels.
  it.each([
    ['a gap that was sent and is missing from the reply', withGaps([GOOD.gaps[0]])],
    ['an empty reply', withGaps([])],
    ['a gap that was not sent (one candidate)', withGaps([...GOOD.gaps, { step: 'treat', best: SOLO_CODE, acceptable: [] }])],
    ['a gap that was not sent (no candidates)', withGaps([...GOOD.gaps, { step: 'protect', best: 'P-1', acceptable: [] }])],
    ['the same gap twice', withGaps([...GOOD.gaps, { step: 'cleanse', best: 'C-B', acceptable: [] }])],
    ['a best that is no code at all', withGaps([{ step: 'cleanse', best: 'C-ZZ', acceptable: [] }, GOOD.gaps[1]])],
    ['a best that is a candidate of another gap', withGaps([{ step: 'cleanse', best: 'M-1', acceptable: [] }, GOOD.gaps[1]])],
    ['an acceptable that is no code at all', withGaps([{ step: 'cleanse', best: 'C-A', acceptable: ['C-ZZ'] }, GOOD.gaps[1]])],
    ['an acceptable that is a candidate of another gap', withGaps([GOOD.gaps[0], { step: 'moisturise', best: 'M-3', acceptable: ['C-A'] }])],
    ['an acceptable listed twice', withGaps([GOOD.gaps[0], { step: 'moisturise', best: 'M-3', acceptable: ['M-2', 'M-2'] }])],
    ['a best that is also acceptable', withGaps([{ step: 'cleanse', best: 'C-A', acceptable: ['C-A'] }, GOOD.gaps[1]])],
    ['an empty best', withGaps([{ step: 'cleanse', best: '', acceptable: [] }, GOOD.gaps[1]])],
    ['a step outside the four', withGaps([...GOOD.gaps, { step: 'exfoliate', best: 'E-1', acceptable: [] }])],
    ['a gap with no best', withGaps([{ step: 'cleanse', acceptable: [] }, GOOD.gaps[1]])],
    ['a gap with no acceptable', withGaps([{ step: 'cleanse', best: 'C-A' }, GOOD.gaps[1]])],
    ['an acceptable that is one string', withGaps([{ step: 'cleanse', best: 'C-A', acceptable: 'C-B' }, GOOD.gaps[1]])],
    ['no gaps field', {}],
    ['gaps that are not a list', { gaps: 'cleanse' }],
  ])('throws AnthropicRequestError for %s', async (_label, answer) => {
    const { labeller } = labellerAnswering(answer)

    expect(await caught(labeller.label(INPUT))).toBeInstanceOf(AnthropicRequestError)
  })

  it('accepts a best with every other candidate acceptable, and a best with none', async () => {
    const all = withGaps([{ step: 'cleanse', best: 'C-A', acceptable: ['C-B'] }, { step: 'moisturise', best: 'M-1', acceptable: ['M-2', 'M-3'] }])
    const none = withGaps([{ step: 'cleanse', best: 'C-A', acceptable: [] }, { step: 'moisturise', best: 'M-1', acceptable: [] }])

    await expect(labellerAnswering(all).labeller.label(INPUT)).resolves.toMatchObject({ moisturise: { best: 'M-1', acceptable: ['M-2', 'M-3'] } })
    await expect(labellerAnswering(none).labeller.label(INPUT)).resolves.toMatchObject({ moisturise: { best: 'M-1', acceptable: [] } })
  })
})

describe('AnthropicRoutineLabeller: job routing, cost and errors', () => {
  it('asks Claude as the label-routine job and uses the model configured for it', async () => {
    const { calls, fetch } = stubFetch(() => messageResponse({ content: [textBlock(JSON.stringify(GOOD))] }))

    await labellerWith(fetch, undefined, { ...MODELS, [LABEL_JOB]: ROUTED_TO } as Record<AiJob, string>).label(INPUT)

    expect(calls[0]!.body.model).toBe(ROUTED_TO)
  })

  it('does not use the model of any other job', async () => {
    const { calls, fetch } = stubFetch(() => messageResponse({ content: [textBlock(JSON.stringify(GOOD))] }))
    const others = (Object.keys(MODELS) as AiJob[]).filter((job) => job !== LABEL_JOB)

    for (const other of others) await labellerWith(fetch, undefined, { ...MODELS, [LABEL_JOB]: MODEL, [other]: ROUTED_TO } as Record<AiJob, string>).label(INPUT)

    expect(calls.map((c) => c.body.model)).toEqual(others.map(() => MODEL))
  })

  it('records its call on the ledger under the label-routine job, one entry for a case', async () => {
    const ledger = new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS })
    const { fetch } = stubFetch(() => messageResponse({ content: [textBlock(JSON.stringify(GOOD))] }))

    await labellerWith(fetch, ledger).label(INPUT)

    expect(ledger.entries.map((e) => [e.job, e.model, e.status])).toEqual([[LABEL_JOB, MODEL, 'settled']])
  })

  it('throws AiBudgetExceededError, sending nothing, when the spend cap would be passed', async () => {
    const { calls, fetch } = stubFetch(() => messageResponse({ content: [textBlock(JSON.stringify(GOOD))] }))

    const error = await caught(labellerWith(fetch, new MemoryAiSpendLedger({ capMicros: 1 })).label(INPUT))

    expect(error).toBeInstanceOf(AiBudgetExceededError)
    expect(calls).toHaveLength(0)
  })

  it('throws AnthropicConfigError, sending nothing, for a model that has no price', async () => {
    const { calls, fetch } = stubFetch(() => messageResponse({ content: [textBlock(JSON.stringify(GOOD))] }))

    const error = await caught(labellerWith(fetch, undefined, { ...MODELS, [LABEL_JOB]: 'claude-unpriced-1' } as Record<AiJob, string>).label(INPUT))

    expect(error).toBeInstanceOf(AnthropicConfigError)
    expect(calls).toHaveLength(0)
  })

  it.each([
    ['the key or account being rejected (401)', () => errorResponse(401, 'authentication_error'), AnthropicConfigError],
    ['billing being refused (402)', () => errorResponse(402, 'billing_error'), AnthropicConfigError],
    ['Claude being overloaded (529)', () => errorResponse(529, 'overloaded_error'), AnthropicUnavailableError],
    ['a refusal', () => messageResponse({ content: [textBlock('I cannot help with that.')], stop_reason: 'refusal' }), AnthropicRefusalError],
    ['an answer cut off by max_tokens, even if the cut text happens to parse', () => messageResponse({ content: [textBlock(JSON.stringify(GOOD))], stop_reason: 'max_tokens' }), AnthropicRequestError],
    ['text that is not JSON', () => messageResponse({ content: [textBlock('The first one looks best.')] }), AnthropicRequestError],
  ])('lets the vendor error through on %s, with no labels', async (_label, respond, expected) => {
    const { fetch } = stubFetch(respond)

    expect(await caught(labellerWith(fetch).label(INPUT))).toBeInstanceOf(expected)
  })
})

// --- the command's core --------------------------------------------------------------------------------------------------------------------------

const SNAPSHOT = snapshotOf([
  offer('NG', row('C-A', { steps: ['cleanse'] })),
  offer('NG', row('C-B', { steps: ['cleanse'] })),
  offer('NG', row('C-C', { steps: ['cleanse'] })),
  offer('NG', row('M-1', { steps: ['moisturise'] })),
])
// Each person has cleanse with three candidates, moisturise with one, treat and protect with none.
const CASES: RoutineCase[] = [caseOf({ id: 'hold-01' }), caseOf({ id: 'hold-02', persona: 'tolu' }), caseOf({ id: 'hold-03', persona: 'chidi' })]
const MODEL_ID = 'claude-opus-5-5'
const MICROS_PER_CALL = 1000
const ERROR_SENTINEL = 'SENTINEL-LABELLER-ERROR-MESSAGE'

class FakeLabellerError extends Error {}

/** The default answer: the first code (in order) is best, nothing else is acceptable, for every gap with two or more candidates. */
const firstIsBest = (input: LabellerInput): Partial<Record<RoutineStep, GapLabel>> =>
  Object.fromEntries(
    input.skeleton.gaps
      .filter((gap) => gap.candidates.length >= 2)
      .map((gap) => {
        const codes = gap.candidates.map((c) => c.code).sort()
        return [gap.step, { candidates: codes, best: codes[0]!, acceptable: [] }]
      }),
  )

/** A labeller that takes its call's cost on the real ledger path (reserve, then settle), so the cap really stops it, and records what it was asked. */
class SpendingLabeller implements RoutineLabeller {
  readonly calls: LabellerInput[] = []
  constructor(
    private readonly ledger: MemoryAiSpendLedger,
    private readonly micros: number,
    private readonly answer: (call: number, input: LabellerInput) => Partial<Record<RoutineStep, GapLabel>> | undefined,
  ) {}
  async label(input: LabellerInput): Promise<Partial<Record<RoutineStep, GapLabel>>> {
    this.calls.push(input)
    if (this.micros > 0) {
      const id = await this.ledger.reserve({ job: LABEL_JOB, model: 'fake-model', estimateMicros: this.micros })
      await this.ledger.settle(id, { usage: { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, webSearches: 0 }, costMicros: this.micros })
    }
    return this.answer(this.calls.length, input) ?? firstIsBest(input)
  }
}

type Setup = {
  cases?: RoutineCase[]
  limit?: number
  capMicros?: number
  /** What the labeller answers on its n-th call (1-based); the first-is-best labels when it returns undefined. Throw to fail that call. */
  answer?: (call: number, input: LabellerInput) => Partial<Record<RoutineStep, GapLabel>> | undefined
  /** Paths that already exist on the disk. */
  existing?: string[]
  /** What saving the label set does: throw to refuse. */
  save?: () => void
}

const setup = ({ cases = CASES, limit, capMicros = BIG_CAP_MICROS, answer = () => undefined, existing = [], save }: Setup = {}) => {
  const ledger = new MemoryAiSpendLedger({ capMicros })
  const labeller = new SpendingLabeller(ledger, MICROS_PER_CALL, answer)
  const logs: string[] = []
  const saved: LabelSet[] = []
  const sheets: { path: string; entries: SheetEntry[]; sha: string; countries: readonly { code: string; currency: string }[]; filled: LabelSet['cases'] }[] = []
  const asked: string[] = []
  const run = () =>
    runAutoLabel({
      version: 'v3',
      cases,
      ...(limit === undefined ? {} : { limit }),
      model: MODEL_ID,
      snapshot: SNAPSHOT,
      deps: { labeller, ledger },
      io: {
        log: (line: string) => logs.push(line),
        exists: async (path: string) => {
          asked.push(path)
          return existing.includes(path)
        },
        saveLabelSet: async (labels: LabelSet) => {
          save?.()
          saved.push(labels)
          return labelSetPath(labels.version)
        },
        writeSheet: async (path: string, entries: SheetEntry[], sha: string, countries: readonly { code: string; currency: string }[], filled: LabelSet['cases']) => void sheets.push({ path, entries, sha, countries, filled }),
      },
    })
  return { ledger, labeller, logs, saved, sheets, asked, run }
}

const SHEET_PATH = 'eval-data/routine/label-sheet-v3-claude-opus-5-5.xlsx'

describe('autoLabelSheetPath', () => {
  it('names the filled sheet after the version and the model, in the gitignored folder', () => {
    expect(autoLabelSheetPath('v3', 'claude-opus-5-5')).toBe(SHEET_PATH)
    expect(autoLabelSheetPath('v4-derm', 'claude-sonnet-5-5')).toBe('eval-data/routine/label-sheet-v4-derm-claude-sonnet-5-5.xlsx')
  })
})

describe('runAutoLabel: asking the labeller', () => {
  it('asks once per case, in order, with the skeleton the label sheet shows (hints off) and the case\'s country and currency', async () => {
    const { run, labeller } = setup()

    const { exitCode } = await run()

    expect(exitCode).toBe(0)
    expect(labeller.calls).toHaveLength(3)
    for (const call of labeller.calls) {
      expect(call.skeleton.hintsShown).toBe(false)
      expect(call.skeleton.gaps.find((g) => g.step === 'cleanse')!.candidates.map((c) => c.code).sort()).toEqual(['C-A', 'C-B', 'C-C'])
      expect(call.country).toBe('NG')
      expect(call.currency).toBe('NGN')
    }
  })

  it('labels the first N cases with --limit, and saves a set with only those', async () => {
    const { run, labeller, saved } = setup({ limit: 2 })

    const { exitCode } = await run()

    expect(exitCode).toBe(0)
    expect(labeller.calls).toHaveLength(2)
    expect(Object.keys(saved[0]!.cases).sort()).toEqual(['hold-01', 'hold-02'])
  })
})

describe('runAutoLabel: the labels it saves', () => {
  it('gives a gap with one candidate that candidate as best, and leaves a gap with no candidates out', async () => {
    const { run, saved } = setup()

    await run()

    // cleanse (3 candidates) is the labeller's; moisturise (1) is automatic; treat and protect (none) are absent.
    expect(saved[0]!.cases['hold-01']).toEqual({
      cleanse: { candidates: ['C-A', 'C-B', 'C-C'], best: 'C-A', acceptable: [] },
      moisturise: { candidates: ['M-1'], best: 'M-1', acceptable: [] },
    })
    expect(Object.keys(saved[0]!.cases['hold-01']!).sort()).toEqual(['cleanse', 'moisturise'])
  })

  it('uses what the labeller said for the gaps it labelled', async () => {
    const { run, saved } = setup({ answer: () => ({ cleanse: { candidates: ['C-A', 'C-B', 'C-C'], best: 'C-C', acceptable: ['C-A'] } }) })

    await run()

    expect(saved[0]!.cases['hold-02']!.cleanse).toEqual({ candidates: ['C-A', 'C-B', 'C-C'], best: 'C-C', acceptable: ['C-A'] })
  })

  it('saves one provisional label set for the version, pinned to the snapshot, that says which model made it', async () => {
    const { run, saved } = setup()

    await run()

    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ version: 'v3', status: 'provisional', snapshotSha256: SNAPSHOT.sha256, labelledBy: 'claude-opus-5-5' })
    expect(Object.keys(saved[0]!.cases).sort()).toEqual(['hold-01', 'hold-02', 'hold-03'])
  })

  it('writes a filled copy of the label sheet, named for the version and model, with the same labels, the cases\' countries and the snapshot\'s stamp and currencies', async () => {
    const { run, saved, sheets } = setup()

    await run()

    expect(sheets).toHaveLength(1)
    expect(sheets[0]!.path).toBe(SHEET_PATH)
    expect(sheets[0]!.filled).toEqual(saved[0]!.cases)
    expect(sheets[0]!.sha).toBe(SNAPSHOT.sha256)
    expect(sheets[0]!.countries).toEqual(SNAPSHOT.countries)
    expect(sheets[0]!.entries.map((e) => [e.id, e.country])).toEqual([['hold-01', 'NG'], ['hold-02', 'NG'], ['hold-03', 'NG']])
    expect(sheets[0]!.entries[0]!.skeleton.hintsShown).toBe(false)
  })
})

describe('runAutoLabel: when a case cannot be labelled, nothing is saved', () => {
  it('goes on after a case fails, names every failed case, saves nothing and exits 1', async () => {
    const { run, labeller, logs, saved, sheets } = setup({
      answer: (call) => {
        if (call !== 2) return undefined
        throw new AnthropicRequestError(ERROR_SENTINEL)
      },
    })

    const { exitCode } = await run()

    expect(exitCode).toBe(1)
    expect(labeller.calls).toHaveLength(3)
    expect(saved).toEqual([])
    expect(sheets).toEqual([])
    expect(logs.some((l) => l.includes('hold-02'))).toBe(true)
  })

  it('names all the failed cases when more than one fails', async () => {
    const { run, logs, saved } = setup({
      answer: (call) => {
        if (call === 1) throw new FakeLabellerError(ERROR_SENTINEL)
        if (call === 3) throw new AnthropicRequestError(ERROR_SENTINEL)
        return undefined
      },
    })

    expect((await run()).exitCode).toBe(1)
    expect(saved).toEqual([])
    const failed = logs.filter((l) => /fail/i.test(l)).join('\n')
    expect(failed).toContain('hold-01')
    expect(failed).toContain('hold-03')
    expect(failed).not.toContain('hold-02')
  })

  it('counts a reply with no label for a gap that has two or more candidates as a failed case: a case is never half-labelled', async () => {
    const { run, logs, saved } = setup({ answer: () => ({}) })

    const { exitCode } = await run()

    expect(exitCode).toBe(1)
    expect(saved).toEqual([])
    for (const id of ['hold-01', 'hold-02', 'hold-03']) expect(logs.join('\n'), id).toContain(id)
  })

  it('stops at the spend cap, saves nothing and exits 1: the first two calls fit under it, the third would pass it', async () => {
    // Each call is 1000 micros; the cap is 2500, so the third would make 3000.
    const { run, labeller, ledger, logs, saved, sheets } = setup({ capMicros: 2500 })

    const { exitCode } = await run()

    expect(exitCode).toBe(1)
    expect(labeller.calls).toHaveLength(3)
    expect(ledger.spentMicros()).toBe(2000)
    expect(saved).toEqual([])
    expect(sheets).toEqual([])
    expect(logs.some((l) => /cap/i.test(l))).toBe(true)
  })

  it('does not ask for the cases after the cap stopped the run', async () => {
    // A cap of 1500: the second call would make 2000, so it is refused and the third is never asked.
    const { run, labeller } = setup({ capMicros: 1500 })

    await run()

    expect(labeller.calls).toHaveLength(2)
  })

  it('stops at once and exits 2 when Claude rejects the key, saving nothing', async () => {
    const { run, labeller, logs, saved, sheets } = setup({
      answer: () => {
        throw new AnthropicConfigError(ERROR_SENTINEL)
      },
    })

    const { exitCode } = await run()

    expect(exitCode).toBe(2)
    expect(labeller.calls).toHaveLength(1)
    expect(saved).toEqual([])
    expect(sheets).toEqual([])
    expect(logs.join('\n')).not.toContain(ERROR_SENTINEL)
  })

  it('exits 2 with the rejection, not 1, when a case failed first and the key was rejected after', async () => {
    const { run } = setup({
      answer: (call) => {
        if (call === 1) throw new AnthropicRequestError(ERROR_SENTINEL)
        if (call === 2) throw new AnthropicConfigError(ERROR_SENTINEL)
        return undefined
      },
    })

    expect((await run()).exitCode).toBe(2)
  })
})

describe('runAutoLabel: a label set is never overwritten', () => {
  it('asks for nothing, spends nothing and exits 2 when the label set for the version exists already', async () => {
    const { run, labeller, ledger, logs, saved } = setup({ existing: [labelSetPath('v3')] })

    const { exitCode } = await run()

    expect(exitCode).toBe(2)
    expect(labeller.calls).toEqual([])
    expect(ledger.spentMicros()).toBe(0)
    expect(saved).toEqual([])
    expect(logs.some((l) => l.includes('v3'))).toBe(true)
  })

  it('asks for nothing and exits 2 when the filled sheet exists already, so its hours of corrections are not lost', async () => {
    const { run, labeller, saved, sheets } = setup({ existing: [SHEET_PATH] })

    const { exitCode } = await run()

    expect(exitCode).toBe(2)
    expect(labeller.calls).toEqual([])
    expect(saved).toEqual([])
    expect(sheets).toEqual([])
  })

  it('checks the label set path and the sheet path, and nothing else', async () => {
    const { run, asked } = setup()

    await run()

    expect([...asked].sort()).toEqual([SHEET_PATH, labelSetPath('v3')].sort())
  })

  it('exits 2 and writes no sheet when saving the label set is refused because it exists by then', async () => {
    const { run, sheets, logs } = setup({
      save: () => {
        throw new LabelSetError('eval-data/routine/labels/v3.json exists already. A label set is never overwritten: pick a new version.')
      },
    })

    const { exitCode } = await run()

    expect(exitCode).toBe(2)
    expect(sheets).toEqual([])
    expect(logs.some((l) => /exists already/.test(l))).toBe(true)
  })
})

describe('runAutoLabel: the console', () => {
  it('prints each case id with its gap count and cost, the spend against the cap, and nothing the model chose', async () => {
    const { run, logs } = setup({ answer: () => ({ cleanse: { candidates: ['C-A', 'C-B', 'C-C'], best: 'C-B', acceptable: ['C-C'] } }) })

    await run()

    for (const id of ['hold-01', 'hold-02', 'hold-03']) {
      const lines = logs.filter((l) => l.startsWith(id))
      expect(lines, id).toHaveLength(1)
      // Two gaps are labelled for each case: cleanse (by the model) and moisturise (the only candidate).
      expect(lines[0], id).toContain('2')
      expect(lines[0], id).toContain(usd(MICROS_PER_CALL))
    }
    expect(logs.join('\n')).toContain(usd(3 * MICROS_PER_CALL))
    expect(logs.join('\n')).toContain(usd(BIG_CAP_MICROS))
  })

  it('never prints a code the model chose, an error message, or any other text of the model\'s', async () => {
    const { run, logs } = setup({
      answer: (call) => {
        if (call === 2) throw new AnthropicRequestError(ERROR_SENTINEL)
        return { cleanse: { candidates: ['C-A', 'C-B', 'C-C'], best: 'C-B', acceptable: ['C-C'] } }
      },
    })

    await run()

    const printed = logs.join('\n')
    expect(printed).not.toContain(ERROR_SENTINEL)
    for (const code of ['C-A', 'C-B', 'C-C', 'M-1']) expect(printed, code).not.toContain(code)
  })

  it('says where the label set and the sheet were saved, when they were', async () => {
    const { run, logs } = setup()

    await run()

    expect(logs.join('\n')).toContain(labelSetPath('v3'))
    expect(logs.join('\n')).toContain(SHEET_PATH)
  })

  it('says nothing was saved when the run failed', async () => {
    const { run, logs } = setup({
      answer: () => {
        throw new FakeLabellerError(ERROR_SENTINEL)
      },
    })

    await run()

    expect(logs.join('\n')).not.toContain(labelSetPath('v3'))
    expect(logs.some((l) => /nothing (was )?saved/i.test(l))).toBe(true)
  })
})
