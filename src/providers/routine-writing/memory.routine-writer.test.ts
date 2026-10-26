import { describe, expect, it } from 'vitest'
import type { GateFailure, Routine, RoutineSkeleton } from '../../modules/routines/routines.types'
import { MemoryRoutineWriter } from './memory.routine-writer'

const skeleton = (goal: RoutineSkeleton['goal']): RoutineSkeleton => ({
  goal,
  person: { seen: [], alsoNoticed: [], skinType: null, lowConfidence: [], cautions: [], budgetBand: null },
  steps: ['cleanse'],
  shelf: [],
  gaps: [],
  limits: { allowed: { cleanse: ['am-pm'], treat: [], moisturise: [], protect: ['am'] }, maxNewProducts: 0 },
  hintsShown: false,
})

const routine = (expectation: string): Routine => ({ steps: [], tapers: [], expectation })

describe('MemoryRoutineWriter', () => {
  it('fails with a clear "no answer set" error until told how to answer, and records nothing for it', async () => {
    const writer = new MemoryRoutineWriter()

    await expect(writer.write(skeleton('even-tone'))).rejects.toThrow(/no answer set/i)
    expect(writer.calls).toEqual([])
  })

  it('answers with what its function computes from the skeleton', async () => {
    const writer = new MemoryRoutineWriter()
    writer.respondWith((s) => routine(`for ${s.goal}`))

    await expect(writer.write(skeleton('even-tone'))).resolves.toEqual(routine('for even-tone'))
    await expect(writer.write(skeleton('glow'))).resolves.toEqual(routine('for glow'))
  })

  it('records every skeleton it was given, in order', async () => {
    const writer = new MemoryRoutineWriter()
    writer.respondWith(() => routine('x'))
    const first = skeleton('even-tone')
    const second = skeleton('glow')

    await writer.write(first)
    await writer.write(second)

    expect(writer.calls).toEqual([first, second])
  })

  it('failNextWith rejects the next call only, records nothing for it, then recovers', async () => {
    const writer = new MemoryRoutineWriter()
    writer.respondWith(() => routine('ok'))
    const failure = new Error('boom')
    writer.failNextWith(failure)

    await expect(writer.write(skeleton('even-tone'))).rejects.toBe(failure)
    expect(writer.calls).toEqual([])

    await expect(writer.write(skeleton('glow'))).resolves.toEqual(routine('ok'))
    expect(writer.calls).toEqual([skeleton('glow')])
  })

  describe('retries', () => {
    const FAILED: GateFailure[] = [
      { gate: 'unknown-product', step: 'treat' },
      { gate: 'gap', step: 'protect' },
    ]

    it('records the retry each call was given, alongside the skeleton it was given with', async () => {
      const writer = new MemoryRoutineWriter()
      writer.respondWith(() => routine('x'))
      const first = skeleton('even-tone')

      await writer.write(first, { failed: FAILED })

      expect(writer.calls).toEqual([first])
      expect(writer.retries).toEqual([{ failed: FAILED }])
    })

    it('records undefined for a call with no retry, keeping retries in step with calls', async () => {
      const writer = new MemoryRoutineWriter()
      writer.respondWith(() => routine('x'))

      await writer.write(skeleton('even-tone'))
      await writer.write(skeleton('even-tone'), { failed: FAILED })
      await writer.write(skeleton('glow'))

      expect(writer.calls).toHaveLength(3)
      expect(writer.retries).toEqual([undefined, { failed: FAILED }, undefined])
    })

    it('records no retry for a call that fails, as it records no skeleton for it', async () => {
      const writer = new MemoryRoutineWriter()
      writer.respondWith(() => routine('ok'))
      writer.failNextWith(new Error('boom'))

      await expect(writer.write(skeleton('even-tone'), { failed: FAILED })).rejects.toThrow('boom')
      expect(writer.retries).toEqual([])

      await writer.write(skeleton('glow'))
      expect(writer.retries).toEqual([undefined])
      expect(writer.calls).toHaveLength(1)
    })
  })
})
