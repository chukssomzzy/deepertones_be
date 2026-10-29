import { z } from '@hono/zod-openapi'

export const SetFaceShareConsentBody = z
  .object({ version: z.number().int().openapi({ description: 'The version of the face share consent wording the user agreed to. Only the current version is accepted.' }) })
  .openapi('SetFaceShareConsentBody')

export const FaceShareConsentGivenResponse = z
  .object({
    version: z.number().int(),
    givenAt: z.iso.datetime(),
  })
  .openapi('FaceShareConsentGivenResponse')

export const FaceShareConsentResponse = z
  .object({
    version: z.number().int(),
    givenAt: z.iso.datetime(),
    withdrawnAt: z.iso.datetime().nullable(),
    current: z.boolean().openapi({ description: 'True while the consent is for the current wording and has not been withdrawn: the only consent a share accepts.' }),
  })
  .openapi('FaceShareConsentResponse')

export const ShareFaceTimelineBody = z
  .object({ afterScanId: z.string().min(1).openapi({ description: 'The face scan to show as "after": a later ready scan of the current goal, with a front photo, at least 14 days after day one.' }) })
  .openapi('ShareFaceTimelineBody')
