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
//                          A concern item with no string region (hd_age_spot and others have no subcategories) is read as region 'whole'.
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
      skipped: [],
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
      skipped: [],
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
      skipped: [],
    })
  })

  // Perfect Corp's reference lists hd_acne and hd_texture with a [whole] subcategory, and hd_age_spot (like hd_redness, hd_radiance...) with none,
  // so its item has no region. Staging scan 36f451ae lost its age-spot result to exactly this.
  const MASK_ACNE = 'https://masks.test/acne.png?sig=private-mask-482913'
  const MASK_TEXTURE = 'https://masks.test/texture.png?sig=private-mask-482913'
  const REGIONLESS_OUTPUT = [
    { type: 'hd_acne', region: 'whole', raw_score: 80, ui_score: 85, mask_urls: [MASK_ACNE] },
    { type: 'hd_texture', region: 'whole', raw_score: 55, ui_score: 63, mask_urls: [MASK_TEXTURE] },
    { type: 'hd_age_spot', raw_score: 57.33, ui_score: 68, mask_urls: [MASK_URL] },
    { type: 'hd_skin_type', region: 'whole', skin_type: 'Oily' },
    { type: 'skin_age', score: 29.4 },
  ]

  it('keeps an hd item that has no region as a whole-face concern, with its scores and mask urls, next to the items that do have one', async () => {
    const { client } = make(() => taskReply('success', { results: { output: REGIONLESS_OUTPUT } }))

    await expect(client.getSkinAnalysis('t')).resolves.toEqual({
      status: 'success',
      concerns: [
        { concern: 'hd_acne', region: 'whole', rawScore: 80, uiScore: 85, maskUrls: [MASK_ACNE] },
        { concern: 'hd_texture', region: 'whole', rawScore: 55, uiScore: 63, maskUrls: [MASK_TEXTURE] },
        { concern: 'hd_age_spot', region: 'whole', rawScore: 57.33, uiScore: 68, maskUrls: [MASK_URL] },
      ],
      skinTypes: [{ region: 'whole', skinType: 'Oily' }],
      skinAge: 29.4,
      all: null,
      skipped: [],
    })
  })

  it('keeps a region-less item that has no mask urls, with an empty list', async () => {
    const output = [{ type: 'hd_redness', raw_score: 71, ui_score: 75 }]
    const { client } = make(() => taskReply('success', { results: { output } }))

    const result = await client.getSkinAnalysis('t')

    expect(result).toMatchObject({ concerns: [{ concern: 'hd_redness', region: 'whole', rawScore: 71, uiScore: 75, maskUrls: [] }], skipped: [] })
  })

  it.each([
    ['null', null],
    ['a number', 7],
    ['an object', { name: 'left_cheek' }],
    ['a list', ['left_cheek']],
    ['a boolean', true],
  ])('reads a region that is %s, not text, as the whole face', async (_label, region) => {
    const output = [{ type: 'hd_age_spot', region, raw_score: 57.33, ui_score: 68, mask_urls: [MASK_URL] }]
    const { client } = make(() => taskReply('success', { results: { output } }))

    const result = await client.getSkinAnalysis('t')

    expect(result).toMatchObject({
      concerns: [{ concern: 'hd_age_spot', region: 'whole', rawScore: 57.33, uiScore: 68, maskUrls: [MASK_URL] }],
      skipped: [],
    })
  })

  it('keeps the region it was given on an item that has one, and does not turn it into the whole face', async () => {
    const output = [{ type: 'hd_redness', region: 'forehead', raw_score: 33, ui_score: 41 }]
    const { client } = make(() => taskReply('success', { results: { output } }))

    const result = await client.getSkinAnalysis('t')

    expect(result).toMatchObject({ concerns: [{ concern: 'hd_redness', region: 'forehead', rawScore: 33, uiScore: 41, maskUrls: [] }] })
  })

  it.each([
    ['no raw_score', { type: 'hd_acne', region: 'whole', ui_score: 85 }],
    ['no ui_score', { type: 'hd_acne', region: 'whole', raw_score: 80 }],
    ['neither score', { type: 'hd_acne', region: 'whole' }],
    ['a raw_score that is text', { type: 'hd_acne', region: 'whole', raw_score: '80', ui_score: 85 }],
    ['a ui_score that is text', { type: 'hd_acne', region: 'whole', raw_score: 80, ui_score: '85' }],
    ['no region and no scores', { type: 'hd_acne', mask_urls: [MASK_ACNE] }],
    ['no region and only one score', { type: 'hd_acne', raw_score: 80, mask_urls: [MASK_ACNE] }],
  ])('leaves an hd item with %s out of the concerns and reports it as skipped, by type and problem only', async (_label, item) => {
    const output = [{ type: 'hd_texture', region: 'whole', raw_score: 55, ui_score: 63 }, item]
    const { client } = make(() => taskReply('success', { results: { output } }))

    const result = await client.getSkinAnalysis('t')

    expect(result).toMatchObject({
      status: 'success',
      concerns: [{ concern: 'hd_texture', region: 'whole', rawScore: 55, uiScore: 63, maskUrls: [] }],
      skipped: [{ type: 'hd_acne', problem: 'no-scores' }],
    })
    expect((result as { skipped: unknown[] }).skipped).toHaveLength(1)
    expect(JSON.stringify((result as { skipped: unknown[] }).skipped)).not.toContain('masks.test')
  })

  it('lists every skipped item, in the order the vendor sent them', async () => {
    const output = [{ type: 'hd_redness', raw_score: 71 }, { type: 'hd_pore', region: 'whole', ui_score: 4 }, { type: 'hd_acne', region: 'whole', raw_score: 80, ui_score: 85 }]
    const { client } = make(() => taskReply('success', { results: { output } }))

    const result = await client.getSkinAnalysis('t')

    expect(result).toMatchObject({
      concerns: [{ concern: 'hd_acne' }],
      skipped: [
        { type: 'hd_redness', problem: 'no-scores' },
        { type: 'hd_pore', problem: 'no-scores' },
      ],
    })
  })

  it('names a skipped type only when it looks like an hd code: lowercase letters and underscores, 1 to 40 after hd_', async () => {
    const longest = 'hd_' + 'a'.repeat(40)
    const tooLong = 'hd_' + 'a'.repeat(41)
    const output = [
      { type: 'hd_a' },
      { type: longest },
      { type: tooLong },
      { type: 'hd_' },
      { type: 'hd_Acne' },
      { type: 'hd_acne spot' },
      { type: 'hd_acne\nspot' },
      { type: 'hd_acne-1' },
      { type: 'hd_<script>' },
    ]
    const { client } = make(() => taskReply('success', { results: { output } }))

    const result = await client.getSkinAnalysis('t')

    expect(result).toMatchObject({
      concerns: [],
      skipped: [
        { type: 'hd_a', problem: 'no-scores' },
        { type: longest, problem: 'no-scores' },
      ],
    })
    expect((result as { skipped: unknown[] }).skipped).toHaveLength(2)
  })

  it('does not report as skipped an item that is not an hd concern: the skin type, skin age and overall items, a type that is not text, and a type that does not start hd_', async () => {
    const output = [
      { type: 'hd_skin_type', skin_type: 'Oily' },
      { type: 'skin_age' },
      { type: 'all' },
      { type: 'mystery', raw_score: 1 },
      { type: 7 },
      {},
    ]
    const { client } = make(() => taskReply('success', { results: { output } }))

    await expect(client.getSkinAnalysis('t')).resolves.toEqual({
      status: 'success',
      concerns: [],
      skinTypes: [],
      skinAge: null,
      all: null,
      skipped: [],
    })
  })

  it('still needs a region on a skin type item: one without is not read as the whole face', async () => {
    const output = [{ type: 'hd_skin_type', skin_type: 'Oily' }]
    const { client } = make(() => taskReply('success', { results: { output } }))

    await expect(client.getSkinAnalysis('t')).resolves.toMatchObject({ skinTypes: [], concerns: [], skipped: [] })
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
// stripped and the rest is base64-decoded. The clock is injected. A delivery that is refused says why, with the reason and a few
// counts and key names, and never the secret, a signature or anything the body says.
describe('RestPerfectCorpClient.checkWebhook', () => {
  const KEY_BYTES = Uint8Array.from({ length: 24 }, (_, i) => i * 7 + 3)
  const OTHER_KEY_BYTES = Uint8Array.from({ length: 24 }, (_, i) => i * 5 + 1)
  const base64 = (bytes: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  const SECRET_BASE64 = base64(KEY_BYTES)
  const WEBHOOK_ID = 'msg_2zq0xYk4WpP3eK8vNn1aBcDeFgH'
  const TASK_ID = 'task-skin-1'
  const PAYLOAD = { created_at: 1761112848, data: { task_id: TASK_ID, task_status: 'success' } }
  const BODY = JSON.stringify(PAYLOAD)
  const ALL_HEADERS = ['webhook-id', 'webhook-timestamp', 'webhook-signature']

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

  const withSignature = (timestamp: string, value: string) => new Headers({ 'webhook-id': WEBHOOK_ID, 'webhook-timestamp': timestamp, 'webhook-signature': value })

  /** The reason a delivery was refused. Fails the test if it was accepted. */
  const rejectionOf = async (body: string, headers: Headers, webhookClient = client()) => {
    const result = await webhookClient.checkWebhook(body, headers)
    if (result.ok) throw new Error('expected the delivery to be rejected, but it was accepted')
    return result.rejection
  }

  /** A correctly signed, fresh delivery of `body`. */
  const shapeOf = async (body: string) => {
    const signed = await delivery({ body })
    return rejectionOf(signed.body, signed.headers)
  }

  /** What a wrongly signed BODY delivery says: nothing matched even with the other ways to read the secret and the id, and its keys are listed. */
  const MISMATCH = {
    reason: 'signature-mismatch',
    versions: ['v1'],
    signatureCount: 1,
    undecodedSecretWouldMatch: false,
    idWithoutSuffixWouldMatch: false,
    undecodedAndIdWithoutSuffixWouldMatch: false,
    topLevelKeys: ['created_at', 'data'],
    dataKeys: ['task_id', 'task_status'],
  }

  const ACCEPTED = { ok: true, delivery: { webhookId: WEBHOOK_ID, taskId: TASK_ID, taskStatus: 'success' } }

  describe('a delivery that is accepted', () => {
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
      expect(await verifier.checkWebhook(payload, headers)).toEqual({ ok: true, delivery: { webhookId: id, taskId: 't-9', taskStatus: 'error' } })
    })

    it('accepts a correctly signed delivery and returns the webhook id, task id and status', async () => {
      const { body, headers } = await delivery()

      expect(await client().checkWebhook(body, headers)).toEqual(ACCEPTED)
    })

    it('returns an error status as it is', async () => {
      const errored = JSON.stringify({ created_at: 1, data: { task_id: 'task-9', task_status: 'error' } })
      const { body, headers } = await delivery({ body: errored })

      expect(await client().checkWebhook(body, headers)).toEqual({ ok: true, delivery: { webhookId: WEBHOOK_ID, taskId: 'task-9', taskStatus: 'error' } })
    })

    // What Perfect Corp really sends (seen in a staging delivery): data.taskId and data.taskStatus, in camelCase, 153 bytes.
    it.each(['success', 'error'] as const)('accepts the delivery as Perfect Corp really sends it, in camelCase, with a task status of %s', async (taskStatus) => {
      const real = `{"created_at":1761112848,"data":{"taskId":"${TASK_ID}","taskStatus":"${taskStatus}"}}`
      const { body, headers } = await delivery({ body: real })

      expect(await client().checkWebhook(body, headers)).toEqual({ ok: true, delivery: { webhookId: WEBHOOK_ID, taskId: TASK_ID, taskStatus } })
    })

    it('still accepts the snake_case body the documentation describes, task_id and task_status', async () => {
      const documented = '{"created_at":1761112848,"data":{"task_id":"task-skin-1","task_status":"error"}}'
      const { body, headers } = await delivery({ body: documented })

      expect(await client().checkWebhook(body, headers)).toEqual({ ok: true, delivery: { webhookId: WEBHOOK_ID, taskId: 'task-skin-1', taskStatus: 'error' } })
    })

    describe('when a body carries both spellings', () => {
      const accept = async (data: Record<string, unknown>) => {
        const { body, headers } = await delivery({ body: JSON.stringify({ created_at: 1, data }) })
        return client().checkWebhook(body, headers)
      }

      it('reads the snake_case task id and status, each on its own', async () => {
        expect(await accept({ task_id: 'a', taskId: 'b', task_status: 'error', taskStatus: 'success' })).toEqual({ ok: true, delivery: { webhookId: WEBHOOK_ID, taskId: 'a', taskStatus: 'error' } })
        expect(await accept({ taskId: 'b', task_id: 'a', taskStatus: 'error', task_status: 'success' })).toEqual({ ok: true, delivery: { webhookId: WEBHOOK_ID, taskId: 'a', taskStatus: 'success' } })
      })

      it('reads the camelCase task id when the snake_case one is empty or not text, and the camelCase status when the snake_case one is absent', async () => {
        expect(await accept({ task_id: '', taskId: 'b', taskStatus: 'success' })).toEqual({ ok: true, delivery: { webhookId: WEBHOOK_ID, taskId: 'b', taskStatus: 'success' } })
        expect(await accept({ task_id: 5, taskId: 'b', taskStatus: 'error' })).toEqual({ ok: true, delivery: { webhookId: WEBHOOK_ID, taskId: 'b', taskStatus: 'error' } })
        expect(await accept({ task_id: 'a', taskStatus: 'error' })).toEqual({ ok: true, delivery: { webhookId: WEBHOOK_ID, taskId: 'a', taskStatus: 'error' } })
      })

      it('does not fall back to the camelCase status when the snake_case one is there but wrong', async () => {
        expect(await accept({ task_id: 'a', task_status: 'running', taskStatus: 'success' })).toMatchObject({ ok: false, rejection: { problem: 'bad-task-status', taskStatusValue: 'running' } })
        expect(await accept({ task_id: 'a', task_status: '', taskStatus: 'success' })).toMatchObject({ ok: false, rejection: { problem: 'bad-task-status' } })
      })
    })

    it('accepts a secret with the whsec_ prefix and the same secret without it', async () => {
      const { body, headers } = await delivery()

      expect(await client(`whsec_${SECRET_BASE64}`).checkWebhook(body, headers)).toEqual(ACCEPTED)
      expect(await client(SECRET_BASE64).checkWebhook(body, headers)).toEqual(ACCEPTED)
    })

    it('accepts a timestamp exactly 5 minutes old and refuses one a second older', async () => {
      const edge = await delivery({ ageSeconds: TOLERANCE_SECONDS })
      const past = await delivery({ ageSeconds: TOLERANCE_SECONDS + 1 })

      expect(await client().checkWebhook(edge.body, edge.headers)).toEqual(ACCEPTED)
      expect(await rejectionOf(past.body, past.headers)).toMatchObject({ reason: 'stale-timestamp' })
    })

    it('accepts a timestamp exactly 5 minutes in the future and refuses one a second further', async () => {
      const edge = await delivery({ ageSeconds: -TOLERANCE_SECONDS })
      const past = await delivery({ ageSeconds: -(TOLERANCE_SECONDS + 1) })

      expect(await client().checkWebhook(edge.body, edge.headers)).toEqual(ACCEPTED)
      expect(await rejectionOf(past.body, past.headers)).toMatchObject({ reason: 'stale-timestamp' })
    })

    it('accepts a delivery when any one of several space-separated signatures matches, in any position', async () => {
      const { body, timestamp, signature } = await delivery()
      const wrong = `v1,${base64(new Uint8Array(32).fill(9))}`

      expect(await client().checkWebhook(body, withSignature(timestamp, `${wrong} v1,${signature}`))).toEqual(ACCEPTED)
      expect(await client().checkWebhook(body, withSignature(timestamp, `v1,${signature} ${wrong}`))).toEqual(ACCEPTED)
      expect(await client().checkWebhook(body, withSignature(timestamp, `${wrong} v1,${signature} ${wrong}`))).toEqual(ACCEPTED)
    })

    it('ignores a signature of a version it does not know, and accepts when a v1 one sits beside it', async () => {
      const { body, timestamp, signature } = await delivery()

      expect(await client().checkWebhook(body, withSignature(timestamp, `v2,${signature} v1,${signature}`))).toEqual(ACCEPTED)
    })
  })

  describe('rejection: missing-headers', () => {
    it.each(ALL_HEADERS)('names %s, and only it, when that header is absent', async (missing) => {
      const { body, headers } = await delivery()
      headers.delete(missing)

      expect(await rejectionOf(body, headers)).toEqual({ reason: 'missing-headers', missing: [missing] })
    })

    it('names all three, in the order id, timestamp, signature, when there are no headers at all', async () => {
      expect(await rejectionOf(BODY, new Headers())).toEqual({ reason: 'missing-headers', missing: ['webhook-id', 'webhook-timestamp', 'webhook-signature'] })
    })

    it('names two of them in that same order when two are absent', async () => {
      const { body, headers } = await delivery()
      headers.delete('webhook-signature')
      headers.delete('webhook-id')

      expect(await rejectionOf(body, headers)).toEqual({ reason: 'missing-headers', missing: ['webhook-id', 'webhook-signature'] })
    })

    // Signed over the empty value, so only the emptiness itself can be what is refused.
    it('counts an empty webhook id as missing, even when it is signed over the empty id', async () => {
      const { body, headers } = await delivery({ id: '' })

      expect(await rejectionOf(body, headers)).toEqual({ reason: 'missing-headers', missing: ['webhook-id'] })
    })

    it('counts an empty timestamp as missing, even when it is signed over the empty timestamp', async () => {
      const { body, headers } = await delivery({ timestamp: '' })

      expect(await rejectionOf(body, headers)).toEqual({ reason: 'missing-headers', missing: ['webhook-timestamp'] })
    })

    it('counts an empty signature header as missing', async () => {
      const { body, headers } = await delivery()
      headers.set('webhook-signature', '')

      expect(await rejectionOf(body, headers)).toEqual({ reason: 'missing-headers', missing: ['webhook-signature'] })
    })

    it('is the first thing checked: a missing header is reported even when the timestamp that is there is not digits', async () => {
      const { body, headers } = await delivery({ timestamp: 'abc' })
      headers.delete('webhook-id')

      expect(await rejectionOf(body, headers)).toEqual({ reason: 'missing-headers', missing: ['webhook-id'] })
    })
  })

  describe('rejection: bad-timestamp', () => {
    // Signed over the odd timestamp too, so only the timestamp itself can be what is refused.
    it.each(['abc', '12.5x', 'NaN', '-', '0x10', '-5', '+5', '1e3'])('refuses a timestamp of "%s", even when it is signed over that timestamp', async (timestamp) => {
      const { body, headers } = await delivery({ timestamp })

      await expect(rejectionOf(body, headers)).resolves.toEqual({ reason: 'bad-timestamp' })
    })

    it('is checked before the age: digits only is the rule that comes first', async () => {
      const { body, headers } = await delivery({ timestamp: '12.5' })

      expect(await rejectionOf(body, headers)).toEqual({ reason: 'bad-timestamp' })
    })
  })

  describe('rejection: stale-timestamp', () => {
    it('says how far in the past a delivery is, one second beyond the window, with no millisecond reading and a signature that was good', async () => {
      const { body, headers } = await delivery({ ageSeconds: TOLERANCE_SECONDS + 1 })

      expect(await rejectionOf(body, headers)).toEqual({ reason: 'stale-timestamp', skewSeconds: 301, skewIfMilliseconds: null, signatureValid: true })
    })

    it('says how far in the future a delivery is, as a negative skew', async () => {
      const { body, headers } = await delivery({ ageSeconds: -(TOLERANCE_SECONDS + 1) })

      expect(await rejectionOf(body, headers)).toEqual({ reason: 'stale-timestamp', skewSeconds: -301, skewIfMilliseconds: null, signatureValid: true })
    })

    it('reports a long-past delivery in seconds', async () => {
      const { body, headers } = await delivery({ ageSeconds: 86_400 })

      expect(await rejectionOf(body, headers)).toEqual({ reason: 'stale-timestamp', skewSeconds: 86_400, skewIfMilliseconds: null, signatureValid: true })
    })

    it('says the signature was not good when it was made with another secret, so a bad clock is told apart from a bad secret', async () => {
      const { body, headers } = await delivery({ ageSeconds: 1000, keyBytes: OTHER_KEY_BYTES })

      expect(await rejectionOf(body, headers)).toEqual({ reason: 'stale-timestamp', skewSeconds: 1000, skewIfMilliseconds: null, signatureValid: false })
    })

    it('says the signature was not good when the body was changed after signing', async () => {
      const { body, headers } = await delivery({ ageSeconds: 1000 })

      expect(await rejectionOf(body + ' ', headers)).toMatchObject({ reason: 'stale-timestamp', signatureValid: false })
    })

    it('judges the age by the injected clock, not the real one', async () => {
      const { body, headers } = await delivery()
      const later = make(() => json({}), { webhookSecret: `whsec_${SECRET_BASE64}`, now: () => new Date(NOW.getTime() + (TOLERANCE_SECONDS + 1) * 1000) }).client

      expect(await rejectionOf(body, headers, later)).toEqual({ reason: 'stale-timestamp', skewSeconds: 301, skewIfMilliseconds: null, signatureValid: true })
    })

    describe('a timestamp in milliseconds', () => {
      it('shows the skew it would have in seconds near zero, and a signature that is good when signed over that very timestamp', async () => {
        const timestamp = String(NOW.getTime() - 2000)
        const { body, headers } = await delivery({ timestamp })

        expect(await rejectionOf(body, headers)).toEqual({
          reason: 'stale-timestamp',
          // Read as seconds the timestamp is about 1000 times too far ahead: now_s - (now_ms - 2000).
          skewSeconds: NOW_SECONDS - (NOW.getTime() - 2000),
          skewIfMilliseconds: 2,
          signatureValid: true,
        })
      })

      it('reads 0 when the millisecond timestamp is exactly now', async () => {
        const { body, headers } = await delivery({ timestamp: String(NOW.getTime()) })

        expect(await rejectionOf(body, headers)).toMatchObject({ reason: 'stale-timestamp', skewIfMilliseconds: 0, signatureValid: true })
      })

      it('reads a negative number of seconds when the millisecond timestamp is ahead of now', async () => {
        const { body, headers } = await delivery({ timestamp: String(NOW.getTime() + 7000) })

        expect(await rejectionOf(body, headers)).toMatchObject({ reason: 'stale-timestamp', skewIfMilliseconds: -7, signatureValid: true })
      })

      it('says the signature was not good when the millisecond timestamp was signed with another secret', async () => {
        const { body, headers } = await delivery({ timestamp: String(NOW.getTime() - 2000), keyBytes: OTHER_KEY_BYTES })

        expect(await rejectionOf(body, headers)).toMatchObject({ reason: 'stale-timestamp', skewIfMilliseconds: 2, signatureValid: false })
      })

      it('treats 100000000000 as seconds and the next number up as milliseconds', async () => {
        const seconds = await delivery({ timestamp: '100000000000' })
        const millis = await delivery({ timestamp: '100000000001' })

        expect(await rejectionOf(seconds.body, seconds.headers)).toMatchObject({ reason: 'stale-timestamp', skewIfMilliseconds: null })
        // 100000000001 ms is 100000000.001 s, so now_s minus that is 100,000,000 s less than now_s, to the second.
        expect(await rejectionOf(millis.body, millis.headers)).toMatchObject({ reason: 'stale-timestamp', skewIfMilliseconds: NOW_SECONDS - 100_000_000 })
      })
    })

    it('comes before the signature is judged: a stale delivery with a wrong signature is stale, not a mismatch', async () => {
      const { body, headers } = await delivery({ ageSeconds: 1000, keyBytes: OTHER_KEY_BYTES })

      expect((await rejectionOf(body, headers)).reason).toBe('stale-timestamp')
    })

    it('comes before the secret is read: a stale delivery is stale even when our secret cannot be decoded', async () => {
      const { body, headers } = await delivery({ ageSeconds: 1000 })

      expect((await rejectionOf(body, headers, client('whsec_!!!not-base64!!!'))).reason).toBe('stale-timestamp')
    })
  })

  describe('rejection: unreadable-secret', () => {
    it.each(['whsec_!!!not-base64!!!', '!!!not-base64!!!'])('is reported when our configured secret "%s" cannot be base64-decoded, without throwing', async (secret) => {
      const { body, headers } = await delivery()

      await expect(rejectionOf(body, headers, client(secret))).resolves.toEqual({ reason: 'unreadable-secret' })
    })
  })

  describe('rejection: signature-mismatch', () => {
    it('is reported for a signature made with another secret, however ours is configured, with what the header held and no match for our text', async () => {
      const { body, headers } = await delivery({ keyBytes: OTHER_KEY_BYTES })
      const expected = MISMATCH

      expect(await rejectionOf(body, headers, client(`whsec_${SECRET_BASE64}`))).toEqual(expected)
      expect(await rejectionOf(body, headers, client(SECRET_BASE64))).toEqual(expected)
    })

    it('is reported for a body that was changed after it was signed, by a single character', async () => {
      const { body, headers } = await delivery()

      expect((await rejectionOf(body.replace(TASK_ID, 'task-skin-2'), headers)).reason).toBe('signature-mismatch')
      expect((await rejectionOf(body + ' ', headers)).reason).toBe('signature-mismatch')
    })

    it('is reported for a delivery whose webhook id or timestamp was changed after signing, even inside the time window', async () => {
      const { body, headers, signature } = await delivery()
      const otherId = new Headers({ 'webhook-id': WEBHOOK_ID + 'x', 'webhook-timestamp': headers.get('webhook-timestamp')!, 'webhook-signature': `v1,${signature}` })
      const otherTime = new Headers({ 'webhook-id': WEBHOOK_ID, 'webhook-timestamp': String(NOW_SECONDS - 1), 'webhook-signature': `v1,${signature}` })

      expect((await rejectionOf(body, otherId)).reason).toBe('signature-mismatch')
      expect((await rejectionOf(body, otherTime)).reason).toBe('signature-mismatch')
    })

    it('lists each version it saw once, with how many entries there were, when none matches', async () => {
      const { body, timestamp } = await delivery()
      const wrong = base64(new Uint8Array(32).fill(9))

      expect(await rejectionOf(body, withSignature(timestamp, `v2,${wrong} v1,${wrong} v1,${wrong}`))).toEqual({
        ...MISMATCH,
        versions: ['v1', 'v2'],
        signatureCount: 3,
      })
    })

    it('ignores a signature of a version it does not know: v2 alone does not match', async () => {
      const { body, timestamp, signature } = await delivery()

      expect(await rejectionOf(body, withSignature(timestamp, `v2,${signature}`))).toEqual({ ...MISMATCH, versions: ['v2'] })
    })

    it('sorts the versions, and names a prefix that is not v and one to three digits "other", never as it was written', async () => {
      const { body, timestamp } = await delivery()
      const wrong = base64(new Uint8Array(32).fill(9))
      const header = `v1000,${wrong} leaky-prefix-482913,${wrong} v1,${wrong} v999,${wrong} v1234,${wrong}`

      const rejection = await rejectionOf(body, withSignature(timestamp, header))

      expect(rejection).toEqual({ ...MISMATCH, versions: ['other', 'v1', 'v999'], signatureCount: 5 })
      expect(JSON.stringify(rejection)).not.toContain('leaky-prefix-482913')
    })

    it.each(['v1', 'v1,', 'v1,!!!not-base64!!!', 'garbage', ',', 'v1,AAAA,BBBB'])('is reported, without throwing, for a signature header of "%s"', async (value) => {
      const { body, timestamp } = await delivery()

      await expect(rejectionOf(body, withSignature(timestamp, value))).resolves.toMatchObject({ reason: 'signature-mismatch', signatureCount: 1 })
    })

    // The configured secret is the base64 text. A sender that keyed with its own characters (not decoded) would sign like this.
    describe('undecodedSecretWouldMatch', () => {
      it('is true when the delivery was signed with the configured secret string as UTF-8 bytes, whsec_ prefix included', async () => {
        const secret = `whsec_${SECRET_BASE64}`
        const { body, headers } = await delivery({ keyBytes: new TextEncoder().encode(secret) })

        expect(await rejectionOf(body, headers, client(secret))).toEqual({ ...MISMATCH, undecodedSecretWouldMatch: true })
      })

      it('is true when the delivery was signed with the part after whsec_ as UTF-8 bytes', async () => {
        const { body, headers } = await delivery({ keyBytes: new TextEncoder().encode(SECRET_BASE64) })

        expect(await rejectionOf(body, headers, client(`whsec_${SECRET_BASE64}`))).toMatchObject({ reason: 'signature-mismatch', undecodedSecretWouldMatch: true })
      })

      it('is true for a secret configured without the prefix, signed with that text as UTF-8 bytes', async () => {
        const { body, headers } = await delivery({ keyBytes: new TextEncoder().encode(SECRET_BASE64) })

        expect(await rejectionOf(body, headers, client(SECRET_BASE64))).toMatchObject({ reason: 'signature-mismatch', undecodedSecretWouldMatch: true })
      })

      it('is true when the matching entry is one of several', async () => {
        const secret = `whsec_${SECRET_BASE64}`
        const { body, timestamp, signature } = await delivery({ keyBytes: new TextEncoder().encode(secret) })
        const wrong = base64(new Uint8Array(32).fill(9))

        expect(await rejectionOf(body, withSignature(timestamp, `v1,${wrong} v1,${signature}`), client(secret))).toMatchObject({
          signatureCount: 2,
          undecodedSecretWouldMatch: true,
        })
      })

      it('is false for a signature made with a random key', async () => {
        const random = crypto.getRandomValues(new Uint8Array(24))
        const { body, headers } = await delivery({ keyBytes: random })

        expect(await rejectionOf(body, headers)).toMatchObject({ reason: 'signature-mismatch', undecodedSecretWouldMatch: false })
      })

      it('is false when only a v2 entry was made with the secret text, since only v1 counts', async () => {
        const secret = `whsec_${SECRET_BASE64}`
        const { body, timestamp, signature } = await delivery({ keyBytes: new TextEncoder().encode(secret) })

        expect(await rejectionOf(body, withSignature(timestamp, `v2,${signature}`), client(secret))).toMatchObject({ undecodedSecretWouldMatch: false })
      })
    })

    // Real deliveries carry ids like `msg_…:122998323166`. A sender that signs over the id without the part from its first ':' on would
    // be accepted if we did the same, and the log should say so.
    describe('idWithoutSuffixWouldMatch and undecodedAndIdWithoutSuffixWouldMatch', () => {
      const BASE_ID = 'msg_2zq0xYk4WpP3eK8vNn1aBcDeFgH'
      const SUFFIXED_ID = `${BASE_ID}:122998323166`

      /** A delivery that carries `headerId` but was signed over `signedId`, with `keyBytes`. */
      const signedOver = async (headerId: string, signedId: string, keyBytes: Uint8Array = KEY_BYTES, body = BODY) => {
        const timestamp = String(NOW_SECONDS)
        return { body, headers: new Headers({ 'webhook-id': headerId, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${await sign(signedId, timestamp, body, keyBytes)}` }) }
      }

      it('is true, and the others false, when the signature is over the id up to its first colon, with the decoded secret', async () => {
        const { body, headers } = await signedOver(SUFFIXED_ID, BASE_ID)

        expect(await rejectionOf(body, headers)).toEqual({ ...MISMATCH, idWithoutSuffixWouldMatch: true })
      })

      it('is false when the id has a suffix but was signed over the whole id (that is accepted, not a mismatch)', async () => {
        const { body, headers } = await signedOver(SUFFIXED_ID, SUFFIXED_ID)

        expect(await client().checkWebhook(body, headers)).toEqual({ ok: true, delivery: { webhookId: SUFFIXED_ID, taskId: TASK_ID, taskStatus: 'success' } })
      })

      it('is false when the signature is over the id up to its first colon but made with another secret', async () => {
        const { body, headers } = await signedOver(SUFFIXED_ID, BASE_ID, OTHER_KEY_BYTES)

        expect(await rejectionOf(body, headers)).toEqual(MISMATCH)
      })

      it('is false when the id has no colon, whatever the signature', async () => {
        const { body, headers } = await signedOver(BASE_ID, BASE_ID, OTHER_KEY_BYTES)

        expect(await rejectionOf(body, headers)).toEqual(MISMATCH)
      })

      it('cuts the id at its FIRST colon: the text before it matches, the text before the last colon does not', async () => {
        const first = await signedOver('a:b:c', 'a')
        const last = await signedOver('a:b:c', 'a:b')

        expect(await rejectionOf(first.body, first.headers)).toMatchObject({ idWithoutSuffixWouldMatch: true })
        expect(await rejectionOf(last.body, last.headers)).toMatchObject({ idWithoutSuffixWouldMatch: false })
      })

      it('is true when the matching entry is one of several', async () => {
        const { body, headers } = await signedOver(SUFFIXED_ID, BASE_ID)
        const wrong = base64(new Uint8Array(32).fill(9))
        headers.set('webhook-signature', `v1,${wrong} ${headers.get('webhook-signature')}`)

        expect(await rejectionOf(body, headers)).toMatchObject({ signatureCount: 2, idWithoutSuffixWouldMatch: true })
      })

      it('is false when the matching entry is not v1', async () => {
        const { body, headers } = await signedOver(SUFFIXED_ID, BASE_ID)
        headers.set('webhook-signature', headers.get('webhook-signature')!.replace('v1,', 'v2,'))

        expect(await rejectionOf(body, headers)).toMatchObject({ idWithoutSuffixWouldMatch: false })
      })

      it('puts the both-ways flag up, and only it, when the signature is over the id without its suffix and keyed with the secret text, prefix included', async () => {
        const secret = `whsec_${SECRET_BASE64}`
        const { body, headers } = await signedOver(SUFFIXED_ID, BASE_ID, new TextEncoder().encode(secret))

        expect(await rejectionOf(body, headers, client(secret))).toEqual({ ...MISMATCH, undecodedAndIdWithoutSuffixWouldMatch: true })
      })

      it('puts the both-ways flag up when the key is the part after whsec_ as UTF-8 bytes', async () => {
        const { body, headers } = await signedOver(SUFFIXED_ID, BASE_ID, new TextEncoder().encode(SECRET_BASE64))

        expect(await rejectionOf(body, headers, client(`whsec_${SECRET_BASE64}`))).toEqual({ ...MISMATCH, undecodedAndIdWithoutSuffixWouldMatch: true })
      })

      it('puts the both-ways flag up for a secret configured without the prefix', async () => {
        const { body, headers } = await signedOver(SUFFIXED_ID, BASE_ID, new TextEncoder().encode(SECRET_BASE64))

        expect(await rejectionOf(body, headers, client(SECRET_BASE64))).toMatchObject({ undecodedAndIdWithoutSuffixWouldMatch: true })
      })

      it('leaves the both-ways flag down when the text key signed over the whole id: that is the undecoded deviation alone', async () => {
        const secret = `whsec_${SECRET_BASE64}`
        const { body, headers } = await signedOver(SUFFIXED_ID, SUFFIXED_ID, new TextEncoder().encode(secret))

        expect(await rejectionOf(body, headers, client(secret))).toEqual({ ...MISMATCH, undecodedSecretWouldMatch: true })
      })

      it('leaves the both-ways flag down for an id with no colon', async () => {
        const secret = `whsec_${SECRET_BASE64}`
        const { body, headers } = await signedOver(BASE_ID, BASE_ID, new TextEncoder().encode(secret))

        expect(await rejectionOf(body, headers, client(secret))).toEqual({ ...MISMATCH, undecodedSecretWouldMatch: true })
      })
    })

    describe('topLevelKeys and dataKeys', () => {
      const mismatchOf = async (body: string) => {
        const { headers } = await delivery({ body, keyBytes: OTHER_KEY_BYTES })
        return rejectionOf(body, headers)
      }

      it('lists the key names of the real body, sorted, so its layout is learned', async () => {
        const body = JSON.stringify({ type: 'x', created_at: 1, data: { task_status: 'success', task_id: 't', extra_field: 2 } })

        expect(await mismatchOf(body)).toMatchObject({ reason: 'signature-mismatch', topLevelKeys: ['created_at', 'data', 'type'], dataKeys: ['extra_field', 'task_id', 'task_status'] })
      })

      it('lists no data keys when data is not an object, and still the top-level ones', async () => {
        expect(await mismatchOf(JSON.stringify({ created_at: 1, data: 'text' }))).toMatchObject({ topLevelKeys: ['created_at', 'data'], dataKeys: [] })
      })

      it.each([['not JSON', 'not json at all'], ['null', 'null'], ['a list', '[1, 2]'], ['empty', '']])('lists no keys when the body is %s', async (_label, body) => {
        expect(await mismatchOf(body)).toMatchObject({ reason: 'signature-mismatch', topLevelKeys: [], dataKeys: [] })
      })

      it('drops a key that is not code-shaped and keeps one of exactly 40 characters, as bad-shape does', async () => {
        const forty = 'k'.repeat(40)
        const body = JSON.stringify({ [forty]: 1, ['k'.repeat(41)]: 2, 'user@example.com': 3, 'has space': 4, data: { 'a b': 1, fine_1: 2 } })

        expect(await mismatchOf(body)).toMatchObject({ topLevelKeys: ['data', forty], dataKeys: ['fine_1'] })
      })

      it('lists at most 20 keys of each kind: the first 20 in sorted order, however they were written', async () => {
        const keys = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`a${String(count - i).padStart(2, '0')}`, i]))
        const sortedFirst = Array.from({ length: 20 }, (_, i) => `a${String(i + 1).padStart(2, '0')}`)

        expect(await mismatchOf(JSON.stringify({ ...keys(21), data: keys(21) }))).toMatchObject({ topLevelKeys: sortedFirst, dataKeys: sortedFirst })
      })
    })

    it('comes before the body is read: a wrongly signed body that is not JSON is a mismatch', async () => {
      const { body, headers } = await delivery({ body: 'not json at all', keyBytes: OTHER_KEY_BYTES })

      expect((await rejectionOf(body, headers)).reason).toBe('signature-mismatch')
    })
  })

  describe('rejection: bad-shape', () => {
    it('is not-json for a correctly signed body that is not JSON, with no keys', async () => {
      expect(await shapeOf('not json at all')).toEqual({ reason: 'bad-shape', problem: 'not-json', topLevelKeys: [], dataKeys: [] })
    })

    it('is no-data when there is no data, and lists the top-level keys it has', async () => {
      expect(await shapeOf(JSON.stringify({ created_at: 1, type: 'x' }))).toEqual({ reason: 'bad-shape', problem: 'no-data', topLevelKeys: ['created_at', 'type'], dataKeys: [] })
    })

    it.each([
      ['null', 'null'],
      ['a number', '5'],
      ['a list', '[1, 2]'],
    ])('is no-data, with no keys and no throw, when the body is JSON that is %s', async (_label, body) => {
      expect(await shapeOf(body)).toEqual({ reason: 'bad-shape', problem: 'no-data', topLevelKeys: [], dataKeys: [] })
    })

    it('is no-data when data is not an object, with no data keys', async () => {
      expect(await shapeOf(JSON.stringify({ created_at: 1, data: 'text' }))).toEqual({
        reason: 'bad-shape',
        problem: 'no-data',
        topLevelKeys: ['created_at', 'data'],
        dataKeys: [],
      })
    })

    it('is no-data when data is null', async () => {
      expect(await shapeOf(JSON.stringify({ data: null }))).toEqual({ reason: 'bad-shape', problem: 'no-data', topLevelKeys: ['data'], dataKeys: [] })
    })

    it('is no-task-id when data has no task id, and lists the keys of data', async () => {
      expect(await shapeOf(JSON.stringify({ created_at: 1, data: { task_status: 'success' } }))).toEqual({
        reason: 'bad-shape',
        problem: 'no-task-id',
        topLevelKeys: ['created_at', 'data'],
        dataKeys: ['task_status'],
      })
    })

    it('is no-task-id when the task id is not text', async () => {
      expect(await shapeOf(JSON.stringify({ created_at: 1, data: { task_id: 5, task_status: 'success' } }))).toMatchObject({ problem: 'no-task-id', dataKeys: ['task_id', 'task_status'] })
    })

    it('is no-task-id when the task id is empty text', async () => {
      expect(await shapeOf(JSON.stringify({ created_at: 1, data: { task_id: '', task_status: 'success' } }))).toMatchObject({ problem: 'no-task-id' })
    })

    it('is bad-task-status for a status other than success or error', async () => {
      expect(await shapeOf(JSON.stringify({ created_at: 1, data: { task_id: 't', task_status: 'running' } }))).toEqual({
        reason: 'bad-shape',
        problem: 'bad-task-status',
        taskStatusValue: 'running',
        topLevelKeys: ['created_at', 'data'],
        dataKeys: ['task_id', 'task_status'],
      })
    })

    describe('camelCase, as Perfect Corp sends it', () => {
      const camel = (data: Record<string, unknown>) => shapeOf(JSON.stringify({ created_at: 1, data }))

      it.each([
        ['absent', { taskStatus: 'success' }, ['taskStatus']],
        ['empty text', { taskId: '', taskStatus: 'success' }, ['taskId', 'taskStatus']],
        ['a number', { taskId: 5, taskStatus: 'success' }, ['taskId', 'taskStatus']],
        ['null', { taskId: null, taskStatus: 'success' }, ['taskId', 'taskStatus']],
      ])('is no-task-id when taskId is %s, and lists the keys of data', async (_label, data, dataKeys) => {
        const rejection = await camel(data)

        expect(rejection).toEqual({ reason: 'bad-shape', problem: 'no-task-id', topLevelKeys: ['created_at', 'data'], dataKeys })
      })

      it('is bad-task-status, carrying the status, for a status of running', async () => {
        expect(await camel({ taskId: 't', taskStatus: 'running' })).toEqual({
          reason: 'bad-shape',
          problem: 'bad-task-status',
          taskStatusValue: 'running',
          topLevelKeys: ['created_at', 'data'],
          dataKeys: ['taskId', 'taskStatus'],
        })
      })

      it('is bad-task-status, carrying the status as written, for SUCCESS: the status is matched exactly', async () => {
        expect(await camel({ taskId: 't', taskStatus: 'SUCCESS' })).toMatchObject({ problem: 'bad-task-status', taskStatusValue: 'SUCCESS' })
      })

      it('is bad-task-status with no status carried when there is no status', async () => {
        const rejection = await camel({ taskId: 't' })

        expect(rejection).toMatchObject({ problem: 'bad-task-status', dataKeys: ['taskId'] })
        expect('taskStatusValue' in rejection).toBe(false)
      })
    })

    describe('taskStatusValue', () => {
      const statusOf = async (taskStatus: unknown, spelling: 'taskStatus' | 'task_status' = 'taskStatus') =>
        shapeOf(JSON.stringify({ created_at: 1, data: { [spelling === 'taskStatus' ? 'taskId' : 'task_id']: 't', [spelling]: taskStatus } }))

      it.each([
        ['a space in it', 'a b'],
        ['30 characters', 'x'.repeat(30)],
        ['21 characters', 'x'.repeat(21)],
        ['a number', 5],
        ['an email address', 'amara@example.com'],
        ['a digit in it', 'run1'],
        ['empty text', ''],
        ['null', null],
        ['a list', ['running']],
      ])('is left out, as a key, when the status is %s: it is not an enum-like word, so it is not safe to log', async (_label, taskStatus) => {
        for (const spelling of ['taskStatus', 'task_status'] as const) {
          const rejection = await statusOf(taskStatus, spelling)

          expect(rejection).toMatchObject({ reason: 'bad-shape', problem: 'bad-task-status' })
          expect('taskStatusValue' in rejection, `${spelling}: ${JSON.stringify(taskStatus)}`).toBe(false)
        }
      })

      it.each([
        ['running'],
        ['SUCCESS'],
        ['in_progress'],
        ['in-progress'],
        ['x'],
        ['x'.repeat(20)],
      ])('is carried, as written, when the status is the enum-like word "%s"', async (taskStatus) => {
        for (const spelling of ['taskStatus', 'task_status'] as const) {
          expect(await statusOf(taskStatus, spelling)).toMatchObject({ problem: 'bad-task-status', taskStatusValue: taskStatus })
        }
      })

      it('is not on a rejection that is not about the status', async () => {
        const rejection = await shapeOf(JSON.stringify({ created_at: 1, data: { taskStatus: 'running' } }))

        expect(rejection).toMatchObject({ problem: 'no-task-id' })
        expect('taskStatusValue' in rejection).toBe(false)
      })
    })

    it('is bad-task-status when there is no status', async () => {
      expect(await shapeOf(JSON.stringify({ created_at: 1, data: { task_id: 't' } }))).toMatchObject({ problem: 'bad-task-status', dataKeys: ['task_id'] })
    })

    it('reports the task id problem before the status problem when both are wrong', async () => {
      expect(await shapeOf(JSON.stringify({ data: { task_status: 'running' } }))).toMatchObject({ problem: 'no-task-id' })
    })

    it('sorts the keys it lists', async () => {
      expect(await shapeOf(JSON.stringify({ zeta: 1, alpha: 2, mid: 3 }))).toMatchObject({ topLevelKeys: ['alpha', 'mid', 'zeta'] })
    })

    it('drops a key that is not code-shaped (letters, digits and underscores, 1 to 40 of them), and keeps one of exactly 40', async () => {
      const forty = 'k'.repeat(40)
      const body = JSON.stringify({
        [forty]: 1,
        ['k'.repeat(41)]: 2,
        'user@example.com': 3,
        'has space': 4,
        'dash-ed': 5,
        '': 6,
        'ok_Key9': 7,
        data: { 'Bearer abc.def': 1, 'a b': 2, fine_1: 3, task_status: 'running' },
      })

      expect(await shapeOf(body)).toEqual({
        reason: 'bad-shape',
        problem: 'no-task-id',
        topLevelKeys: ['data', forty, 'ok_Key9'],
        dataKeys: ['fine_1', 'task_status'],
      })
    })

    it('lists at most 20 keys of each kind: all 20 when there are 20, the first 20 in sorted order when there are 21', async () => {
      const keys = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`a${String(count - i).padStart(2, '0')}`, i]))
      const sortedFirst = (count: number) => Array.from({ length: count }, (_, i) => `a${String(i + 1).padStart(2, '0')}`)

      // Written in reverse, so keeping the first 20 written and keeping the first 20 sorted are different answers.
      const exactly = await shapeOf(JSON.stringify({ ...keys(20) }))
      const over = await shapeOf(JSON.stringify({ ...keys(21) }))
      const overData = await shapeOf(JSON.stringify({ data: { ...keys(21) } }))

      expect(exactly).toMatchObject({ topLevelKeys: sortedFirst(20) })
      expect(over).toMatchObject({ topLevelKeys: sortedFirst(20) })
      expect(overData).toMatchObject({ topLevelKeys: ['data'], dataKeys: sortedFirst(20) })
    })

    it('is checked last: it comes only after the signature is good', async () => {
      const wrongKey = await delivery({ body: JSON.stringify({ created_at: 1 }), keyBytes: OTHER_KEY_BYTES })

      expect((await rejectionOf(wrongKey.body, wrongKey.headers)).reason).toBe('signature-mismatch')
    })
  })

  describe('what a rejection never holds', () => {
    const VALUE = 'distinctive-body-value-482913'
    const CAMEL_TASK_ID = 'camel-task-id-739104'

    it('carries no secret, no signature, no webhook id and no value from the body, whichever way the delivery fails', async () => {
      const secret = `whsec_${SECRET_BASE64}`
      const leakyBody = (data: Record<string, unknown>) => JSON.stringify({ created_at: 1, note: VALUE, data: { task_id: TASK_ID, ...data } })
      const wrong = base64(new Uint8Array(32).fill(9))
      const scenarios: { name: string; make: () => Promise<{ rejection: Awaited<ReturnType<typeof rejectionOf>>; signature: string }> }[] = []
      const add = (name: string, build: () => Promise<{ body: string; headers: Headers; signature: string; secret?: string }>) =>
        scenarios.push({
          name,
          make: async () => {
            const built = await build()
            return { rejection: await rejectionOf(built.body, built.headers, client(built.secret ?? secret)), signature: built.signature }
          },
        })

      add('missing header', async () => {
        const d = await delivery({ body: leakyBody({ task_status: 'success' }) })
        d.headers.delete('webhook-timestamp')
        return d
      })
      add('bad timestamp', () => delivery({ timestamp: 'abc', body: leakyBody({ task_status: 'success' }) }))
      add('stale', () => delivery({ ageSeconds: 5000, body: leakyBody({ task_status: 'success' }) }))
      add('stale in milliseconds', () => delivery({ timestamp: String(NOW.getTime()), body: leakyBody({ task_status: 'success' }) }))
      add('unreadable secret', async () => ({ ...(await delivery({ body: leakyBody({ task_status: 'success' }) })), secret: 'whsec_!!!not-base64!!!' }))
      add('mismatch', async () => {
        const d = await delivery({ body: leakyBody({ task_status: 'success' }), keyBytes: OTHER_KEY_BYTES })
        d.headers.set('webhook-signature', `v1,${d.signature} leaky-prefix-482913,${wrong}`)
        return d
      })
      add('mismatch signed with the secret text', async () => delivery({ body: leakyBody({ task_status: 'success' }), keyBytes: new TextEncoder().encode(secret) }))
      add('mismatch with an id suffix, signed over the id without it', async () => {
        const id = `${WEBHOOK_ID}:122998323166`
        const timestamp = String(NOW_SECONDS)
        const body = leakyBody({ task_status: 'success' })
        const signature = await sign(WEBHOOK_ID, timestamp, body)
        return { body, headers: new Headers({ 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` }), signature }
      })
      add('mismatch with an id suffix, signed with the secret text over the id without it', async () => {
        const id = `${WEBHOOK_ID}:122998323166`
        const timestamp = String(NOW_SECONDS)
        const body = leakyBody({ task_status: 'success' })
        const signature = await sign(WEBHOOK_ID, timestamp, body, new TextEncoder().encode(secret))
        return { body, headers: new Headers({ 'webhook-id': id, 'webhook-timestamp': timestamp, 'webhook-signature': `v1,${signature}` }), signature }
      })
      add('mismatch with keys that hold values', () =>
        delivery({
          keyBytes: OTHER_KEY_BYTES,
          body: JSON.stringify({ [`not code shaped ${VALUE}`]: 1, note: VALUE, data: { task_id: TASK_ID, task_status: VALUE, [`${TASK_ID}:${VALUE}`]: 2 } }),
        }),
      )
      add('not json', () => delivery({ body: `not json, ${VALUE}` }))
      add('no data', () => delivery({ body: JSON.stringify({ note: VALUE }) }))
      add('no task id', () => delivery({ body: JSON.stringify({ data: { note: VALUE, task_status: 'success' } }) }))
      add('bad status', () => delivery({ body: leakyBody({ task_status: VALUE }) }))
      add('keys that hold values', () => delivery({ body: JSON.stringify({ [`not code shaped ${VALUE}`]: 1, data: { task_status: VALUE, [TASK_ID]: 1, [`${TASK_ID}:${VALUE}`]: 2 } }) }))
      // The camelCase body Perfect Corp really sends, refused in each way the shape check can, with a task id that is easy to find in the output.
      const camelBody = (data: Record<string, unknown>) => JSON.stringify({ created_at: 1, note: VALUE, data: { taskId: CAMEL_TASK_ID, ...data } })
      add('camelCase, bad status', () => delivery({ body: camelBody({ taskStatus: VALUE }) }))
      add('camelCase, bad status that is the task id', () => delivery({ body: camelBody({ taskStatus: CAMEL_TASK_ID }) }))
      add('camelCase, no status', () => delivery({ body: camelBody({}) }))
      add('camelCase, status of running', () => delivery({ body: camelBody({ taskStatus: 'running' }) }))
      add('camelCase, wrongly signed', () => delivery({ body: camelBody({ taskStatus: 'success' }), keyBytes: OTHER_KEY_BYTES }))
      add('camelCase, stale', () => delivery({ ageSeconds: 5000, body: camelBody({ taskStatus: 'success' }) }))
      add('camelCase, keys that hold values', () => delivery({ body: JSON.stringify({ data: { taskStatus: VALUE, [CAMEL_TASK_ID]: 1, [`${CAMEL_TASK_ID}:${VALUE}`]: 2 } }) }))

      for (const scenario of scenarios) {
        const { rejection, signature } = await scenario.make()
        const text = JSON.stringify(rejection)

        for (const [what, secretValue] of [
          ['the secret', secret],
          ['the secret without its prefix', SECRET_BASE64],
          ['the signature', signature],
          ['the other signature', wrong],
          ['the webhook id', WEBHOOK_ID],
          ['the id suffix', '122998323166'],
          ['the task id', TASK_ID],
          ['the camelCase task id', CAMEL_TASK_ID],
          ['a body value', VALUE],
          ['a prefix as written', 'leaky-prefix-482913'],
        ] as const) {
          expect(text, `${scenario.name}: ${what}`).not.toContain(secretValue)
        }
      }
    })

    it('never throws, whatever the headers and body hold', async () => {
      const oddHeaders = ['', ' ', 'v1,', ',,,', 'v1,é', 'v1 v1 v1', 'v1,' + 'A'.repeat(10_000)]
      for (const value of oddHeaders) {
        const { body, timestamp } = await delivery()
        await expect(client().checkWebhook(body, withSignature(timestamp, value))).resolves.toMatchObject({ ok: false })
      }
      for (const body of ['', '{', '"text"', '{"data":{"task_id":{"a":1},"task_status":[]}}']) {
        const signed = await delivery({ body })
        await expect(client().checkWebhook(signed.body, signed.headers)).resolves.toMatchObject({ ok: false })
      }
    })
  })
})
