export type ProductCategory = 'skin' | 'hair' | 'body' | 'makeup' | 'other'

export const PRODUCT_FORMS = ['spray', 'roll-on', 'stick', 'cream', 'lotion', 'gel', 'oil', 'serum', 'liquid', 'bar', 'powder', 'balm'] as const
export type ProductForm = (typeof PRODUCT_FORMS)[number]

/** Who a product is, as read from its label. */
export type ProductIdentity = {
  brand: string
  name: string
  variant?: string
  form?: ProductForm
  category: ProductCategory
}

export type ResearchResult =
  /** `sourceUrl` is a page the search actually returned; `ingredients` are in label (INCI) order. */
  | { found: true; ingredients: string[]; sourceUrl: string; imageUrl?: string }
  /** Nothing usable and sourced: no list, no trustworthy page, or an answer that could not be read. */
  | { found: false }

/**
 * Finds a product's official ingredient list online. Adapters throw their vendor's errors for
 * failures the caller can act on; "could not find it" is a result, not an error.
 */
export interface ProductResearcher {
  research(product: ProductIdentity): Promise<ResearchResult>
}
