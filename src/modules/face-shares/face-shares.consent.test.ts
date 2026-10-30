import { describe, expect, it } from 'vitest'
import { CURRENT_FACE_SHARE_CONSENT_VERSION } from './face-shares.consent'

describe('CURRENT_FACE_SHARE_CONSENT_VERSION', () => {
  it('starts at 1: the first wording of the face share consent', () => {
    expect(CURRENT_FACE_SHARE_CONSENT_VERSION).toBe(1)
  })
})
