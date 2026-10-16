import type { ProductImage } from '../product-analysis/product-analyst.provider'
import type { ProductRecognizer, Recognition } from './product-recognizer.provider'

/** Answers from a function you set ("unreadable" until then), and records the images it was shown. For tests. */
export class MemoryProductRecognizer implements ProductRecognizer {
  readonly calls: ProductImage[] = []
  #answer: (image: ProductImage) => Recognition = () => ({ classification: 'unreadable' })
  #failure: Error | undefined

  respondWith(answer: (image: ProductImage) => Recognition) {
    this.#answer = answer
  }

  /** The next recognize() rejects with `error` and records nothing. */
  failNextWith(error: Error) {
    this.#failure = error
  }

  async recognize(image: ProductImage): Promise<Recognition> {
    if (this.#failure) {
      const failure = this.#failure
      this.#failure = undefined
      throw failure
    }
    this.calls.push(image)
    return this.#answer(image)
  }
}
