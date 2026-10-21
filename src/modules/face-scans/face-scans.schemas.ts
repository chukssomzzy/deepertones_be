import { z } from '@hono/zod-openapi'
import { REJECTED_PHOTO_REASONS } from '../../providers/perfect-corp/perfect-corp.provider'
import { GOALS } from '../goals/goals.vocabulary'
import { FACE_SCAN_POLICY } from './face-scans.service'

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
    rescanSuggested: z.boolean().openapi({ description: 'True when the profile\'s latest scan was taken under another goal than its current one.' }),
  })
  .openapi('FaceScanResponse')
