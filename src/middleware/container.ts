import { buildContainer } from '../container'
import { factory } from '../lib/factory'

/** Puts this request's services on `c.var.services`. Construction is lazy, so this is cheap. */
export const container = factory.createMiddleware(async (c, next) => {
  c.set('services', buildContainer(c.env))
  await next()
})
