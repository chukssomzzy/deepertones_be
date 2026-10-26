import { z } from '@hono/zod-openapi'

// The admin catalog routes' wire contract (the workbook itself is defined by catalog.workbook.schema.ts, the contract; keep the two in step). The workbook itself is checked by validateWorkbook (the contract), not here: this only says what
// shape a request must have to be read at all, and what a reply holds. An uploaded workbook is only read as a JSON object here: its six tabs are checked
// by the service, after the contract version, because a file made for another version may not have them.

const MAX_UPLOADED_BY = 80
const MAX_CONTRACT_VERSION = 20

/** A tab as the spreadsheet script reads it: the header row, and rows keyed by header. A cell is text, a number, a boolean or empty. */
const RawTabSchema = z
  .object({
    headers: z.array(z.string()),
    rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]).optional())),
  })
  .openapi('CatalogWorkbookTab')

export const RawWorkbookSchema = z
  .object({ products: RawTabSchema, availability: RawTabSchema, ingredients: RawTabSchema, countries: RawTabSchema, claimWords: RawTabSchema, tapers: RawTabSchema })
  .openapi('CatalogWorkbook', { description: 'The six tabs of the catalog workbook, in the shape the export gives them and the import takes them. The contract is in docs/catalog-workbook-contract.md.' })

export const ExportCatalogResponse = z
  .object({
    catalogVersion: z.number().int().openapi({ description: 'The live catalog version: send it back as `baseVersion` when importing the edited workbook.' }),
    contractVersion: z.string().openapi({ example: '2.1.0', description: 'The contract version of the workbook: send it back as `contractVersion` when importing the edited workbook.' }),
    workbook: RawWorkbookSchema,
  })
  .openapi('CatalogExport')

/** JSON in a form field, parsed here so that a bad one is a 400 with the rest of the validation, not a 500. The contract check comes after, in the service. */
const jsonField = z.string().transform((text, ctx) => {
  try {
    return JSON.parse(text) as unknown
  } catch {
    ctx.addIssue({ code: 'custom', message: 'Not valid JSON' })
    return z.NEVER
  }
})

export const ImportCatalogBody = z.object({
  workbook: jsonField
    .pipe(z.record(z.string(), z.unknown()))
    .openapi({ type: 'string', description: 'The JSON text of the workbook (the `workbook` of an export, edited): an object of the six tabs described by `CatalogWorkbook`. Only that it is a JSON object is checked first; the tabs are checked after `contractVersion`.' }),
  file: z
    .instanceof(File)
    .optional()
    .openapi({ type: 'string', format: 'binary', description: 'The .xlsx the workbook was read from, up to 10 MB. Archived when the upload is applied; required when `dryRun` is `false`.' }),
  baseVersion: z.string().regex(/^\d{1,9}$/, 'A whole number').transform(Number).openapi({ type: 'string', description: 'The `catalogVersion` of the export the workbook was edited from.', example: '1' }),
  dryRun: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true')
    .openapi({ type: 'string', enum: ['true', 'false'], default: 'true', description: 'Only `false` applies the upload. The default reports what it would change and writes nothing.' }),
  contractVersion: z.string().min(1).max(MAX_CONTRACT_VERSION).openapi({ description: 'The `contractVersion` of the export the workbook was edited from. A workbook made for another contract version is refused with 409 `CONTRACT_MISMATCH`, before anything else is checked.', example: '2.1.0' }),
  uploadedBy: z.string().trim().min(1).max(MAX_UPLOADED_BY).openapi({ description: 'Who is uploading, as a label for the catalog version (1 to 80 characters, after trimming).' }),
})

const TabDiffSchema = z
  .object({
    added: z.array(z.string()),
    updated: z.array(z.string()),
    retired: z.array(z.string()).openapi({ description: 'Codes the upload leaves out (or marks retired). For availability, a removed row, keyed `<product code>:<country>`.' }),
    reactivated: z.array(z.string()),
  })
  .openapi('CatalogTabDiff')

export const ImportCatalogResponse = z
  .object({
    applied: z.boolean().openapi({ description: 'False for a dry run.' }),
    catalogVersion: z.number().int().openapi({ description: 'The new catalog version when applied, the live one otherwise.' }),
    diff: z.object({
      products: TabDiffSchema,
      availability: TabDiffSchema,
      ingredients: TabDiffSchema,
      countries: TabDiffSchema,
      claimWords: TabDiffSchema,
      tapers: TabDiffSchema,
      newProducts: z
        .array(z.object({ code: z.string(), brand: z.string(), name: z.string(), variant: z.string().nullable(), form: z.string().nullable() }))
        .openapi({ description: 'Product rows no catalog product has the identity of (exact identity key or alias): applying would create them.' }),
    }),
  })
  .openapi('CatalogImport')
