// fromCharCode(...bytes) on a whole photo overflows the call stack, so build the string in slices.
const CHUNK = 0x8000

export const base64Of = (bytes: Uint8Array): string => {
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(binary)
}

/** Unpadded base64url (RFC 4648 section 5). */
export const toBase64Url = (bytes: Uint8Array): string => base64Of(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

/**
 * Strict inverse of toBase64Url: throws on anything outside the base64url alphabet (standard base64's + / and =
 * included, whitespace too) and on an impossible length, so callers treat a throw as "invalid".
 */
export const fromBase64Url = (text: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new Error('not base64url')
  return Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0))
}
