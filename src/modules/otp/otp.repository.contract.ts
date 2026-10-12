import { describe, expect, it } from 'vitest'
import type { EmailAddress } from '../../lib/email-address'
import type { PhoneNumber } from '../../lib/phone'
import type { OtpChallenge, OtpRepository } from './otp.repository'
import type { OtpRecipient } from './otp.types'

const BASE = new Date('2030-06-15T12:00:00.000Z')
const at = (offsetMs: number) => new Date(BASE.getTime() + offsetMs)
const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const MAX = 5

// Each call yields a number no other test (or earlier run against a shared D1) uses.
const runSalt = String(Math.floor(Math.random() * 1e5)).padStart(5, '0')
let counter = 0
const freshPhone = (): OtpRecipient => ({
  channel: 'whatsapp',
  address: `+234809${runSalt}${String(counter++).padStart(2, '0')}` as PhoneNumber,
})
const freshEmail = (): OtpRecipient => ({
  channel: 'email',
  address: `user-${runSalt}-${counter++}@example.com` as EmailAddress,
})

const challenge = (recipient: OtpRecipient, createdAt: Date, overrides: Partial<Omit<OtpChallenge, 'channel' | 'address'>> = {}) => ({
  id: crypto.randomUUID(),
  ...recipient,
  codeHash: 'a'.repeat(64),
  createdAt,
  expiresAt: new Date(createdAt.getTime() + 10 * MINUTE),
  ...overrides,
})

/**
 * Behaviour every OtpRepository must have. Runs against the fake (unit tier) and against
 * real local D1 (integration tier). Each test owns its phone numbers, so order never matters.
 */
export const otpRepositoryContract = (name: string, make: () => OtpRepository | Promise<OtpRepository>) => {
  describe(`OtpRepository contract: ${name}`, () => {
    it('findLatest returns null for a recipient with no challenges', async () => {
      const repo = await make()

      expect(await repo.findLatest(freshPhone())).toBeNull()
    })

    it('round-trips every field of a created challenge', async () => {
      const repo = await make()
      const who = freshPhone()
      const created = challenge(who, BASE, { codeHash: 'b'.repeat(64) })

      await repo.create(created)
      const found = await repo.findLatest(who)

      expect(found).not.toBeNull()
      expect(found!.id).toBe(created.id)
      expect(found!.channel).toBe(who.channel)
      expect(found!.address).toBe(who.address)
      expect(found!.codeHash).toBe(created.codeHash)
      expect(found!.createdAt.getTime()).toBe(created.createdAt.getTime())
      expect(found!.expiresAt.getTime()).toBe(created.expiresAt.getTime())
      expect(found!.attempts).toBe(0)
      expect(found!.consumedAt).toBeNull()
    })

    it('findLatest returns the most recently created challenge, in any insertion order', async () => {
      const repo = await make()
      const who = freshPhone()
      const oldest = challenge(who, at(0))
      const newest = challenge(who, at(2 * MINUTE))
      const middle = challenge(who, at(MINUTE))

      await repo.create(oldest)
      await repo.create(newest)
      await repo.create(middle)

      expect((await repo.findLatest(who))!.id).toBe(newest.id)
    })

    it('findLatest returns the newest challenge even when it is consumed', async () => {
      const repo = await make()
      const who = freshPhone()
      await repo.create(challenge(who, at(0)))
      const newest = challenge(who, at(MINUTE))
      await repo.create(newest)
      await repo.consume(newest.id, at(2 * MINUTE), MAX)

      const found = await repo.findLatest(who)

      expect(found!.id).toBe(newest.id)
      expect(found!.consumedAt!.getTime()).toBe(at(2 * MINUTE).getTime())
    })

    it('findLatest returns the challenge created last when two share the same createdAt', async () => {
      const repo = await make()
      const who = freshPhone()
      const first = challenge(who, BASE)
      const second = challenge(who, BASE)

      await repo.create(first)
      await repo.create(second)

      expect((await repo.findLatest(who))!.id).toBe(second.id)
    })

    it('keeps different phone numbers isolated', async () => {
      const repo = await make()
      const a = freshPhone()
      const b = freshPhone()
      const forA = challenge(a, at(0))
      const forB = challenge(b, at(MINUTE))
      await repo.create(forA)
      await repo.create(forB)

      expect((await repo.findLatest(a))!.id).toBe(forA.id)
      expect((await repo.findLatest(b))!.id).toBe(forB.id)
      expect(await repo.sendTimes(a, at(-HOUR))).toHaveLength(1)
    })

    it('sendTimes returns creation times at or after since, newest first', async () => {
      const repo = await make()
      const who = freshPhone()
      for (const offset of [0, 10 * MINUTE, 5 * MINUTE, 20 * MINUTE]) {
        await repo.create(challenge(who, at(offset)))
      }

      const times = await repo.sendTimes(who, at(5 * MINUTE))

      expect(times.map((d: Date) => d.getTime())).toEqual([at(20 * MINUTE), at(10 * MINUTE), at(5 * MINUTE)].map((d: Date) => d.getTime()))
    })

    it('sendTimes excludes a challenge created one millisecond before since', async () => {
      const repo = await make()
      const who = freshPhone()
      await repo.create(challenge(who, at(-1)))

      expect(await repo.sendTimes(who, at(0))).toEqual([])
    })

    it('sendTimes is empty for a recipient with no challenges', async () => {
      const repo = await make()

      expect(await repo.sendTimes(freshPhone(), at(-HOUR))).toEqual([])
    })

    it('create purges the challenges of that recipient older than 24h before the new one, and keeps the rest', async () => {
      const repo = await make()
      const who = freshPhone()
      const other = freshPhone()
      const now = at(48 * HOUR)
      await repo.create(challenge(who, new Date(now.getTime() - 24 * HOUR - 1)))
      await repo.create(challenge(who, new Date(now.getTime() - 24 * HOUR)))
      await repo.create(challenge(other, new Date(now.getTime() - 30 * HOUR)))
      const since = new Date(now.getTime() - 48 * HOUR)
      expect(await repo.sendTimes(who, since)).toHaveLength(2)

      await repo.create(challenge(who, now))

      const remaining = (await repo.sendTimes(who, since)).map((d: Date) => d.getTime())
      expect(remaining).toEqual([now.getTime(), now.getTime() - 24 * HOUR])
      expect(await repo.sendTimes(other, since)).toHaveLength(1)
    })

    it('round-trips an email challenge with its channel and address', async () => {
      const repo = await make()
      const who = freshEmail()
      const created = challenge(who, BASE)

      await repo.create(created)

      expect(await repo.findLatest(who)).toMatchObject({ id: created.id, channel: 'email', address: who.address })
      expect(await repo.findById(created.id)).toMatchObject({ channel: 'email', address: who.address })
    })

    it('keeps two different emails isolated', async () => {
      const repo = await make()
      const a = freshEmail()
      const b = freshEmail()
      const forA = challenge(a, at(0))
      const forB = challenge(b, at(MINUTE))
      await repo.create(forA)
      await repo.create(forB)

      expect((await repo.findLatest(a))!.id).toBe(forA.id)
      expect((await repo.findLatest(b))!.id).toBe(forB.id)
      expect(await repo.sendTimes(a, at(-HOUR))).toHaveLength(1)
      expect(await repo.sendTimes(b, at(-HOUR))).toHaveLength(1)
    })

    describe('the same address string on different channels', () => {
      // Not a real-world collision (a phone is never an email); it pins that BOTH columns are part of the key.
      const sameAddress = () => {
        const address = freshEmail().address as string
        return {
          email: { channel: 'email', address } as unknown as OtpRecipient,
          whatsapp: { channel: 'whatsapp', address } as unknown as OtpRecipient,
        }
      }

      it('findLatest does not cross channels', async () => {
        const repo = await make()
        const { email, whatsapp } = sameAddress()
        const forEmail = challenge(email, at(0))
        await repo.create(forEmail)

        expect(await repo.findLatest(whatsapp)).toBeNull()

        const forWhatsapp = challenge(whatsapp, at(-MINUTE))
        await repo.create(forWhatsapp)
        expect((await repo.findLatest(email))!.id).toBe(forEmail.id)
        expect((await repo.findLatest(whatsapp))!.id).toBe(forWhatsapp.id)
      })

      it('sendTimes does not cross channels', async () => {
        const repo = await make()
        const { email, whatsapp } = sameAddress()
        await repo.create(challenge(email, at(0)))
        await repo.create(challenge(email, at(MINUTE)))
        await repo.create(challenge(whatsapp, at(2 * MINUTE)))

        expect(await repo.sendTimes(email, at(-HOUR))).toHaveLength(2)
        expect(await repo.sendTimes(whatsapp, at(-HOUR))).toHaveLength(1)
      })

      it('create purges only the challenges of its own channel', async () => {
        const repo = await make()
        const { email, whatsapp } = sameAddress()
        const now = at(48 * HOUR)
        await repo.create(challenge(email, new Date(now.getTime() - 30 * HOUR)))
        await repo.create(challenge(whatsapp, new Date(now.getTime() - 30 * HOUR)))
        const since = new Date(now.getTime() - 48 * HOUR)

        await repo.create(challenge(email, now))

        expect(await repo.sendTimes(email, since)).toHaveLength(1)
        expect(await repo.sendTimes(whatsapp, since)).toHaveLength(1)
      })
    })

    it('recordFailedAttempt increments up to the max, then returns null', async () => {
      const repo = await make()
      const who = freshPhone()
      const c = challenge(who, BASE)
      await repo.create(c)

      expect(await repo.recordFailedAttempt(c.id, 3)).toBe(1)
      expect(await repo.recordFailedAttempt(c.id, 3)).toBe(2)
      expect(await repo.recordFailedAttempt(c.id, 3)).toBe(3)
      expect(await repo.recordFailedAttempt(c.id, 3)).toBeNull()
      expect((await repo.findLatest(who))!.attempts).toBe(3)
    })

    it('recordFailedAttempt returns null for an unknown id', async () => {
      const repo = await make()

      expect(await repo.recordFailedAttempt(crypto.randomUUID(), 5)).toBeNull()
    })

    it('consume succeeds once, then reports false', async () => {
      const repo = await make()
      const who = freshPhone()
      const c = challenge(who, BASE)
      await repo.create(c)

      expect(await repo.consume(c.id, at(MINUTE), MAX)).toBe(true)
      expect(await repo.consume(c.id, at(2 * MINUTE), MAX)).toBe(false)
      expect((await repo.findLatest(who))!.consumedAt!.getTime()).toBe(at(MINUTE).getTime())
    })

    it('consume is refused once the attempts have reached the max, and leaves the challenge unconsumed', async () => {
      const repo = await make()
      const who = freshPhone()
      const c = challenge(who, BASE)
      await repo.create(c)
      for (let i = 0; i < MAX; i++) await repo.recordFailedAttempt(c.id, MAX)

      expect(await repo.consume(c.id, at(MINUTE), MAX)).toBe(false)
      expect((await repo.findLatest(who))!.consumedAt).toBeNull()
    })

    it('consume succeeds with one attempt left', async () => {
      const repo = await make()
      const c = challenge(freshPhone(), BASE)
      await repo.create(c)
      for (let i = 0; i < MAX - 1; i++) await repo.recordFailedAttempt(c.id, MAX)

      expect(await repo.consume(c.id, at(MINUTE), MAX)).toBe(true)
    })

    it('consume is refused at the exact expiry time but allowed one millisecond before', async () => {
      const repo = await make()
      const who = freshPhone()
      const c = challenge(who, BASE)
      await repo.create(c)

      expect(await repo.consume(c.id, c.expiresAt, MAX)).toBe(false)
      expect((await repo.findLatest(who))!.consumedAt).toBeNull()
      expect(await repo.consume(c.id, new Date(c.expiresAt.getTime() - 1), MAX)).toBe(true)
    })

    it('consume succeeds once when unconsumed, under the attempt cap and before expiry, then is refused', async () => {
      const repo = await make()
      const c = challenge(freshPhone(), BASE)
      await repo.create(c)
      await repo.recordFailedAttempt(c.id, MAX)

      expect(await repo.consume(c.id, at(MINUTE), MAX)).toBe(true)
      expect(await repo.consume(c.id, at(MINUTE), MAX)).toBe(false)
    })

    it('consume returns false for an unknown id', async () => {
      const repo = await make()

      expect(await repo.consume(crypto.randomUUID(), BASE, MAX)).toBe(false)
    })

    it('create stores a challenge as queued, with no failure reason and no delivery time', async () => {
      const repo = await make()
      const c = challenge(freshPhone(), BASE)

      await repo.create(c)

      expect(await repo.findById(c.id)).toMatchObject({
        id: c.id,
        channel: c.channel,
        address: c.address,
        deliveryStatus: 'queued',
        failureReason: null,
        deliveredAt: null,
      })
    })

    it('findById returns null for an unknown id', async () => {
      const repo = await make()

      expect(await repo.findById(crypto.randomUUID())).toBeNull()
    })

    it('findById finds a challenge that is not the latest for its recipient', async () => {
      const repo = await make()
      const who = freshPhone()
      const older = challenge(who, at(0))
      await repo.create(older)
      await repo.create(challenge(who, at(MINUTE)))

      expect((await repo.findById(older.id))!.id).toBe(older.id)
    })

    it('markDelivered moves queued to delivered once, recording when', async () => {
      const repo = await make()
      const c = challenge(freshPhone(), BASE)
      await repo.create(c)

      expect(await repo.markDelivered(c.id, at(SECOND))).toBe(true)
      expect(await repo.markDelivered(c.id, at(2 * SECOND))).toBe(false)

      const found = await repo.findById(c.id)
      expect(found).toMatchObject({ deliveryStatus: 'delivered', failureReason: null })
      expect(found!.deliveredAt!.getTime()).toBe(at(SECOND).getTime())
    })

    it('markDelivered returns false for an unknown id and for a failed challenge', async () => {
      const repo = await make()
      const c = challenge(freshPhone(), BASE)
      await repo.create(c)
      await repo.markFailed(c.id, 'unavailable')

      expect(await repo.markDelivered(c.id, at(SECOND))).toBe(false)
      expect(await repo.markDelivered(crypto.randomUUID(), at(SECOND))).toBe(false)
      expect((await repo.findById(c.id))!.deliveryStatus).toBe('failed')
    })

    it.each(['recipient-rejected', 'unavailable'] as const)('markFailed moves queued to failed with reason %s, once', async (reason) => {
      const repo = await make()
      const c = challenge(freshPhone(), BASE)
      await repo.create(c)

      expect(await repo.markFailed(c.id, reason)).toBe(true)
      expect(await repo.markFailed(c.id, 'unavailable')).toBe(false)

      expect(await repo.findById(c.id)).toMatchObject({ deliveryStatus: 'failed', failureReason: reason, deliveredAt: null })
    })

    it('markFailed never overrides a delivered challenge', async () => {
      const repo = await make()
      const c = challenge(freshPhone(), BASE)
      await repo.create(c)
      await repo.markDelivered(c.id, at(SECOND))

      expect(await repo.markFailed(c.id, 'unavailable')).toBe(false)
      expect(await repo.findById(c.id)).toMatchObject({ deliveryStatus: 'delivered', failureReason: null })
    })

    it('markFailed returns false for an unknown id', async () => {
      const repo = await make()

      expect(await repo.markFailed(crypto.randomUUID(), 'unavailable')).toBe(false)
    })

    it('sendTimes leaves out only challenges that failed as unavailable', async () => {
      const repo = await make()
      const who = freshPhone()
      const queued = challenge(who, at(0))
      const delivered = challenge(who, at(MINUTE))
      const rejected = challenge(who, at(2 * MINUTE))
      const unavailable = challenge(who, at(3 * MINUTE))
      for (const c of [queued, delivered, rejected, unavailable]) await repo.create(c)
      await repo.markDelivered(delivered.id, at(4 * MINUTE))
      await repo.markFailed(rejected.id, 'recipient-rejected')
      await repo.markFailed(unavailable.id, 'unavailable')

      const times = await repo.sendTimes(who, at(-HOUR))

      expect(times.map((d: Date) => d.getTime())).toEqual([at(2 * MINUTE), at(MINUTE), at(0)].map((d) => d.getTime()))
    })
  })
}
