/** Wraps a factory so it runs on first call and returns the same instance afterwards. */
export const once = <T>(factory: () => T): (() => T) => {
  let built = false
  let value: T
  return () => {
    if (!built) {
      value = factory()
      built = true
    }
    return value
  }
}
