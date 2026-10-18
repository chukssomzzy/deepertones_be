// Test-only bindings, injected by vitest.config.ts. Not part of the deployed Worker.
declare namespace Cloudflare {
  interface Env {
    TEST_MIGRATIONS: import('cloudflare:test').D1Migration[]
  }
}

// A file imported as its own text (`import source from './x.ts?raw'`), which vite supports; used to check what a source file says about itself.
declare module '*?raw' {
  const text: string
  export default text
}
