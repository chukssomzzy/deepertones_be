import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { createCloudflareR2Client } from './assets/cloudflare-r2-client'
import { ASSET_BUCKET, ASSET_DOMAIN, ASSET_ZONE } from './assets/config'
import { syncAssets } from './assets/sync'

const ASSETS_DIR = path.resolve(import.meta.dirname, '../assets')

async function readAssets(dir: string, prefix = ''): Promise<{ key: string; bytes: Uint8Array }[]> {
  const out: { key: string; bytes: Uint8Array }[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    // Dotfiles (.DS_Store and friends) are never assets.
    if (entry.name.startsWith('.')) continue
    const key = prefix + entry.name
    if (entry.isDirectory()) out.push(...(await readAssets(path.join(dir, entry.name), `${key}/`)))
    else if (entry.isFile()) out.push({ key, bytes: new Uint8Array(await readFile(path.join(dir, entry.name))) })
  }
  return out
}

async function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const force = args.includes('--force')
  const unknown = args.filter((a) => a !== '--dry-run' && a !== '--force')
  if (unknown.length > 0) throw new Error(`Unknown argument(s): ${unknown.join(' ')}. Supported: --dry-run, --force`)

  const apiToken = process.env.CLOUDFLARE_API_TOKEN
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID
  const missing = [!apiToken && 'CLOUDFLARE_API_TOKEN', !accountId && 'CLOUDFLARE_ACCOUNT_ID'].filter(Boolean)
  if (!apiToken || !accountId) throw new Error(`Missing environment variable(s): ${missing.join(', ')}`)

  const files = await readAssets(ASSETS_DIR)
  await syncAssets({
    client: createCloudflareR2Client({ accountId, apiToken }),
    files,
    bucket: ASSET_BUCKET,
    domain: ASSET_DOMAIN,
    zone: ASSET_ZONE,
    dryRun,
    force,
  })
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
