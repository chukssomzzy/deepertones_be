import { env } from 'cloudflare:workers'
import { vi } from 'vitest'

// A stand-in for the Perfect Corp (YouCam) API for the integration tests, installed over the global fetch: the Worker's container builds its own
// RestPerfectCorpClient per message, so the client cannot be handed a stub, only the fetch it will call. Nothing here reaches the network.
//
// The vendor shapes are the ones rest.perfect-corp.test.ts pins (still to be checked against a real staging response): the upload slot, the task
// id, `data.results.output` for a skin analysis, `data.results.fitzpatrick_scale`, `error` for a task that ended badly and `error_code` for a
// refused request.

export const API = env.PERFECT_CORP_BASE_URL
export const UPLOAD_HOST = 'https://upload.perfect-corp.test'
export const MASK_HOST = 'https://masks.perfect-corp.test'

export type VendorCall = { method: string; url: string; body: unknown }

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

export const running = () => json({ status: 200, data: { task_status: 'running' } })
export const skinSuccess = (output: unknown[]) => json({ status: 200, data: { task_status: 'success', results: { output } } })
export const fitzpatrickSuccess = (scale: string) => json({ status: 200, data: { task_status: 'success', results: { fitzpatrick_scale: scale } } })
/** A task that ended badly; `error` is the vendor's code, e.g. `error_no_face` (a photo problem) or `error_internal` (an outage). */
export const taskError = (error: string) => json({ status: 200, data: { task_status: 'error', error, error_message: 'private vendor text' } })
export const outage = () => json({ status: 503, error: 'unavailable' }, 503)
export const noCredit = () => json({ status: 400, error: 'no units', error_code: 'CreditInsufficiency' }, 400)

export const maskUrl = (name: string) => `${MASK_HOST}/${name}.png?sig=test`
/** What a finished analysis for the `glow` goal says: masks on two of its three concerns, a dry whole-face skin type, a skin age and the overall score. */
export const glowOutput = () => [
  { type: 'hd_radiance', region: 'whole', raw_score: 41.5, ui_score: 52, mask_urls: [maskUrl('radiance')] },
  { type: 'hd_moisture', region: 'whole', raw_score: 62, ui_score: 70, mask_urls: [maskUrl('moisture')] },
  { type: 'hd_texture', region: 'whole', raw_score: 55, ui_score: 63, mask_urls: [] },
  { type: 'hd_skin_type', region: 'whole', skin_type: 'Dry' },
  { type: 'skin_age', score: 31 },
  { type: 'all', score: 70 },
]

type Override = { when: (call: VendorCall) => boolean; respond: () => Response; once: boolean }

/**
 * Installs the stub. Tasks get ids of their own on every run (the database is shared). A task answers `running` until a test says otherwise with
 * `answerSkin` / `answerFitzpatrick` (by task id, taken from the scan row once the upload step has run); `override` makes one kind of call answer
 * something else, once or for good. Call `vi.unstubAllGlobals()` afterwards.
 */
export const stubPerfectCorp = () => {
  const calls: VendorCall[] = []
  const skin = new Map<string, () => Response>()
  const fitzpatrick = new Map<string, () => Response>()
  const overrides: Override[] = []
  const suffix = crypto.randomUUID().slice(0, 8)
  let files = 0
  let tasks = 0

  const handle = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : init?.body
    const call = { method, url, body }
    calls.push(call)

    const index = overrides.findIndex((override) => override.when(call))
    if (index >= 0) {
      const override = overrides[index]!
      if (override.once) overrides.splice(index, 1)
      return override.respond()
    }
    if (url.startsWith(UPLOAD_HOST)) return new Response(null, { status: 200 })
    if (url.startsWith(MASK_HOST)) return new Response(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]), { status: 200, headers: { 'Content-Type': 'image/png' } })
    if (!url.startsWith(API)) throw new Error(`the test reached an address it did not expect: ${url}`)

    const path = url.slice(API.length)
    if (method === 'POST' && path === '/s2s/v2.0/file') {
      const id = `file-${suffix}-${++files}`
      return json({ status: 200, data: { files: [{ content_type: 'image/jpeg', file_name: 'front.jpg', file_id: id, requests: [{ method: 'PUT', url: `${UPLOAD_HOST}/${id}`, headers: { 'Content-Type': 'image/jpeg' } }] }] } })
    }
    if (method === 'POST' && path === '/s2s/v2.0/task/skin-analysis') return json({ status: 200, data: { task_id: `skin-${suffix}-${++tasks}` } })
    if (method === 'POST' && path === '/s2s/v2.0/task/fitzpatrick-scale-analyzer') return json({ status: 200, data: { task_id: `fitz-${suffix}-${++tasks}` } })
    if (method === 'POST' && path === '/s2s/v2.0/task/delete') return json({ status: 200, data: {} })
    const skinTask = /^\/s2s\/v2\.0\/task\/skin-analysis\/(.+)$/.exec(path)?.[1]
    if (method === 'GET' && skinTask) return (skin.get(decodeURIComponent(skinTask)) ?? running)()
    const fitzTask = /^\/s2s\/v2\.0\/task\/fitzpatrick-scale-analyzer\/(.+)$/.exec(path)?.[1]
    if (method === 'GET' && fitzTask) return (fitzpatrick.get(decodeURIComponent(fitzTask)) ?? running)()
    throw new Error(`the test reached a Perfect Corp call it did not expect: ${method} ${path}`)
  }
  vi.stubGlobal('fetch', handle)

  return {
    calls,
    /** The calls made so far to a path (its part after the base address) with the given method. */
    callsTo: (method: string, path: string | RegExp) => calls.filter((call) => call.method === method && (typeof path === 'string' ? call.url === `${API}${path}` : path.test(call.url.slice(API.length)))),
    answerSkin: (taskId: string, reply: () => Response) => void skin.set(taskId, reply),
    answerFitzpatrick: (taskId: string, reply: () => Response) => void fitzpatrick.set(taskId, reply),
    override: (when: (call: VendorCall) => boolean, respond: () => Response, { once = false }: { once?: boolean } = {}) => void overrides.push({ when, respond, once }),
  }
}
export type PerfectCorpStub = ReturnType<typeof stubPerfectCorp>

const bytesOfBase64 = (text: string) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0))
const base64Of = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)))

/**
 * Signs a webhook the way the Standard Webhooks spec says (and so independently of the code that checks it): HMAC-SHA-256, keyed with the base64-decoded
 * secret (after its `whsec_` prefix), over `<id>.<timestamp>.<raw body>`, sent as `v1,<base64>`. `timestampSeconds` defaults to now; `secret` to the
 * Worker's own, so a test can sign with another to make a forgery.
 */
export const signedWebhook = async (
  taskId: string,
  options: { webhookId?: string; taskStatus?: 'success' | 'error'; timestampSeconds?: number; secret?: string; body?: string } = {},
): Promise<{ body: string; headers: Record<string, string>; webhookId: string }> => {
  const webhookId = options.webhookId ?? `msg_${crypto.randomUUID()}`
  const timestamp = String(options.timestampSeconds ?? Math.floor(Date.now() / 1000))
  const body = options.body ?? JSON.stringify({ created_at: Number(timestamp), data: { task_id: taskId, task_status: options.taskStatus ?? 'success' } })
  const secret = options.secret ?? env.PERFECT_CORP_WEBHOOK_SECRET!
  const key = await crypto.subtle.importKey('raw', bytesOfBase64(secret.replace(/^whsec_/, '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = base64Of(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${webhookId}.${timestamp}.${body}`)))
  return { body, webhookId, headers: { 'content-type': 'application/json', 'webhook-id': webhookId, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` } }
}

/** A queue producer that keeps what is sent to it, and can be made to fail. */
export const queueRecorder = () => {
  const messages: unknown[] = []
  const state = { failing: false }
  const queue = {
    send: async (body: unknown) => {
      if (state.failing) throw new Error('queue is down')
      messages.push(body)
    },
    sendBatch: async () => {},
  } as unknown as Queue
  return { queue, messages, state }
}
