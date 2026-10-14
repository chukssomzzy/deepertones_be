import { ValidationError } from './errors'

/** A trimmed, lower-cased email address that passed parseEmailAddress. Only that function makes one. */
export type EmailAddress = string & { readonly __brand: 'EmailAddress' }

const MAX_LENGTH = 254
const MAX_LOCAL_LENGTH = 64

// A deliberately plain check: one '@', a non-empty local part, and a dotted domain of hyphen-safe
// labels. The only real proof an address works is the mail arriving.
const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const PATTERN = new RegExp(`^([^\\s@]+)@(${LABEL}(?:\\.${LABEL})+)$`)

const invalid = () => new ValidationError('INVALID_EMAIL', 'Enter a valid email address')

/** Normalises an email address to its trimmed, lower-case form; throws INVALID_EMAIL if it is not one. */
export const parseEmailAddress = (input: string): EmailAddress => {
  const normalised = input.trim().toLowerCase()
  const match = PATTERN.exec(normalised)
  if (!match || normalised.length > MAX_LENGTH || match[1]!.length > MAX_LOCAL_LENGTH) throw invalid()
  return normalised as EmailAddress
}
