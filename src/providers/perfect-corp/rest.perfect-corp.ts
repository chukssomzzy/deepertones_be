import { firstValueFrom } from 'rxjs'
import { base64Of } from '../../lib/base64'
import { timingSafeEqual } from '../../lib/crypto'
import { type HttpBytesResponse, type HttpResponse, HttpTooLargeError, HttpTransportError, requestBytes$, requestJson$ } from '../../lib/http'
import {
  FITZPATRICK_TYPES,
  type ConcernScore,
  type FitzpatrickResult,
  type FitzpatrickType,
  type PerfectCorpClient,
  PerfectCorpBadRequestError,
  PerfectCorpCreditError,
  PerfectCorpRejectedPhotoError,
  PerfectCorpUnavailableError,
  type RejectedPhotoReason,
  type SkinAnalysisResult,
  type WebhookCheck,
  type WebhookRejection,
} from './perfect-corp.provider'

export type RestPerfectCorpClientConfig = {
  apiKey: string
  /** The Standard Webhooks secret as Perfect Corp shows it: `whsec_` and then base64, or the base64 alone. */
  webhookSecret: string
  /** The API address with no trailing slash, e.g. https://yce-api-01.makeupar.com */
  baseUrl: string
  /** Give up on a request after this long; default 15000. */
  timeoutMs?: number
  /** The largest overlay mask accepted; default 8 MiB. */
  maxMaskBytes?: number
  /** The clock the webhook's age is judged by. */
  now?: () => Date
}

/** The task errors that mean the photo is the problem, and so a retake can fix it. Every other error code is an outage to the user. */
const REJECTIONS: Record<string, RejectedPhotoReason> = {
  error_lighting_dark: 'too-dark',
  error_pose: 'turn-to-camera',
  error_face_angle_yaw: 'turn-to-camera',
  error_face_angle_pitch: 'turn-to-camera',
  error_face_angle_roll: 'turn-to-camera',
  error_src_face_too_small: 'move-closer',
  error_src_face_out_of_bound: 'face-not-centred',
  error_no_face: 'no-face',
  error_below_min_image_size: 'image-size',
  error_exceed_max_image_size: 'image-size',
  // The Fitzpatrick analyzer's own codes.
  error_insufficient_lighting: 'too-dark',
  error_face_angle_invalid: 'turn-to-camera',
  error_face_position_too_small: 'move-closer',
  error_face_position_invalid: 'face-not-centred',
  error_face_position_out_of_boundary: 'face-not-centred',
}

type Json = Record<string, unknown>

/**
 * Perfect Corp (YouCam) over `requestJson$` and `requestBytes$`, not a vendor SDK: it is REST only. Nothing here retries; the job system
 * does. Errors carry a class, an HTTP status or a code-shaped vendor error code, and nothing else of what the vendor said: its free text
 * can echo a photo address or a key. Nothing is logged.
 *
 * The webhook body is verified against a real staging delivery: `data.taskId` and `data.taskStatus` in camelCase (the snake_case
 * `task_id` and `task_status` of the documentation are still accepted).
 *
 * UNVERIFIED VENDOR SHAPES, pinned from the brief and Perfect Corp's docs and to be checked against a real staging response: the result
 * of a skin analysis (`data.results.output`; an `hd_*` item with no string `region` is read as `whole`, since the reference gives hd_age_spot and
 * others no subcategories), the Fitzpatrick result (`data.results.fitzpatrick_scale`), the error body (`error_code`),
 * and the GET and delete paths.
 */
export class RestPerfectCorpClient implements PerfectCorpClient {
  private static readonly DEFAULT_TIMEOUT_MS = 15_000
  private static readonly DEFAULT_MAX_MASK_BYTES = 8 * 1024 * 1024
  private static readonly WEBHOOK_TOLERANCE_SECONDS = 5 * 60
  private static readonly SECRET_PREFIX = 'whsec_'
  // Vendor codes go into our error messages, so accept only code-shaped strings.
  private static readonly CODE_SHAPE = /^[A-Za-z0-9_]{1,64}$/
  // A body's key names go into the log of a rejected webhook, so only plain identifier-shaped ones, and few.
  private static readonly KEY_NAME_SHAPE = /^[A-Za-z0-9_]{1,40}$/
  private static readonly MAX_LOGGED_KEYS = 20
  // A rejected task status is logged as written, so only an enum-like word.
  private static readonly STATUS_SHAPE = /^[A-Za-z_-]{1,20}$/
  // A skipped item's type is logged as written, so only an hd code.
  private static readonly HD_TYPE_SHAPE = /^hd_[a-z_]{1,40}$/
  private static readonly WHOLE_FACE = 'whole'
  private static readonly WEBHOOK_HEADERS = ['webhook-id', 'webhook-timestamp', 'webhook-signature'] as const
  // A timestamp above this cannot be seconds before the year 5138, so the sender is counting milliseconds.
  private static readonly MILLISECOND_TIMESTAMP_FROM = 1e11

  // `#`, not `private`: these hold secrets, and a runtime-private field stays out of JSON.stringify and spreads.
  readonly #apiKey: string
  readonly #webhookSecret: string
  private readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly maxMaskBytes: number
  private readonly now: () => Date

  constructor(config: RestPerfectCorpClientConfig) {
    this.#apiKey = config.apiKey
    this.#webhookSecret = config.webhookSecret
    this.baseUrl = config.baseUrl
    this.timeoutMs = config.timeoutMs ?? RestPerfectCorpClient.DEFAULT_TIMEOUT_MS
    this.maxMaskBytes = config.maxMaskBytes ?? RestPerfectCorpClient.DEFAULT_MAX_MASK_BYTES
    this.now = config.now ?? (() => new Date())
  }

  async uploadFile(bytes: Uint8Array, options: { contentType: 'image/jpeg'; fileName: string }): Promise<string> {
    const reply = await this.api('POST', '/s2s/v2.0/file', {
      files: [{ content_type: options.contentType, file_name: options.fileName, file_size: bytes.byteLength }],
    })
    const file = RestPerfectCorpClient.first(RestPerfectCorpClient.object(RestPerfectCorpClient.data(reply)).files)
    const fileId = file.file_id
    const slot = RestPerfectCorpClient.first(file.requests)
    const { method, url, headers } = slot
    if (typeof fileId !== 'string' || fileId === '' || typeof method !== 'string' || typeof url !== 'string' || !url.startsWith('https://')) {
      throw new PerfectCorpUnavailableError('Perfect Corp gave no usable upload slot')
    }

    // The slot belongs to the storage behind it: it carries its own method and headers, and never our key.
    const response = await this.send(url, { method, headers: RestPerfectCorpClient.stringHeaders(headers), body: bytes })
    if (!response.ok) throw RestPerfectCorpClient.failure('upload', response)
    return fileId
  }

  async createSkinAnalysis(input: { fileId: string; actions: string[] }): Promise<string> {
    return this.createTask('/s2s/v2.0/task/skin-analysis', { src_file_id: input.fileId, dst_actions: input.actions, format: 'json' })
  }

  async createFitzpatrick(input: { fileId: string }): Promise<string> {
    return this.createTask('/s2s/v2.0/task/fitzpatrick-scale-analyzer', { src_file_id: input.fileId, version: '1.0' })
  }

  async getSkinAnalysis(taskId: string): Promise<SkinAnalysisResult> {
    const data = await this.readTask(`/s2s/v2.0/task/skin-analysis/${encodeURIComponent(taskId)}`)
    if (data === 'running') return { status: 'running' }

    const output = RestPerfectCorpClient.object(data.results).output
    if (!Array.isArray(output)) throw new PerfectCorpUnavailableError('Perfect Corp sent a skin analysis with no results')

    const concerns: ConcernScore[] = []
    const skipped: { type: string; problem: 'no-scores' }[] = []
    const skinTypes: { region: string; skinType: string }[] = []
    let skinAge: number | null = null
    let all: number | null = null
    for (const entry of output) {
      const item = RestPerfectCorpClient.object(entry)
      const { type } = item
      if (type === 'hd_skin_type') {
        if (typeof item.region === 'string' && typeof item.skin_type === 'string') skinTypes.push({ region: item.region, skinType: item.skin_type })
      } else if (type === 'skin_age') {
        if (typeof item.score === 'number') skinAge = item.score
      } else if (type === 'all') {
        if (typeof item.score === 'number') all = item.score
      } else if (typeof type === 'string' && type.startsWith('hd_')) {
        // An item without both scores is left out: it is a thing the vendor did not measure, not a measurement of zero. Its type is reported, once, for the log.
        if (typeof item.raw_score !== 'number' || typeof item.ui_score !== 'number') {
          if (RestPerfectCorpClient.HD_TYPE_SHAPE.test(type)) skipped.push({ type, problem: 'no-scores' })
          continue
        }
        const maskUrls = Array.isArray(item.mask_urls) ? item.mask_urls.filter((url): url is string => typeof url === 'string') : []
        // The reference gives hd_age_spot, hd_redness, hd_radiance and others no subcategories, so their items carry no region: that is the whole face.
        const region = typeof item.region === 'string' ? item.region : RestPerfectCorpClient.WHOLE_FACE
        concerns.push({ concern: type, region, rawScore: item.raw_score, uiScore: item.ui_score, maskUrls })
      }
    }
    return { status: 'success', concerns, skinTypes, skinAge, all, skipped }
  }

  async getFitzpatrick(taskId: string): Promise<FitzpatrickResult> {
    const data = await this.readTask(`/s2s/v2.0/task/fitzpatrick-scale-analyzer/${encodeURIComponent(taskId)}`)
    if (data === 'running') return { status: 'running' }

    const scale = RestPerfectCorpClient.object(data.results).fitzpatrick_scale
    if (typeof scale !== 'string' || !(FITZPATRICK_TYPES as readonly string[]).includes(scale)) {
      throw new PerfectCorpUnavailableError('Perfect Corp sent a Fitzpatrick result with no usable type')
    }
    return { status: 'success', fitzpatrick: scale as FitzpatrickType }
  }

  async deleteTask(taskId: string): Promise<void> {
    await this.api('POST', '/s2s/v2.0/task/delete', { task_id: taskId })
  }

  async downloadMask(url: string): Promise<Uint8Array> {
    // The link comes from the vendor's reply, so it is vetted before anything is fetched: https only, never a plain, local or odd scheme.
    if (!RestPerfectCorpClient.isHttps(url)) throw new PerfectCorpBadRequestError('Perfect Corp mask address is not an https address')
    let response: HttpBytesResponse
    try {
      // The link is signed and belongs to the vendor's storage: no key goes to it, and a redirect is an error, not a place to follow.
      response = await firstValueFrom(requestBytes$(url, { method: 'GET', timeoutMs: this.timeoutMs, maxBytes: this.maxMaskBytes }))
    } catch (error) {
      if (error instanceof HttpTooLargeError) throw new PerfectCorpBadRequestError('Perfect Corp mask is over the size limit')
      if (error instanceof HttpTransportError) throw new PerfectCorpUnavailableError('Perfect Corp mask request failed before a response')
      throw error
    }
    if (!response.ok) throw RestPerfectCorpClient.failure('mask download', response)
    return response.bytes
  }

  async checkWebhook(body: string, headers: Headers): Promise<WebhookCheck> {
    const webhookId = headers.get('webhook-id')
    const timestamp = headers.get('webhook-timestamp')
    const signatures = headers.get('webhook-signature')
    const reject = (rejection: WebhookRejection): WebhookCheck => ({ ok: false, rejection })

    const missing = RestPerfectCorpClient.WEBHOOK_HEADERS.filter((name) => !headers.get(name))
    if (missing.length > 0 || !webhookId || !timestamp || !signatures) return reject({ reason: 'missing-headers', missing })
    // Digits only: Number() would read "0x10" as 16 and "" as 0.
    if (!/^\d+$/.test(timestamp)) return reject({ reason: 'bad-timestamp' })

    const entries = signatures.split(' ').filter((entry) => entry !== '')
    const keyBytes = RestPerfectCorpClient.decodedSecret(this.#webhookSecret)
    const signed = (id: string) => `${id}.${timestamp}.${body}`

    const nowSeconds = this.now().getTime() / 1000
    const sentSeconds = Number(timestamp)
    if (Math.abs(nowSeconds - sentSeconds) > RestPerfectCorpClient.WEBHOOK_TOLERANCE_SECONDS) {
      return reject({
        reason: 'stale-timestamp',
        skewSeconds: Math.round(nowSeconds - sentSeconds),
        // A sender that counts in milliseconds looks about 1000 times too far ahead; this is the skew it would have in seconds.
        skewIfMilliseconds: sentSeconds > RestPerfectCorpClient.MILLISECOND_TIMESTAMP_FROM ? Math.round(nowSeconds - sentSeconds / 1000) : null,
        signatureValid: keyBytes !== null && RestPerfectCorpClient.anyV1Matches(entries, await RestPerfectCorpClient.hmac(keyBytes, signed(webhookId))),
      })
    }

    if (keyBytes === null) return reject({ reason: 'unreadable-secret' })
    if (!RestPerfectCorpClient.anyV1Matches(entries, await RestPerfectCorpClient.hmac(keyBytes, signed(webhookId)))) {
      return reject(await this.mismatch(entries, body, webhookId, signed, keyBytes))
    }

    const payload = RestPerfectCorpClient.parseJson(body)
    const keys = RestPerfectCorpClient.layout(payload)
    if (payload === undefined) return reject({ reason: 'bad-shape', problem: 'not-json', ...keys })
    const data = RestPerfectCorpClient.isObject(payload) ? payload.data : undefined
    if (!RestPerfectCorpClient.isObject(data)) return reject({ reason: 'bad-shape', problem: 'no-data', ...keys })
    // Perfect Corp sends camelCase; the documentation says snake_case. snake_case wins per field when it is usable.
    const taskId = typeof data.task_id === 'string' && data.task_id !== '' ? data.task_id : data.taskId
    // A status that is there but wrong does not fall back: it would let a stale spelling hide the real one.
    const taskStatus = data.task_status !== undefined ? data.task_status : data.taskStatus
    if (typeof taskId !== 'string' || taskId === '') return reject({ reason: 'bad-shape', problem: 'no-task-id', ...keys })
    if (taskStatus !== 'success' && taskStatus !== 'error') {
      const enumLike = typeof taskStatus === 'string' && RestPerfectCorpClient.STATUS_SHAPE.test(taskStatus)
      return reject({ reason: 'bad-shape', problem: 'bad-task-status', ...(enumLike ? { taskStatusValue: taskStatus } : {}), ...keys })
    }
    return { ok: true, delivery: { webhookId, taskId, taskStatus } }
  }

  /**
   * Why no v1 signature matched: which other readings of the secret and the id WOULD have matched, and the layout of the body. Only
   * yes or no and key names come out, never a signature, so this tells a sender's mistake apart without handing anything over.
   */
  private async mismatch(entries: string[], body: string, webhookId: string, signed: (id: string) => string, keyBytes: Uint8Array): Promise<WebhookRejection> {
    const secret = this.#webhookSecret
    const unprefixed = secret.startsWith(RestPerfectCorpClient.SECRET_PREFIX) ? secret.slice(RestPerfectCorpClient.SECRET_PREFIX.length) : secret
    const textKeys = [...new Set([secret, unprefixed])].map((text) => new TextEncoder().encode(text))
    const colon = webhookId.indexOf(':')
    const bareId = colon === -1 ? null : webhookId.slice(0, colon)

    const matches = async (keys: Uint8Array[], id: string | null) => {
      if (id === null) return false
      let matched = false
      for (const key of keys) if (RestPerfectCorpClient.anyV1Matches(entries, await RestPerfectCorpClient.hmac(key, signed(id)))) matched = true
      return matched
    }
    const versions = entries.map((entry) => {
      const version = entry.includes(',') ? entry.slice(0, entry.indexOf(',')) : ''
      return /^v\d{1,3}$/.test(version) ? version : 'other'
    })
    return {
      reason: 'signature-mismatch',
      versions: [...new Set(versions)].sort(),
      signatureCount: entries.length,
      undecodedSecretWouldMatch: await matches(textKeys, webhookId),
      idWithoutSuffixWouldMatch: await matches([keyBytes], bareId),
      undecodedAndIdWithoutSuffixWouldMatch: await matches(textKeys, bareId),
      ...RestPerfectCorpClient.layout(RestPerfectCorpClient.parseJson(body)),
    }
  }

  /** The secret as the bytes it keys the HMAC with: `whsec_` stripped when present, then base64-decoded. Null when it cannot be read. */
  private static decodedSecret(secret: string): Uint8Array | null {
    try {
      const encoded = secret.startsWith(RestPerfectCorpClient.SECRET_PREFIX) ? secret.slice(RestPerfectCorpClient.SECRET_PREFIX.length) : secret
      const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0))
      // An empty key is no key: WebCrypto refuses to import one.
      return bytes.length > 0 ? bytes : null
    } catch {
      return null
    }
  }

  /** HMAC-SHA-256 of the message as base64. Null when the runtime refuses the key, which no signature can then match. */
  private static async hmac(keyBytes: Uint8Array, message: string): Promise<string | null> {
    try {
      const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      return base64Of(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))))
    } catch {
      return null
    }
  }

  /** Whether any `v1,<signature>` entry equals the expected one. Every entry is compared, so which one matched is not a matter of timing. Only v1 is known. */
  private static anyV1Matches(entries: string[], expected: string | null): boolean {
    if (expected === null) return false
    let matched = false
    for (const entry of entries) {
      const comma = entry.indexOf(',')
      if (comma === -1 || entry.slice(0, comma) !== 'v1') continue
      if (timingSafeEqual(expected, entry.slice(comma + 1))) matched = true
    }
    return matched
  }

  /** The parsed body, or undefined when it is not JSON (JSON.parse never gives undefined). */
  private static parseJson(body: string): unknown {
    try {
      return JSON.parse(body)
    } catch {
      return undefined
    }
  }

  private static isObject(value: unknown): value is Json {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
  }

  /** The key names of the body and of its `data`, for the log: only code-shaped names, sorted, at most 20 each. Empty at a level that is not an object. */
  private static layout(payload: unknown): { topLevelKeys: string[]; dataKeys: string[] } {
    const names = (value: unknown) =>
      RestPerfectCorpClient.isObject(value)
        ? Object.keys(value)
            .filter((key) => RestPerfectCorpClient.KEY_NAME_SHAPE.test(key))
            .sort()
            .slice(0, RestPerfectCorpClient.MAX_LOGGED_KEYS)
        : []
    return { topLevelKeys: names(payload), dataKeys: names(RestPerfectCorpClient.isObject(payload) ? payload.data : undefined) }
  }

  private async createTask(path: string, body: unknown): Promise<string> {
    const taskId = RestPerfectCorpClient.object(RestPerfectCorpClient.data(await this.api('POST', path, body))).task_id
    if (typeof taskId !== 'string' || taskId === '') throw new PerfectCorpUnavailableError('Perfect Corp gave no task id')
    return taskId
  }

  /** The `data` of a task that has ended well, 'running' while it runs. An ended-badly task throws. */
  private async readTask(path: string): Promise<Json | 'running'> {
    const data = RestPerfectCorpClient.object(RestPerfectCorpClient.data(await this.api('GET', path)))
    const { task_status: status } = data
    if (status === 'running') return 'running'
    if (status === 'success') return data
    if (status !== 'error') throw new PerfectCorpUnavailableError('Perfect Corp sent a task status it does not know')

    // `error` is the code; `error_message` is free text and is never read.
    const code = typeof data.error === 'string' ? data.error : ''
    // An own-property check: a code of "toString" must not find an inherited name.
    if (Object.hasOwn(REJECTIONS, code)) throw new PerfectCorpRejectedPhotoError(REJECTIONS[code]!)
    throw new PerfectCorpUnavailableError(`Perfect Corp task failed (code ${RestPerfectCorpClient.CODE_SHAPE.test(code) ? code : 'none'})`)
  }

  /** A call to the API, bearer-authorised. Resolves to the parsed body of a 2xx. */
  private async api(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const response = await this.send(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) throw RestPerfectCorpClient.failure('request', response)
    return response.body
  }

  private async send(url: string, init: RequestInit): Promise<HttpResponse> {
    try {
      return await firstValueFrom(requestJson$(url, { ...init, timeoutMs: this.timeoutMs }))
    } catch (error) {
      if (error instanceof HttpTransportError) throw new PerfectCorpUnavailableError('Perfect Corp request failed before a response')
      throw error
    }
  }

  /** What an answer that is not 2xx means. The vendor's text is never copied into the error. */
  private static failure(what: string, response: { status: number; body?: unknown }): Error {
    const { status } = response
    // 408 is the server giving up waiting for us: the same request may well work again.
    if (status >= 500 || status === 429 || status === 408) return new PerfectCorpUnavailableError(`Perfect Corp ${what} answered HTTP ${status}`)
    // The credit code only means something on a 400.
    if (status === 400 && (response.body as Json | null)?.error_code === 'CreditInsufficiency') {
      return new PerfectCorpCreditError('Perfect Corp has no units left')
    }
    return new PerfectCorpBadRequestError(`Perfect Corp ${what} answered HTTP ${status}`)
  }

  private static isHttps(url: string): boolean {
    try {
      return new URL(url).protocol === 'https:'
    } catch {
      return false
    }
  }

  private static object(value: unknown): Json {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : {}
  }

  private static data(reply: unknown): unknown {
    return RestPerfectCorpClient.object(reply).data
  }

  /** The first entry of a list, as an object; empty when there is none. */
  private static first(list: unknown): Json {
    return Array.isArray(list) ? RestPerfectCorpClient.object(list[0]) : {}
  }

  private static stringHeaders(headers: unknown): Record<string, string> {
    return Object.fromEntries(Object.entries(RestPerfectCorpClient.object(headers)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
  }
}
