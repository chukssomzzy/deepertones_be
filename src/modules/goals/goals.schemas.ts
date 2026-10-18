import { z } from '@hono/zod-openapi'
import { GOALS } from './goals.vocabulary'

const GoalName = z.enum(GOALS).openapi({ description: 'One of the five goals the app offers.', example: 'fade-dark-marks' })

// Exactly one of the two: strict objects mean a body with both, or with neither, matches neither.
export const SetGoalBody = z
  .union([
    z.strictObject({ goal: GoalName }),
    z.strictObject({
      text: z.string().trim().min(1).max(200).openapi({
        description:
          'The goal in the user\'s own words, 1 to 200 characters once trimmed. Links, markup and control or invisible characters are refused with 400 `INVALID_GOAL_TEXT`.',
        example: 'make my face clear',
      }),
    }),
  ])
  .openapi('SetGoalBody')

export const GoalAnswerResponse = z
  .object({
    title: z.string(),
    howLong: z.string().openapi({ description: 'How long it usually takes, honestly.' }),
    helps: z.string(),
    inTheWay: z.string(),
    note: z.string().nullable().openapi({ description: 'A line about natural colour, only for someone who asked to be lighter.' }),
  })
  .openapi('GoalAnswer')

export const GoalResponse = z
  .object({
    goal: GoalName.nullable().openapi({ description: 'Null while the user has typed words but not picked a goal.' }),
    wantsLighter: z.boolean(),
    text: z.string().nullable().openapi({ description: 'The user\'s own words, when they typed any.' }),
    answer: GoalAnswerResponse.nullable().openapi({ description: 'Null while there is no goal.' }),
    answersVersion: z.number().int().openapi({ description: 'Which version of the answer copy `answer` is from.' }),
    updatedAt: z.string().openapi({ format: 'date-time', description: 'When the goal was last set.' }),
  })
  .openapi('Goal')

export const OnboardingResponse = z
  .object({
    goal: GoalResponse.nullable().openapi({ description: 'The current goal, or null when none was set.' }),
    safety: z.null().openapi({ description: 'Always null until the safety answers are built.' }),
    next: z.enum(['goal', 'safety']).openapi({ description: 'The first-run step to show next.' }),
  })
  .openapi('Onboarding')
