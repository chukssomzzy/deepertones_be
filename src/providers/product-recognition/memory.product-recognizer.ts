import type { ProductImage } from '../product-analysis/product-analyst.provider'
import type { ProductRecognizer, Recognition, ShelfProductTarget, ShelfRecognition } from './product-recognizer.provider'

/** Answers from a function you set ("unreadable" until then), and records the images it was shown. For tests. */
export class MemoryProductRecognizer implements ProductRecognizer {
  readonly calls: ProductImage[] = []
  private answer: (image: ProductImage) => Recognition = () => ({ classification: 'unreadable' })
  readonly shelfCalls: ProductImage[] = []
  private shelfAnswer: (image: ProductImage) => ShelfRecognition = () => ({ classification: 'unreadable', products: [], excluded: { otherProducts: 0, unreadable: 0 } })
  readonly shelfProductCalls: { image: ProductImage; target: ShelfProductTarget }[] = []
  private shelfProductAnswer: (image: ProductImage, target: ShelfProductTarget) => Recognition = () => ({ classification: 'unreadable' })
  private failure: Error | undefined

  respondWith(answer: (image: ProductImage) => Recognition) {
    this.answer = answer
  }

  respondToShelfWith(answer: (image: ProductImage) => ShelfRecognition) {
    this.shelfAnswer = answer
  }

  respondToShelfProductWith(answer: (image: ProductImage, target: ShelfProductTarget) => Recognition) {
    this.shelfProductAnswer = answer
  }

  /** The next recognize(), recognizeShelf() or recognizeShelfProduct(), whichever comes first, rejects with `error` and records nothing. */
  failNextWith(error: Error) {
    this.failure = error
  }

  async recognize(image: ProductImage): Promise<Recognition> {
    this.throwIfFailing()
    this.calls.push(image)
    return this.answer(image)
  }

  async recognizeShelf(image: ProductImage): Promise<ShelfRecognition> {
    this.throwIfFailing()
    this.shelfCalls.push(image)
    return this.shelfAnswer(image)
  }

  async recognizeShelfProduct(image: ProductImage, target: ShelfProductTarget): Promise<Recognition> {
    this.throwIfFailing()
    this.shelfProductCalls.push({ image, target })
    return this.shelfProductAnswer(image, target)
  }

  private throwIfFailing() {
    if (!this.failure) return
    const failure = this.failure
    this.failure = undefined
    throw failure
  }
}
