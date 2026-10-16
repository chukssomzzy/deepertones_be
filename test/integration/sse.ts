// A bounded reader for server-sent-event streams, shared by the Durable Object unit tests and the scan stream's
// integration tests. A stream under test can be endless (an open scan), so nothing here can wait without a limit:
// every read has a deadline, and a stream that stays quiet gives back what it had, with `ended: false`.

export type SseRead = {
  /** The frames read by this call, in order, each without its blank-line terminator. */
  frames: string[]
  /** True when the server closed the stream. False when the call stopped for any other reason (enough frames, or the deadline). */
  ended: boolean
}

export type SseReader = {
  /**
   * Reads until `count` more frames arrived, the stream ended, or `timeoutMs` passed. Frames that arrived together are
   * kept for the next call, so a test can read, act, and read again from the same stream.
   */
  read(count: number, timeoutMs?: number): Promise<SseRead>
  /** Releases the stream. Always call it: an unread stream keeps its Durable Object busy. Safe to call twice. */
  cancel(): Promise<void>
}

const DEFAULT_TIMEOUT_MS = 2000

export const sseReader = (res: Response): SseReader => {
  if (!res.body) throw new Error(`the response has no body (status ${res.status})`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  const queued: string[] = []
  let buffer = ''
  let ended = false
  // A read that timed out is still pending on the reader; the next call must wait on the same one or its chunk is lost.
  let inflight: Promise<ReadableStreamReadResult<Uint8Array>> | null = null

  const read = async (count: number, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<SseRead> => {
    const deadline = Date.now() + timeoutMs
    const frames: string[] = []
    const take = () => {
      while (frames.length < count && queued.length > 0) frames.push(queued.shift()!)
    }
    take()
    while (frames.length < count && !ended) {
      const left = deadline - Date.now()
      if (left <= 0) break
      inflight ??= reader.read().catch(() => ({ done: true, value: undefined }) as ReadableStreamReadResult<Uint8Array>)
      let timer: ReturnType<typeof setTimeout> | undefined
      const result = await Promise.race([
        inflight,
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), left)
        }),
      ])
      clearTimeout(timer)
      if (result === 'timeout') break
      inflight = null
      if (result.done) {
        ended = true
        break
      }
      buffer += decoder.decode(result.value, { stream: true })
      for (let i = buffer.indexOf('\n\n'); i >= 0; i = buffer.indexOf('\n\n')) {
        queued.push(buffer.slice(0, i))
        buffer = buffer.slice(i + 2)
      }
      take()
    }
    // The stream only counts as ended for this call once every frame it delivered has been handed out.
    return { frames, ended: ended && queued.length === 0 }
  }

  return {
    read,
    cancel: async () => {
      await reader.cancel().catch(() => {})
    },
  }
}

/** One read of up to `count` frames from a fresh stream, then the stream is released. */
export const readFrames = async (res: Response, count: number, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<SseRead> => {
  const stream = sseReader(res)
  try {
    return await stream.read(count, timeoutMs)
  } finally {
    await stream.cancel()
  }
}

export type ParsedFrame = { event: string | null; data: unknown; comment: string | null }

/**
 * Splits a frame into its `event:` name and its JSON `data:`, or its `:` comment. A frame with no data line has
 * `data: undefined`; data that is not JSON is returned as the raw string.
 */
export const parseFrame = (frame: string): ParsedFrame => {
  let event: string | null = null
  let comment: string | null = null
  const data: string[] = []
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) comment = line.slice(1).trim()
    else if (line.startsWith('event:')) event = line.slice('event:'.length).trim()
    else if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart())
  }
  if (data.length === 0) return { event, data: undefined, comment }
  const raw = data.join('\n')
  try {
    return { event, data: JSON.parse(raw), comment }
  } catch {
    return { event, data: raw, comment }
  }
}
