export const CACHE_CONTROL = 'public, max-age=86400'
export const MANIFEST_KEY = '_sync-manifest.json'
// The Worker writes stock images here (catalog/<environment>/…) into the same bucket; the sync must never overwrite them.
export const CATALOG_PREFIX = 'catalog/'

export type Manifest = { version: 1; files: Record<string, string> }
export type LocalFile = { key: string; sha256: string }
export type AssetPlan = { upload: string[]; unchanged: string[]; orphaned: string[] }

const CONTENT_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  json: 'application/json',
  txt: 'text/plain; charset=utf-8',
  css: 'text/css; charset=utf-8',
}

export function contentTypeFor(key: string): string {
  const ext = key.includes('.') ? key.slice(key.lastIndexOf('.') + 1).toLowerCase() : ''
  if (ext === 'svg') {
    // Gmail and Outlook do not render SVG, and these files exist for email.
    throw new Error(`${key}: SVG is not allowed (Gmail and Outlook do not render it); use PNG`)
  }
  const type = CONTENT_TYPES[ext]
  if (!type) throw new Error(`${key}: no content type known for ".${ext}"; add it to CONTENT_TYPES in scripts/assets/plan.ts`)
  return type
}

/** Throws for a local key the sync must not write: the manifest's own, or one under the Worker's catalog prefix. */
export function assertKeyAllowed(key: string): void {
  if (key === MANIFEST_KEY) throw new Error(`${MANIFEST_KEY} is reserved for the sync manifest; rename the local file`)
  if (key.startsWith(CATALOG_PREFIX)) {
    throw new Error(`${key}: the ${CATALOG_PREFIX} prefix is reserved for catalog images written by the Worker; move the file out of assets/${CATALOG_PREFIX}`)
  }
}

/** Pure: decides what to upload from the local hashes and the manifest of the previous run. */
export function planAssetSync(local: LocalFile[], manifest: Manifest | null, opts: { force?: boolean } = {}): AssetPlan {
  for (const f of local) assertKeyAllowed(f.key)

  const previous = manifest?.files ?? {}
  const sorted = [...local].sort((a, b) => (a.key < b.key ? -1 : 1))
  const upload: string[] = []
  const unchanged: string[] = []
  for (const f of sorted) {
    if (opts.force || previous[f.key] !== f.sha256) upload.push(f.key)
    else unchanged.push(f.key)
  }
  const localKeys = new Set(local.map((f) => f.key))
  // Reported, never deleted: a bad push must not be able to take down a live email image.
  const orphaned = Object.keys(previous).filter((k) => !localKeys.has(k)).sort()
  return { upload, unchanged, orphaned }
}
