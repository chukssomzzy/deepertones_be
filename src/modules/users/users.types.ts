import type { EmailAddress } from '../../lib/email-address'
import type { PhoneNumber } from '../../lib/phone'
import type { devices, users } from './users.table'

/** A user as stored; email and phone are in canonical form when present. */
export type User = Omit<typeof users.$inferSelect, 'email' | 'phone'> & {
  email: EmailAddress | null
  phone: PhoneNumber | null
}

export type Device = typeof devices.$inferSelect

export type UserStatus = User['status']

/** A verified way to reach a user: an email or a phone number, already canonical. */
export type UserIdentifier = { kind: 'email'; email: EmailAddress } | { kind: 'phone'; phone: PhoneNumber }
