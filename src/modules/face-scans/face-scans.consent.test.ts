import { describe, expect, it } from 'vitest'
import { CURRENT_FACE_CONSENT_VERSION } from './face-scans.consent'

describe('CURRENT_FACE_CONSENT_VERSION', () => {
  it('starts at 1: the first wording of the face photo consent', () => {
    expect(CURRENT_FACE_CONSENT_VERSION).toBe(1)
  })
})
