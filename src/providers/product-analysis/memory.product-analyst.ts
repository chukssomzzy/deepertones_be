import type { ProductIdentity } from '../product-research/product-researcher.provider'
import type { AnalysisInput, DraftConcern, ProductAnalyst, ProductImage } from './product-analyst.provider'

/** Answers from functions you set (no concerns, "different product", "not a match" until then), and records the arguments. For tests. */
export class MemoryProductAnalyst implements ProductAnalyst {
  readonly calls = {
    analyse: [] as AnalysisInput[],
    sameProduct: [] as [ProductIdentity, ProductIdentity][],
    imageShowsProduct: [] as [ProductImage, ProductIdentity][],
  }
  #analyseAnswer: (input: AnalysisInput) => DraftConcern[] = () => []
  #sameProductAnswer: (a: ProductIdentity, b: ProductIdentity) => boolean = () => false
  #imageShowsProductAnswer: (image: ProductImage, product: ProductIdentity) => boolean = () => false
  #failure: Error | undefined

  analyseWith(answer: (input: AnalysisInput) => DraftConcern[]) {
    this.#analyseAnswer = answer
  }

  sameProductWith(answer: (a: ProductIdentity, b: ProductIdentity) => boolean) {
    this.#sameProductAnswer = answer
  }

  imageShowsProductWith(answer: (image: ProductImage, product: ProductIdentity) => boolean) {
    this.#imageShowsProductAnswer = answer
  }

  /** The next call, of any method, rejects with `error` and records nothing. */
  failNextWith(error: Error) {
    this.#failure = error
  }

  async analyse(input: AnalysisInput): Promise<DraftConcern[]> {
    this.#throwIfFailing()
    this.calls.analyse.push(input)
    return this.#analyseAnswer(input)
  }

  async sameProduct(a: ProductIdentity, b: ProductIdentity): Promise<boolean> {
    this.#throwIfFailing()
    this.calls.sameProduct.push([a, b])
    return this.#sameProductAnswer(a, b)
  }

  async imageShowsProduct(image: ProductImage, product: ProductIdentity): Promise<boolean> {
    this.#throwIfFailing()
    this.calls.imageShowsProduct.push([image, product])
    return this.#imageShowsProductAnswer(image, product)
  }

  #throwIfFailing() {
    if (!this.#failure) return
    const failure = this.#failure
    this.#failure = undefined
    throw failure
  }
}
