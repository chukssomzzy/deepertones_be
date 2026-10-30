import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type Actor, runAs } from '../../lib/context'
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError, UnavailableError } from '../../lib/errors'
import { MemoryPhotoStore } from '../../providers/photo-store/memory.photo-store'
import type { ProductImage } from '../../providers/product-analysis/product-analyst.provider'
import { MemoryShareCardRenderer } from '../../providers/share-card/memory.share-card-renderer'
import { ShareCardQuotaError } from '../../providers/share-card/share-card.provider'
import { markedJpeg } from '../scans/scans.photos.fake'
import { FakeFaceSharesRepository } from './face-shares.repository.fake'
import { FaceSharesService } from './face-shares.service'

// Sharing the before-and-after card (spec #259, C2) at the service, with fakes: who may share and in what order they are refused, which day the "after" photo is, what
// is asked of the renderer, and what happens when the renderer is out of allowance or fails. The face scans are a stub that answers what the real read answers (the
// local calendar dates are its job, pinned in face-scans.share-read.test.ts), so the 14-day edge is reached here with dates chosen by the test.
//
// THE CONTRACT THIS FILE PINS (the brief names the behaviour, the checks and the codes; the names are the assumptions):
//   new FaceSharesService({ repository, now?, newId?,
//     faceScans:  { beforeAndAfterFor(profileId, afterScanId): Promise<BeforeAndAfter> }   structural: face-shares never imports face-scans
//     photos:     { get(key): Promise<ProductImage | null> }                               the private photo store
//     renderer:   ShareCardRenderer                                                         src/providers/share-card/share-card.provider.ts
//     readLogo:   () => Promise<ProductImage>                                               the public email logo (CATALOG_IMAGES, email/logo.png)
//     opsAlerts:  { raise(kind) }                                                           the OpsAlertsService
//   })
//   BeforeAndAfter = { before: ShareScan | null, after: ShareScan | null }, ShareScan = { scanId, frontPhotoKey, localDay: 'YYYY-MM-DD' }
//     `before` is the current goal's day one (null: none, or it has no front photo). `after` is the asked-for scan when it is a later ready scan of the same chase with
//     a front photo, else null (unknown, another profile's, not later, another chase, no front photo: not told apart). `after` is null when `before` is.
//     `localDay` is the calendar date in the person's zone, so N is a difference of two dates and no clock is involved.
//   share(afterScanId): Promise<{ bytes: Uint8Array; mediaType: 'image/png' }>, session-scoped. Checks, in order, each leaving the renderer, the photo store and
//     face_shares untouched:
//       401 AUTH_REQUIRED, 403 SIGNUP_REQUIRED (guest), 409 SHARE_CONSENT_REQUIRED, 409 NO_DAY_ONE_PHOTO (before is null),
//       404 FACE_SCAN_NOT_FOUND (after is null), 409 SHARE_TOO_EARLY (after.localDay is less than 14 days after before.localDay).
//     Then the card is rendered with layout `shareCardLayout(N)`, N = days between the two dates + 1, so the first allowed card (14 days after) is "Day 15".
//     Then, and only then, face_shares gets { id: newId(), profileId, beforeScanId, afterScanId, consentVersion, createdAt: now() }. Nothing is stored in the photo store.
//   A render that throws ShareCardQuotaError: opsAlerts.raise('share-render-quota') once, then 503 SHARE_UNAVAILABLE "Sharing is busy right now. Try again later.",
//     nothing recorded. Any other throw: 503 SHARE_UNAVAILABLE, nothing recorded, no alert, logged by ids only.
//   No log line (console.*) holds a photo key, photo bytes or the text of an error: ids only.

const T0 = new Date('2030-06-15T12:00:00.000Z')

const CURRENT_CONSENT = 1
const AMARA_USER = 'user-amara'
const AMARA = 'profile-amara'
const TOLU_USER = 'user-tolu'
const TOLU = 'profile-tolu'
const BEFORE_SCAN = 'scan-before'
const AFTER_SCAN = 'scan-after'
const BEFORE_KEY = `faces/test/${AMARA_USER}/${AMARA}/${BEFORE_SCAN}/front.jpg`
const AFTER_KEY = `faces/test/${AMARA_USER}/${AMARA}/${AFTER_SCAN}/front.jpg`

const actor = (userId: string, profileId: string, status: 'anonymous' | 'verified' = 'verified'): Actor => ({ kind: 'user', userId, status, profileId })
const AMARA_ACTOR = actor(AMARA_USER, AMARA)
const TOLU_ACTOR = actor(TOLU_USER, TOLU)
const GUEST = actor('user-guest', 'profile-guest', 'anonymous')
const PUBLIC: Actor = { kind: 'public' }

const BEFORE_PHOTO = markedJpeg(11)
const AFTER_PHOTO = markedJpeg(22)
const LOGO: ProductImage = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 77]), mediaType: 'image/png' }
const CARD = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 99])

type ShareScan = { scanId: string; frontPhotoKey: string; localDay: string }
type BeforeAndAfter = { before: ShareScan | null; after: ShareScan | null }
/** Dates are chosen by the test; the day one is always BEFORE_SCAN and the asked-for scan AFTER_SCAN. */
const reading = (beforeDay: string, afterDay: string): BeforeAndAfter => ({
  before: { scanId: BEFORE_SCAN, frontPhotoKey: BEFORE_KEY, localDay: beforeDay },
  after: { scanId: AFTER_SCAN, frontPhotoKey: AFTER_KEY, localDay: afterDay },
})
/** 14 days after, across a month end: the first card that may be shared. */
const ELIGIBLE = reading('2030-03-30', '2030-04-13')

const errorOf = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error as Error & { code?: string }
  }
  throw new Error('expected the promise to reject')
}

let clock: Date
let repository: FakeFaceSharesRepository
let photos: MemoryPhotoStore
let renderer: MemoryShareCardRenderer
let raised: string[]
let answer: BeforeAndAfter
let asked: { profileId: string; afterScanId: string }[]
let logoReads: number
let ids: number
let service: FaceSharesService

const build = (over: { renderer?: MemoryShareCardRenderer } = {}) =>
  new FaceSharesService({
    repository,
    now: () => clock,
    newId: () => `share-${++ids}`,
    faceScans: {
      beforeAndAfterFor: async (profileId: string, afterScanId: string) => {
        asked.push({ profileId, afterScanId })
        return answer
      },
    },
    photos,
    renderer: over.renderer ?? renderer,
    readLogo: async () => {
      logoReads++
      return LOGO
    },
    opsAlerts: {
      raise: async (kind: string) => {
        raised.push(kind)
      },
    },
  })

beforeEach(async () => {
  clock = T0
  repository = new FakeFaceSharesRepository()
  photos = new MemoryPhotoStore({ environment: 'test' })
  await photos.put(BEFORE_KEY, BEFORE_PHOTO)
  await photos.put(AFTER_KEY, AFTER_PHOTO)
  renderer = new MemoryShareCardRenderer({ card: { bytes: CARD, mediaType: 'image/png' } })
  raised = []
  answer = ELIGIBLE
  asked = []
  logoReads = 0
  ids = 0
  service = build()
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** Amara has said yes to sharing, the way she does: through the service. */
const consents = (who: Actor = AMARA_ACTOR) => runAs(who, () => service.giveConsent(CURRENT_CONSENT))
const share = (who: Actor = AMARA_ACTOR, afterScanId: string = AFTER_SCAN) => runAs(who, () => service.share(afterScanId))

/** A refusal is before anything is made: nothing rendered, nothing recorded, no alert. */
const nothingHappened = async (profileId = AMARA) => {
  expect(renderer.calls).toEqual([])
  expect(await repository.sharesOf(profileId)).toEqual([])
  expect(raised).toEqual([])
}

describe('FaceSharesService.share: who may share, in order', () => {
  it('refuses a caller with no session with 401 AUTH_REQUIRED, before anything else is looked at', async () => {
    answer = { before: null, after: null }

    const error = await errorOf(share(PUBLIC))

    expect(error).toBeInstanceOf(UnauthorizedError)
    expect(error.code).toBe('AUTH_REQUIRED')
    expect(asked).toEqual([])
    await nothingHappened()
  })

  it('refuses a guest with 403 SIGNUP_REQUIRED even though there is no consent and no day one either', async () => {
    answer = { before: null, after: null }

    const error = await errorOf(share(GUEST))

    expect(error).toBeInstanceOf(ForbiddenError)
    expect(error.code).toBe('SIGNUP_REQUIRED')
    await nothingHappened('profile-guest')
  })

  it('refuses a signed-up caller who never said yes with 409 SHARE_CONSENT_REQUIRED, before the day one is looked at', async () => {
    answer = { before: null, after: null }

    const error = await errorOf(share())

    expect(error).toBeInstanceOf(ConflictError)
    expect(error.code).toBe('SHARE_CONSENT_REQUIRED')
    await nothingHappened()
  })

  it('refuses again after the consent is withdrawn: the next share asks again', async () => {
    await consents()
    await runAs(AMARA_ACTOR, () => service.withdrawConsent())

    const error = await errorOf(share())

    expect(error).toBeInstanceOf(ConflictError)
    expect(error.code).toBe('SHARE_CONSENT_REQUIRED')
    await nothingHappened()
  })

  it("does not count another profile's consent", async () => {
    await consents(TOLU_ACTOR)

    const error = await errorOf(share(AMARA_ACTOR))

    expect(error.code).toBe('SHARE_CONSENT_REQUIRED')
    await nothingHappened()
  })

  it('refuses with 409 NO_DAY_ONE_PHOTO when there is no day one, before the asked-for scan is judged', async () => {
    await consents()
    answer = { before: null, after: null }

    const error = await errorOf(share())

    expect(error).toBeInstanceOf(ConflictError)
    expect(error.code).toBe('NO_DAY_ONE_PHOTO')
    await nothingHappened()
  })

  it('refuses with 404 FACE_SCAN_NOT_FOUND when the asked-for scan is not an eligible later scan, before the 14 days are counted', async () => {
    await consents()
    // Dates that would be too early too: the 404 wins.
    answer = { before: reading('2030-03-30', '2030-03-31').before, after: null }

    const error = await errorOf(share())

    expect(error).toBeInstanceOf(NotFoundError)
    expect(error.code).toBe('FACE_SCAN_NOT_FOUND')
    await nothingHappened()
  })

  it('asks the face scans about the session profile and the asked-for scan id, and nothing else', async () => {
    await consents()

    await share(AMARA_ACTOR, 'scan-asked-for')

    expect(asked).toEqual([{ profileId: AMARA, afterScanId: 'scan-asked-for' }])
  })
})

describe('FaceSharesService.share: the 14-day edge and Day N', () => {
  beforeEach(async () => {
    await consents()
  })

  it.each([
    ['the same day', '2030-03-30', '2030-03-30'],
    ['the next day', '2030-03-30', '2030-03-31'],
    ['13 days after, across a month end (Day 14)', '2030-03-30', '2030-04-12'],
    ['13 days after, across a year end', '2030-12-26', '2031-01-08'],
    ['13 days after, across the end of February in a leap year', '2028-02-20', '2028-03-04'],
  ])('refuses %s with 409 SHARE_TOO_EARLY and renders nothing', async (_name, beforeDay, afterDay) => {
    answer = reading(beforeDay, afterDay)

    const error = await errorOf(share())

    expect(error).toBeInstanceOf(ConflictError)
    expect(error.code).toBe('SHARE_TOO_EARLY')
    await nothingHappened()
  })

  it.each([
    ['14 days after, across a month end', '2030-03-30', '2030-04-13', 'Day 15'],
    ['14 days after, across the end of February in a common year', '2030-02-20', '2030-03-06', 'Day 15'],
    ['14 days after, across a year end', '2030-12-25', '2031-01-08', 'Day 15'],
    ['14 days after, across the end of February in a leap year', '2028-02-20', '2028-03-05', 'Day 15'],
    ['15 days after, in a leap year', '2028-02-20', '2028-03-06', 'Day 16'],
    ['43 days after: the dates of a person in London whose clocks went forward in between (UTC dates would be Day 43)', '2030-03-30', '2030-05-12', 'Day 44'],
    ['42 days after, the same instants read in UTC', '2030-03-30', '2030-05-11', 'Day 43'],
  ])('renders %s as "%s"', async (_name, beforeDay, afterDay, afterLabel) => {
    answer = reading(beforeDay, afterDay)

    const card = await share()

    expect(card).toEqual({ bytes: CARD, mediaType: 'image/png' })
    expect(renderer.calls).toHaveLength(1)
    expect(renderer.calls[0]!.layout.labels.map((label) => label.text)).toEqual(['Day 1', afterLabel])
  })
})

describe('FaceSharesService.share: what is rendered and recorded', () => {
  beforeEach(async () => {
    await consents()
  })

  it('hands the renderer the day-one photo as before, the asked-for photo as after, and the logo, and answers the rendered card', async () => {
    const card = await share()

    expect(card).toEqual({ bytes: CARD, mediaType: 'image/png' })
    expect(renderer.calls).toHaveLength(1)
    const [call] = renderer.calls
    expect(call!.before).toEqual(BEFORE_PHOTO)
    expect(call!.after).toEqual(AFTER_PHOTO)
    expect(call!.logo).toEqual(LOGO)
    expect(logoReads).toBe(1)
  })

  it('records the share once the card is rendered: the profile, both scans, the consent version and the time, and stores no card and no photo', async () => {
    clock = new Date(T0.getTime() + 5 * 60 * 1000)
    const storedBefore = photos.stored.size

    await share()

    expect(await repository.sharesOf(AMARA)).toEqual([
      { id: 'share-1', profileId: AMARA, beforeScanId: BEFORE_SCAN, afterScanId: AFTER_SCAN, consentVersion: CURRENT_CONSENT, createdAt: clock },
    ])
    expect(photos.stored.size).toBe(storedBefore)
    expect([...photos.stored.keys()].sort()).toEqual([BEFORE_KEY, AFTER_KEY].sort())
  })

  it('keeps every share: a second card of the same photos is a second record', async () => {
    await share()
    await share()

    expect((await repository.sharesOf(AMARA)).map((record) => record.id)).toEqual(['share-1', 'share-2'])
  })

  it('records nothing before the render has finished: the share is written only after the renderer returns', async () => {
    let recordedWhenRendering = -1
    class ObservingRenderer extends MemoryShareCardRenderer {
      override async render(input: Parameters<MemoryShareCardRenderer['render']>[0]) {
        recordedWhenRendering = (await repository.sharesOf(AMARA)).length
        return super.render(input)
      }
    }
    service = build({ renderer: new ObservingRenderer({ card: { bytes: CARD, mediaType: 'image/png' } }) })

    await share()

    expect(recordedWhenRendering).toBe(0)
    expect(await repository.sharesOf(AMARA)).toHaveLength(1)
  })
})

describe('FaceSharesService.share: when the renderer cannot make the card', () => {
  beforeEach(async () => {
    await consents()
  })

  it('on the free allowance running out, raises share-render-quota once and answers 503 SHARE_UNAVAILABLE in plain words, recording nothing', async () => {
    renderer.failure = new ShareCardQuotaError()

    const error = await errorOf(share())

    expect(error).toBeInstanceOf(UnavailableError)
    expect(error.code).toBe('SHARE_UNAVAILABLE')
    expect(error.message).toBe('Sharing is busy right now. Try again later.')
    expect(raised).toEqual(['share-render-quota'])
    expect(await repository.sharesOf(AMARA)).toEqual([])
  })

  it('on any other render failure, answers 503 SHARE_UNAVAILABLE with no alert and records nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    renderer.failure = new Error('the images binding fell over')

    const error = await errorOf(share())

    expect(error).toBeInstanceOf(UnavailableError)
    expect(error.code).toBe('SHARE_UNAVAILABLE')
    expect(raised).toEqual([])
    expect(await repository.sharesOf(AMARA)).toEqual([])
  })

  it('shares again once the renderer works: the failed attempt left nothing behind', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    renderer.failure = new ShareCardQuotaError()
    await errorOf(share())
    renderer.failure = null

    await share()

    expect(await repository.sharesOf(AMARA)).toHaveLength(1)
  })

  it('logs another failure by ids only: the profile and scan ids are there, the error text is not', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    renderer.failure = new Error(`SECRET-RENDER-DETAIL ${BEFORE_KEY}`)

    await errorOf(share())

    expect(logged).toHaveBeenCalled()
    const text = textOf(logged)
    expect(text).toContain(AMARA)
    expect(text).not.toContain('SECRET-RENDER-DETAIL')
  })
})

describe('FaceSharesService.share: privacy of the log', () => {
  const channels = ['log', 'info', 'warn', 'error', 'debug'] as const

  const spyOnConsole = () => channels.map((channel) => vi.spyOn(console, channel).mockImplementation(() => undefined))

  it.each([
    ['a card that is made', () => undefined],
    ['the allowance running out', () => void (renderer.failure = new ShareCardQuotaError())],
    ['a render that fails', () => void (renderer.failure = new Error(`boom ${BEFORE_KEY} ${AFTER_KEY}`))],
  ])('writes no photo key, photo bytes or url to any log line for %s', async (_name, arrange) => {
    const spies = spyOnConsole()
    await consents()
    arrange()

    await share().catch(() => undefined)

    const text = textOf(...spies)
    for (const forbidden of [BEFORE_KEY, AFTER_KEY, 'faces/', 'front.jpg', 'http://', 'https://']) expect(text).not.toContain(forbidden)
    for (const bytes of [BEFORE_PHOTO.bytes, AFTER_PHOTO.bytes, LOGO.bytes, CARD]) expect(text).not.toContain(Array.from(bytes).join(','))
    for (const call of spies.flatMap((spy) => spy.mock.calls.flat())) expect(containsBinary(call)).toBe(false)
  })
})

/** Everything the given console spies were called with, as one string, with binary shown as its byte values so a dumped photo cannot hide. */
function textOf(...spies: { mock: { calls: unknown[][] } }[]): string {
  return spies
    .flatMap((spy) => spy.mock.calls)
    .map((args) =>
      args
        .map((arg) =>
          typeof arg === 'string'
            ? arg
            : JSON.stringify(arg, (_key, value: unknown) => {
                if (value instanceof Uint8Array || value instanceof ArrayBuffer) return Array.from(new Uint8Array(value as ArrayBuffer)).join(',')
                if (value instanceof Error) return `${value.name}: ${value.message}\n${value.stack ?? ''}`
                return value
              }),
        )
        .join(' '),
    )
    .join('\n')
}

/** Whether a console argument is, or holds at the top level or one level down, raw bytes. */
function containsBinary(value: unknown): boolean {
  const isBinary = (v: unknown) => v instanceof Uint8Array || v instanceof ArrayBuffer || v instanceof ReadableStream
  if (isBinary(value)) return true
  return typeof value === 'object' && value !== null && Object.values(value).some(isBinary)
}
