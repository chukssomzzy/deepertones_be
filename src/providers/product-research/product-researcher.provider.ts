import { PRODUCT_FORMS, type ProductForm } from '../../modules/catalog/catalog.vocabulary'

export { PRODUCT_FORMS, type ProductForm }
export type ProductCategory = 'skin' | 'hair' | 'body' | 'makeup' | 'other'

/** Who a product is, as read from its label. */
export type ProductIdentity = {
  brand: string
  name: string
  variant?: string
  form?: ProductForm
  category: ProductCategory
}

export type ResearchResult =
  /**
   * `sourceUrl` is a page the search actually returned; `ingredients` are in label (INCI) order.
   * `imagePages` are pages for this exact product, best first, each one the search returned: at most 3, https only, no duplicates. Omitted when there are none.
   * `searchPages` are the other pages the search returned, in search order: https only, no duplicates, none of the `imagePages` or the `sourceUrl`, at most 30.
   * Unranked and unchecked as to product; the catalog picks from them by name. Omitted when there are none.
   */
  | { found: true; ingredients: string[]; sourceUrl: string; imagePages?: string[]; searchPages?: string[] }
  /** Nothing usable and sourced: no list, no trustworthy page, or an answer that could not be read. `imagePages` and `searchPages` as above, given even without a list when the answer was readable; an unreadable or unsourced answer has neither. */
  | { found: false; imagePages?: string[]; searchPages?: string[] }

/**
 * Finds a product's official ingredient list online. Adapters throw their vendor's errors for
 * failures the caller can act on; "could not find it" is a result, not an error.
 */
export interface ProductResearcher {
  research(product: ProductIdentity): Promise<ResearchResult>
}
