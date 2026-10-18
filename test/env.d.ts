// Test-only bindings, injected by vitest.config.ts. Not part of the deployed Worker.
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[]
  }
}
