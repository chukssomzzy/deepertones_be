import { describe, expect, it } from 'vitest'
import { MemoryVerdictFitter } from './memory.verdict-fitter'
import type { FitRequest, FitResult } from './verdict-fitter.provider'

const request = (goalId: FitRequest['goal']['id']): FitRequest => ({
  goal: { id: goalId, skinConcerns: ['hd_age_spot'] },
  skinType: null,
  scan: null,
  shelf: [{ id: 'p1', brand: null, name: 'Serum', variant: null, step: 'treat', ingredients: ['Aqua'], cautions: [], skinConcerns: [], floor: { status: 'open' } }],
  clashes: [],
})

const result = (reason: string): FitResult => ({ products: [{ id: 'p1', label: 'helping', reason, sameJobAs: null }], clashes: [] })

describe('MemoryVerdictFitter', () => {
  it('fails with a clear "no answer set" error until told how to answer, and records nothing for it', async () => {
    const fitter = new MemoryVerdictFitter()

    await expect(fitter.fit(request('even-tone'))).rejects.toThrow(/no answer set/i)
    expect(fitter.calls).toEqual([])
  })

  it('answers with what its function computes from the request', async () => {
    const fitter = new MemoryVerdictFitter()
    fitter.respondWith((r) => result(`for ${r.goal.id}`))

    await expect(fitter.fit(request('even-tone'))).resolves.toEqual(result('for even-tone'))
    await expect(fitter.fit(request('glow'))).resolves.toEqual(result('for glow'))
  })

  it('records every request it was given, in order', async () => {
    const fitter = new MemoryVerdictFitter()
    fitter.respondWith(() => result('x'))
    const first = request('even-tone')
    const second = request('glow')

    await fitter.fit(first)
    await fitter.fit(second)

    expect(fitter.calls).toEqual([first, second])
  })

  it('failNextWith rejects the next call only, records nothing for it, then recovers', async () => {
    const fitter = new MemoryVerdictFitter()
    fitter.respondWith(() => result('ok'))
    const failure = new Error('boom')
    fitter.failNextWith(failure)

    await expect(fitter.fit(request('even-tone'))).rejects.toBe(failure)
    expect(fitter.calls).toEqual([])

    await expect(fitter.fit(request('glow'))).resolves.toEqual(result('ok'))
    expect(fitter.calls).toEqual([request('glow')])
  })

  it('records nothing for a call whose answer function throws', async () => {
    const fitter = new MemoryVerdictFitter()
    fitter.respondWith(() => {
      throw new Error('bad answer')
    })

    await expect(fitter.fit(request('even-tone'))).rejects.toThrow('bad answer')
    expect(fitter.calls).toEqual([])
  })
})
