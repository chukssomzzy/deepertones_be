import { describe, expect, it } from 'vitest'
import { GOALS } from '../goals/goals.vocabulary'
import { mayScanNow } from './face-scans.policy'

// Who may start a face scan now. Today: a profile that has no face scan under its current goal, or whose current goal is not the goal of its latest
// face scan. (A later check-in schedule adds a third reason; it is not here yet.) Pure: the service reads the goal and the latest scan and asks.
describe('mayScanNow', () => {
  it('allows a profile that has never had a face scan', () => {
    expect(mayScanNow({ goal: 'glow', latest: null })).toEqual({ allowed: true })
  })

  it('refuses a profile whose latest face scan was taken under the goal it has now, and says why', () => {
    expect(mayScanNow({ goal: 'glow', latest: { goalAtScan: 'glow' } })).toEqual({ allowed: false, reason: 'already-scanned-for-goal' })
  })

  it('allows a profile whose latest face scan was taken under another goal', () => {
    expect(mayScanNow({ goal: 'brighter', latest: { goalAtScan: 'glow' } })).toEqual({ allowed: true })
  })

  it.each(GOALS)('refuses the goal %s against itself and allows it against every other goal', (goal) => {
    expect(mayScanNow({ goal, latest: { goalAtScan: goal } })).toMatchObject({ allowed: false })
    for (const other of GOALS.filter((g) => g !== goal)) expect(mayScanNow({ goal, latest: { goalAtScan: other } })).toEqual({ allowed: true })
  })
})
