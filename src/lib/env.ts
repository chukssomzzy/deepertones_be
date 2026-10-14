import type { RequestIdVariables } from 'hono/request-id'

/**
 * Bindings and variables every request has. Lives apart from factory.ts (whose AppEnv adds the
 * Container) so errors.ts, which services import, need not import the container.
 */
export type BaseEnv = { Bindings: CloudflareBindings; Variables: RequestIdVariables }

/**
 * WHATSAPP_ACCESS_TOKEN is a secret that is NOT in `secrets.required` (WhatsApp is off until it is
 * added to OTP_CHANNELS), so `wrangler types` no longer emits it. Declared here, optional, so the
 * container and tests can still read it; the WhatsApp adapter fails loudly if it is enabled without one.
 * When whatsapp joins OTP_CHANNELS, make it required again AND delete this declaration, or the
 * regenerated required type will conflict with it.
 */
declare global {
  interface CloudflareBindings {
    WHATSAPP_ACCESS_TOKEN?: string
  }
  namespace Cloudflare {
    interface Env {
      WHATSAPP_ACCESS_TOKEN?: string
    }
  }
}
