import { afterEach, describe, expect, it, vi } from 'vitest'
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

afterEach(() => {
  vi.restoreAllMocks()
})

/** Ada has a default and a second profile; Bo has just a default. */
const setup = async () => {
  const repository = new FakeProfilesRepository()
  const adaDefault = profile('p-ada', 'u-ada', { isDefault: true })
  const adaSecond = profile('p-ada-2', 'u-ada', { displayName: 'Ada Jr', createdAt: at(MINUTE) })
  const boDefault = profile('p-bo', 'u-bo', { isDefault: true })
  for (const p of [adaSecond, boDefault, adaDefault]) await repository.insert(p)
  let n = 0
  const service = new ProfilesService({ repository, newId: () => `p-new-${++n}`, now: () => at(5 * MINUTE) })
  return { service, repository, adaDefault, adaSecond, boDefault }
}

describe('ProfilesService.defaultFor', () => {
  it('returns the user\'s default profile, not another of theirs', async () => {
    const { service, adaDefault } = await setup()

    expect(await service.defaultFor('u-ada')).toEqual(adaDefault)
  })

  it('creates the missing default for a user with no profile, and returns it', async () => {
    const { service, repository } = await setup()

    const created = await service.defaultFor('u-nobody')

    expect(created).toEqual({ id: 'p-new-1', userId: 'u-nobody', displayName: null, isDefault: true, createdAt: at(5 * MINUTE) })
    expect(await repository.defaultFor('u-nobody')).toEqual(created)
  })

  it('creates it once: the next call returns the same profile', async () => {
    const { service, repository } = await setup()

    const first = await service.defaultFor('u-nobody')
    const second = await service.defaultFor('u-nobody')

    expect(second).toEqual(first)
    expect(await repository.ofUser('u-nobody')).toHaveLength(1)
  })

  it('logs the creation once, with ids only, and logs nothing for a default that exists', async () => {
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { service } = await setup()

    await service.defaultFor('u-ada')
    expect(logged).not.toHaveBeenCalled()
    await service.defaultFor('u-nobody')
    await service.defaultFor('u-nobody')

    expect(logged.mock.calls).toEqual([[{ outcome: 'default-profile-created', userId: 'u-nobody' }]])
  })

  it('answers one profile to two simultaneous calls: the loser of the unique index reads the winner', async () => {
    const logged = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const { service, repository } = await setup()

    const [a, b] = await Promise.all([service.defaultFor('u-nobody'), service.defaultFor('u-nobody')])

    expect(a.id).toBe(b.id)
    expect(await repository.ofUser('u-nobody')).toEqual([a])
    expect(logged).toHaveBeenCalledTimes(1)
  })

  it('lets the error surface when the profile cannot be stored and none exists (an unknown user, in D1)', async () => {
    const { service, repository } = await setup()
    vi.spyOn(repository, 'insert').mockRejectedValue(new Error('FOREIGN KEY constraint failed'))

    await expect(service.defaultFor('u-nobody')).rejects.toThrow('FOREIGN KEY constraint failed')
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

describe('ProfilesService.find', () => {
  it('returns the profile by its id with the user it belongs to, default or not (what a job needs to act as the user)', async () => {
    const { service } = await setup()

    expect(await service.find('p-ada')).toMatchObject({ id: 'p-ada', userId: 'u-ada' })
    expect(await service.find('p-ada-2')).toMatchObject({ id: 'p-ada-2', userId: 'u-ada' })
  })

  it('says whether the owner is a guest or verified, in the same read', async () => {
    const { service, repository } = await setup()
    repository.markVerified('u-bo')

    expect(await service.find('p-ada')).toEqual({ id: 'p-ada', userId: 'u-ada', ownerStatus: 'anonymous' })
    expect(await service.find('p-bo')).toEqual({ id: 'p-bo', userId: 'u-bo', ownerStatus: 'verified' })
  })

  it('returns null for an id that is no profile', async () => {
    const { service } = await setup()

    expect(await service.find('no-such-profile')).toBeNull()
  })
})
