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
