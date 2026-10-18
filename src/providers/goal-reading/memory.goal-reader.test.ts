import { describe, expect, it } from 'vitest'
import type { GoalReading } from './goal-reader.provider'
import { MemoryGoalReader } from './memory.goal-reader'

const NO_GOAL: GoalReading = { goal: null, wantsLighter: false }
const CLEAR: GoalReading = { goal: 'clear-skin', wantsLighter: false }
const LIGHTER: GoalReading = { goal: 'brighter', wantsLighter: true }

describe('MemoryGoalReader', () => {
  it('reads no goal until told otherwise, then answers with what its function computes from the text', async () => {
    const reader = new MemoryGoalReader()
    await expect(reader.read('make my face clear')).resolves.toEqual(NO_GOAL)

    reader.respondWith((text) => (text.includes('fairer') ? LIGHTER : CLEAR))

    await expect(reader.read('make my face clear')).resolves.toEqual(CLEAR)
    await expect(reader.read('I want to be fairer')).resolves.toEqual(LIGHTER)
  })

  it('records every text it was given, in order', async () => {
    const reader = new MemoryGoalReader()

    await reader.read('first')
    await reader.read('second')

    expect(reader.calls).toEqual(['first', 'second'])
  })

  it('failNextWith rejects the next call only, records nothing for it, then recovers', async () => {
    const reader = new MemoryGoalReader()
    reader.respondWith(() => CLEAR)
    const failure = new Error('boom')
    reader.failNextWith(failure)

    await expect(reader.read('x')).rejects.toBe(failure)
    expect(reader.calls).toEqual([])

    await expect(reader.read('x')).resolves.toEqual(CLEAR)
    expect(reader.calls).toEqual(['x'])
  })
})
