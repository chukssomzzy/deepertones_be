import { describe, expect, it } from 'vitest'
import { costMicros, estimateInputTokens, estimateMicros, priceOf, SEARCH_INPUT_ALLOWANCE } from './anthropic.provider'

/*
 * Prices (USD per million tokens, so numerically micro-USD per token), from Anthropic's pricing page as fetched
 * 2026-10-15; web search is $10 per 1,000 searches = 10_000 micros each:
 *
 *   model              input   output  cache write (5m)  cache read
 *   claude-sonnet-5-5   2       10      2.5               0.10
 *   claude-haiku-5-5    0.10    0.50    0.125             0.01     (prompts up to 100k tokens)
 *                       0.50    2.50    0.625             0.05     (prompts over 100k tokens)
 *   claude-opus-5-5     4       20      5                 0.20
 *
 * Every expected value below is worked out by hand from that table (tokens x price, summed, rounded UP once per call),
 * never by calling the code under test. Usage is { inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, webSearches }.
 */

const usage = (over: Partial<Record<'inputTokens' | 'outputTokens' | 'cacheWriteTokens' | 'cacheReadTokens' | 'webSearches', number>> = {}) => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheWriteTokens: 0,
  cacheReadTokens: 0,
  webSearches: 0,
  ...over,
})

const SONNET = 'claude-sonnet-5-5'
const HAIKU = 'claude-haiku-5-5'
const OPUS = 'claude-opus-5-5'

describe('priceOf', () => {
  it.each([SONNET, HAIKU, OPUS])('knows the price of %s', (model) => {
    expect(priceOf(model)).toBeDefined()
  })

  it.each(['claude-test-model', 'gpt-5', '', 'claude-sonnet-5'])('has no price for the unknown model "%s"', (model) => {
    expect(priceOf(model)).toBeUndefined()
  })
})

describe('costMicros', () => {
  describe('Sonnet 5.5 ($2 in, $10 out, $2.50 cache write, $0.10 cache read)', () => {
    it('costs nothing for no usage', () => {
      expect(costMicros(SONNET, usage())).toBe(0)
    })

    it('prices input and output tokens: 1000 in and 500 out is 2000 + 5000 micros', () => {
      expect(costMicros(SONNET, usage({ inputTokens: 1000, outputTokens: 500 }))).toBe(7000)
    })

    it('prices every component: 20000 + 20000 + 10000 + 10000 + 2 searches at 10000', () => {
      const all = usage({ inputTokens: 10_000, outputTokens: 2_000, cacheWriteTokens: 4_000, cacheReadTokens: 100_000, webSearches: 2 })

      expect(costMicros(SONNET, all)).toBe(80_000)
    })

    it('adds 10000 micros ($0.01) for each web search, and nothing else when only searches ran', () => {
      expect(costMicros(SONNET, usage({ webSearches: 1 }))).toBe(10_000)
      expect(costMicros(SONNET, usage({ webSearches: 5 }))).toBe(50_000)
    })

    it('has one price whatever the prompt size: 200000 input tokens is 400000 micros, no tier', () => {
      expect(costMicros(SONNET, usage({ inputTokens: 200_000 }))).toBe(400_000)
    })

    it.each([
      ['1 cache-read token is 0.1 micro, rounded up to 1', { cacheReadTokens: 1 }, 1],
      ['10 cache-read tokens are exactly 1 micro', { cacheReadTokens: 10 }, 1],
      ['11 cache-read tokens are 1.1 micros, rounded up to 2', { cacheReadTokens: 11 }, 2],
      ['1 cache-write token is 2.5 micros, rounded up to 3', { cacheWriteTokens: 1 }, 3],
      ['2 cache-write tokens are exactly 5 micros', { cacheWriteTokens: 2 }, 5],
    ])('rounds up to a whole micro: %s', (_label, over, expected) => {
      expect(costMicros(SONNET, usage(over))).toBe(expected)
    })

    it('rounds up once per call, on the total, not per component', () => {
      // 1 cache-read token (0.1) + 1 cache-write token (2.5) = 2.6 micros -> 3, not 1 + 3 = 4.
      expect(costMicros(SONNET, usage({ cacheReadTokens: 1, cacheWriteTokens: 1 }))).toBe(3)
    })
  })

  describe('Haiku 5.5 (up to 100k prompt tokens: $0.10 / $0.50 / $0.125 / $0.01; over: $0.50 / $2.50 / $0.625 / $0.05)', () => {
    it('prices a small call at the low tier: 1000 in and 1000 out is 100 + 500 micros', () => {
      expect(costMicros(HAIKU, usage({ inputTokens: 1000, outputTokens: 1000 }))).toBe(600)
    })

    it('adds 30100 for 1000 input tokens and 3 searches: 100 + 3 x 10000', () => {
      expect(costMicros(HAIKU, usage({ inputTokens: 1000, webSearches: 3 }))).toBe(30_100)
    })

    describe('the tier switches when input + cache read + cache write tokens pass 100000', () => {
      it('keeps exactly 100000 input tokens at the low tier: 10000 micros', () => {
        expect(costMicros(HAIKU, usage({ inputTokens: 100_000 }))).toBe(10_000)
      })

      it('moves 100001 input tokens to the high tier: 50000.5 rounds up to 50001', () => {
        expect(costMicros(HAIKU, usage({ inputTokens: 100_001 }))).toBe(50_001)
      })

      it('counts cache-read tokens toward the tier: 60000 + 40000 = 100000 is low (6000 + 400)', () => {
        expect(costMicros(HAIKU, usage({ inputTokens: 60_000, cacheReadTokens: 40_000 }))).toBe(6_400)
      })

      it('counts cache-read tokens toward the tier: 60000 + 40001 is high (30000 + 2000.05 -> 32001)', () => {
        expect(costMicros(HAIKU, usage({ inputTokens: 60_000, cacheReadTokens: 40_001 }))).toBe(32_001)
      })

      it('counts cache-write tokens toward the tier: 100000 alone is low (12500)', () => {
        expect(costMicros(HAIKU, usage({ cacheWriteTokens: 100_000 }))).toBe(12_500)
      })

      it('counts cache-write tokens toward the tier: 1 + 100000 is high (0.5 + 62500 -> 62501)', () => {
        expect(costMicros(HAIKU, usage({ inputTokens: 1, cacheWriteTokens: 100_000 }))).toBe(62_501)
      })

      it('counts a single cache-write token past the line: 100000 input + 1 write is high (50000 + 0.625 -> 50001)', () => {
        expect(costMicros(HAIKU, usage({ inputTokens: 100_000, cacheWriteTokens: 1 }))).toBe(50_001)
      })

      it('prices cache reads at the tier: 100000 low is 1000, 100001 high is 5000.05 -> 5001', () => {
        expect(costMicros(HAIKU, usage({ cacheReadTokens: 100_000 }))).toBe(1_000)
        expect(costMicros(HAIKU, usage({ cacheReadTokens: 100_001 }))).toBe(5_001)
      })

      it('does not count output tokens toward the tier: 1000 in and 200000 out stays low (100 + 100000)', () => {
        expect(costMicros(HAIKU, usage({ inputTokens: 1000, outputTokens: 200_000 }))).toBe(100_100)
      })

      it('prices output at the high tier too once the prompt is over: 100001 in and 1000 out is 50000.5 + 2500 -> 52501', () => {
        expect(costMicros(HAIKU, usage({ inputTokens: 100_001, outputTokens: 1000 }))).toBe(52_501)
      })

      it('prices every component at the high tier: 25000 + 5000 + 18750 + 1500', () => {
        const all = usage({ inputTokens: 50_000, outputTokens: 2_000, cacheWriteTokens: 30_000, cacheReadTokens: 30_000 })

        expect(costMicros(HAIKU, all)).toBe(50_250)
      })
    })

    it.each([
      // Each of these sums to a whole number of micros by exact arithmetic (tokens x price in thousandths of a micro, summed),
      // yet adding the same products as floating-point numbers lands a hair above it and rounding up gives one micro too many.
      // They only pass when the sum is done in integers.
      ['721 in, 35 out, 14 write, 865 read: 72.1 + 17.5 + 1.75 + 8.65 = exactly 100', usage({ inputTokens: 721, outputTokens: 35, cacheWriteTokens: 14, cacheReadTokens: 865 }), 100],
      ['931 in, 20 out, 340 write, 940 read: 93.1 + 10 + 42.5 + 9.4 = exactly 155', usage({ inputTokens: 931, outputTokens: 20, cacheWriteTokens: 340, cacheReadTokens: 940 }), 155],
    ])('does not let floating-point noise add a micro: %s', (_label, over, expected) => {
      expect(costMicros(HAIKU, over)).toBe(expected)
    })
  })

  describe('Opus 5.5 ($4 in, $20 out, $5 cache write, $0.20 cache read)', () => {
    it('prices input and output: 1000 each is 4000 + 20000 micros', () => {
      expect(costMicros(OPUS, usage({ inputTokens: 1000, outputTokens: 1000 }))).toBe(24_000)
    })

    it('prices cache writes and reads: 1000 write is 5000, 1000 read is 200', () => {
      expect(costMicros(OPUS, usage({ cacheWriteTokens: 1000 }))).toBe(5_000)
      expect(costMicros(OPUS, usage({ cacheReadTokens: 1000 }))).toBe(200)
    })

    it('prices every component: 4000 + 20000 + 5000 + 200 + one search at 10000', () => {
      const all = usage({ inputTokens: 1000, outputTokens: 1000, cacheWriteTokens: 1000, cacheReadTokens: 1000, webSearches: 1 })

      expect(costMicros(OPUS, all)).toBe(39_200)
    })

    it('has one price whatever the prompt size: 200000 input tokens is 800000 micros', () => {
      expect(costMicros(OPUS, usage({ inputTokens: 200_000 }))).toBe(800_000)
    })
  })

  it('is a whole number of micros', () => {
    expect(Number.isInteger(costMicros(HAIKU, usage({ inputTokens: 7, outputTokens: 3, cacheReadTokens: 13 })))).toBe(true)
  })

  it('refuses to price an unknown model, rather than calling it free', () => {
    expect(() => costMicros('claude-test-model', usage({ inputTokens: 1000 }))).toThrow()
  })
})

describe('estimateMicros (the worst case reserved before a call)', () => {
  it('allows 25000 input tokens for each search: the results it fetches are fed back to the model', () => {
    expect(SEARCH_INPUT_ALLOWANCE).toBe(25_000)
  })

  it('adds input (and each search\'s 25000 allowance) at the input price, the whole output allowance at the output price, and every allowed search', () => {
    // Sonnet: (10000 + 5 x 25000) x 2 + 4096 x 10 + 5 x 10000 = 270000 + 40960 + 50000
    expect(estimateMicros(SONNET, { inputTokens: 10_000, maxOutputTokens: 4_096, maxSearches: 5 })).toBe(360_960)
  })

  it('adds nothing for input when there are no searches', () => {
    // Sonnet: 10000 x 2 + 4096 x 10
    expect(estimateMicros(SONNET, { inputTokens: 10_000, maxOutputTokens: 4_096, maxSearches: 0 })).toBe(60_960)
  })

  it('prices a small Haiku call: 1000 in at 0.10 plus 16000 out at 0.50 is 100 + 8000', () => {
    expect(estimateMicros(HAIKU, { inputTokens: 1000, maxOutputTokens: 16_000, maxSearches: 0 })).toBe(8_100)
  })

  it('prices Opus: 2000 in plus the search allowance at 4, 1000 out at 20, one search', () => {
    // (2000 + 25000) x 4 + 1000 x 20 + 10000 = 108000 + 20000 + 10000
    expect(estimateMicros(OPUS, { inputTokens: 2000, maxOutputTokens: 1000, maxSearches: 1 })).toBe(138_000)
  })

  it('rounds up to a whole micro', () => {
    // 1 x 0.10 + 1 x 0.50 = 0.6
    expect(estimateMicros(HAIKU, { inputTokens: 1, maxOutputTokens: 1, maxSearches: 0 })).toBe(1)
  })

  it('uses the high Haiku tier, for the output too, from 100001 input tokens, exactly as the real cost would', () => {
    // A call that big is billed at the high tier, so the reservation must be too or it could be less than the bill.
    expect(estimateMicros(HAIKU, { inputTokens: 100_000, maxOutputTokens: 1000, maxSearches: 0 })).toBe(10_500)
    expect(estimateMicros(HAIKU, { inputTokens: 100_001, maxOutputTokens: 1000, maxSearches: 0 })).toBe(52_501)
  })

  it('is exactly the cost of a call that uses all of its allowance, each search having added 25000 input tokens', () => {
    const allowance = { inputTokens: 10_000, maxOutputTokens: 4_096, maxSearches: 5 }
    const spent = usage({ inputTokens: 10_000 + 5 * 25_000, outputTokens: 4_096, webSearches: 5 })

    expect(costMicros(SONNET, spent)).toBe(estimateMicros(SONNET, allowance))
  })

  it('puts a Haiku call with searches at the long tier when the searches\' allowance takes the prompt over 100000', () => {
    // 1 + 4 x 25000 = 100001 input tokens at 0.50, 1000 out at 2.50, 4 searches: 50000.5 + 2500 + 40000 -> 92501
    expect(estimateMicros(HAIKU, { inputTokens: 1, maxOutputTokens: 1000, maxSearches: 4 })).toBe(92_501)
    // One token less stays at the low tier: 100000 x 0.10 + 1000 x 0.50 + 40000
    expect(estimateMicros(HAIKU, { inputTokens: 0, maxOutputTokens: 1000, maxSearches: 4 })).toBe(50_500)
  })

  it('covers the cost of a Haiku research call that used 100001 input tokens, 4096 output tokens and 5 searches', () => {
    const request = { inputTokens: 1_000, maxOutputTokens: 4_096, maxSearches: 5 }
    const spent = usage({ inputTokens: 100_001, outputTokens: 4_096, webSearches: 5 })

    expect(estimateMicros(HAIKU, request)).toBeGreaterThanOrEqual(costMicros(HAIKU, spent))
  })

  it('is never less than the cost of a call that stays inside its allowance', () => {
    const allowance = { inputTokens: 10_000, maxOutputTokens: 4_096, maxSearches: 5 }
    const spent = usage({ inputTokens: 9_000, outputTokens: 3_000, cacheReadTokens: 500, webSearches: 2 })

    expect(costMicros(SONNET, spent)).toBeLessThanOrEqual(estimateMicros(SONNET, allowance))
  })

  it('refuses an unknown model', () => {
    expect(() => estimateMicros('claude-test-model', { inputTokens: 1, maxOutputTokens: 1, maxSearches: 0 })).toThrow()
  })
})

describe('estimateInputTokens', () => {
  const imageBlock = (data: string) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data } })
  const withContent = (content: unknown) => ({ max_tokens: 100, messages: [{ role: 'user', content }] })

  it('is the JSON byte length divided by 2.5, rounded up', () => {
    // {"max_tokens":10,"messages":[{"role":"user","content":"hello"}]} is 64 bytes: ceil(64 / 2.5) = ceil(25.6) = 26
    expect(estimateInputTokens({ max_tokens: 10, messages: [{ role: 'user', content: 'hello' }] })).toBe(26)
  })

  it('counts bytes, not characters: 30 two-byte letters make a 119-byte body, ceil(119 / 2.5) = ceil(47.6) = 48', () => {
    expect(estimateInputTokens({ max_tokens: 10, messages: [{ role: 'user', content: 'é'.repeat(30) }] })).toBe(48)
  })

  it('grows with the system prompt', () => {
    const short = estimateInputTokens({ max_tokens: 10, system: 'Be brief.', messages: [{ role: 'user', content: 'hi' }] })
    const long = estimateInputTokens({ max_tokens: 10, system: 'Be brief. '.repeat(100), messages: [{ role: 'user', content: 'hi' }] })

    expect(long).toBeGreaterThan(short + 300)
  })

  it('counts an image as 5000 tokens plus the few tokens of its block, whatever the size of the file', () => {
    const text = { type: 'text', text: 'hi' }
    const without = estimateInputTokens(withContent([text]))

    const withImage = estimateInputTokens(withContent([imageBlock('AAAA'), text]))

    expect(withImage - without).toBeGreaterThanOrEqual(5000)
    expect(withImage - without).toBeLessThan(5100)
  })

  it('does not count the base64 bytes of an image: a 300000-character photo estimates the same as a 10-character one', () => {
    const text = { type: 'text', text: 'hi' }

    const tiny = estimateInputTokens(withContent([imageBlock('A'.repeat(10)), text]))
    const huge = estimateInputTokens(withContent([imageBlock('A'.repeat(300_000)), text]))

    expect(huge).toBe(tiny)
  })

  it('adds 5000 more for each further image', () => {
    const one = estimateInputTokens(withContent([imageBlock('AAAA')]))
    const two = estimateInputTokens(withContent([imageBlock('AAAA'), imageBlock('AAAA')]))

    expect(two - one).toBeGreaterThanOrEqual(5000)
    expect(two - one).toBeLessThan(5100)
  })

  it('leaves the body it was given untouched, so the request that is sent still carries the image', () => {
    const body = withContent([imageBlock('QUJDRA=='), { type: 'text', text: 'hi' }])
    const before = structuredClone(body)

    estimateInputTokens(body)

    expect(body).toEqual(before)
  })

  it('is a whole number', () => {
    expect(Number.isInteger(estimateInputTokens(withContent('abcd')))).toBe(true)
  })
})
