import { describe, expect, it } from 'vitest'
import { FORBIDDEN_WORDING } from '../routines/routines.wording'
import { STEP_DOWN_LINE_GUEST, STEP_DOWN_LINE_VERIFIED } from './shelf.copy'

describe('the step-down warning lines', () => {
  it.each([
    ['verified', STEP_DOWN_LINE_VERIFIED],
    ['guest', STEP_DOWN_LINE_GUEST],
  ])('the %s line says nothing the app never says', (_who, line) => {
    for (const { code, pattern } of FORBIDDEN_WORDING) expect(pattern.test(line), `"${line}" trips ${code}`).toBe(false)
  })

  it('are different lines, and the guest one asks for no taper code or name', () => {
    expect(STEP_DOWN_LINE_GUEST).not.toBe(STEP_DOWN_LINE_VERIFIED)
    expect(STEP_DOWN_LINE_GUEST).toMatch(/sign up/i)
  })
})
