import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

// Both tiers run inside workerd (the real Workers runtime) with the bindings from wrangler.jsonc.
// What separates them is scope, not runtime:
//   unit         one module in isolation, colocated as src/**/*.test.ts (services with fakes, lib helpers)
//   integration  real local bindings: repositories against D1, the whole Worker through its entrypoint
// Neither may reach a real Cloudflare account or third-party service: no test needs a secret.
export default defineConfig(async () => {
  // Read in Node, handed to workerd as a binding, applied by test/integration/setup.ts.
  const migrations = await readD1Migrations('./migrations')

  // Only the two Workers tiers get the Workers pool. `scripts` is plain Node, so the plugin
  // must not be a root-level plugin (that would apply it to every project).
  const workers = () =>
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // Test-only values, so no test needs a real secret.
      miniflare: { bindings: { TEST_MIGRATIONS: migrations, OTP_PEPPER: 'test-pepper', JWT_SECRET: 'test-jwt-secret', DEVICE_ID_KEY: 'test-device-id-key', ZEPTOMAIL_API_KEY: 'test-key', WHATSAPP_ACCESS_TOKEN: 'test-token', ANTHROPIC_API_KEY: 'test-anthropic-key', EXPO_ACCESS_TOKEN: 'test-expo-token', PERFECT_CORP_API_KEY: 'test-perfect-corp-key', PERFECT_CORP_WEBHOOK_SECRET: 'whsec_' + btoa('test-perfect-corp-webhook-secret!') } },
    })

  return {
    test: {
      projects: [
        { plugins: [workers()], test: { name: 'unit', include: ['src/**/*.test.ts'] } },
        {
          plugins: [workers()],
          test: {
            name: 'integration',
            include: ['test/integration/**/*.test.ts'],
            // A parallel full run hangs at the end in the workers pool after every test has passed; one file at a time is clean.
            fileParallelism: false,
            setupFiles: ['./test/integration/setup.ts'],
          },
        },
        // Node-side tooling (CI scripts): plain Node, no Workers pool.
        { test: { name: 'scripts', include: ['scripts/**/*.test.ts'], environment: 'node' } },
      ],
    },
  }
})
