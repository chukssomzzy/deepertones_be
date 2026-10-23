// Fakes for the two catalog script runners (`runExport`, `runUpload`): every effect they have is handed in, so these stand in for the vars file on
// disk, the admin API and the terminal. Not a test file, so it is never run.

/** A distinctive admin token: if it shows up anywhere it must not, a test can say so. */
export const TOKEN = 'tok-SECRET-9f8e7d6c'
/** Another secret that sits in the same vars file and has no business being read, let alone printed. */
export const OTHER_SECRET = 'pepper-SECRET-1a2b3c4d'

export const VARS = `# the file the script reads\nOTP_PEPPER=${OTHER_SECRET}\nADMIN_API_TOKEN=${TOKEN}\n`

/** What the script asked the network for. */
export type Sent = { url: string; method: string; headers: Headers; body: BodyInit | null | undefined; timeoutMs: number }

export type Reply = { status: number; body: unknown } | Error

type Init = { method?: string; headers?: HeadersInit; body?: BodyInit | null; timeoutMs: number }

/** The request seam: records every call and answers with `reply` (or rejects, when `reply` is an Error). */
export const fakeRequest = (reply: Reply | ((sent: Sent) => Reply)) => {
  const sent: Sent[] = []
  const request = async (url: string, init: Init) => {
    const call: Sent = { url, method: init.method ?? 'GET', headers: new Headers(init.headers), body: init.body, timeoutMs: init.timeoutMs }
    sent.push(call)
    const answer = typeof reply === 'function' ? reply(call) : reply
    if (answer instanceof Error) throw answer
    return { status: answer.status, ok: answer.status >= 200 && answer.status < 300, body: answer.body }
  }
  return { sent, request }
}

/** The project's success envelope around `data`. */
export const okReply = (data: unknown): Reply => ({ status: 200, body: { success: true, status: 200, message: 'OK', data } })

/** The project's error envelope. */
export const errorReply = (status: number, code: string, details?: unknown): Reply => ({
  status,
  body: { success: false, status, message: `${code} happened`, error: { code, details, requestId: 'req-1' } },
})

/** The terminal: everything the script said, on either stream. */
export const fakeOutput = () => {
  const out: string[] = []
  const err: string[] = []
  return {
    log: (line: string) => void out.push(line),
    error: (line: string) => void err.push(line),
    stdout: () => out.join('\n'),
    stderr: () => err.join('\n'),
    text: () => [...out, ...err].join('\n'),
  }
}

/** Reads text files from `files`; anything else is missing, the way the file system says it. */
export const fakeReadText = (files: Record<string, string>) => {
  const reads: string[] = []
  const readText = async (path: string): Promise<string> => {
    reads.push(path)
    const contents = files[path]
    if (contents === undefined) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), { code: 'ENOENT' })
    return contents
  }
  return { reads, readText }
}
