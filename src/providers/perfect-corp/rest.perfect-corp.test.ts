import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PerfectCorpBadRequestError,
  PerfectCorpCreditError,
  PerfectCorpRejectedPhotoError,
  PerfectCorpUnavailableError,
} from './perfect-corp.provider'
import { RestPerfectCorpClient } from './rest.perfect-corp'

// The Perfect Corp (YouCam) adapter against a stubbed fetch: request shapes, answers, error mapping and the webhook signature. The real
// API is never called. Vendor shapes come from issue #112 and Perfect Corp's docs.
//
// UNVERIFIED VENDOR SHAPES (pinned here from the brief, to check against a real staging response before relying on them):
//   skin analysis result:  data.results.output = [ { type, region, raw_score, ui_score, mask_urls }, { type: 'hd_skin_type', region,
//                          skin_type }, { type: 'skin_age', score }, { type: 'all', score } ]  (per Perfect Corp's own format_json_success example)
//   fitzpatrick result:    data.results.fitzpatrick_scale = 'I' .. 'VI'
//   error body:            { status, error, error_code } with error_code 'CreditInsufficiency' on 400
//   GET paths:             /s2s/v2.0/task/skin-analysis/<id> and /s2s/v2.0/task/fitzpatrick-scale-analyzer/<id>
//   delete body:           { task_id }

const BASE_URL = 'https://perfect-corp.test'
const API_KEY = 'pc-super-secret-api-key-482913'
const PRIVATE_TEXT = 'Private vendor text 482913'
const UPLOAD_URL = 'https://upload.test/put/abc?sig=private-signature-482913'
const MASK_URL = 'https://masks.test/age_spot.png?sig=private-mask-482913'

const NOW = new Date('2030-06-15T12:00:00.000Z')
const NOW_SECONDS = NOW.getTime() / 1000
const TOLERANCE_SECONDS = 5 * 60

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

type Call = { url: string; method: string; init: RequestInit; body: unknown }

const config = { apiKey: API_KEY, webhookSecret: 'whsec_' + btoa('0123456789abcdef0123456789abcdef'), baseUrl: BASE_URL, now: () => NOW }

const make = (respond: (call: Call) => Response | Promise<Response>, overrides: Partial<ConstructorParameters<typeof RestPerfectCorpClient>[0]> = {}) => {
  const calls: Call[] = []
  const stub = async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : init?.body
    const call = { url: String(input), method: init?.method ?? 'GET', init: init ?? {}, body }
    calls.push(call)
    return respond(call)
  }
  vi.stubGlobal('fetch', stub)
  const client = new RestPerfectCorpClient({ ...config, ...overrides })
  return { client, calls }
}

const caught = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the promise to reject')
}

/** A fetch that never answers and rejects when the request is aborted, as a real one does on timeout. */
const hangs = () => {
  vi.stubGlobal('fetch', (_input: RequestInfo | URL, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5])

const FILE_REPLY = {
  status: 200,
  data: {
    files: [
      {
        content_type: 'image/jpeg',
        file_name: 'front.jpg',
        file_id: 'file-abc-123',
        requests: [{ method: 'PUT', url: UPLOAD_URL, headers: { 'Content-Type': 'image/jpeg', 'x-amz-meta-test': 'kept' } }],
      },
    ],
  },
}

/** Answers the file request, then the upload. */
const uploadRoutes = (call: Call) => (call.url === `${BASE_URL}/s2s/v2.0/file` ? json(FILE_REPLY) : new Response(null, { status: 200 }))

const taskReply = (taskStatus: 'running' | 'success' | 'error', fields: Record<string, unknown> = {}) =>
  json({ status: 200, data: { task_status: taskStatus, ...fields } })

describe('RestPerfectCorpClient', () => {
  it('keeps the API key and the webhook secret out of the client when it is serialised or spread', () => {
    const { client } = make(() => json({}))

    for (const text of [JSON.stringify(client), JSON.stringify({ ...client })]) {
      expect(text).not.toContain(API_KEY)
      expect(text).not.toContain(config.webhookSecret)
    }
  })
})

describe('RestPerfectCorpClient.uploadFile', () => {
  it('asks for an upload slot with the content type, file name and exact byte size, as a bearer-authorised JSON POST to the configured base url', async () => {
    const { client, calls } = make(uploadRoutes)

    await client.uploadFile(BYTES, { contentType: 'image/jpeg', fileName: 'front.jpg' })

    const first = calls[0]!
    expect(first.url).toBe(`${BASE_URL}/s2s/v2.0/file`)
    expect(first.method).toBe('POST')
    expect(first.body).toEqual({ files: [{ content_type: 'image/jpeg', file_name: 'front.jpg', file_size: BYTES.byteLength }] })
    const headers = new Headers(first.init.headers)
    expect(headers.get('Authorization')).toBe(`Bearer ${API_KEY}`)
    expect(headers.get('Content-Type')).toBe('application/json')
  })

  it('then PUTs the bytes to the url in files[0].requests[0], with the method and headers it came with, and returns the file id', async () => {
    const { client, calls } = make(uploadRoutes)

    const fileId = await client.uploadFile(BYTES, { contentType: 'image/jpeg', fileName: 'front.jpg' })

    expect(fileId).toBe('file-abc-123')
    expect(calls).toHaveLength(2)
    const put = calls[1]!
    expect(put.url).toBe(UPLOAD_URL)
    expect(put.method).toBe('PUT')
    const headers = new Headers(put.init.headers)
    expect(headers.get('Content-Type')).toBe('image/jpeg')
    expect(headers.get('x-amz-meta-test')).toBe('kept')
    expect(new Uint8Array(put.body as ArrayBuffer | Uint8Array)).toEqual(BYTES)
  })

  it('does not send the API key to the upload address, which belongs to somebody else', async () => {
    const { client, calls } = make(uploadRoutes)

    await client.uploadFile(BYTES, { contentType: 'image/jpeg', fileName: 'front.jpg' })

    expect(new Headers(calls[1]!.init.headers).get('Authorization')).toBeNull()
  })

  it('uses the method the slot names, not a fixed one', async () => {
    const reply = { status: 200, data: { files: [{ ...FILE_REPLY.data.files[0], requests: [{ method: 'POST', url: UPLOAD_URL, headers: {} }] }] } }
    const { client, calls } = make((call) => (call.url === `${BASE_URL}/s2s/v2.0/file` ? json(reply) : new Response(null, { status: 200 })))

    await client.uploadFile(BYTES, { contentType: 'image/jpeg', fileName: 'front.jpg' })

    expect(calls[1]!.method).toBe('POST')
  })

  it('makes no upload request when the slot cannot be had', async () => {
    const { client, calls } = make(() => json({ status: 500 }, 500))

    await caught(client.uploadFile(BYTES, { contentType: 'image/jpeg', fileName: 'front.jpg' }))

    expect(calls).toHaveLength(1)
  })

  it('reports an upload the vendor refuses as unavailable when it is a 5xx, and as a bad request when it is another 4xx', async () => {
    const refuse = (status: number) =>
      make((call) => (call.url === `${BASE_URL}/s2s/v2.0/file` ? json(FILE_REPLY) : new Response('denied', { status }))).client.uploadFile(BYTES, {
        contentType: 'image/jpeg',
        fileName: 'front.jpg',
      })

    expect(await caught(refuse(503))).toBeInstanceOf(PerfectCorpUnavailableError)
    expect(await caught(refuse(403))).toBeInstanceOf(PerfectCorpBadRequestError)
  })

  it('reports an upload that fails before any answer as unavailable', async () => {
    const { client } = make((call) => {
      if (call.url === `${BASE_URL}/s2s/v2.0/file`) return json(FILE_REPLY)
      throw new TypeError('network down')
    })

    expect(await caught(client.uploadFile(BYTES, { contentType: 'image/jpeg', fileName: 'front.jpg' }))).toBeInstanceOf(PerfectCorpUnavailableError)
  })

  it.each([
    ['no files', { status: 200, data: { files: [] } }],
    ['no data', { status: 200 }],
    ['no file id', { status: 200, data: { files: [{ requests: [{ method: 'PUT', url: UPLOAD_URL, headers: {} }] }] } }],
    ['no upload request', { status: 200, data: { files: [{ file_id: 'f', requests: [] }] } }],
  ])('reports a slot reply with %s as unavailable, never as a file id', async (_label, reply) => {
    const { client, calls } = make(() => json(reply))

    expect(await caught(client.uploadFile(BYTES, { contentType: 'image/jpeg', fileName: 'front.jpg' }))).toBeInstanceOf(PerfectCorpUnavailableError)
    expect(calls).toHaveLength(1)
  })
})

describe('RestPerfectCorpClient task creation', () => {
  it('creates a skin analysis task with exactly the file id, the actions and format json, and returns the task id', async () => {
    const { client, calls } = make(() => json({ status: 200, data: { task_id: 'task-skin-1' } }))

    const taskId = await client.createSkinAnalysis({ fileId: 'file-abc-123', actions: ['hd_acne', 'hd_pore', 'hd_oiliness', 'hd_skin_type'] })

    expect(taskId).toBe('task-skin-1')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${BASE_URL}/s2s/v2.0/task/skin-analysis`)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.body).toEqual({ src_file_id: 'file-abc-123', dst_actions: ['hd_acne', 'hd_pore', 'hd_oiliness', 'hd_skin_type'], format: 'json' })
    const headers = new Headers(calls[0]!.init.headers)
    expect(headers.get('Authorization')).toBe(`Bearer ${API_KEY}`)
    expect(headers.get('Content-Type')).toBe('application/json')
  })

  it('creates a Fitzpatrick task with exactly the file id and version 1.0, and returns the task id', async () => {
    const { client, calls } = make(() => json({ status: 200, data: { task_id: 'task-fitz-1' } }))

    const taskId = await client.createFitzpatrick({ fileId: 'file-abc-123' })

    expect(taskId).toBe('task-fitz-1')
    expect(calls[0]!.url).toBe(`${BASE_URL}/s2s/v2.0/task/fitzpatrick-scale-analyzer`)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.body).toEqual({ src_file_id: 'file-abc-123', version: '1.0' })
    expect(new Headers(calls[0]!.init.headers).get('Authorization')).toBe(`Bearer ${API_KEY}`)
  })

  it.each([
    ['no task id', { status: 200, data: {} }],
    ['no data', { status: 200 }],
    ['an empty task id', { status: 200, data: { task_id: '' } }],
    ['a task id that is not text', { status: 200, data: { task_id: 7 } }],
  ])('reports a reply with %s as unavailable', async (_label, reply) => {
    const { client } = make(() => json(reply))

    expect(await caught(client.createSkinAnalysis({ fileId: 'f', actions: ['hd_acne'] }))).toBeInstanceOf(PerfectCorpUnavailableError)
    expect(await caught(client.createFitzpatrick({ fileId: 'f' }))).toBeInstanceOf(PerfectCorpUnavailableError)
  })
})

describe('RestPerfectCorpClient.getSkinAnalysis', () => {
  const OUTPUT = [
    { type: 'hd_age_spot', region: 'whole', raw_score: 57.33, ui_score: 68, mask_urls: [MASK_URL] },
    { type: 'hd_age_spot', region: 'left_cheek', raw_score: 41.5, ui_score: 52, mask_urls: [MASK_URL, MASK_URL + '2'] },
    { type: 'hd_acne', region: 'whole', raw_score: 88, ui_score: 90 },
    { type: 'hd_skin_type', region: 'whole', skin_type: 'Dry & Redness' },
    { type: 'hd_skin_type', region: 't_zone', skin_type: 'Oily' },
    { type: 'skin_age', score: 29.4 },
    { type: 'all', score: 72.5 },
  ]

  it('reads the task from its own url, bearer-authorised', async () => {
    const { client, calls } = make(() => taskReply('running'))

    await client.getSkinAnalysis('task-skin-1')

    expect(calls[0]!.url).toBe(`${BASE_URL}/s2s/v2.0/task/skin-analysis/task-skin-1`)
    expect(calls[0]!.method).toBe('GET')
    expect(new Headers(calls[0]!.init.headers).get('Authorization')).toBe(`Bearer ${API_KEY}`)
  })

  it('escapes a task id that is not url-safe, so it cannot reach another path', async () => {
    const { client, calls } = make(() => taskReply('running'))

    await client.getSkinAnalysis('a/b+c?d')

    expect(calls[0]!.url).toBe(`${BASE_URL}/s2s/v2.0/task/skin-analysis/a%2Fb%2Bc%3Fd`)
  })

  it('says running while the task is running', async () => {
    const { client } = make(() => taskReply('running'))

    await expect(client.getSkinAnalysis('t')).resolves.toEqual({ status: 'running' })
  })

  it('returns the concern items with their region, both scores and mask urls, the skin type items, the skin age and the overall item on success', async () => {
    const { client } = make(() => taskReply('success', { results: { output: OUTPUT } }))

    const result = await client.getSkinAnalysis('t')

    expect(result).toEqual({
      status: 'success',
      concerns: [
        { concern: 'hd_age_spot', region: 'whole', rawScore: 57.33, uiScore: 68, maskUrls: [MASK_URL] },
        { concern: 'hd_age_spot', region: 'left_cheek', rawScore: 41.5, uiScore: 52, maskUrls: [MASK_URL, MASK_URL + '2'] },
        { concern: 'hd_acne', region: 'whole', rawScore: 88, uiScore: 90, maskUrls: [] },
      ],
      skinTypes: [
        { region: 'whole', skinType: 'Dry & Redness' },
        { region: 't_zone', skinType: 'Oily' },
      ],
      skinAge: 29.4,
      all: 72.5,
    })
  })

  it('ignores a score on a concern item, and a raw_score or ui_score on a skin type, skin age or overall item: each kind carries only its own fields', async () => {
    const output = [
      { type: 'hd_acne', region: 'whole', score: 12, raw_score: 40, ui_score: 50 },
      { type: 'hd_skin_type', region: 'whole', skin_type: 'Oily', raw_score: 1, ui_score: 2 },
      { type: 'skin_age', score: 31 },
      { type: 'all', score: 70, raw_score: 1, ui_score: 2 },
    ]
    const { client } = make(() => taskReply('success', { results: { output } }))

    await expect(client.getSkinAnalysis('t')).resolves.toEqual({
      status: 'success',
      concerns: [{ concern: 'hd_acne', region: 'whole', rawScore: 40, uiScore: 50, maskUrls: [] }],
      skinTypes: [{ region: 'whole', skinType: 'Oily' }],
      skinAge: 31,
      all: 70,
    })
  })

  it('has no skin age and no overall item when the vendor sent none, and no skin types when it sent none', async () => {
    const { client } = make(() => taskReply('success', { results: { output: [OUTPUT[0]] } }))

    await expect(client.getSkinAnalysis('t')).resolves.toEqual({
      status: 'success',
      concerns: [{ concern: 'hd_age_spot', region: 'whole', rawScore: 57.33, uiScore: 68, maskUrls: [MASK_URL] }],
      skinTypes: [],
      skinAge: null,
      all: null,
    })
  })

  it.each([
    ['no results', {}],
    ['results that are not a list', { results: { output: 'nope' } }],
    ['no data at all', undefined],
  ])('reports a success with %s as unavailable, not as an empty analysis', async (_label, fields) => {
    const { client } = make(() => (fields === undefined ? json({ status: 200 }) : taskReply('success', fields)))

    expect(await caught(client.getSkinAnalysis('t'))).toBeInstanceOf(PerfectCorpUnavailableError)
  })

  it('reports a task_status it does not know as unavailable', async () => {
    const { client } = make(() => taskReply('weird' as never))

    expect(await caught(client.getSkinAnalysis('t'))).toBeInstanceOf(PerfectCorpUnavailableError)
  })
})

describe('RestPerfectCorpClient.getFitzpatrick', () => {
  it('reads the task from its own url', async () => {
    const { client, calls } = make(() => taskReply('running'))

    await client.getFitzpatrick('task-fitz-1')

    expect(calls[0]!.url).toBe(`${BASE_URL}/s2s/v2.0/task/fitzpatrick-scale-analyzer/task-fitz-1`)
    expect(calls[0]!.method).toBe('GET')
    expect(new Headers(calls[0]!.init.headers).get('Authorization')).toBe(`Bearer ${API_KEY}`)
  })

  it('says running while the task is running', async () => {
    const { client } = make(() => taskReply('running'))

    await expect(client.getFitzpatrick('t')).resolves.toEqual({ status: 'running' })
  })

  it.each(['I', 'II', 'III', 'IV', 'V', 'VI'])('returns type %s on success', async (scale) => {
    const { client } = make(() => taskReply('success', { results: { fitzpatrick_scale: scale } }))

    await expect(client.getFitzpatrick('t')).resolves.toEqual({ status: 'success', fitzpatrick: scale })
  })

  it.each([['VII'], ['iv'], [''], [4]])('reports a scale of %s as unavailable, never as a type', async (scale) => {
    const { client } = make(() => taskReply('success', { results: { fitzpatrick_scale: scale } }))

    expect(await caught(client.getFitzpatrick('t'))).toBeInstanceOf(PerfectCorpUnavailableError)
  })

  it('reports a success with no results as unavailable', async () => {
    const { client } = make(() => taskReply('success'))

    expect(await caught(client.getFitzpatrick('t'))).toBeInstanceOf(PerfectCorpUnavailableError)
  })
})

describe('RestPerfectCorpClient task errors', () => {
  const REJECTIONS = [
    ['error_lighting_dark', 'too-dark'],
    ['error_pose', 'turn-to-camera'],
    ['error_face_angle_yaw', 'turn-to-camera'],
    ['error_face_angle_pitch', 'turn-to-camera'],
    ['error_face_angle_roll', 'turn-to-camera'],
    ['error_src_face_too_small', 'move-closer'],
    ['error_src_face_out_of_bound', 'face-not-centred'],
    ['error_no_face', 'no-face'],
    ['error_below_min_image_size', 'image-size'],
    ['error_exceed_max_image_size', 'image-size'],
  ] as const

  const failedTask = (error: string | undefined) => taskReply('error', { error, error_message: PRIVATE_TEXT })

  it.each(REJECTIONS)('turns the skin analysis error %s into a rejected photo with the reason %s', async (code, reason) => {
    const { client } = make(() => failedTask(code))

    const error = await caught(client.getSkinAnalysis('t'))

    expect(error).toBeInstanceOf(PerfectCorpRejectedPhotoError)
    expect((error as PerfectCorpRejectedPhotoError).reason).toBe(reason)
  })

  it.each(REJECTIONS)('turns the Fitzpatrick error %s into a rejected photo with the reason %s', async (code, reason) => {
    const { client } = make(() => failedTask(code))

    const error = await caught(client.getFitzpatrick('t'))

    expect(error).toBeInstanceOf(PerfectCorpRejectedPhotoError)
    expect((error as PerfectCorpRejectedPhotoError).reason).toBe(reason)
  })

  it.each(['error_inference', 'unknown_internal_error', 'error_face_parsing', 'error_upload', 'exceed_nsfw_retry_limits', 'error_face_anglefoo', '', undefined])(
    'turns the other task error %s into unavailable: not a photo problem the user can fix',
    async (code) => {
      const { client } = make(() => failedTask(code))

      const skin = await caught(client.getSkinAnalysis('t'))
      const fitzpatrick = await caught(client.getFitzpatrick('t'))

      expect(skin).toBeInstanceOf(PerfectCorpUnavailableError)
      expect(skin).not.toBeInstanceOf(PerfectCorpRejectedPhotoError)
      expect(fitzpatrick).toBeInstanceOf(PerfectCorpUnavailableError)
    },
  )

  it('keeps the vendor\'s free-text message out of the error it throws', async () => {
    for (const code of ['error_no_face', 'error_inference']) {
      const { client } = make(() => failedTask(code))

      const error = (await caught(client.getSkinAnalysis('t'))) as Error

      expect(error.message).not.toContain(PRIVATE_TEXT)
    }
  })
})

describe('RestPerfectCorpClient.deleteTask', () => {
  it('posts the task id to the delete endpoint', async () => {
    const { client, calls } = make(() => json({ status: 200 }))

    await client.deleteTask('task-skin-1')

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${BASE_URL}/s2s/v2.0/task/delete`)
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.body).toEqual({ task_id: 'task-skin-1' })
    expect(new Headers(calls[0]!.init.headers).get('Authorization')).toBe(`Bearer ${API_KEY}`)
  })

  it('rejects when the vendor cannot delete it, so the caller can log it and retry', async () => {
    const { client } = make(() => json({ status: 503 }, 503))

    expect(await caught(client.deleteTask('t'))).toBeInstanceOf(PerfectCorpUnavailableError)
  })
})

describe('RestPerfectCorpClient.downloadMask', () => {
  const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9])
  const png = (bytes: Uint8Array = PNG) => new Response(bytes, { status: 200, headers: { 'Content-Type': 'image/png' } })

  it('returns the bytes of the mask', async () => {
    const { client, calls } = make(() => png())

    const bytes = await client.downloadMask(MASK_URL)

    expect(bytes).toEqual(PNG)
    expect(calls[0]!.url).toBe(MASK_URL)
    expect(calls[0]!.method).toBe('GET')
  })

  it('does not send the API key to the mask address, which belongs to somebody else', async () => {
    const { client, calls } = make(() => png())

    await client.downloadMask(MASK_URL)

    expect(new Headers(calls[0]!.init.headers).get('Authorization')).toBeNull()
  })

  it('returns a mask of exactly the size cap and refuses one a byte over it', async () => {
    const atCap = new Uint8Array(64).fill(7)
    const overCap = new Uint8Array(65).fill(7)

    expect(await make(() => png(atCap), { maxMaskBytes: 64 }).client.downloadMask(MASK_URL)).toEqual(atCap)

    const error = await caught(make(() => png(overCap), { maxMaskBytes: 64 }).client.downloadMask(MASK_URL))
    expect(error).toBeInstanceOf(PerfectCorpBadRequestError)
  })

  it('refuses a mask whose declared length is over the cap without reading it', async () => {
    const { client } = make(() => new Response(new Uint8Array(4), { status: 200, headers: { 'Content-Length': '1000000' } }), { maxMaskBytes: 64 })

    expect(await caught(client.downloadMask(MASK_URL))).toBeInstanceOf(PerfectCorpBadRequestError)
  })

  it('has a cap by default that lets a mask of a megabyte through', async () => {
    const mask = new Uint8Array(1024 * 1024).fill(3)
    const { client } = make(() => png(mask))

    expect((await client.downloadMask(MASK_URL)).byteLength).toBe(mask.byteLength)
  })

  it('reports an expired or refused link as a bad request, an outage as unavailable, and a failed connection as unavailable', async () => {
    expect(await caught(make(() => new Response('gone', { status: 403 })).client.downloadMask(MASK_URL))).toBeInstanceOf(PerfectCorpBadRequestError)
    expect(await caught(make(() => new Response('oops', { status: 503 })).client.downloadMask(MASK_URL))).toBeInstanceOf(PerfectCorpUnavailableError)
    const down = make(() => {
      throw new TypeError('network down')
    })
    expect(await caught(down.client.downloadMask(MASK_URL))).toBeInstanceOf(PerfectCorpUnavailableError)
  })

  it.each(['http://masks.test/a.png', 'ftp://masks.test/a.png', 'data:image/png;base64,iVBORw0KGgo=', 'file:///etc/passwd', '//masks.test/a.png', 'not a url', ''])(
    'refuses the mask address "%s", which is not https, as a bad request, and makes no request at all',
    async (address) => {
      const { client, calls } = make(() => new Response(new Uint8Array([1]), { status: 200 }))

      expect(await caught(client.downloadMask(address))).toBeInstanceOf(PerfectCorpBadRequestError)
      expect(calls).toEqual([])
    },
  )

  it('does not follow a redirect: a 3xx is an error, not a fetch of wherever it points', async () => {
    const { client, calls } = make(() => new Response(null, { status: 302, headers: { Location: 'http://169.254.169.254/latest' } }))

    await caught(client.downloadMask(MASK_URL))

    expect(calls).toHaveLength(1)
  })
})

describe('RestPerfectCorpClient error mapping', () => {
  const call = (client: RestPerfectCorpClient) => client.createSkinAnalysis({ fileId: 'f', actions: ['hd_acne'] })

  // 408 is the server giving up waiting for us: the same request may well work again, so it is not our bad request.
  it.each([500, 502, 503, 504, 429, 408])('reports HTTP %s as unavailable', async (status) => {
    const { client } = make(() => json({ status, error: PRIVATE_TEXT }, status))

    expect(await caught(call(client))).toBeInstanceOf(PerfectCorpUnavailableError)
  })

  it('reports a failed connection as unavailable', async () => {
    const { client } = make(() => {
      throw new TypeError('network down')
    })

    expect(await caught(call(client))).toBeInstanceOf(PerfectCorpUnavailableError)
  })

  it('reports no answer within the timeout as unavailable', async () => {
    hangs()
    const client = new RestPerfectCorpClient({ ...config, timeoutMs: 10 })

    expect(await caught(call(client))).toBeInstanceOf(PerfectCorpUnavailableError)
  })

  it('reports a 400 whose error_code is CreditInsufficiency as a credit error, not a bad request', async () => {
    const { client } = make(() => json({ status: 400, error: PRIVATE_TEXT, error_code: 'CreditInsufficiency' }, 400))

    const error = await caught(call(client))

    expect(error).toBeInstanceOf(PerfectCorpCreditError)
    expect(error).not.toBeInstanceOf(PerfectCorpBadRequestError)
    expect(error).not.toBeInstanceOf(PerfectCorpUnavailableError)
  })

  it.each([
    [400, { status: 400, error: PRIVATE_TEXT, error_code: 'InvalidParameter' }],
    [400, { status: 400, error: PRIVATE_TEXT }],
    [400, 'not json'],
    [401, { status: 401, error_code: 'Unauthorized' }],
    [403, { status: 403 }],
    [404, { status: 404 }],
    [409, { status: 409 }],
    [422, { status: 422 }],
    // The credit code only means something on a 400.
    [403, { status: 403, error_code: 'CreditInsufficiency' }],
  ])('reports HTTP %s with body %j as a bad request', async (status, body) => {
    const { client } = make(() => json(body, status))

    const error = await caught(call(client))

    expect(error).toBeInstanceOf(PerfectCorpBadRequestError)
    expect(error).not.toBeInstanceOf(PerfectCorpCreditError)
  })

  it('treats every kind of call the same way: a credit error from a Fitzpatrick create, an outage from a status read, a bad request from a delete', async () => {
    expect(await caught(make(() => json({ error_code: 'CreditInsufficiency' }, 400)).client.createFitzpatrick({ fileId: 'f' }))).toBeInstanceOf(PerfectCorpCreditError)
    expect(await caught(make(() => json({}, 502)).client.getFitzpatrick('t'))).toBeInstanceOf(PerfectCorpUnavailableError)
    expect(await caught(make(() => json({}, 404)).client.deleteTask('t'))).toBeInstanceOf(PerfectCorpBadRequestError)
  })

  it('puts neither the vendor\'s free text, the API key, nor an address with a signature in the error message', async () => {
    // One scenario at a time: each builds its own stubbed fetch.
    const scenarios: (() => Promise<unknown>)[] = [
      () => call(make(() => json({ status: 500, error: PRIVATE_TEXT }, 500)).client),
      () => call(make(() => json({ status: 400, error: PRIVATE_TEXT, error_code: 'CreditInsufficiency' }, 400)).client),
      () => call(make(() => json({ status: 400, error: PRIVATE_TEXT, error_code: 'InvalidParameter' }, 400)).client),
      () => make(() => json({ status: 403, error: PRIVATE_TEXT }, 403)).client.downloadMask(MASK_URL),
      () =>
        make((c) => (c.url === `${BASE_URL}/s2s/v2.0/file` ? json(FILE_REPLY) : new Response(PRIVATE_TEXT, { status: 403 }))).client.uploadFile(BYTES, {
          contentType: 'image/jpeg',
          fileName: 'front.jpg',
        }),
    ]

    for (const scenario of scenarios) {
      const message = ((await caught(scenario())) as Error).message
      expect(message).not.toContain(PRIVATE_TEXT)
      expect(message).not.toContain(API_KEY)
      expect(message).not.toContain('private-signature-482913')
      expect(message).not.toContain('private-mask-482913')
    }
  })

  it('writes nothing to the console that carries a secret, a photo address, vendor text or a body, whatever goes wrong', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}))
    const scenarios: (() => Promise<unknown>)[] = [
      () => call(make(() => json({ status: 500, error: PRIVATE_TEXT }, 500)).client),
      () => call(make(() => json({ error: PRIVATE_TEXT, error_code: 'CreditInsufficiency' }, 400)).client),
      () => make(() => taskReply('error', { error: 'error_no_face', error_message: PRIVATE_TEXT })).client.getSkinAnalysis('t'),
      () => make(() => taskReply('error', { error: 'error_inference', error_message: PRIVATE_TEXT })).client.getFitzpatrick('t'),
      () => make(() => new Response(PRIVATE_TEXT, { status: 403 })).client.downloadMask(MASK_URL),
    ]
    for (const scenario of scenarios) await caught(scenario())

    const logged = spies.flatMap((spy) => spy.mock.calls.flat()).map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join('\n')
    for (const secret of [API_KEY, config.webhookSecret, PRIVATE_TEXT, 'private-mask-482913', 'private-signature-482913']) {
      expect(logged).not.toContain(secret)
    }
  })
})

// The Standard Webhooks scheme (standardwebhooks.com): headers webhook-id, webhook-timestamp (seconds) and webhook-signature (space-separated
// "v1,<base64>" entries). The signature is HMAC-SHA256 over `${id}.${timestamp}.${body}`, keyed with the secret after "whsec_" is
// stripped and the rest is base64-decoded. The clock is injected.
describe('RestPerfectCorpClient.verifyWebhook', () => {
  const KEY_BYTES = Uint8Array.from({ length: 24 }, (_, i) => i * 7 + 3)
  const base64 = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  const SECRET_BASE64 = base64(KEY_BYTES)
  const WEBHOOK_ID = 'msg_2zq0xYk4WpP3eK8vNn1aBcDeFgH'
  const PAYLOAD = { created_at: 1761112848, data: { task_id: 'task-skin-1', task_status: 'success' } }
  const BODY = JSON.stringify(PAYLOAD)

  /** The signature the way the Standard Webhooks spec computes it, worked here with WebCrypto and not with the adapter. */
  const sign = async (id: string, timestamp: string | number, body: string, keyBytes: Uint8Array = KEY_BYTES) => {
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    return base64(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)))
  }

  const client = (secret = `whsec_${SECRET_BASE64}`) => make(() => json({}), { webhookSecret: secret }).client

  /** Headers for a delivery made `ageSeconds` ago, signed with `keyBytes`. */
  const delivery = async (over: { ageSeconds?: number; timestamp?: string; body?: string; id?: string; keyBytes?: Uint8Array } = {}) => {
    const { ageSeconds = 0, body = BODY, id = WEBHOOK_ID, keyBytes = KEY_BYTES } = over
    const timestamp = over.timestamp ?? String(NOW_SECONDS - ageSeconds)
    const signature = await sign(id, timestamp, body, keyBytes)
    return { body, headers: new Headers({ 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` }), timestamp, signature }
  }

  it('matches the published Standard Webhooks test vector, so the scheme is the standard one and not only self-consistent', async () => {
    const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw'
    const id = 'msg_p5jXN8AQM9LWM0D4loKWxJek'
    const timestamp = '1614265330'
    const published = 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE='
    const keyBytes = Uint8Array.from(atob(secret.slice('whsec_'.length)), (c) => c.charCodeAt(0))
    const verifier = make(() => json({}), { webhookSecret: secret, now: () => new Date(1614265330 * 1000) }).client
    const payload = '{"created_at": 1614265330, "data": {"task_id": "t-9", "task_status": "error"}}'

    // The test's own signer, run over the published inputs, gives the published signature: it is the standard scheme.
    expect(`v1,${await sign(id, timestamp, '{"test": 2432232314}', keyBytes)}`).toBe(published)
    // And the adapter accepts a payload signed the same way, under the same secret.
    const headers = new Headers({ 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${await sign(id, timestamp, payload, keyBytes)}` })
    expect(await verifier.verifyWebhook(payload, headers)).toEqual({ webhookId: id, taskId: 't-9', taskStatus: 'error' })
  })

  it('accepts a correctly signed delivery and returns the webhook id, task id and status', async () => {
    const { body, headers } = await delivery()

    expect(await client().verifyWebhook(body, headers)).toEqual({ webhookId: WEBHOOK_ID, taskId: 'task-skin-1', taskStatus: 'success' })
  })

  it('returns an error status as it is', async () => {
    const errored = JSON.stringify({ created_at: 1, data: { task_id: 'task-9', task_status: 'error' } })
    const { body, headers } = await delivery({ body: errored })

    expect(await client().verifyWebhook(body, headers)).toEqual({ webhookId: WEBHOOK_ID, taskId: 'task-9', taskStatus: 'error' })
  })

  it('accepts a secret with the whsec_ prefix and the same secret without it', async () => {
    const { body, headers } = await delivery()

    expect(await client(`whsec_${SECRET_BASE64}`).verifyWebhook(body, headers)).not.toBeNull()
    expect(await client(SECRET_BASE64).verifyWebhook(body, headers)).not.toBeNull()
  })

  it('rejects a signature made with another secret, however it is configured', async () => {
    const other = Uint8Array.from({ length: 24 }, (_, i) => i * 5 + 1)
    const { body, headers } = await delivery({ keyBytes: other })

    expect(await client(`whsec_${SECRET_BASE64}`).verifyWebhook(body, headers)).toBeNull()
    expect(await client(SECRET_BASE64).verifyWebhook(body, headers)).toBeNull()
  })

  it('does not use the base64 text of the secret as the key: the key is the decoded bytes', async () => {
    const textKey = new TextEncoder().encode(SECRET_BASE64)
    const { body, headers } = await delivery({ keyBytes: textKey })

    expect(await client().verifyWebhook(body, headers)).toBeNull()
  })

  it('rejects a body that was changed after it was signed, by a single character', async () => {
    const { body, headers } = await delivery()

    expect(await client().verifyWebhook(body.replace('task-skin-1', 'task-skin-2'), headers)).toBeNull()
    expect(await client().verifyWebhook(body + ' ', headers)).toBeNull()
  })

  it('rejects a delivery whose webhook id or timestamp was changed after signing, even inside the time window', async () => {
    const { body, headers, signature } = await delivery()
    const otherId = new Headers({ 'webhook-id': WEBHOOK_ID + 'x', 'webhook-timestamp': headers.get('webhook-timestamp')!, 'webhook-signature': `v1,${signature}` })
    const otherTime = new Headers({ 'webhook-id': WEBHOOK_ID, 'webhook-timestamp': String(NOW_SECONDS - 1), 'webhook-signature': `v1,${signature}` })

    expect(await client().verifyWebhook(body, otherId)).toBeNull()
    expect(await client().verifyWebhook(body, otherTime)).toBeNull()
  })

  it('accepts a timestamp exactly 5 minutes old and refuses one a second older', async () => {
    const edge = await delivery({ ageSeconds: TOLERANCE_SECONDS })
    const past = await delivery({ ageSeconds: TOLERANCE_SECONDS + 1 })

    expect(await client().verifyWebhook(edge.body, edge.headers)).not.toBeNull()
    expect(await client().verifyWebhook(past.body, past.headers)).toBeNull()
  })

  it('accepts a timestamp exactly 5 minutes in the future and refuses one a second further', async () => {
    const edge = await delivery({ ageSeconds: -TOLERANCE_SECONDS })
    const past = await delivery({ ageSeconds: -(TOLERANCE_SECONDS + 1) })

    expect(await client().verifyWebhook(edge.body, edge.headers)).not.toBeNull()
    expect(await client().verifyWebhook(past.body, past.headers)).toBeNull()
  })

  it('judges the age by the injected clock, not the real one', async () => {
    const { body, headers } = await delivery()
    const later = make(() => json({}), { now: () => new Date(NOW.getTime() + (TOLERANCE_SECONDS + 1) * 1000) }).client

    expect(await later.verifyWebhook(body, headers)).toBeNull()
  })

  it('accepts a delivery when any one of several space-separated signatures matches, in any position', async () => {
    const { body, headers, timestamp, signature } = await delivery()
    const wrong = `v1,${base64(new Uint8Array(32).fill(9))}`
    const at = (value: string) => new Headers({ 'webhook-id': WEBHOOK_ID, 'webhook-timestamp': timestamp, 'webhook-signature': value })

    expect(headers.get('webhook-signature')).toBe(`v1,${signature}`)
    expect(await client().verifyWebhook(body, at(`${wrong} v1,${signature}`))).not.toBeNull()
    expect(await client().verifyWebhook(body, at(`v1,${signature} ${wrong}`))).not.toBeNull()
    expect(await client().verifyWebhook(body, at(`${wrong} v1,${signature} ${wrong}`))).not.toBeNull()
    expect(await client().verifyWebhook(body, at(`${wrong} ${wrong}`))).toBeNull()
  })

  it('ignores a signature of a version it does not know', async () => {
    const { body, timestamp, signature } = await delivery()
    const at = (value: string) => new Headers({ 'webhook-id': WEBHOOK_ID, 'webhook-timestamp': timestamp, 'webhook-signature': value })

    expect(await client().verifyWebhook(body, at(`v2,${signature}`))).toBeNull()
    expect(await client().verifyWebhook(body, at(`v2,${signature} v1,${signature}`))).not.toBeNull()
  })

  it.each(['webhook-id', 'webhook-timestamp', 'webhook-signature'])('rejects a delivery with no %s header', async (missing) => {
    const { body, headers } = await delivery()
    headers.delete(missing)

    expect(await client().verifyWebhook(body, headers)).toBeNull()
  })

  // Signed over the empty value, so only the emptiness itself can be what is refused.
  it('rejects a delivery whose webhook id is empty, even when it is signed over the empty id', async () => {
    const { body, headers } = await delivery({ id: '' })

    expect(await client().verifyWebhook(body, headers)).toBeNull()
  })

  it('rejects a delivery whose timestamp is empty, even when it is signed over the empty timestamp', async () => {
    const { body, headers } = await delivery({ timestamp: '' })

    expect(await client().verifyWebhook(body, headers)).toBeNull()
  })

  it('rejects a delivery whose signature header is empty', async () => {
    const { body, headers } = await delivery()
    headers.set('webhook-signature', '')

    expect(await client().verifyWebhook(body, headers)).toBeNull()
  })

  it.each(['', 'v1', 'v1,', 'v1,!!!not-base64!!!', 'garbage', ',', 'v1,AAAA,BBBB'])('rejects, without throwing, a signature header of "%s"', async (value) => {
    const { body, headers } = await delivery()
    headers.set('webhook-signature', value)

    await expect(client().verifyWebhook(body, headers)).resolves.toBeNull()
  })

  // Signed over the odd timestamp too, so only the timestamp itself can be what is refused.
  it.each(['abc', '12.5x', 'NaN', '-', '0x10'])('rejects, without throwing, a timestamp of "%s", even when it is signed over that timestamp', async (timestamp) => {
    const { body, headers } = await delivery({ timestamp })

    await expect(client().verifyWebhook(body, headers)).resolves.toBeNull()
  })

  it.each([
    ['is not JSON', 'not json at all'],
    ['has no data', JSON.stringify({ created_at: 1 })],
    ['has no task id', JSON.stringify({ created_at: 1, data: { task_status: 'success' } })],
    ['has a task id that is not text', JSON.stringify({ created_at: 1, data: { task_id: 5, task_status: 'success' } })],
    ['has a status other than success or error', JSON.stringify({ created_at: 1, data: { task_id: 't', task_status: 'running' } })],
    ['has no status', JSON.stringify({ created_at: 1, data: { task_id: 't' } })],
  ])('returns null for a correctly signed payload that %s', async (_label, body) => {
    const signed = await delivery({ body })

    await expect(client().verifyWebhook(signed.body, signed.headers)).resolves.toBeNull()
  })
})
