import { describe, expect, it } from 'vitest'
import type { EmailAddress } from '../../lib/email-address'
import { ConflictError, NotFoundError } from '../../lib/errors'
import type { PhoneNumber } from '../../lib/phone'
import { FakeUsersRepository } from './users.repository.fake'
import { usersRepositoryContract } from './users.repository.contract'
import { UsersService } from './users.service'
import type { UserIdentifier } from './users.types'

usersRepositoryContract('fake', () => new FakeUsersRepository())

const T0 = new Date('2030-06-15T12:00:00.000Z')
const MINUTE = 60 * 1000

const email = (local: string): UserIdentifier => ({ kind: 'email', email: `${local}@example.com` as EmailAddress })
const phone = (n: string): UserIdentifier => ({ kind: 'phone', phone: `+23480312${n}` as PhoneNumber })

const setup = (repository = new FakeUsersRepository()) => {
  let clock = T0
  let n = 0
  const service = new UsersService({ repository, now: () => clock, newId: () => `user-${++n}` })
  return { repository, service, advance: (ms: number) => (clock = new Date(clock.getTime() + ms)) }
}

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error as Error & { code?: string }
  }
  throw new Error('expected the promise to reject')
}

describe('UsersService.guestForDevice', () => {
  it('creates an anonymous guest for a device it has not seen', async () => {
    const { service } = setup()

    const user = await service.guestForDevice('dev-1', 'ios')

    expect(user).toMatchObject({ status: 'anonymous', email: null, phone: null, tokenVersion: 0 })
  })

  it('returns the same guest when the same device asks twice, and records the time seen', async () => {
    const { service, advance } = setup()
    const first = await service.guestForDevice('dev-1', 'ios')
    advance(5 * MINUTE)

    const second = await service.guestForDevice('dev-1', 'ios')

    expect(second.id).toBe(first.id)
    expect((await service.get(first.id)).lastSeenAt.getTime()).toBe(T0.getTime() + 5 * MINUTE)
  })

  it('records the time the device was seen when it is reused', async () => {
    const { service, repository, advance } = setup()
    await service.guestForDevice('dev-1', 'ios')
    advance(5 * MINUTE)

    await service.guestForDevice('dev-1', 'ios')

    expect((await repository.findDevice('dev-1'))!.lastSeenAt.getTime()).toBe(T0.getTime() + 5 * MINUTE)
  })

  it('gives different devices different guests', async () => {
    const { service } = setup()

    const a = await service.guestForDevice('dev-a', 'ios')
    const b = await service.guestForDevice('dev-b', 'android')

    expect(a.id).not.toBe(b.id)
  })

  it('gives a device a new guest once its previous guest has been promoted', async () => {
    const { service } = setup()
    const first = await service.guestForDevice('dev-1', 'ios')
    await service.promote(first.id, email('ada'))

    const next = await service.guestForDevice('dev-1', 'ios')

    expect(next.id).not.toBe(first.id)
    expect(next.status).toBe('anonymous')
    expect((await service.guestForDevice('dev-1', 'ios')).id).toBe(next.id)
  })
})

describe('UsersService.promote', () => {
  it.each([
    ['email', email('ada')],
    ['phone', phone('0001')],
  ] as const)('verifies a guest with their %s and bumps the token version', async (_kind, identifier) => {
    const { service, advance } = setup()
    const guest = await service.guestForDevice('dev-1', 'ios')
    advance(MINUTE)

    const result = await service.promote(guest.id, identifier)

    expect(result.outcome).toBe('promoted')
    expect(result.user).toMatchObject({ id: guest.id, status: 'verified', tokenVersion: 1 })
    expect(await service.findByIdentifier(identifier)).toMatchObject({ id: guest.id })
  })

  it('returns the existing owner and leaves the guest unchanged when the identifier belongs to someone else', async () => {
    const { service } = setup()
    const owner = await service.guestForDevice('dev-owner', 'ios')
    await service.promote(owner.id, email('ada'))
    const guest = await service.guestForDevice('dev-2', 'android')

    const result = await service.promote(guest.id, email('ada'))

    expect(result.outcome).toBe('existing')
    expect(result.user.id).toBe(owner.id)
    expect(await service.get(guest.id)).toMatchObject({ status: 'anonymous', email: null, tokenVersion: 0 })
  })

  it('returns the existing owner when the repository reports the identifier taken in a race', async () => {
    class RacingRepository extends FakeUsersRepository {
      private lookups = 0
      override async findByIdentifier(identifier: UserIdentifier) {
        // The first lookup (before the write) misses, as if the owner promoted in between.
        return this.lookups++ === 0 ? null : super.findByIdentifier(identifier)
      }
    }
    const { service, repository } = setup(new RacingRepository())
    const owner = await service.guestForDevice('dev-owner', 'ios')
    await repository.promote(owner.id, email('ada'), T0)
    const guest = await service.guestForDevice('dev-2', 'android')

    const result = await service.promote(guest.id, email('ada'))

    expect(result.outcome).toBe('existing')
    expect(result.user.id).toBe(owner.id)
    expect(await service.get(guest.id)).toMatchObject({ status: 'anonymous' })
  })

  it('returns the caller untouched when a verified user signs in again with their own identifier', async () => {
    const { service } = setup()
    const guest = await service.guestForDevice('dev-1', 'ios')
    await service.promote(guest.id, email('ada'))

    const result = await service.promote(guest.id, email('ada'))

    expect(result.outcome).toBe('existing')
    expect(result.user).toMatchObject({ id: guest.id, status: 'verified', tokenVersion: 1 })
  })

  it('throws USER_NOT_FOUND when promoting an unknown user', async () => {
    const { service } = setup()

    const error = await errorOf(service.promote('nobody', email('ada')))

    expect(error).toBeInstanceOf(NotFoundError)
    expect(error.code).toBe('USER_NOT_FOUND')
  })

  it('refuses to promote a user who is already verified with NOT_A_GUEST', async () => {
    const { service } = setup()
    const guest = await service.guestForDevice('dev-1', 'ios')
    await service.promote(guest.id, email('ada'))

    const error = await errorOf(service.promote(guest.id, phone('0002')))

    expect(error).toBeInstanceOf(ConflictError)
    expect(error.code).toBe('NOT_A_GUEST')
  })
})

describe('UsersService reads and housekeeping', () => {
  it('get throws USER_NOT_FOUND for an unknown user', async () => {
    const { service } = setup()

    const error = await errorOf(service.get('nobody'))

    expect(error).toBeInstanceOf(NotFoundError)
    expect(error.code).toBe('USER_NOT_FOUND')
  })

  it('findByIdentifier returns null when nobody owns it', async () => {
    const { service } = setup()

    expect(await service.findByIdentifier(email('nobody'))).toBeNull()
  })

  it('bumpTokenVersion returns the new version', async () => {
    const { service } = setup()
    const guest = await service.guestForDevice('dev-1', 'ios')

    expect(await service.bumpTokenVersion(guest.id)).toBe(1)
    expect(await service.bumpTokenVersion(guest.id)).toBe(2)
  })

  it('bumpTokenVersion throws NotFoundError for an unknown user', async () => {
    const { service } = setup()

    expect(await errorOf(service.bumpTokenVersion('nobody'))).toBeInstanceOf(NotFoundError)
  })

  it('touch records the current time as lastSeenAt', async () => {
    const { service, advance } = setup()
    const guest = await service.guestForDevice('dev-1', 'ios')
    advance(9 * MINUTE)

    await service.touch(guest.id)

    expect((await service.get(guest.id)).lastSeenAt.getTime()).toBe(T0.getTime() + 9 * MINUTE)
  })

  it('unlinkDevices detaches the device so it gets a new guest next time', async () => {
    const { service } = setup()
    const guest = await service.guestForDevice('dev-1', 'ios')

    expect(await service.unlinkDevices(guest.id)).toBe(1)

    expect((await service.guestForDevice('dev-1', 'ios')).id).not.toBe(guest.id)
  })
})
