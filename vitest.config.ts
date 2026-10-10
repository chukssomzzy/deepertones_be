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

  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: { bindings: { TEST_MIGRATIONS: migrations } },
      }),
    ],
    test: {
      projects: [
        { extends: true, test: { name: 'unit', include: ['src/**/*.test.ts'] } },
        {
          extends: true,
          test: {
            name: 'integration',
            include: ['test/integration/**/*.test.ts'],
            setupFiles: ['./test/integration/setup.ts'],
          },
        },
      ],
    },
  }
})
