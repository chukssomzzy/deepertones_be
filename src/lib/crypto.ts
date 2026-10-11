const encoder = new TextEncoder()

/** n decimal digits from the CSPRNG. Bytes above the largest multiple of 10 are rejected, so no digit is likelier. */
export const randomDigits = (n: number): string => {
  let digits = ''
  while (digits.length < n) {
    const bytes = crypto.getRandomValues(new Uint8Array(n - digits.length))
    for (const byte of bytes) {
      if (byte < 250) digits += byte % 10
    }
  }
  return digits.slice(0, n)
}

export const hmacSha256Hex = async (key: string, value: string): Promise<string> => {
  const cryptoKey = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ])
  const signature = await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(value))
  return Array.from(new Uint8Array(signature), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** Compares without stopping at the first difference, so timing does not reveal how much matched. */
export const timingSafeEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')

const fromBase64Url = (text: string) =>
  Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), (c) => c.charCodeAt(0))

const IV_BYTES = 12

/** AES-256-GCM key from HKDF-SHA-256(secret, empty salt, info). */
const deriveAesKey = async (secret: string, info: string, usage: 'encrypt' | 'decrypt') => {
  const material = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(0), info: encoder.encode(info) },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    [usage],
  )
}

/**
 * Encrypts `plaintext` for storage somewhere readable (e.g. a queue message). The key is derived
 * from `secret` and `info`, so a different `info` yields an unrelated key: that is what keeps this
 * key separate from the HMAC key `hmacSha256Hex` uses with the same secret. `aad` is authenticated,
 * not encrypted: opening with a different `aad` fails, which binds the text to its owner.
 * Output: base64url of a random 12-byte IV followed by the ciphertext.
 */
export const sealText = async (secret: string, info: string, plaintext: string, aad: string): Promise<string> => {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES))
  const key = await deriveAesKey(secret, info, 'encrypt')
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(aad) }, key, encoder.encode(plaintext)),
  )
  const out = new Uint8Array(IV_BYTES + ciphertext.length)
  out.set(iv)
  out.set(ciphertext, IV_BYTES)
  return toBase64Url(out)
}

/** Reverses sealText. Throws on any tampering, a wrong secret/info, or a different `aad`. */
export const openText = async (secret: string, info: string, sealed: string, aad: string): Promise<string> => {
  const bytes = fromBase64Url(sealed)
  const key = await deriveAesKey(secret, info, 'decrypt')
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, IV_BYTES), additionalData: encoder.encode(aad) },
    key,
    bytes.slice(IV_BYTES),
  )
  return new TextDecoder().decode(plain)
}
