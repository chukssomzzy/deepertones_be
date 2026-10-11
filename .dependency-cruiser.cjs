// Architecture rules, checked by `npm run lint:arch` locally and the Architecture job in CI.
// docs/architecture.md explains the layering these rules protect.
//
// Paths are relative to the repo root. Files that only exist for tests
// (*.test.ts, *.fake.ts, *.contract.ts) are exempt where noted: they wire real and fake
// pieces together on purpose.
const TEST_ONLY = '\\.(test|fake|contract)\\.ts$'

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular imports make initialisation order fragile. Extract the shared piece into its own file.',
      from: {},
      to: { circular: true },
    },

    // --- Services: business logic only ---------------------------------------------------
    {
      name: 'service-no-packages',
      severity: 'error',
      comment:
        'Services never import a package (hono, drizzle-orm, vendor SDKs). They depend on ' +
        'repository/provider interfaces and get them through the constructor. Pure utilities can be allowlisted here.',
      from: { path: '\\.service\\.ts$' },
      to: { dependencyTypes: ['npm', 'npm-dev', 'npm-optional', 'npm-peer', 'npm-no-pkg', 'npm-unknown'], pathNot: '^node_modules/zod/' },
    },
    {
      name: 'service-repository-types-only',
      severity: 'error',
      comment:
        'A service may import its OWN module\'s repository file for its type only ' +
        '(`import type`). The concrete class is wired in src/container.ts.',
      from: { path: '\\.service\\.ts$' },
      to: { path: '\\.repository\\.ts$', dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'service-no-foreign-repository',
      severity: 'error',
      comment:
        'Another module\'s repository is private to it. Depend on that module\'s service instead, ' +
        'so its business rules cannot be bypassed.',
      from: { path: '^src/modules/([^/]+)/.+\\.service\\.ts$' },
      to: { path: '^src/modules/[^/]+/.+\\.repository\\.ts$', pathNot: '^src/modules/$1/' },
    },
    {
      name: 'service-no-concrete-provider',
      severity: 'error',
      comment: 'Services depend on the provider interface (*.provider.ts), never on a vendor adapter.',
      from: { path: '\\.service\\.ts$' },
      to: { path: '^src/providers/', pathNot: '\\.provider\\.ts$' },
    },

    // --- Data access stays in repositories --------------------------------------------------
    {
      name: 'db-only-in-repositories',
      severity: 'error',
      comment:
        'Only repositories (and the container that builds them) touch drizzle-orm, tables or the db client. ' +
        '*.types.ts may `import type` a table to infer row types.',
      from: { pathNot: ['\\.repository\\.ts$', '\\.table\\.ts$', '^src/lib/db\\.ts$', '^src/container\\.ts$', TEST_ONLY] },
      to: { path: ['^node_modules/drizzle-orm/', '\\.table\\.ts$', '^src/lib/db\\.ts$'], dependencyTypesNot: ['type-only'] },
    },
    {
      name: 'routes-no-repositories',
      severity: 'error',
      comment: 'Routes are thin: validate, call one service method, present. They never reach past the service.',
      from: { path: '\\.routes\\.ts$' },
      to: { path: ['\\.repository\\.ts$', '^src/providers/', '^src/container\\.ts$'] },
    },
    {
      name: 'routes-must-be-documented',
      severity: 'error',
      comment:
        'Every endpoint is in the OpenAPI spec. Route modules are built with openapiApp() and defineRoute() ' +
        'from src/lib/openapi.ts, never a plain Hono app (`hono`, `hono/tiny`, `hono/quick`, or ' +
        'factory.createApp()), so an undocumented route cannot be written. Hono helpers (hono/cookie, ' +
        'hono/streaming, ...) and type-only imports (e.g. AppEnv) are fine.',
      from: { path: '\\.routes\\.ts$' },
      to: {
        // Only the entry points that construct an app: hono's main export and its presets.
        path: ['^node_modules/hono/dist/(types/)?(index|preset/[^/]+)\\.(d\\.ts|js)$', '^src/lib/factory\\.ts$'],
        dependencyTypesNot: ['type-only'],
      },
    },

    // --- Wiring --------------------------------------------------------------------------
    {
      name: 'concrete-classes-only-in-container',
      severity: 'error',
      comment:
        'src/container.ts is the composition root: the only production file that imports concrete ' +
        'repository or provider classes. Everyone else imports types only.',
      from: { pathNot: ['^src/container\\.ts$', TEST_ONLY] },
      to: {
        path: ['\\.repository\\.ts$', '^src/providers/.+(?<!\\.provider)\\.ts$'],
        dependencyTypesNot: ['type-only'],
      },
    },

    {
      name: 'http-only-in-providers',
      severity: 'error',
      comment:
        'Every outside call goes through a provider, so services, repositories and routes never make HTTP ' +
        'calls. src/lib/http.ts is the HTTP client for provider adapters.',
      from: { pathNot: ['^src/providers/', TEST_ONLY] },
      to: { path: '^src/lib/http\\.ts$' },
    },

    // --- Request context -------------------------------------------------------------------
    {
      name: 'context-only-in-services',
      severity: 'error',
      comment:
        'Only services read the request context (currentActor/requireUser). Repositories and providers get ' +
        'what they need as arguments. The middleware that creates the context is the one exception; ' +
        'queue/cron entrypoints that call runAs() join this allowlist when they exist.',
      from: { pathNot: ['\\.service\\.ts$', '^src/middleware/request-context\\.ts$', '^src/lib/context\\.ts$', TEST_ONLY] },
      to: { path: '^src/lib/context\\.ts$' },
    },

    // --- Test code never ships -------------------------------------------------------------
    {
      name: 'no-test-code-in-production',
      severity: 'error',
      comment: 'Fakes, contracts and test libraries are for tests only.',
      from: { pathNot: TEST_ONLY },
      to: { path: ['\\.fake\\.ts$', '\\.contract\\.ts$', '^node_modules/vitest/', '^node_modules/@cloudflare/vitest-plugin/'] },
    },
  ],

  options: {
    doNotFollow: { path: 'node_modules' },
    // Needed to see `import type` edges at all, which several rules above depend on.
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      mainFields: ['module', 'main', 'types', 'typings'],
    },
  },
}
