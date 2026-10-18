import type { Mention, MentionReader } from './mention-reader.provider'

/** Answers from a function you set (no mentions until then), and records the text it was given. For tests. */
export class MemoryMentionReader implements MentionReader {
  readonly calls: string[] = []
  private answer: (text: string) => Mention[] = () => []
  private failure: Error | undefined

  respondWith(answer: (text: string) => Mention[]) {
    this.answer = answer
  }

  /** The next read() rejects with `error` and records nothing. */
  failNextWith(error: Error) {
    this.failure = error
  }

  async read(text: string): Promise<Mention[]> {
    if (this.failure) {
      const failure = this.failure
      this.failure = undefined
      throw failure
    }
    this.calls.push(text)
    return this.answer(text)
  }
}
