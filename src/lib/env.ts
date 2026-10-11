import type { RequestIdVariables } from 'hono/request-id'

/**
 * Bindings and variables every request has. Lives apart from factory.ts (whose AppEnv adds the
 * Container) so errors.ts, which services import, need not import the container.
 */
export type BaseEnv = { Bindings: CloudflareBindings; Variables: RequestIdVariables }
