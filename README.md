# deepertones-be

Serverless API for deepertones: [Hono](https://hono.dev) on Cloudflare Workers.

## Commands

| Command                       | What it does                                                          |
| ----------------------------- | --------------------------------------------------------------------- |
| `npm run dev`                 | Local server on http://localhost:8787 (real workerd runtime)          |
| `npm test`                    | Both test tiers                                                       |
| `npm run test:unit`           | Unit tests (`src/**/*.test.ts`): one module in isolation, with fakes  |
| `npm run test:integration`    | Integration tests (`test/integration`): real local D1, whole Worker   |
| `npm run typecheck`           | `tsc` over src and tests                                              |
| `npm run lint:arch`           | Architecture rules (dependency-cruiser); see docs/architecture.md     |
| `npm run openapi`             | Regenerate `docs/openapi.json` from the routes (commit the result)    |
| `npm run openapi:lint`        | Lint `docs/openapi.json` (Redocly; exceptions in `redocly.yaml`)      |
| `npm run db:generate`         | Generate a SQL migration from changed `*.table.ts` files              |
| `npm run db:migrate:local`    | Apply migrations to the local D1 used by `npm run dev`                |
| `npm run cf-typegen`          | Regenerate `worker-configuration.d.ts` after editing bindings         |
| `npm run deploy:staging`      | Deploy the staging Worker (CI does this; see Deploying)               |
| `npm run deploy:production`   | Deploy the production Worker (CI does this; see Deploying)            |

## Architecture

Thin routes → services (business logic) → repositories (D1 via Drizzle), with every third party
behind a provider interface. **Read [docs/architecture.md](docs/architecture.md) before adding a
feature**: it has the layout, the reasons behind each rule, and the steps for a new module.
`src/modules/health` is the reference implementation.

## API docs

Swagger UI is at **`/docs`** and the raw spec at **`/openapi.json`**, locally
(http://localhost:8787/docs) and on staging. Production 404s both: set `DOCS_ENABLED` to `"true"`
in `env.production` of `wrangler.jsonc` to publish them there.

The spec is generated from the route definitions themselves (`defineRoute` in each
`*.routes.ts`), so it cannot drift from the code. A committed copy lives in
[`docs/openapi.json`](docs/openapi.json): read it without running the API, generate a client from
it, or review API changes as a diff in each PR. CI fails if it is stale; after changing a route, run
`npm run openapi` and commit the result.

## Response shape

Every JSON response has the same outer shape. A success:

```json
{ "success": true, "status": 200, "message": "Health check complete", "data": { ... } }
```

An error (every non-2xx):

```json
{
  "success": false,
  "status": 400,
  "message": "Invalid json",
  "error": { "code": "VALIDATION_FAILED", "details": [{ "path": "name", "message": "Required" }], "requestId": "..." }
}
```

Two rules hold for every response: `success` is `true` exactly when the HTTP status is 2xx, and the
body's `status` always equals the HTTP status. The one exception is `204`, which has no body.

Lists will return an array in `data`, with pagination in an optional top-level `meta` (e.g.
`meta: { nextCursor }`). That is not built yet; the first list endpoint decides it.

Branch on `success` and TypeScript narrows the rest:

```ts
const body = await res.json()
if (body.success) body.data
else body.error.code
```

## Typed client for the frontend

`src/index.ts` exports `AppType`. Get it into the frontend however the repos are linked
(workspace package, git submodule, or a published types package), then:

```ts
import { hc } from 'hono/client'

const api = hc<AppType>('https://api.deepertones.com') // staging: https://api.staging.deepertones.com
const res = await api.health.$get() // fully typed request + response

const body = await res.json()
if (body.success) console.log(body.data)
else console.error(body.error.code) // see "Response shape"
```

## Config & secrets

- Non-secret config lives in `vars` in `wrangler.jsonc`.
- Local secrets go in `.dev.vars` (see `.dev.vars.example`); production secrets via `npx wrangler secret put NAME`.
- After changing either, run `npm run cf-typegen` so `c.env` stays typed.

## Deploying

A merge is a deploy; nobody deploys by hand.

| Branch    | Deploys to                                                                   | Trigger                           | Workflow                               |
| --------- | ---------------------------------------------------------------------------- | --------------------------------- | -------------------------------------- |
| `staging` | https://api.staging.deepertones.com (Worker `deepertones-be-staging`)         | push (merge) to `staging`         | `.github/workflows/deploy-staging.yml` |
| `main`    | https://api.deepertones.com (Worker `deepertones-be-production`)              | merge of the release PR on `main` | `.github/workflows/release.yml`        |

Each address is a Workers Custom Domain (`routes` in `wrangler.jsonc`): the deploy itself creates
the DNS record and certificate in the `deepertones.com` zone, so there is no DNS to set up by hand.
A Custom Domain cannot be created over an existing CNAME for the same hostname; delete it first.
`*.workers.dev` and preview URLs are switched off, so each API has exactly one public address.

There are only two long-lived branches. "production" is the name of the deploy target
(the GitHub environment and `env.production` in `wrangler.jsonc`), never a branch.

Every pull request and every push to `staging`/`main` runs `.github/workflows/tests.yml`:
unit, integration, typecheck, architecture rules, the API contract (`docs/openapi.json` is current
and valid), and a dry-run build of both environments.
None of these take a secret. Tests currently run alongside the deploy, not before it, so a red test does not stop a deploy.

Production goes through a release: merging `staging` into `main` makes release-please open a
version-bump pull request. Merging *that* tags the release, deploys the tag, and merges `main`
back into `staging`. release-please reads [Conventional Commits](https://www.conventionalcommits.org)
(`feat:`, `fix:`, `feat!:`) to choose the version and write the changelog.

The back-merge pushes to `staging` with the workflow's own `GITHUB_TOKEN`. If `staging` is ever a
protected branch, that push is what breaks; give the back-merge job `RELEASE_PLEASE_TOKEN`
instead of removing it.

In `wrangler.jsonc`, the top level is local development. Deployed Workers come only from
`env.staging` and `env.production` (named `deepertones-be-staging` / `deepertones-be-production`).
Env blocks do not inherit `vars` or bindings, so add each one to both.

Each deploy applies D1 migrations first, then deploys the Worker: the schema leads the code. A
migration that drops a column or table must therefore ship one release *after* the code that
stopped using it.

### Before the first deploy

1. Create two GitHub environments, `staging` and `production` (Settings → Environments).
   Add a required reviewer to `production` if you want a manual gate.
2. Add repository secrets (Settings → Secrets and variables → Actions):

   | Secret                  | What it is                                                                                         |
   | ----------------------- | -------------------------------------------------------------------------------------------------- |
   | `CLOUDFLARE_API_TOKEN`  | Cloudflare API token from the "Edit Cloudflare Workers" template, **plus D1 Edit** (the template lacks it; migrations fail with 7403 without it). |
   | `CLOUDFLARE_ACCOUNT_ID` | The Cloudflare account the Workers live in.                                                        |
   | `RELEASE_PLEASE_TOKEN`  | Fine-grained PAT on this repo with Contents and Pull requests: read and write.                    |

3. Set `CORS_ORIGINS` for staging and production in `wrangler.jsonc` to the frontend origins
   (empty means no browser may call the API).
4. Run "Deploy staging" once by hand (Actions → Deploy staging → Run workflow) to check the credentials.

## Troubleshooting

**`Cannot find native binding` from vitest (rolldown)**: npm bug
[#4828](https://github.com/npm/cli/issues/4828) drops platform-specific optional dependencies
from `package-lock.json`, most often right after `npm install <package>`. CI's `npm ci` then
fails the same way. The fix is a clean regeneration, not `npm audit fix`:

```sh
rm -rf node_modules package-lock.json && npm install
```

**dependency-cruiser reports `0 modules`**: it needs TypeScript ≤ 6 (see docs/architecture.md).
