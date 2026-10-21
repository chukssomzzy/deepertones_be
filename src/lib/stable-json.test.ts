import { describe, expect, it } from 'vitest'
import { stableJson } from './stable-json'

describe('stableJson', () => {
  it('writes the keys of an object in sorted order, whatever order they were given in', () => {
    expect(stableJson({ b: 1, a: 2, c: 3 })).toBe('{"a":2,"b":1,"c":3}')
    expect(stableJson({ c: 3, a: 2, b: 1 })).toBe(stableJson({ b: 1, c: 3, a: 2 }))
  })

  it('sorts the keys of nested objects too, including those inside arrays', () => {
    expect(stableJson({ z: { y: 1, x: 2 }, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"z":{"x":2,"y":1}}')
  })

  it('keeps the order of an array, since the order of a list is part of what it says', () => {
    expect(stableJson([3, 1, 2])).toBe('[3,1,2]')
    expect(stableJson({ list: ['b', 'a'] })).not.toBe(stableJson({ list: ['a', 'b'] }))
  })

  it('leaves out a key whose value is undefined, so it reads the same as a key that is not there', () => {
    expect(stableJson({ a: 1, b: undefined })).toBe('{"a":1}')
    expect(stableJson({ a: 1, b: undefined })).toBe(stableJson({ a: 1 }))
    expect(stableJson({ outer: { gone: undefined, kept: null } })).toBe('{"outer":{"kept":null}}')
  })

  it('keeps null, and writes strings, numbers and booleans as JSON does', () => {
    expect(stableJson(null)).toBe('null')
    expect(stableJson({ n: null, s: 'say "hi"\n', x: 1.5, t: true, f: false })).toBe('{"f":false,"n":null,"s":"say \\"hi\\"\\n","t":true,"x":1.5}')
  })

  it('writes an empty object and an empty array as such', () => {
    expect(stableJson({})).toBe('{}')
    expect(stableJson([])).toBe('[]')
    expect(stableJson({ a: {}, b: [] })).toBe('{"a":{},"b":[]}')
  })

  it('escapes a key as JSON does, so keys that hold quotes cannot be confused with structure', () => {
    expect(stableJson({ 'a"b': 1 })).toBe('{"a\\"b":1}')
  })
})
