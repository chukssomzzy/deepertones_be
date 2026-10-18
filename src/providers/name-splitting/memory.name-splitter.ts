import type { NameSplit, NameSplitter } from './name-splitter.provider'

/** Answers from a function you set ("not a product" until then), and records the text it was given. For tests. */
export class MemoryNameSplitter implements NameSplitter {
  readonly calls: string[] = []
  private answer: (text: string) => NameSplit = () => ({ kind: 'not-a-product' })
  private failure: Error | undefined

  respondWith(answer: (text: string) => NameSplit) {
    this.answer = answer
  }

  /** The next split() rejects with `error` and records nothing. */
  failNextWith(error: Error) {
    this.failure = error
  }

  async split(text: string): Promise<NameSplit> {
    if (this.failure) {
      const failure = this.failure
      this.failure = undefined
      throw failure
    }
    this.calls.push(text)
    return this.answer(text)
  }
}
