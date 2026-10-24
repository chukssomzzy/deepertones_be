import type { z } from '@hono/zod-openapi'
import { toSafetyResponse } from '../safety/safety.presenter'
import type { GoalResponse, OnboardingResponse, SwitchPreviewResponse } from './goals.schemas'
import type { GoalView, OnboardingView, SwitchPreviewView } from './goals.types'

export const toGoalResponse = ({ goal, wantsLighter, text, answer, answersVersion, updatedAt }: GoalView): z.infer<typeof GoalResponse> => ({
  goal,
  wantsLighter,
  text,
  answer: answer && { title: answer.title, howLong: answer.howLong, helps: answer.helps, inTheWay: answer.inTheWay, note: answer.note },
  answersVersion,
  updatedAt: updatedAt.toISOString(),
})

export const toOnboardingResponse = ({ goal, safety, next }: OnboardingView): z.infer<typeof OnboardingResponse> => ({
  goal: goal && toGoalResponse(goal),
  safety: safety && toSafetyResponse(safety),
  next,
})

export const toSwitchPreviewResponse = ({ goal, outcome, dayOneAt, resumeUntil }: SwitchPreviewView): z.infer<typeof SwitchPreviewResponse> => ({
  goal,
  outcome,
  dayOneAt: dayOneAt && dayOneAt.toISOString(),
  resumeUntil: resumeUntil && resumeUntil.toISOString(),
})
