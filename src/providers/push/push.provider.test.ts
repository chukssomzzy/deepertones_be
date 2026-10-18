import { describe, expect, it } from 'vitest'
import { isExpoPushToken } from './push.provider'

const tokenOfLength = (length: number) => {
  const prefix = 'ExponentPushToken['
  return `${prefix}${'x'.repeat(length - prefix.length - 1)}]`
}

describe('isExpoPushToken', () => {
  it('accepts a token of exactly 256 characters', () => {
    const token = tokenOfLength(256)
    expect(token).toHaveLength(256)
    expect(isExpoPushToken(token)).toBe(true)
  })

  it('rejects a token of 257 characters, one over the limit', () => {
    const token = tokenOfLength(257)
    expect(token).toHaveLength(257)
    expect(isExpoPushToken(token)).toBe(false)
  })

  it.each(['ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]', 'ExpoPushToken[abc]'])('accepts %s', (token) => {
    expect(isExpoPushToken(token)).toBe(true)
  })

  it.each([
    ['an empty string', ''],
    ['an empty inner part', 'ExponentPushToken[]'],
    ['a missing closing bracket', 'ExponentPushToken[abc'],
    ['a native FCM token', 'fcm-token'],
    ['leading whitespace (no trimming)', ' ExponentPushToken[abc]'],
    ['trailing whitespace (no trimming)', 'ExponentPushToken[abc] '],
    ['a trailing newline', 'ExponentPushToken[abc]\n'],
    ['a space inside the brackets', 'ExponentPushToken[a bc]'],
    ['a tab inside the brackets', 'ExponentPushToken[a\tbc]'],
    ['a newline inside the brackets', 'ExponentPushToken[a\nbc]'],
    ['a space only inside the brackets', 'ExpoPushToken[ ]'],
  ])('rejects %s', (_label, token) => {
    expect(isExpoPushToken(token)).toBe(false)
  })
})
