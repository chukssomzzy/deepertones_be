import { createHash } from 'node:crypto'
import { CACHE_CONTROL, MANIFEST_KEY, contentTypeFor, planAssetSync, type Manifest } from './plan'

export interface R2Client {
  bucketExists(bucket: string): Promise<boolean>
  createBucket(bucket: string): Promise<void>
  customDomains(bucket: string): Promise<string[]>
  zoneId(zoneName: string): Promise<string>
  attachDomain(bucket: string, domain: string, zoneId: string): Promise<void>
  /** null when the object does not exist. */
  getObject(bucket: string, key: string): Promise<Uint8Array | null>
  putObject(bucket: string, key: string, body: Uint8Array, headers: { contentType: string; cacheControl: string }): Promise<void>
}

export type SyncDeps = {
  client: R2Client
  files: { key: string; bytes: Uint8Array }[]
  bucket: string
  domain: string
  zone: string
  dryRun?: boolean
  force?: boolean
  log?: (line: string) => void
}

export type SyncResult = {
  createdBucket: boolean
  attachedDomain: boolean
  uploaded: string[]
  unchanged: string[]
  orphaned: string[]
}

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

// Anything unreadable is treated as absent: the worst outcome is one redundant upload of every file,
// which is safe, whereas trusting a damaged manifest could skip a file that changed.
function parseManifest(bytes: Uint8Array | null): Manifest | null {
  if (!bytes) return null
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes))
    if (typeof parsed !== 'object' || parsed === null) return null
    const { version, files } = parsed as { version?: unknown; files?: unknown }
    if (version !== 1 || typeof files !== 'object' || files === null || Array.isArray(files)) return null
    if (!Object.values(files).every((v) => typeof v === 'string')) return null
    return { version: 1, files: files as Record<string, string> }
  } catch {
    return null
  }
}

export async function syncAssets(deps: SyncDeps): Promise<SyncResult> {
  const { client, files, bucket, domain, zone, dryRun = false, force = false } = deps
  const log = deps.log ?? console.log
  const prefix = dryRun ? '[dry-run] would: ' : ''

  // Validate every key before the first write (dry run included): a bad extension must fail the
  // whole run up front, not after earlier files are uploaded and the manifest is never written.
  for (const f of files) {
    if (f.key === MANIFEST_KEY) throw new Error(`${MANIFEST_KEY} is reserved for the sync manifest; rename the local file`)
    contentTypeFor(f.key)
  }

  let createdBucket = false
  if (!(await client.bucketExists(bucket))) {
    log(`${prefix}create bucket ${bucket}`)
    if (!dryRun) await client.createBucket(bucket)
    createdBucket = true
  }

  // A bucket that does not exist yet cannot have domains, and listing them would 404.
  let attachedDomain = false
  const domains = createdBucket && dryRun ? [] : await client.customDomains(bucket)
  if (!domains.includes(domain)) {
    log(`${prefix}attach custom domain ${domain} (zone ${zone})`)
    if (!dryRun) await client.attachDomain(bucket, domain, await client.zoneId(zone))
    attachedDomain = true
  }

  const rawManifest = createdBucket && dryRun ? null : await client.getObject(bucket, MANIFEST_KEY)
  const manifest = parseManifest(rawManifest)
  if (rawManifest && !manifest) log('manifest is unreadable or has an unknown version; treating every file as changed')

  const hashes = files.map((f) => ({ key: f.key, sha256: sha256(f.bytes) }))
  const plan = planAssetSync(hashes, manifest, { force })
  const result: SyncResult = { createdBucket, attachedDomain, uploaded: plan.upload, unchanged: plan.unchanged, orphaned: plan.orphaned }

  const summary = () => {
    for (const key of plan.unchanged) log(`unchanged ${key}`)
    if (plan.orphaned.length > 0) {
      log(`orphaned (in the bucket, no longer in assets/; never deleted, remove by hand if unwanted): ${plan.orphaned.join(', ')}`)
    }
  }

  if (dryRun) {
    for (const key of plan.upload) log(`${prefix}upload ${key}`)
    summary()
    return result
  }

  const byKey = new Map(files.map((f) => [f.key, f.bytes]))
  for (const key of plan.upload) {
    await client.putObject(bucket, key, byKey.get(key)!, { contentType: contentTypeFor(key), cacheControl: CACHE_CONTROL })
    log(`uploaded ${key}`)
  }
  summary()

  // Last, so a failed upload leaves the old manifest and the next run retries it.
  if (plan.upload.length > 0 || !manifest) {
    const merged: Manifest = { version: 1, files: {} }
    for (const orphan of plan.orphaned) merged.files[orphan] = manifest!.files[orphan]!
    for (const h of hashes) merged.files[h.key] = h.sha256
    const sortedFiles = Object.fromEntries(Object.entries(merged.files).sort(([a], [b]) => (a < b ? -1 : 1)))
    const body = new TextEncoder().encode(JSON.stringify({ version: 1, files: sortedFiles }, null, 2) + '\n')
    await client.putObject(bucket, MANIFEST_KEY, body, { contentType: 'application/json', cacheControl: 'no-cache' })
    log(`wrote ${MANIFEST_KEY}`)
  }
  log(`done: ${plan.upload.length} uploaded, ${plan.unchanged.length} unchanged, ${plan.orphaned.length} orphaned`)
  return result
}
