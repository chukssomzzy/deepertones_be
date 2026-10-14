# deepertones-be

Serverless API for deepertones: [Hono](https://hono.dev) on Cloudflare Workers.

## Commands

| Command                       | What it does                                                          |
| ----------------------------- | --------------------------------------------------------------------- |
| `npm run dev`                 | Local server on http://localhost:8787 (real workerd runtime)          |
| `npm test`                    | All test tiers (unit, integration, scripts)                           |
| `npm run test:unit`           | Unit tests (`src/**/*.test.ts`): one module in isolation, with fakes  |
| `npm run test:integration`    | Integration tests (`test/integration`): real local D1, whole Worker   |
| `npm run test:scripts`        | Tooling tests (`scripts/**`): plain Node, Cloudflare API faked        |
| `npm run typecheck`           | `tsc` over src and tests                                              |
| `npm run lint:arch`           | Architecture rules (dependency-cruiser); see docs/architecture.md     |
| `npm run openapi`             | Regenerate `docs/openapi.json` from the routes (commit the result)    |
| `npm run openapi:lint`        | Lint `docs/openapi.json` (Redocly; exceptions in `redocly.yaml`)      |
| `npm run db:generate`         | Generate a SQL migration from changed `*.table.ts` files              |
| `npm run db:migrate:local`    | Apply migrations to the local D1 used by `npm run dev`                |
| `npm run cf-typegen`          | Regenerate `worker-configuration.d.ts` after editing bindings         |
| `npm run assets:sync`         | Sync `assets/` to R2 (CI does this; `-- --dry-run` previews)          |
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

## Auth for the app

Everyone is a user: a guest (`status: "anonymous"`) tied to the device, who becomes `verified` by proving an email.
Every success response is `{ success, status, message, data }`; `data` below is that `data`.

1. **At app start** call `POST /auth/anonymous` with `{ deviceId, platform: "ios" | "android" }`. The device id is
   Android's `getAndroidId`, or on iOS a UUID you generate once and keep in the Keychain (`expo-secure-store`). The
   same device id gets the same guest. You get `{ tokens, user }`.
2. **Store the tokens in `expo-secure-store`.** Send `Authorization: Bearer <accessToken>` on every call. The access
   token lives 15 minutes, the refresh token 60 days (each refresh restarts the 60 days).
3. **On a 401 with `TOKEN_EXPIRED`** call `POST /auth/refresh` with `{ refreshToken }`, store the new pair and retry.
   **On `TOKEN_INVALID`** (from any call, including refresh) throw the stored tokens away and go back to step 1.
4. **To sign in**, with the guest's token: `POST /auth/otp/send` with `{ channel: "email", address }`, then
   `POST /auth/otp/verify` with `{ channel, address, code }`. Verify returns a new session: store it, replacing
   the old one. If the address already belongs to an account you are signed in as that account, and the guest is left
   behind. `GET /me` returns the current user.
5. **To log out** call `POST /auth/logout` with `{ deviceId, platform }` and the bearer token. It signs the user out
   on every device (their other devices' refresh then fails with `TOKEN_INVALID`) and returns a fresh guest session
   to store.

`deviceId` must be at least 16 characters (a UUID is fine), and a verification code is exactly 6 digits; anything
else is a 400 `VALIDATION_FAILED` and costs no attempt.

Error codes to handle (in `error.code`):

- `AUTH_REQUIRED` (401): no token. `TOKEN_EXPIRED` (401): refresh. `TOKEN_INVALID` (401): start over from step 1.
- `USER_NOT_FOUND` (404, on `/me` and logout): the account is gone; re-bootstrap.
- `RATE_LIMITED` (429): wait `Retry-After` seconds.
- `ACCOUNT_LINKING_UNAVAILABLE` (409): a verified user tried to add a different, unowned email. Not supported yet;
  no code is sent or used. `NOT_A_GUEST` (409) should now be unreachable in practice.
- `VALIDATION_FAILED` (400), and from the code flow `INVALID_EMAIL`, `OTP_CHANNEL_UNAVAILABLE`, `OTP_COOLDOWN` (429)
  and the verify errors listed in `docs/architecture.md` (OTP section).

Rate limits (per minute, per IP unless noted): bootstrap and logout share 10, refresh 30, verify 10, send 3 (and 3 per user).

## Config & secrets

- Non-secret config lives in `vars` in `wrangler.jsonc`.
- Secrets live in three gitignored files. `.dev.vars` is for `wrangler dev` (copy `.dev.vars.example`).
  `.dev.vars.staging` and `.dev.vars.production` are for the deployed Workers (copy
  `.dev.vars.deployed.example`). Note `wrangler dev --env staging` would load `.dev.vars.staging`, i.e. real
  staging credentials.
- `npm run secrets:push -- --env staging` reports what it would send to that Worker (names only, never values)
  and sends nothing; add `--apply` to send. Blank entries are left alone, names that are `vars` in
  `wrangler.jsonc` are skipped, unknown names and an `OTP_PEPPER` shared between the two files are errors.
  The list of secrets and why is in `scripts/secrets/plan.ts`. `npx wrangler secret put NAME --env staging` still
  works as a one-off alternative.
- Required secrets: `ZEPTOMAIL_API_KEY`, `OTP_PEPPER`, `JWT_SECRET` and `DEVICE_ID_KEY`. All are listed in `secrets.required`, so a deploy fails until they are set on that environment (push `JWT_SECRET` and `DEVICE_ID_KEY` to staging and production before this lands). `JWT_SECRET` signs access/refresh tokens and must differ per environment; to rotate it, move the old value to the optional `JWT_SECRET_PREVIOUS` (accepted for verification only). `DEVICE_ID_KEY` must differ per environment and must NEVER be rotated: it would orphan every device's guest. Generate each with `openssl rand -hex 32`. ZeptoMail setup is in [ZeptoMail setup](#zeptomail-setup). `WHATSAPP_ACCESS_TOKEN` is only needed once `whatsapp` is in `OTP_CHANNELS` (see [WhatsApp OTP setup](#whatsapp-otp-setup)).
- After changing either, run `npm run cf-typegen` so `c.env` stays typed.

## ZeptoMail setup

Sign-in codes go out by email through ZeptoMail (Zoho). The code is in `src/modules/otp` and
`src/providers/email`. Local dev, staging and production all send real email, so each one needs
the setup below. Tests never call ZeptoMail and need no secrets.

1. Create a ZeptoMail account and a **Mail Agent**.
2. Add and verify the sending domain `mail.deepertones.com`. ZeptoMail shows a DKIM TXT record and a
   bounce (return-path) CNAME record; add both in Cloudflare DNS for `deepertones.com`, set to
   **DNS only** (not proxied).
3. New accounts are reviewed by Zoho before they can send without limits (until then there is a
   trial limit), so start this early.
4. Copy the API URL (Mail Agent → Setup Info → API) into `ZEPTOMAIL_API_URL` in `wrangler.jsonc`:
   in the top level, in `env.staging` and in `env.production`. The host depends on the data centre
   the account lives in, and env blocks do not inherit `vars`.
5. Create the "Send Mail token" (Mail Agent → Setup Info → API) and set it as `ZEPTOMAIL_API_KEY`:
   - Locally, in `.dev.vars` (copy `.dev.vars.example`; also set `OTP_PEPPER` to the output of
     `openssl rand -hex 32`).
   - For each deployed environment, fill in `.dev.vars.staging` / `.dev.vars.production` (copied from
     `.dev.vars.deployed.example`), then:

     ```sh
     npm run secrets:push -- --env staging            # report only
     npm run secrets:push -- --env staging --apply
     npm run secrets:push -- --env production --apply
     ```

     One-off alternative: `npx wrangler secret put ZEPTOMAIL_API_KEY --env staging`.

`OTP_CHANNELS` in `wrangler.jsonc` lists the channels people can sign in with; it is `email` today.
Use a **different** `OTP_PEPPER` in each environment, and never change a pepper while codes are
live (it invalidates outstanding codes; harmless once 10 minutes have passed).

## WhatsApp OTP setup

WhatsApp is **optional and off** until Meta approves the authentication template: `OTP_CHANNELS`
is `email`, and a WhatsApp send is refused with `OTP_CHANNEL_UNAVAILABLE`. To turn it on, finish
the steps below, then add `whatsapp` to `OTP_CHANNELS` (`"email,whatsapp"`) in all three
`wrangler.jsonc` blocks and make `WHATSAPP_ACCESS_TOKEN` a required secret again (and delete its optional declaration in `src/lib/env.ts`, or the regenerated required type will conflict with it).

Codes can be sent over WhatsApp through the Meta WhatsApp Cloud API, using an approved
authentication template. The code is in `src/modules/otp` and `src/providers/otp-delivery`. Once
enabled, local dev, staging and production send real messages. Tests never call Meta and need no
secrets.

> The send endpoint is rate limited per IP and per user (see "Auth for the app"); the per-number cooldown and cap are check-then-act and can be raced, so keep those limits.

1. Create or verify a Meta Business account **registered in Nigeria**. Users are in Nigeria, and a
   Nigerian business pays the cheaper local authentication rate.
2. Create a Meta app with the **WhatsApp** product, and add a business phone number to it.
3. Create an **authentication** template named `deepertones_otp`, language `en`:
   - Use a **copy code** button and the code in the body. The adapter sends the code as both.
   - Set **code expiration to 10 minutes**. This is fixed in the template, not in our code, so it
     must match `OTP_POLICY.ttlMinutes` in `src/modules/otp/otp.service.ts`. If they differ, users
     see codes that expire at the wrong time. Sends fail until Meta approves the template.
4. Create a System User and a **permanent** access token with the `whatsapp_business_messaging`
   permission.
5. Put the phone number ID (Meta → WhatsApp → API setup) in `WHATSAPP_PHONE_NUMBER_ID` in
   `wrangler.jsonc`: in the top level (local dev), in `env.staging` and in `env.production`. Env
   blocks do not inherit `vars`, so each one needs it.
6. Set the token (`OTP_PEPPER` is already set, see [ZeptoMail setup](#zeptomail-setup)):
   - Locally, set `WHATSAPP_ACCESS_TOKEN` in `.dev.vars`.
   - For each deployed environment, set it in `.dev.vars.staging` / `.dev.vars.production` and run
     `npm run secrets:push -- --env staging --apply` (then `production`). Leave `OTP_PEPPER` blank there so it
     is not overwritten. One-off alternative: `npx wrangler secret put WHATSAPP_ACCESS_TOKEN --env staging`.

Notes:

- Use a **different** `OTP_PEPPER` in each environment. A leak from staging must not help an
  attacker against production codes.
- Never change a pepper while codes are live. Changing it invalidates outstanding codes. That is
  harmless once 10 minutes have passed, so rotate then.
- While the Meta app is in **development mode**, only numbers added as test recipients receive
  messages. Any other number fails with Meta error 131030, which shows up as a failed delivery
  status with reason `recipient-rejected`. Switch the app to live mode before real users sign in.

## Email assets

Email images are served from the R2 bucket `deepertones-assets` on the custom domain `assets.deepertones.com`,
shared by every environment. CI keeps it in sync with the `assets/` folder:

1. Drop the files in `assets/` (the path under `assets/` is the URL path, so `assets/email/logo.png` is
   `https://assets.deepertones.com/email/logo.png`).
2. Merge to `staging`. The `Sync assets` workflow uploads what changed.

The sync is idempotent: it records each file's hash in `_sync-manifest.json` in the bucket and uploads only
files that are new or changed. The first run creates the bucket and attaches the custom domain. It never
deletes: a file removed from `assets/` is listed as orphaned in the run log and stays in the bucket; delete it
by hand in the Cloudflare dashboard if you really want it gone. To re-upload everything, run the workflow
manually with `force` ticked.

The sync runs on `staging` only: changes land there first and `main` only receives what staging already had, so
syncing from `main` could roll an asset in the shared bucket back. A manual run is only allowed from `staging`.
`_sync-manifest.json` is public at `assets.deepertones.com` and lists every asset key, so nothing secret may go
in `assets/`. An object changed or deleted by hand in the dashboard is not noticed until a `--force` run (the
manual workflow has a `force` box).

To preview what a sync would do, with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set:

```
npm run assets:sync -- --dry-run
```

The API token needs R2 edit. Attaching the custom domain may also need zone-level permission for
`deepertones.com`; if the first run fails there, its error says so.

SVG is rejected: Gmail and Outlook do not render it, so the logo is a PNG at 2x its display size.

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

3. Create the job queues (two per environment: the delivery queue and its dead-letter queue). A
   deploy that binds a missing queue fails:

   ```sh
   npx wrangler queues create deepertones-otp-delivery-staging
   npx wrangler queues create deepertones-otp-delivery-dlq-staging
   npx wrangler queues create deepertones-otp-delivery-production
   npx wrangler queues create deepertones-otp-delivery-dlq-production
   ```

4. Set `CORS_ORIGINS` for staging and production in `wrangler.jsonc` to the frontend origins
   (empty means no browser may call the API).
5. Set `ZEPTOMAIL_API_KEY` and `OTP_PEPPER` on both environments with `npm run secrets:push -- --env staging --apply` and `--env production --apply` (see [Config & secrets](#config--secrets)). The deploy fails until they are set. See [ZeptoMail setup](#zeptomail-setup). WhatsApp is optional and off until Meta approves the template ([WhatsApp OTP setup](#whatsapp-otp-setup)).
6. Run "Deploy staging" once by hand (Actions → Deploy staging → Run workflow) to check the credentials.

## Troubleshooting

**`Cannot find native binding` from vitest (rolldown)**: npm bug
[#4828](https://github.com/npm/cli/issues/4828) drops platform-specific optional dependencies
from `package-lock.json`, most often right after `npm install <package>`. CI's `npm ci` then
fails the same way. The fix is a clean regeneration, not `npm audit fix`:

```sh
rm -rf node_modules package-lock.json && npm install
```

**dependency-cruiser reports `0 modules`**: it needs TypeScript ≤ 6 (see docs/architecture.md).
