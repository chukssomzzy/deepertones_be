import type { GoalReader, GoalReading } from './goal-reader.provider'

/** Answers from a function you set ("no goal" until then), and records the text it was given. For tests. */
export class MemoryGoalReader implements GoalReader {
  readonly calls: string[] = []
  private answer: (text: string) => GoalReading = () => ({ goal: null, wantsLighter: false })
  private failure: Error | undefined

  respondWith(answer: (text: string) => GoalReading) {
    this.answer = answer
  }

  /** The next read() rejects with `error` and records nothing. */
  failNextWith(error: Error) {
    this.failure = error
  }

  async read(text: string): Promise<GoalReading> {
    if (this.failure) {
      const failure = this.failure
      this.failure = undefined
      throw failure
    }
    this.calls.push(text)
    return this.answer(text)
  }
}
