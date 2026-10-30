import { bodyLimit } from 'hono/body-limit'
import { defineRoute, errorResponses, multipartBody, ok, openapiApp, success } from '../../lib/openapi'
import { adminToken } from '../../middleware/admin-token'
import { rateLimit } from '../../middleware/rate-limit'
import { toExportCatalogResponse, toImportCatalogResponse } from './catalog.workbook.presenter'
import { ExportCatalogResponse, ImportCatalogBody, ImportCatalogResponse } from './catalog.workbook.schemas'

// The .xlsx is at most 10 MB; the rest is room for the workbook's JSON (the same rows again, as text) and the multipart framing. bodyLimit runs before the form is read.
const MAX_IMPORT_BODY_BYTES = 16 * 1024 * 1024

// The address limit comes first and counts every caller, a wrong token included, so a guess at the token costs an attempt; then the token; then the body.
const guard = [rateLimit('ADMIN_IP_LIMITER', 'ip'), adminToken()]

const exportCatalog = defineRoute({
  method: 'get',
  path: '/catalog/export',
  operationId: 'exportCatalog',
  tags: ['Admin'],
  summary: 'The catalog workbook as it is now',
  description:
    'Every tab with its full header row, retired rows included, in the form the import takes: lists joined with `; `, dates as `YYYY-MM-DD`, an empty cell `null`. ' +
    'Importing an export unchanged changes nothing. Send the `X-Admin-Token` header; a user token never opens this.',
  security: [{ adminToken: [] }],
  middleware: guard,
  responses: { 200: success(ExportCatalogResponse, 'The live workbook'), ...errorResponses(401, 429) },
})

const importCatalog = defineRoute({
  method: 'post',
  path: '/catalog/import',
  operationId: 'importCatalog',
  tags: ['Admin'],
  summary: 'Check, and optionally apply, an edited catalog workbook',
  description:
    'Multipart. The whole workbook is the upload: a product, rule or country code it leaves out is retired, never deleted. The server checks the workbook against the contract itself, ' +
    'refuses one made for another contract version (409 `CONTRACT_MISMATCH`, checked before anything else), refuses one made from a catalog version that is not live (409 `CATALOG_STALE`), and reports the diff per tab. The default is a dry run that writes nothing. ' +
    'With `dryRun=false` and the original `.xlsx` as `file`, the file is archived and the change applied in one atomic write, which the catalog version guards. ' +
    'Problems with the workbook come as 400 `CATALOG_INVALID` with `error.details.problems`: `{ tab, row, column, rule }`, never a cell value. ' +
    'In production, an approved Ingredients, Claim words, Tapers, Guides, Reintroductions, Escalations, Responses or Weeks row whose `approved_by` is not on the server\'s list of qualified approvers is such a problem too (`UNQUALIFIED_APPROVER`). ' +
    'A workbook of the current contract version that is not eleven tabs of a header row and rows is 400 `VALIDATION_FAILED`, checked after the contract version. ' +
    'Other 400 codes: `CATALOG_FILE_REQUIRED` (applying without a file), `CATALOG_FILE_TOO_LARGE` (over 10 MB), `CATALOG_FILE_NOT_XLSX` (not a zip, so not an .xlsx) and ' +
    '`CATALOG_TOO_LARGE` (the change is too many rows for one atomic write; it is never split, so make it in smaller uploads). ' +
    '503 `CATALOG_ARCHIVE_FAILED` means the file could not be archived and nothing was applied; try again.',
  security: [{ adminToken: [] }],
  middleware: [...guard, bodyLimit({ maxSize: MAX_IMPORT_BODY_BYTES })],
  request: { body: multipartBody(ImportCatalogBody) },
  responses: { 200: success(ImportCatalogResponse, 'The diff, and whether it was applied'), ...errorResponses(401, 409, 413, 429, 503) },
})

export const adminCatalogRoutes = openapiApp()
  .openapi(exportCatalog, async (c) => ok(c, toExportCatalogResponse(await c.var.services.catalogWorkbook.exportWorkbook()), 'Catalog exported'))
  .openapi(importCatalog, async (c) => {
    const { workbook, file, baseVersion, dryRun, uploadedBy, contractVersion } = c.req.valid('form')
    const result = await c.var.services.catalogWorkbook.importWorkbook({
      workbook,
      file: file ? new Uint8Array(await file.arrayBuffer()) : null,
      baseVersion,
      dryRun,
      uploadedBy,
      contractVersion,
    })
    return ok(c, toImportCatalogResponse(result), result.applied ? 'Catalog updated' : 'Catalog checked, nothing written')
  })
