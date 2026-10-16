import { z } from '@hono/zod-openapi'
import { OTP_POLICY } from '../otp/otp.service'

const Platform = z.enum(['ios', 'android'])

export const DeviceBody = z
  .object({
    deviceId: z.string().min(16).max(200).openapi({
      description: 'A stable id for this install: Android `getAndroidId`, or a UUID kept in the iOS Keychain.',
    }),
    platform: Platform,
  })
  .openapi('DeviceBody')

export const SendOtpBody = z
  .object({
    channel: z.enum(['email', 'whatsapp']),
    address: z.string().min(1).max(320).openapi({ example: 'ada@example.com' }),
  })
  .openapi('SendOtpBody')

export const VerifyOtpBody = SendOtpBody.extend({
  code: z.string().regex(new RegExp(`^\\d{${OTP_POLICY.length}}$`)).openapi({ example: '482913' }),
}).openapi('VerifyOtpBody')

export const RefreshBody = z
  .object({ refreshToken: z.string().min(1).max(4096) })
  .openapi('RefreshBody')

export const OtpChallengeResponse = z
  .object({
    challengeId: z.string(),
    expiresAt: z.iso.datetime().openapi({ description: 'When the code stops working.' }),
  })
  .openapi('OtpChallengeResponse')

export const UserResponse = z
  .object({
    id: z.string(),
    status: z.enum(['anonymous', 'verified']).openapi({ description: '`anonymous` is a guest; `verified` has proven an email or phone.' }),
    email: z.string().nullable(),
    phone: z.string().nullable(),
  })
  .openapi('User')

export const ProfileResponse = z
  .object({
    id: z.string(),
    displayName: z.string().nullable().openapi({ description: 'Unset for now.' }),
    isDefault: z.boolean(),
    createdAt: z.iso.datetime(),
  })
  .openapi('Profile')

export const MeResponse = z
  .object({
    user: UserResponse,
    profile: ProfileResponse.openapi({ description: 'The profile this session is on.' }),
    profiles: z.array(ProfileResponse).openapi({ description: 'Every profile of the account, the default first.' }),
  })
  .openapi('Me')

export const SessionResponse = z
  .object({
    tokens: z.object({
      accessToken: z.string().openapi({ description: 'Send as `Authorization: Bearer ...`. Lives 15 minutes.' }),
      refreshToken: z.string().openapi({ description: 'Send only to `/api/v1/auth/refresh`. Lives 60 days from each use.' }),
      accessExpiresAt: z.iso.datetime(),
      refreshExpiresAt: z.iso.datetime(),
    }),
    user: UserResponse,
  })
  .openapi('Session')
