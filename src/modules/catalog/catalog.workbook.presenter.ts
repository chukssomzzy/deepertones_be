import type { z } from '@hono/zod-openapi'
import type { ExportCatalogResponse, ImportCatalogResponse } from './catalog.workbook.schemas'
import type { ExportResult, ImportResult } from './catalog.workbook.service'

// Every field is named, so a field added to a result is not published by accident.
export const toExportCatalogResponse = ({ catalogVersion, contractVersion, workbook }: ExportResult): z.infer<typeof ExportCatalogResponse> => ({ catalogVersion, contractVersion, workbook })

export const toImportCatalogResponse = ({ applied, catalogVersion, diff }: ImportResult): z.infer<typeof ImportCatalogResponse> => ({
  applied,
  catalogVersion,
  diff: {
    products: diff.products,
    availability: diff.availability,
    ingredients: diff.ingredients,
    countries: diff.countries,
    claimWords: diff.claimWords,
    tapers: diff.tapers,
    newProducts: diff.newProducts.map(({ code, brand, name, variant, form }) => ({ code, brand, name, variant, form })),
  },
})
