import { z } from '@hono/zod-openapi'

export const HealthResponse = z
  .object({
    status: z.enum(['ok', 'degraded']).openapi({ description: '`degraded` when any check is down.' }),
    environment: z.string().openapi({ example: 'staging' }),
    checks: z.object({
      database: z.enum(['ok', 'down']),
    }),
  })
  .openapi('HealthResponse')
