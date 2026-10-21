import { describe, expect, it } from 'vitest'
import { app } from '../../src/app'
import { errorOf, fetchWorker, freshIp, ORIGIN } from './admin.catalog.support'

// Every route under /api/v1/admin, found from the app itself and not from a list written here, refuses a caller with no token. A route added to
// the admin group without adminToken() in its middleware fails here, whatever it does.

// A route is listed once for each handler and middleware on it, so the walk takes each method and path once.
const adminRoutes = [...new Map(app.routes.filter((route) => route.path.startsWith('/api/v1/admin/') && route.method !== 'ALL').map((route) => [`${route.method} ${route.path}`, route])).values()]

describe('every /api/v1/admin route', () => {
  it('is found: the walk is not an empty one', () => {
    expect(adminRoutes.map((route) => `${route.method} ${route.path}`).sort()).toEqual(expect.arrayContaining(['GET /api/v1/admin/catalog/export', 'POST /api/v1/admin/catalog/import']))
  })

  it.each(adminRoutes.map((route) => [`${route.method} ${route.path}`, route.method, route.path] as const))('answers 401 ADMIN_TOKEN_INVALID to %s with no admin token', async (_, method, path) => {
    const res = await fetchWorker(`${ORIGIN}${path}`, { method, headers: { 'cf-connecting-ip': freshIp() } })

    expect(res.status).toBe(401)
    expect((await errorOf(res)).code).toBe('ADMIN_TOKEN_INVALID')
  })

  it('answers 404 to a path under /api/v1/admin that no route serves, so nothing there is open by default', async () => {
    const res = await fetchWorker(`${ORIGIN}/api/v1/admin/does-not-exist`, { headers: { 'cf-connecting-ip': freshIp() } })

    expect(res.status).toBe(404)
  })
})
