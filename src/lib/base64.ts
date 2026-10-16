// fromCharCode(...bytes) on a whole photo overflows the call stack, so build the string in slices.
const CHUNK = 0x8000

export const base64Of = (bytes: Uint8Array): string => {
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(binary)
}
