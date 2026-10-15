import type { ProductIdentity, ProductResearcher, ResearchResult } from './product-researcher.provider'

/** Answers from a function you set, and records what it was asked. For tests. */
export class MemoryProductResearcher implements ProductResearcher {
  readonly calls: ProductIdentity[] = []
  private answer: (product: ProductIdentity) => ResearchResult = () => ({ found: false })
  private failure: Error | undefined

  respondWith(answer: (product: ProductIdentity) => ResearchResult) {
    this.answer = answer
  }

  /** The next research() rejects with `error` and records nothing. */
  failNextWith(error: Error) {
    this.failure = error
  }

  async research(product: ProductIdentity): Promise<ResearchResult> {
    if (this.failure) {
      const failure = this.failure
      this.failure = undefined
      throw failure
    }
    this.calls.push(product)
    return this.answer(product)
  }
}
