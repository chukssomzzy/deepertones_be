import type { FitRequest, FitResult, VerdictFitter } from './verdict-fitter.provider'

/** Answers from a function you set (a clear "no answer set" error until then), and records the requests it was given. For tests. */
export class MemoryVerdictFitter implements VerdictFitter {
  readonly identity = { model: 'memory-model', promptHash: 'memory-prompt-hash' }
  readonly calls: FitRequest[] = []
  private answer: (request: FitRequest) => FitResult = () => {
    throw new Error('MemoryVerdictFitter: no answer set; call respondWith() first')
  }
  private failure: Error | undefined

  respondWith(answer: (request: FitRequest) => FitResult) {
    this.answer = answer
  }

  /** The next fit() rejects with `error` and records nothing. */
  failNextWith(error: Error) {
    this.failure = error
  }

  async fit(request: FitRequest): Promise<FitResult> {
    if (this.failure) {
      const failure = this.failure
      this.failure = undefined
      throw failure
    }
    // Recorded only once answered, so a call that fails (no answer set, or the function throws) leaves no trace.
    const result = this.answer(request)
    this.calls.push(request)
    return result
  }
}
