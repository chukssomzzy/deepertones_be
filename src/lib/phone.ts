import { parsePhoneNumberFromString } from 'libphonenumber-js/min'
import { ValidationError } from './errors'

/** A phone number in canonical E.164 form, with the leading '+'. Only parsePhoneNumber makes one. */
export type PhoneNumber = string & { readonly __brand: 'PhoneNumber' }

const DEFAULT_REGION = 'NG'

const invalid = () => new ValidationError('INVALID_PHONE', 'Enter a valid phone number')

/** Normalises any common way of writing a number to E.164; throws INVALID_PHONE if it is not one. */
export const parsePhoneNumber = (input: string): PhoneNumber => {
  const trimmed = input.trim()
  // "2348031234567" has the country code but no '+'; with a default region the library would
  // read it as a national number, so try it as international first.
  const candidates = /^\d/.test(trimmed) && !trimmed.startsWith('0') ? [`+${trimmed}`, trimmed] : [trimmed]
  for (const candidate of candidates) {
    const parsed = parsePhoneNumberFromString(candidate, DEFAULT_REGION)
    if (parsed?.isValid()) return parsed.number as PhoneNumber
  }
  throw invalid()
}
