import { describe, expect, it } from 'vitest'
import type { Routine, RoutineSkeleton } from '../../modules/routines/routines.types'
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
})
