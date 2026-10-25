import { describe, expect, it } from 'vitest'
import type { RoutineStep } from '../../src/modules/catalog/catalog.vocabulary'
import type { Routine, RoutineSkeleton } from '../../src/modules/routines/routines.types'
import { routineJudgeJudgeRoutinePrompt } from '../../src/prompts/prompts.generated'
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
import type { GapLabel } from './routine-labels'
import { AnthropicRoutineJudge, classOfPick, judgeOnce, judgeResultOf, PROBLEM_CODES, type RoutineJudge, type RoutineJudgeInput, type RoutineJudgement } from './routine-judge'
import { candidate, routineOf, skeletonOf } from './routine.fixture'

// The rubric judge of `npm run eval:routine`: one Claude call per routine that has been written. It is shown the person, the shelf with its verdicts, each gap's
// candidates and the routine, and NEVER the labels. It answers with its own class for the product the routine picked in each gap (best, acceptable or not),
// three 1 to 5 scores (fit, simplicity, words) and problem CODES from a fixed list, never free text. It goes through client.structured like the routine writer, so a
// reply it cannot give is a throw (the run decides what a thrown error means), and a reply that does not fit the schema never becomes a partial judgement.
//
// The second half is the pure agreement: the judge's class for a pick against the label's class for it (a pick that is not a candidate is "not").

const JUDGE_JOB = 'judge-routine' as AiJob
const ROUTED_TO = 'claude-haiku-5-5'
const CANDIDATE_NAME = 'zzqx-unique-candidate-name'
const REASON = 'SENTINEL-REASON-TEXT'

const SKELETON: RoutineSkeleton = skeletonOf(
  [
    { step: 'cleanse', candidates: [candidate('C-A', { name: CANDIDATE_NAME }), candidate('C-B')] },
    { step: 'moisturise', candidates: [candidate('M-1')] },
  ],
  { goal: 'even-tone', person: { seen: [{ concern: 'hd_age_spot', level: 'some' }], alsoNoticed: [], skinType: 'combination', lowConfidence: [], cautions: ['tapering'], budgetBand: null } },
)
const ROUTINE: Routine = (() => {
  const routine = routineOf({ cleanse: 'C-A', moisturise: 'M-1' })
  routine.steps[0]!.reason = REASON
  return routine
})()

const JUDGEMENT: RoutineJudgement = {
  picks: [
    { step: 'cleanse', pickClass: 'best' },
    { step: 'moisturise', pickClass: 'acceptable' },
  ],
  fit: 4,
  simplicity: 5,
  words: 3,
  problems: ['vague-reason', 'unexplained-term'],
}

const judgeWith = (fetch: typeof globalThis.fetch, ledger = new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS }), models: Record<AiJob, string> = { ...MODELS, [JUDGE_JOB]: MODEL } as Record<AiJob, string>) =>
  new AnthropicRoutineJudge(new AnthropicClient({ apiKey: API_KEY, models, ledger, baseURL: 'https://anthropic.example', fetch }))

/** A judge whose model answers `answer` (any value, so a test can break it); `calls` records the requests. */
const judgeAnswering = (answer: unknown = JUDGEMENT) => {
  const stub = stubFetch(() => messageResponse({ content: [textBlock(JSON.stringify(answer))] }))
  return { ...stub, judge: judgeWith(stub.fetch) }
}
const judgeOver = (...responders: Parameters<typeof stubFetch>) => {
  const { calls, fetch } = stubFetch(...responders)
  return { calls, judge: judgeWith(fetch) }
}
const input = { skeleton: SKELETON, routine: ROUTINE }

/** The JSON object in the one user message: everything from its first brace. */
const sentInput = (body: any): unknown => {
  expect(body.messages).toHaveLength(1)
  expect(body.messages[0].role).toBe('user')
  const raw = body.messages[0].content
  const text: string = typeof raw === 'string' ? raw : raw.map((block: any) => block.text).join('')
  return JSON.parse(text.slice(text.indexOf('{')))
}

describe('AnthropicRoutineJudge: the request', () => {
  it('sends the judge-routine prompt as the system prompt, with no tools: it judges what it is shown and fetches nothing', async () => {
    const { calls, judge } = judgeAnswering()

    await judge.judge(input)

    expect(JSON.stringify(calls[0]!.body.system)).toContain(JSON.stringify(routineJudgeJudgeRoutinePrompt.text).slice(1, -1))
    expect('tools' in calls[0]!.body).toBe(false)
    expect('tool_choice' in calls[0]!.body).toBe(false)
  })

  it('sends the skeleton and the routine, as they are, in one user message', async () => {
    const { calls, judge } = judgeAnswering()

    await judge.judge(input)

    expect(sentInput(calls[0]!.body)).toEqual({ skeleton: SKELETON, routine: ROUTINE })
  })

  // The adapter's signature has no labels at all, so the proof is structural: nothing but the skeleton and the routine is in what is sent. (A search for the
  // words "best" or "acceptable" would prove nothing: the prompt's own pickClass vocabulary has them.)
  it('sends nothing but the skeleton and the routine, so no label can reach the judge', async () => {
    const { calls, judge } = judgeAnswering()

    await judge.judge(input)

    expect(Object.keys(sentInput(calls[0]!.body) as object).sort()).toEqual(['routine', 'skeleton'])
  })

  it('tells the judge the person, the candidates and the words the routine uses', async () => {
    const { calls, judge } = judgeAnswering()

    await judge.judge(input)

    const sent = requestText(calls[0]!.body)
    for (const part of [CANDIDATE_NAME, 'tapering', 'even-tone', 'hd_age_spot', REASON]) expect(sent, part).toContain(part)
  })

  it('keeps the routine out of the system prompt, so the instructions do not carry the data', async () => {
    const { calls, judge } = judgeAnswering()

    await judge.judge(input)

    expect(JSON.stringify(calls[0]!.body.system)).not.toContain(REASON)
    expect(JSON.stringify(calls[0]!.body.system)).not.toContain(CANDIDATE_NAME)
  })

  it('leaves room for the answer and for the model\'s thinking: max_tokens of at least 12000, as the judge thinks through every candidate before it classes a pick', async () => {
    const { calls, judge } = judgeAnswering()

    await judge.judge(input)

    expect(calls[0]!.body.max_tokens).toBeGreaterThanOrEqual(12000)
  })

  it('asks for a json_schema structured output with exactly the five fields of a judgement, all required, and no oneOf', async () => {
    const { calls, judge } = judgeAnswering()

    await judge.judge(input)

    const format = calls[0]!.body.output_config.format
    expect(format.type).toBe('json_schema')
    expect(Object.keys(format.schema.properties).sort()).toEqual(['fit', 'picks', 'problems', 'simplicity', 'words'])
    expect([...format.schema.required].sort()).toEqual(['fit', 'picks', 'problems', 'simplicity', 'words'])
    expect(format.schema.additionalProperties).toBe(false)
    expect(JSON.stringify(format.schema)).not.toContain('"oneOf"')
  })

  it('puts the fixed problem codes and the three classes in the schema, so the API holds the model to them', async () => {
    const { calls, judge } = judgeAnswering()

    await judge.judge(input)

    const sent = JSON.stringify(calls[0]!.body.output_config.format.schema)
    for (const code of PROBLEM_CODES) expect(sent, code).toContain(`"${code}"`)
    for (const pickClass of ['best', 'acceptable', 'not']) expect(sent, pickClass).toContain(`"${pickClass}"`)
  })

  it('makes exactly one request per routine', async () => {
    const { calls, judge } = judgeAnswering()

    await judge.judge(input)

    expect(calls).toHaveLength(1)
  })
})

describe('PROBLEM_CODES: the fixed vocabulary of what the judge may say is wrong', () => {
  it('has the codes the brief names, each a plain lower-case word chain and never a sentence', () => {
    for (const code of ['ignored-caution', 'leaned-on-low-confidence', 'also-noticed-justified-product', 'poor-fit', 'too-many-actives', 'harsh-during-taper', 'vague-reason', 'overstated-claim', 'timing-dishonest', 'unexplained-term']) {
      expect(PROBLEM_CODES as readonly string[], code).toContain(code)
    }
    for (const code of PROBLEM_CODES) expect(code).toMatch(/^[a-z]+(-[a-z]+)*$/)
  })
})

describe('AnthropicRoutineJudge: the judgement', () => {
  it('returns the judgement the model gave: its class for each gap\'s pick, the three scores and the problem codes', async () => {
    const { judge } = judgeAnswering(JUDGEMENT)

    await expect(judge.judge(input)).resolves.toStrictEqual(JUDGEMENT)
  })

  it('accepts a judgement with no problems and one with no picks (a routine with no gap that had candidates)', async () => {
    await expect(judgeAnswering({ ...JUDGEMENT, problems: [] }).judge.judge(input)).resolves.toMatchObject({ problems: [] })
    await expect(judgeAnswering({ ...JUDGEMENT, picks: [] }).judge.judge(input)).resolves.toMatchObject({ picks: [] })
  })

  it('keeps only the judgement\'s own fields: any other text the model wrote goes no further', async () => {
    const judgement = await judgeAnswering({ ...JUDGEMENT, notes: 'SENTINEL-NOTES' }).judge.judge(input)

    expect(Object.keys(judgement).sort()).toEqual(['fit', 'picks', 'problems', 'simplicity', 'words'])
    expect(JSON.stringify(judgement)).not.toContain('SENTINEL')
  })

  // The scores are whole numbers from 1 to 5: both ends are in, one past either end is out.
  it.each(['fit', 'simplicity', 'words'] as const)('takes %s at 1 and at 5', async (field) => {
    await expect(judgeAnswering({ ...JUDGEMENT, [field]: 1 }).judge.judge(input)).resolves.toMatchObject({ [field]: 1 })
    await expect(judgeAnswering({ ...JUDGEMENT, [field]: 5 }).judge.judge(input)).resolves.toMatchObject({ [field]: 5 })
  })

  it.each(['fit', 'simplicity', 'words'] as const)('refuses %s at 0, at 6, at 3.5 and as a word', async (field) => {
    for (const value of [0, 6, 3.5, '4', null]) {
      expect(await caught(judgeAnswering({ ...JUDGEMENT, [field]: value }).judge.judge(input)), `${field} = ${String(value)}`).toBeInstanceOf(AnthropicRequestError)
    }
  })

  it.each([
    ['a problem that is a sentence, not a code', { problems: ['The reason is vague and the claim is too strong.'] }],
    ['a problem code outside the vocabulary', { problems: ['bad-vibes'] }],
    ['problems that are one string', { problems: 'vague-reason' }],
    ['a pick class outside best, acceptable and not', { picks: [{ step: 'cleanse', pickClass: 'maybe' }] }],
    ['a pick for a step outside the four', { picks: [{ step: 'exfoliate', pickClass: 'best' }] }],
    ['a pick with no class', { picks: [{ step: 'cleanse' }] }],
  ])('throws AnthropicRequestError for %s: a judgement is never partial', async (_label, change) => {
    const { judge } = judgeAnswering({ ...JUDGEMENT, ...change })

    expect(await caught(judge.judge(input))).toBeInstanceOf(AnthropicRequestError)
  })

  it.each(['fit', 'picks', 'problems'] as const)('throws AnthropicRequestError when the reply has no %s', async (field) => {
    const { [field]: _left, ...rest } = JUDGEMENT

    expect(await caught(judgeAnswering(rest).judge.judge(input))).toBeInstanceOf(AnthropicRequestError)
  })
})

describe('AnthropicRoutineJudge: job routing, cost and errors', () => {
  it('asks Claude as the judge-routine job and uses the model configured for it', async () => {
    const { calls, fetch } = stubFetch(() => messageResponse({ content: [textBlock(JSON.stringify(JUDGEMENT))] }))

    await judgeWith(fetch, undefined, { ...MODELS, [JUDGE_JOB]: ROUTED_TO } as Record<AiJob, string>).judge(input)

    expect(calls[0]!.body.model).toBe(ROUTED_TO)
  })

  it('does not use the model of any other job', async () => {
    const { calls, fetch } = stubFetch(() => messageResponse({ content: [textBlock(JSON.stringify(JUDGEMENT))] }))
    const others = (Object.keys(MODELS) as AiJob[]).filter((job) => job !== JUDGE_JOB)

    for (const other of others) await judgeWith(fetch, undefined, { ...MODELS, [JUDGE_JOB]: MODEL, [other]: ROUTED_TO } as Record<AiJob, string>).judge(input)

    expect(calls.map((c) => c.body.model)).toEqual(others.map(() => MODEL))
  })

  it('records its call on the ledger under the judge-routine job', async () => {
    const ledger = new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS })
    const { fetch } = stubFetch(() => messageResponse({ content: [textBlock(JSON.stringify(JUDGEMENT))] }))

    await judgeWith(fetch, ledger).judge(input)

    expect(ledger.entries.map((e) => [e.job, e.model, e.status])).toEqual([[JUDGE_JOB, MODEL, 'settled']])
  })

  it('throws AiBudgetExceededError, sending nothing, when the spend cap would be passed', async () => {
    const { calls, fetch } = stubFetch(() => messageResponse({ content: [textBlock(JSON.stringify(JUDGEMENT))] }))

    const error = await caught(judgeWith(fetch, new MemoryAiSpendLedger({ capMicros: 1 })).judge(input))

    expect(error).toBeInstanceOf(AiBudgetExceededError)
    expect(calls).toHaveLength(0)
  })

  it('throws AnthropicConfigError, sending nothing, for a model that has no price: a call that cannot be capped is not made', async () => {
    const { calls, fetch } = stubFetch(() => messageResponse({ content: [textBlock(JSON.stringify(JUDGEMENT))] }))

    const error = await caught(judgeWith(fetch, undefined, { ...MODELS, [JUDGE_JOB]: 'claude-unpriced-1' } as Record<AiJob, string>).judge(input))

    expect(error).toBeInstanceOf(AnthropicConfigError)
    expect(calls).toHaveLength(0)
  })

  it.each([
    ['the key or account being rejected (401)', () => errorResponse(401, 'authentication_error'), AnthropicConfigError],
    ['billing being refused (402)', () => errorResponse(402, 'billing_error'), AnthropicConfigError],
    ['a permission being refused (403)', () => errorResponse(403, 'permission_error'), AnthropicConfigError],
    ['Claude being overloaded (529)', () => errorResponse(529, 'overloaded_error'), AnthropicUnavailableError],
    ['Claude failing (500)', () => errorResponse(500, 'api_error'), AnthropicUnavailableError],
    ['a refusal', () => messageResponse({ content: [textBlock('I cannot help with that.')], stop_reason: 'refusal' }), AnthropicRefusalError],
    ['an answer cut off by max_tokens, even if the cut text happens to parse', () => messageResponse({ content: [textBlock(JSON.stringify(JUDGEMENT))], stop_reason: 'max_tokens' }), AnthropicRequestError],
    ['text that is not JSON', () => messageResponse({ content: [textBlock('The routine looks fine to me.')] }), AnthropicRequestError],
  ])('lets the vendor error through on %s, with no judgement', async (_label, respond, expected) => {
    const { judge } = judgeOver(respond)

    expect(await caught(judge.judge(input))).toBeInstanceOf(expected)
  })
})

// --- agreement: the judge's class for a pick against the label's class for it -------------------------------------------------------------------

const LABEL: GapLabel = { candidates: ['C-A', 'C-B', 'C-C'], best: 'C-A', acceptable: ['C-B'] }

describe('classOfPick: the class the labels give a routine\'s pick', () => {
  it.each([
    ['the labelled best', { kind: 'candidate', code: 'C-A' }, 'best'],
    ['an acceptable candidate', { kind: 'candidate', code: 'C-B' }, 'acceptable'],
    ['a candidate that is neither', { kind: 'candidate', code: 'C-C' }, 'not'],
    ['a code that is not a candidate of the gap', { kind: 'candidate', code: 'ZZ-9' }, 'not'],
    ['a shelf product', { kind: 'shelf', id: 'cleanser-1' }, 'not'],
    ['"use what you have"', { kind: 'none' }, 'not'],
  ] as const)('says %s is %s', (_label, product, expected) => {
    expect(classOfPick(LABEL, product)).toBe(expected)
  })
})

describe('judgeResultOf: agreement over the scored gaps', () => {
  // Cleanse (3 candidates), treat (2), moisturise (1: nothing to compare) and protect (2). The labels:
  const LABELS: Partial<Record<RoutineStep, GapLabel>> = {
    cleanse: LABEL,
    treat: { candidates: ['T-1', 'T-2'], best: 'T-1', acceptable: [] },
    moisturise: { candidates: ['M-1'], best: 'M-1', acceptable: [] },
    protect: { candidates: ['P-1', 'P-2'], best: 'P-2', acceptable: ['P-1'] },
  }
  const GAP_CODES = { cleanse: ['C-A', 'C-B', 'C-C'], treat: ['T-1', 'T-2'], moisturise: ['M-1'], protect: ['P-1', 'P-2'] }
  // The routine picks C-B (labelled acceptable), T-2 (labelled not), M-1 and P-1 (labelled acceptable).
  const PICKS = routineOf({ cleanse: 'C-B', treat: 'T-2', moisturise: 'M-1', protect: 'P-1' })
  const judgement = (picks: [RoutineStep, 'best' | 'acceptable' | 'not'][], over: Partial<RoutineJudgement> = {}): RoutineJudgement => ({
    picks: picks.map(([step, pickClass]) => ({ step, pickClass })),
    fit: 4,
    simplicity: 5,
    words: 3,
    problems: [],
    ...over,
  })

  it('counts a gap as agreed, and agreed exactly, when the judge\'s class is the label\'s class, and takes the three scores as the judge gave them', () => {
    // Scored gaps: cleanse, treat, protect (moisturise has one candidate). Cleanse: label acceptable, judge acceptable, agreed. Treat: label not, judge acceptable, not
    // agreed. Protect: label acceptable, judge acceptable, agreed. So 2 of 3. The judge's class for moisturise is not looked at.
    const result = judgeResultOf(judgement([['cleanse', 'acceptable'], ['treat', 'acceptable'], ['moisturise', 'best'], ['protect', 'acceptable']]), { routine: PICKS, gapCodes: GAP_CODES, labels: LABELS })

    expect(result).toEqual({ picksAgreed: 2, picksAgreedExactly: 2, picksJudged: 3, fit: 4, simplicity: 5, words: 3 })
  })

  // One scored gap (cleanse: C-A best, C-B acceptable, C-C neither) at a time, so each row is one label class set against one judge class.
  // Changed in #152 follow-up: agreement is right-vs-not (best and acceptable are on one side, not on the other); the exact match is counted beside it.
  it.each([
    ['label best, judge acceptable: agreed, not exactly', 'C-A', 'acceptable', 1, 0],
    ['label acceptable, judge best: agreed, not exactly', 'C-B', 'best', 1, 0],
    ['label best, judge best: agreed and exactly', 'C-A', 'best', 1, 1],
    ['label acceptable, judge acceptable: agreed and exactly', 'C-B', 'acceptable', 1, 1],
    ['label not, judge not: agreed and exactly', 'C-C', 'not', 1, 1],
    ['label not, judge acceptable: neither', 'C-C', 'acceptable', 0, 0],
    ['label not, judge best: neither', 'C-C', 'best', 0, 0],
    ['label acceptable, judge not: neither', 'C-B', 'not', 0, 0],
    ['label best, judge not: neither', 'C-A', 'not', 0, 0],
  ] as const)('counts %s (best and acceptable are one side, not is the other)', (_label, code, judged, agreed, agreedExactly) => {
    const result = judgeResultOf(judgement([['cleanse', judged]]), { routine: routineOf({ cleanse: code }), gapCodes: { cleanse: LABEL.candidates }, labels: { cleanse: LABEL } })

    expect(result).toMatchObject({ picksAgreed: agreed, picksAgreedExactly: agreedExactly, picksJudged: 1 })
  })

  it('counts each scored gap on its own: best against acceptable and acceptable against best agree, and acceptable against not does not (1 of 3 exactly 0)', () => {
    // Picks: cleanse C-B (label acceptable) judged best; treat T-2 (label not) judged acceptable; protect P-1 (label acceptable) judged not. Only cleanse is on the same side.
    const result = judgeResultOf(judgement([['cleanse', 'best'], ['treat', 'acceptable'], ['protect', 'not']]), { routine: PICKS, gapCodes: GAP_CODES, labels: LABELS })

    expect(result).toMatchObject({ picksAgreed: 1, picksAgreedExactly: 0, picksJudged: 3 })
  })

  it('agrees when both say "not": a pick the labels reject and the judge rejects too', () => {
    const result = judgeResultOf(judgement([['treat', 'not']]), { routine: routineOf({ treat: 'T-2' }), gapCodes: { treat: ['T-1', 'T-2'] }, labels: { treat: LABELS.treat! } })

    expect(result).toMatchObject({ picksAgreed: 1, picksAgreedExactly: 1, picksJudged: 1 })
  })

  it('counts a pick that is not a candidate as "not": agreed when the judge says not, a disagreement when it says anything else', () => {
    const routine = routineOf({ cleanse: 'ZZ-9' })
    const base = { routine, gapCodes: { cleanse: ['C-A', 'C-B', 'C-C'] }, labels: { cleanse: LABEL } }

    expect(judgeResultOf(judgement([['cleanse', 'not']]), base)).toMatchObject({ picksAgreed: 1, picksAgreedExactly: 1, picksJudged: 1 })
    expect(judgeResultOf(judgement([['cleanse', 'best']]), base)).toMatchObject({ picksAgreed: 0, picksAgreedExactly: 0, picksJudged: 1 })
    expect(judgeResultOf(judgement([['cleanse', 'acceptable']]), base)).toMatchObject({ picksAgreed: 0, picksAgreedExactly: 0, picksJudged: 1 })
  })

  it('counts a scored gap the judge gave no class for as judged and not agreed: skipping a gap cannot raise the agreement', () => {
    const result = judgeResultOf(judgement([['cleanse', 'acceptable']]), { routine: PICKS, gapCodes: GAP_CODES, labels: LABELS })

    expect(result).toMatchObject({ picksAgreed: 1, picksAgreedExactly: 1, picksJudged: 3 })
  })

  it('judges no picks, but still passes the scores on, when the case has no labels', () => {
    const result = judgeResultOf(judgement([['cleanse', 'acceptable']]), { routine: PICKS, gapCodes: GAP_CODES, labels: null })

    expect(result).toEqual({ picksAgreed: 0, picksAgreedExactly: 0, picksJudged: 0, fit: 4, simplicity: 5, words: 3 })
  })

  it('judges no picks when the labels were made on other candidates than this skeleton has: those gaps are not scored', () => {
    const stale = { ...LABELS, cleanse: { candidates: ['C-A', 'C-B'], best: 'C-A', acceptable: ['C-B'] } }

    const result = judgeResultOf(judgement([['cleanse', 'acceptable'], ['treat', 'not'], ['protect', 'acceptable']]), { routine: PICKS, gapCodes: GAP_CODES, labels: stale })

    expect(result).toMatchObject({ picksAgreed: 0, picksAgreedExactly: 0, picksJudged: 0 })
  })
})

// judgeOnce: the one retry of the rubric judge. Haiku sometimes gives one invalid answer (AnthropicRequestError: off-schema JSON, not JSON, or out of tokens) on a case,
// and a case with a routine but no judgement blocks the bar, so a RequestError is tried once more with the same input. Nothing else is retried: a cap, a rejected key,
// an unavailable model and a refusal each mean something to the run, and the retry's own error (of any class) is thrown as it is.
describe('judgeOnce: a rubric judge answer that is invalid is retried once', () => {
  /** A judge that does what `steps` say on its first call, second call and so on (an Error is thrown, a judgement is returned), and records every input. */
  const scripted = (...steps: (RoutineJudgement | Error)[]) => {
    const calls: RoutineJudgeInput[] = []
    const judge: RoutineJudge = {
      judge: async (given) => {
        calls.push(given)
        const step = steps[calls.length - 1]
        if (step === undefined) throw new Error('called more often than the test scripted')
        if (step instanceof Error) throw step
        return step
      },
    }
    return { judge, calls }
  }
  const SECOND: RoutineJudgement = { ...JUDGEMENT, fit: 2 }

  it('asks again after an AnthropicRequestError and returns the second answer, marked retried, with the same input both times', async () => {
    const { judge, calls } = scripted(new AnthropicRequestError('SENTINEL-FIRST'), SECOND)

    const result = await judgeOnce(judge, input)

    expect(result).toEqual({ judgement: SECOND, retried: true })
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual(input)
    expect(calls[1]).toEqual(input)
  })

  it('throws the second AnthropicRequestError as it is, after exactly two calls, when the retry fails too', async () => {
    const second = new AnthropicRequestError('SENTINEL-SECOND')
    const { judge, calls } = scripted(new AnthropicRequestError('SENTINEL-FIRST'), second)

    await expect(judgeOnce(judge, input)).rejects.toBe(second)

    expect(calls).toHaveLength(2)
  })

  it('throws whatever error the retry fails with, of any class, as it is', async () => {
    const second = new AnthropicRefusalError('SENTINEL-SECOND')
    const { judge, calls } = scripted(new AnthropicRequestError('SENTINEL-FIRST'), second)

    await expect(judgeOnce(judge, input)).rejects.toBe(second)

    expect(calls).toHaveLength(2)
  })

  it('makes one call and says it did not retry when the first answer is valid', async () => {
    const { judge, calls } = scripted(JUDGEMENT)

    const result = await judgeOnce(judge, input)

    expect(result).toEqual({ judgement: JUDGEMENT, retried: false })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(input)
  })

  it.each([
    ['AiBudgetExceededError', new AiBudgetExceededError('cap')],
    ['AnthropicConfigError', new AnthropicConfigError('key')],
    ['AnthropicUnavailableError', new AnthropicUnavailableError('down')],
    ['AnthropicRefusalError', new AnthropicRefusalError('declined')],
    ['a plain Error', new Error('anything')],
  ])('never retries %s: it is thrown as it is after one call', async (_name, error) => {
    const { judge, calls } = scripted(error, JUDGEMENT)

    await expect(judgeOnce(judge, input)).rejects.toBe(error)

    expect(calls).toHaveLength(1)
  })
})
