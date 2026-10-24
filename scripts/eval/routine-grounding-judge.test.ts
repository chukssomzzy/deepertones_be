import { describe, expect, it } from 'vitest'
import { routineGroundingJudgeJudgeGroundingPrompt } from '../../src/prompts/prompts.generated'
import { AiBudgetExceededError, type AiJob } from '../../src/providers/anthropic/ai-spend.provider'
import { AnthropicClient } from '../../src/providers/anthropic/anthropic.client'
import { AnthropicConfigError } from '../../src/providers/anthropic/anthropic.provider'
import { MemoryAiSpendLedger } from '../../src/providers/anthropic/memory.ai-spend-ledger'
import {
  API_KEY,
  BIG_CAP_MICROS,
  type Block,
  caught,
  errorResponse,
  fetchCall,
  fetchedPage,
  fetchError,
  MODEL,
  MODELS,
  messageResponse,
  requestText,
  stubFetch,
  textBlock,
} from '../../src/providers/anthropic/messages-api.fake'
import { AnthropicGroundingJudge, type GroundingRequest, unverifiableGrounding } from './routine-grounding-judge'

// The page-support judge of `npm run eval:routine`: for ONE grounding link of ONE routine entry, one Claude call that may fetch that page (and only that page)
// and says whether it supports the entry's reason. It mirrors the catalog eval's AnthropicDraftJudge: the web fetch tool restricted to the cited host, at most
// 2 fetches, 20,000 tokens a page; `fetched` is true only for a successful fetch of exactly the cited address; every failure is an "unverifiable" verdict with a
// fixed reason and never an error, except what ends the run (the spend cap, a rejected key or account), which is thrown. Its score is reported but is not in the bar.

const JUDGE_JOB = 'judge-grounding' as AiJob
const ROUTED_TO = 'claude-haiku-5-5'
const PAGE = 'https://www.shop.example/p/gentle-cleanser?ref=SENTINEL-URL-QUERY'

const REQUEST: GroundingRequest = { step: 'cleanse', reason: 'Glycerin (a water-holding ingredient) keeps skin soft while the retinol is tapered.', sourceUrl: PAGE }

const ANSWER = { fetched: true, supports: 'yes' }
const fetchedAndSaid = (final: unknown): Block[] => [textBlock('Let me read it.'), fetchCall('srvtoolu_01', PAGE), fetchedPage('srvtoolu_01', PAGE), textBlock(typeof final === 'string' ? final : JSON.stringify(final))]
const respondWith = (content: Block[], stop_reason = 'end_turn') => () => messageResponse({ content, stop_reason })

const judgeWith = (fetch: typeof globalThis.fetch, ledger = new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS }), models: Record<AiJob, string> = { ...MODELS, [JUDGE_JOB]: MODEL } as Record<AiJob, string>) =>
  new AnthropicGroundingJudge(new AnthropicClient({ apiKey: API_KEY, models, ledger, baseURL: 'https://anthropic.example', fetch }))
const judgeOver = (...responders: Parameters<typeof stubFetch>) => {
  const { calls, fetch } = stubFetch(...responders)
  return { calls, judge: judgeWith(fetch) }
}
const judged = (content: Block[], request: GroundingRequest = REQUEST) => judgeOver(respondWith(content)).judge.judge(request)
const fetchTool = (calls: { body: any }[]) => (calls[0]!.body.tools as Record<string, unknown>[]).find((tool) => tool.name === 'web_fetch')!

/** What a verdict that vouches for nothing looks like, with the fixed reason it gives. */
const nothingVouched = (reason: string) => ({ fetched: false, supports: 'unclear', reason })

describe('AnthropicGroundingJudge: the request', () => {
  it('gives Claude the web fetch tool and nothing else, and lets it fetch at most twice', async () => {
    const { calls, judge } = judgeOver(respondWith(fetchedAndSaid(ANSWER)))

    await judge.judge(REQUEST)

    expect(calls).toHaveLength(1)
    const names = (calls[0]!.body.tools as Record<string, unknown>[]).map((tool) => tool.name)
    expect(names).toEqual(['web_fetch'])
    expect(fetchTool(calls).type).toMatch(/^web_fetch_\d{8}$/)
    expect(fetchTool(calls).max_uses).toBeGreaterThanOrEqual(1)
    expect(fetchTool(calls).max_uses).toBeLessThanOrEqual(2)
  })

  it('bounds one fetch to 20,000 tokens of page, since a fetched page is billed as input tokens', async () => {
    const { calls, judge } = judgeOver(respondWith(fetchedAndSaid(ANSWER)))

    await judge.judge(REQUEST)

    expect(fetchTool(calls).max_content_tokens).toBe(20_000)
  })

  it('restricts the web fetch tool to the host of the cited page, so it cannot read another site', async () => {
    const { calls, judge } = judgeOver(respondWith(fetchedAndSaid(ANSWER)))

    await judge.judge(REQUEST)

    expect(fetchTool(calls).allowed_domains).toEqual(['www.shop.example'])
    expect(fetchTool(calls)).not.toHaveProperty('blocked_domains')
  })

  it('lets only Claude call the web fetch tool directly, so a fetch result always comes back as a block of the reply', async () => {
    const { calls, judge } = judgeOver(respondWith(fetchedAndSaid(ANSWER)))

    await judge.judge(REQUEST)

    expect(fetchTool(calls).allowed_callers).toEqual(['direct'])
  })

  it('tells Claude the step, the reason it must check and the page, with the address as it was cited', async () => {
    const { calls, judge } = judgeOver(respondWith(fetchedAndSaid(ANSWER)))

    await judge.judge(REQUEST)

    const sent = requestText(calls[0]!.body)
    for (const part of ['cleanse', REQUEST.reason, PAGE]) expect(sent, part).toContain(part)
  })

  it('asks for no call, and says not fetched, when the cited address cannot be read as a web address', async () => {
    const { calls, judge } = judgeOver(respondWith(fetchedAndSaid(ANSWER)))

    const verdict = await judge.judge({ ...REQUEST, sourceUrl: 'not a web address' })

    expect(calls).toHaveLength(0)
    expect(verdict).toEqual(nothingVouched('not-fetched'))
  })

  it('sends the judge-grounding prompt as the system prompt', async () => {
    const { calls, judge } = judgeOver(respondWith(fetchedAndSaid(ANSWER)))

    await judge.judge(REQUEST)

    expect(JSON.stringify(calls[0]!.body.system)).toContain(JSON.stringify(routineGroundingJudgeJudgeGroundingPrompt.text).slice(1, -1))
  })

  it('asks as the judge-grounding job, uses the model configured for it and no other job\'s, and records the call under that job', async () => {
    const { calls, fetch } = stubFetch(respondWith(fetchedAndSaid(ANSWER)))
    const ledger = new MemoryAiSpendLedger({ capMicros: BIG_CAP_MICROS })

    await judgeWith(fetch, ledger, { ...MODELS, [JUDGE_JOB]: ROUTED_TO } as Record<AiJob, string>).judge(REQUEST)
    const others = (Object.keys(MODELS) as AiJob[]).filter((job) => job !== JUDGE_JOB)
    for (const other of others) await judgeWith(fetch, undefined, { ...MODELS, [JUDGE_JOB]: MODEL, [other]: ROUTED_TO } as Record<AiJob, string>).judge(REQUEST)

    expect(calls[0]!.body.model).toBe(ROUTED_TO)
    expect(calls.slice(1).map((c) => c.body.model)).toEqual(others.map(() => MODEL))
    expect(ledger.entries.map((e) => [e.job, e.status])).toEqual([[JUDGE_JOB, 'settled']])
  })
})

describe('AnthropicGroundingJudge: the verdict', () => {
  it.each(['yes', 'no', 'unclear'])('reads supports "%s" after the cited page was fetched', async (supports) => {
    expect(await judged(fetchedAndSaid({ fetched: true, supports }))).toStrictEqual({ fetched: true, supports })
  })

  it('reads the verdict from the last JSON object of a reply that has chatter before it', async () => {
    const verdict = await judged(fetchedAndSaid(`The page lists "{braces}" and more.\n${JSON.stringify(ANSWER)}`))

    expect(verdict).toStrictEqual({ fetched: true, supports: 'yes' })
  })

  it('keeps only the verdict\'s own fields: page text or reasoning the model wrote goes no further', async () => {
    const verdict = await judged(fetchedAndSaid({ ...ANSWER, reasoning: 'SENTINEL-REASONING', quote: 'SENTINEL-PAGE-TEXT' }))

    expect(Object.keys(verdict).sort()).toEqual(['fetched', 'supports'])
    expect(JSON.stringify(verdict)).not.toContain('SENTINEL')
  })

  it('says not fetched when the judge claims it read the page but no fetch result came back: it is not taken at its word', async () => {
    expect(await judged([textBlock(JSON.stringify(ANSWER))])).toEqual(nothingVouched('not-fetched'))
  })

  it('says the fetch failed, whatever the judge then says about the page', async () => {
    expect(await judged([fetchCall('srvtoolu_01', PAGE), fetchError('srvtoolu_01', PAGE), textBlock(JSON.stringify(ANSWER))])).toEqual(nothingVouched('fetch-failed'))
  })

  it('says not fetched when the judge itself says it could not fetch the page, even though a fetch result is there', async () => {
    expect(await judged(fetchedAndSaid({ fetched: false, supports: 'yes' }))).toEqual(nothingVouched('not-fetched'))
  })

  // `fetched` is about the page that was cited. A different page says nothing about the entry's reason, whatever the judge then claims about it.
  it.each([
    ['another path on the same host', 'https://www.shop.example/p/foaming-cleanser'],
    ['another host', 'https://www.other.example/p/gentle-cleanser?ref=SENTINEL-URL-QUERY'],
    ['the same path with another query', 'https://www.shop.example/p/gentle-cleanser?ref=other'],
    ['the host alone, as a same-host redirect to the home page would give', 'https://www.shop.example/'],
  ])('says not fetched when the only page fetched is %s', async (_label, url) => {
    expect(await judged([fetchCall('a', url), fetchedPage('a', url), textBlock(JSON.stringify(ANSWER))])).toEqual(nothingVouched('not-fetched'))
  })

  it('judges when the cited page is among two fetched, the other one being another page', async () => {
    const other = 'https://www.shop.example/p/other'

    const verdict = await judged([fetchCall('a', other), fetchedPage('a', other), fetchCall('b', PAGE), fetchedPage('b', PAGE), textBlock(JSON.stringify(ANSWER))])

    expect(verdict).toStrictEqual({ fetched: true, supports: 'yes' })
  })

  it.each([
    ['a fragment', `${PAGE}#reviews`],
    ['an upper-case scheme and host', 'HTTPS://WWW.SHOP.EXAMPLE/p/gentle-cleanser?ref=SENTINEL-URL-QUERY'],
    ['a trailing slash', 'https://www.shop.example/p/gentle-cleanser/?ref=SENTINEL-URL-QUERY'],
    ['the default port', 'https://www.shop.example:443/p/gentle-cleanser?ref=SENTINEL-URL-QUERY'],
  ])('takes a fetched address that differs from the cited one only by %s as the cited page', async (_label, url) => {
    expect(await judged([fetchCall('a', url), fetchedPage('a', url), textBlock(JSON.stringify(ANSWER))])).toMatchObject({ fetched: true })
  })

  it('counts one good fetch among a failed one as fetched', async () => {
    const verdict = await judged([fetchCall('a', PAGE), fetchError('a', PAGE), fetchCall('b', PAGE), fetchedPage('b', PAGE), textBlock(JSON.stringify(ANSWER))])

    expect(verdict).toStrictEqual({ fetched: true, supports: 'yes' })
  })
})

describe('AnthropicGroundingJudge: what it cannot vouch for is "unverifiable", never an error', () => {
  it.each([
    ['text that is not JSON', 'I could not decide.'],
    ['an empty reply', ''],
    ['JSON that is cut off', '{"fetched": true, "supp'],
    ['JSON with a value outside yes, no and unclear', JSON.stringify({ ...ANSWER, supports: 'maybe' })],
    ['JSON without the supports field', JSON.stringify({ fetched: true })],
    ['JSON with fetched as a word', JSON.stringify({ ...ANSWER, fetched: 'yes' })],
  ])('gives an unverifiable verdict for %s', async (_label, final) => {
    expect(await judged(fetchedAndSaid(final))).toEqual(nothingVouched('unreadable-answer'))
  })

  it.each([
    ['refusal', 'refused'],
    ['max_tokens', 'cut-off'],
  ])('gives an unverifiable verdict when the reply stopped for %s, with the reason %s', async (stop, reason) => {
    expect(await judgeOver(respondWith(fetchedAndSaid(ANSWER), stop)).judge.judge(REQUEST)).toEqual(nothingVouched(reason))
  })

  it('builds an unverifiable verdict from a reason, which is how the run marks a link it never asked about', () => {
    expect(unverifiableGrounding('cut-off')).toEqual({ fetched: false, supports: 'unclear', reason: 'cut-off' })
  })

  it.each([
    ['the API being unavailable (503)', () => errorResponse(503, 'api_error')],
    ['the API throttling (429)', () => errorResponse(429, 'rate_limit_error')],
    ['the request being rejected (400)', () => errorResponse(400, 'invalid_request_error')],
  ])('gives an unverifiable verdict instead of throwing on %s', async (_label, respond) => {
    expect(await judgeOver(respond).judge.judge(REQUEST)).toEqual(nothingVouched('api-error'))
  })

  // A key, billing or permission that is wrong is not about this link: every later one would fail the same way, so the run has to stop and say so.
  it.each([
    ['the key or account being rejected (401)', () => errorResponse(401, 'authentication_error')],
    ['billing being refused (402)', () => errorResponse(402, 'billing_error')],
    ['a permission being refused (403)', () => errorResponse(403, 'permission_error')],
  ])('throws AnthropicConfigError on %s, so the run can stop and report', async (_label, respond) => {
    expect(await caught(judgeOver(respond).judge.judge(REQUEST))).toBeInstanceOf(AnthropicConfigError)
  })

  it('throws AnthropicConfigError, sending nothing, for a model that has no price', async () => {
    const { calls, fetch } = stubFetch(respondWith(fetchedAndSaid(ANSWER)))

    const error = await caught(judgeWith(fetch, undefined, { ...MODELS, [JUDGE_JOB]: 'claude-unpriced-1' } as Record<AiJob, string>).judge(REQUEST))

    expect(error).toBeInstanceOf(AnthropicConfigError)
    expect(calls).toHaveLength(0)
  })

  it('throws AiBudgetExceededError, sending nothing, when the spend cap would be passed', async () => {
    const { calls, fetch } = stubFetch(respondWith(fetchedAndSaid(ANSWER)))

    const error = await caught(judgeWith(fetch, new MemoryAiSpendLedger({ capMicros: 1 })).judge(REQUEST))

    expect(error).toBeInstanceOf(AiBudgetExceededError)
    expect(calls).toHaveLength(0)
  })
})
