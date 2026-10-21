import type { CatalogDrafter, DraftRequest, DraftResult } from './catalog-drafter.provider'

/** Answers from a function you set, and records what it was asked. For tests. */
export class MemoryCatalogDrafter implements CatalogDrafter {
  readonly calls: DraftRequest[] = []
  private answer: (request: DraftRequest) => DraftResult = () => ({ cells: {}, availability: [] })
  private failure: Error | undefined

  respondWith(answer: (request: DraftRequest) => DraftResult) {
    this.answer = answer
  }

  /** The next draft() rejects with `error` and records nothing. */
  failNextWith(error: Error) {
    this.failure = error
  }

  async draft(request: DraftRequest): Promise<DraftResult> {
    if (this.failure) {
      const failure = this.failure
      this.failure = undefined
      throw failure
    }
    this.calls.push(request)
    return this.answer(request)
  }
}
