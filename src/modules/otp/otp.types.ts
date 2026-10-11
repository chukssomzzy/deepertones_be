import type { PhoneNumber } from '../../lib/phone'
import type { otpChallenges } from './otp.table'

export type OtpChallenge = Omit<typeof otpChallenges.$inferSelect, 'phone'> & { phone: PhoneNumber }

/** What create() takes: a fresh challenge has no attempts, is not consumed and is queued for delivery. */
export type NewOtpChallenge = Omit<OtpChallenge, 'attempts' | 'consumedAt' | 'deliveryStatus' | 'failureReason' | 'deliveredAt'>
