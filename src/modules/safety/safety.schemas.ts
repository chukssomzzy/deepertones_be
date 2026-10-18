import { z } from '@hono/zod-openapi'
import { SAFETY_CHOICES, SAFETY_TEXT_MAX } from './safety.vocabulary'

const SafetyChoiceName = z.enum(SAFETY_CHOICES).openapi({ description: 'One thing that changes what is safe for the user, or `none`.', example: 'pregnant' })

const text = (description: string, example: string) => z.string().trim().max(SAFETY_TEXT_MAX).optional().openapi({ description, example })

export const SetSafetyBody = z
  .strictObject({
    choices: z.array(SafetyChoiceName).min(1).max(SAFETY_CHOICES.length).openapi({
      description:
        'What applies, one to five of the choices. Repeats are collapsed. `none` cannot be combined with another choice: 400 `INVALID_SAFETY_ANSWER` with `details.field` `choices`.',
    }),
    reactionText: text(
      'The products or ingredients that gave a reaction, up to 300 characters once trimmed. Optional even when `reaction` is ticked; blank counts as left out. Words without `reaction` ticked are 400 `INVALID_SAFETY_ANSWER` with `details.field` `reactionText`.',
      'Caro White and fragrance',
    ),
    prescriptionText: text(
      'The prescription cream or tablets, up to 300 characters once trimmed. Optional even when `prescription` is ticked; blank counts as left out. Words without `prescription` ticked are 400 `INVALID_SAFETY_ANSWER` with `details.field` `prescriptionText`.',
      'clobetasol',
    ),
  })
  .openapi('SetSafetyBody')

export const SafetyResponse = z
  .object({
    choices: z.array(SafetyChoiceName).openapi({ description: 'The ticked choices, once each, in the order of the choice list.' }),
    reactionText: z.string().nullable().openapi({ description: 'The user\'s own words about a reaction, when they typed any.' }),
    prescriptionText: z.string().nullable().openapi({ description: 'The user\'s own words about a prescription, when they typed any.' }),
    excludesPregnancyCaution: z.boolean().openapi({ description: 'True when `pregnant` or `breastfeeding` is ticked.' }),
    updatedAt: z.string().openapi({ format: 'date-time', description: 'When the answers were last saved.' }),
  })
  .openapi('Safety')
