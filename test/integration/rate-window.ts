// Miniflare's rate-limit binding counts in fixed windows aligned to the wall-clock minute (epoch = floor(now / 60 s)),
// and a new epoch restarts every key's count. A burst that straddles a minute boundary therefore never reaches its
// limit and the expected 429 never comes. The limiter runs in another isolate on the real clock, so fake timers cannot
// help: a rate-limit test has to keep its whole burst inside one window.

export const RATE_WINDOW_MS = 60 * 1000
/** The default room `startOfRateWindow` asks for. */
export const SAFE_WINDOW_MS = 20 * 1000
/** A burst of up to ~21 requests needs this much of a window left; generous, as the full suite runs the bursts slowly. */
export const BURST_NEEDS_MS = 30 * 1000
/** Worst case: a wait for the next window (<= 60 s), a burst that straddles it, another wait, and a second burst. */
export const RATE_TEST_TIMEOUT_MS = 2 * RATE_WINDOW_MS + 60 * 1000

// A little past the boundary, so the wait never ends in the window it was leaving.
const MARGIN_MS = 50

const windowOf = (at: number) => Math.floor(at / RATE_WINDOW_MS)
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/** Resolves once at least `needMs` of the current window remain, sleeping into the next window when they do not. */
export const startOfRateWindow = async (needMs: number = SAFE_WINDOW_MS) => {
  const remaining = RATE_WINDOW_MS - (Date.now() % RATE_WINDOW_MS)
  if (remaining < needMs) await sleep(remaining + MARGIN_MS)
}

/**
 * Runs `burst` inside one rate-limit window and returns what it returned. It waits until `needMs` of a window remain,
 * runs the burst, and checks that it started and ended in the same window. If it straddled a boundary the counters were
 * reset part-way, so the result means nothing: it waits for room again and runs the burst one more time, and fails when
 * that straddles too.
 *
 * The burst runs more than once at worst, so it must make its own keys (a fresh user, a fresh address) on every call, and
 * must only collect what it saw: assert on the returned value, after this resolves.
 */
export const inOneRateWindow = async <T>(burst: () => Promise<T>, { needMs }: { needMs: number }): Promise<T> => {
  for (let attempt = 1; attempt <= 2; attempt++) {
    await startOfRateWindow(needMs)
    const startedAt = Date.now()
    const result = await burst()
    const endedAt = Date.now()
    if (windowOf(startedAt) === windowOf(endedAt)) {
      return result
    }
  }
  throw new Error(`the burst straddled a rate-limit window boundary twice (needMs=${needMs}); it is too slow to fit one 60 s window`)
}
