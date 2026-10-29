import { beforeEach, describe, expect, it } from 'vitest'
import { type Actor, runAs } from '../../lib/context'
import { FakeFaceSharesRepository } from './face-shares.repository.fake'
import { FaceSharesService } from './face-shares.service'

// The remembered consent to share a before-and-after card of the face photos (spec #259, C1). It is asked once and kept; the person can withdraw it at any
// time and the next share asks again. The repository is the real fake; the clock is one mutable instant.
//
// THE CONTRACT THIS FILE PINS (assumed: the brief names the behaviour and `hasCurrentConsent`, not the constructor; it follows InboxService):
//   new FaceSharesService({ repository, now? })
//     repository  FaceSharesRepository (see face-shares.repository.contract.ts)
//     now         the clock; the time a consent is given and withdrawn comes from it
//   giveConsent(version: number): Promise<{ version: number; givenAt: Date }>
//     Session-scoped, verified users only. Only CURRENT_FACE_SHARE_CONSENT_VERSION (1) is accepted; any other is ValidationError 400
//     FACE_SHARE_CONSENT_VERSION_MISMATCH with details { current: 1 }, and nothing is recorded. Giving again, or after a withdrawal, starts the consent afresh
//     (new time, withdrawal cleared).
//   consent(): Promise<{ version: number; givenAt: Date; withdrawnAt: Date | null; current: boolean }>
//     Session-scoped, verified users only. A withdrawn consent, and one for an older version, are still shown, with current false. NotFoundError 404
//     FACE_SHARE_CONSENT_NOT_FOUND until the profile has given one.
//   withdrawConsent(): Promise<void>
//     Session-scoped, verified users only. Stamps the time and keeps the record. Never throws for "nothing to withdraw" (already withdrawn, never given).
//   hasCurrentConsent(profileId: string): Promise<{ version: number } | null>
//     By profile id with NO session (C2 asks while sharing). { version } of the consent when it is for the current version and not withdrawn; null otherwise
//     (never given, withdrawn, or for an older version). Nothing else is in the answer.
//   Gates for the three session methods, in order: 401 AUTH_REQUIRED (no session), 403 SIGNUP_REQUIRED (a guest), then the rest. A guest who sends a wrong version
//   is told 403, not 400.

const T0 = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs)

const CURRENT = 1
const AMARA_USER = 'user-amara'
const AMARA = 'profile-amara-1'
const AMARA_SECOND = 'profile-amara-2'
const TOLU_USER = 'user-tolu'
const TOLU = 'profile-tolu-1'

const actor = (userId: string, profileId: string, status: 'anonymous' | 'verified' = 'verified'): Actor => ({ kind: 'user', userId, status, profileId })
const AMARA_ACTOR = actor(AMARA_USER, AMARA)
const AMARA_SECOND_ACTOR = actor(AMARA_USER, AMARA_SECOND)
const TOLU_ACTOR = actor(TOLU_USER, TOLU)
const GUEST = actor('user-guest', 'profile-guest', 'anonymous')
const PUBLIC: Actor = { kind: 'public' }

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error as Error & { code?: string; details?: unknown }
  }
  throw new Error('expected the promise to reject')
}

let clock: Date
let repository: FakeFaceSharesRepository
let service: FaceSharesService

beforeEach(() => {
  clock = T0
  repository = new FakeFaceSharesRepository()
  service = new FaceSharesService({ repository, now: () => clock })
})

const give = (who: Actor, version: number = CURRENT) => runAs(who, () => service.giveConsent(version))
const consent = (who: Actor) => runAs(who, () => service.consent())
const withdraw = (who: Actor) => runAs(who, () => service.withdrawConsent())

describe('FaceSharesService.giveConsent', () => {
  it('records the consent for the current version at the time of the call and answers the version and that time', async () => {
    clock = at(3 * MINUTE)

    const given = await give(AMARA_ACTOR)

    expect(given).toEqual({ version: CURRENT, givenAt: at(3 * MINUTE) })
    expect(await repository.consentOf(AMARA)).toMatchObject({ profileId: AMARA, userId: AMARA_USER, version: CURRENT, givenAt: at(3 * MINUTE), withdrawnAt: null })
  })

  it.each([
    ['one below the current version', CURRENT - 1],
    ['one above the current version', CURRENT + 1],
  ])('refuses %s with 400 FACE_SHARE_CONSENT_VERSION_MISMATCH, saying which is current, and records nothing', async (_label, version) => {
    const error = await errorOf(give(AMARA_ACTOR, version))

    expect(error).toMatchObject({ name: 'ValidationError', code: 'FACE_SHARE_CONSENT_VERSION_MISMATCH', details: { current: CURRENT } })
    expect(await repository.consentOf(AMARA)).toBeNull()
  })

  it('leaves a consent already given as it was when a wrong version is sent', async () => {
    await give(AMARA_ACTOR)

    await errorOf(give(AMARA_ACTOR, CURRENT + 1))

    expect(await consent(AMARA_ACTOR)).toMatchObject({ version: CURRENT, givenAt: T0, current: true })
  })

  it('starts the consent afresh when it is given again: the new time, still one consent', async () => {
    await give(AMARA_ACTOR)
    clock = at(10 * MINUTE)

    await give(AMARA_ACTOR)

    expect(await consent(AMARA_ACTOR)).toEqual({ version: CURRENT, givenAt: at(10 * MINUTE), withdrawnAt: null, current: true })
  })

  it('starts the consent afresh when it is given after a withdrawal: the withdrawal is cleared and the next share needs no new ask', async () => {
    await give(AMARA_ACTOR)
    clock = at(5 * MINUTE)
    await withdraw(AMARA_ACTOR)
    clock = at(8 * MINUTE)

    await give(AMARA_ACTOR)

    expect(await consent(AMARA_ACTOR)).toEqual({ version: CURRENT, givenAt: at(8 * MINUTE), withdrawnAt: null, current: true })
    expect(await service.hasCurrentConsent(AMARA)).toEqual({ version: CURRENT })
  })

  it('refuses a guest with 403 SIGNUP_REQUIRED, even with a wrong version, and a caller with no session with 401 AUTH_REQUIRED', async () => {
    expect(await errorOf(give(GUEST))).toMatchObject({ name: 'ForbiddenError', code: 'SIGNUP_REQUIRED' })
    expect(await errorOf(give(GUEST, CURRENT + 1))).toMatchObject({ name: 'ForbiddenError', code: 'SIGNUP_REQUIRED' })
    expect(await errorOf(give(PUBLIC))).toMatchObject({ name: 'UnauthorizedError', code: 'AUTH_REQUIRED' })
    expect(await repository.consentOf('profile-guest')).toBeNull()
  })
})

describe('FaceSharesService.consent', () => {
  it('is 404 FACE_SHARE_CONSENT_NOT_FOUND until the profile has given one', async () => {
    expect(await errorOf(consent(AMARA_ACTOR))).toMatchObject({ name: 'NotFoundError', code: 'FACE_SHARE_CONSENT_NOT_FOUND' })
  })

  it('shows the version, when it was given, that it is not withdrawn, and that it is current', async () => {
    await give(AMARA_ACTOR)

    expect(await consent(AMARA_ACTOR)).toEqual({ version: CURRENT, givenAt: T0, withdrawnAt: null, current: true })
  })

  it('still shows a withdrawn consent, with when it was withdrawn and current false', async () => {
    await give(AMARA_ACTOR)
    clock = at(5 * MINUTE)
    await withdraw(AMARA_ACTOR)

    expect(await consent(AMARA_ACTOR)).toEqual({ version: CURRENT, givenAt: T0, withdrawnAt: at(5 * MINUTE), current: false })
  })

  // Only a bump of the current version makes a consent for an older one, and the service refuses to write one, so the row is seeded through the repository.
  it('still shows a consent given for an older version, with current false', async () => {
    await repository.giveConsent({ profileId: AMARA, userId: AMARA_USER, version: CURRENT - 1, at: T0 })

    expect(await consent(AMARA_ACTOR)).toEqual({ version: CURRENT - 1, givenAt: T0, withdrawnAt: null, current: false })
  })

  it('belongs to the profile: the same account\'s other profile, and another account, have none', async () => {
    await give(AMARA_ACTOR)

    expect(await errorOf(consent(AMARA_SECOND_ACTOR))).toMatchObject({ code: 'FACE_SHARE_CONSENT_NOT_FOUND' })
    expect(await errorOf(consent(TOLU_ACTOR))).toMatchObject({ code: 'FACE_SHARE_CONSENT_NOT_FOUND' })
  })

  it('refuses a guest with 403 SIGNUP_REQUIRED and a caller with no session with 401 AUTH_REQUIRED', async () => {
    expect(await errorOf(consent(GUEST))).toMatchObject({ name: 'ForbiddenError', code: 'SIGNUP_REQUIRED' })
    expect(await errorOf(consent(PUBLIC))).toMatchObject({ name: 'UnauthorizedError', code: 'AUTH_REQUIRED' })
  })
})

describe('FaceSharesService.withdrawConsent', () => {
  it('stamps the time of the withdrawal and keeps the record', async () => {
    await give(AMARA_ACTOR)
    clock = at(5 * MINUTE)

    await expect(withdraw(AMARA_ACTOR)).resolves.toBeUndefined()

    expect(await repository.consentOf(AMARA)).toMatchObject({ version: CURRENT, givenAt: T0, withdrawnAt: at(5 * MINUTE) })
  })

  it('is not an error to withdraw twice, and the first time stands', async () => {
    await give(AMARA_ACTOR)
    clock = at(5 * MINUTE)
    await withdraw(AMARA_ACTOR)
    clock = at(9 * MINUTE)

    await expect(withdraw(AMARA_ACTOR)).resolves.toBeUndefined()

    expect((await consent(AMARA_ACTOR)).withdrawnAt).toEqual(at(5 * MINUTE))
  })

  it('is not an error when there was never a consent, and it makes no record', async () => {
    await expect(withdraw(AMARA_ACTOR)).resolves.toBeUndefined()

    expect(await repository.consentOf(AMARA)).toBeNull()
  })

  it('withdraws the session profile\'s consent only', async () => {
    await give(AMARA_ACTOR)
    await give(AMARA_SECOND_ACTOR)
    await give(TOLU_ACTOR)

    await withdraw(AMARA_ACTOR)

    expect((await consent(AMARA_ACTOR)).current).toBe(false)
    expect((await consent(AMARA_SECOND_ACTOR)).current).toBe(true)
    expect((await consent(TOLU_ACTOR)).current).toBe(true)
  })

  it('refuses a guest with 403 SIGNUP_REQUIRED and a caller with no session with 401 AUTH_REQUIRED, and withdraws nothing', async () => {
    await repository.giveConsent({ profileId: 'profile-guest', userId: 'user-guest', version: CURRENT, at: T0 })

    expect(await errorOf(withdraw(GUEST))).toMatchObject({ name: 'ForbiddenError', code: 'SIGNUP_REQUIRED' })
    expect(await errorOf(withdraw(PUBLIC))).toMatchObject({ name: 'UnauthorizedError', code: 'AUTH_REQUIRED' })
    expect((await repository.consentOf('profile-guest'))!.withdrawnAt).toBeNull()
  })
})

describe('FaceSharesService.hasCurrentConsent', () => {
  // No runAs anywhere in this block: the share asks by profile id with no session, so a call that reads the session would throw "No request context".
  it('answers null for a profile that never gave consent', async () => {
    expect(await service.hasCurrentConsent(AMARA)).toBeNull()
  })

  it('answers the version of a current consent, and nothing else', async () => {
    await give(AMARA_ACTOR)

    expect(await service.hasCurrentConsent(AMARA)).toEqual({ version: CURRENT })
  })

  it('answers null once the consent is withdrawn, so the next share must ask again', async () => {
    await give(AMARA_ACTOR)
    await withdraw(AMARA_ACTOR)

    expect(await service.hasCurrentConsent(AMARA)).toBeNull()
  })

  it('answers null for a consent given for an older version', async () => {
    await repository.giveConsent({ profileId: AMARA, userId: AMARA_USER, version: CURRENT - 1, at: T0 })

    expect(await service.hasCurrentConsent(AMARA)).toBeNull()
  })

  it('answers for the profile it is asked about: another profile\'s consent does not count', async () => {
    await give(TOLU_ACTOR)
    await give(AMARA_ACTOR)
    await withdraw(AMARA_ACTOR)

    expect(await service.hasCurrentConsent(AMARA)).toBeNull()
    expect(await service.hasCurrentConsent(AMARA_SECOND)).toBeNull()
    expect(await service.hasCurrentConsent(TOLU)).toEqual({ version: CURRENT })
  })
})
