import type { z } from '@hono/zod-openapi'
import type { SafetyResponse } from './safety.schemas'
import type { SafetyView } from './safety.types'

export const toSafetyResponse = ({ choices, reactionText, prescriptionText, excludesPregnancyCaution, updatedAt }: SafetyView): z.infer<typeof SafetyResponse> => ({
  choices,
  reactionText,
  prescriptionText,
  excludesPregnancyCaution,
  updatedAt: updatedAt.toISOString(),
})
