import { firstValueFrom } from 'rxjs'
import { requestJson$ } from '../../src/lib/http'
import type { R2Client } from './sync'

const API = 'https://api.cloudflare.com/client/v4'
const TIMEOUT_MS = 30_000

type CfEnvelope = { errors?: { code?: number; message?: string }[]; result?: unknown }

export function createCloudflareR2Client(opts: { accountId: string; apiToken: string }): R2Client {
  const account = `/accounts/${encodeURIComponent(opts.accountId)}`
  // Each key segment is encoded on its own so the `/` separators survive.
  const encodeKey = (key: string) => key.split('/').map(encodeURIComponent).join('/')

  async function call(method: string, path: string, init: { body?: BodyInit; headers?: Record<string, string>; allow404?: boolean } = {}) {
    const res = await firstValueFrom(
      requestJson$(`${API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${opts.apiToken}`, ...init.headers },
        body: init.body,
        timeoutMs: TIMEOUT_MS,
      }),
    )
    if (res.ok) return res
    if (res.status === 404 && init.allow404) return null
    const errors = ((res.body as CfEnvelope | null)?.errors ?? [])
      .map((e) => `${e.code ?? '?'}: ${e.message ?? ''}`)
      .join('; ')
    // Never include request headers here: they carry the token.
    throw new Error(`Cloudflare API ${method} ${path} failed with ${res.status}${errors ? ` (${errors})` : ''}`)
  }

  const json = (value: unknown) => ({ body: JSON.stringify(value), headers: { 'content-type': 'application/json' } })
  const result = (res: { body: unknown }) => (res.body as CfEnvelope).result

  return {
    async bucketExists(bucket) {
      return (await call('GET', `${account}/r2/buckets/${encodeURIComponent(bucket)}`, { allow404: true })) !== null
    },
    async createBucket(bucket) {
      await call('POST', `${account}/r2/buckets`, json({ name: bucket }))
    },
    async customDomains(bucket) {
      const res = await call('GET', `${account}/r2/buckets/${encodeURIComponent(bucket)}/domains/custom`)
      const domains = (result(res!) as { domains?: { domain: string }[] } | undefined)?.domains ?? []
      return domains.map((d) => d.domain)
    },
    async zoneId(zoneName) {
      const res = await call('GET', `/zones?name=${encodeURIComponent(zoneName)}`)
      const id = (result(res!) as { id: string }[] | undefined)?.[0]?.id
      if (!id) throw new Error(`No Cloudflare zone named ${zoneName} is visible to this API token`)
      return id
    },
    async attachDomain(bucket, domain, zoneId) {
      try {
        await call('POST', `${account}/r2/buckets/${encodeURIComponent(bucket)}/domains/custom`, json({ domain, zoneId, enabled: true, minTLS: '1.2' }))
      } catch (error) {
        const hint = 'Attaching a custom domain may need the API token to have zone-level permission for the domain\'s zone, in addition to R2 edit.'
        throw new Error(`${(error as Error).message}. ${hint}`, { cause: error })
      }
    },
    // Limitation: requestJson$ hands back parsed JSON (or text), never raw bytes, so this only
    // round-trips text. The only object ever read is the JSON manifest, which is why that is enough.
    async getObject(bucket, key) {
      const res = await call('GET', `${account}/r2/buckets/${encodeURIComponent(bucket)}/objects/${encodeKey(key)}`, { allow404: true })
      if (!res) return null
      const text = typeof res.body === 'string' ? res.body : JSON.stringify(res.body)
      return new TextEncoder().encode(text)
    },
    async putObject(bucket, key, body, headers) {
      await call('PUT', `${account}/r2/buckets/${encodeURIComponent(bucket)}/objects/${encodeKey(key)}`, {
        body: body as BodyInit,
        headers: { 'content-type': headers.contentType, 'cache-control': headers.cacheControl },
      })
    },
  }
}
