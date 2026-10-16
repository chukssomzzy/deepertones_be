import type { z } from '@hono/zod-openapi'
import type { Profile } from '../profiles/profiles.types'
import type { User } from '../users/users.types'
import type { MeResponse, OtpChallengeResponse, ProfileResponse, SessionResponse, UserResponse } from './auth.schemas'
import type { Me, Session } from './auth.service'

export const toUserResponse = (user: User): z.infer<typeof UserResponse> => ({
  id: user.id,
  status: user.status,
  email: user.email,
  phone: user.phone,
})

export const toProfileResponse = (profile: Profile): z.infer<typeof ProfileResponse> => ({
  id: profile.id,
  displayName: profile.displayName,
  isDefault: profile.isDefault,
  createdAt: profile.createdAt.toISOString(),
})

export const toMeResponse = ({ user, profile, profiles }: Me): z.infer<typeof MeResponse> => ({
  user: toUserResponse(user),
  profile: toProfileResponse(profile),
  profiles: profiles.map(toProfileResponse),
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
