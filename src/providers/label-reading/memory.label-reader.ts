import type { ProductImage } from '../product-analysis/product-analyst.provider'
import type { LabelReader, LabelReading } from './label-reader.provider'

/** Answers from a function you set ("not readable" until then), and records the images it was shown. For tests. */
export class MemoryLabelReader implements LabelReader {
  readonly calls: ProductImage[] = []
  private answer: (image: ProductImage) => LabelReading = () => ({ readable: false })
  private failure: Error | undefined

  respondWith(answer: (image: ProductImage) => LabelReading) {
    this.answer = answer
  }

  /** The next read() rejects with `error` and records nothing. */
  failNextWith(error: Error) {
    this.failure = error
  }

  async read(image: ProductImage): Promise<LabelReading> {
    if (this.failure) {
      const failure = this.failure
      this.failure = undefined
      throw failure
    }
    this.calls.push(image)
    return this.answer(image)
  }
}
