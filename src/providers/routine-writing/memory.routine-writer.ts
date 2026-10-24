import type { Routine, RoutineSkeleton } from '../../modules/routines/routines.types'
import type { RoutineWriter } from './routine-writer.provider'

/** Answers from a function you set (a clear "no answer set" error until then), and records the skeletons it was given. For tests. */
export class MemoryRoutineWriter implements RoutineWriter {
  readonly calls: RoutineSkeleton[] = []
  private answer: (skeleton: RoutineSkeleton) => Routine = () => {
    throw new Error('MemoryRoutineWriter: no answer set; call respondWith() first')
  }
  private failure: Error | undefined

  respondWith(answer: (skeleton: RoutineSkeleton) => Routine) {
    this.answer = answer
  }

  /** The next write() rejects with `error` and records nothing. */
  failNextWith(error: Error) {
    this.failure = error
  }

  async write(skeleton: RoutineSkeleton): Promise<Routine> {
    if (this.failure) {
      const failure = this.failure
      this.failure = undefined
      throw failure
    }
    // Recorded only once answered, so a call that fails (no answer set, or the function throws) leaves no trace.
    const routine = this.answer(skeleton)
    this.calls.push(skeleton)
    return routine
  }
}
