import type { FitzpatrickResult, PerfectCorpClient, SkinAnalysisResult, VerifiedWebhook } from './perfect-corp.provider'

type Method = keyof PerfectCorpClient
type Answer<M extends Method> = Awaited<ReturnType<PerfectCorpClient[M]>>

// The first 8 bytes of every PNG, then a few more so it is not empty.
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

/**
 * A PerfectCorpClient in memory, for the tests of whatever calls it. Every call is logged in order with its arguments (so a test can
 * assert the exact sequence a scan made), including a call scripted to fail. An answer is scripted per method: `script` queues values
 * that are handed out one per call, an Error being thrown as that very instance, and a plain default follows once the queue is empty.
 * The defaults keep a service waiting (tasks are `running`) and fail a webhook closed (it is not verified).
 */
export class MemoryPerfectCorpClient implements PerfectCorpClient {
  readonly calls: { method: Method; args: unknown[] }[] = []
  private readonly scripts = new Map<Method, unknown[]>()
  private files = 0
  private tasks = 0

  /** Queues answers for the next calls to `method`. */
  script<M extends Method>(method: M, ...answers: (Answer<M> | Error)[]): void {
    this.scripts.set(method, [...(this.scripts.get(method) ?? []), ...answers])
  }

  async uploadFile(bytes: Uint8Array, options: { contentType: 'image/jpeg'; fileName: string }): Promise<string> {
    return this.run('uploadFile', [bytes, options], () => `file-${++this.files}`)
  }

  async createSkinAnalysis(input: { fileId: string; actions: string[] }): Promise<string> {
    return this.run('createSkinAnalysis', [input], () => `skin-task-${++this.tasks}`)
  }

  async createFitzpatrick(input: { fileId: string }): Promise<string> {
    return this.run('createFitzpatrick', [input], () => `fitzpatrick-task-${++this.tasks}`)
  }

  async getSkinAnalysis(taskId: string): Promise<SkinAnalysisResult> {
    return this.run('getSkinAnalysis', [taskId], () => ({ status: 'running' }))
  }

  async getFitzpatrick(taskId: string): Promise<FitzpatrickResult> {
    return this.run('getFitzpatrick', [taskId], () => ({ status: 'running' }))
  }

  async deleteTask(taskId: string): Promise<void> {
    return this.run('deleteTask', [taskId], () => undefined)
  }

  async downloadMask(url: string): Promise<Uint8Array> {
    return this.run('downloadMask', [url], () => PNG_BYTES.slice())
  }

  async verifyWebhook(body: string, headers: Headers): Promise<VerifiedWebhook | null> {
    return this.run('verifyWebhook', [body, headers], () => null)
  }

  private run<M extends Method>(method: M, args: unknown[], fallback: () => Answer<M>): Answer<M> {
    this.calls.push({ method, args })
    const queue = this.scripts.get(method)
    if (!queue?.length) return fallback()
    const next = queue.shift()
    if (next instanceof Error) throw next
    return next as Answer<M>
  }
}
