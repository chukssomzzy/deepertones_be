import { describe, expect, it } from 'vitest'
import { checkPushReceiptsSpec, NOTIFICATION_KINDS, sendPushSpec } from './notifications.job-specs'

const FINISHED = { kind: 'scan-finished', userId: 'user-1', profileId: 'profile-1', scanId: 'scan-1', readyCount: 3 }
const NEEDS_YOU = { kind: 'scan-needs-you', userId: 'user-1', profileId: 'profile-1', scanId: 'scan-1', itemId: 'item-1', need: 'back-photo' }
// The one instant the fixtures hang off.
const SIGNED_IN_AT = Date.parse('2030-06-15T12:00:00.000Z')
const SIGN_IN = { kind: 'new-sign-in', userId: 'user-1', platform: 'ios', eventId: 'event-1', at: SIGNED_IN_AT }

describe('the send-push job', () => {
  it('is named send-push on the push-delivery queue and retries like OTP delivery', () => {
    expect(sendPushSpec.name).toBe('send-push')
    expect(sendPushSpec.queue).toBe('push-delivery')
    expect(sendPushSpec.retry).toEqual({ baseSeconds: 5, factor: 3, capSeconds: 135 })
  })

  it('names the three notification kinds', () => {
    expect([...NOTIFICATION_KINDS].sort()).toEqual(['new-sign-in', 'scan-finished', 'scan-needs-you'])
  })

  it.each([
    ['scan-finished', FINISHED],
    ['scan-finished with nothing ready (the boundary: 0 is allowed)', { ...FINISHED, readyCount: 0 }],
    ['scan-needs-you for a back photo', NEEDS_YOU],
    ['scan-needs-you to confirm', { ...NEEDS_YOU, need: 'confirm' }],
    ['scan-needs-you asking again', { ...NEEDS_YOU, ask: 2 }],
    ['new-sign-in on iOS', SIGN_IN],
    ['new-sign-in on Android', { ...SIGN_IN, platform: 'android' }],
    ['new-sign-in from an unknown platform', { ...SIGN_IN, platform: null }],
  ])('accepts a %s body', (_name, body) => {
    expect(sendPushSpec.schema.safeParse(body).success).toBe(true)
  })

  it.each([
    ['a negative ready count (the boundary: -1)', { ...FINISHED, readyCount: -1 }],
    ['a fractional ready count', { ...FINISHED, readyCount: 1.5 }],
    ['a need that is not back-photo or confirm', { ...NEEDS_YOU, need: 'retake' }],
    ['a needs-you body with no item', { ...NEEDS_YOU, itemId: undefined }],
    ['a platform that is not ios, android or null', { ...SIGN_IN, platform: 'windows' }],
    ['a sign-in body with no event id', { ...SIGN_IN, eventId: undefined }],
    ['a sign-in body with no time', { ...SIGN_IN, at: undefined }],
    ['a sign-in body with a fractional time', { ...SIGN_IN, at: 1.5 }],
    ['a sign-in body with a time that is not a number', { ...SIGN_IN, at: 'later' }],
    ['a kind that does not exist', { ...FINISHED, kind: 'marketing' }],
    ['a body with no kind', { userId: 'user-1' }],
  ])('rejects %s', (_name, body) => {
    expect(sendPushSpec.schema.safeParse(body).success).toBe(false)
  })

  it('derives the idempotency key from the body alone, so a repeated message repeats the key', () => {
    expect(sendPushSpec.key(FINISHED as never)).toBe('scan-finished:scan-1')
    expect(sendPushSpec.key({ ...FINISHED } as never)).toBe(sendPushSpec.key(FINISHED as never))
    expect(sendPushSpec.key(SIGN_IN as never)).toBe('new-sign-in:event-1')
  })

  it('keys a needs-you message by scan and need, so ten items needing a back photo are one notification', () => {
    expect(sendPushSpec.key(NEEDS_YOU as never)).toBe('scan-needs-you:scan-1:back-photo')
    expect(sendPushSpec.key({ ...NEEDS_YOU, itemId: 'item-2' } as never)).toBe('scan-needs-you:scan-1:back-photo')
    expect(sendPushSpec.key({ ...NEEDS_YOU, need: 'confirm' } as never)).toBe('scan-needs-you:scan-1:confirm')
  })

  it('keys a re-ask by scan, item and ask number, and treats ask 0 as the first ask (the boundary: 0 and 1)', () => {
    expect(sendPushSpec.key({ ...NEEDS_YOU, ask: 0 } as never)).toBe('scan-needs-you:scan-1:back-photo')
    expect(sendPushSpec.key({ ...NEEDS_YOU, ask: 1 } as never)).toBe('scan-needs-you:scan-1:item-1:ask-1')
    expect(sendPushSpec.key({ ...NEEDS_YOU, ask: 2 } as never)).toBe('scan-needs-you:scan-1:item-1:ask-2')
  })
})

describe('the check-push-receipts job', () => {
  const RECEIPT = { ticketId: 'ticket-1', deviceHash: 'device-hash-1', tokenHash: 'a'.repeat(64) }

  it('is named check-push-receipts on its own push-receipts queue', () => {
    expect(checkPushReceiptsSpec.name).toBe('check-push-receipts')
    expect(checkPushReceiptsSpec.queue).toBe('push-receipts')
  })

  it('accepts ticket ids with the device hash and the hash of the token they were sent to', () => {
    expect(checkPushReceiptsSpec.schema.safeParse({ receipts: [RECEIPT, { ...RECEIPT, ticketId: 'ticket-2' }] }).success).toBe(true)
  })

  it.each([
    ['a receipt with no token hash', { receipts: [{ ticketId: 'ticket-1', deviceHash: 'device-hash-1' }] }],
    ['a receipt with no device hash', { receipts: [{ ticketId: 'ticket-1', tokenHash: 'a'.repeat(64) }] }],
    ['a body with no receipts', {}],
  ])('rejects %s', (_name, body) => {
    expect(checkPushReceiptsSpec.schema.safeParse(body).success).toBe(false)
  })

  it('never lets a push token into the message: a token field on a receipt is dropped by the schema', () => {
    const parsed = checkPushReceiptsSpec.schema.parse({ receipts: [{ ...RECEIPT, token: 'ExponentPushToken[leaky]' }] })

    expect(JSON.stringify(parsed)).not.toContain('ExponentPushToken')
  })

  it('has one key for one body, and a different key when the tickets differ', () => {
    const body = { receipts: [RECEIPT] }

    expect(checkPushReceiptsSpec.key(body)).toBe(checkPushReceiptsSpec.key({ receipts: [{ ...RECEIPT }] }))
    expect(checkPushReceiptsSpec.key(body)).not.toBe(checkPushReceiptsSpec.key({ receipts: [{ ...RECEIPT, ticketId: 'ticket-2' }] }))
  })
})
