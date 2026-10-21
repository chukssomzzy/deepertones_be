import { describe, expect, it } from 'vitest'
import { MemoryPerfectCorpClient } from './memory.perfect-corp'
import { PerfectCorpRejectedPhotoError, PerfectCorpUnavailableError, type SkinAnalysisResult } from './perfect-corp.provider'

// The fake services are tested with: answers are scripted per call (consumed in order, then a plain default), and every call is logged
// in order with its arguments, so a service test can assert the exact sequence of Perfect Corp calls a scan made.

const BYTES = new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3])
const UPLOAD = { contentType: 'image/jpeg' as const, fileName: 'front.jpg' }

const SUCCESS: SkinAnalysisResult = {
  status: 'success',
  concerns: [{ concern: 'hd_acne', region: 'whole', rawScore: 40, uiScore: 50, maskUrls: ['https://masks.test/a.png'] }],
  skinTypes: [{ region: 'whole', skinType: 'Oily' }],
  skinAge: 31,
  all: 70,
  skipped: [],
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

const caught = async (promise: Promise<unknown>) => {
  try {
    await promise
  } catch (error) {
    return error
  }
  throw new Error('expected the promise to reject')
}

describe('MemoryPerfectCorpClient call log', () => {
  it('starts empty', () => {
    expect(new MemoryPerfectCorpClient().calls).toEqual([])
  })

  it('records every call in order with the method and the arguments it was given', async () => {
    const fake = new MemoryPerfectCorpClient()
    const headers = new Headers({ 'webhook-id': 'msg_1' })

    const fileId = await fake.uploadFile(BYTES, UPLOAD)
    const skinTask = await fake.createSkinAnalysis({ fileId, actions: ['hd_acne', 'hd_skin_type'] })
    const fitzTask = await fake.createFitzpatrick({ fileId })
    await fake.getSkinAnalysis(skinTask)
    await fake.getFitzpatrick(fitzTask)
    await fake.downloadMask('https://masks.test/a.png')
    await fake.deleteTask(skinTask)
    await fake.checkWebhook('{}', headers)

    expect(fake.calls).toEqual([
      { method: 'uploadFile', args: [BYTES, UPLOAD] },
      { method: 'createSkinAnalysis', args: [{ fileId, actions: ['hd_acne', 'hd_skin_type'] }] },
      { method: 'createFitzpatrick', args: [{ fileId }] },
      { method: 'getSkinAnalysis', args: [skinTask] },
      { method: 'getFitzpatrick', args: [fitzTask] },
      { method: 'downloadMask', args: ['https://masks.test/a.png'] },
      { method: 'deleteTask', args: [skinTask] },
      { method: 'checkWebhook', args: ['{}', headers] },
    ])
  })

  it('records a call that was scripted to fail, because it was still made', async () => {
    const fake = new MemoryPerfectCorpClient()
    fake.script('createSkinAnalysis', new PerfectCorpUnavailableError('down'))

    await caught(fake.createSkinAnalysis({ fileId: 'f', actions: ['hd_acne'] }))

    expect(fake.calls.map((c) => c.method)).toEqual(['createSkinAnalysis'])
  })
})

describe('MemoryPerfectCorpClient defaults', () => {
  it('numbers the file ids and task ids it hands out, each its own, across calls', async () => {
    const fake = new MemoryPerfectCorpClient()

    const files = [await fake.uploadFile(BYTES, UPLOAD), await fake.uploadFile(BYTES, UPLOAD)]
    const skin = [await fake.createSkinAnalysis({ fileId: files[0]!, actions: [] }), await fake.createSkinAnalysis({ fileId: files[1]!, actions: [] })]
    const fitz = [await fake.createFitzpatrick({ fileId: files[0]! }), await fake.createFitzpatrick({ fileId: files[1]! })]

    expect(new Set([...files, ...skin, ...fitz]).size).toBe(6)
    for (const id of [...files, ...skin, ...fitz]) expect(id).toEqual(expect.any(String))
  })

  it('says running for a task nobody scripted an answer for, so a service keeps waiting', async () => {
    const fake = new MemoryPerfectCorpClient()

    await expect(fake.getSkinAnalysis('task-1')).resolves.toEqual({ status: 'running' })
    await expect(fake.getFitzpatrick('task-2')).resolves.toEqual({ status: 'running' })
  })

  it('returns PNG bytes for a mask nobody scripted an answer for', async () => {
    const bytes = await new MemoryPerfectCorpClient().downloadMask('https://masks.test/a.png')

    expect([...bytes.slice(0, 8)]).toEqual(PNG_SIGNATURE)
  })

  it('deletes a task without complaint', async () => {
    await expect(new MemoryPerfectCorpClient().deleteTask('task-1')).resolves.toBeUndefined()
  })

  it('fails closed on a webhook nobody scripted an answer for: it is rejected as having no headers', async () => {
    await expect(new MemoryPerfectCorpClient().checkWebhook('{}', new Headers())).resolves.toEqual({
      ok: false,
      rejection: { reason: 'missing-headers', missing: ['webhook-id', 'webhook-timestamp', 'webhook-signature'] },
    })
  })
})

describe('MemoryPerfectCorpClient.script', () => {
  it('answers the next call to a method with the scripted value', async () => {
    const fake = new MemoryPerfectCorpClient()
    fake.script('getSkinAnalysis', SUCCESS)

    await expect(fake.getSkinAnalysis('task-1')).resolves.toEqual(SUCCESS)
  })

  it('hands out several scripted answers in order, one per call, then falls back to the default', async () => {
    const fake = new MemoryPerfectCorpClient()
    fake.script('getSkinAnalysis', { status: 'running' }, SUCCESS)

    expect(await fake.getSkinAnalysis('t')).toEqual({ status: 'running' })
    expect(await fake.getSkinAnalysis('t')).toEqual(SUCCESS)
    expect(await fake.getSkinAnalysis('t')).toEqual({ status: 'running' })
  })

  it('adds to what was scripted before', async () => {
    const fake = new MemoryPerfectCorpClient()
    fake.script('uploadFile', 'file-a')
    fake.script('uploadFile', 'file-b')

    expect([await fake.uploadFile(BYTES, UPLOAD), await fake.uploadFile(BYTES, UPLOAD)]).toEqual(['file-a', 'file-b'])
  })

  it('throws a scripted Error, as that very error, for that call only', async () => {
    const fake = new MemoryPerfectCorpClient()
    const rejection = new PerfectCorpRejectedPhotoError('too-dark')
    fake.script('getSkinAnalysis', rejection, SUCCESS)

    expect(await caught(fake.getSkinAnalysis('t'))).toBe(rejection)
    expect(await fake.getSkinAnalysis('t')).toEqual(SUCCESS)
  })

  it('keeps each method\'s script apart: scripting one leaves the others on their defaults', async () => {
    const fake = new MemoryPerfectCorpClient()
    fake.script('getSkinAnalysis', SUCCESS)

    await expect(fake.getFitzpatrick('t')).resolves.toEqual({ status: 'running' })
    await expect(fake.getSkinAnalysis('t')).resolves.toEqual(SUCCESS)
  })

  it('scripts the task ids, the Fitzpatrick type, the mask bytes and a checked webhook', async () => {
    const fake = new MemoryPerfectCorpClient()
    const mask = new Uint8Array([1, 2, 3])
    const hook = { ok: true as const, delivery: { webhookId: 'msg_1', taskId: 'task-1', taskStatus: 'success' as const } }
    fake.script('createSkinAnalysis', 'task-skin')
    fake.script('createFitzpatrick', 'task-fitz')
    fake.script('getFitzpatrick', { status: 'success', fitzpatrick: 'V' })
    fake.script('downloadMask', mask)
    fake.script('checkWebhook', hook)

    expect(await fake.createSkinAnalysis({ fileId: 'f', actions: [] })).toBe('task-skin')
    expect(await fake.createFitzpatrick({ fileId: 'f' })).toBe('task-fitz')
    expect(await fake.getFitzpatrick('task-fitz')).toEqual({ status: 'success', fitzpatrick: 'V' })
    expect(await fake.downloadMask('https://masks.test/a.png')).toEqual(mask)
    expect(await fake.checkWebhook('{}', new Headers())).toEqual(hook)
  })

  it('scripts a rejected webhook with its reason, then falls back to the default rejection', async () => {
    const fake = new MemoryPerfectCorpClient()
    const rejected = { ok: false as const, rejection: { reason: 'bad-timestamp' as const } }
    fake.script('checkWebhook', rejected)

    expect(await fake.checkWebhook('{}', new Headers())).toEqual(rejected)
    expect(await fake.checkWebhook('{}', new Headers())).toEqual({
      ok: false,
      rejection: { reason: 'missing-headers', missing: ['webhook-id', 'webhook-timestamp', 'webhook-signature'] },
    })
  })

  it('keeps separate fakes separate', async () => {
    const a = new MemoryPerfectCorpClient()
    const b = new MemoryPerfectCorpClient()
    a.script('getSkinAnalysis', SUCCESS)
    await a.uploadFile(BYTES, UPLOAD)

    expect(await b.getSkinAnalysis('t')).toEqual({ status: 'running' })
    expect(b.calls.map((c) => c.method)).toEqual(['getSkinAnalysis'])
  })
})
