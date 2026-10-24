import { z } from '@hono/zod-openapi'
import { GOALS } from '../goals/goals.vocabulary'
import { SAFETY_CHOICES } from '../safety/safety.vocabulary'

// Any value is accepted, even a repeated or empty one (Hono hands a repeated parameter over as a list, which `.catch` turns into no locale): a
// language that does not ship falls back to English, so a locale is never a 400. The generator cannot describe `.catch`, hence the explicit type.
export const OnboardingContentQuery = z.object({
  locale: z
    .string()
    .optional()
    .catch(undefined)
    .openapi({ type: 'string', description: 'The language to write the screens in. Only `en` ships now; anything else, or nothing, gets `en`, and `locale` in the response says which.', example: 'en' }),
})

const Chip = z.object({ id: z.enum(GOALS), label: z.string() })

const Field = z.object({
  label: z.string().openapi({ description: 'The label of the text box.' }),
  hint: z.string().optional().openapi({ description: 'Smaller text under the box.' }),
})

const Choice = z.object({
  id: z.enum(SAFETY_CHOICES),
  label: z.string(),
  field: Field.optional().openapi({ description: 'The text box to show under this choice once it is ticked. Absent when the choice takes no words.' }),
})

const Answer = z.object({
  title: z.string(),
  howLong: z.string(),
  helps: z.string(),
  inTheWay: z.string(),
})

export const OnboardingContentResponse = z
  .object({
    locale: z.string().openapi({ type: 'string', description: 'The language the text is in: `en`, whatever was asked for.', example: 'en' }),
    contentVersion: z.string().openapi({ description: 'A hash of everything below. It is also the `ETag` (in quotes).' }),
    goalScreen: z.object({
      title: z.string(),
      subtitle: z.string(),
      placeholder: z.string().openapi({ description: 'Placeholder of the box where the user types a goal in their own words.' }),
      footnote: z.string(),
      continueLabel: z.string(),
      loginLabel: z.string(),
      chips: z.array(Chip).openapi({ description: 'The goals to offer, in display order. Each `id` is accepted by `PUT /api/v1/me/goal`.' }),
    }),
    answerScreen: z.object({
      subtitle: z.string(),
      howLongLabel: z.string(),
      helpsLabel: z.string(),
      inTheWayLabel: z.string(),
      continueLabel: z.string(),
      changeLabel: z.string(),
    }),
    answers: z
      .object(Object.fromEntries(GOALS.map((goal) => [goal, Answer])) as Record<(typeof GOALS)[number], typeof Answer>)
      .openapi({ description: 'The answer card for each goal. It is the same text `PUT /api/v1/me/goal` answers with, without `note`.' }),
    colourNote: z.string().openapi({ description: 'Add to the answer card only when the user\'s own words asked to be lighter. It is the `note` that `PUT /api/v1/me/goal` sends in that case.' }),
    safetyScreen: z.object({
      title: z.string(),
      subtitle: z.string(),
      footnote: z.string(),
      continueLabel: z.string(),
      choices: z.array(Choice).openapi({ description: 'The choices to offer, in display order. Each `id` is accepted in `choices` of `PUT /api/v1/me/safety`.' }),
    }),
    switchScreen: z.object({
      resume: z.string(),
      fresh: z.string(),
    }).openapi({ description: 'The heads-up before a goal switch: show the line named by the `outcome` of `GET /api/v1/me/goal/switch-preview`. Draft wording.' }),
  })
  .openapi('OnboardingContent')
