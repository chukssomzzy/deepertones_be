import type { PhoneNumber } from '../../lib/phone'
import type { otpChallenges } from './otp.table'

export type OtpChallenge = Omit<typeof otpChallenges.$inferSelect, 'phone'> & { phone: PhoneNumber }

/** What create() takes: a fresh challenge has no attempts and is not consumed. */
export type NewOtpChallenge = Omit<OtpChallenge, 'attempts' | 'consumedAt'>
