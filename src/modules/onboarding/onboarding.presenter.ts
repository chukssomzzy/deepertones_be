import type { z } from '@hono/zod-openapi'
import type { OnboardingContent } from './onboarding.content'
import type { OnboardingContentResponse } from './onboarding.schemas'

// The route has a bodiless 304, which stops the compiler checking the body of its 200; this return type is where the wire shape is checked instead.
export const toOnboardingContentResponse = (content: OnboardingContent): z.infer<typeof OnboardingContentResponse> => ({
  locale: content.locale,
  contentVersion: content.contentVersion,
  goalScreen: content.goalScreen,
  answerScreen: content.answerScreen,
  answers: content.answers,
  colourNote: content.colourNote,
  safetyScreen: content.safetyScreen,
  switchScreen: content.switchScreen,
})
