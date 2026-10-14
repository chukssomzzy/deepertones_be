import type { EmailAddress } from '../../lib/email-address'
import type { PhoneNumber } from '../../lib/phone'
import type { otpChallenges } from './otp.table'

export type OtpChannel = 'whatsapp' | 'email'

/** Who a code goes to: a channel and the address on it, already in canonical form. */
export type OtpRecipient = { channel: 'whatsapp'; address: PhoneNumber } | { channel: 'email'; address: EmailAddress }

type ChallengeRow = Omit<typeof otpChallenges.$inferSelect, 'channel' | 'address'>

export type OtpChallenge = ChallengeRow & OtpRecipient

/** What create() takes: a fresh challenge has no attempts, is not consumed and is queued for delivery. */
export type NewOtpChallenge = Omit<ChallengeRow, 'attempts' | 'consumedAt' | 'deliveryStatus' | 'failureReason' | 'deliveredAt'> & OtpRecipient
