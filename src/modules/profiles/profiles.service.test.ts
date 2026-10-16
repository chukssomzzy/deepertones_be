import { describe, expect, it } from 'vitest'
import { NotFoundError } from '../../lib/errors'
import { FakeProfilesRepository } from './profiles.repository.fake'
import { ProfilesService } from './profiles.service'
import type { Profile } from './profiles.types'

// The one clock every test hangs off; fixtures are offsets from it.
const T0 = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000
const at = (offsetMs: number) => new Date(T0.getTime() + offsetMs)

const profile = (id: string, userId: string, over: Partial<Profile> = {}): Profile => ({
  id,
  userId,
  displayName: null,
  isDefault: false,
  createdAt: T0,
  ...over,
})

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error as Error & { code?: string }
  }
  throw new Error('expected the promise to reject')
}

/** Ada has a default and a second profile; Bo has just a default. */
const setup = async () => {
  const repository = new FakeProfilesRepository()
  const adaDefault = profile('p-ada', 'u-ada', { isDefault: true })
  const adaSecond = profile('p-ada-2', 'u-ada', { displayName: 'Ada Jr', createdAt: at(MINUTE) })
  const boDefault = profile('p-bo', 'u-bo', { isDefault: true })
  for (const p of [adaSecond, boDefault, adaDefault]) await repository.insert(p)
  return { service: new ProfilesService({ repository }), adaDefault, adaSecond, boDefault }
}

describe('ProfilesService.defaultFor', () => {
  it('returns the user\'s default profile, not another of theirs', async () => {
    const { service, adaDefault } = await setup()

    expect(await service.defaultFor('u-ada')).toEqual(adaDefault)
  })

  it('answers PROFILE_NOT_FOUND, as a NotFoundError, for a user with no profile', async () => {
    const { service } = await setup()

    const error = await errorOf(service.defaultFor('u-nobody'))

    expect(error).toBeInstanceOf(NotFoundError)
    expect(error.code).toBe('PROFILE_NOT_FOUND')
  })
})

describe('ProfilesService.ownedBy', () => {
  it('returns the profile when it belongs to the user, default or not', async () => {
    const { service, adaDefault, adaSecond } = await setup()

    expect(await service.ownedBy('u-ada', 'p-ada')).toEqual(adaDefault)
    expect(await service.ownedBy('u-ada', 'p-ada-2')).toEqual(adaSecond)
  })

  it('returns null for a profile that belongs to another user', async () => {
    const { service } = await setup()

    expect(await service.ownedBy('u-bo', 'p-ada')).toBeNull()
  })

  it('returns null for a profile that does not exist', async () => {
    const { service } = await setup()

    expect(await service.ownedBy('u-ada', 'no-such-profile')).toBeNull()
  })
})

describe('ProfilesService.of', () => {
  it('lists the user\'s profiles, the default first', async () => {
    const { service, adaDefault, adaSecond } = await setup()

    expect(await service.of('u-ada')).toEqual([adaDefault, adaSecond])
  })

  it('lists only that user\'s profiles', async () => {
    const { service, boDefault } = await setup()

    expect(await service.of('u-bo')).toEqual([boDefault])
  })

  it('is empty for a user with none', async () => {
    const { service } = await setup()

    expect(await service.of('u-nobody')).toEqual([])
  })
})
