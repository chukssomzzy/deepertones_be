import { z } from '@hono/zod-openapi'
import { REJECTED_PHOTO_REASONS } from '../../providers/perfect-corp/perfect-corp.provider'
import { GOALS } from '../goals/goals.vocabulary'
import { FACE_SCAN_POLICY } from './face-scans.service'
import { CONCERN_IDS } from './face-scans.tables'

export const FaceScanParams = z.object({ id: z.string() })
// Any length: a token that is too long or not ours is PHOTO_NOT_FOUND from the service, the same as every other bad link.
export const FacePhotoLinkParams = z.object({ token: z.string() })

export const SetFaceConsentBody = z
  .object({ version: z.number().int().openapi({ description: 'The version of the face photo consent wording the user agreed to. Only the current version is accepted.' }) })
  .openapi('SetFaceConsentBody')

export const FaceConsentGivenResponse = z
  .object({
    version: z.number().int(),
    givenAt: z.iso.datetime(),
  })
  .openapi('FaceConsentGivenResponse')

export const FaceConsentResponse = z
  .object({
    version: z.number().int(),
    givenAt: z.iso.datetime(),
    withdrawnAt: z.iso.datetime().nullable(),
    current: z.boolean().openapi({ description: 'True while the consent is for the current wording and has not been withdrawn: the only consent a face scan accepts.' }),
  })
  .openapi('FaceConsentResponse')

// The generator cannot describe a File on its own (see PhotoFile in scans.schemas.ts). Nothing the client declares about the file is
// checked here: the service reads the bytes and answers UNSUPPORTED_IMAGE, IMAGE_TOO_SMALL or IMAGE_TOO_LARGE with a code the app can act on.
const FacePhotoFile = z
  .instanceof(File)
  .openapi({ type: 'string', format: 'binary', description: `A JPEG photo, at most ${FACE_SCAN_POLICY.maxPhotoBytes} bytes, ${FACE_SCAN_POLICY.minShortSide} to 4096 pixels on the shorter side and at most 4096 on the longer.` })

export const CreateFaceScanBody = z
  .object({
    front: FacePhotoFile.openapi({ description: 'The front photo, required.' }),
    right: FacePhotoFile.optional().openapi({ description: 'The right side photo.' }),
    left: FacePhotoFile.optional().openapi({ description: 'The left side photo.' }),
  })
  .openapi('CreateFaceScanBody')

export const RetakeFaceScanBody = z
  .object({ front: FacePhotoFile.openapi({ description: 'The new front photo, required.' }) })
  .openapi('RetakeFaceScanBody')

const FacePhotoLink = z.object({ url: z.string().openapi({ description: 'A signed link, good for 5 minutes, to `GET /api/v1/scans/faces/photos/{token}`.' }) })

export const PerfectCorpWebhookResponse = z
  .object({ received: z.literal(true) })
  .openapi('PerfectCorpWebhookResponse')

const ConcernIdEnum = z.enum(Object.values(CONCERN_IDS) as [string, ...string[]]).openapi({
  description: 'The concern, by the app\'s own id. Never a Perfect Corp name.',
})

const FaceScanSeen = z.object({
  concern: ConcernIdEnum,
  region: z.string().openapi({ description: 'The region that was read: `whole` for the whole face.' }),
  level: z.enum(['faint', 'a-little', 'some', 'clear']).openapi({
    description:
      'A level of how much can be seen, from `faint` (hardly there; the words read as reassurance) up to `clear`. It is not a score and carries no number. Use it to style the item, for example to show a `faint` one subdued with its overlay off until it is tapped.',
  }),
  words: z.string().openapi({ description: 'What can be seen, in plain words. Show it as it is; it is never a diagnosis.' }),
  overlay: z
    .object({ url: z.string() })
    .nullable()
    .openapi({ description: 'A signed link to the PNG mask of where the concern shows, good for 5 minutes (fetch the scan again for a new one); null when there is no mask.' }),
})

const FaceScanSinceDayOne = z.object({
  dayOneScanId: z.string().openapi({ description: 'The earlier scan this one is compared with: the profile\'s first ready scan under this goal since the goal last changed.' }),
  dayOneAt: z.iso.datetime(),
  concerns: z
    .array(
      z.object({
        concern: ConcernIdEnum,
        change: z.enum(['fainter', 'more-visible', 'no-clear-change']),
        words: z.string().openapi({ description: 'The change in plain words. Show it as it is.' }),
      }),
    )
    .openapi({ description: 'The goal\'s concerns that were read on both scans, in goal order. Changes inside ordinary variation are `no-clear-change`.' }),
  skinAge: z
    .object({ change: z.enum(['younger', 'older', 'no-clear-change']), words: z.string() })
    .nullable()
    .openapi({ description: 'How the skin age moved; null when either scan has no skin age.' }),
})

const FaceScanResult = z
  .object({
    seen: z
      .array(FaceScanSeen)
      .openapi({ description: 'Every goal concern Perfect Corp measured, with how much can be seen, in goal order, at most 3. A concern Perfect Corp did not return is left out; empty when none came back.' }),
    alsoNoticed: z
      .array(FaceScanSeen)
      .openapi({ description: 'Other concerns that can be seen, beyond the goal\'s; never a diagnosis. Only those that are not `faint`, in a fixed order; empty when there are none (always, for a scan taken before these were measured). Show them under the goal\'s concerns as "Also noticed". They are not part of `sinceDayOne` or `nothingStandsOut`.' }),
    nothingStandsOut: z.string().nullable().openapi({ description: 'A calm sentence to show when every item in `seen` is `faint`, or `seen` is empty; null otherwise.' }),
    skinType: z.enum(['oily', 'dry', 'combination', 'normal']).nullable().openapi({ description: 'The skin type; null when it could not be read.' }),
    skinAge: z
      .object({ years: z.number().int(), words: z.string() })
      .nullable()
      .openapi({ description: 'The skin age as a plain fact in whole years. It is never compared with a real age. Null when it could not be read.' }),
    sinceDayOne: FaceScanSinceDayOne.nullable().openapi({ description: 'The change since day one; null when this scan is its own day one.' }),
    nextGoal: z.enum(GOALS).nullable().openapi({ description: 'The goal to suggest working on next, from this check-in scan. Null on every other scan.' }),
    tablesVersion: z.string().openapi({ description: 'The version of the rules that worded this result. The words are worked out each time the scan is read.' }),
  })
  .openapi('FaceScanResult', {
    description:
      'What a ready scan shows. It never holds a score or any number but the skin age in years, never a condition name, never a Perfect Corp name, ' +
      'never a Fitzpatrick type, and never a word about lightness. It describes the face, not the person: show the words as they are.',
  })

export const FaceScanResponse = z
  .object({
    id: z.string(),
    state: z.enum(['analysing', 'needs-retake', 'ready', 'failed']),
    reason: z
      .enum(['unavailable', 'consent-withdrawn', ...REJECTED_PHOTO_REASONS])
      .nullable()
      .openapi({
        description:
          'Why the scan `failed` (`unavailable`, or `consent-withdrawn` when consent was taken back before the photo was analysed) or needs a retake ' +
          '(`too-dark`, `turn-to-camera`, `move-closer`, `face-not-centred`, `no-face` or `image-size`: one instruction for the app to show); null otherwise.',
      }),
    goal: z.enum(GOALS).openapi({ description: 'The goal the scan was taken under, whatever the goal is now.' }),
    createdAt: z.iso.datetime(),
    photos: z.object({ front: FacePhotoLink.optional(), right: FacePhotoLink.optional(), left: FacePhotoLink.optional() }).openapi({ description: 'A link for each photo that was sent.' }),
    rescanSuggested: z.boolean().openapi({ description: 'True when a face scan is due now for the profile\'s current goal (the same due rule `POST /scans/faces` enforces): a first scan under the goal, or its chase\'s check-in at the review point.' }),
    // Not `FaceScanResult.nullable()`: that would make the registered component itself nullable and replace its never-list description.
    result: z.union([FaceScanResult, z.null()]).openapi({ description: 'What the scan shows: filled when `state` is `ready`, null otherwise.' }),
  })
  .openapi('FaceScanResponse')

export const FaceScanListResponse = z
  .object({
    faceScans: z.array(FaceScanResponse).openapi({ description: 'The profile\'s face scans in every state, latest first, at most 20. Each is what `GET /api/v1/scans/faces/{id}` shows.' }),
  })
  .openapi('FaceScanListResponse')
