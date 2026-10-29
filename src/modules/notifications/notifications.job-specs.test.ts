import { describe, expect, it } from 'vitest'
import { REJECTED_PHOTO_REASONS } from '../../providers/perfect-corp/perfect-corp.provider'
import { checkPushReceiptsSpec, NOTIFICATION_KINDS, sendPushSpec } from './notifications.job-specs'

const FINISHED = { kind: 'scan-finished', userId: 'user-1', profileId: 'profile-1', scanId: 'scan-1', readyCount: 3 }
const NEEDS_YOU = { kind: 'scan-needs-you', userId: 'user-1', profileId: 'profile-1', scanId: 'scan-1', itemId: 'item-1', need: 'back-photo' }
// The one instant the fixtures hang off.
const SIGNED_IN_AT = Date.parse('2030-06-15T12:00:00.000Z')
const SIGN_IN = { kind: 'new-sign-in', userId: 'user-1', platform: 'ios', eventId: 'event-1', at: SIGNED_IN_AT }
const FACE_READY = { kind: 'face-scan-ready', userId: 'user-1', profileId: 'profile-1', faceScanId: 'face-1' }
// The instant a face scan went to needs-retake, and one minute after it (a second rejection of the same scan).
const RETAKE_AT = SIGNED_IN_AT
const SECOND_RETAKE_AT = SIGNED_IN_AT + 60 * 1000
// The check-in-due push names the chase by its day-one scan: ids only, like every push (issue #145).
const CHECK_IN_DUE = { kind: 'face-check-in-due', userId: 'user-1', profileId: 'profile-1', dayOneScanId: 'day-one-1' }
// The routine reminder belongs to a profile, not an account: no user id. `day` is the profile's local day and `time` the reminder's, which is what the Done action posts to the check-in route.
const ROUTINE_REMINDER = { kind: 'routine-reminder', profileId: 'profile-1', day: '2030-06-15', time: 'morning', title: 'Cleanser, Moisturiser, Sunscreen' }
// The step-down alert (#217 PR 4c) belongs to a profile and carries its text like the routine reminder: one change per step-down whose step begins that local day, each a routine title and the fixed line.
const STEP_DOWN_ALERT = { kind: 'step-down-alert', profileId: 'profile-1', day: '2030-06-15', changes: [{ title: 'Cream', line: 'From today: use it every other day' }] }
// The missed-days nudge carries the first day of the missed run (`since`), which is what makes it once per run.
const MISSED_DAYS_NUDGE = { kind: 'missed-days-nudge', profileId: 'profile-1', since: '2030-06-13' }
const FACE_RETAKE = { kind: 'face-scan-needs-retake', userId: 'user-1', profileId: 'profile-1', faceScanId: 'face-1', reason: 'too-dark', at: RETAKE_AT }

describe('the send-push job', () => {
  it('is named send-push on the push-delivery queue and retries like OTP delivery', () => {
    expect(sendPushSpec.name).toBe('send-push')
    expect(sendPushSpec.queue).toBe('push-delivery')
    expect(sendPushSpec.retry).toEqual({ baseSeconds: 5, factor: 3, capSeconds: 135 })
  })

  it('names the ten notification kinds', () => {
    expect([...NOTIFICATION_KINDS].sort()).toEqual(['face-check-in-due', 'face-scan-needs-retake', 'face-scan-ready', 'missed-days-nudge', 'new-sign-in', 'pause-check-in', 'routine-reminder', 'scan-finished', 'scan-needs-you', 'step-down-alert'])
  })

  it.each([
    ['scan-finished', FINISHED],
    ['scan-finished with nothing ready (the boundary: 0 is allowed)', { ...FINISHED, readyCount: 0 }],
    ['scan-needs-you for a back photo', NEEDS_YOU],
    ['scan-needs-you to confirm', { ...NEEDS_YOU, need: 'confirm' }],
    ['scan-needs-you to identify a product', { ...NEEDS_YOU, need: 'identify' }],
    ['scan-needs-you asking again', { ...NEEDS_YOU, ask: 2 }],
    ['new-sign-in on iOS', SIGN_IN],
    ['new-sign-in on Android', { ...SIGN_IN, platform: 'android' }],
    ['new-sign-in from an unknown platform', { ...SIGN_IN, platform: null }],
  ])('accepts a %s body', (_name, body) => {
    expect(sendPushSpec.schema.safeParse(body).success).toBe(true)
  })

  it('accepts a face-scan-ready body', () => {
    expect(sendPushSpec.schema.safeParse(FACE_READY).success).toBe(true)
  })

  it.each(['morning', 'evening'])('accepts a routine-reminder body for the %s', (time) => {
    expect(sendPushSpec.schema.safeParse({ ...ROUTINE_REMINDER, time }).success).toBe(true)
  })

  it('accepts a routine-reminder title of 1 and of 200 characters', () => {
    expect(sendPushSpec.schema.safeParse({ ...ROUTINE_REMINDER, title: 'x' }).success).toBe(true)
    expect(sendPushSpec.schema.safeParse({ ...ROUTINE_REMINDER, title: 'x'.repeat(200) }).success).toBe(true)
  })

  it('accepts a step-down-alert body with one change and with several, and a missed-days-nudge body', () => {
    expect(sendPushSpec.schema.safeParse(STEP_DOWN_ALERT).success).toBe(true)
    expect(sendPushSpec.schema.safeParse({ ...STEP_DOWN_ALERT, changes: [...STEP_DOWN_ALERT.changes, { title: 'Gel cleanser', line: 'From today: stop using it' }] }).success).toBe(true)
    expect(sendPushSpec.schema.safeParse(MISSED_DAYS_NUDGE).success).toBe(true)
  })

  it('accepts a face-check-in-due body', () => {
    expect(sendPushSpec.schema.safeParse(CHECK_IN_DUE).success).toBe(true)
  })

  it.each(REJECTED_PHOTO_REASONS)('accepts a face-scan-needs-retake body for the reason %s', (reason) => {
    expect(sendPushSpec.schema.safeParse({ ...FACE_RETAKE, reason }).success).toBe(true)
  })

  it.each([
    ['a negative ready count (the boundary: -1)', { ...FINISHED, readyCount: -1 }],
    ['a fractional ready count', { ...FINISHED, readyCount: 1.5 }],
    ['a need that is not back-photo, confirm or identify', { ...NEEDS_YOU, need: 'retake' }],
    ['a needs-you body with no item', { ...NEEDS_YOU, itemId: undefined }],
    ['a platform that is not ios, android or null', { ...SIGN_IN, platform: 'windows' }],
    ['a sign-in body with no event id', { ...SIGN_IN, eventId: undefined }],
    ['a sign-in body with no time', { ...SIGN_IN, at: undefined }],
    ['a sign-in body with a fractional time', { ...SIGN_IN, at: 1.5 }],
    ['a sign-in body with a time that is not a number', { ...SIGN_IN, at: 'later' }],
    ['a face-scan-ready body with no face scan id', { ...FACE_READY, faceScanId: undefined }],
    ['a face-scan-ready body with no profile id', { ...FACE_READY, profileId: undefined }],
    ['a face-scan-needs-retake body with a reason that is not one of the photo reasons', { ...FACE_RETAKE, reason: 'blurry' }],
    ['a face-scan-needs-retake body with a failure reason (unavailable is not a retake reason)', { ...FACE_RETAKE, reason: 'unavailable' }],
    ['a face-scan-needs-retake body with no reason', { ...FACE_RETAKE, reason: undefined }],
    ['a face-scan-needs-retake body with no time', { ...FACE_RETAKE, at: undefined }],
    ['a face-scan-needs-retake body with a time that is not a number', { ...FACE_RETAKE, at: 'later' }],
    ['a face-scan-needs-retake body with no face scan id', { ...FACE_RETAKE, faceScanId: undefined }],
    ['a face-check-in-due body with no day-one scan id', { ...CHECK_IN_DUE, dayOneScanId: undefined }],
    ['a face-check-in-due body with no profile id', { ...CHECK_IN_DUE, profileId: undefined }],
    ['a face-check-in-due body with no user id', { ...CHECK_IN_DUE, userId: undefined }],
    ['a routine-reminder body with a time that is not morning or evening', { ...ROUTINE_REMINDER, time: 'noon' }],
    ['a routine-reminder body with no time', { ...ROUTINE_REMINDER, time: undefined }],
    ['a routine-reminder body with no day', { ...ROUTINE_REMINDER, day: undefined }],
    ['a routine-reminder body with no profile id', { ...ROUTINE_REMINDER, profileId: undefined }],
    ['a routine-reminder body with no title', { ...ROUTINE_REMINDER, title: undefined }],
    ['a routine-reminder body with an empty title', { ...ROUTINE_REMINDER, title: '' }],
    ['a routine-reminder body with a title over 200 characters', { ...ROUTINE_REMINDER, title: 'x'.repeat(201) }],
    ['a step-down-alert body with no changes (an alert with nothing to say is never queued)', { ...STEP_DOWN_ALERT, changes: [] }],
    ['a step-down-alert body with no changes field', { ...STEP_DOWN_ALERT, changes: undefined }],
    ['a step-down-alert change with no title', { ...STEP_DOWN_ALERT, changes: [{ line: 'From today: stop using it' }] }],
    ['a step-down-alert change with an empty title', { ...STEP_DOWN_ALERT, changes: [{ title: '', line: 'From today: stop using it' }] }],
    ['a step-down-alert change with no line', { ...STEP_DOWN_ALERT, changes: [{ title: 'Cream' }] }],
    ['a step-down-alert change with an empty line', { ...STEP_DOWN_ALERT, changes: [{ title: 'Cream', line: '' }] }],
    ['a step-down-alert body with no day', { ...STEP_DOWN_ALERT, day: undefined }],
    ['a step-down-alert body with no profile id', { ...STEP_DOWN_ALERT, profileId: undefined }],
    ['a missed-days-nudge body with no since', { ...MISSED_DAYS_NUDGE, since: undefined }],
    ['a missed-days-nudge body with no profile id', { ...MISSED_DAYS_NUDGE, profileId: undefined }],
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

  it('keys a step-down alert by profile and local day, so a repeat is one alert, and two days or two profiles are two', () => {
    expect(sendPushSpec.key(STEP_DOWN_ALERT as never)).toBe('step-down-alert:profile-1:2030-06-15')
    expect(sendPushSpec.key({ ...STEP_DOWN_ALERT, changes: [{ title: 'Serum', line: 'From today: stop using it' }] } as never)).toBe('step-down-alert:profile-1:2030-06-15')
    expect(sendPushSpec.key({ ...STEP_DOWN_ALERT, day: '2030-06-16' } as never)).toBe('step-down-alert:profile-1:2030-06-16')
    expect(sendPushSpec.key({ ...STEP_DOWN_ALERT, profileId: 'profile-2' } as never)).toBe('step-down-alert:profile-2:2030-06-15')
  })

  it('keys a missed-days nudge by profile and the first day of the run, so one run of missed days is one nudge however many mornings it spans, and a new run is a new one', () => {
    expect(sendPushSpec.key(MISSED_DAYS_NUDGE as never)).toBe('missed-days-nudge:profile-1:2030-06-13')
    expect(sendPushSpec.key({ ...MISSED_DAYS_NUDGE, since: '2030-06-20' } as never)).toBe('missed-days-nudge:profile-1:2030-06-20')
    expect(sendPushSpec.key({ ...MISSED_DAYS_NUDGE, profileId: 'profile-2' } as never)).toBe('missed-days-nudge:profile-2:2030-06-13')
  })

  it('keys a needs-you message by scan and need, so ten items needing a back photo are one notification', () => {
    expect(sendPushSpec.key(NEEDS_YOU as never)).toBe('scan-needs-you:scan-1:back-photo')
    expect(sendPushSpec.key({ ...NEEDS_YOU, itemId: 'item-2' } as never)).toBe('scan-needs-you:scan-1:back-photo')
    expect(sendPushSpec.key({ ...NEEDS_YOU, need: 'confirm' } as never)).toBe('scan-needs-you:scan-1:confirm')
  })

  it('keys an identify message by scan and need, so ten items to identify are one notification, apart from a back-photo ask and a confirmation', () => {
    const identify = { ...NEEDS_YOU, need: 'identify' }

    expect(sendPushSpec.key(identify as never)).toBe('scan-needs-you:scan-1:identify')
    expect(sendPushSpec.key({ ...identify, itemId: 'item-2' } as never)).toBe('scan-needs-you:scan-1:identify')
    expect(sendPushSpec.key({ ...identify, scanId: 'scan-2' } as never)).toBe('scan-needs-you:scan-2:identify')
  })

  it('keys a re-ask by scan, item and ask number, and treats ask 0 as the first ask (the boundary: 0 and 1)', () => {
    expect(sendPushSpec.key({ ...NEEDS_YOU, ask: 0 } as never)).toBe('scan-needs-you:scan-1:back-photo')
    expect(sendPushSpec.key({ ...NEEDS_YOU, ask: 1 } as never)).toBe('scan-needs-you:scan-1:item-1:ask-1')
    expect(sendPushSpec.key({ ...NEEDS_YOU, ask: 2 } as never)).toBe('scan-needs-you:scan-1:item-1:ask-2')
  })
})

describe('the send-push job: face scan keys', () => {
  it('keys a face-scan-ready message by the face scan alone, so a scan that becomes ready once is one notification', () => {
    expect(sendPushSpec.key(FACE_READY as never)).toBe('face-scan-ready:face-1')
    expect(sendPushSpec.key({ ...FACE_READY } as never)).toBe(sendPushSpec.key(FACE_READY as never))
    expect(sendPushSpec.key({ ...FACE_READY, faceScanId: 'face-2' } as never)).toBe('face-scan-ready:face-2')
  })

  it('keys a face-scan-needs-retake message by the face scan and the instant of the transition', () => {
    expect(sendPushSpec.key(FACE_RETAKE as never)).toBe(`face-scan-needs-retake:face-1:${RETAKE_AT}`)
    expect(sendPushSpec.key({ ...FACE_RETAKE } as never)).toBe(sendPushSpec.key(FACE_RETAKE as never))
  })

  it('gives each rejection of one face scan its own key, because retakes are unlimited and every rejection is its own notification', () => {
    expect(sendPushSpec.key({ ...FACE_RETAKE, at: SECOND_RETAKE_AT } as never)).toBe(`face-scan-needs-retake:face-1:${SECOND_RETAKE_AT}`)
    expect(sendPushSpec.key({ ...FACE_RETAKE, at: SECOND_RETAKE_AT } as never)).not.toBe(sendPushSpec.key(FACE_RETAKE as never))
  })

  it('keeps the key of a needs-retake message apart from its ready key and from another scan\'s', () => {
    expect(sendPushSpec.key({ ...FACE_RETAKE, faceScanId: 'face-2' } as never)).toBe(`face-scan-needs-retake:face-2:${RETAKE_AT}`)
    expect(sendPushSpec.key(FACE_RETAKE as never)).not.toBe(sendPushSpec.key(FACE_READY as never))
  })

  it('does not key a needs-retake message by its reason: the same rejection instant is the same notification', () => {
    expect(sendPushSpec.key({ ...FACE_RETAKE, reason: 'no-face' } as never)).toBe(sendPushSpec.key(FACE_RETAKE as never))
  })
})

describe('the send-push job: check-in due key', () => {
  it('keys a check-in-due message by the chase\'s day-one scan alone, so a chase is one notification however often it is queued', () => {
    expect(sendPushSpec.key(CHECK_IN_DUE as never)).toBe('face-check-in-due:day-one-1')
    expect(sendPushSpec.key({ ...CHECK_IN_DUE } as never)).toBe(sendPushSpec.key(CHECK_IN_DUE as never))
  })

  it('gives a fresh chase, which has another day-one scan, its own key', () => {
    expect(sendPushSpec.key({ ...CHECK_IN_DUE, dayOneScanId: 'day-one-2' } as never)).toBe('face-check-in-due:day-one-2')
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

// The reminder cron's profile message (spec #233, PR 8a) rides the send-push job but is not a notification.
describe('the reminder-profile message of the send-push job', () => {
  const MESSAGE = { kind: 'reminder-profile', profileId: 'profile-1', slot: Date.UTC(2030, 5, 15, 6, 45) }

  it('is accepted, with the profile and the cron slot in epoch ms', () => {
    expect(sendPushSpec.schema.safeParse(MESSAGE).success).toBe(true)
  })

  it.each([
    ['no profile', { ...MESSAGE, profileId: undefined }],
    ['no slot', { ...MESSAGE, slot: undefined }],
    ['a fractional slot', { ...MESSAGE, slot: 1.5 }],
  ])('rejects %s', (_name, body) => {
    expect(sendPushSpec.schema.safeParse(body).success).toBe(false)
  })

  it('is one message for one profile and slot, and another for the next slot or another profile', () => {
    expect(sendPushSpec.key(MESSAGE as never)).toBe(`reminder-profile:profile-1:${MESSAGE.slot}`)
    expect(sendPushSpec.key({ ...MESSAGE, slot: MESSAGE.slot + 900_000 } as never)).not.toBe(sendPushSpec.key(MESSAGE as never))
    expect(sendPushSpec.key({ ...MESSAGE, profileId: 'profile-2' } as never)).not.toBe(sendPushSpec.key(MESSAGE as never))
  })

  it('is not one of the notification kinds', () => {
    expect(NOTIFICATION_KINDS).not.toContain('reminder-profile')
  })
})
