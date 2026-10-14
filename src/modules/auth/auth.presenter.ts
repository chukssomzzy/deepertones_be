import type { z } from '@hono/zod-openapi'
import type { User } from '../users/users.types'
import type { OtpChallengeResponse, SessionResponse, UserResponse } from './auth.schemas'
import type { Session } from './auth.service'

export const toUserResponse = (user: User): z.infer<typeof UserResponse> => ({
  id: user.id,
  status: user.status,
  email: user.email,
  phone: user.phone,
})

export const toSessionResponse = ({ tokens, user }: Session): z.infer<typeof SessionResponse> => ({
  tokens: {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    accessExpiresAt: tokens.accessExpiresAt.toISOString(),
    refreshExpiresAt: tokens.refreshExpiresAt.toISOString(),
  },
  user: toUserResponse(user),
})

export const toOtpChallengeResponse = (challenge: {
  challengeId: string
  expiresAt: Date
}): z.infer<typeof OtpChallengeResponse> => ({
  challengeId: challenge.challengeId,
  expiresAt: challenge.expiresAt.toISOString(),
})
