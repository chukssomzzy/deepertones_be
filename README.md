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
| `npm run prompts`             | Regenerate `src/prompts/prompts.generated.ts` (commit the result)     |
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
Every success response is `{ success, status, message, data }`; `data` below is that `data`. All API routes live under
`/api/v1`; only `/health`, `/docs` and `/openapi.json` are at the root.

1. **At app start** call `POST /api/v1/auth/anonymous` with `{ deviceId, platform: "ios" | "android" }`. The device id is
   Android's `getAndroidId`, or on iOS a UUID you generate once and keep in the Keychain (`expo-secure-store`). The
   same device id gets the same guest. You get `{ tokens, user }`.
2. **Store the tokens in `expo-secure-store`.** Send `Authorization: Bearer <accessToken>` on every call. The access
   token lives 15 minutes, the refresh token 60 days (each refresh restarts the 60 days).
3. **On a 401 with `TOKEN_EXPIRED`** call `POST /api/v1/auth/refresh` with `{ refreshToken }`, store the new pair and retry.
   **On `TOKEN_INVALID`** (from any call, including refresh) throw the stored tokens away and go back to step 1.
4. **To sign in**, with the guest's token: `POST /api/v1/auth/otp/send` with `{ channel: "email", address }`, then
   `POST /api/v1/auth/otp/verify` with `{ channel, address, code }`. Verify returns a new session: store it, replacing
   the old one. If the address already belongs to an account you are signed in as that account, and the guest is left
   behind. `GET /api/v1/me` returns the current user.
5. **To log out** call `POST /api/v1/auth/logout` with `{ deviceId, platform }` and the bearer token. It signs the user out
   on every device (their other devices' refresh then fails with `TOKEN_INVALID`) and returns a fresh guest session
   to store.
6. **For push notifications**, after every sign-in, logout, profile switch and token refresh, call `PUT /api/v1/me/push-token` with
   `{ deviceId, platform, token }` (the same `deviceId`; `token` is the Expo push token) and the bearer token. It answers 204.
   `DELETE /api/v1/me/push-token` with `{ deviceId }` stops them for this phone (204 even if nothing was registered). Logout and
   signing a guest in to an existing account delete the tokens they leave behind, so register again after them.
   `GET`/`PATCH /api/v1/me/notification-settings` read and change `{ scanFinished, scanNeedsYou }` (both on by default; PATCH names at
   least one). The pushes sent are "your scan is ready" (to the phones on the profile that made the scan), "your scan needs you" (an item
   needs a confirmation or a photo of the back; once per scan and kind, and once more when a back photo was unreadable) and, always,
   a security alert to the account's other phones when a guest signs in to an existing account. The same two switches cover face scans: "your face scan is ready" follows `scanFinished`, and "your face photo needs a retake" follows `scanNeedsYou` (no push for a face scan that fails). Each carries `data.url`, `kind` and
   the ids to route the tap.
7. **For shelf scans**, `POST /api/v1/scans/products/shelf` takes 1 to 3 `photos` (multipart) and answers 202 with the scan. Every scan
   response and the stream's `snapshot` now carry `kind` (`product` or `shelf`) and `photos[]` (`id`, `position`, `state`, and the
   `skipped` counts), and each item has a `photoId`. On a shelf scan the stream sends an `event: photo` when a photo has been read, before
   the `item` events of its products. A photo yields up to 5 products and a scan holds at most 20 items; each product counts against the daily limit.
8. **For onboarding**, before anything else, fetch `GET /api/v1/onboarding/content` (public, no token, optional `?locale=`, falls back to `en`) and render screens 1.2 to 1.5 from it: the text, the six goal chips and the safety choices (each `{ id, label }`, and `field` where a text box goes), the answer card for each goal and the colour note. Send `If-None-Match` with the last `ETag` (the `contentVersion`) to get an empty 304 while nothing changed. It is sent with `max-age` of 5 minutes plus `stale-while-revalidate` for a day; native HTTP stacks often ignore `stale-while-revalidate`, so show your cached copy straight away and revalidate in the background. A copy change reaches the app within minutes once it revalidates. Then `PUT /api/v1/me/goal` with `{ goal }` (one of `clear-skin`, `even-tone`, `fade-dark-marks`,
   `brighter`, `glow`, `calm-repair`, the last for skin made thin, red or reactive by a strong cream) or `{ text }` (the user's own words, 1 to 200 characters; not both) and the bearer token, guests included. It answers
   `{ goal, wantsLighter, text, answer, answersVersion, updatedAt }`, where `answer` is `{ title, howLong, helps, inTheWay, note }` (all
   draft copy for now). Typed words are read by a small model and sorted into a goal; words that ask to be lighter or fairer come back as `brighter` with `wantsLighter` true (and a plain note in `answer`). When no goal is found, or the model is unavailable, the words are saved with `goal` and `answer` null and the answer is still 200, so show the chips; a chip picked next keeps the words. The route is rate limited (10 changes a minute per user, 20 per address, chips included): 429 `RATE_LIMITED`, wait `Retry-After` seconds.
   `GET /api/v1/me/goal` returns the same view (404 `GOAL_NOT_SET` before anything was saved), and `GET /api/v1/me/onboarding` returns
   `{ goal, safety, next }` with `next` of `goal`, `safety` or `shelf`: use it to resume the first run. Words with a link or markup are a
   400 `INVALID_GOAL_TEXT`.
8. **For the safety question** (screen 1.5, after the goal): `PUT /api/v1/me/safety` with `{ choices, reactionText?, prescriptionText? }` and the bearer token,
   guests included. `choices` is a list (up to 20 entries, repeats are collapsed) of `pregnant`, `breastfeeding`, `reaction`, `prescription` and `none`; the optional texts (up to 300 characters
   as typed; line breaks and tabs are fine and come back as one space) name the products or ingredients behind `reaction` and `prescription`. `none` stands alone, and a text needs its own choice ticked (400
   `INVALID_SAFETY_ANSWER`, with `error.details.field` naming the field); words with a link, markup or an invisible character are a 400 `INVALID_SAFETY_TEXT`.
   Ticking a choice and naming nothing is fine, and a blank text counts as left out. It answers `{ choices, reactionText, prescriptionText,
   excludesPregnancyCaution, updatedAt }`; `GET /api/v1/me/safety` returns the same (404 `SAFETY_NOT_SET` before the first answer). The answers can be changed
   at any time, the newest counts, and a text is kept only if the answer you last sent has it. They are private to the profile. `GET /api/v1/me/onboarding` carries them in `safety`.

`deviceId` must be at least 16 characters (a UUID is fine), and a verification code is exactly 6 digits; anything
else is a 400 `VALIDATION_FAILED` and costs no attempt.

Error codes to handle (in `error.code`):

- `AUTH_REQUIRED` (401): no token. `TOKEN_EXPIRED` (401): refresh. `TOKEN_INVALID` (401): start over from step 1.
- `USER_NOT_FOUND` (404, on `/api/v1/me` and logout): the account is gone; re-bootstrap.
- `RATE_LIMITED` (429): wait `Retry-After` seconds.
- `PUSH_TOKEN_INVALID` (400): the token is not an Expo push token.
- `INVALID_GOAL_TEXT` (400): the typed goal has a link, markup or an invisible character. `GOAL_NOT_SET` (404): no goal saved yet.
- `INVALID_SAFETY_ANSWER` (400, `details.field` says which): "none" with another choice, or words without their choice. `INVALID_SAFETY_TEXT` (400): the words have a link, markup or an invisible character. `SAFETY_NOT_SET` (404): no safety answer yet.
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
- Required secrets: `ZEPTOMAIL_API_KEY`, `OTP_PEPPER`, `JWT_SECRET`, `DEVICE_ID_KEY`, `ANTHROPIC_API_KEY`, `EXPO_ACCESS_TOKEN`, `PERFECT_CORP_API_KEY` and `PERFECT_CORP_WEBHOOK_SECRET`. All are listed in `secrets.required`, so a deploy fails until they are set on that environment (push `JWT_SECRET`, `DEVICE_ID_KEY`, `ANTHROPIC_API_KEY`, `EXPO_ACCESS_TOKEN`, `PERFECT_CORP_API_KEY` and `PERFECT_CORP_WEBHOOK_SECRET` to staging and production before this lands). See [Face scan setup](#face-scan-setup-perfect-corp) for the last two. `JWT_SECRET` signs access/refresh tokens and must differ per environment; to rotate it, move the old value to the optional `JWT_SECRET_PREVIOUS` (accepted for verification only). `DEVICE_ID_KEY` must differ per environment and must NEVER be rotated: it would orphan every device's guest. Generate `JWT_SECRET` and `DEVICE_ID_KEY` with `openssl rand -hex 32`. ZeptoMail setup is in [ZeptoMail setup](#zeptomail-setup). Expo setup is in [Expo push setup](#expo-push-setup). `WHATSAPP_ACCESS_TOKEN` is only needed once `whatsapp` is in `OTP_CHANNELS` (see [WhatsApp OTP setup](#whatsapp-otp-setup)).
- After changing either, run `npm run cf-typegen` so `c.env` stays typed.

## Product catalog setup

Product research and analysis call Claude, and stock images are kept in the existing public bucket
`deepertones-assets`, served at `assets.deepertones.com` (see [Email assets](#email-assets)), under
`catalog/<environment>/`. There is no bucket or domain to create: both already exist, and the CI asset sync never
touches `catalog/` (it refuses a local file under that prefix). Design in "Product catalog service" in
`docs/architecture.md`. What is left for the account owner, once per environment:

1. Create an Anthropic API key per environment (Claude Console → API keys; a separate key or workspace for each, so
   spend limits and revocation are per environment) and put it in `.dev.vars.staging` and `.dev.vars.production` as
   `ANTHROPIC_API_KEY`.
2. Push them: `npm run secrets:push -- --env staging --apply`, then `npm run secrets:push -- --env production --apply`.
3. Optional: add a response header rule (the `deepertones.com` zone → Rules → Transform Rules → Modify Response
   Header) that sets `X-Content-Type-Options: nosniff` for `assets.deepertones.com`, so a browser never
   reinterprets a stored object.

Deploys fail until `ANTHROPIC_API_KEY` is set on the environment's Worker (it is in `secrets.required`), so do steps 1
and 2 before merging to `staging` or `main`. The first catalog image can only be written once `deepertones-assets`
exists, which the first asset sync creates. Locally nothing needs creating: the tests and `wrangler dev` use a local
bucket, which serves no public URL, so product views show no image. For `wrangler dev`, also put `ANTHROPIC_API_KEY` in `.dev.vars` to try the real model.

### Private photo storage

Users' product photos go to the private R2 bucket `deepertones-private` (binding `PRIVATE_PHOTOS`), one bucket for every
environment, keys under `photos/<environment>/`. The bucket already exists (created 2026-10-15), so there is nothing to do:
no bucket, domain or secret to create. Keep it private: never attach a custom domain or enable r2.dev. Design in
"Private photos" in `docs/architecture.md`.

### AI spend cap

Every Claude request is reserved and settled in the ledger and counted against a daily dollar figure, `AI_DAILY_BUDGET_USD` in
`wrangler.jsonc` (a `var` in each environment: `1` locally, `5` on staging, `30` on production; it must be a positive
number). It resets at 00:00 UTC. **It only alerts**: the first call past it emails `OPS_ALERT_EMAIL` (once that UTC day) and
no call is ever refused, so it can never leave a user's scan stuck. There is no Console limit behind it, by decision, so
change it in the config. The catalog's daily research (200) and analysis (300) budgets are alert-only in the same way, and
so is Claude refusing our account (no credit, a bad key, permissions): the scan item waits and asks again every 5 minutes,
and the alert email goes out at most once an hour. Set `OPS_ALERT_EMAIL` (a `var` in each environment, empty until you
fill it in; an empty one logs and drops the alert) to the address that should get them; see "Ops alerts" in
`docs/architecture.md`. The
`ai_usage` table (migration 0008) holds the record, so run the migrations on an environment before deploying to it. To see
what has been spent:

```
npm run ai:spend -- --env staging          # also --env production; local by default; --days N (default 30)
```

It prints today, the last 7 days and the last N days in dollars, then each job and model. The models per job are
`ANTHROPIC_MODEL_RESEARCH`, `_VISION`, `_RECOGNIZE_SHELF`, `_JUDGE` (Haiku) and `_ANALYSIS` (Sonnet) in the same file. Design in "AI cost
tracking" in `docs/architecture.md`.

To measure the research, analysis, goal-reading and mention-reading steps against fixed cases, run `npm run eval:catalog` (the default `--mode all` includes the goal and mention readers; `-- --mode goals` runs only the first, about 40 Haiku calls and a few cents, and `-- --mode mentions` only the second, about 22 Haiku calls and a few cents; it makes real, billed Claude calls and reads the key from `.dev.vars`; `-- --limit 1` keeps a trial cheap, and `-- --max-usd 0.5` caps what it may spend, 2 dollars by default; it prints the cost of each case and the total). For the weekly CI run, add the same key as a GitHub repository secret named `ANTHROPIC_API_KEY` (Settings → Secrets and variables → Actions); without it the run skips. See "Catalog eval" in `docs/architecture.md`.

## Catalog workbook

The recommendation catalog (products, where they are sold and at what price, ingredient rules, countries) is edited as a spreadsheet, not in the
database. A dermatologist reviews the rules in [docs/catalog-workbook-contract.md](docs/catalog-workbook-contract.md) (written from the contract by
`npm run catalog:contract-doc`), and the two commands below move the workbook in and out of an environment.

1. **Export** the live catalog: `npm run catalog:export -- --env staging` (or `local`, `production`; `--out file.xlsx` to name the file). It writes
   `catalog-<env>-v<version>.xlsx` with the four tabs (Products, Availability, Ingredients, Countries) and a hidden `_meta` sheet that remembers the
   catalog version the file came from. Leave `_meta` alone.
2. **Edit** the workbook in Excel or Sheets. Keep the tab names and header rows as they are.
3. **Upload as a dry run**: `npm run catalog:upload -- catalog-staging-v12.xlsx --env staging --by "Your name"`. The file is checked against the
   contract on your machine first, and every problem is listed by tab, row and column with nothing sent. If it passes, the server answers with what
   would change per tab (added, updated, retired, reactivated) and any product it would create as new. A different spelling of a product's name is a
   new product, so read that list. A dry run changes nothing.
4. **Apply** it by running the same command with `--apply`. This writes the new catalog version and archives the file. If someone else applied a
   change after your export, the upload is refused as `CATALOG_STALE`: export again and redo the edits on the new file.

Both commands read `ADMIN_API_TOKEN` from the environment's vars file: `.dev.vars` for `local`, `.dev.vars.staging` and `.dev.vars.production` for the
deployed ones (the same gitignored files as above). The token is sent only in the `X-Admin-Token` header and is never printed.

- **Creating or rotating the token:** generate a long random value (for example `openssl rand -base64 48`), put it in `.dev.vars.<env>` as
  `ADMIN_API_TOKEN`, and push it with `npm run secrets:push -- --env <env> --apply`. To rotate, replace the value and push again; the old value stops
  working as soon as the Worker has the new one. For `local`, the value in `.dev.vars` is what `wrangler dev` reads.
- **A file only goes back where it came from.** The export stamps the environment, the catalog version and the contract version into the hidden `_meta`
  sheet. An upload is refused, before anything is sent, if the file was exported from another environment or for another contract version, and the
  server refuses it (`CATALOG_STALE`) if the catalog has moved on since: export again and redo the edits on the new file. `catalog:export` will not replace a file that already exists unless you pass
  `--force`.
- **Use Excel or LibreOffice.** Google Sheets and Numbers may drop the hidden `_meta` sheet when they save; a file without it is refused, so use Excel or
  LibreOffice, or export again.
- **Keep the cells as text.** Excel may retype a date, or turn a code such as `007` into a number, when you paste over a cell. Dates are written
  `YYYY-MM-DD` and codes are text, and the contract check lists any cell that no longer fits.

**Drafting with AI.** To fill in a new product's blanks, add its row to the Products tab (brand, name, category, origin, status `draft`), then run
`npm run catalog:draft -- in.xlsx --out out.xlsx --max-usd 2 [--countries NG,GB]`. It fills only the empty cells of `draft` rows (the ingredient list, its
page, skin concerns, skin types, steps and frequency) and adds an Availability row for each active country that has none, never adding or removing a product
and never writing to the input file. Every cell it fills is listed in `draft_cells` with the page it came from, and a row stays `draft` with no approval, so a
person must check each cell against its page, clear its `draft_cells` entry and approve the row. It makes real, billed Claude calls (key from `.dev.vars`) and
stops at `--max-usd` (2 dollars by default), keeping what it has. The report lists what is still wrong, by tab, row and column; the output file is a normal
workbook to finish and upload as above. Draft from a file you exported: the output keeps the input's `_meta` stamps (environment, catalog version and
contract version), so it uploads to the environment it was exported from, and a file with no stamp stays refused by the upload.

## Face scan setup (Perfect Corp)

The face scan sends the front photo to Perfect Corp (YouCam) and gets the analysis back by webhook. Design in "Face scans" in
`docs/architecture.md`. What is left for the account owner, once per environment, **before** merging to `staging` or `main`:

1. Put `PERFECT_CORP_API_KEY` (the API key from the Perfect Corp console) and `PERFECT_CORP_WEBHOOK_SECRET` (the signing secret the console shows for
   the webhook, `whsec_` and then base64) in `.dev.vars.staging` and `.dev.vars.production`, then push them:
   `npm run secrets:push -- --env staging --apply`, then `--env production --apply`. Both are in `secrets.required`, so **a deploy fails until both are
   set** on that environment's Worker.
2. Register the webhook URL in Perfect Corp's console, once per environment, for task results:
   `https://<that Worker's host>/api/v1/webhooks/perfect-corp`. Until it is registered nothing wakes the analysis, and the reaper's single check 15
   minutes after the photo is what finds the result.
3. Confirm `PERFECT_CORP_USD_PER_UNIT` in `wrangler.jsonc` (a placeholder) and create the `face-scans` queues (see [Before the first deploy](#before-the-first-deploy)).

The webhook route has its own per-address limit (`PERFECT_CORP_WEBHOOK_LIMITER`, 300 a minute) and refuses a body over 64 KB. The tests never reach Perfect
Corp: they stub `fetch`.

### Showing a face scan result (for the app)

`GET /api/v1/scans/faces/{id}` (and the create and retake answers) carry `result`: null until `state` is `ready`. Render it as it is: `result.seen` is the
goal's concerns that can be seen now (at most 3, goal order; `words` is the text to show, `concern` an id such as `glow` or `spots`), or show
`result.nothingStandsOut` when `seen` is empty. `skinType` and `skinAge.words` are plain facts, and `sinceDayOne` (null for the first scan under a goal)
has the `words` for how each concern moved. Never show a number or invent wording of your own: there is no score, diagnosis or Fitzpatrick type in the
result by design. `overlay.url` is a signed link to a PNG mask of where the concern shows and **expires after 5 minutes**: when it has, fetch the scan
again for fresh links. Field details are in `docs/openapi.json` (`FaceScanResult`).

`GET /api/v1/scans/faces` lists the profile's face scans, latest first, at most 20, in every state (`{ faceScans }`, each the same as `GET /scans/faces/{id}`).
Use it to find a scan without remembering its id, or to offer a retake of one that `needs-retake`. It is empty (200) before the first scan and keeps working after
the face consent is withdrawn, so the user can still find and delete their scans.

A face scan sends a push when it becomes `ready` (`data.kind` `face-scan-ready`, `data.url` `/scans/faces/{faceScanId}`) and when its front photo needs a retake
(`face-scan-needs-retake`, `/scans/faces/{faceScanId}/retake`, with `data.reason`), once per transition; a failed scan sends none. The app needs those two
screens. The server always sends, so if the user is watching that scan's live stream (`GET /scans/faces/{id}/events`) when the push lands, the app should
suppress the foreground notification.

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

## Expo push setup

Push notifications go out through the Expo Push Service. The provider is in `src/providers/push`, the send and receipt
jobs in `src/modules/notifications` (see "Push notifications (Expo)" and "Sending push notifications" in
`docs/architecture.md`). The backend sends three pushes: "scan ready", "scan needs you" (a confirmation or a back photo) and a
security alert when a guest signs in to an existing account; "What triggers a push" there says when. Tests never call Expo and need no
secrets. What is left for the account owner, once per environment (a separate access token per environment is fine but not
required):

1. In Expo, create a robot user and an access token for it (expo.dev → account → Access tokens).
2. In the Expo project's settings, turn on **Enhanced security for push notifications**. Expo then refuses a
   send that does not carry the access token, so a leaked push token cannot be used to message our users.
3. Upload the credentials Expo needs to reach the phones, to Expo/EAS (`eas credentials`, or the dashboard): the
   **FCM v1 service-account key** (Android) and the **APNs key** (iOS).
4. Put the access token in `.dev.vars.staging` and `.dev.vars.production` as `EXPO_ACCESS_TOKEN` (and in `.dev.vars`
   to try it locally), then push it:

   ```sh
   npm run secrets:push -- --env staging --apply
   npm run secrets:push -- --env production --apply
   ```

5. Create the four push queues for each environment (`push-delivery`, `push-delivery-dlq`, `push-receipts`,
   `push-receipts-dlq`); the commands are in [Before the first deploy](#before-the-first-deploy), step 3. A deploy that binds
   a missing queue fails.

Deploys fail until `EXPO_ACCESS_TOKEN` is set on the environment's Worker (it is in `secrets.required`), so do steps 1
to 5 before merging to `staging` or `main`.

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
unit, integration (four parallel shards behind one `Integration` check), typecheck, architecture rules, the API contract (`docs/openapi.json` is current
and valid), the prompts (CI regenerates `src/prompts/prompts.generated.ts` and fails if it is stale),
and a dry-run build of both environments.
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
Env blocks do not inherit `vars`, bindings or `triggers`, so add each one to both.
The daily guest-cleanup cron (`triggers.crons`, 03:17 UTC) is deployed with the Worker; see Guest cleanup in `docs/architecture.md`.
The scan reaper cron (`*/10 * * * *`, same `triggers.crons`) is deployed with the Worker too and needs no setup: no queue, binding or secret to create. It queues scan steps that were lost again and fails items stuck for over 2 hours; see Scan module in `docs/architecture.md`.

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

3. Create the job queues (two per queue per environment: the queue and its dead-letter queue; OTP delivery,
   the scan items, push delivery, push receipts, the parse of the safety answers and the shared `email` queue, which carries
   the ops alert emails and any later email job). A deploy that binds a missing queue fails:

   ```sh
   npx wrangler queues create deepertones-otp-delivery-staging
   npx wrangler queues create deepertones-otp-delivery-dlq-staging
   npx wrangler queues create deepertones-otp-delivery-production
   npx wrangler queues create deepertones-otp-delivery-dlq-production
   npx wrangler queues create deepertones-scan-items-staging
   npx wrangler queues create deepertones-scan-items-dlq-staging
   npx wrangler queues create deepertones-scan-items-production
   npx wrangler queues create deepertones-scan-items-dlq-production
   npx wrangler queues create deepertones-push-delivery-staging
   npx wrangler queues create deepertones-push-delivery-dlq-staging
   npx wrangler queues create deepertones-push-delivery-production
   npx wrangler queues create deepertones-push-delivery-dlq-production
   npx wrangler queues create deepertones-push-receipts-staging
   npx wrangler queues create deepertones-push-receipts-dlq-staging
   npx wrangler queues create deepertones-push-receipts-production
   npx wrangler queues create deepertones-push-receipts-dlq-production
   npx wrangler queues create deepertones-parse-safety-staging
   npx wrangler queues create deepertones-parse-safety-dlq-staging
   npx wrangler queues create deepertones-parse-safety-production
   npx wrangler queues create deepertones-parse-safety-dlq-production
   npx wrangler queues create deepertones-email-staging
   npx wrangler queues create deepertones-email-dlq-staging
   npx wrangler queues create deepertones-email-production
   npx wrangler queues create deepertones-email-dlq-production
   npx wrangler queues create deepertones-face-scans-staging
   npx wrangler queues create deepertones-face-scans-dlq-staging
   npx wrangler queues create deepertones-face-scans-production
   npx wrangler queues create deepertones-face-scans-dlq-production
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
