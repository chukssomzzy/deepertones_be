# Architecture

How the deepertones API is put together, and why. Decided 2026-10-10.
Most of the rules here are enforced by `.dependency-cruiser.cjs` (`npm run lint:arch`, and the
Architecture job in CI). If a rule and this document disagree, fix one of them.

## The flow

```
request
  → middleware: requestId · logger · cors · secureHeaders · container · auth · requestContext
  → route        declared with defineRoute (validates input, documents itself),
                 calls ONE service method, returns ok(...)
  → service      business logic; reads currentActor(); throws domain errors
      → repository   all database access (Drizzle on D1)
      → provider     every third party, behind an interface
  ← ok() wraps data in the success envelope
  ← errorHandler maps domain errors to HTTP, in one table, and renders the error envelope
```

## Layout

```
src/
  index.ts                 app assembly; exports AppType for the typed client
  container.ts             composition root: the ONLY file that knows concrete classes
  docs.ts                  spec header, /openapi.json and Swagger UI at /docs
  middleware/              requestContext, container, cors, auth
  lib/                     shared plumbing: factory, errors, openapi, api-version, actor, context, jwt, db, http, once, url-safety, image-header
  modules/<feature>/
    <feature>.routes.ts           thin controller
    <feature>.service.ts          business logic
    <feature>.repository.ts       D1 class + inferred type
    <feature>.repository.fake.ts  in-memory implementation for unit tests
    <feature>.repository.contract.ts  behaviour both implementations must pass
    <feature>.table.ts            Drizzle table(s)
    <feature>.types.ts            domain types (inferred from tables)
    <feature>.schemas.ts          zod schemas: request AND response (the wire contract)
    <feature>.presenter.ts        domain object → public JSON, typed by its response schema
    <feature>.service.test.ts     unit tests, next to the code
  modules/scans/           the product scan: scans and scan_items, ScanService, the advance-scan-item job (see "Scan module")
  modules/face-scans/      the face scan: pure rules (face-scans.tables.ts), consent, the scan records and their routes, FaceScanService (see "Face scans")
  modules/face-shares/     the remembered consent to share a before-and-after card of the face photos, and the record of each share, FaceSharesService (see "Face shares")
  modules/recommendations/ where a profile shops and what it can spend, and the reviewed products it may be suggested: RecommendationService (see "Shopping facts and candidates")
  emails/                  email templates: html tag, brand, components/, templates/, registry (renderEmail)
  prompts/                 the Claude system prompts as Markdown, and prompts.generated.ts built from them (see "Prompts")
  jobs/                    the job system: job.ts (defineJob), dispatcher.ts (the Worker's queue
                           and scheduled handlers), registry.ts (every job), job-runs.* (idempotency table)
  providers/<capability>/
    <capability>.provider.ts      interface services depend on
    <vendor>.<capability>.ts      one adapter per vendor
    memory.<capability>.ts        fake for tests
    (email/ sends transactional email: an EmailSender port, the ZeptoMail adapter, a memory fake)
    (job-queue/ is the producer side of the job system: a JobQueue port, Cloudflare Queues + memory adapters)
    (anthropic/ is the shared Claude Messages API client, its errors, reply helpers, price table and the AiSpendLedger
     port; product-research/ finds a product's ingredients with web search; product-analysis/ writes concerns and
     answers same-product and image-matches-product questions. See "Claude (Anthropic) providers" and "AI cost tracking".)
    (name-splitting/ splits a name a user typed into brand, name, variant and category: the NameSplitter port, the Claude adapter, a memory fake.
     See "Claude (Anthropic) providers".)
    (scan-events/ is the port a scan's changes are published and watched through: ScanEvents, a memory fake, and the
     Durable Object adapter. See "Live updates".)
    (push/ sends push notifications: a PushSender port, the Expo adapter, a memory fake. See "Push notifications (Expo)".)
    (workbook-archive/ keeps the .xlsx of each applied catalog upload in the private bucket: a WorkbookArchive port, an R2 adapter, a memory fake. See "Catalog workbook import".)
    (perfect-corp/ reaches Perfect Corp (YouCam) for the face scan: a PerfectCorpClient port with its error classes, the REST adapter, a memory
     fake, and the VendorSpendLedger port. See "Perfect Corp provider" and "Vendor spend ledger".)
src/realtime/              Durable Object classes (ScanStream), exported from src/index.ts; reached only through a provider
docs/openapi.json          the generated spec, committed (npm run openapi)
scripts/                   build-time scripts (spec generation, prompts generation)
migrations/                SQL generated by drizzle-kit, applied by wrangler
test/integration/          tests against real local bindings
```

`modules/health` is the reference implementation of every piece above that it needs.
`providers/otp-delivery/` is the first real provider: the interface, the Meta WhatsApp adapter, and the memory fake.
`providers/email/` follows the same shape for email.
`modules/users` owns identity (users, guests, devices); `modules/otp` sends and checks codes.

## Decisions

### Feature folders, `*.routes.ts`
A feature's route, service and repository change together, so they live together. Routes are
called `routes` because in Hono they are sub-apps mounted with `app.route()`, not controller classes.

### Per-request container, constructor injection
Bindings (`env.DB`, buckets, secrets) arrive with each request, so `buildContainer(env)` runs per
request. It is lazy (`once`), so a request only builds what it touches. Services, repositories
and providers are classes that take their dependencies in the constructor. Unit tests build a
service directly with fakes, so no DI framework and no module mocking is needed.

### Private members: `private` by default, `#` for secrets
A class's constants and helpers are class members (`private static readonly`, `private static`), not
module-level names; only what other files import is exported. Use TypeScript `private` by default. Use
ECMAScript `#` only for a field that holds a secret (an API key, a signing secret, a client that
carries a key): TS `private` is erased, so the field is still an own property that a spread,
`Object.values` or `JSON.stringify` exposes, while a `#` field is private at runtime too. Each `#`
secret field has a test that spreading its object does not expose it.

### Repository types are inferred; provider interfaces are written
A repository has one real implementation, so `tracks.repository.ts` exports `class D1TracksRepository`
and `export type TracksRepository = PublicOf<D1TracksRepository>`. The D1 class is the single source:
signatures and doc comments are written once, and the fake `implements` the inferred type, so it is
still checked by the compiler. `PublicOf` (`lib/types.ts`) drops private members, which is what lets
a fake match. Services `import type` it, so there is no runtime coupling and the depcruise rules are
unchanged.

Providers keep a hand-written `*.provider.ts` interface: several vendors implement one port, and the
contract must not be one vendor's shape.

### Background jobs (Cloudflare Queues)
Slow or flaky work (sending a message, calling a vendor) runs in a queue consumer, not in the
request. Queues deliver at least once, so the system is built around repeat-safety.

- **A job is declared in the module that owns it, in two files.** `<feature>.job-specs.ts` holds the
  `jobSpec({ name, queue, schema, key, retry })`, which services import to enqueue.
  `<feature>.jobs.ts` holds `defineJob(spec, { handle, onDeadLetter? })`, typed with the
  `Container`. `handle` calls one service method, like a route, so business logic stays in services.
  *Why the split:* a service that imported a file containing its own handler would close the cycle
  container → service → jobs → container. `job.ts` is generic over `Services` and never imports the
  container.
- **`src/jobs/registry.ts` lists every job**; only `src/index.ts` imports it
  (`job-registry-only-in-entry`) and passes it to `createQueueHandler`, the Worker's `queue` export.
  `job-handlers-only-in-registry` lets only the registry import a `*.jobs.ts`, and
  `job-specs-no-container` stops a `*.job-specs.ts` importing `container.ts`.
- **One queue and one dead-letter queue per queue per environment**: `deepertones-<queue>-<env>` and
  `deepertones-<queue>-dlq-<env>` (`queueNames`). Environments never share a queue. Queues must exist before a deploy that
  binds them. Most jobs have a queue of their own, so a backlog in one never delays another; the `email` queue is **shared**.
- **A queue may carry several jobs (`shared: true` on the spec).** The `email` queue (`send-ops-alert` today, every later
  email kind after it) is meant to carry many jobs, because an email job is small and a queue per kind is more to create and
  watch than it is worth. (`deliver-otp` stays on its own `otp-delivery` queue: it sends WhatsApp too.) A message on a shared
  queue names its job: `{ job: '<name>', body }`, and nothing else. `CloudflareQueuesJobQueue.enqueue` writes that envelope for
  a spec marked `shared`, after validating the body against the spec's schema; every other spec still sends the bare body.
  The dispatcher routes a message to the job it names, and a dead letter the same way (its `onDeadLetter` hook). Idempotency
  keys stay per job (`job_runs` is keyed by job and key). The registry test requires every job name to be unique, every
  queue to have its own dead-letter queue, and the jobs of a queue to be all `shared` or none (and `shared` when there are several).
  **What the dispatcher does with a message it cannot attribute:** a queue that carries ONE job still accepts a bare body (what
  the last deploy sent, still in flight when a queue is first shared) as well as an envelope naming that job. Anything else (an
  envelope naming a job the queue does not carry, or a bare body on a queue of several) can never succeed, so it is logged
  `{ queue, attempt, outcome: 'unknown-job', named }` (only the claimed job name, truncated; never the body) and acked, not
  retried: a retry would only repeat the same log line until the message expires.
- **Dispatcher flow, per message**: find the queue's jobs by queue name (unknown queue: log an error and
  retry the whole batch, so nothing is lost while misconfigured) → pick the job (above) → validate the body against the
  schema (invalid: ack, since a retry cannot fix it) → claim the idempotency key → run `handle`
  inside `runAs({ kind: 'system', job })` → ack or retry. Each message is handled on its own. After
  the batch, `job_runs` rows older than 7 days are purged, so no cron is needed. Every run logs
  `{ job, key, attempt, outcome }`; message bodies are never logged, they may carry secrets.
- **Permanent vs temporary errors.** `PermanentJobError` records the run as failed and acks: retrying
  cannot help. Any other error releases the run and retries. When the queue's `max_retries` is
  spent, Cloudflare moves the message to the dead-letter queue.
- **A job record or log never carries an error's message.** `describeError` (`src/jobs/safe-error.ts`)
  is the only way an error reaches the `job_runs.lastError` column (the reason passed to `markFailed` and `release`) or a log line. Only errors the app
  itself authored keep their text: a `DomainError` (as `code: message`) and a `PermanentJobError`.
  Every other error is written as its name, plus the name of its `cause` when it has one
  (`DrizzleQueryError (cause: Error)`); a thrown non-error is `non-error <typeof>`. *Why:* drizzle's
  `DrizzleQueryError` message is `Failed query: <sql> params: <params>`, and the params can be
  model-written text, user-typed text or hashes. drizzle leaves that error's `name` as `Error`, so the
  class name is used when the name is the generic one. This covers the `dispatcher-error`,
  `purge-failed` and scheduled `failed` log lines too. So a message you write for a domain error or
  `PermanentJobError` must not interpolate user or model text. **The same holds for the whole app**, not only jobs: the
  name-only half is `describeUnexpectedError` (`src/lib/safe-error.ts`, a leaf so `lib/errors.ts` can use it without a cycle;
  `describeError` adds the two kinds of error the app writes). `errorHandler` logs a 500 as `{ requestId, error }` with that
  description, and the OTP `enqueue-failed` and the health check's failed-database log lines use it too. No log line is given a
  raw error object or `String(error)`.
- **Full-jitter exponential backoff**: delay = random in [0, min(cap, base * factor^(attempt-1))),
  per job (`retry`), so retries spread out instead of stampeding a recovering vendor. The delay is
  always passed to `message.retry`, even when 0.
- **Idempotency is a `job_runs` claim**, keyed by (job, key) where the key comes from the message's
  own data, so enqueueing the same work twice is also deduplicated. A claim is ONE atomic upsert:
  it wins for a new key or a running key whose lease (2 minutes) expired, so a crashed run does not
  stick. `done` and `failed` are terminal (duplicates are acked unrun); a live lease means retry
  later.
- **The claim returns a lease token** (the lease expiry in ms). `markDone` and `release` are each one
  conditional UPDATE that applies only while that token is still the run's lease. *Why:* a slow
  worker whose lease expired and was re-claimed must not mark the new owner's run done or free its
  lease. A refused `markDone` is logged as `lease-lost`.
- **This is at-least-once with duplicate suppression, not exactly-once.** A crash after the side
  effect but before `done` is recorded cannot be prevented, and a lease can expire under a slow
  handler, so handlers must be repeat-safe.
- **Dead letters never override `done` or `failed`, nor a run being worked on.** On the dead-letter
  queue the run is read first: a finished run is acked (`dead-letter-ignored`), and so is a run still
  claimed within its lease (`dead-letter-in-progress`, e.g. a duplicate of an item another delivery is
  working on), both with no hook and no write. Otherwise
  `onDeadLetter` updates domain state (e.g. marks a challenge failed), then the run is recorded as
  failed with `last_error` = `dead-lettered: <last retry's error>` (just `dead-lettered` if no
  attempt recorded one), so the cause survives.
- **Bookkeeping failures** (D1 down, a hook that throws) are logged as `dispatcher-error` and the
  message is retried with backoff; they do not lose it. The purge failing is logged only.
- **The `parse-safety` job** (`modules/safety`: `safety.job-specs.ts`, `safety.jobs.ts`; logic in `SafetyService.parse`) reads the words a user typed beside "a product gave
  me a reaction" and "I use a prescription" (see "Safety facts (onboarding)"). It is on its own `parse-safety` queue and dead-letter queue in all three `wrangler.jsonc` blocks
  (binding `PARSE_SAFETY_QUEUE`; created before the first deploy that binds them, README "Before the first deploy"). The body is `{ safetyId }` and nothing else, so no word of
  the text is in the queue, and the key is `parse-safety:<safetyId>`. Nobody waits for it, so it lets the defaults batch it, keeps the standard 5 attempts (`max_retries` 4) and
  retries like the receipt check (30 s x3 up to 600 s); `onDeadLetter` is `markParseFailed`. The consumer takes **one message at a time** (`max_batch_size` 1): a parse is a
  model read and a catalog research, and a batch is retried or acked as a whole. The body may also carry `retry: true`, for the second try the next day: the dispatcher
  records a dead-lettered run as failed for the key for good, so that message has its own key, `parse-safety:<safetyId>:retry`. The daily cron queues it (see "Guest cleanup").
- **The `build-verdict` job** (`modules/verdicts`: `verdicts.job-specs.ts`, `verdicts.jobs.ts`; logic in `VerdictService.build`) builds a profile's shelf verdict (see "Shelf verdict"). It is on its
  own `verdicts` queue and dead-letter queue in all three `wrangler.jsonc` blocks (binding `VERDICTS_QUEUE`; created before the first deploy that binds them, README "Before the first deploy"),
  one message at a time (`max_batch_size` 1), the standard 5 attempts and the safety parse's backoff. The body is ids and counters, never the shelf or the words typed. The key is
  `build-verdict:<profileId>:<requestedAt>:<waits>`, with `:retry` on the second day's try for the same reason as `parse-safety`; `onDeadLetter` is `markFitFailed`.
- **The `build-routine` job** (`modules/routines`) builds a profile's routine (see "Routines (job)"). Its own `routines` queue and dead-letter queue in all three blocks (binding `ROUTINES_QUEUE`), one message at a time, the verdict build's backoff; `onDeadLetter` is `markBuildFailed`.
- **Producing goes through the `JobQueue` provider** (`enqueue(job, body, { delaySeconds? })`, typed by the job's
  schema; the delay holds the message back, for a wait that must not use up retries), with a Cloudflare Queues adapter and an in-memory fake (which records the job name and the bare body, whatever the queue). Services never see bindings.
- **`buildJobRuntime(env)`** in `container.ts` returns `{ services, jobRuns }` for the dispatcher.
  The dispatcher cannot import the concrete `D1JobRunsRepository` itself
  (`concrete-classes-only-in-container`), and `jobRuns` is kept out of the services `Container` so a
  route can never reach a repository.
- **Rules**: `job-registry-only-in-entry` (above), and `context-only-in-services` lets
  `src/jobs/dispatcher.ts` call `runAs`. That is why the guest-cleanup cron handler (`createScheduledHandler`)
  lives there: it is the one runAs-allowlisted jobs entry. The Worker's `scheduled` export is
  `createScheduledRouter` (`src/jobs/scheduled.ts`), which only picks a handler by `controller.cron`; the
  scan reaper and the reminder send job it routes to need no actor, so they stay off the allowlist.

### Outbound HTTP
Provider adapters call vendors through `lib/http.ts`, built on rxjs `fromFetch`: `requestJson$` for JSON APIs
and `requestBytes$` for binary downloads (`requestHeadBytes$` for the start of a page).
It returns an Observable so an adapter can compose operators; the adapter converts at its own
boundary with `firstValueFrom`, so services stay Promise-based and never import rxjs. The rule: use a vendor's
official SDK when it runs on Workers and does not retry on its own; otherwise write the adapter by hand on
`requestJson$`. Claude is the one vendor that goes through its official SDK (see "Claude (Anthropic) providers"); Expo is the
hand-written case (see "Push notifications (Expo)").

- **Every call has a timeout** (`timeoutMs`); on expiry the request is aborted and the stream
  errors with `HttpTimeoutError`. Other transport failures are `HttpNetworkError`. Any HTTP status
  is a value, not an error: the adapter decides what a 4xx or 5xx means.
- **`requestBytes$` is for untrusted servers.** It never follows redirects (`redirect: 'manual'`): a 3xx is
  a value with its `location`, so the adapter vets each hop before requesting it. The size cap
  (`maxBytes`) is enforced while reading: a larger `content-length` fails before any byte is read, and
  otherwise the body is streamed and cancelled as soon as the cap is passed, so an endless body cannot
  fill memory (never `arrayBuffer()`). Exceeding it is `HttpTooLargeError`, its own error and not a
  transport one, because the server did answer. `timeoutMs` covers the whole body.
- **`requestHeadBytes$` is `requestBytes$` for when only the start of the body matters** (the `<head>` of a web
  page). Same manual redirects and timeout, but a body past `maxBytes` is cut at the cap and the stream cancelled,
  not an error, and a large `content-length` is not refused.
- **No retries.** A retried OTP send could deliver, and bill, a second code. Retrying is each
  caller's decision.
- **Provider-only.** The `http-only-in-providers` rule lets only `src/providers/**` import
  `lib/http.ts`, so services, repositories and routes never make HTTP calls. Build scripts under
  `scripts/` (the asset sync's Cloudflare client) also use it; `lint:arch` only checks `src`, so
  that is by convention.

### D1 + Drizzle, tables per module
SQLite at the edge with a native binding, local simulation in dev and tests, and no connection
management. Drizzle gives typed queries and generated migrations. `drizzle.config.ts` collects
`src/**/*.table.ts`; its `out` and `migrations_dir` in `wrangler.jsonc` must stay the same folder.

### Atomic writes live in one repository method
**D1 has no interactive transactions**: no `BEGIN → read → decide → write → COMMIT`. The only
atomic tool is `db.batch([...])`, a fixed list of statements that all apply or none do. So:

- the service decides *what* should happen (reads, rules, errors);
- one repository method makes it happen atomically with `db.batch`.

A service never coordinates two repositories "in a transaction"; that cannot be made atomic on D1.

### Domain errors, mapped at the edge
Services throw `ValidationError`, `UnauthorizedError`, `ForbiddenError`, `NotFoundError`,
`ConflictError`, `RateLimitedError` or `UnavailableError` (all `DomainError`) with a stable `code`. They know nothing
about HTTP, so the same service works from a queue consumer or cron trigger. `errorHandler` maps
kind → status in one table (`RateLimitedError` → 429, `UnavailableError` → 503) and renders the error envelope below.
A `RateLimitedError` with a numeric `details.retryAfterSeconds` also sets the `Retry-After` header.
Anything that is not a `DomainError` is a bug: logged, and returned as a generic 500.

### One response envelope
Every JSON response has the same outer shape, so a client branches on one field.

- **Success:** `{ success: true, status, message, data }`. A route declares it with
  `success(Schema, description)` and returns it with `ok(c, data, message, status?)`.
- **Error:** `{ success: false, status, message, error: { code, details?, requestId } }`. Only
  `errorHandler` and `notFoundHandler` build it; routes and services throw `DomainError`s.
- **204** is not enveloped: `c.body(null, 204)`, no body.
- **Lists** (not built yet): `data` is the array, pagination goes in an optional top-level `meta`.

Each rule and its reason:

- **`success` is true exactly when the HTTP status is 2xx.** Clients branch on one field, and
  TypeScript narrows the typed client on it.
- **The body's `status` always equals the HTTP status.** `ok()` takes the status as one argument
  and sets both the header and the body from it, so they cannot disagree.
- **503 is `success: false`.** `success` means "it worked". A degraded `/health` is a failure, even
  though it carries the report in `error.details`.
- **204 has no body.** By definition there is nothing to envelope.
- **`meta` is the slot for list pagination.** `data` is the payload for single items and lists
  alike, so a list never wraps `data` in another object, and paging info sits beside it.

### Types inferred from Drizzle
`type Track = typeof tracks.$inferSelect` in `tracks.types.ts`. Services import the type only,
which costs nothing at runtime. When an entity's stored shape and domain shape diverge, that one
entity gets a hand-written type and a mapper in its repository.

### Modules talk through services
A service may depend on another module's **service**, never its repository. Each repository is
private to its module, so its rules (e.g. "deleted users are invisible") cannot be bypassed.
No cycles: if two services need each other, extract a third.

### Presenters shape responses
`toTrackResponse(track)` picks the public fields. Services return full domain objects, internal
columns cannot leak by accident, and `AppType` (the frontend's typed client) reflects the public shape.

### Routes document themselves (OpenAPI)
Every route is declared with `defineRoute()` on an `openapiApp()` (`lib/openapi.ts`, built on
`@hono/zod-openapi`). The same zod schemas validate requests, generate the spec and type the
handler, so the compiler rejects a handler that returns a status or body its route does not
declare: the docs cannot drift from the code. `AppType`/`hc` keep working. A route's `security` names how it is guarded: `bearerAuth` for a user's access token, `adminToken` (the `X-Admin-Token` header) for the `/api/v1/admin` routes, `[]` for a public one.

### API versioning
Every API route is mounted under `/api/v1` (`API_V1_PREFIX` in `lib/api-version.ts`). `src/app.ts` builds one `v1` sub-app
(`/auth`, `/me`, `/products`, `/onboarding`, `/scans/products`, `/scans/faces`, `/admin`) and mounts it in the same `app.route(...)` chain as `/health`, so the typed client (`hc<AppType>(...)`) reaches
`client.api.v1.auth`, `client.api.v1.me`, `client.api.v1.products`, `client.api.v1.onboarding` and `client.api.v1.scans.products`. `/health`, `/docs` and `/openapi.json` stay at the root: they
describe the service, not the API contract. The unversioned paths are gone (the app had not shipped), so they 404 with the
usual `NOT_FOUND` envelope. A breaking change means a new `/api/v2` sub-app mounted next to v1, not an edit to v1.
Anything that builds a link to an API route starts from `API_V1_PREFIX` (the service's photo link does, via `productPhotoUrl`
in `modules/scans/scans.paths.ts`) rather than writing the path out.

Scans are named by what is scanned: this module is the **product scan**, at `/api/v1/scans/products` (operations
`createProductScan`, `getProductScan`, ..., tag "Product scans"); the **face scan** is at `/api/v1/scans/faces` (tag "Face scans", see "Face scans"). Only
the HTTP surface carries the name: the module directory, classes, tables, queues, Durable Object and error codes keep `scan`.

- **Schemas** for requests and responses live in `<feature>.schemas.ts`, built with the `z` from
  `@hono/zod-openapi` (it adds `.openapi()`). A response schema gets a component name
  (`.openapi('TrackResponse')`). The presenter's return type is `z.infer<typeof TrackResponse>`.
- **Every route** needs an `operationId` (the method name in generated clients) and `tags`
  (its group in Swagger UI); the types require both.
- **Errors**: one `ErrorResponse` component. `defineRoute` adds 500 to every route, 400 to any
  route with `request`, and 415 to any route with a body; a route lists the rest itself with
  `...errorResponses(401, 404)`.
- **Success** responses are declared with `success(Schema, description)` in `responses`, and the
  handler returns `ok(c, data, message, status?)`. The handler's return type is checked against
  that declaration, so a bare object cannot be returned.
- **Bodies** use `jsonBody(schema)`: it sets `required: true`, without which a request sent
  without a JSON Content-Type would skip validation. An upload uses `multipartBody(schema)` (same reason), read with
  `c.req.valid('form')`. A file field is `z.instanceof(File).openapi({ type: 'string', format: 'binary' })` (the generator cannot
  describe a `File`; `z.file()` would not type `name` or `arrayBuffer()` under workers-types), and Hono gives a single file bare,
  not in a list. Pair an upload with `bodyLimit` (`hono/body-limit`) in the route's `middleware`, which runs before the form is read.
- **Non-JSON responses** use `imageResponse(description)` (`image/jpeg` and `image/webp`, binary) and `sseResponse(description)`
  (`text/event-stream`) in place of `success(...)`. The handler returns a `Response` it builds with its own headers. Once any
  status of a route has such a content type, @hono/zod-openapi types the handler's whole return as `Response`, so the compiler no
  longer checks that route's bodies; the integration tests do. Errors still come out in the envelope.
- **413** (`errorResponses(413)`, "Request body too large") is thrown by `bodyLimit` as an HTTPException, which `errorHandler`
  renders as `HTTP_413`. `defineRoute` adds 415 to any route with a body, JSON or multipart ("The Content-Type of the body is not
  supported by this route"); a route lists 413 itself.
- **Invalid input** throws `ValidationError('VALIDATION_FAILED', …)` from the app's `defaultHook`, so
  it reaches the client through `errorHandler` like every other error.
- **Served** at `/docs` (Swagger UI, version pinned) and `/openapi.json` where `DOCS_ENABLED` is
  `"true"`: local and staging. Production 404s both until someone flips the var.
- **Committed** as `docs/openapi.json`, so each PR shows its API change as a diff. CI regenerates it,
  fails if stale, and lints it with Redocly (`redocly.yaml` lists each rule switched off, and why).
- `info.version` is the API contract's version, bumped by hand on a breaking change, not
  `package.json`'s (release-please would make the committed spec stale on every release).
- Enforced: `routes-must-be-documented` stops a `*.routes.ts` from importing `hono` or
  `lib/factory.ts`, so a plain, undocumented Hono app cannot be written.

### Request context in AsyncLocalStorage
*Your choice; the recommendation was passing `actor` as an explicit argument.* `lib/context.ts`
holds an `AsyncLocalStorage<RequestContext>` with `{ actor, requestId }`. The `requestContext`
middleware runs each request inside it. Services call `currentActor()` / `requireUser()` without
ever seeing Hono's `c`. Limits that keep the implicitness contained:

- **Only services read it.** Repositories and providers receive values as plain arguments.
- **Reading it outside a context throws.** Queue/cron handlers and tests wrap work in
  `runAs(actor, fn)`; a forgotten wrapper fails loudly instead of acting as "anonymous".
- **`Actor` is a tagged union**: `public | user { userId, status, profileId } | system`. Every request has one, and
  services narrow on `kind`. `public` means no usable token; a guest is a `user` with status
  `anonymous`. `RequestContext` also carries a `tokenProblem` (`missing | expired | invalid`) for
  `public` actors, which the guards turn into the right 401.

### Users and guests
`modules/users` owns identity. Its routes live in `modules/auth` (see Auth routes).

- **One `users` table** for guests and verified people. `status` is `anonymous` (a guest) or `verified`;
  `email` and `phone` are nullable and each unique; `token_version` starts at 0.
- **`devices` maps a hashed device id to the device's current guest.** The raw device id is never stored.
- **A device id only ever yields a guest.** If the device's account has been verified since,
  `guestForDevice` creates a new guest and re-points the device. Getting into a verified account always
  takes a code, so the device id is never a password.
- **Promotion is in place.** `promote` turns the calling guest row into a verified one (identifier set,
  token version + 1) as ONE conditional `UPDATE ... WHERE status = 'anonymous'`, so nothing moves between
  accounts. The unique index settles a race on the identifier (`taken`).
- **`existing`** is the answer when the identifier already belongs to another account: that account is
  returned and the calling guest is left untouched (its data is abandoned by decision).
- **Actor guards** (`lib/context.ts`): `requireUser()` accepts any user, guests included, and throws
  401 `AUTH_REQUIRED` (no token), `TOKEN_EXPIRED` or `TOKEN_INVALID`; `requireVerified()` also throws
  403 `VERIFICATION_REQUIRED` for a guest. Feature-specific locks stay in the feature's service.
- **Service errors:** `NOT_A_GUEST` (409, promoting an already verified user) and `USER_NOT_FOUND` (404,
  an unknown user, or an identifier that was taken but whose owner vanished). A verified user presenting
  their own identifier again gets `existing` back, with nothing written.
- **Accepted:** two simultaneous first bootstraps from one device can create two guests. The last write
  wins the device row; the loser is an unreachable guest, cleaned up later.

### Profiles
`modules/profiles` holds `profiles` (`id`, `user_id` with cascade, `display_name` null for now, `is_default`, `created_at`),
`D1ProfilesRepository` (`findById`, `defaultFor`, `ofUser`, `insert`) and `ProfilesService` (`defaultFor`, `ownedBy`, `of`).
It is identity only: later features (skin analysis, goals) keep their own tables keyed by `profile_id`.

- **Account vs profile.** The account is the `users` row (a guest or a verified user); a profile is one person's face
  inside it. Anything about a person belongs to a profile; sign-in, token version and quotas belong to the account.
- **The default is created with the user.** `createGuestForDevice`, the only place a user row is written, also writes the
  default profile (`is_default`, no name, `created_at` = the user's) in the same `db.batch` (user, profile, device), so a
  user never exists without one (but see "Rollout") and a profile id that is taken rolls everything back. A partial unique index on `(user_id)
  WHERE is_default = 1` keeps it to one default per user. Profiles go with their user (cascade), so guest cleanup needs no
  cleaner of its own. Migration 0011 backfilled one default per existing user.
- **The `pid` claim.** Both tokens carry the active profile's id, and the auth middleware puts it in the actor
  (`actor.profileId`), so services read the profile as they read the user and no route passes it around. Bootstrap, logout
  and signing in as an existing account issue the user's default; a promoted guest keeps the profile it was on.
- **Transition rule.** An access token that passes every other check but has no `pid` at all is `expired` (401
  `TOKEN_EXPIRED`), which the app already answers by refreshing; a `pid` that is present but is not a non-empty string is
  `invalid`. A refresh token without a `pid`, or with an unusable one, is accepted and gets the default profile. Nobody is
  signed out, and after one refresh every token carries a `pid`.
- **Refresh fallback.** `AuthService.refresh` keeps the refresh token's profile when `ProfilesService.ownedBy(user, pid)`
  finds it, and otherwise uses the user's default, so a deleted or foreign profile can never wedge a session.
- **Ownership.** `scans.profile_id` (migration 0012) is the profile that made the scan. Nullable in SQL with no foreign key,
  because adding a NOT NULL or REFERENCES column to `scans` would take a table rebuild, which can cascade-delete `scan_items`;
  the code always sets it (`NewScan.profileId`) and 0012 backfilled it from each user's default profile. Only that profile may
  read the scan, its items, its photo links (minted only inside an owned view) and its event stream; anyone else gets the
  404 `SCAN_NOT_FOUND` another user would get. A link already minted works until it expires (5 minutes).
- **Quotas stay per account.** The daily photo quotas count by `user_id` (and by IP), so extra profiles cannot multiply AI spend.
- **No routes yet.** Creating, switching, renaming and deleting profiles are not built; `GET /api/v1/me` is the only place profiles
  show.
- **Rollout.** Deploys apply migrations (0011 profiles, 0012 `scans.profile_id`) before the new Worker goes live, and if a
  deploy fails after migrating the window lasts until one succeeds. In it the OLD Worker still creates users with no profile
  and scans with `profile_id` NULL, and the backfills have already run. The new code takes both over:
  - **Self-healing default.** `ProfilesService.defaultFor` creates the default (new id, no name, `is_default`, `created_at` =
    now) when the user has none, and logs `{ outcome: 'default-profile-created', userId }`. So bootstrap, refresh and signing in
    to a profile-less account work and make the profile on the spot. Two simultaneous callers race on the partial unique
    index; the loser reads the winner's profile. For a user that does not exist the foreign key refuses the insert and that
    error surfaces (the auth paths read the user first).
  - **Orphan scans.** The 10-minute reaper (`ScanService.reap`) first runs `ScansRepository.adoptOrphanScans(500)`: one UPDATE
    that gives each scan with `profile_id IS NULL` (read through `(profile_id, created_at)`, oldest first) the default profile
    of its owner, and logs `{ outcome: 'orphan-scans-adopted', count }` when it changed any. A scan whose owner has no
    default is not a candidate, so it does not use up the 500; it stays NULL, and so unreadable, until a later sweep after the
    owner's next session has made the default. A failure is logged `{ outcome: 'orphan-adopt-failed' }` and the rest of the
    sweep runs. The repository reads `profiles`, another module's table, because no service call can say which scans these are.
  - **Tokens without `pid`.** Tokens the old Worker issued carry no `pid`: the access token is `expired` and the refresh token
    is accepted, so one refresh upgrades the session (see "Transition rule"). Nobody is signed out.
  - **`GET /api/v1/me` changed shape**: the user's fields moved under `user`, next to `profile` and `profiles`. The app ships with
    the change, so an app build from before it misreads `/api/v1/me` from this deploy on; release them together.
- **No routes yet.** Creating, switching, renaming and deleting profiles are not built; `GET /api/v1/me` is the only place profiles
  show.

### Guest cleanup
A daily cron (`triggers.crons` in `wrangler.jsonc`, 03:17 UTC, restated in each env block) runs
`UsersService.purgeUnreachableGuests` through the Worker's `scheduled` export (routed by `createScheduledRouter` to `createScheduledHandler` in
`jobs/dispatcher.ts`), as the system actor `guest-cleanup`.

- **What goes:** guests (`status = 'anonymous'`) that no `devices` row points at and that were last seen more
  than 90 days ago (strictly: exactly 90 days is kept). Their device rows go with them (cascade). Verified
  users are never selected, and `deleteUsers` re-checks `status = 'anonymous'`, so a user row is never
  deleted after a promotion. Cleaners run before that check, so in theory a promotion between the select and
  the cleaners could lose that guest's data; in practice it cannot happen, because a guest idle for 90 days
  holds no valid refresh token (60-day lifetime) and no device re-links to an old guest.
- **How much:** batches of 500, at most 5000 per run; the next day's run takes the rest.
- **Cleaners:** a module that stores per-user data adds a `GuestDataCleaner` (`{ name, deleteFor(userIds) }`)
  to `guestDataCleaners` in the container (data whose foreign key cascades from `users`, like profiles, push tokens and notification settings, needs none). Every cleaner sees each batch BEFORE the user rows are deleted, so
  data never outlives its owner; make them safe to repeat. A cleaner that throws aborts the run and that
  batch's users stay for the next run.
- **Failure:** logged as `{ job: 'guest-cleanup', outcome: 'failed', error }` and rethrown so Cloudflare
  records the cron as failed.
- **The same cron also sweeps the safety parses** (`createDailyJobs` in `jobs/scheduled.ts`): after the cleanup it calls `SafetyService.requeueDueParses`, which queues the
  parse-safety job for every pending parse whose due time has come (see "Safety facts (onboarding)"). Neither runs inside the other: a cleanup that throws does not stop the
  sweep, nor a sweep that throws the cleanup, and the first failure is rethrown after all have run so Cloudflare records the cron as failed. The sweep logs
  `{ job: 'safety-parse-requeue', outcome: 'done', queued }` (only when it queued something) or `{ ..., outcome: 'failed', error }`.
- **A third step sends the check-in-due pushes** (own try, after the safety sweep): `FaceScanService.sendDueCheckIns(new Date())` (see "Face scans", "Check-in push"). It logs
  `{ job: 'face-check-in-push', outcome: 'done', queued }` when it queued something, or `{ ..., outcome: 'failed', error }`, and a failure here is rethrown only if nothing before it failed.
- **A fourth step queues the fit retries** (own try, last): `VerdictService.requeueDueFits(new Date())` (see "Shelf verdict"). It logs `{ job: 'verdict-fit-requeue', outcome: 'done', queued }` when it
  queued something, or `{ ..., outcome: 'failed', error }`, and a failure here is rethrown only if nothing before it failed.

### Tokens and the auth middleware
`lib/jwt.ts` signs and verifies HS256 JWTs with WebCrypto (no package); `modules/auth/tokens.service.ts`
(`TokenService`) issues and verifies the two kinds. The `auth` middleware turns a bearer token into the actor.

- **Two tokens**: a 15-minute access token (`sub`, `st` status, `ver` token version, `pid` active profile, `typ: access`)
  and a 60-day refresh token (`sub`, `ver`, `pid`, `typ: refresh`). `typ` keeps them apart: a refresh token as a bearer,
  or an access token at refresh, is `invalid`. `pid` is covered in "Profiles".
- **HS256 with a key id.** The header carries `kid` (first 16 hex of SHA-256 of the secret), so verification picks
  the secret by `kid`. `JWT_SECRET` signs; `JWT_SECRET_PREVIOUS`, when set, verifies only. Rotating therefore signs
  nobody out. The algorithm is checked strictly, the signature in constant time, and `expired` is reported only
  after the signature is valid, so a forged expired token is `invalid`.
- **`token_version` is checked only at refresh**, by `AuthService.refresh`, which compares the token's `ver`
  with the user's row. `TokenService` has no database access, and the middleware does no database read.
- **The middleware never rejects.** It runs after `container` (it needs `services.tokens`; the container is lazy, so
  this is cheap) and before `requestContext`, so it (like any middleware before it, such as a future rate limiter)
  runs outside the request context and must not call services that read `currentActor`/`requireUser`, and stores `c.var.auth = { actor, tokenProblem? }`. No header is
  `missing`; a non-Bearer scheme, a bad or wrong-type token is `invalid`; a correctly signed but old one is
  `expired`. An expired token must not block `/api/v1/auth/refresh`, and public routes ignore the header. The guards turn
  the problem into `AUTH_REQUIRED`, `TOKEN_EXPIRED` or `TOKEN_INVALID` (401), and a guest on a verified-only route
  into `VERIFICATION_REQUIRED` (403).
- **Secrets**: `JWT_SECRET` and `DEVICE_ID_KEY` are required (different per environment); `DEVICE_ID_KEY` must never
  rotate.
- **Accepted risks**: a stolen refresh token works until the user logs out (it slides for up to 60 days); a logout
  reaches the user's other devices within 15 minutes, when their access tokens expire and their refresh fails.

### Auth routes
`modules/auth` holds `AuthService` (the only place that combines users, otp and tokens), `auth.routes.ts`
(`/api/v1/auth/*`, plus `GET /api/v1/me` as its own sub-app) and the schemas and presenter. All of it goes through services.

| Route | Caller | Rate limit (per 60 s) |
| --- | --- | --- |
| `POST /api/v1/auth/anonymous` | public: starts a guest session for `{ deviceId, platform }` | 10 per IP |
| `POST /api/v1/auth/otp/send` | bearer (guests included) | 3 per IP and 3 per user |
| `POST /api/v1/auth/otp/verify` | bearer: promotes the guest, or signs in as the address's owner | 10 per IP |
| `POST /api/v1/auth/refresh` | public: `{ refreshToken }`; the Authorization header is ignored | 30 per IP |
| `POST /api/v1/auth/logout` | bearer: bumps the token version, returns a fresh guest for `{ deviceId, platform }` | shares bootstrap's 10 per IP (it creates guests) |
| `GET /api/v1/me` | bearer | none |
| `PUT`/`DELETE /api/v1/me/push-token`, `GET`/`PATCH /api/v1/me/notification-settings` | bearer (guests included); see "Push tokens and notification settings" | none |
| `PUT`/`GET /api/v1/me/goal`, `GET /api/v1/me/onboarding` | bearer (guests included); see "Goals (onboarding)" | none |
| `PUT`/`GET /api/v1/me/safety` | bearer (guests included); see "Safety facts (onboarding)" | none |
| `PUT`/`GET /api/v1/me/shopping` | bearer (guests included); see "Shopping facts and candidates" | PUT: 20 per IP and 10 per user; GET none |
| `GET /api/v1/onboarding/content` | public: a token is ignored; see "Onboarding content" | none (cached) |

- **Sessions** are `{ tokens: { accessToken, refreshToken, accessExpiresAt, refreshExpiresAt }, user }`; they do not carry the
  profile (the app reads it from `GET /api/v1/me`). Refreshing slides the refresh token's 60 days.
- **`GET /api/v1/me`** answers `{ user, profile, profiles }`: the user, the profile the session is on, and every profile of the
  account (default first). A session whose `pid` is not among the user's profiles gets 401 `TOKEN_EXPIRED`.
- **Device ids are HMAC'd** with `DEVICE_ID_KEY` before they reach the database; the raw id is never stored.
- **Logout and a guest's sign-in drop push tokens** (see "Push tokens and notification settings"): logout deletes every push token of
  the account, and signing in as an existing owner deletes the leaving guest's.
- **A guest's sign-in alerts the account.** After the guest's rows are deleted, `verifyOtp` queues the `new-sign-in` push for the account that was
  signed in to, with the platform of the deleted phone and the time of the sign-in (see "Sending push notifications" → "What triggers a push").
  It is always sent (no setting) and never fails the sign-in. The alert is not sent for promotion in place or for a verified user re-verifying their own address.
- **Verify and logout unlink the user's devices**, so the device's next bootstrap creates a new guest rather than
  returning data that belonged to the pre-login (or just logged-out) identity.
- **Linking is refused up front.** A verified caller using an address nobody owns gets 409 `ACCOUNT_LINKING_UNAVAILABLE` from send and verify, before a code is sent or consumed (checked against the user's row, not the token's status). A guest that signs in as an existing owner has its token version bumped, retiring its refresh token.
- **Rate limits** are Workers rate-limit bindings (`ratelimits` in `wrangler.jsonc`, restated in every environment
  block), applied by `rateLimit(binding, 'ip' | 'user')` (`middleware/rate-limit.ts`) as route middleware in
  `defineRoute`. It runs after `auth`, outside the request context, so it reads `c.var.auth`, never
  `currentActor()`. IP comes from `cf-connecting-ip`; the user key is skipped for a public caller (a route that must refuse them puts `signedIn()`, `middleware/signed-in.ts`, before it; a route that must also refuse guests uses `verifiedUser()`, `middleware/verified-user.ts`). Over the limit
  is 429 `RATE_LIMITED` with `Retry-After: 60`. A `namespace_id` is an account-wide counter, so each binding in
  each environment has its own. Counts are per Cloudflare location and approximate: the OTP per-recipient cooldown
  and cap still apply underneath.
- **OpenAPI**: the `bearerAuth` scheme is registered in `mountDocs`. Protected routes declare
  `security: [{ bearerAuth: [] }]`; public routes (including `/health`) declare `security: []`.

### Unit and integration tests
Both run inside workerd via `@cloudflare/vitest-plugin`; they differ in scope.

- **Unit** (`src/**/*.test.ts`): a service with in-memory fakes. Fakes are written once per
  interface and reused; tests assert outcomes, not call sequences.
- **Integration** (`test/integration/`): repositories against real local D1 with every migration
  applied, and the whole Worker through its entrypoint with the frontend's typed client. The files run one
  at a time (`fileParallelism: false` in `vitest.config.ts`): a parallel full run hangs at the end in the
  workers pool after every test has passed. Unit tests stay parallel. CI splits the files across four shards
  (`vitest --shard=i/4`), each run one file at a time.
- **Contracts**: `<feature>.repository.contract.ts` runs against the fake (unit) and the D1
  implementation (integration), so the fake cannot drift from the real thing.
- No test may need a secret or reach a real service.

### Rules enforced by dependency-cruiser
*Your choice; the recommendation was ESLint import rules.* `.dependency-cruiser.cjs` carries one
rule per boundary above, each with a comment explaining it. Every rule was checked to fire
against a deliberately violating file.

It needs **TypeScript ≤ 6**: dependency-cruiser reads TS through the compiler's JS API, which
TypeScript 7 (the Go port) does not ship yet. On TS 7 it checks 0 modules and passes, so CI
fails the Architecture job if it ever reports 0 modules.

### Static assets (R2)

Files the outside world must fetch by URL (today the email logo) live in `assets/` and are synced to the R2
bucket `deepertones-assets`, served at `assets.deepertones.com`, by `.github/workflows/sync-assets.yml`.
`deepertones-assets` is the one public bucket for everything public: the CI sync owns `email/` and every other key
that comes from `assets/`, and the Worker owns `catalog/<environment>/…` (see "Catalog images"). The two never
overlap, because the sync refuses, before uploading anything, any local file whose key starts with `catalog/`.

- One bucket for every environment: the files are public and identical, so per-env buckets would only drift.
  Catalog images share it too, separated by key prefix rather than by bucket.
- Synced by CI from the repo, not uploaded by hand: the folder is the source of truth and a manual upload
  nobody ran looks exactly like one that failed.
- Runs on merges to `staging` only, and manual runs only from `staging`: `main` receives what staging
  already had, so syncing from it could roll a shared asset back.
- `_sync-manifest.json` is public (it lists asset keys), so nothing secret may go in `assets/`. Objects edited
  or deleted by hand in the dashboard are not noticed until a `--force` run.
- Idempotent through a hash manifest (`_sync-manifest.json`) in the bucket, so unchanged pushes write nothing.
- Never deletes: removed files are reported as orphaned. An email already sent still points at its images.
- The sync is a Node script over the Cloudflare REST API (`scripts/assets`), not wrangler, so it can create the
  bucket and domain, and its logic is unit-tested against a fake client. It is outside `src/`, so it is not a
  Worker module and the layering rules do not apply to it.
- SVG is rejected: Gmail and Outlook do not render it.

### Email templates

Everything about how an email looks lives in `src/emails/`. `html.ts` is the escaping `html` tag (every
interpolation is escaped unless it is `SafeHtml`). `brand.ts` holds the name, colours, fonts and logo URL.
`components/` are small functions returning `SafeHtml` (layout, header, footer, paragraph, code box).
`templates/<name>.ts` is one file per email: `defineTemplate({ render(data) -> { subject, preheader?, body }, sample })`,
registered in `registry.ts`. Callers use `renderEmail(name, data)`; name and data are type-checked, and the
plain-text part is generated from the HTML (never written by hand). `npm run emails:preview` writes every
template's sample to `.email-preview/` and opens it. The `emails-are-pure` rule keeps `src/emails/` free of
modules, providers, jobs, middleware and wiring: templates are pure functions of their data. The logo is a
PNG on R2 at `assets.deepertones.com` (see README, "Email assets").

### Email (ZeptoMail)
Transactional email goes through ZeptoMail (Zoho), behind an `EmailSender` port with one adapter,
`ZeptoMailEmailSender`, and a memory fake for tests. One shared sender is built in the container,
because later modules will send email too.

- **Our own templates, in `src/emails/`** (see "Email templates" above). Modules render with
  `renderEmail(name, data)` and pass the result to the sender. *Why:* a template is code that must
  change with the feature, so it is typed code the compiler checks, instead of living in a vendor
  dashboard. `html` escapes every interpolated value by default and the shared layout is the one
  header and footer, so a template cannot forget to escape or drift from the brand.
- **Sender `no-reply@mail.deepertones.com`.** The subdomain keeps the reputation of app mail apart
  from anything sent from the main domain.
- **Tracking is off** (no open or click tracking): sign-in mail needs neither, and rewritten links
  hurt trust in a message that carries a code.
- **No retries in the adapter.** A retry is the caller's decision: the `deliver-otp` job already
  retries with backoff, and a blind retry inside the adapter could send the same email twice.
- **The adapter classifies, the caller decides.** A rejected recipient address, a 5xx and a 429 become
  `EmailDeliveryError` (`recipient-rejected` or `unavailable`). A bad key, an unverified sender
  domain, no credits, an account not yet approved (and any other rejection that is not the recipient,
  or an empty setting) become `EmailDeliveryError` `misconfigured`: our own setup is wrong and a human
  must fix it, so retrying cannot help.

### Push notifications (Expo)
Push notifications go through the Expo Push Service, behind a `PushSender` port (`providers/push/push.provider.ts`) with one
adapter, `ExpoPushSender` (`expo.push.ts`), and a memory fake, `MemoryPushSender`. The port file also exports
`isExpoPushToken`, a pure token-shape check, because services may not import an adapter. The tokens and settings
(see "Push tokens and notification settings") are stored and routed, and the container builds the `ExpoPushSender` with `EXPO_ACCESS_TOKEN`.
The send and receipt jobs are in "Sending push notifications"; the scan and sign-in flows that queue them are listed there under "What triggers a push".

- **Why Expo.** The app is an Expo (React Native) app and registers an Expo push token; Expo's service then reaches Apple
  and Google with the credentials uploaded to Expo/EAS. The backend never talks to APNs or FCM.
- **Why not the official `expo-server-sdk`.** This is an explicit exception to the preference for a vendor's official SDK over
  hand-rolled HTTP (see "Claude (Anthropic) providers"). The SDK imports `fetch` from `undici`, which Workers cannot run, and it
  retries internally, which the job system already does (see "Outbound HTTP": no retries in adapters). So the adapter calls Expo's
  documented endpoints through `requestJson$` + `firstValueFrom`, and the access token is the only thing it sends beyond them.
- **Two calls.** `send(messages)` posts to `https://exp.host/--/api/v2/push/send` and returns one ticket per message, in order: `ok`
  with the id Expo assigned, or an error with a reason. `receipts(ids)` posts to `.../push/getReceipts` and returns receipts by ticket
  id; an id Expo has no receipt for yet is left out. Every message is sent with the default sound. A message may carry a `categoryId`, which the adapter forwards as Expo's `categoryId` (it is how the phone shows the category's actions, the routine reminder's "Done"); it is left out of the request when the message has none.
- **Batching, at-most-once.** Expo takes at most 100 messages per send and 1000 ids per receipts call, so the adapter splits a larger call
  in order and merges the answers. A push cannot be taken back, so a retry must never resend what already went out. Only the FIRST
  request's failure rejects `send()` or `receipts()`: nothing has gone out, so the job's retry resends safely. After that, a failed
  request no longer throws. Its messages come back as error tickets (`unavailable` for transport, timeout, 429 and 5xx;
  `misconfigured` for any other status) and, for receipts, its ids are left out, so the caller keeps the tickets of what was sent.
  A notification targets a handful of phones, so one request is the normal case and this is the edge.
- **Errors, in three kinds.** A problem with one message is a value: the ticket or receipt is `{ status: 'error', reason }` with
  `device-not-registered` (Expo's `DeviceNotRegistered`: delete the token), `rate-limited` (`MessageRateExceeded`), `misconfigured`
  (`InvalidCredentials`, `MismatchSenderId`: our credentials are wrong), `unavailable` (the request carrying it failed after the first) or
  `other` (everything else, including codes Expo adds later). A problem with the first request that may pass is `PushUnavailableError`:
  transport failure or timeout, 429, 5xx. A problem that will not pass is a plain `Error` (any other HTTP status: credentials, a bad
  request; or `EXPO_ACCESS_TOKEN` empty or containing whitespace, which is refused before any request), for the job to fail permanently
  and log. Messages carry the HTTP status and Expo's request-level codes (only code-shaped ones) and nothing else: never the access
  token, a push token, the notification text or Expo's own `message`.
- **A malformed 2xx reply never throws.** If Expo answers 2xx with something that is not a ticket for every message (not an array, the
  wrong count, an unknown status, an ok ticket with no id, not JSON), Expo may well have sent them, so a throw would make the job's retry
  send a duplicate. That batch's messages get `other` instead. For receipts, an unreadable reply leaves its ids out and one unreadable
  entry leaves out just that id; the receipt check is advisory.
- **Token shape.** `isExpoPushToken` accepts `ExponentPushToken[...]` and `ExpoPushToken[...]` with no whitespace anywhere and at most 256
  characters.
- **Enhanced security and `EXPO_ACCESS_TOKEN`.** With "Enhanced security for push notifications" on in the Expo project, Expo refuses a
  send or receipts call without a robot-user access token, so a leaked push token cannot be used to message our users. The token
  is the required secret `EXPO_ACCESS_TOKEN` (per environment, like the other required secrets; see README, "Expo push setup"). The
  adapter holds it in a `#` field (see "Private members").
- **Tests** stub `fetch` at the global (the adapter) or use the fake directly. `MemoryPushSender` records `sent`, answers every message
  with an `ok` ticket numbered `ticket-1`, `ticket-2`, ..., and can script a ticket per token (`ticketFor`; a scripted ok ticket's id is known
  to `receipts()`), a receipt per ticket id (`receiptFor`) and the next failure of `send` (`failNextWith`) or `receipts` (`failNextReceiptsWith`).

### Push tokens and notification settings
`modules/notifications` holds `push_tokens` and `notification_settings` (migration 0015), `D1PushTokensRepository`,
`D1NotificationSettingsRepository` and `NotificationsService`. It stores who may be notified and what they want; sending is in "Sending push notifications".

- **One row per phone.** `push_tokens` is keyed by `device_hash`, the HMAC of the device id with `DEVICE_ID_KEY`, the same hash as
  `devices` (the container gives `NotificationsService` the same key, held in a `#` field), so a phone is one row however often it registers.
  The row has the Expo `token` (unique), `platform`, `user_id`, `profile_id` (both cascade) and `created_at`/`updated_at`. A raw device id is never stored.
- **The profile comes from the session's `pid`.** The app never says whose phone it is: `register` reads the account and profile from the actor, so
  a profile switch moves the phone by registering again. The app registers after every sign-in, logout, profile switch and token refresh.
- **A token moves.** The repository's `upsert` is ONE `db.batch`: delete any OTHER row holding the token (the unique column would refuse the
  insert), then insert the device's row or update it to the new token, platform, account, profile and time. `created_at` is kept on update. If the
  write fails the delete rolls back, so a token is never lost half-moved. So registering the same device from another account moves it, and a
  reinstalled app (new device id, same token) takes the token from the old row.
- **Token shape is checked in the service**: `isExpoPushToken` (from the push provider's port file) else 400 `PUSH_TOKEN_INVALID`; the schema
  separately caps it at 256 characters (`VALIDATION_FAILED`).
- **Logout drops the whole account's tokens.** Logout signs out every phone of the account (token version bump, devices unlinked), so
  `AuthService.logout` calls `accountSignedOut(userId)`, which deletes every row of the user on all profiles. Each phone registers again under the
  guest it is handed next; none keeps receiving the old account's notifications.
- **A guest's sign-in drops the guest's tokens.** `verifyOtp` carries no device id, so the phone cannot be named. But at that moment its row still
  belongs to the calling guest, so when the outcome is `existing` and the caller was a guest, `guestSignedIn(actor.userId)` deletes the guest's rows. The
  phone registers again under the account it signed in to. A guest promoted in place, and a verified user signing in again with their own address,
  keep their rows.
- **A signed-out phone can register again for up to 15 minutes.** Access tokens are not version-checked (see "Tokens and the auth middleware"),
  so after logout the old session still passes `PUT /push-token` until its access token expires, and the row it writes belongs to the old
  account. It is cleaned up when the phone registers again under its new session (the same device hash moves to the new account) or when
  Expo reports the token dead.
- **Register moves, unregister only deletes your own.** `register` moves any device's row to the caller, by design: one row per device,
  whoever held it. `unregister` deletes the row only when it belongs to the caller; another account's row is left alone.
- **Settings are per account**, shared by its profiles: `notification_settings` (`user_id` PK, cascade, `scan_finished`, `scan_needs_you`, default on,
  `updated_at`). There is no row until the first change, so reading writes nothing and answers both on. A change is one upsert that writes only the
  switches named, so a second change is not undone by a stale read.
- **Routes**, all bearer (guests included), under `/api/v1/me` and tagged "Notifications": `PUT /push-token` `{ deviceId, platform, token }` (204),
  `DELETE /push-token` `{ deviceId }` (204, idempotent; another account's row is left alone and still 204), `GET /notification-settings` and
  `PATCH /notification-settings` (at least one of `scanFinished`, `scanNeedsYou`). Both answer `{ scanFinished, scanNeedsYou }`.
  They are a second `.route('/me', ...)` in `src/app.ts`, next to `GET /me`.
- **No cleaner and no rate limiter.** Rows cascade from `users`, so guest cleanup deletes them. The routes need a session, and a row is only ever
  written for the caller.

### Sending push notifications
Two jobs in `modules/notifications` (specs in `notifications.job-specs.ts`, handlers in `notifications.jobs.ts`, logic in
`NotificationsService`), each on its own queue with its own dead-letter queue like every job: `send-push` on `push-delivery` and
`check-push-receipts` on `push-receipts`. That is four more queues per environment, in all three `wrangler.jsonc` blocks
(env blocks do not inherit), created before the first deploy that binds them (README, "Before the first deploy").

- **The trigger methods enqueue and never fail the caller.** `scanFinished`, `scanNeedsYou`, `faceScanReady`, `faceScanNeedsRetake`, `faceCheckInDue`, `routineReminder`, `stepDownAlert`, `missedDaysNudge` and `newSignIn` queue a `send-push` job
  and, if the enqueue throws, log `{ outcome: 'push-enqueue-failed', kind, scanId?, faceScanId? }` and return: a scan step or a sign-in must not fail
  because a push could not be queued. (Who calls them, and when, is in "What triggers a push".)
- **The body carries the kind and ids only**, never a token, text or link: those are worked out when the job runs, so a logout, a
  profile switch or a changed setting between the event and the send is respected. The body is a union on `kind`
  (`NOTIFICATION_KINDS`): `scan-finished` (user, profile, scan, `readyCount`), `scan-needs-you` (user, profile, scan, item, `need` of
  `back-photo`, `confirm` or `identify`, optional `ask`), `new-sign-in` (user, `platform` or null, `eventId`, `at`), `face-scan-ready` (user, profile, `faceScanId`) and
  `face-scan-needs-retake` (user, profile, `faceScanId`, `reason` of `REJECTED_PHOTO_REASONS`, `at`), `face-check-in-due` (user, profile, `dayOneScanId`), `routine-reminder` (profile, `day`, `time`, `title`; no user: it belongs to the profile), `step-down-alert` (profile, `day`, `changes`: one or more `{ title, line }`), `missed-days-nudge` (profile, `since`) and `pause-check-in` (profile, `pauseId`, `checkDay`). The routine reminder, the step-down alert and the pause check-in also carry an optional `inboxId`, the id of the inbox row for the same thing.
- **One idempotency key per notification occurrence**, so a repeated message sends nothing: `scan-finished:<scanId>`;
  `scan-needs-you:<scanId>:<need>` (ten items needing a back photo, or needing identifying, are ONE notification each, linking to the first item that asked);
  `scan-needs-you:<scanId>:<itemId>:ask-<n>` for the n-th re-ask of an item after an unreadable back photo (`ask` 0 or absent is the
  first ask); `new-sign-in:<eventId>`; `face-scan-ready:<faceScanId>` (a scan becomes ready once);
  `face-check-in-due:<dayOneScanId>` (a chase is told once); `routine-reminder:<profileId>:<day>:<time>` (one per profile, local day and time); `step-down-alert:<profileId>:<day>` (one per profile and local day, whatever it lists); `missed-days-nudge:<profileId>:<since>` (one per run of missed days); `pause-check-in:<profileId>:<pauseId>:<checkDay>` (one per check day of a pause: a check day that moves is a new push); `face-scan-needs-retake:<faceScanId>:<at>` (`at` = the `updatedAt` written by the transition, epoch ms: retakes are unlimited, so each rejection is its own
  notification). `newSignIn` takes an optional `eventId`: without one it is a fresh id per call, so each alert is
  sent; a caller that passes the sign-in's own id (a session id, say) makes a repeated call for the same sign-in the same notification,
  deduplicated by the key. The receipt job's key is its ticket ids.
- **The routine reminder** (`routine-reminder`, #217 PR 4b) is the one kind that is not about a scan and the one body that carries text: `title` is the entry titles the reminder lists (already past the wording gate, joined with `, `; 1 to 200 characters), since only the send job knows which entries are due. It is never logged: a failed enqueue logs `{ outcome: 'push-enqueue-failed', kind, profileId }`. `NotificationsService.routineReminder({ profileId, day, time, title })` queues it (and answers whether it was queued), and `hasPhone(profileId)` says whether any phone is registered for the profile (the send job reads it before it claims). `deliver` sends to every phone of the PROFILE (`forProfile`, whatever account row it sits under) and only when `RemindersService.enabledFor(profileId)` says reminders are on at the time of the send (an optional `reminders` dep, wired in `container.ts`; without it no reminder is sent). The account's scan switches never gate it, and it does not read them. The message is the title, a fixed body per time of day ("Time for your morning routine" / "Time for your evening routine"), `categoryId: 'routine-reminder'` (the app registers that category with its "Done" action) and `data: { kind, url: '/routine', profileId, day, time }`: the `day` and `time` are what "Done" posts to `POST /me/routine/check-ins`. Tickets, dead tokens, receipts and retries are as for every kind. Who queues it is "Reminders" → Sends.
- **The step-down alert and the missed-days nudge** (`step-down-alert` and `missed-days-nudge`, #217 PR 4c) belong to the profile like the routine reminder and go to every phone of it (`forProfile`). The alert's body carries text, `changes` (each the product's routine title and the step's fixed line, past the wording gate; never logged: a failed enqueue logs `{ outcome: 'push-enqueue-failed', kind, profileId }`); the nudge's carries only `since`. `NotificationsService.stepDownAlert({ profileId, day, changes })` and `missedDaysNudge({ profileId, since })` queue them and answer whether they were queued. `deliver` gates each on ONE read of the optional `reminders` dep when the job runs, `RemindersService.stepDownAlertsFor` / `missedDaysNudgeFor` (reminders on AND the kind's own switch; without the dep nothing is sent), so a switch turned off after queueing drops the push; the account's scan switches never gate them. The alert is a fixed title ("A change in your routine today") and a body of one `<title>. <line>` per change, in order, with `data: { kind, url: '/routine/step-down', profileId, day }`. The nudge is fixed copy that is kind and blames no one ("Pick up where you left off" / "Your routine is here whenever you are ready."), the same for every run, with `data: { kind, url: '/routine', profileId }`. Neither has a `categoryId` (there is no "Done" on them). Who queues them is "Reminders" → Sends.
- **`inboxId` and the pause check-in** (#233, PR 8b). A push that is the delivery of an inbox row names it: `data.inboxId` is the row's id, added to the routine reminder's and the step-down alert's `data` (and left out, not set to undefined, when the row could not be written), so the app can post it to `POST /me/inbox/{id}/read` when the push is tapped. The words of the reminder and the alert are defined once, in `notifications.copy.ts` (a leaf file with no imports), and the row the job writes uses the same functions, so a row and its push cannot differ. `pause-check-in` is the push for a check-in after a pause that is due (`NotificationsService.pauseCheckIn({ profileId, pauseId, checkDay, inboxId? })`): it belongs to the profile, goes to every phone of it (`forProfile`), and is gated by `RemindersService.enabledFor` read when the job runs, like the routine reminder. Its words are the same for every pause ("Time for your check-in" / "Tell us how your skin has been since your pause."): the lock screen never names the step or the product. Deep link `/routine` (static, in `deep-links.json`); `data: { kind, url, profileId, pauseId, inboxId? }`. There is no account switch and no new setting for it.
- **What triggers a push.** Only a guarded update that APPLIED notifies, and the call comes after the update (never inside it), so a repeated or
  late step, or a step that lost a race, says nothing. `ScanService` takes `NotificationsService` (a type-only import; the dependency runs one way) and calls:

  | Where | When | Call | Key |
  | --- | --- | --- | --- |
  | `recognise` | the item moved to `needs-confirmation` | `scanNeedsYou({ need: 'confirm' })` | `scan-needs-you:<scanId>:confirm` |
  | `recognise` | the 3rd front photo could not be read and the item moved to `needs-identification` (not for the first two, which ask for a retake, nor for a rejected photo) | `scanNeedsYou({ need: 'identify' })` | `scan-needs-you:<scanId>:identify` |
  | `research` | `not-found` and the item moved to `needs-back-photo` | `scanNeedsYou({ need: 'back-photo' })` | `scan-needs-you:<scanId>:back-photo` |
  | `labelUnreadable` | the item moved back to `needs-identification` when it has no product, else to `needs-back-photo` | `scanNeedsYou({ need: 'identify' \| 'back-photo', ask: n })` (`identify` when it has no product), `n` = the item's back-photo count at the time of the re-ask | `scan-needs-you:<scanId>:<itemId>:ask-<n>` |
  | `sendDone` | the call's `markScanDone` applied | `scanFinished({ readyCount })`, `readyCount` = the items in `ready` | `scan-finished:<scanId>` |
  | `FaceScanService.copyResults` | `completeFaceScan` returned true | `faceScanReady()` | `face-scan-ready:<faceScanId>` |
  | `FaceScanService.needRetake` | the conditional `analysing` to `needs-retake` update applied (upload or fetch step) | `faceScanNeedsRetake({ reason, at })` | `face-scan-needs-retake:<faceScanId>:<at>` |
  | `FaceScanService.sendDueCheckIns` | the daily cron: a chase at its review point whose `recordCheckInPush` landed | `faceCheckInDue({ userId, profileId, dayOneScanId })` | `face-check-in-due:<dayOneScanId>` |
  | `AuthService.verifyOtp` | a guest signed in to an existing account | `newSignIn({ userId: <account>, platform, at })` | `new-sign-in:<eventId>` |

  A face scan that ends `failed` (any path) notifies nothing, nor does the Fitzpatrick step, a retake or a create. An item that ends `failed` after the last allowed back photo notifies nothing. Ten items needing a back photo are ONE push (the first item's key wins; the job system drops the
  rest), linking to the first item that asked.
  - **Keys.** `userId` and `profileId` are the scan row's (a step runs as a system actor, so there is no session to take them from).
    `notifyNeedsYou` reads the scan for them after the update; that read is guarded (a failure is logged as
    `{ outcome: 'push-failed', scanId, itemId }`), because the item has already moved and a throw would be retried into a no-op.
  - **Finished goes before the live `done`.** `sendDone` queues the push, then publishes `done`. The person may have closed the app, so the push must
    not depend on the live stream being up or the publish succeeding; if the order were the other way a failing publish would skip it. The
    call that SET the done time is the only one that pushes: `watch` re-sending `done` to a late client (time already set) does not, but
    `watch` and the reaper, when they are the call that sets it, do. The push's reads (the scan, and the items when the caller has none in hand: the reaper) are guarded on their own:
    if they throw, `push-failed` is logged, `done` is still published, and the done time is cleared again so the reaper re-claims it and queues the push again; the step does not fail. The done time can be cleared
    and set again (a failed publish, a reaper re-claim), which queues `scan-finished:<scanId>` again; the key makes the repeat free.
  - **Orphans are skipped.** A scan with no profile (written by the old Worker, before `adoptOrphanScans` gave it one) has no phones to tell:
    nothing is queued and `{ outcome: 'push-skipped-no-profile', scanId }` is logged (a needs-you push for such a scan is skipped the same way). The
    done time is still set, so the scan is not told later either.
  - **Sign-in.** `AuthService.verifyOtp` calls `guestSignedIn` (deletes the guest's rows and answers the platform of the phone it deleted: the
    most recently updated row's, null if none), then `newSignIn` with that platform and `at` = the injected clock's now. The alert fires only when the caller was a
    guest and the outcome is `existing`; promotion in place and a verified user signing in again do not.
- **Targeting is decided at send time.** Scan and face scan notifications go to the phones on the scan's profile (`forProfile`, narrowed to the
  account the message names); the sign-in alert goes to the account's phones (`forUser`), on any profile, EXCEPT the phone that signed
  in (below). No phone, no send and no receipt job. The two scan switches are read then too (a missing row means on): `scan-finished` and `face-scan-ready` follow `scanFinished`, `scan-needs-you`, `face-scan-needs-retake` and `face-check-in-due` follow `scanNeedsYou` (no new switch); the sign-in alert has no switch.
- **The sign-in alert skips the phone that signed in, by time.** The body carries `at`, when the sign-in happened (epoch ms; `newSignIn`
  defaults it to now). `deliver` alerts only the account's rows with `createdAt < at`. Why: the signing-in phone gets a session first and
  registers its push token after, so any row created at or after `at` is that phone registering under the account (a guest's row is
  deleted at sign-in, and the phone's new row is a new row), and alerting it would tell a person about their own sign-in. A phone that
  registers again after `at` but whose row was created earlier is another phone and is still alerted (`createdAt` is kept on update).
  Scan notifications ignore `at`.
- **The text is generic** and is built in the service: it shows on a lock screen, so it names no product and no skin detail ("Your scan
  is ready", "3 products analysed", "We need a photo of the back of a product", "New sign-in to your Deeper Tones account", "on an
  iPhone, just now"). `data` is `{ url, kind, scanId?, itemId?, faceScanId?, reason?, profileId? }`; the sign-in alert has only `url` and `kind`. The face scan pushes say "Your face scan is ready" / "Open the app to see what we noticed"
  and "Your face photo needs a retake" with one line per retake reason ("Find more light and take it again", "We couldn't find a face. Take it again", ...): no condition word, score, digit or lightness word.
- **Deep links are a JSON file.** `deep-links.json` maps each kind to an Expo Router path template (`/scans/{scanId}`,
  `/scans/{scanId}/items/{itemId}`, `/settings/security`, `/scans/faces/{faceScanId}`, `/scans/faces/{faceScanId}/retake`, and the static `/scans/faces/new` for `face-check-in-due`, which carries no scan id because a check-in is a scan that does not exist yet), bundled with the Worker; `deepLinkFor(kind, ids)` fills each `{placeholder}`
  with the URL-encoded id, so an id cannot add a path segment or a query. Changing a path is a PR and goes live with the next deploy.
  `deep-links.test.ts` fails when a kind has no path, a path starts without `/`, or it uses a placeholder its kind does not provide;
  adding a kind means updating that test's table on purpose.
- **At most once.** `deliver` sends one message per phone in one `push.send` call and never sends a message again: a ticket that is
  rate-limited, unavailable or otherwise failed is logged and left, because retrying the job would resend the phones that did get
  theirs. Only a failure of the whole call is retried: `PushUnavailableError` is rethrown for the dispatcher's backoff (nothing went
  out). Any other send error, or every ticket `misconfigured`, throws `PermanentJobError` (the run is recorded failed and acked, since
  retrying cannot fix our credentials). Once the messages are out nothing may throw, so deleting a dead token and queuing the receipt
  check each log and swallow their own failure, and the token hashes the receipt job needs are computed BEFORE the send.
  This holds for our own retries only. The job system is at-least-once (see "Background jobs"): if the dispatcher's `markDone` fails after
  a handler succeeded, the message is retried and the claim is free again; and if Expo times out on the FIRST request, the adapter
  cannot know whether it was accepted, so the retry may resend. Both can duplicate a push; neither is something this module can close.
- **Dead tokens, in two steps.** A ticket `device-not-registered` deletes the phone at once. For every accepted ticket the job queues
  ONE `check-push-receipts` job with `delaySeconds: 900` (15 minutes: Expo needs that long before a receipt exists), carrying
  `{ ticketId, deviceHash, tokenHash }` per ticket: the device hash and the SHA-256 of the token, never the token.
  `checkReceipts` asks Expo for those ids (a receipt not there yet is skipped) and deletes the phones reported dead.
- **The token-hash guard.** Both deletions go through `deleteIfToken(deviceHash, token)`, ONE conditional DELETE that applies only while
  the device's row still holds that token. A phone that registered a new token since the send keeps it. The receipt job has only the
  hash, so it reads the row, compares `sha256Hex(row.token)` with the message's `tokenHash`, and only then deletes with the row's token.
- **Dead letters.** `onDeadLetter` logs `{ job, outcome: 'dead-lettered' }` and nothing else; a lost notification needs no repair.
- **Logs.** The notifications module logs `{ job, kind?, outcome, count }`: no token, text, link or account, profile, scan or item id, and no error
  text. The outcomes are `sent`, `not-sent`, `misconfigured`, `dead-token-deleted`, `dead-token-delete-failed` and `receipt-enqueue-failed`.
  The lines that name ids are the exceptions, and log nothing but ids: `push-enqueue-failed` (`kind`, `scanId` if any), and from `ScanService`
  `push-skipped-no-profile` (`scanId`) and `push-failed` (`scanId`, plus `itemId` for a needs-you push).
- **Queue settings.** `push-delivery` is modelled on `otp-delivery` (batch 10, a 1 second batch timeout since a person waits, 5 attempts,
  backoff 5 s x3 up to 135 s). `push-receipts` is not urgent, so it lets a batch fill (25, up to 30 seconds), 5 attempts, backoff 30 s x3
  up to 600 s. **Concurrency follows these consumer settings**: the reminder fan-out (below, "Reminders" → Sends) puts one `reminder-profile` message per started profile on `push-delivery`, so how many profiles are worked at once is the queue's own batch size and consumer concurrency, not anything in the cron. Raise them in `wrangler.jsonc` (all three blocks) if the Lagos 07:00 spike is too slow.
- **The `reminder-profile` message** (#233, PR 8a) is the one `send-push` body that is not a notification: `{ kind: 'reminder-profile', profileId, slot }`, `slot` the 15-minute cron's scheduled time in epoch ms. It is in `sendPushSpec`'s union (no new queue exists for it) but not in `NOTIFICATION_KINDS`, and its key is `reminder-profile:<profileId>:<slot>`. The `sendPush` handler routes it to `ReminderSendsService.sendForProfile` and everything else to `NotificationsService.deliver` (which refuses it with a `PermanentJobError`: reaching it there is a wiring mistake).

### Goals (onboarding)
`modules/goals` holds `profile_goals` (migration 0023), `D1GoalsRepository` (`append`, `current`, `history`) and `GoalsService` (`set`, `current`, `requireGoal`, `onboarding`).
It is the first step of the first run: a guest says what they want their skin to look like and gets the app's honest answer straight away. Issue #82
is built in four pull requests; the goal is the first two (the six chips, and typed words read by the goal reader), the safety answers are the third, and the parse of their reaction and prescription words is the fourth (see "Safety facts (onboarding)").

- **History, not a single value.** `profile_goals` is keyed by `profile_id` (cascade) and append-only: every change adds a row and the newest by
  `created_at` is the current goal, read through the `(profile_id, created_at)` index. Rows that share a `created_at` are ordered by `rowid`, so the one appended later is the current goal. `goal` is one of the six goals or null, `text` is the user's own
  words or null, `wants_lighter` and `answers_version` are always written. Rows go with their profile, so guest cleanup needs no cleaner of its own,
  and a guest who signs up keeps the goal (promotion keeps the profile).
- **The six goals are the catalog's.** `GOALS` (`goals.vocabulary.ts`) is the catalog's `goal:` traits without the prefix, in the same order, so a
  user can pick no goal a product cannot be tagged with. A test pins that the two lists match. `calm-repair` is last, added after the first five: it is for skin made thin, red or reactive by a lightening,
  toning or steroid cream, the product's primary user (CONTEXT.md). Its answer says up front that a flare is expected, and plans a dated step-down on
  anything harmful rather than telling the user to stop it. `ANALYSIS_VERSION` was not bumped for the new trait (an owner decision), so analyses made
  before it lack `goal:calm-repair` until they are next re-analysed.
- **The answer is not stored.** `answerFor(goal, wantsLighter)` (`goals.answers.ts`) is a fixed copy table: a title, `howLong`, `helps`, `inTheWay` per
  goal, plus one colour `note` that only a row with `wants_lighter` gets (the same note whichever goal it was sorted into; the plan itself does not
  change). The view is built when a row is read, so a new version of the copy reaches goals saved earlier. `GOAL_ANSWERS_VERSION` is bumped whenever
  the meaning of any text changes; the view always carries the current one, and each row records the version it was saved under. The copy is a DRAFT that
  needs owner and qualified review before launch.
- **Typed words are read by the goal reader.** `{ text }` is trimmed (1 to 200 characters, by the schema) and checked, then `GoalReader.read` (see
  "Claude (Anthropic) providers") sorts it into one of the six goals and the service saves `goal` and `wants_lighter` with the words. When the
  reader finds no goal the words are saved with `goal` null and no answer. **`wantsLighter` always means `brighter`:** words that ask to be lighter,
  fairer or whiter are saved as `brighter` with `wants_lighter` true, and the answer adds the colour note. That is a sorted request, never a refusal.
  **A reader that cannot read is not an error for the user.** `AiBudgetExceededError`, `AnthropicUnavailableError`, `AnthropicRequestError` and
  `AnthropicRefusalError` save the words with `goal` null and `wants_lighter` false (still 200, so the app shows the chips) and log one
  `{ outcome: 'goal-read-failed', reason }` with a short kebab-case reason (`budget-exceeded`, `unavailable`, `request-rejected`, `refused`). Any other error, an
  `AnthropicConfigError` above all (a setup problem to fix, not an outage to hide), propagates and nothing is stored. Chips never call the reader,
  and neither do words refused for a link, markup or a hidden character. Words with a link or markup
  (`hasLinkOrMarkup` from `lib/text-safety`; a bare `<`, as in "spots < 1cm", is fine) or a control or invisible character (`\p{Cc}`, `\p{Cf}`) are
  400 `INVALID_GOAL_TEXT`. Shape and length are zod: exactly one of `goal` and `text`, else 400 `VALIDATION_FAILED`.
- **The text-carry rule.** A `{ goal }` copies `text` from the current row only when that row's `goal` is null, because the pick answers "which is
  closest?" to words nobody sorted. After a chip, or after words that were already matched, the next chip leaves `text` null, so old words do not
  follow later changes.
- **Current and onboarding.** `GET /goal` is 404 `GOAL_NOT_SET` only for a profile that never saved anything; saved words with no goal are a view with
  `goal` and `answer` null. `GET /onboarding` answers `{ goal, safety, next }`: `next` is `goal` until a row has a goal, then `safety` until the profile has
  a safety answer ("none of these" is one), then `shelf`. `safety` is the profile's current safety view whichever step it is, because the question can be
  answered before the goal. `GoalsService` gets it from `SafetyService.currentOrNull()`, never from the safety repository.
- **The guard.** `requireGoal()` answers the current goal view, or 409 `GOAL_REQUIRED` when the profile has no row or only words with no goal. It is
  built for the verdict and routine work and is not wired to a route yet.
- **Guests are allowed.** Every method calls `requireUser()` and uses `actor.profileId`, so a guest has a goal like anyone, and a second profile of
  an account has its own.
- **Rate limits on `PUT /goal`.** `GOAL_SET_IP_LIMITER` (20 a minute per address) and `GOAL_SET_USER_LIMITER` (10 a minute per user), in the order
  address limit, `signedIn()`, user limit, as the scan routes. They cover chips too: the route cannot tell words from chips before it validates the
  body, and a typed goal may cost a model call. Over the limit is 429 `RATE_LIMITED` with `Retry-After`, before any model is called; `GET /goal` and
  `GET /onboarding` are not limited.
- **Wiring.** The container builds `GoalsService` with `D1GoalsRepository` and `AnthropicGoalReader` over its own client with an 8 s timeout (the read runs
  inside the user's request on the first screen, so it gives up sooner than the name split's 15 s), so a slow model costs the user a short wait before the chips, not a stuck screen.
- **Logs never carry the text.** The only log is `{ outcome: 'goal-read-failed', reason }` when the reader cannot read, with no words in it; a test spies on the console to keep it so. The words are user input and may be personal.
- **Routes**, all bearer, under `/api/v1/me`, tagged "Onboarding": `PUT /goal` `{ goal }` or `{ text }`, `GET /goal` and `GET /onboarding`, a third
  `.route('/me', ...)` in `src/app.ts`.
- **Switch preview.** `GET /goal/switch-preview?goal=` (bearer, guests included, no middleware) answers `{ goal, outcome, dayOneAt, resumeUntil }` from `FaceScanService.switchPreview`, which lives
  there because the day one comes from the face-scan tables. `outcome` is `resume` iff `chaseStartFor([...history, { goal, createdAt: now }], goal, now)` is before now, else `fresh`. `resumeUntil` is the
  `createdAt` of the row that followed the goal's latest run plus `RESUME_DAYS` (90); `dayOneAt` is the chase's first ready scan (`dayOneFor`), null when it has none; both are null for `fresh`.
  The goal the profile is on is 400 `GOAL_ALREADY_CURRENT`; a profile with no goal yet (the `NotFoundError` from `goals.current()`) starts every goal fresh. It only reads. The app's wording is
  `switchScreen[outcome]` in the onboarding content (DRAFT copy).
- **Not part of the goal.** The words typed beside the safety choices (a product that gave a reaction, a prescription) are read in the background by the parse job; see "Safety facts (onboarding)".

### Safety facts (onboarding)
`modules/safety` holds `profile_safety` (migration 0024) and `safety_mentions` (migration 0025), `D1SafetyRepository` (`append`, `appendCarrying`, `find`, `current`, `history`,
`setParseState`, `appendMentions`, `mentions`, `resolveMention`) and `SafetyService` (`set`, `current`, `currentOrNull`, `currentMentions`, `markReactionProduct`, `requireAnswered`, and for the
queue `parse` and `markParseFailed`). It is screen 1.5 of the first run, "Anything that changes what's safe for you?", the third pull request of issue #82; the parse of the
two texts is the fourth.

- **The choices.** `SAFETY_CHOICES` (`safety.vocabulary.ts`) is `pregnant`, `breastfeeding`, `reaction` ("a product gave me a reaction"), `prescription` and
  `none`, in the order the app shows them. The service stores and returns the ticked choices once each, in that order, whatever order or repeats were sent.
- **The rules, in `SafetyService.set`.** Each text is trimmed and every run of whitespace in it (a line break, a tab) is made one space, so a list written over
  several lines is saved as one line; a text that is empty after that is null, so an empty field says nothing. This comes before every check below. Then:
  `none` with any other choice is 400 `INVALID_SAFETY_ANSWER` with `details.field` `choices`; a text with words but without its choice ticked (`reactionText` needs
  `reaction`, `prescriptionText` needs `prescription`, and `none` ticks neither) is 400 `INVALID_SAFETY_ANSWER` with the field named; a text with a link or
  markup (`hasLinkOrMarkup`) or any other control or invisible character (`\p{Cc}`, `\p{Cf}`; line breaks and tabs are gone by then) is 400 `INVALID_SAFETY_TEXT` with the field named. Ticking a choice and naming nothing
  is valid and still counts: the caution applies from the tick. Shape is zod: a strict object, `choices` one to 20 entries of the vocabulary (repeats are collapsed by the service, so the limit only stops a silly body), each text a
  string of at most 300 characters (`SAFETY_TEXT_MAX`) once trimmed, counted as typed before whitespace is collapsed, else 400 `VALIDATION_FAILED`.
- **History, as for goals.** `profile_safety` is keyed by `profile_id` (cascade) and append-only: every change adds a row and the newest by `created_at` is the
  current answer, ties broken by `rowid`. The newest wins even when it is less strict than the one before ("none" can replace "pregnant"); nothing carries over, so a
  text is kept only if the answer that is current says it. `choices` is a JSON array in a text column. Guest cleanup needs no cleaner of its own, and a guest who signs up
  keeps the answers (promotion keeps the profile). The migration is additive.
- **The view.** `{ choices, reactionText, prescriptionText, excludesPregnancyCaution, updatedAt }`, and the presenter returns exactly those five keys.
  `excludesPregnancyCaution` is true when `pregnant` or `breastfeeding` is ticked; it is worked out when the row is read, not stored.
- **Guests are allowed.** Every method calls `requireUser()` and uses `actor.profileId`, so each profile of an account has its own answers. `GET /safety` is 404
  `SAFETY_NOT_SET` until the profile has answered.
- **The guard.** `requireAnswered()` answers the current view, or 409 `SAFETY_ANSWERS_REQUIRED` for a profile that has not answered ("none" is an answer). With
  `GoalsService.requireGoal()` it is what the verdict and the routine will call, so no routine rests on a missing answer. Scans need neither, so the shelf photo stays
  part of the hook. Neither guard is wired to a route yet.
- **Parsing the two texts only ever adds caution.** What the user typed, and the tick itself, always count; whatever is parsed from it can only add caution, never remove
  any, and nothing the model says about a product's contents is ever kept (see below). A parse that fails, or never runs, takes nothing away.
- **The parse state** is three columns on `profile_safety` (migration 0025, additive: plain `ADD COLUMN`s, no table rebuild). `parse_state` is `none` (no words, and every
  row saved before the parse existed), `pending` (words were saved and the parse has not finished), `done` or `failed` (final). `parse_due_at` is when the parse is due.
  `parse_retried` (default false) is set when a parse that ran out of retries is given its one more try, and is never cleared. A partial index on `parse_due_at` for the pending rows
  serves the daily sweep. `set` writes `pending` and queues one `parse-safety` message carrying the row's id for an answer with any words (one message, not two,
  for both texts); an answer without words, or "none of these", is `none` and queues nothing.
- **At most one parse per profile per hour.** The message is held back (`delaySeconds`) until an hour after the **due time** of the profile's newest answer with words whose
  parse is due or has run (`parse_due_at` at or before now; answers without words, and rows from before the parse, do not count), never less than 0: `delay = max(0, ceil(anchor.parse_due_at + 1 h - now))`,
  and `parse_due_at` is now plus that delay. An answer whose parse is still in the future is being replaced by this one and never runs, so it holds nothing back: A at 0, B at 10 minutes and C at 20 minutes
  give due times 0, 60 and 60 minutes, and a C at 61 minutes (after B's parse fell due at 60) waits until 120. The limit is the service's own; the saves themselves are rate limited (below).
- **A queue that is down never fails the save.** The enqueue error is logged as `{ outcome: 'parse-enqueue-failed', safetyId }` (no message, no words) and swallowed; the
  row stays `pending`, and the repair or the daily sweep queues it again.
- **Repair on read.** `current()` (so `GET /safety`) queues the parse again, with no delay, when the current row is still `pending` more than **45 minutes** after
  `parse_due_at` (strictly after: the queue retries for most of an hour before it gives up, so a parse in its retries is not taken for lost; a lost message, or a queue that was down at the save,
  is). A row on its second try is queued with `retry: true`. The row's key makes a repeat one run. It looks only at the current row, answers the same view, and a
  queue that is down is logged and never fails the read. A row not yet due (such as one given its second try tomorrow) is never repaired.
- **`parse(safetyId)`** runs as the system actor, so it never calls `requireUser`, and is safe to run again. A row that does not exist, or is not `pending`, is left alone;
  one that a newer answer of its profile has replaced is marked `done` with no call (the newer one has its own job). Otherwise:
  1. **Each text is read once.** The reaction text and then the prescription text are read with the `MentionReader`, and each one's mentions are stored AS SOON AS they are read, in ONE
     batch (`storeRead`) together with a record in `safety_reads` that the text was read. A retry reads only the texts without that record, so a text that named nothing, or was refused,
     is never paid for again, one that named something is never stored twice, and what the first text named is never lost when the second cannot be read yet. Positions go on from the
     mentions already stored. A refusal or a rejected request leaves that text with no mentions (the words still count) and the parse goes on; the AI budget, an outage and a config error throw, and the job retries.
  2. **Three products at most, each once.** A product is stored `unresolved` at once when it has no brand or no category (the catalog needs both; the reader leaves a brand empty for "the white tub from the
     market"). The others use up the answer's three slots, counted across both texts in the order read and across a retry (the slots already used count). The same product named again (the same
     `normaliseText` of brand, name and variant) uses no further slot, is looked up once, and every mention of it gets the same outcome; a product past the third is `unresolved`. The rest are `pending`.
     An ingredient has no resolution and is never sent to the catalog.
  3. Each `pending` product is looked up with the same two catalog calls a typed name gets, with no scan item: `resolve({ brand, name, category, variant? })`, and for
     `needs-research` `research(productId)`. `ready`, `needs-analysis`, `analysis-failed` and a `found` research are `resolved` with the catalog's `productId`; `not-found` is
     `unresolved` with the `productId` kept, even when the catalog offers a stale formulation (never taken as an answer). `budget-exhausted` throws `CatalogBusyError`,
     and `ResearchInProgressError` and `CatalogBusyError` from the catalog pass through, each leaving that product `pending` for the retry. Each outcome is stored as soon
     as it is known, so a retry asks the catalog only about the products still `pending`. The parse does not analyse a formulation: that stays the scan's business.
  4. The row is marked `done`.
- **A second try the next day.** `markParseFailed` (the dead-letter hook) acts on a `pending` row only. The first dead letter puts it back to `pending` with `parse_retried` set and `parse_due_at` at the
  next midnight UTC strictly after now (at midnight exactly, the one a day on), and queues nothing: a queue delay cannot reach that far. The daily cron (`requeueDueParses(now)`, see "Guest cleanup")
  queues `{ safetyId, retry: true }` for every pending row due by then, the longest overdue first and at most 200 a run, the profile's session not needed. The second dead letter is final: `failed`. A
  `done` or `failed` row, or one with nothing to parse, is left alone. The words, the choices and what had been found stay as they were throughout.
- **Ingredients never come from model memory.** The reader names only what the person wrote, and a product's ingredients come from the catalog's research alone, so
  a mention is a name the person typed and a `product_id` is a catalog product. Nothing about what is in a product is taken from the model.
- **`safety_mentions`** (migration 0025): `id`, `safety_id` (FK to `profile_safety`, cascade, so guest cleanup needs no cleaner), `source` (`reaction`, `prescription` or `skin-log`; see "Marks from the skin log"),
  `kind` (`product` or `ingredient`), `brand`, `name`, `variant`, `category` (null for an ingredient or when unknown), `product_id` (a catalog id with no foreign key, like
  `scan_items.product_id`), `resolution` (`pending`, `resolved`, `unresolved`; null for an ingredient), `position` and `created_at`; indexed on (`safety_id`, `position`).
  `safety_reads` (same migration; `safety_id` FK with cascade, `source`; primary key on both) records the texts that have been read. `appendMentions` and `storeRead` are each one `db.batch`
  (all or nothing; `appendMentions` of an empty list does nothing, `storeRead` of one still records the read). `currentMentions()` answers the current row's mentions in order for the services that
  will use them; no route exposes them yet, and the `SafetyView` and the API stay exactly as they were.
- **Marks from the skin log (`skin-log`).** A product the person marks as one they keep reacting to is a `safety_mentions` row with `source` `skin-log`: kind `product`, resolution
  `resolved`, variant null, and the catalog `product_id` (a product with no catalog id, such as a step with no label or a `none` step, cannot be marked). It is a source value only: the column has no CHECK, so there is no migration.
  The type is split in two in TypeScript: `MentionSource` (mentions) has `skin-log`, `ReadSource` (`safety_reads`, and what `storeRead` and `reads` take) stays `reaction | prescription`, since a mark is not read from words.
  `SafetyService.markReactionProduct(profileId, { productId, brand, name, category })` takes no session and appends the mention to the profile's **current** row (it writes no row of its own, so the
  view and `GET /safety` are unchanged); it answers `{ marked }`, false when that product is already marked or the profile has no safety row. It is called by the skin-care module (the reaction call, PR 6b of #233).
  **A mark is carried forward.** Mentions hang off one safety row and `set` appends a new row, so `set` copies the current row's `skin-log` mentions onto the new one (fresh ids, `safety_id` the new row, positions from 0)
  through `D1SafetyRepository.appendCarrying(row, carried)`: the row insert and one insert per carried mention in one `db.batch`, an empty list still adding the row. Reaction and prescription mentions are never carried;
  they are read again from the new words. **Marks do not count toward the three-product cap:** `mentionRows` skips `skin-log` mentions when it counts the slots, so a carried mark never pushes a typed product to `unresolved`.
  **Reconcile after the write.** D1 has no transaction across a read and the write after it, so both sides re-check: `markReactionProduct` re-reads the current row after writing and, if a save replaced it, marks that row too (`marked` is true only when the mark is on the current row); `set` re-reads the old row's marks after `appendCarrying` and appends any product the new row lacks. Each row holds a product at most once, so the checks are no-ops when nothing raced, and `carriedMarks` carries one mention for each product even if two concurrent marks left a duplicate.
  **Marks are never removed:** no unmark exists, by design (cautious). **An empty or blank `productId` marks nothing** (`marked` false): a step with no label, or a `none` step, has no catalog id and cannot be marked.
  **The routine follows through the verdict fingerprint, not an event.** The verdict floor's `reactedProducts` and the recommendations' `sharedWithReaction` flag accept `skin-log` as well as `reaction` (`reactedIngredients` stays
  `reaction` only). The fingerprint hashes the mentions, so a new mark changes it, a carry (new ids, later times) does not; skin-care then calls `verdicts.savedFor(profileId)`, which queues a verdict build, and the build fires `onRoutineTrigger('verdict')`.
  skin-care never calls routines, and no safety-change rebuild (`reason: 'safety'`) is used.
- **Logs carry ids and outcomes only**, never the words, a brand or a name, and a successful parse logs nothing of its own (the dispatcher logs `{ job, key, attempt, outcome }`).
  Tests spy on the console to keep it so. The words are user input and may be personal.
- **Routes**, bearer, under `/api/v1/me`, tagged "Onboarding": `PUT /safety` and `GET /safety`, a fourth `.route('/me', ...)` in `src/app.ts`. `PUT /safety` is rate limited like `PUT /goal`, in the same order
  (`SAFETY_SET_IP_LIMITER` 20 a minute per address, then `signedIn()`, then `SAFETY_SET_USER_LIMITER` 10 a minute per user; 429 `RATE_LIMITED` with `Retry-After`; namespace ids 1022/1023, 2022/2023 and 3022/3023): a
  save can queue a parse that researches a product into the shared catalog, and a guest costs nothing to make. `GET /safety` is not limited. A save calls no model itself.

### Shopping facts and candidates
`modules/recommendations` holds `profile_shopping` (migration 0033), `D1RecommendationsRepository` (`append`, `current`, `history`) and `RecommendationService`
(`setShopping`, `currentShopping`, `candidatesFor`). It is the fifth pull request of issue #115: the reviewed catalog of "Catalog workbook import" gets a reader,
which answers one question, "which products may be suggested to this profile for this routine step", by fixed rules and no model. It reads the goal, the safety answers,
the face scan, the catalog and the workbook through their services, never their repositories.

- **History, as for goals and safety.** `profile_shopping` is keyed by `profile_id` (cascade) and append-only: every change adds a row and the newest by `created_at` is the
  current one (ties by `rowid`, so the one appended later wins), read through the `(profile_id, created_at)` index. `country` is a code of the Countries tab and has no foreign
  key (that table is the catalog's, and a country is retired, never deleted, so a stored code keeps its meaning). `budget_band` is `low`, `mid`, `high` or null, and the newest row
  decides, so a band is taken back by saving the country alone. A guest has a fact as much as a verified user and keeps it on signing up; a second profile has its own. No
  cleaner: rows cascade from the profile.
- **Setting it.** `setShopping({ country, budgetBand? })` refuses a country that is not an **active** row of `CatalogWorkbookService.countries()` (a retired one is no longer served) with
  400 `UNKNOWN_COUNTRY`, then a band outside `BUDGET_BANDS` with 400 `UNKNOWN_BUDGET_BAND`, and stores nothing for either. Both are plain text on the wire, so these say which of the two it was;
  a body that is not text, or has no country, is the schema's 400 `VALIDATION_FAILED`. `GET` is 404 `SHOPPING_NOT_SET` until a country is saved.
- **Rate limits on `PUT /shopping`.** `SHOPPING_SET_IP_LIMITER` (20 a minute per address, namespace ids 1030 / 2030 / 3030) then `signedIn()` then `SHOPPING_SET_USER_LIMITER` (10 a minute per user,
  1031 / 2031 / 3031), in the order of the goal route; 429 `RATE_LIMITED` with `Retry-After`. `GET` is not limited. Routes are bearer, under `/api/v1/me`, tagged "Recommendations".
- **`candidatesFor({ step })` has no route yet**; the routine stage will call it. It needs, in this order, a goal (409 `GOAL_REQUIRED`), safety answers ("none of these" is one: 409
  `SAFETY_ANSWERS_REQUIRED`) and a shopping fact (409 `SHOPPING_REQUIRED`). A stored country that has since been retired, or no row passing, is `[]`: a normal answer, which the routine
  meets with "use what you have". `shoppingFor(profileId)` answers a profile's shopping fact by id (409 `SHOPPING_REQUIRED` when none) for the routine's jobs, and `candidatesFor({ step, country })` asks the same question of another country with the budget band ignored, used only to ask "is this still sold, and safe for this person, anywhere" (a retired or unknown country is `[]`).
- **The rules**, all fixed, applied to `approvedFor({ country, step })` (the approved rows sold in the country that fill the step, each pinned to the formulation the workbook reviewed;
  `latestFormulation` is never read for a row):
  - **Concern:** the row works on at least one of the goal's concerns (`concernsForGoal`, the face scan's table).
  - **Skin type:** `FaceScanService.latestSkinType()`, the label of the newest **ready** scan of the profile (a newer scan still analysing, or needing a retake, does not hide an older ready
    one; a newer ready scan with no label is the answer, null). A known type keeps rows that list it or say `all`; an unknown one keeps only `all`, and a type is never assumed.
  - **Budget:** the row's **lowest** price is at most the band's top in the country's own money (`low_max`, `mid_max`; `high` has no cap; no band, no check).
  - **Ingredient rules:** the facts of a row are `flagFacts(row.ingredients, liveRules.entries)` (the live approved rules, matched as the analysis matches them: a strength, a bracket
    or a slash is no way round) plus the cautions the row lists itself, which can only add. A `banned-substance` fact always leaves the row out, and a `pregnancy-caution` fact does when
    `SafetyView.excludesPregnancyCaution` (pregnant or breastfeeding). Other kinds (allergen, irritation) are for the verdict and never take a row out of this list. A row that claims
    "pregnancy safe" but lists retinol is still flagged by the rule.
  - **What the user named** (`SafetyService.currentMentions()`, the newest answer only): a product mention whose `productId` is the row's leaves it out, **whatever its resolution and whichever
    text it came from** (the user named that exact product, and a product the parse could not research keeps its catalog id); a product with no id (named with no maker) leaves out nothing.
    A row whose ingredient list is the same list (`ingredientsKey`: case, spacing and order) as the latest list of any **resolved** product named, as a reaction or a prescription, is also left out: the
    same product entered under another spelling has another product id. An ingredient mention leaves out any row that lists it, matched whole through `ingredientParts` ("alcohol" takes out "Alcohol" and
    not "Cetearyl Alcohol"), **and through the live rules' labels**: the named parts are expanded with every label (name and aliases) of each rule that lists one of them, so "fragrance" and "Parfum", or
    "retinoic acid" and "tretinoin", stand for each other whichever the user or the row wrote. The expansion is one step, never a chain through rules that share a label, so it does not depend on rule
    order, and a name no rule lists is matched as written: never fuzzy. Words not parsed yet name nothing, so the ticked boxes alone apply: unparsed words never relax anything.
- **The answer** is `[{ code, product, skinConcerns, ingredients, evidenceUrls, ingredientsSourceUrl, passed, sharedWithReaction, origin, frequency, priceMin, priceMax, whereSold }]`, sorted by lowest price then code, so **origin never decides a place**
  (a brand-submitted row passed the same evidence bar and gets no help). `product` is the summary of the pinned formulation's product (one batched `productSummaries`); a row whose product
  cannot be found is left out and logged as `candidate-product-missing` with its code only, so one bad row cannot fail the list. `passed` names the rules the row passed, in the fixed order
  `country, step, skin-concern, skin-type, budget, ingredient-rules, reactions`: `budget` only when a band was given, `reactions` only when the user named something that could be checked
  (an ingredient, or a product with an id).
- **A candidate carries its row's facts for the routine writer.** `approvedFor` maps the row's `evidenceUrls` and `ingredientsSourceUrl` (an empty list and a null when the workbook has none, and such a row is still a candidate) as well as its `skinConcerns` and `ingredients`, and `candidatesFor` copies all four onto the candidate, plus `keyIngredient` and `strength` for the routine screen's "what to look for" (no rule and no routine writer input reads them) (the three lists as new arrays, so changing one candidate's cannot change the row or the next candidate). The evidence links are context for the AI and the team only: **they never reach an API response or a screen**, so no presenter or schema carries them. `Candidate` is internal and no route returns it.
- **`sharedWithReaction` is information, not a filter.** For each product the user named in the **reaction** text that the parse resolved, in the order they named them, it lists the candidate's
  ingredients, spelled as the candidate has them, that the product's latest list also holds (compared through `ingredientParts`, expanded through the live rules' labels as above). A product with no list, or one not resolved, has no entry, and so
  does one that shares nothing. `ProductCatalogService.latestIngredients(productId)` reads the list: the latest formulation's ingredients or null (also for an unknown product), never throws for
  a missing one, researches nothing and writes nothing.
- **Reads.** After the guards (in order, so the error names what is missing first), the countries, the mentions, the skin type, the live rules and the approved rows for the stored country are read
  together; the named products' latest lists (at most three products, in parallel) and the summaries of the rows kept follow. `flagFacts` builds its label map once per rules array (a `WeakMap`
  keyed by the array, which is one per rules version), not once per row.
- **Wiring.** The container builds `RecommendationService` over `D1RecommendationsRepository` and the goals, safety, catalogWorkbook, faceScans and catalog services, exposed as `recommendations`.

### Onboarding content
`GET /api/v1/onboarding/content` (`modules/onboarding`, operation `getOnboardingContent`, tag "Onboarding", mounted at `/api/v1/onboarding`) serves the text of onboarding screens 1.2 to 1.5
(goal, answer, safety), the fifth pull request of issue #82, so a copy change, a new chip or a new choice is a deploy and not an app release. The app fetches it first and renders from it.

- **Public and the same for everyone.** `security: []`, no rate limit (it is static and cached). A bearer token, valid or not, changes nothing: `auth` never rejects, and the route reads no actor.
  The route calls `contentFor` (`onboarding.content.ts`) directly: the content is pure data with nothing to wire, so there is no service or repository. `toOnboardingContentResponse` (`onboarding.presenter.ts`) maps it to the response schema, field by field.
- **The source of truth is not in this module.** The chip and choice ids come from the vocabularies the API itself validates (`GOALS`, `SAFETY_CHOICES`), in their order, so every
  id the app shows is one `PUT /me/goal` and `PUT /me/safety` accept (the integration test tries each). The answer cards come from `goals.answers` (`answerFor(goal, false)` without its `note`), and
  `colourNote` is `answerFor(goal, true).note`, so the words have one source and `PUT`/`GET /me/goal` keep answering from the same table. The labels are typed `Record<Goal, string>` and
  `Record<SafetyChoice, …>`: a new goal or choice without a label does not compile. This module may import other modules' vocabulary and answers files (pure, as scans imports `catalog.vocabulary`), never their services.
- **Response.** `{ locale, contentVersion, goalScreen, answerScreen, answers, colourNote, safetyScreen }`. A safety choice has a `field` (`{ label, hint? }`, the text box under it) only for `reaction` and `prescription`.
  The mock text of the screens is used word for word; the sixth chip ("Calm, healthy skin") and the reaction field are DRAFT and need owner review before launch. They are named in `DRAFT_COPY` (a test pins the list, and that each string is shown by the content) and marked DRAFT in the source; approving a string means removing it from both.
- **Version and caching.** `contentVersion` is the first 16 hex digits of the SHA-256 of the content without `contentVersion` (`locale` included), serialised as JSON with object keys sorted and array order kept, so a changed word, id, or position
  is a new version and a reordering of fields in the source is not. A key set to `undefined` is left out, as JSON leaves it out. `CONTENT_SHAPE_VERSION` is hashed in too: bump it when the response shape changes without any copy changing, or apps holding the old ETag keep getting 304 and the old shape. It is computed once per isolate (`once`) and is also the `ETag`, in quotes. `Cache-Control` is `public, max-age=300, stale-while-revalidate=86400`: five minutes
  so a copy deploy reaches the apps quickly, and a day of serving the old text while it revalidates, so opening the app never waits on this call. `If-None-Match` naming the current ETag (a list, weak `W/` forms and `*` count) is 304 with no body, still carrying `ETag` and `Cache-Control`.
  CORS exposes no response headers anywhere in the app, and this is a mobile client, so `ETag` is not added to them.
- **Locale.** `?locale=` is optional and lenient: only exactly `en` (case-sensitive) is served as itself, and anything else (empty, long, a path, markup, repeated) falls back to `en`, with `locale` in the response saying so and the same ETag.
  It is never a 400. Only English ships now; a language is added by writing its content and listing it in `LOCALES`.
- **The presenter holds the shape.** The bodiless 304 makes @hono/zod-openapi type this route's handler return as `Response`, so the compiler does not check the body of the `ok(...)` call (see "Routes document themselves"). `toOnboardingContentResponse` is typed `z.infer<typeof OnboardingContentResponse>`, so a field that differs from the schema fails to compile there. The integration test checks the strings.
- **Copy changes ship with a deploy.** Nothing here is read from a database or a setting. After a deploy, apps pick up the new text within the cache window.

### Prompts

Each Claude system prompt is its own Markdown file in `src/prompts/`, next to the email templates, so a prompt change
reads as a diff of prose, not of TypeScript. They are not beside their adapters because a generated module inside
`providers/` would break `concrete-classes-only-in-container` (only the container may value-import a non-`.provider` file
there), and a dependency-cruiser rule is never loosened to make code fit.

- **One file per prompt, named `<adapter>.<purpose>.md`:** `label-reader.read-label.md`,
  `product-recognizer.recognize.md`, `product-recognizer.recognize-shelf.md`, `product-researcher.research.md`, `product-analyst.analyse.md`,
  `product-analyst.same-product.md`, `product-analyst.image-check.md`, `name-splitter.split-name.md`,
  `goal-reader.read-goal.md`, `mention-reader.read-mentions.md`, `catalog-drafter.draft-catalog-row.md`, `draft-judge.judge-draft.md` (the eval's own), `routine-judge.judge-routine.md`, `routine-grounding-judge.judge-grounding.md` and `routine-labeller.label-routine.md` (the routine eval's own), `routine-writer.write-routine.md`, `verdict-fitter.fit-verdict.md`. The export name is the camelCased file name plus
  `Prompt` (`productAnalystAnalysePrompt`); two files that would give the same name are an error.
- **Front matter, in YAML, for people; the model never sees it.** `purpose` (one line on what the prompt makes Claude do),
  `usedBy` (the adapter class and method, e.g. `AnthropicProductAnalyst.analyse`), `job` (the `AiJob` that runs it, one of
  `AI_JOBS`), `version` (what to bump when the meaning changes: `ANALYSIS_VERSION` or `none`) and `placeholders` (a map
  from each placeholder name to a one-line description; absent or `{}` when there are none). All but `placeholders` are
  required. The file starts with `---`, and the front matter ends at the next line that is exactly `---`.
- **The body is exactly what Claude receives.** Everything after the front matter, with one trailing newline removed and
  nothing else touched. Nothing in a file is a comment. Where a value comes from code the body has `{{name}}`
  (camelCase); single braces, such as the JSON shape in the researcher's prompt, are plain text, and any other `{{` is
  an error. A placeholder may appear more than once. The names in the body and in `placeholders` must be the same set.
- **Typed functions and strings.** A prompt without placeholders is exported as `{ job, hash, text }`. One with
  placeholders is `{ job, hash, render }`, where `render` takes one object typed from the placeholder names, all
  `string`, so a missing, extra or misspelled value fails typecheck. The text goes into the module as JSON string
  literals joined with `+`, never template literals, so backticks, `${` and backslashes in a body are safe. Adapters
  take `system` and `{ job }` from the export, so a prompt's job is written down once, in its file. The one-line
  user-message lead-ins ("Analyse this product:") stay in the adapters beside the JSON they frame.
- **Generated, committed, checked in CI.** `npm run prompts` (`scripts/prompts.ts`, with the pure core in
  `scripts/prompts/generate.ts`) reads every `src/prompts/*.md` and writes `src/prompts/prompts.generated.ts`, or prints
  every error, each naming its file, and exits 1. It fails on a missing or empty `purpose`, `usedBy`, `job` or
  `version`, a `job` outside `AI_JOBS`, a `version` other than `ANALYSIS_VERSION` or `none`, listed placeholders that
  differ from the body's, and a malformed placeholder. Files are sorted by name, so the output is stable. The Prompts job
  in the Tests workflow reruns it and fails if the committed module differs, as the API contract job does for
  `docs/openapi.json`. A TypeScript module, not an imported `.md`, is what lets the Worker build, the Workers tests and the
  eval script (Node, tsx) share one loading path with no bundler setup, and nothing is fetched at runtime: a prompt
  changes only through a PR and a deploy. `yaml` is a devDependency used by the generator only.
- **`prompts-are-pure`.** Like `emails-are-pure`, it keeps `src/prompts/` free of modules, providers, jobs, middleware and
  wiring. The one exception is a type-only import of `AiJob` from `providers/anthropic/ai-spend.provider.ts`, which the
  generated module uses.
- **The analyse prompt is pinned to `ANALYSIS_VERSION`.** Its length limits are `{{whyGuidance}}` and `{{whoGuidance}}`,
  filled by `AnthropicProductAnalyst` from `WHY_GUIDANCE` and `WHO_GUIDANCE`, the constants that also describe `why` and
  `whoShouldTakeCare` in the answer schema, so the prompt and the schema cannot disagree. Every prompt exports a `hash`,
  the sha256 of its body with the front matter stripped and the placeholders unfilled, and `catalog.vocabulary.test.ts`
  pins `productAnalystAnalysePrompt.hash` next to `ANALYSIS_VERSION`. Editing the analyse prompt therefore fails that
  test until you decide: if the meaning changed, bump `ANALYSIS_VERSION` (stored analyses become stale and the
  three-rejection count starts again) and update the hash; if it is a typo fix or rewording, update only the hash, so
  stored analyses are not re-run for nothing. The hash is taken before placeholders are filled, so it does not see the
  guidance constants: changing their values changes what Claude is told without failing the pin, and is the same decision.
  Check an analyse wording change with `npm run eval:catalog`.

### Claude (Anthropic) providers
Product research, analysis and photo reading call Claude through one `AnthropicClient`, and thin adapters
(`AnthropicProductResearcher`, `AnthropicProductAnalyst`, `AnthropicProductRecognizer`, `AnthropicLabelReader`) own the
answer shapes and send the system prompts. The prompts are Markdown files in `src/prompts/`, not strings in the classes
(see "Prompts"); each call takes its `system` text and its AI job from the generated module.

- **The official SDK, not `requestJson$`.** `@anthropic-ai/sdk` brings Claude's headers, error shapes
  and types, so this is the one vendor outside "Outbound HTTP". It is built with `maxRetries: 0`: the
  job dispatcher is the only retrier, and each request is billed once. `timeoutMs` and a test `fetch`
  are passed through; the client maps SDK errors to the classes below and never reads their `message`.
- **One client, built in the container and injected.** Adapters `import type { AnthropicClient }`
  only, because `concrete-classes-only-in-container` forbids importing a concrete provider class
  anywhere else. The errors and the helpers adapters need as values (`textOf`, `sourceUrlsOf`) live in
  `anthropic.provider.ts`, the one file of the folder an adapter may import as a value. Nothing
  re-exports them from the client. The price table and its functions are there too, because the client cannot
  import a file of its own folder that is not a `*.provider.ts`.
- **Structured outputs, never a forced `tool_choice`.** Sonnet 5.5 rejects forced tool choice, so
  answers are constrained with `output_config.format` (`json_schema`). Callers pass a zod schema and
  get its inferred type back; the client sends `z.toJSONSchema` (not the SDK's `zodOutputFormat`,
  which turns `enum` into description text) and checks the reply with `safeParse`. Schemas use none of
  the keywords the API rejects (length, range and count limits); enums come from vocabularies the
  caller passes in. `max_tokens` leaves room for adaptive thinking, which counts against it.
- **Internals are private class members.** Constants and helpers in the client and adapters are
  `private` class members, not module-level names; only what other files import (the errors, types
  and helpers in `anthropic.provider.ts`) is exported. The client's API key and the SDK client that
  carries it are `#` fields (see "Private members").
- **Web search returns JSON text, checked against the search.** The researcher cannot use structured
  outputs with the search tool, so its prompt demands a JSON-only final answer. The last object in the
  text that fits the shape wins; the `sourceUrl` must be a URL the search returned or a cited page
  (`sourceUrlsOf`), so a made-up page cannot become a source. Anything unreadable or unverifiable is
  `{ found: false }`, never an error.
- **`pause_turn` is resent up to 3 times.** When server tools run long the API pauses; the client
  re-sends the paused content unchanged and returns every block from every round. A fourth pause is
  `AnthropicUnavailableError`.
- **Three error classes, siblings.** `AnthropicUnavailableError`: transport failure (the message says
  timeout or network), 429, 5xx, a reply that is not a message, or a turn still paused: retry later.
  `AnthropicConfigError`: our key, billing or permissions are wrong (401, 402, 403): a setup task, not
  retryable, like a bad ZeptoMail key; a model with no price in the table is the same kind of error. `AnthropicRequestError`: permanent for this input (400, 404,
  413, `max_tokens`, structured JSON that is unparseable or off-schema). `AnthropicRefusalError` is a refusal. Error messages carry the HTTP status,
  `error.type` and `request_id` only, never the key, the request or response content, or the API's own
  `error.message`. An empty key rejects naming `ANTHROPIC_API_KEY` before any request.
- **The researcher's bounds.** At most 150 ingredients, each at most 120 characters after trimming
  and without control characters, or the answer is `{ found: false }`. JSON is extracted in linear
  time, so hostile text with thousands of braces cannot stall the Worker.
- **`imageUrl` hygiene.** Only a URL that passes `isSafePublicHttpsUrl` (`lib/url-safety.ts`) is kept;
  otherwise the image is omitted and the product is still found. This is a first filter: the image
  store (see "Catalog images") checks again.
- **Web pages and product data are data.** Every prompt tells the model to ignore instructions inside
  them, and product details are passed as JSON, not spliced into prose.
- **Providers and modules.** A provider may import a module's vocabulary file (plain constants and types: `product-researcher.provider.ts` takes
  `catalog.vocabulary`, the goal reader `goals.vocabulary`). dependency-cruiser enforces that a provider never touches `drizzle-orm`, a `*.table.ts`
  or `lib/db` (`db-only-in-repositories`) and never value-imports a `*.repository.ts` (`concrete-classes-only-in-container`). It has no rule against
  a provider importing anything else from a module, so keeping to vocabulary files is a convention that review holds.
- **Scan providers read photos.** `AnthropicProductRecognizer` (`recognize`, port `ProductRecognizer`) names the product
  in a photo: a beauty or personal-care product (with brand, name, optional variant, optional form, category and a 0 to 1 confidence),
  `other-product`, `face-or-person`, `label-not-visible` (a beauty product is in view but its label is turned away, covered or out of frame, so there is nothing to read; the prompt says so) or `unreadable`. The brand is the maker's name only (NIVEA, not NIVEA MEN); a sub-line or range printed with it goes at the start of the name, and the name is the product's own front-label name in English, without claims, benefit lines, ingredient call-outs, sizes or translations, and the variant is only what tells editions apart (a shade, scent, strength or SPF number, or a skin-type edition that is part of the name block), never a suitability line, claim or size. `recognizeShelf(image)` (job `recognize-shelf`, prompt `product-recognizer.recognize-shelf.md`) lists every readable beauty or personal-care product on a shelf photo as a `ShelfRecognition`: `products` (brand, name, optional variant and form, category, confidence; at most 5, most confident first, equal confidences in the model's order), `excluded` counts (`otherProducts` and `unreadable`, each floored and clamped to 0 to 50; people and faces are never counted) and a `classification` (`beauty-product` exactly when a product survives, else `other-product`, `face-or-person` or `unreadable`). Each product follows the same text rules as `recognize`; one that fails them is dropped and counted `unreadable`, and the limit of 5 is applied after, so products cut for the limit are counted nowhere. Nothing calls it yet. `AnthropicLabelReader` (`read-label`, port `LabelReader`) copies the
  ingredient list off a label photo, in label order and as printed, never completed from memory, and also the brand, name, variant
  and category (one of the five) when the label prints them, never guessed; it reads no form. Only the ingredient list decides whether the reading is
  readable: a bad entry (over 120 characters, a hidden character, a link or markup), an empty list or more than 150 entries is
  `{ readable: false }`, while each of brand, name and variant that is empty or fails the same checks, and a category outside the five
  (the request advertises the five, but the parse is lenient so it cannot fail the list), is dropped on its own and the rest is kept. `recognize` and `read-label` both run on the vision
  model (`ANTHROPIC_MODEL_VISION`; `recognizeShelf` has its own, `ANTHROPIC_MODEL_RECOGNIZE_SHELF`), send the photo first, use structured outputs and `max_tokens` 4096, and treat the photo
  as user-supplied data. The model is not trusted: a brand, name, variant or ingredient over 120 characters (after
  trimming), with a link, markup or a hidden character (a control character, `\p{Cc}`, or an invisible format character
  such as a right-to-left override or a zero-width space, `\p{Cf}`), or a list of more than 150 entries, becomes
  `unreadable` / `{ readable: false }`, never an error. The link and markup check lives in `lib/text-safety.ts`, shared with
  the catalog.
- **`AnthropicNameSplitter`** (`split-name`, port `NameSplitter`, in `providers/name-splitting/`; `MemoryNameSplitter` is the fake)
  splits a name a user typed into a product: `split(text)` answers `{ kind: 'product', brand, name, variant?, category }` or
  `{ kind: 'not-a-product' }`. The typed text is the only thing in the user message (the system prompt never carries it), the prompt
  tells the model it is user-supplied data whose instructions are ignored, and never to guess or invent a brand, name or variant, and to copy the user's words as typed. The
  schema is one closed object with required `kind`, `brand`, `name`, `variant` and `category` (not a union, which the API does not
  take); a missing text field is read as empty and a category outside the five parses as absent, so a slip is a result and not a
  failed call. Same bounds as the recognizer (each of brand, name and variant at most 120 characters after trimming, no hidden
  character, no link or markup), and a product with an empty brand or name, or no valid category, is `not-a-product`: **a brand-less
  typed name is not a product.** **Provenance:** each of the brand, name and variant must be a stretch of the typed text, compared after `normaliseText` (`lib/normalise-text.ts`, shared with the
  catalog: case, accents and punctuation ignored, `&` is "and", `+` is "plus") **and with the spaces removed**, so "SheaMoisture" matches a typed "shea moisture" and "50 ml"
  matches "50ml"; the user may have typed more. A part the model made up, or a typo it corrected, is `not-a-product`, so it cannot put into the shared catalog a name nobody typed. The category is exempt. The brand and name
  must each keep at least one character after normalising. Runs on the judge model (`ANTHROPIC_MODEL_JUDGE`) with `max_tokens` 4096. A refusal, an unavailable
  model and an unusable answer are thrown as the client's errors; `ScanService.identifyByName` decides what each means.
- **`AnthropicGoalReader`** (`read-goal`, port `GoalReader`, in `providers/goal-reading/`; `MemoryGoalReader` is the fake) sorts the words a user
  typed as their goal: `read(text)` answers `{ goal, wantsLighter }`, `goal` one of the six or null. The trimmed text is the only thing in the user
  message (no lead-in, and the system prompt never carries it), and the prompt tells the model it is user-supplied data whose instructions are
  ignored. The schema is one closed object with a required `goal` (the six goals or `none`, rather than a nullable goal) and a required boolean
  `wantsLighter`; the schema sent carries no `default` (a root `catch` would add one), so the leniency is in the parse alone: each field `catch`es to absent and a reply that is
  not an object reads as an empty one, so any reply off the schema is `{ goal: null, wantsLighter: false }`, never a failed call.
  **`wantsLighter: true` is always `{ goal: 'brighter', wantsLighter: true }`**, whatever goal the model gave: asking to be lighter is a real goal that
  gets a real answer, not a refusal. Runs on the judge model (`ANTHROPIC_MODEL_JUDGE`) with `max_tokens` 4096. A refusal, an unavailable model and a
  rejected request are thrown as the client's errors; `GoalsService` decides what each means.
- **`AnthropicMentionReader`** (`read-mentions`, port `MentionReader`, in `providers/mention-reading/`; `MemoryMentionReader` is the fake, with `calls`, `respondWith` and
  `failNextWith`) lists the products and ingredients named in the words typed beside "a product gave me a reaction" and "I use a prescription": `read(text)` answers
  `Mention[]`, a `{ kind: 'product', brand | null, name, variant?, category | null }` or an `{ kind: 'ingredient', name }`. The text is the only thing in the user message
  (no lead-in, and the system prompt never carries it), and the prompt tells the model it is user-supplied data whose instructions are ignored, to copy the person's words,
  never to list a product's ingredients from memory, and that a thing with no name is a product with no brand. The schema is one closed object with a required `mentions`
  list of closed items, every one of `kind` (product or ingredient), `brand`, `name`, `variant` and `category` (the five, or `none`) required, with no `default`, `minItems`
  or `maxItems`; the leniency is in the parse alone. A reply that is not an object, or whose `mentions` is not a list, is no mentions; an item off the schema is dropped on
  its own; a category outside the five is null and the mention is kept. Bounds, as for the splitter: a trimmed field is at most 120 characters, with no link, markup or hidden
  character (`\p{Cc}`, `\p{Cf}`), and a product or ingredient needs a name. **Provenance**, the splitter's rule: every brand, name, variant and ingredient name must be, after
  `normaliseText` and with the spaces removed, a stretch of the typed text, or the same words in another order as a run of typed words that sit together ("White Caro" typed, "Caro White" read); a mention that fails is dropped whole (so
  an ingredient the model supplied from what it knows never gets through), the category is exempt, and a product with no brand needs no brand check. An ingredient is
  returned as its name alone. At most 10 mentions are kept, counted after dropping. Runs on the judge model (`ANTHROPIC_MODEL_JUDGE`) with `max_tokens` 4096. A refusal, an
  unavailable model and a rejected request are thrown as the client's errors; `SafetyService.parse` decides what each means.

### AI cost tracking
Every Claude request is reserved and settled in a ledger, and counted against a daily dollar figure. **The figure only
alerts** (owner's decision, 2026-10-18): the first call past it emails the owner once that UTC day, and no call is ever
refused, so an environment-wide limit can never leave a user's scan stuck. There is still no Console spend limit behind it.
Only the catalog eval's `MemoryAiSpendLedger` refuses on a cap, so its `--max-usd` really stops spending.

- **Prices** are a table in `anthropic.provider.ts` (`priceOf`, `costMicros`, `estimateMicros`, `estimateInputTokens`),
  from https://platform.claude.com/docs/en/about-claude/pricing, fetched 2026-10-15. Rates are whole numbers in
  thousandths of a micro-USD per token and a call is summed in integers and rounded up once, so floating-point noise
  cannot add a micro. Haiku 5.5 prices a request whose prompt (input + cache reads + cache writes) is over 100,000 tokens
  at a higher tier, output included. Web search is $0.01 a search. Only the 5-minute cache-write rate is priced: no request
  uses a 1-hour `cache_control`, so add a rate for it before ever sending one. When a price changes or a model is added, update the
  table and the date. A model missing from it is refused (`AnthropicConfigError`) before anything is reserved or sent.
- **Reserve, then settle.** Before each request (each `pause_turn` continuation is its own request) the client reserves
  its worst case on the ledger: the input (JSON bytes / 2.5, rounded up, the current tokenizer averaging about 2.5
  characters per token, plus a flat 5000 tokens per image), **plus `SEARCH_INPUT_ALLOWANCE` (25,000 tokens) for every
  search the request permits** (the `max_uses` of its `web_search` tools), **plus `max_uses` × `max_content_tokens` for its
  `web_fetch` tools** (a fetch has no price of its own, only the input tokens of the page; a `web_fetch` tool without both
  limits is refused before anything is reserved), the whole `max_tokens`, and $0.01 per
  permitted search. The search and fetch allowances are added to the input BEFORE the Haiku tier is chosen, so a 5-search Haiku call
  is reserved at the long-prompt rates, as a call that read that many results would be billed. The allowance is a
  calibration knob, not a measured fact: tune it from real `ai_usage` rows (the largest `input_tokens` per search seen on
  a settled research call). The reservation counts against the cap until the call is **settled** or **released**:
  - A reply with usage is settled at the cost of the usage the API reported. A billed reply is settled before it is
    judged, so a refusal, a cut-off answer or invalid JSON still counts.
  - **Unknown outcomes are billed.** A transport failure (timeout, abort or network error), an HTTP 500, 504 or other 5xx, a
    body the SDK could not read, and a 200 that is not a message, or has no usage block, are settled at the reserved
    worst case (usage recorded as zeros),
    because the API may have done the work: what cannot be measured is counted high.
  - **Only a clear "not processed" is released**: any 4xx (429 included) and 529 (overloaded).
  - A ledger that cannot be reached for the reservation fails closed: nothing is sent and the call throws
    `AnthropicUnavailableError` (retryable) with no detail in the message. `AiBudgetExceededError` (only the eval's ledger
    throws it) is passed through as it is.
  - Failing to settle or release never changes the call's result or error and is logged as
    `{ outcome: 'ai-ledger-failed' }`, nothing more.
- **The figure is per UTC day.** `AI_DAILY_BUDGET_USD` in `wrangler.jsonc` (1 locally, 5 on staging, 30 on production).
  `AiUsageService` (an `AiSpendLedger`) stores every reservation, sums settled costs plus open reservations' estimates for
  requests made since 00:00 UTC (a call belongs to the day it was reserved, whenever it settles), and when that sum passes the
  figure it raises the `ai-spend-cap` ops alert (see "Ops alerts"; once per UTC day, however many calls pass it). It never
  throws for the figure. A reservation that is never settled or released (a crash) keeps counting its estimate for that day.
  The container throws a clear error when the variable is not a positive number.
- **The insert and the sum are one batch.** `D1AiUsageRepository.insertReservation` always inserts the row and answers
  `{ overCap }` from the sum since midnight, this reservation included, in one `db.batch` (a transaction on D1), so the
  answer is not made stale by a call that lands between them. The repository contract pins an eight-way race: every row is
  stored and at least those past the figure are flagged.
- **`ai_usage`** (`modules/ai-usage`, migration 0008) has one row per request: id, job, model, status (`reserved`,
  `settled`, `released`), the estimate, and once settled the cost in micros, the five usage counts and the time.
  A reservation that is never settled or released (a crash) keeps holding its estimate for that UTC day; `npm run ai:spend`
  shows these.
  Migration 0028 adds `vendor` and `units` for the per-unit vendor rows (see "Vendor spend ledger").
- **Models per job.** `AnthropicClient` takes a model for each job (`research`, `analysis`, `same-product`, `image-check`,
  `recognize`, `recognize-shelf`, `read-label`, `split-name`, `read-goal`, `read-mentions`, `draft-catalog-row`, `judge-draft`, `judge-routine`, `label-routine`, `judge-grounding`, `write-routine`, `fit-verdict`), set by `ANTHROPIC_MODEL_RESEARCH` (research and draft-catalog-row), `_ANALYSIS`, `_JUDGE` (same-product, split-name, read-goal, read-mentions, and the eval's own jobs judge-draft, judge-routine, label-routine and judge-grounding), `_VISION`
  (image-check, recognize and read-label), `_RECOGNIZE_SHELF` (recognize-shelf, on its own so the eval can move it alone) and `_ROUTINE` (write-routine and fit-verdict, Sonnet, because their words reach users). The owner's rule: a cheap model (Haiku) for the internal steps, a better one
  (Sonnet) for the text users read. Each adapter says which job it is. `recognize`, `recognize-shelf`, `read-label` and `split-name` serve the
  scan flow (see "Scan module"); `read-goal` and `read-mentions` serve onboarding (see "Goals (onboarding)" and "Safety facts (onboarding)"). The yes/no answers get `max_tokens` 4096, because Haiku 5.5's adaptive thinking counts
  against it. A test keeps the eval's default models equal to the top-level `ANTHROPIC_MODEL_*` vars.
- **`AnthropicVerdictFitter`** (`fit-verdict`, port `VerdictFitter`, in `providers/verdict-fitting/`; `MemoryVerdictFitter` is the fake, with `calls`, `respondWith` and
  `failNextWith`) judges the shelf products the verdict's rules floor left open (spec #171): helping, redundant or blocking the goal, with one plain
  reason about the product, and for each clashing pair which one to reduce. One call on `ANTHROPIC_MODEL_ROUTINE` (Sonnet, because the reasons reach users), `max_tokens` 8192,
  prompt `src/prompts/verdict-fitter.fit-verdict.md`. The request (goal, skin type and scan when there are any, every shelf product with its floor status, the
  clash pairs) goes in the user message as JSON, never in the system prompt. The schema sent is a plain object with required `products` and `clashes` (no `oneOf`).
  Each product entry has `sameJobAs` (a string or null, always present, so the schema stays a flat object): a `redundant` entry names the product that does its job and stays,
  and `helping` and `blocking` entries carry null. The adapter throws `AnthropicRequestError`, never returning a partial result, unless the reply has exactly one entry with one of the
  three labels for each open product and none for a fixed one, each reason is not empty (after trimming) and at most 200 characters, every `redundant` entry's `sameJobAs` is a product
  that stays (an open product this same answer labels `helping`, or a fixed product in the group `prescribed`; so never itself, an unknown id, a dropped or stopped fixed product, a
  product labelled `redundant` or `blocking`, or the other half of a mutually redundant pair) and no other label names one, and every clash entry is a pair the request asked about, answered once,
  reducing one of its own two products and never a prescribed one, and returned with the request's order of `ids`. A pair the reply leaves out is not an error: the floor's fixed
  tie-break settles it. The adapter logs nothing. The caller skips the call when no product is open and there are no clashes, and passes the floor's `taper-missing` entries as fixed in the group `likely-the-problem`.
- **`AnthropicCatalogDrafter`** (`draft-catalog-row`, port `CatalogDrafter`, in `providers/catalog-drafting/`; `MemoryCatalogDrafter` is the fake, with `calls`, `respondWith` and
  `failNextWith`) drafts the empty catalog cells of one product for `npm run catalog:draft`: `draft({ product, columns, countries })` (each country with its currency) answers the values of `skin_concerns`, `skin_types`, `steps` and
  `frequency`, each with the page it came from, and a price range for each country. It searches the web (2 searches and one per country, to a most of 6; 16000 `max_tokens`, because Haiku's adaptive thinking and the search rounds count against it as well as the answer, and only the tokens used are billed; an answer cut off or refused throws `AnthropicRequestError` or `AnthropicRefusalError`, as `structured()` does), and, when a country is asked for, may also fetch pages with the `web_fetch` tool (`web_fetch_20260318`, direct calls only so the results come back as top-level blocks, one fetch per country to a most of 4, no `allowed_domains` since the shops are not known in advance, and `max_content_tokens` 12000 because a fetched page is billed as input tokens; the client reserves up to `max_uses` × `max_content_tokens` of fetched input on top of the search allowance; the docs say that bound is approximate and does not cover binary content such as PDFs, so a fetched PDF can bill past the reservation, settled at actual cost as for the judge). The prompt tells the model to use only the pages it
  found, never memory, and to ignore instructions in them. `checkedDraft`, in the port file, keeps only what the workbook can take: the columns and countries asked for, values
  in the vocabularies, prices (rounded half up to a whole unit, and at least 1 after rounding), and a source that is a public https page the search returned or the model fetched (`sourceUrlsOf`, `fetchedUrlsOf`; the script runs it again without the source check). A price row, like a cell, may cite a page the search returned or one the model **fetched** in that same answer; coverage matters more than exactness for a price, since it only feeds a budget band. A fetched page is matched with `comparableUrl` so a trailing slash, a fragment or the case of the host does not matter, while another path or query does. The prompt prefers the product's own page at a shop selling in that country, fetched so the price and pack size are read from the page, and falls back to the price a search result shows for this exact product or a price-comparison page for it. A price row is for one pack size (the prompt says so; sizes, bundles and multipacks are never combined), and `checkedDraft` drops a row whose highest price is over 2.5 times its lowest, since that is not one product's price. `isUsableSource` also refuses a short denylist of classified-ad and auction sites (`ebay`, `jiji`, `craigslist`, `gumtree`, `olx`, on any TLD and subdomain); general retailers and marketplaces are not on it. A price row must not cite a page that lists many products, so `checkedDraft` drops one whose page is a search page (a `search`, `catalogsearch` or `slp` path segment, or a `q`, `query`, `search`, `s`, `k`, `keyword` or `searchterm` parameter) or a listing page (a last segment starting `mlp-`, or a path ending at `brands`, `brand`, `category`, `categories` or `collections` or one segment below it); a price-comparison site is allowed, since a price is an estimate for a budget band; a refused row does not use up its country, and a cell may still cite such a page. It also drops a row whose rounded highest price is over `MAX_PLAUSIBLE_PRICE` for the asked country's currency (GBP 500, NGN 1,000,000; one face-skincare product above that is almost certainly in minor units, £6.50 written as 650, or in another currency; a currency with no entry has no ceiling). It is a heuristic: it catches pence only for a product of £5.01 or more, and for NGN it is a wrong-currency guard rather than a kobo one (₦6,500 in kobo is under it), so the prompt's "pounds not pence" rule is the first defence, and a row whose page is an international storefront (`iherb`, `caretobeauty`, `sweetcare`, `lojaglamourosa`, `stylevana`, `yesstyle`, `cosmetis`, `ubuy`, `desertcart`, on any TLD and subdomain), since those show a price converted for a country they ship to, not a local shop's price; a cell may still cite one, and such a refused row does not use up its country either. `DraftRequest.attempt` (from 1, left out for the first) is set by the script's retry passes: from 2 the user message adds that an earlier attempt found no usable price for these countries, so the model looks more widely (other retailers and pharmacies, marketplace product pages, price-comparison pages for this exact product). It runs on Haiku through `ANTHROPIC_MODEL_RESEARCH`.
  `npm run catalog:draft` (`draftWorkbook` in `scripts/catalog/draft.ts`) makes up to `--passes N` passes (an integer 1 to 5, default 3). Pass 1 researches the ingredient list and drafts the cells and prices. Each later pass revisits only the non-skipped draft products still lacking an Availability row for some wanted country, asking the drafter for those countries alone (`columns: []`, `attempt` set to the pass number), and never researches again; a product that failed in pass 1 is tried again for its prices, and its `failed` entry stays. Only a pass 1 error is recorded in `failed` (at most one entry per product code); an error in a later pass is not a product failing, it leaves the pair unpriced and it shows in the missing list. Rows are checked and appended as in pass 1. The spend cap ends the run with `stoppedBy` `cap`, and a bad key, billing or permission with `config`, in any pass. The report has a line `Prices: X of Y product-country pairs priced after N passes` (a price the workbook already had counts as priced; N is the passes made, so it is 1 when pass 1 priced everything) and, for each product still missing a price, a line `CODE: NG, GB`.
- **Haiku and web search.** Research runs on Haiku by default; that it supports the `web_search` server tool is checked
  by the eval's research mode (`npm run eval:catalog -- --mode research`), and the Models API field
  `capabilities.server_tools.web_search.supported` is the authority. If it is false, set `ANTHROPIC_MODEL_RESEARCH` to
  another model.
- **Seeing the spend.** `npm run ai:spend -- --env staging` (`local` by default, or `production`; `--days N`, default 30)
  reads `ai_usage` through `wrangler d1 execute` and prints today, the last 7 days and the last N days in dollars (settled
  cost only), a line "held by unsettled reservations" with the estimates still reserved and how many, then each job and
  model. It is read-only. The catalog eval reports its own cost (see "Catalog eval").

### Perfect Corp provider
Face photos are analysed by Perfect Corp (YouCam), behind a `PerfectCorpClient` port (`providers/perfect-corp/perfect-corp.provider.ts`) with
one adapter, `RestPerfectCorpClient` (`rest.perfect-corp.ts`), and a memory fake, `MemoryPerfectCorpClient`. It is REST only, so there is no
vendor SDK; the adapter calls the API through `requestJson$` (and `requestBytes$` for masks), bearer-authorised with
`PERFECT_CORP_API_KEY`, against `PERFECT_CORP_BASE_URL`. No retries here (the job system retries), and nothing is logged.
The API key and webhook secret are `#` fields so they stay out of `JSON.stringify`.

- **The port.** `uploadFile` (a slot request, then a PUT of the bytes to the slot's own address, method and headers, without our key),
  `createSkinAnalysis` (HD actions, `format: json`), `createFitzpatrick`, `getSkinAnalysis`, `getFitzpatrick`, `deleteTask`,
  `downloadMask` (capped, no redirects, no key) and `checkWebhook`. A task read answers `running` or `success` with the parsed result;
  a task that ended on an error throws.
- **Error mapping.** Four classes, so a caller chooses by class and never reads vendor text:
  - `PerfectCorpUnavailableError`: no connection, a timeout, HTTP 5xx, 429 or 408, a reply that cannot be read (no task id, no results, a
    status it does not know), and any task error that is not a photo problem. Retry with jitter.
  - `PerfectCorpRejectedPhotoError` (with a fixed `reason`): a task error that a retake fixes. `error_lighting_dark` is `too-dark`;
    `error_pose` and the three `error_face_angle_*` are `turn-to-camera`; `error_src_face_too_small` is `move-closer`;
    `error_src_face_out_of_bound` is `face-not-centred`; `error_no_face` is `no-face`; `error_below_min_image_size` and
    `error_exceed_max_image_size` are `image-size`; the Fitzpatrick analyzer's own codes are `error_insufficient_lighting` (`too-dark`),
    `error_face_angle_invalid` (`turn-to-camera`), `error_face_position_too_small` (`move-closer`) and `error_face_position_invalid` and
    `error_face_position_out_of_boundary` (`face-not-centred`). Exact matches only. Perfect Corp charges only on success, so a rejection costs nothing.
  - `PerfectCorpCreditError`: HTTP 400 with `error_code` `CreditInsufficiency` (on a 400 only). Not retried: an ops alert, not a retry storm.
  - `PerfectCorpBadRequestError`: every other 4xx, a mask address that is not an absolute `https:` URL (refused before any request is made:
    the address comes from the vendor's reply, so a plain, local or odd scheme is never fetched), a mask over the size cap, and a mask
    answered with a redirect.
  Error messages carry the class, an HTTP status or a code-shaped vendor code, and nothing the vendor wrote: its free text can echo an
  address with a signature in it.
- **Webhooks** follow Standard Webhooks (standardwebhooks.com). `checkWebhook(rawBody, headers)` needs `webhook-id`,
  `webhook-timestamp` (seconds, digits only, within 5 minutes either way) and `webhook-signature` (space-separated `v1,<base64>`
  entries; any one may match, other versions are ignored). The signature is HMAC-SHA-256 over `id.timestamp.body` with `crypto.subtle`,
  keyed with the base64-DECODED secret (`whsec_` stripped when present), compared in constant time. Only after that is the body read: it
  needs `data.taskId` and a `data.taskStatus` (what Perfect Corp sends) or the documented `data.task_id` and `data.task_status` (snake_case wins per field when
  usable), the status being `success` or `error`. A rejected status that is an enum-like word is logged as `taskStatusValue`. Anything else resolves to a rejection naming the reason (never throws), and the route
  answers 401. A rejected delivery is logged as `perfect-corp-webhook-rejected` with that reason (read with `npx wrangler tail --env staging`), never the
  secret, a signature or the body. The clock is injected.
- **Unverified vendor shapes.** The skin-analysis result (`data.results.output` items with `type`, `region`, `raw_score`, `ui_score`,
  `mask_urls`, `skin_type`, and the `skin_age` and `all` items), the Fitzpatrick result (`data.results.fitzpatrick_scale`), the `error_code` body and the GET
  and delete paths are pinned from the brief and Perfect Corp's documents. Check them against a real staging response before relying on them.
  An `hd_*` item with both scores but no string `region` (the reference gives hd_age_spot, hd_redness, hd_radiance and others no subcategories) is read
  as region `whole`; one missing a score is left out and reported in the result's `skipped` (type and `no-scores` only). `FaceScanService` logs
  `face-scan-concern-missing` (concern, the concern names that did come back, `skipped`; no scores, links or photo) once per goal concern absent from a stored result.
- **The memory fake** logs every call in order with its arguments (a scripted failure too, since the call was made), and `script(method,
  ...answers)` queues answers handed out one per call (an `Error` is thrown as itself). Its defaults keep a service waiting (tasks are
  `running`) and fail a webhook closed.

### Face scan tables
`modules/face-scans/face-scans.tables.ts` holds the face-scan rules as pure, versioned tables: no I/O, no clock, no model, so the same
results always give the same words. Everything reads `raw_score` (1 to 100, HIGHER IS HEALTHIER), never `ui_score`.

- **Tables and versions.** Each has a constant that a stored result will carry, all `1` today except `GOAL_CONCERNS_VERSION` (`2`), `VISIBILITY_VERSION` (`3`) and `WORDING_VERSION` (`2`): `GOAL_CONCERNS_VERSION` (`concernsForGoal`,
  the goal's own three concerns, which drive `seen`, `sinceDayOne` and `nothingStandsOut`; `measuredConcernsForGoal`, those three in goal order and then the core
  concerns the goal lacks, in core order (`hd_age_spot`, `hd_acne`, `hd_pore`, `hd_oiliness`), 4 to 7 per goal; and `hdActionsForGoal`, the measured concerns plus
  `hd_skin_type`, 5 to 8 actions, the 16-unit HD tier. Why every goal measures the core four: the routine stage needs the whole picture (a glow user with spots needs
  products that do not clog pores; on darker skin dark marks are the most common concern), and a concern not measured on day one can never show change since
  day one; the goals come from `goals.vocabulary.ts` and an unknown name throws), `VISIBILITY_VERSION` (`isVisible`, `bandFor`), `WORDING_VERSION` (`WORDING`, `seenWords`),
  `SKIN_TYPE_VERSION` (`skinTypeLabel`), `CHANGE_VERSION` (`concernChange`, `skinAgeChange`), `CHASE_VERSION` (`chaseStartFor`, the 90-day
  resume rule, `RESUME_DAYS`; issue #145) and `REVIEW_VERSION` (`REVIEW_WEEKS`, `reviewPointFor`, below; issue #145). Change a table, bump its version.
- **The review table and the check-in scan's actions (issue #145).** `REVIEW_WEEKS: Record<Goal, number>` gives each goal its review week, 6 for
  every goal today and every number a placeholder to tune later as a reviewed change. `reviewPointFor(dayOneAt, goal)` is day one plus that many
  weeks, to the millisecond, keeping day one's time of day and never mutating it. `hdActionsForCheckIn()` is what the chase's wider check-in scan
  asks Perfect Corp for: all nine `SHOWN_CONCERNS` plus `hd_skin_type`, ten actions, the HD 9-to-12 tier (20 units), against the 5 to 8 actions (16
  units) of a normal scan.
- **The visibility cut-offs are per concern (visibility v3).** Perfect Corp's `raw_score` sits on a different range for each concern, so each has its own
  three cut-offs (a score at or below one is in that band): `visible` (the `a-little` band's top), `some` and `clear`. Above `visible` is `faint` (`bandFor`
  returns it; `isVisible` means "not faint"). The values are in `THRESHOLDS` in `face-scans.tables.ts` (`face-scans.tables.test.ts` pins every boundary and
  that they are strictly ordered). Provenance: calibrated 2026-10-23 on 40 Chicago Face Database photos (mostly Black, some Indian and multiracial) against
  blind visual ratings by an AI rater, so a first calibration, to be re-checked by a human rater experienced with skin of colour and on real app selfies
  (`research-visibility-thresholds.md`, "Evaluation results"). Confidence: redness, texture and moisture are low (redness was at chance on the darker half;
  texture and moisture barely tracked the ratings); pore is low too (39 of 40 photos rated visible); acne and shine are weaker on the darker half.
  The change thresholds (5 points for a concern, 2 years for skin age) are still placeholders, and the overlays and skin age have not been checked on
  darker skin (see CONTEXT.md). A change counts only when it is bigger than that; exactly that much is noise.
  A rise in a concern is "fainter", a fall "more visible"; no change is ever worded as lightness.
- **The wording** is one text per concern and band (`faint`, `a-little`, `some`, `clear`), with a `whole` text that answers any region without words of its own (region-specific
  words are added once Perfect Corp's region names are confirmed). Every text describes only what can be seen, in 80 characters or fewer, with
  no digit, no exclamation mark, no condition name, no "acne" (spots and breakouts are what show), no "you have" and no lightness word.
  `face-scans.tables.test.ts` scans every string for these, so a new text that breaks one fails there. The skin age is the one text with a
  number, and it is a plain fact (`Your skin looks about 29`) that never compares with a real age.
- **Skin type** is read from the whole-face `hd_skin_type` item only (never guessed from the t_zone and u_zone items): `Oily`, `Dry`,
  `Combination` and `Normal`, with or without `& Redness`, in any case; plain `Redness` is normal; anything else is null.

### Face scans
`modules/face-scans` is the face scan (#112), built as five stacked changes. The first was the pure rules (`face-scans.tables.ts`) and the Perfect Corp
provider, the second the **records** (consent, the scan and its photos, the routes, the queue and the cleaner), the third the **analysis
pipeline**: the job that sends the front photo to Perfect Corp and copies the results back, the webhook that wakes it, the retake, the reaper's one
check, the live stream and the spend. The fourth is the **result view**: what a ready scan shows (see "The result view" below). This one (5 of 5) is the **push
notifications** (see "Pushes" below).
Face scans split by what a guest may do. A guest may **run the scan flow**: give consent (`PUT /me/face-consent`), start a scan, retake it and follow it live; those four routes use `signedIn()` as their early exit and their `FaceScanService` methods (`giveConsent`, `create`, `retake`, `watch`) need only `requireUser()`. Everything that shows or manages what the scan found is for **verified users**: reading and withdrawing the consent, the list, reading a scan and deleting one. Those five routes use `verifiedUser()` as their early exit (403 `VERIFICATION_REQUIRED` for a guest, 401 with no token) and their methods (`consent`, `withdrawConsent`, `listFaceScans`, `getFaceScan`, `deleteFaceScan`) start with `requireVerified()`, before the ownership check, so a guest gets 403 for any id, never 404. The live stream carries **status only**: every `face` frame is exactly `{ id, state, reason }` (plus `done`), for every state including `ready`, and never a result, score, skin age or type, overlay or photo link, or goal and rescan information, so a guest learns the next step (analysing, needs a retake and why, failed and why, ready) and must verify and `GET /scans/faces/{id}` to see the result. The create and retake `202` answers show no result either. `latestSkinType()` (read by the recommendations) stays `requireUser`. The photo link and the Perfect Corp webhook are credential-gated (a signed link, a signature), and the job-driven methods run as the system.
`FaceScanService` takes the goals service (`requireGoal`, `current`, `history` and `historyFor`, as a type-only `Pick`; services may depend on services), the photo
store, the job queue, the Perfect Corp client, the vendor spend ledger (`aiUsage`), the scan events, the notifications (`Pick<NotificationsService, 'faceScanReady' | 'faceScanNeedsRetake' | 'faceCheckInDue'>`) and the ops alerts (`Pick<OpsAlertsService,
'raise'>`). The container builds one `RestPerfectCorpClient` from `PERFECT_CORP_API_KEY`, `PERFECT_CORP_WEBHOOK_SECRET` and `PERFECT_CORP_BASE_URL`.

- **Tables (migration 0029).** All carry `user_id` (so the guest cleanup needs no join) and cascade from `profiles`; the children cascade
  from `face_scans`. `face_consents` (one row per profile: version, given and withdrawn times), `face_scans` (`state` `analysing` |
  `needs-retake` | `ready` | `failed`, `reason`, `goal_at_scan`, the Perfect Corp task ids and environment, `skin_age`, `skin_type`, `tables_version`,
  timestamps; indexed on `(profile_id, created_at)`; migration 0030 adds `reaper_checked_at` and indexes on both task-id columns and on
  `(state, updated_at)`; migration 0034 adds `check_in`, last, because the conditional `createFaceScan`'s `INSERT ... SELECT` lists columns by
  position), `face_scan_photos` (one per scan and position `front` | `right` | `left`, the primary key),
  and, filled by the analysis, `face_results` (per concern and region: `raw_score`, `ui_score`), `face_masks` (an R2 key per concern) and
  `profile_fitzpatrick` (`I` to `VI` and the task id). The view shows the scores' words and the mask links, never the scores, and never the Fitzpatrick type. `reason` is `unavailable` or `consent-withdrawn` for a
  failed scan, and for a scan that needs a retake one of `REJECTED_PHOTO_REASONS` (`too-dark`, `turn-to-camera`, `move-closer`, `face-not-centred`,
  `no-face`, `image-size`); the column is plain text and the enum is the TypeScript table's.
- **`face_check_in_pushes` (migration 0035)**: one row per chase that has been dealt with, primary key `(profile_id, day_one_scan_id)`, with `user_id`, `goal` and `sent_at`;
  cascades from `profiles`, and `deleteForUsers` removes it for the cleaner. There is no foreign key to the scan, so deleting a scan never makes a push due again.
- **Check-in push.** `FaceScanService.sendDueCheckIns(now)` runs from the daily cron with no actor and answers how many pushes it queued. `checkInPushCandidates` lists
  (oldest first, at most 200) the ready, non-check-in scans taken at least the shortest review week ago whose chase has no recorded push and no check-in that is not
  failed, and, when the profile has a goal history, only those taken under its current goal (so goals it left cannot fill the limit; they count again on return). The
  repository joins `profile_goals` for that. Each candidate is then confirmed by the pure rule with `GoalsService.historyFor(profileId)` (the session-free twin of
  `history`): `chaseStartFor` must find the goal current now, and the candidate must be the first ready scan of that chase (`dayOneFor`) with `now` at its
  `reviewPointFor`. A candidate that is a day one of an earlier chase of the goal is recorded without a push so it leaves the list; so is one whose profile has an empty goal history (a switched-away goal, with history, is skipped unrecorded). `recordCheckInPush` is written BEFORE
  `faceCheckInDue` is called and only a write that landed calls it, so a chase is told at most once; a queue that is down is logged `{ outcome: 'check-in-push-failed',
  profileId, dayOneScanId }` and that chase is not tried again. The `scanNeedsYou` switch is read when the push is sent, not by the sweep: with it off the push is dropped there
  and the chase stays recorded.
- **Consent.** `CURRENT_FACE_CONSENT_VERSION` (1) is the version of the wording; bump it and every earlier consent stops counting.
  Consent belongs to the profile. `PUT /me/face-consent { version }` records it (any other version is 400 `FACE_CONSENT_VERSION_MISMATCH`
  with `details.current`; giving again starts it afresh and clears a withdrawal), `GET` shows it (404 `FACE_CONSENT_NOT_FOUND` until given; a
  withdrawn or older one is shown with `current` false), and `DELETE` stamps the withdrawal time and keeps the row (204, also when there is nothing to withdraw).
- **Creating a scan.** `POST /scans/faces` takes multipart `front` (required) and `right` and `left` (optional). Middleware, in order:
  `FACE_SCAN_IP_LIMITER` (20 a minute) → `signedIn` → `FACE_SCAN_USER_LIMITER` (10 a minute) → `bodyLimit` (3 x 6,000,000 + 1,000,000 bytes).
  The service then checks, in this order, and stores and queues nothing until all pass: consent (409 `FACE_CONSENT_REQUIRED`: none, withdrawn, or an
  older version), the goal (409 `GOAL_REQUIRED`, from `GoalsService.requireGoal`), whether a scan is due (429 `FACE_SCAN_NOT_DUE` with `details.reason`),
  then every photo (400). A photo is a JPEG, decided by its bytes and never by what the caller claims: `UNSUPPORTED_IMAGE` for anything else (and for
  a header over 4096 px, which `readImageHeader` reads as no image), `IMAGE_TOO_SMALL` for a shorter side under 1080 px, `IMAGE_TOO_LARGE` over 6,000,000
  bytes. Then it writes **R2 before the database**, deleting the photos again if the write fails; saves the scan and its photo rows in one `db.batch`;
  and enqueues `analyse-face-scan { faceScanId, step: 'upload', at }`. If the enqueue fails the scan is marked `failed` / `unavailable`
  (kept, with its photos, so the user can see and delete it) and the call still answers 202. The AI spend ledger is not touched: Perfect
  Corp is charged when a result comes back.
- **Double-submit guard.** Two requests for one profile (a double tap, two devices) can both read "no scan under this goal yet" before either writes, so
  the check alone cannot stop them. The write does: `createFaceScan(scan, photos, { expectLatestId })` stores the scan only if the profile's latest
  non-failed scan (ordered as `latestForProfile` is, `created_at` then `rowid`) is still `expectLatestId` (null for none), and answers true or false. On D1
  that is one `db.batch` whose first statement is `INSERT ... SELECT ... WHERE (latest) IS ?` and whose photo inserts are `WHERE EXISTS` that scan row; the
  answer is the first statement's `meta.changes`. Writes in a batch are serialised, so exactly one of any number of simultaneous requests lands. The service
  passes the id it read; on false it deletes the photos it put, queues nothing and throws 429 `FACE_SCAN_NOT_DUE` with the reason that fits the
  verdict it already had (`check-in-taken` for a lost check-in, else `already-scanned-for-goal`). Without the
  option the write is unconditional. There is deliberately no unique index on (profile, goal): going back to an earlier goal is allowed once another scan came between.
- **The policy** (`face-scans.policy.ts`, pure; issue #145): `mayScanNow({ goal, history, scans, at })` is the due rule. A goal's chase (`chaseStartFor`,
  read from `history`, the profile's goal rows oldest first) gets **one scan**, plus **one wider check-in scan** once it reaches its review point;
  switching away and back inside the resume window can never unlock another. Only `scans` inside the current chase count (filtered by `goalAtScan`
  and the chase start, with **no upper bound**: a scan stamped after `at`, by clock skew between isolates or a rival stored mid-read, still counts; `at` only
  decides the chase start and whether the review point is reached); a scan that **failed** counts as nothing (not the chase's scan, not its day one, not its check-in). It answers:
  - `{ allowed: true, checkIn: false }` when the chase has no non-failed scan yet (a first chase, or a fresh restart after the 90-day window);
  - `{ allowed: true, checkIn: true }` when the chase has a day one (its first **ready** scan) and `at` is at or past `reviewPointFor(dayOne.createdAt,
    goal)`, and the chase has no non-failed check-in yet;
  - otherwise refused: `already-scanned-for-goal` when the chase has a non-failed scan but no ready day one yet (the first scan is still analysing or
    needs a retake); `check-in-not-due` (carrying `due`, the review point) before the review point; `check-in-taken` once the chase has had its check-in
    (an analysing or needs-retake check-in counts as taken; a failed one does not, so the user may take it again);
  - `{ allowed: false, reason: 'scan-limit', nextScanAt }` when the chase has no non-failed scan but the profile's last **day-one** scan (`lastDayOneAt`: its newest
    non-failed, non-check-in scan under any goal, from `latestDayOneForProfile`) was less than 30 days before `at` (`SCAN_SPACING_DAYS`); `nextScanAt` is `lastDayOneAt` + 30 days,
    and exactly 30 days is allowed. So changing goal never unlocks a paid scan. Check-ins do not count towards the 30 days and are not limited by it; a profile's first scan is always allowed.
  `FaceScanService.create` reads `latestForProfile` first (the double-submit guard's target), then `latestDayOneForProfile`, then the history and the scans, and takes `now` only after those
  reads, so a rival scan stored in the middle is stamped no later than `now`; that `now` is also the time the scan is stored at and `checkInDueAt` is worked out from. It calls the policy with `history = goals.history()`, `since = chaseStartFor(history, goal, now)` and `scans =
  repository.scansUnderGoalSince(profileId, goal, since)` (every scan under the goal since the chase start, whatever state, read without judging it:
  the policy alone decides what it means). The 429's `details.reason` is one of the four above (`scan-limit` carries `details.nextScanAt`, an ISO string, instead); `check-in-not-due` alone also carries
  `details.checkInDueAt`, the ISO date of `reviewPointFor(dayOne.createdAt, goal)` (`createdAt`, never `updatedAt`).
- **`rescanSuggested`** is the due rule itself, reused: `mayScanNow(...).allowed` for the profile's current goal, worked out once per list (no
  goal, or typed words nobody sorted into one, suggests nothing). It is **derived when read**, never stored, and so is true exactly when `create`
  would allow a scan now, whether a first scan or the chase's check-in. It passes `lastDayOneAt` too, so inside the 30-day limit after another goal's day-one scan it is false.
  It has no upper-bound filter of its own: it is the same policy call.
- **Reading, deleting.** `GET /scans/faces/{id}` shows the scan (`id`, `state`, `reason`, `goal` it was taken under, `createdAt`, a signed link
  per photo, `rescanSuggested`) and `result`, which is null until the scan is `ready`. The stored `check_in` flag (below) is read by the policy
  alone and never appears in the view. `DELETE /scans/faces/{id}` deletes the photos and masks from the bucket first, then the rows, then the keys a scan can have (its three photo positions and the
  `mask-<concern>.png` of every concern measured for its goal, the core extras too) once more, so a mask written by an analysis that committed between the key read and the row delete does not
  stay in the bucket (204). Another profile's
  scan, of this account or any other, is 404 `FACE_SCAN_NOT_FOUND`, the same as one that does not exist.
- **The result view.** `view()` fills `result` only when `state` is `ready` (create and retake answers always have `result: null`). It is built when the
  scan is read, from the stored rows, by the pure `resultView` in `face-scans.tables.ts`, so a change to the wording tables reaches scans already stored;
  `tablesVersion` in the view is the version in force now, not the one the scan was stored under (`face_scans.tables_version` still says which wrote it).
  - **Seen (visibility v3, show all).** For each of the goal's three concerns, in goal order, the `raw_score` of its `whole` region row (else the first region
    by name), through `bandFor`. Every concern with a row is listed; one Perfect Corp did not return is left out. A score above the cut-off is the `faint` band:
    shown, but worded as hardly there ("Hardly any spots", "Skin looks smooth"), never claimed to be clearly seen. Each item carries `level`
    (`faint` | `a-little` | `some` | `clear`), a word and never a number, so the app can style it (a faint one subdued, its overlay off until tapped). Why: the
    cut-offs are a first calibration, low-confidence for some concerns (see `research-visibility-thresholds.md` in `.humanlayer/tasks/face-scan/`), and a real scan hid texture, which the owner doubted;
    until they are re-checked, hiding a concern on a doubtful number is worse than showing it as faint. Concerns go out by `CONCERN_IDS` (`spots`, `pores`, `shine`,
    `marks`, `redness`, `glow`, `texture`, `under-eyes`, `dryness`), never Perfect Corp's `hd_*` names. `nothingStandsOut` is `NOTHING_STANDS_OUT` when every item is
    `faint` or `seen` is empty, and null otherwise.
  - **Also noticed.** `alsoNoticed` lists the measured concerns that are not the goal's own three (`measuredConcernsForGoal` minus `concernsForGoal`: the core extras)
    whose band is visible (`a-little`, `some` or `clear`), in core order, each shaped like a `seen` item. A faint extra is not listed (it stays stored for the
    routine stage), nor is one Perfect Corp did not return. Extras are never part of `sinceDayOne` or `nothingStandsOut`. A scan taken before the core extras
    were measured has no rows for them, so its `alsoNoticed` is `[]`; it is `[]` too when no extra is visible. The never-rules hold for it as for `seen`.
  - **Overlays.** The mask key of every concern in `seen`, faint ones included, and of every concern in `alsoNoticed`, is signed with `signPhotoLink`, with the same 5-minute life and profile claim as a
    photo, so `GET /scans/faces/photos/{token}` serves it. A concern outside `seen` and `alsoNoticed` (a faint extra, or one not returned) gets no link, and none is signed; one with no stored mask has `overlay: null`.
  - **Day one.** A goal's *chase* is a continuous run of working on it, read from the profile's own goal history, never from scan dates (issue #145).
    Leaving a goal and taking it up again within `RESUME_DAYS` (90) of leaving continues its chase; a longer gap starts a new one. Day one is the first
    `ready` scan of the chase that contains the scan's own time: a short detour to another goal is a break in the chase, not the end of it, so the
    progress a user had on a goal they come back to within the window still counts, and a goal left for longer starts a fresh chase with its own
    day one. (Whether that also makes a scan due is "The policy" below, unchanged by this rule.)
    `chaseStartFor(history, goal, at)` (`face-scans.tables.ts`) is the pure rule: `history` is the profile's goal rows, oldest first (`GoalsService.history()`),
    a row is current from its `createdAt` inclusive, consecutive rows of the same goal merge into one run, and a row of another goal or a null goal (typed
    words nobody sorted yet) counts as leaving. `FaceScansRepository.dayOneFor({ profileId, goal, at, since, scanId })` then answers the earliest `ready`
    scan under `goal` with `createdAt` between `since` (the chase start) and `at`, and S itself when S is its own day one (the service turns that into
    `sinceDayOne: null`). A scan under another goal inside the window is no cut-off here: the chase already decided that. `since` and the upper bound are
    by timestamp alone, and candidates that share a timestamp go to the lower id; two scans of one profile cannot share a millisecond in practice, and
    `scanId` is kept for the tie-break should one be needed. Deleting the day-one scan makes the next one in the chase the day one: nothing is stored.
    Scans that failed, need a retake or are analysing neither count nor cut.
  - **Since day one.** The row read for each of the goal's concerns on both scans (the `whole` one, else the first region by name), through `concernChange`,
    worded by `changeWords`; a concern missing on either scan, or read from different regions on the two (a cheek is not compared with the whole face), is left out, and the skin age through `skinAgeChange` and `skinAgeChangeWords` (null if either scan has none). The API spells the changes
    `fainter`, `more-visible`, `no-clear-change`; the tables keep their spaced values. The only number in a result is `skinAge.years`.
  - **Next goal.** Every ready result carries `nextGoal`, a goal or null, added by `FaceScanService.result()` on top of `resultView`'s output (the view's own keys
    stay as they are). Only a check-in scan (`scan.checkIn`) can have one; every other scan has null, in the list and in `getFaceScan` alike. `nextGoalFor`
    suggests nothing unless at least one of the scan's own goal's concerns got `fainter` since the chase's day one (read from the same region on both scans). It
    then scores each other goal by the bands of its concerns that are not the current goal's (clear 3, some 2, a little 1, faint or missing 0), the highest
    wins, a tie goes to the earlier goal in `GOALS`, and all zeros means none. `brighter` is a candidate only when the profile ever wanted lighter
    (`history.some((row) => row.wantsLighter)`): it is never offered unasked. With no day one, `nextGoal` is null.
  - **Never** in the view: a score (`raw_score`, `ui_score` or the overall `all`), a Perfect Corp concern name, a condition name, the Fitzpatrick type, or a
    word about lightness. The tables test scans every string, and the pipeline and route tests scan the serialised view.
- **Photo links.** The view signs a 5-minute link per photo with the profile claim (see "Private photos"), only after the ownership check. `GET
  /scans/faces/photos/{token}` is public (`security: []`): the link is the credential, so the profile in the token is what keeps the account's
  other profiles out. `photoForLink` serves only `faces/` keys (404 `PHOTO_NOT_FOUND` otherwise, including a validly signed product link), and the
  product route refuses `faces/` keys the same way. Routes carry the tag "Face scans"; the error codes are in their descriptions.
- **The list.** `GET /scans/faces` (`listFaceScans`, `verifiedUser`) answers `{ faceScans }`: the current profile's latest 20 scans (`FACE_SCAN_LIST_LIMIT`; no cursor,
  like the shelf), newest first by `created_at` then id, in every state, each the very view `getFaceScan` builds. It needs no consent and no goal, so it works after
  consent is withdrawn, and an empty profile gets `[]` with a 200. `FaceScansRepository.listForProfile(profileId, limit)` serves it; `rescanSuggested` is a fact
  about the profile, so the service works it out once and hands it to each `view`, together with a cache of the day-one scans' scores (scans under one goal share a day one, so each
  is read once per list) and the goal history (read only when the profile has a current goal, fetched once and shared: `rescanSuggested`'s own due check now needs it too, not only a ready scan's day one).
- **The skin type.** `FaceScanService.latestSkinType()` answers the skin type of the profile's newest **ready** scan (`FaceScansRepository.latestReadyForProfile`, ordered by `created_at`
  then `rowid`), or null: no ready scan, or none sent a type. A newer scan that is analysing or needs a retake does not hide an older ready one; a newer ready scan with no type is the answer, and
  does not fall back to an older reading. It needs no consent and reads only. `RecommendationService` asks it for the skin-type rule (see "Shopping facts and candidates").
- **The queue.** `analyse-face-scan` is alone on the `face-scans` queue (`deepertones-face-scans-<env>` and `deepertones-face-scans-dlq-<env>`),
  bound as `FACE_SCANS_QUEUE` in all three `wrangler.jsonc` blocks. The consumer takes one message at a time (`max_batch_size` 1, 4 retries): a
  message is one exchange with Perfect Corp. Create the queue and its dead-letter queue in each environment before the deploy. The two limiters
  have namespace ids 1026/1027, 2026/2027 and 3026/3027.
- **States.** `analysing` becomes `ready` (results copied), `needs-retake` (Perfect Corp refused the front photo; `reason` is one retake reason) or
  `failed` (`unavailable` or `consent-withdrawn`); `needs-retake` becomes `analysing` again on a retake. `ready` and `failed` are final. Every change is
  a conditional `updateFaceScan(id, expectedState, patch)`, so of two simultaneous callers exactly one wins and a late message does nothing.
- **The job** `analyse-face-scan { faceScanId, step, at, webhookId? }` has three steps, all in `FaceScanService.advance`. The key is
  `<id>:<step>:wh:<webhookId>` when a webhook woke it and `<id>:<step>:<at>` otherwise, so a webhook delivered twice is one run (the dispatcher's
  `job_runs` claim acks the repeat; there is no table of webhook ids).
  - `upload`: does nothing for a scan that is gone, not `analysing`, or that already has its analysis task (a message taken over after its lease must not
    pay twice). It re-checks consent (no current consent fails the scan as `consent-withdrawn` with no Perfect Corp call), reads the front photo (missing:
    `failed` / `unavailable`), uploads it, creates the skin analysis for `hdActionsForGoal` (a normal scan) or `hdActionsForCheckIn` (`scan.checkIn`) and
    stores the task id and `pc_environment` at once. A profile with no `profile_fitzpatrick` row and no Fitzpatrick task on the scan also gets a
    Fitzpatrick task; an error there is logged by name and never fails the scan.
  - `fetch`: asks for the task (`running` does nothing; the webhook or the reaper comes back). On success it downloads the mask of each concern measured for the goal (its own three and the core extras)
    that has one (the `whole` region's if it has several, else the first), puts each in the private bucket as
    `faces/<env>/<user>/<profile>/<scan>/mask-<concern with _ as ->.png`, then `completeFaceScan` writes the `face_results` rows (every concern item and
    region, plus the overall score as concern `all`, region `whole`), the `face_masks` rows, `skin_type` (`skinTypeLabel`), `skin_age`, `tables_version`
    (`TABLES_VERSION`) and `state = 'ready'` as one batch that holds only while the scan exists and is `analysing`. When it does not (deleted, or moved on,
    while the masks were downloading) the masks just written are deleted again, so nothing is left in the bucket for a scan that is gone. The spend is
    recorded **as soon as Perfect Corp reports success**, before the masks are downloaded (Perfect Corp bills on the task's success, not on our write, so a
    scan deleted or a download failing after that must not leave a charge off the books), as `face-analysis` with the units for the action count (1 to 4: 12,
    5 to 8: 16, 9 to 12: 20, 13 to 16: 22; a normal scan asks 5 to 8, so 16 units, and a check-in asks 10, so 20), keyed by the task id; a ledger failure is logged (`spend-record-failed`, with the task id) and never fails the step. After
    the write, if the scan has a Fitzpatrick task and the profile still has no type, a `fitzpatrick` step is queued for it (a backstop for a lost webhook). Then
    Perfect Corp's copy is deleted (best effort; a failure logs the error's name only) and the stream gets the `ready` frame and `done`.
    The step also logs, to learn what Perfect Corp really sends (no address, score or pixel): `{ outcome: 'front-photo-read', faceScanId, width, height }` once
    per read (null when the stored photo cannot be read) and per mask `{ outcome: 'mask-read', faceScanId, concern, format: 'png' | 'jpeg' | 'other', width, height, bytes }`
    (`describeImageBytes`, from the magic bytes and the PNG or JPEG header; null size when unknown).
  - `fitzpatrick`: stores the type for the profile (insert, first read stands) and records 10 units keyed by the task, then deletes their copy. It never
    changes the scan and is never shown. A task that already gave the profile its type only has its copy deleted again; a task that succeeds after another
    one gave the profile its type is still charged, so its spend is recorded (a ledger failure is logged, not retried) before its copy is deleted.
  - **Perfect Corp's copy of the photo.** The face photo must not outlive the scan at Perfect Corp, so `deleteTask` (best effort: the error's name is logged as
    `task-delete-failed`, nothing else changes) is called for **both** the analysis and the Fitzpatrick task, when set, when a scan goes to `failed` (any
    reason: credit, bad request, the reaper's 2-hour give-up, the dead-letter hook, consent withdrawn), when the user deletes it, and for the analysis task
    when it goes to `needs-retake`. The one exception: a Fitzpatrick task is **kept** on a `needs-retake` scan while the profile has no Fitzpatrick row, since
    it is a read of the same face and may still complete (its own step deletes it). A task created by an upload that then loses (the scan was deleted or failed,
    or a second upload stored its task first; the task id is stored only while the scan has none) is deleted at once. **Not covered:** the account and guest
    purge (`FaceDataCleaner`) does not reach Perfect Corp; tasks there expire on their own. **A failed delete is logged, not retried**, a deliberate deviation from
    the spec's "retried" (a retry would need a place to remember the task id once the scan row is gone).
  - **Perfect Corp's errors**, mapped alike in every step that calls it: `PerfectCorpRejectedPhotoError` sends the scan to `needs-retake` with the reason
    (no spend); `PerfectCorpUnavailableError` is rethrown for the queue to retry (after 4 retries the dead-letter hook fails the scan as `unavailable`,
    except for a `fitzpatrick` step, which leaves the scan alone); `PerfectCorpCreditError` raises the `face-scan-account` ops alert (also when it comes from creating the Fitzpatrick task, which still never fails the scan), fails the scan as
    `unavailable` and ends the message as a `PermanentJobError` (the service fails the scan itself because the dispatcher acks a permanent error and never
    dead-letters it); `PerfectCorpBadRequestError` does the same without the alert. A webhook that says the task ended in an error still queues `fetch`:
    the provider's mapping on `getSkinAnalysis` decides whether that is a retake or an outage.
- **The webhook.** `POST /webhooks/perfect-corp` (under the API prefix) is public (`security: []`): the Standard Webhooks signature on the RAW body is the
  credential (`RestPerfectCorpClient.checkWebhook`, which also refuses a delivery older than 5 minutes). Middleware, in order: `PERFECT_CORP_WEBHOOK_LIMITER`
  (300 a minute per address; namespace ids 1028/2028/3028) then `bodyLimit` (64 KB, so an oversized body is 413 before any signature work). The route reads
  `c.req.text()` and calls `receiveWebhook`: a bad signature is 401 `WEBHOOK_SIGNATURE_INVALID`; otherwise `findByTaskId` (both task-id columns are
  indexed) finds the scan, and a task of another environment (`pc_environment` is not this one) or of a deleted scan is ignored; a match queues `fetch` (its
  analysis task) or `fitzpatrick` with the `webhook-id`. Every non-401 case answers 200 `{ received: true }` in the usual envelope; a step that cannot be
  queued is 503, so Perfect Corp sends the webhook again. Register the URL for each environment in Perfect Corp's console (see the README).
- **Retake.** `POST /scans/faces/{id}/retake` takes multipart `front` only, with create's middleware and its single-photo body limit. The checks run in
  this order and nothing changes until all pass: the scan is the caller's (404 `FACE_SCAN_NOT_FOUND`), consent is current (409 `FACE_CONSENT_REQUIRED`), the
  scan is `needs-retake` (409 `FACE_SCAN_NOT_AWAITING_RETAKE`), then the photo (the same JPEG checks). The front object is overwritten under the same
  key, the scan moves `needs-retake` to `analysing` with `reason`, `pc_analysis_task_id` and `reaper_checked_at` cleared (the retaken photo gets a task and a
  reaper check of its own; the analysis task id is cleared on the row only, its Perfect Corp task was deleted when the photo was refused), and `upload` is queued.
  If the move loses and the scan no longer exists (deleted meanwhile), the front object just written is deleted and the answer is 404; if it exists but is
  no longer waiting for a retake it is 409. If `upload` cannot be queued the scan fails as `unavailable`, still 202. There is no limit and no due-check.
- **The reaper's one check.** `createScanReaper` also calls `FaceScanService.reap(now)`, in its own try (a failure is logged, never fails the product
  sweep nor is hidden by it). It runs two queries of at most 100 scans each, longest-waiting first. First `staleAnalysing(now - 2h)`: those are failed as
  `unavailable`. Then `staleAnalysing(now - 15min, { unchecked: true })`, which leaves out scans with `reaper_checked_at` set so that ones already checked
  and not yet 2 hours old cannot fill the batch and starve newer scans: for each, `markReaperChecked` sets `reaper_checked_at` (a conditional write of that
  column alone: it holds only while the scan is `analysing` and unchecked, and never touches `updated_at`, so the 2 hours do not restart and a scan that
  moved on since it was read keeps its own time) and, only if it did, `fetch` is queued, or `upload` if the scan has no task (its first message was lost).
  The check happens once.
- **The live stream.** The `ScanStream` Durable Object, one per face scan id, carries a `{ type: 'face', faceScan: { id, state, reason } }` event as SSE
  event `face`; product frames are unchanged. `GET /scans/faces/{id}/events` (`signedIn`, a guest too; the caller's own scan, else 404 `FACE_SCAN_NOT_FOUND`) opens a
  stream whose `snapshot` is that frame, reads the scan again once it is open (a change stored in between is sent), and sends `done` straight away for a
  scan that is `ready`, `failed` or `needs-retake`. Each state change publishes its frame, and `done` after a final one. Publishing is best effort: the
  change is already stored, so a failure is logged `{ outcome: 'publish-failed' }` and the step goes on.
- **Pushes.** A face scan notifies the person's phone at most once when it is ready and once for each rejected front photo, through the same `NotificationsService` and `send-push` job as the product scans
  (see "Sending push notifications"). `copyResults` calls `faceScanReady` once `completeFaceScan` returned true (a completion that lost, or a second fetch of a
  ready scan, says nothing), before the steps after the write that can still throw, so a retry cannot lose it. `needRetake` calls `faceScanNeedsRetake` once the
  conditional `analysing` to `needs-retake` update applied, in the upload or the fetch step, with the `updatedAt` it wrote as `at`: a step delivered again finds
  the scan no longer `analysing` and queues nothing, and a retaken photo that is refused again is a new notification under a new key. Nothing is sent for
  `failed` (credit, bad request, consent withdrawn, the reaper, the dead letter), the Fitzpatrick step, a retake or a create. The switches are the account's
  `scanFinished` (ready) and `scanNeedsYou` (needs a retake). The enqueue never throws, so a push that cannot be queued never fails or retries the step.
  The server always sends: the app suppresses the foreground notification when it is watching the scan's live stream.
- **Spend** goes through `VendorSpendLedger` (see "Vendor spend ledger"), as soon as Perfect Corp reports a task successful (before our copy of the result is
  stored: they bill on success), and a failure to record it is logged and does not fail the step.
- **Guest cleanup.** `FaceDataCleaner` is in `guestDataCleaners` beside the scans'. It deletes the users' face photos and masks from the bucket
  first, then their face rows (which also cascade from the profile), so a bucket failure leaves the rows and the keys for the next run. Both
  halves are safe to repeat and chunk the ids under D1's bound-parameter limit. It deletes only what the face tables list, so product photos are untouched.

### Vendor spend ledger
`AiUsageService` is also the `VendorSpendLedger` (`providers/perfect-corp/vendor-spend.provider.ts`), so a face job depends on the port and not the service.
`record({ vendor: 'perfect-corp', job: 'face-analysis' | 'fitzpatrick', units, key })` writes one row to the same `ai_usage` table, already
`settled`, and raises the same `ai-spend-cap` alert when the day's sum passes the figure. It never refuses a call for the figure.

- **Idempotent per vendor task.** `key` is the Perfect Corp task id and the row id is `<vendor>:<key>`, so a redelivered job or a webhook that
  came twice is one charge. `insertSettled` inserts with `onConflictDoNothing` on the id, `returning` the id, in the same `db.batch` as the
  sum; a repeat stores nothing, answers `{ overCap: false }` and so raises no alert (the first record already did, if it passed the figure).
- **Units are validated.** `units` must be a positive whole number or `record` throws before anything is stored (so a bad record does not
  use up its task id).

- **Recorded once, on success.** Perfect Corp charges only when a task succeeds, and nothing sweeps a reservation held open across a
  webhook wait, so nothing is reserved. The spend is recorded when the task is seen to have succeeded, before anything of ours that could fail. A rejected photo records nothing. The units are 12 for the HD analysis and 10 for a first Fitzpatrick read.
- **Cost** is `Math.round(units x PERFECT_CORP_USD_PER_UNIT x 1,000,000)` micro-USD, rounded once at the end (12 x 0.07 is not exact in floating point).
  The container passes `PERFECT_CORP_USD_PER_UNIT` raw and `record` validates it when it is used, throwing an error that names the
  variable unless it is a positive number (or the text of one). It is not checked when the container is built, because the same ledger serves every
  Claude call, and a bad price must fail only the Perfect Corp record, never reserve, settle or release.
- **Migration 0028** adds `vendor` (text, not null, default `anthropic`) and `units` (integer, null) to `ai_usage`. A vendor row stores
  the vendor name as `model` and its estimate as its cost, since both columns are not null. `AI_JOBS` stays Claude's list: the Perfect Corp
  jobs are not in it, so no model, price or prompt is wired for them.
- **Two summaries.** `summary()` is Claude only (it excludes any other vendor); `vendorSummary()` adds up the others per vendor and job
  with calls, units and cost. The daily sum (`committedMicrosSince`) counts both. `npm run ai:spend` reads every settled row, so its
  totals include Perfect Corp, and the vendor's rows show with the vendor name as the model.

### Perfect Corp config
Per environment (dev, staging, production) even though one Perfect Corp account is shared today; the code never assumes that.

- Vars in all three `wrangler.jsonc` blocks: `PERFECT_CORP_BASE_URL` (`https://yce-api-01.makeupar.com`) and `PERFECT_CORP_USD_PER_UNIT`.
  **The price is `0.055`**, Perfect Corp's pay-as-you-go price per unit (checked 2026-10-23); on a monthly subscription set it to that plan's price (0.046–0.048).
- Secrets `PERFECT_CORP_API_KEY` and `PERFECT_CORP_WEBHOOK_SECRET`, **required** in the secrets plan and in `secrets.required` in all three blocks, so a
  deploy fails until both are set on that environment's Worker. Both are in the two `.dev.vars` example files.
- The webhook URL for each environment (`https://<that Worker's host>/api/v1/webhooks/perfect-corp`) is registered in Perfect Corp's console (a deploy
  step, not code); the console shows the secret. Until it is registered nothing wakes the `fetch` step, and the reaper's check 15 minutes on is what finds the result.

### Ops alerts
`modules/ops-alerts` (`OpsAlertsService`) emails the owner when an environment-wide problem needs them. Nothing here is shown to a
user, and no limit behind it refuses anyone (owner's decision, 2026-10-18, issue #91): the limits only make noise.

| Kind              | Raised when                                                                                  | At most one email per |
| ----------------- | -------------------------------------------------------------------------------------------- | --------------------- |
| `ai-account`      | Claude refuses our account: any `AnthropicConfigError` (401, 402 `billing_error`, 403)       | hour                  |
| `face-scan-account` | Perfect Corp refuses our account: a `PerfectCorpCreditError` in a face scan step          | hour                  |
| `ai-spend-cap`    | A call takes the UTC day's AI spend past `AI_DAILY_BUDGET_USD`                               | UTC day               |
| `research-budget` | A research attempt is made when the day's count has reached `dailyResearchBudget` (200)      | UTC day               |
| `analysis-budget` | An analysis attempt is made when the day's count has reached `dailyAnalysisBudget` (300)     | UTC day               |
| `verdict-report`  | A person's mistake report on a shelf verdict is stored as a new row (see "Shelf verdict")    | UTC day               |
| `wrong-match-report` | A shelf swap records a wrong-match report in `verdict_reports` (raised by the shelf swap, see "Shelf") | UTC day         |
| `share-render-quota` | Cloudflare Images' free monthly allowance (5,000 unique transformations) is used up: new share cards are refused until it resets, and the email says to turn on Images Paid (raised by the share-card render, not yet built) | hour |

- **`raise(kind)` never throws.** It is called from the paths that hit the problem (the ledger's `reserve`, the catalog's
  `research` and `analyse`, the scan service), and an alert that cannot be raised must never cost them their work. A failure
  is logged `{ outcome: 'ops-alert-failed', kind, error }` with the error's name only.
- **One claim per kind and window, then a job.** `OpsAlertsRepository.claim(kind, windowStart)` is ONE guarded upsert on
  `ops_alert_claims` (one row per kind, replaced only by a newer window), so however many callers hit the problem in a window
  exactly one wins, and only the winner queues the `send-ops-alert` job. The window is the start of the UTC hour (`ai-account`, `face-scan-account`, `share-render-quota`)
  or UTC day (the rest). The repository does not know how long a window is. *Trade-off:* the window is claimed before the job is
  queued, so a queue outage loses that window's email (the next window sends); queueing first would send one email per caller.
- **`send-ops-alert` is the first job on the shared `email` queue** (see "Background jobs"), keyed `kind:windowStart`, so a
  redelivery is one email. `OpsAlertsService.send` renders the `ops-alert` template and sends it with the shared `EmailSender` to
  `OPS_ALERT_EMAIL`. The text is fixed per kind and carries the environment and the kind and no data. A provider failure is thrown,
  for the queue to retry (5 attempts); an empty or invalid address is logged `{ outcome: 'ops-alert-no-recipient', kind }` and
  acked, because retrying a missing setting cannot help.
- **Config.** `OPS_ALERT_EMAIL` is a `var` (not a secret; listed in `NOT_SECRETS`), empty in `wrangler.jsonc` until the owner
  fills it in. The queue pair `deepertones-email-<env>` and `deepertones-email-dlq-<env>` (binding `EMAIL_QUEUE`) must exist before a deploy.

### Catalog images
`providers/catalog-images` fetches a product's stock image and keeps it. The port is
`CatalogImageStore` (`pageImageUrl`, `fetchImage`, `put`, `delete`, `publicUrl`); `R2CatalogImageStore` and
`MemoryCatalogImageStore` implement it. A failed download is `null`, never an error.

- **Safe-URL rules.** `isSafePublicHttpsUrl` accepts only https URLs of at most 2048 characters with no
  userinfo, no explicit port (read from the raw text, because the URL parser silently drops `:443`),
  no IP literal in any spelling the parser normalises, no `localhost` or `*.localhost`, and no
  single-label host. The adapter checks the start URL and every redirect target, resolves a relative
  `location` against the URL that sent it, and follows at most 2 redirects (3 requests), each with its
  own 10 s timeout.
- **Image from the source page.** `pageImageUrl(pageUrl)` finds the product's image on a page the researcher
  named (a product page or the ingredient page). The researcher cannot supply an image URL itself: web_search never exposes image URLs, so the model always
  answered null. Source pages carry the packshot in their JSON-LD `Product` image or in `og:image`; brand sites' `og:image` is often a logo or a placeholder, so the JSON-LD image is tried first. The adapter fetches the page through the same safe path as
  `fetchImage` (safe-URL check and blocked hosts on every hop, at most 2 redirects, 10 s timeout), accepts only a 2xx
  `text/html` answer, reads at most 512 KB of it (`requestHeadBytes$` stops pulling at the cap), and scans the `<meta>`
  tags with a linear forward-only scanner, not a regex, because the page is hostile (stops at `</head>`, after 200 tags,
  skips a tag over 4 KB; `property` or `name`, any attribute order and quote style, case-insensitive, HTML entities decoded) for
  `og:image`. The JSON-LD is found the same way: `<script type="application/ld+json">` blocks in those 512 KB (type matched
  case-insensitively, at most 20 JSON-LD blocks however many other scripts the page has, a block over 100 KB skipped, invalid JSON skipped), walked with a depth cap of 8 and a
  2,000-node budget through arrays, `@graph`, `mainEntity` and `hasVariant` to the first `Product` or `ProductGroup` with an `image`
  (string, array, or ImageObject `url` / `contentUrl`; entities not decoded). Candidates in order: that image, then
  `og:image`, then `og:image:secure_url` / `og:image:url`, then `twitter:image`. Each value in that order is resolved against the
  page URL (the final one, after redirects) and the first that is a safe public https URL is returned, so an `http` `og:image`
  does not hide a good `og:image:secure_url` (every Shopify store emits that pair). Any failure is `null`; nothing from the page or its URL is logged.
- **Blocked hosts.** `blockedHostSuffixes` (default none) refuses any hop whose hostname equals a
  suffix or ends with `.`+suffix. The container passes our own zones, so a redirect cannot point the
  Worker back at us; the suffixes are not hard-coded in the adapter.
- **The header decides the type and the size.** JPEG, PNG or WebP by signature only; the
  `Content-Type` header is ignored, so SVG, HTML and GIF are refused. Width and height are read from the
  file header (PNG IHDR; the first JPEG SOF marker; WebP `VP8 `, `VP8L` or `VP8X`) without decoding any
  pixels, and an image with a side of 0 or over 4096 is refused, as is a header cut short. The download
  is capped at 5 MB by default.
- **The shared public bucket, written by the Worker.** Images go to `deepertones-assets` (the same bucket CI
  syncs `assets/` into, served at `assets.deepertones.com`) through the `CATALOG_IMAGES` R2 binding. The Worker
  writes only under `catalog/<environment>/` (the service's `imageKeyPrefix`, which the container sets to
  `catalog/${ENVIRONMENT}`), so staging and production stay apart in the one bucket, and the CI sync, which
  owns `email/` and the rest and refuses any `catalog/` file, can never overwrite them. The local binding in
  `wrangler.jsonc` is a simulation: `wrangler dev` and the tests use a local bucket. Keys are validated (lowercase path
  segments of `a-z 0-9 . _ -`, no `..`; anything else throws, because a bad key is our bug; so
  `catalog/staging/products/<uuid>.jpg` passes, since UUIDs are lowercase hex and hyphens) and
  encoded per segment in the public URL. Objects are served with `public, max-age=86400`, deliberately
  not `immutable`: deleting or replacing an image takes effect after at most a day of edge cache. A
  takedown can be made immediate with a manual cache purge of that URL.
- **Serve with `nosniff`.** `assets.deepertones.com` should send `X-Content-Type-Options: nosniff`, so a
  browser never reinterprets a stored object. That is a Cloudflare response header rule on the zone, an
  infra step outside this code (optional, see README, "Product catalog setup").
- **The vision match is the second gate.** Checks on the URL and bytes prove a file is an image, not
  that it shows the right product: a hostile page can serve a valid image of the wrong thing. The
  catalog service must pass the image through `ProductAnalyst.imageShowsProduct` before `put`.

### Private photos
`providers/photo-store` keeps the photos users take of products, and their face photos and overlay masks. The port is `PhotoStore` (`put`, `get`, `delete`,
`deleteMany`); `R2PhotoStore` and `MemoryPhotoStore` implement it. Unlike catalog images, these are private.

- **One private bucket for every environment.** `deepertones-private`, bound as `PRIVATE_PHOTOS` in all three
  `wrangler.jsonc` blocks, next to the public `CATALOG_IMAGES`, never in its place. It has no public domain and r2.dev
  is off, so the only way out is a signed photo link. Environments are told apart by key prefix, as in the public
  bucket. The local binding is a simulation: `wrangler dev` and the tests use a local bucket. **It also holds the catalog workbook archive**, `workbooks/<environment>/<version>-<uuid>.xlsx` (see "Catalog workbook import"): those files are kept for good,
  so no bucket-wide lifecycle rule (expiry or deletion) may be set on the bucket, and the photo sweeps never reach them (they delete by `photos/` and `faces/` key only).
- **Key layout.** Product photos are `photos/<environment>/<user id>/<scan id>/<item id>.<jpg|webp>`. Face photos are
  `faces/<environment>/<user id>/<profile id>/<scan id>/<name>`: `<name>` is `front.jpg`, `right.jpg` or `left.jpg`, or `mask-<concern>.png` for an
  overlay mask, and exactly three id segments sit between the environment and the name. The profile is in the key so a photo link can be checked
  against it. Face photos live under their own prefix, so the product sweeps (which release a photo once it has been used) can never reach them.
  In both, `<environment>` is
  `development`, `staging`, `production` or `test`, and each id is lowercase `a-z 0-9 -` (UUIDs pass). Every method
  validates the key and throws a plain `Error` on a bad one, before touching the bucket: a bad key is our bug.
  `deleteMany` validates every key before deleting any, then deletes in batches of 1000 (the R2 limit). An item id may
  end in `-back` for the back of the pack (`<item id>-back.jpg`); it is an ordinary id.
- **Environment lock.** Both stores are built with `{ environment }` (`R2PhotoStore` also takes the `bucket`) and accept
  only keys that start `photos/<that environment>/` or `faces/<that environment>/`; a key of another environment is the same plain `Error`, and the
  bucket is not touched. One bucket serves every environment, so this keeps a misconfigured Worker from reading or
  deleting another environment's photos.
- **Media rules.** `put` throws unless the media type matches the key's extension: `jpg` with `image/jpeg`, `webp` with
  `image/webp`, and `png` with `image/png`. The key rule is what keeps PNG narrow: only a face mask key can end in `.png`, a face photo
  is a JPEG only, and a product photo is a JPEG or WebP only.
- **One set of checks.** `assertPhotoKey` and `assertPhotoMedia` live in `photo-store.provider.ts`, the one
  non-concrete file both stores may import, and `MemoryPhotoStore` calls them too, so the fake accepts and refuses exactly
  what the real store does. `photo-store.contract.ts` runs the same tests against both.
- **`put` and `get`.** `put` stores the bytes with the media type and `Cache-Control: private, no-store`. `get` returns
  the stored bytes and media type, or null for a missing key or any stored type other than `image/jpeg` or
  `image/webp` (or `image/png` under a `faces/` key, where the masks are); the stored type decides, not the extension. `delete` of a missing key is not an error. Storage
  failures are thrown so the caller can retry.
- **Signed photo links.** `lib/photo-link.ts` signs `{ key, userId, expiresAt }` (and, for a face photo, `profileId`) as an opaque token: base64url of
  `payload.signature`, where the payload is JSON and the signature is HMAC-SHA-256 under a key derived with
  HKDF-SHA-256 from the secret (empty salt, info `deepertones/photo-link/v1`, 256 bits). The container passes
  `JWT_SECRET` to the scan service; there is no new secret, and the distinct info keeps this key unrelated to the one that signs JWTs. A
  link lives `PHOTO_LINK_TTL_SECONDS` (5 minutes), and that is enforced at both ends. `signPhotoLink(link, secret, now)`
  throws on an empty secret, on an expiry more than the TTL after `now`, and when the key's user segment
  (`photos/<environment>/<user id>/...`) is not `userId`, so a link is only ever minted for its own user's photo.
  **The profile claim.** A face link also carries `profileId`, which must equal the key's profile segment
  (`faces/<environment>/<user id>/<profile id>/...`): the signer throws on a face key with no profile or another one, and on a
  product key with a profile, and the verifier gives null for a face token whose profile is missing, empty or not the key's. So the
  account's other profiles cannot open a link made for one profile, and `verifyPhotoLink` gives `{ key, userId, profileId }` for a face
  photo and `{ key, userId }` (no `profileId`) for a product photo.
  **Each route serves its own prefix.** The two kinds of link verify with the same secret, so each photo route checks the key's
  root: `ScanService.photoForLink` refuses (404 `PHOTO_NOT_FOUND`) any key that does not start `photos/`, and
  `FaceScanService.photoForLink` any that does not start `faces/`, so a face token can never open through the product route nor the other way round.
  `verifyPhotoLink(token, secret, now)` takes the clock as an argument and returns the key and user, or null for
  anything malformed, over 2048 characters, wrongly signed, expired, or ending more than the TTL after `now` (a link
  minted wrong still cannot live longer than 5 minutes); reasons are not told apart. The signature is compared in
  constant time. The base64url helpers are `toBase64Url` / `fromBase64Url` in `lib/base64.ts` (strict: anything outside
  the alphabet throws).
- **Serving a photo.** A route that serves photos takes the key only from a verified token (`verifyPhotoLink`), never from
  the path, query or body, and answers with `Cache-Control: private, no-store` so a shared cache or a browser never
  keeps a photo beyond its link.

### Product catalog data
`modules/catalog` holds the shared, per-product data behind the product scan (#20): products, aliases, formulations,
concerns and traits, research attempts, and the pure rules that feed them. The service on top of it is
described in "Product catalog service"; its one route, `GET /api/v1/products/search`, is under "Product search".

- **Identity keys** (`catalog.identity.ts`) are `brand|name|variant|form`, the first three normalised and the form (one of `PRODUCT_FORMS`: spray, roll-on, stick, cream and so on) empty when unknown, so a key always ends in a bar. Form is part of identity because a NIVEA MEN Dry Impact spray and its roll-on are different products with different ingredient lists, and researching without the form found the wrong one. Each part is normalised: lower case, accents and
  apostrophes dropped, `&` read as "and", other marks turned into spaces. Pack sizes are removed (`ml`, `mg`, `kg`,
  `oz`, `fl oz` at any number; a bare `g` or `l` only from 10 up, so "Shade 4 L" is kept). A `+` touching a letter or
  digit is read as "plus" ("SPF 50+" and "Hydro Boost+"; a standalone " + " is just a space). A space is put between a
  letter and the digit after it ("NC15" is "nc 15"), never between a digit and a letter, so "250ml" still reaches the
  size rule. A dot survives only between two digits ("2.5"). **A number written with `%` is never a size**: before
  the rest of the text is normalised, a number followed by `%`, with or without a space before the sign ("100%" or
  "100 %"), is glued to a letter suffix ("100pct"), so it can never read as a bare `l` or `g` once the `%` itself
  turns into a space; the suffix comes off again once sizes have been stripped, leaving the plain number ("100% L-Ascorbic
  Acid Powder" keys as "100 l ascorbic acid powder", not "ascorbic acid powder" with its "100" eaten as 100 litres).
  **A row stored under a key the rules no longer produce** (written before this fix, or before any future key-rule
  change) is not lost: `nearMissCandidates` compares a product's own stored `identityKey`, not one recomputed from its
  fields, so the old row still reaches the judge as a near miss of the reading's new key, and a "same" answer records
  an alias from the new key to the old row. No migration rewrites old rows. **Brand spellings are not merged yet**: two spellings of
  one brand make two brand keys, so a product under the other spelling is not found as a near miss.
- **Near-miss candidates** are products of the same brand family with a different identity key whose words overlap
  (Jaccard similarity, default threshold 0.6) or **where one reading's words are all inside the other's** ("NIVEA soft" in
  "NIVEA Soft Light Moisturiser", "Cocoa Butter Formula" in "Cocoa Butter Formula Daily Body Lotion"), because the recognizer
  adds and drops descriptors from scan to scan and Jaccard punishes that. Containment needs a word beyond the brand on both
  sides, so a reading that is only the brand (contained in every product of it) is never a candidate. **Generic-word guard:** the
  shorter side must also have a word that is neither its brand's nor in a small stoplist of form, category and generic words
  (lotion, cream, gel, oil, wash, cleanser, soap, body, face, hand, hair, skin, men, women, sun, original, classic, care, daily ...;
  `GENERIC_WORDS` in `catalog.identity.ts`). "NIVEA soft" in "NIVEA Soft Light Moisturiser" is a containment; "Dove Body Wash" in
  "Dove Go Fresh Body Wash" is not (it may still be a Jaccard candidate). The word relations (equal, subset, superset) behind
  containment and `lessSpecific` come from one private helper. **UK and US spellings are folded** word for word from a
  fixed, reviewed list: the -ise/-ised/-iser/-ising/-isation forms of moisturise, sanitise and normalise, plus colour,
  centre and grey. No generic suffix rule, so "rise", "wise", "promise" and "anise" never fold, and the fold is
  whole-word, so "greyhound" and "centred" do not either. The fold lives in the one shared word set (`words`, pooling
  brand, name and variant), so it reaches `nameSimilarity`, containment, `lessSpecific` and the edition check
  (`namesAnotherEdition`) alike — and through `lessSpecific` and `lessSpecificForNearMiss`, the alias-equality check
  and the ambiguity guard too.
  That is intended: a UK reading is treated exactly as its US spelling would be, so a UK reading less specific than
  two US rows of different ranges is held back just as the US reading is, and a UK reading landing on a US row by an
  equally-specific match is aliased just as the US spelling would be. `identityKey` never folds, so a UK and a US
  reading keep different keys until the judge is asked. **A suitability phrase named on only one side is ignored here**
  ("for" then up to 3 words then "hair" or "skin", optionally followed by "type"/"types" — "for Natural Hair", "for All
  Hair Types", "for Normal to Oily Skin"; four words between "for" and the hair/skin word is too many to be the phrase,
  so nothing is set aside). **An edition marker is not a suitability line:** a phrase whose words between "for" and
  "hair"/"skin" include any of men, mens, man, mans, women, womens, woman, womans, kids, kid, baby, babys, babies, child,
  childs, children, childrens, teen, teens, boys, boy, girls, girl, ladies, lady, gents, gent, toddler, toddlers, infant,
  infants ("for Men's Skin", "for Kids Hair", "for Boys Hair") is never treated as the phrase and never
  set aside — it names an edition of the range, a real difference, not the pack's wording of the same suitability
  (apostrophes are already dropped by `normaliseText`, so "men's" reads as "mens"). The phrase is dropped from the
  similarity ratio and the containment check only when exactly one of the two listings gives one; the same phrase on
  both sides, two that differ on both sides, and no phrase on either side score on the full words, as before. **Two or
  more distinct phrases switch the ignoring off for the whole call, but the count is scoped to the near misses
  themselves, not the whole family window:** `ignoresOneSidedSuitability(target, products)` first finds the near
  misses with the ignoring on (the same brand-family, different-key, threshold-or-containment pass `nearMissCandidates`
  runs, before sorting and the limit), then counts distinct suitability phrases across the reading and only those near
  misses (a reading with a phrase and a near-miss sibling with a different one; or a reading with none among near-miss
  rows with two different ones). With 2 or more, nothing is set aside for any pair in that call, because the near
  misses themselves then show the words tell products apart rather than restate a shared suitability; otherwise the
  first pass (ignoring on) stands. One distinct phrase, on whichever side, still gets ignored. A row of the family
  that is no near miss settles nothing: its own suitability line is never read for this count, even when the row sits
  in the same brand family as the reading and the near misses. This is local to `nearMissCandidates` and
  `lessSpecificForNearMiss` (both call `ignoresOneSidedSuitability` so they decide the same way for one reading): it
  never reaches `identityKey`, `namesAnotherEdition`, the exported `lessSpecific`, the ambiguity guard's equal-words
  check, or the alias-equality check, all of which still see the phrase's words — but it does reach the ambiguity
  guard's specificity check below (`lessSpecificForNearMiss`) and the form-outranking rule's count, which uses the
  same less-specific set, so a line that bought (or cost) a candidate its place here is seen the same way there.
  Ranking (best first by similarity, then id, at most 3 after ranking) sorts on this phrase-ignored similarity too, not
  the full words'. Switching the ignoring off can itself add a candidate, not only drop one: once the phrase's words
  ("for", "hair"/"skin", and the word(s) between) are no longer set aside, a row with no suitability line of its own
  that happens to hold some of those same words gets credit for sharing them, which can be enough to cross the
  threshold where the words would otherwise have been removed from the comparison — the judge still decides whether
  it is the same product. The family is the first word of the normalised brand
  (`brandFirstWord`), and the words are pooled across brand, name and variant, because the recognizer splits one label
  differently from scan to scan: `NIVEA MEN` / `DRY IMPACT` and `NIVEA` / `MEN DRY IMPACT` are one product. They are
  looked up newest first with `productsByBrandFamily`, a range on the `brand_key` index (`brand_key = w or
  (brand_key >= w || ' ' and brand_key < w || '!')`; a brand key holds only letters, digits, dots and single spaces,
  and a space sorts just below `!`; `LIKE` is case-insensitive in SQLite and cannot use the index). The model, not the
  code, decides whether one is the same product; its answer is stored as an alias.
  The range cannot give index order, so the lookup reads and sorts the whole family before `LIMIT`; that is bounded by the
  family size and acceptable at the current scale.
- **Unnamed products.** `products.kind` (migration 0017, `NOT NULL DEFAULT 'named'`) is `named` or `unnamed`. An unnamed product holds an
  ingredient list no label gave a brand and name for: its identity key is `unnamed:<ingredientsKey>` (so the same list from anyone's
  scan is one product and one formulation, analysed once), its `brand_key`, brand and name are `''`, its variant and form are null and its category is
  the label's, else `other`. A named product is never keyed that way. When a label later names that list for a product that does not
  already have it, `adoptUnnamedFormulation(formulationId, productId)` moves the formulation to the named product and deletes the unnamed
  product: the formulation keeps its id, so its analysis, concerns and attempts are not redone. It is one `db.batch` (the UPDATE, then a DELETE that
  only ever removes an `unnamed` product), so the `(product_id, ingredients_key)` unique index rolls both back; it throws, changing nothing,
  for an unknown formulation or product, a formulation of a named product, a product that already has the list, or a move another call
  made first (the UPDATE changed no row). **Invariant:** `scan_items.product_id` may name an unnamed product that adoption has deleted; read
  the product through `formulation_id`. **Known limit:** a bare-list scan after the adoption makes a new unnamed product and analyses the list again (once).
- **Search text.** `products.search_text` (migration 0015, `NOT NULL DEFAULT ''`) is what search looks in: the service writes
  `normaliseText(brand name variant)` when it creates a named product (accents folded, `&` as "and", `+` as "plus", marks as spaces,
  single spaces) and `''` for an unnamed one. **Pack sizes are kept** (`stripSizes` is not applied), because a person may type "50 ml".
  The repository stores what it is given and never derives it (`NewProduct.searchText` is optional, default `''`). The migration only adds
  the column; **no SQL backfills it**, because SQL cannot fold accents. Products that exist without search text (made before the column,
  or by an old Worker that kept running during a deploy) are filled **by the scheduled reaper, in code**: every run of the scan-reaper
  cron (`jobs/scheduled.ts`, every 10 minutes), after `scans.reap` (the job's purpose, which uses the Worker's subrequests first), then calls `ProductCatalogService.fillSearchText()`, which takes up to 500 named products
  whose `search_text` is `''` (`namedWithoutSearchText`, by id), sets each to the text `resolve` would store (one private helper builds both) with
  `setSearchTexts`, and returns how many it filled. The writes are ONE `db.batch` (one D1 subrequest for up to 500 rows; a Worker invocation may make only 50 on the free plan and 1000 on paid), skipped when there is nothing to fill; an unknown id is ignored. It never overwrites existing text, never touches an unnamed product and makes no model or web
  call. It is its own call beside `scans.reap`, in its own `try`: a failure is logged `{ outcome: 'search-text-fill-failed', error }` and
  does not fail the sweep, and a failing sweep is caught, the fill still runs, and the sweep's error is then rethrown so the run is recorded as failed. More than 500 take more runs.
- **Aliases** map another key to a product. An alias never shadows an identity key, and the first product to take
  one keeps it (`addAlias` is one `insert or ignore` statement; an unknown product throws). `createProduct` is an
  insert-or-ignore on the identity key that returns the stored row, so two scans of one new product both carry on
  with the same product.
- **Formulations** are one ingredient list each, in label order, with where it came from (a web page or the label
  photo) and when it was found. A list that differs materially is a new formulation, never an overwrite.
  `latestFormulation` takes the latest found time and the later insert on a tie. `touchFormulation` only moves the
  found time forward.
- **`saveAnalysis` is atomic.** It checks the formulation exists (throws, stores nothing, if not), then runs ONE
  `db.batch`: delete the old traits, delete the old concerns, insert each concern (one statement per concern, under
  D1's 100-parameter limit), insert the traits (de-duplicated per concern), and set the versions on the formulation.
  A reader sees the old analysis or the new one, never half of either.
- **The ingredient rules are data in D1**, not code. `ingredient_rules` holds one row per rule: a stable `code`, the normalised `name` and
  `aliases` (JSON), a `kind`, the `statement` the analyst is shown, an https `source_url` (or `null`), the skin concerns it `helps`, a `status` of
  `draft`, `approved` or `retired`, who approved and audited it, and `updated_in_version`. **Only an approved rule is matched**: a draft applies to
  nothing, and a retired row stays so its code is never reused. `catalog_versions` has one row per applied upload: an integer `version` that goes up by 1,
  the `rules_version`, the `contract_version` it was written to, who uploaded it and the archive key (`null` for the seed). The **live rules version**
  is the `rules_version` of the latest row. It is a string that changes only when the set of approved rules does, and it is what
  `formulations.reference_version` and `analysis_attempts.reference_version` record; the column names are older than the table, and were not renamed.
- **The seed** is the migration that created both tables (`0031_*`, from `npm run db:generate`, with the seed appended). It inserts one approved rule
  for each entry of `REFERENCE` (`catalog.reference.ts`), signed `reference seed`, and catalog version 1 under the rules version `seed-2026-10`, which is
  what `REFERENCE_VERSION` was when the rules lived in code, so no formulation analysed before the migration is analysed again. The SQL is written by
  `scripts/catalog/seed-rules-sql.ts` and a test fails if the migration ends with anything else. A rule's code is `seedRuleCode(entry)`
  (`catalog.workbook.seed.ts`): `ING-<NAME>-<KIND>`, in capitals, cut to 40. **`REFERENCE` is frozen**: it is the seed and the eval's fixture, never edited
  to change a rule. The workbook is where a rule changes.
- **`liveRules()`** (`CatalogWorkbookRepository`, in the catalog module) returns `{ version, entries }`: the latest rules version, and the approved rules
  in the shape the matcher reads, in code order. It reads the latest version on every call, and keeps the entries per isolate, **keyed by the catalog
  version number** (every applied upload moves it, including one that changes only a rule's `group`, `clashes_with` or `reviewer_role`, which the rules version does not
  see, so a key on the rules version would serve that metadata stale; a Products-only upload costs one re-read). When the catalog version has moved, it reads the version and the rule rows in ONE
  `db.batch`, so an upload cannot land between them and leave new rules stored under the old version. `ProductCatalogService` reads it only where it needs
  it: `analyse` once (the facts the analyst is given and the version the analysis is stored under are the same rules), and `research` only when a stale
  formulation could be the fallback. `flagFacts(ingredients, rules)` takes the rules as an argument, so the eval calls it with `REFERENCE`, and the facts of
  one name that has several kinds come out in a fixed order (banned first, then the commonly cited concerns), never in the order the rows were read.
- **The workbook schema** (`catalog.workbook.schema.ts`) is what a catalog workbook may hold, as data: eleven tabs (Products, Availability, Ingredients,
  Countries, Claim words, Tapers, Guides, Reintroductions, Escalations, Responses, Weeks; contract 2.4.0), their columns, accepted values and
  length caps, and `validateWorkbook(raw)`, which returns the parsed workbook or EVERY problem as `{ tab, row, column, rule }` (a fixed code, never a cell
  value). A tab is `{ headers, rows }`: the header row decides which columns exist, a key a row has that is no header is ignored, and a key it lacks is an
  empty cell. A cell is measured before it is read, so a cell over its cap says only that, and a 32767-character cell costs about its length. The module is
  pure and named `.schema.ts` because dependency-cruiser treats `*.contract.ts` as test-only. It has a `CONTRACT_VERSION` and a fingerprint of its
  definitions; a test pins the released fingerprint, so a change to what a workbook may hold cannot go unversioned. **`docs/catalog-workbook-contract.md` is
  generated** from it by `npm run catalog:contract-doc`, for the people who fill the workbook in, and a scripts test fails when it is stale.
- **The reference coverage is still partial.** The seed is **not the full CosIng annexes**, and `REFERENCE_COVERAGE` is `'partial'`: the catalog service
  must carry that to users so a clean result never reads as an all-clear. The `flagFacts` rule checks match each ingredient exactly against names and
  aliases, including the parts of `Aqua (Water)`, `Parfum/Fragrance` and `Hydroquinone 4%`. Banned substances and the named fragrance allergens carry
  an https regulation URL as their `source`; commonly cited concerns (pore-clogging, sun sensitivity, irritation, pregnancy caution, undisclosed
  fragrance) have a `null` source and say so in their rule, so a regulation is never shown as backing something no regulation says. A `null` source is
  left out of the analyst's prompt.
- **Follow-ups:** a proper import of the public CosIng export; the expanded labelled-allergen list from Regulation
  (EU) 2023/1545 (about 80 substances, where the seed has the original 26); restricted substances with their limits
  and conditions of use; alias coverage, which is hand-built.

### Product catalog service
`ProductCatalogService` (`catalog.service.ts`) is the only way into the catalog from outside the module. It is built in
the container from `D1CatalogRepository`, the Claude researcher and analyst, and the R2 image store (plus the
`imageKeyPrefix` `catalog/<environment>`), and imports
provider **types** only. The catalog is shared data, not per-user, so it has no `GuestDataCleaner`. The repository
stays dumb; every decision below lives in the service (or `catalog.analysis.ts`, a pure helper it calls).

- **resolve → research → analyse.** `resolve(identity)` finds the product by identity key or alias, else asks the
  model about same-brand near misses, else creates it. It returns what the product needs next: `ready`,
  `needs-analysis` (a formulation exists but is not analysed by the current versions), `analysis-failed` (see "Analysis
  attempts") or `needs-research` (no formulation, or the latest is stale). `research(productId)` stores the found
  ingredients as a formulation; `analyse(formulationId)` stores the concerns; `addLabelIngredients` stores a list read
  from a back label for a product that has one; `fromLabel({ ingredients, brand?, name?, variant?, category? })` files a list for an item with
  no product (never researches; the list is validated first, `LABEL_UNREADABLE`). With a brand and a name the product is found as `resolve`
  finds it (a near miss goes to the model; a label with no category compares with the brand's products of every category, and a new product is
  filed under `other`), the product's own formulation for the list is used if it has one, else an unnamed product's is adopted, else a new label
  formulation is stored; if the adoption loses to another call, the product's own formulation is used or stored, never the other's. Without
  both it is the unnamed product's formulation. It returns `analysed` (current `ANALYSIS_VERSION` and live rules version) so the scan can
  skip the analyse step. Callers (the scan jobs) run one of these per step.
- **search, namedProduct and choose** serve a user who names a product by hand (see "Product search" and `identifyByName`).
  `search(q)` normalises the query with `normaliseText` and returns at most 10 `{ id, brand, name, variant, category, imageUrl }`, or `[]` for a
  query with nothing left once normalised (never every product); no model or web call. **It lists only a named product that has at least one formulation** (an `EXISTS` on `formulations`, answered by a covering-index probe on `product_id` (checked with EXPLAIN QUERY PLAN: the scan of `products` is unchanged, and `formulations` is searched by `product_id`), one probe
  per candidate), found by research or read from a label, however old and analysed or not. A product nobody has found ingredients for (a made-up name a user typed,
  or one the research did not find, which the safety parse can also create) is in the catalog but not in the search, and does not use up the limit of 10; it appears the
  moment a formulation is stored for it. `namedProduct(id)` is that summary for one id.
  `choose(id)` is `nextStep` for a product the user picked, the same `ResolveResult` `resolve` gives for it: no lookup by name, no model, nothing
  written. An id the catalog does not hold, and an unnamed product, are `NotFoundError('PRODUCT_NOT_FOUND')` for both.
- **Idempotence.** A job may run twice, so each step is safe to repeat. `research` returns the product's latest
  formulation as `found` when it is fresh, without calling the researcher or recording an attempt. `analyse` returns at
  once when the formulation is already analysed by the current `ANALYSIS_VERSION` and live rules version.
- **Concurrency converges through unique keys, not locks.** `createProduct` is insert-or-ignore on the identity key,
  `addAlias` on the alias key, and `createFormulation` on `(product_id, ingredients_key)` (a unique index, migration
  0007); each returns the stored row, so two writers of the same thing carry on with the same row. `storeFormulation`
  just creates and, when it got an older row back, moves that row's found time to now.
- **In-flight sharing.** Work already running is not paid for twice. If a product's last research attempt is `started`
  and began less than 5 minutes ago, `research` throws `RESEARCH_IN_PROGRESS` (an `UnavailableError`) without calling
  the researcher; the same for a formulation's last analysis attempt and `analyse`, which throws `ANALYSIS_IN_PROGRESS`
  (not a rejection, so it never counts towards the three strikes). So concurrent scans of a new product pay once, and
  the queue retries the others later, by when the first has stored its formulation. An attempt exactly 5 minutes old is
  taken as lost to a crash and no longer shields the work. The check reads the last attempt and the started write
  follows it, so two calls in the same instant can still both pass; the window narrows the double spend, it is not a lock.
- **Lazy re-analysis, not background re-analysis.** The issue asks for formulations to be re-analysed in the
  background when `ANALYSIS_VERSION` (or the live rules version) changes. That is a deliberate deviation: a version
  bump only makes `resolve` answer `needs-analysis` the next time that product is scanned, and the same goes for a
  formulation found more than `FRESH_FOR_DAYS` ago, which answers `needs-research` (a formulation of exactly
  `FRESH_FOR_DAYS` is still fresh). It is cheaper (products nobody scans again cost nothing, and a bump does not
  trigger a burst of model calls) and the user gets the fresh answer at the time it matters. Staleness is checked
  first, so a stale formulation that was never analysed is researched again, not analysed.
- **A spend-cap refusal while asking "same product?"** (`AiBudgetExceededError` from `sameProduct` inside `resolve`, which
  only the eval's ledger throws now) becomes `CatalogBusyError`. The answer is unknown: merging would guess, and creating the product
  would risk a duplicate of one that exists, so the caller waits and asks again later. In production this does not happen: the real ledger does not refuse.
  The same goes for every other `AiBudgetExceededError` / `CatalogBusyError` below; they stay only so the eval's `--max-usd` works.
  Claude refusing our account (`AnthropicConfigError`) is not handled by the catalog: it reaches the scan module (see "Scan module").
- **Alias guard.** A near miss is put to the model only if its category is compatible with the scanned label's (the same, or skin
  care and body care, which a soap, lotion or oil is read as on different photos; hair, makeup and other stay apart), its forms are
  compatible, its variant does not conflict, and it has a variant whenever the label names one (a row made when the scent went unread
  is not every scent of the line). The model treats a variant or form missing from one listing as unread, not as a difference, and
  says no when one name is just a range holding several products; extra marketing words (Specialist, Advanced) are not a difference,
  but sunscreen or SPF, night or day, and AM or PM on one listing only (name or variant) are, as are two different areas a product is for (face against body; an area
  named on one side only is not). A form missing on either side is compatible (a label may not print it); two
  different known forms are different products (a spray is not its roll-on). Variants conflict only on numbers: when both
  have numbers and they differ (SPF 30 and SPF 50, 2% and 5%) the products are different and the model is never asked;
  any other difference in variant wording ("For normal to dry skin" against "Normal to Dry Skin", or a label that shows none) is left to the
  model. The identity key still includes the exact form and variant. This keeps a shampoo from being merged into its conditioner on
  the model's word alone, and the model remains the only gate to a merge. `CATALOG_POLICY` sets the rest: the
  brand's newest 50 products, similarity 0.6, at most 3 asks; the first "same" is remembered as an alias, except when the scanned reading is less specific than that product (its pooled words
  are a strict subset of the product's: "Hydro Boost" for "Hydro Boost Water Gel"). That scan still resolves to the product the model
  chose, but no alias is saved, because it would send the next vague reading, possibly of the Gel-Cream, to the Water Gel by exact key
  without the model; the vague reading goes to the model each time.
  **No alias is recorded when either side is strictly less specific** than the other: the reading's words a strict subset of the
  candidate's, or the candidate's a strict subset of the reading's (a vague stored row must not collect specific aliases), or the
  reading prints no form where the candidate has one. The scan still resolves to the product the model chose. Only a reading of
  equal specificity (the same words in another order, spelling or case, or a different variant wording over the same words) is remembered.
  **Ambiguity guard:** when the reading is strictly less specific than two or more of the near-miss candidates ("Body Wash" with
  "Deeply Nourishing Body Wash" and "Go Fresh Body Wash" stored), the model is not asked about any of them and the reading is created
  as its own product: a duplicate is recoverable, a wrong merge is not. With exactly one such candidate the model is asked as usual.
  This specificity test (`lessSpecificForNearMiss`) weighs the same words the suitability-phrase ignoring (near-miss
  candidates, above) used to find the candidate in the first place — a one-sided phrase set aside, or not, by the same
  two-or-more-distinct-phrases switch-off, decided from the same comparable list and the same `nearMissThreshold` —
  not the full words `lessSpecific` gives: a phrase that bought a candidate past the threshold, or kept one out, is
  seen the same way here, so a line no row of the family gives cannot buy the reading a judge call it would not
  otherwise have earned.
  **An equal candidate is never held back by it.** Whenever one or more of the near-miss candidates have exactly the reading's
  words (full words, `sameWords`, pooled as `nameSimilarity` pools them; the suitability-phrase ignoring above does not apply here), they are
  judged even when the guard holds the reading back from the rest: then only the equal ones are asked about, so a "no" still
  makes a new row and the longer look-alikes are never asked (a "Moisturizing Lotion" reading against stored "Moisturising
  Lotion", "Daily Moisturizing Lotion" and "Night Moisturizing Lotion" rows judges only the first). When the guard would not
  have fired, every candidate is judged as usual, equal ones first.
  **A candidate of the reading's own form outranks one with none.** When the reading gives a form and, among the candidates it
  is less specific than, exactly one shares that form (a candidate of a *different* known form was already dropped by the form
  check above), the ones with no form recorded do not count towards the guard and are not judged either: that one candidate,
  and any candidate the reading is not less specific than, is judged as usual ("Cocoa Butter Formula" (oil) against "Cocoa
  Butter Formula Body Oil" (oil) and "Cocoa Butter Formula Solid Jar" (no form) judges only the oil). Two or more less-specific
  candidates sharing the reading's form are still held back, and a reading that gives no form is unaffected by either rule.
  **A partial read is not judged against a vaguer row:** when the reading is less specific than at least one candidate (by the
  same `lessSpecificForNearMiss` test), the candidates less specific than the reading on those same words (`vaguerForNearMiss`, so a row
  that differs only by a suitability line the reading alone gives counts as its equal, not as vaguer) are not asked about ("Facial
  Moisturizing Lotion" with "PM Facial Moisturizing Lotion" and "Moisturising Lotion" stored asks only about the PM lotion, and a "no"
  makes a new row): the reading is most likely the more specific product read in part, so landing it on a row vaguer still would be a
  guess. Equal candidates are never vaguer, so they are unaffected. Like the ambiguity guard, it sees only the near misses left after
  `nearMissLimit`: a more specific row ranked out of the top 3 by closer, vaguer ones does not trigger it. A suitability line read into
  the variant is still weighed in full by the edition check (`namesAnotherEdition`), so it can keep a variantless row out of the near
  misses altogether: "for Dry Skin" printed as a variant may really be an edition.
  **Judge rule:** the same-product prompt (`product-analyst.same-product.md`) says false when one listing names less than the other
  (a product line, range or bare descriptor against a specific product). A sub-line or range name present in one listing and
  missing from the other (Shea Butter, MEN, Hydro Boost) was not read on that pack, so it is not a difference by itself; this
  does not touch the rule above, which still says false when one listing's whole name is only the range or line, against a
  specific product in it.
- **Research accounting.** An attempt is written as `started` BEFORE the researcher is called and settled to `found`,
  `not-found` or `failed` after, so a crash in between still counts. `found` is settled only AFTER the formulation is
  stored, so until then the `started` row keeps shielding the product from a concurrent call; if the store fails the
  attempt is settled `failed` and the error is rethrown. `started`, `found` and `not-found` count toward
  `dailyResearchBudget` (200 per rolling 24 hours; an attempt exactly 24 hours old still counts); `failed` does not,
  because an outage costs nothing. **The budget is alert-only:** an attempt made when the count has reached it raises the
  `research-budget` ops alert (once per UTC day) and goes ahead; research is never refused for it. If the `started` row cannot be written, the researcher is not called. If settling
  fails, the researcher's result or error is returned unchanged and the log line is `{ outcome: 'attempt-bookkeeping-failed' }`,
  nothing more. Refusals record nothing: a negative-cache hit and an idempotent no-op are free.
  If the eval's spend cap stops the researcher (`AiBudgetExceededError`, see "AI cost tracking"), the attempt is settled as
  `failed` (so it neither counts against the budget nor is cached as `not-found`) and the answer is `budget-exhausted`, with
  the same stale fallback.
- **Negative cache.** A product whose last attempt was `not-found` less than 7 days ago answers `not-found` without
  calling the researcher, so a product nobody can find is not paid for on every scan. A failure is never cached.
- **Stale fallback.** When the new research is refused (the negative cache, or the eval's cap) or finds nothing, `not-found` and `budget-exhausted` carry
  `fallbackFormulationId`: the product's stale formulation, but only if it was analysed by the current analysis and
  reference versions. The scan can then show the old, still valid answer instead of failing.
- **The free-text gate.** Text that came from a web page or the model is shown to users, so it is checked on the way in.
  Researched ingredients, and label ingredients, are refused if any entry contains a link (`scheme://` or `www.`) or
  markup: research then counts as `not-found` and stores nothing, a label as `LABEL_UNREADABLE`. Markup is a `<` straight
  before a letter, `/` or `!` (a tag, a closing tag, a comment). Other angle brackets are ordinary text, so `<1 ppm`,
  `pH < 5` and `> 2%` pass. In an analysis, `why` is at most 800 characters, `whoShouldTakeCare` at most 400, neither may
  carry a link or markup, and there are at most 20 concerns. A breach rejects the whole analysis. A text with both a link and
  markup is reported as the link. The analyst's prompt asks for no links in the text and for comparisons written as words
  or symbols with a space ("less than 1 ppm"). It also states a tighter length budget (`why` at most 450 characters,
  `whoShouldTakeCare` at most 200, repeated in the schema descriptions) so a slightly long answer still clears the gate.
- **Stock image import** runs after the formulation is stored, only when the product has no image and none was looked
  for in the last `FRESH_FOR_DAYS`. The research answer names up to 3 `imagePages` (pages for this exact product, the
  brand's own first, then retailers; each one the search returned, https only; see `AnthropicProductResearcher`). It also
  gives up to 30 `searchPages`: the other pages the search returned, in search order, https only, without the `imagePages`
  or the `sourceUrl` (only on a readable answer; omitted when empty). The pages tried are `[...imagePages, sourceUrl,
  ...pagesByNameMatch(searchPages, product)]` (a not-found result has no `sourceUrl`) with repeats dropped, at most 10
  (`MAX_IMAGE_PAGES`), in that order. `pagesByNameMatch` (`catalog.identity.ts`) ranks the search pages by the product's
  words in the URL path (host, query and fragment are not read; percent-escapes decoded, a bad one keeps the raw text; names
  normalised as the catalog compares them; one-letter words dropped): the score is how many of the brand, name and variant
  words the path holds, a page needs at least one word that is neither the brand's nor in `GENERIC_WORDS`, a tie goes to
  the page with fewer words the product does not have (a sibling edition's "men"), then to search order, and only the best
  page of each site is kept ("www." ignored). A URL that does not parse is dropped. For each page, in order:
  `pageImageUrl(page)` (see "Catalog images"; a page with no usable image is skipped), then the image store's safe
  download (`null` for a bad URL, type or size; the page is skipped and this is not a check), then `imageShowsProduct`
  (the vision match). The first image the match accepts is `put` to `<imageKeyPrefix>/products/<productId>.<jpg|png|webp>`
  (for example `catalog/staging/products/<productId>.jpg`) with the product's image key, image URL and time, and the
  import stops. An image URL already tried in this run is skipped, and at most 3 images per product go to the vision
  match (`MAX_IMAGE_CHECKS`), so the cost of a product is capped. Pages are tried one after another, never in parallel.
  The worst case is about 10 pages x (3 page hops + 3 image hops) = 60 fetches and 3 Haiku checks per product: inside the
  paid-plan subrequest limit, but with a 10-second timeout per fetch and no overall deadline, a product whose every site is
  slow can hold the queue consumer for up to about 10 minutes. If nothing was stored, the product is marked as checked and
  the outcome is the furthest stage reached on any page: `not-this-product`, then `download-failed`, then `no-page-image` (no pages
  at all is `no-page-image`). **A not-found research answer still gets an image attempt** when it names `imagePages` or
  `searchPages`, and so does a found answer whose list was rejected for links or markup. Even when ranking leaves no page
  to try, that is an attempt (`no-page-image`, and the product is marked checked). The research is settled as not-found as
  before, the pages are tried the same way, and the result is `{ kind: 'not-found', image }`. The 7-day "do not research again" rule is
  unchanged, and the image keeps its own `imageCheckedAt` timer, so a cached not-found result does no image work.
  **Every error is swallowed**: if the download, the model or the bucket throws, the research still reports its
  result, nothing is marked (so the next research retries), and the log line is `{ outcome: 'image-import-failed',
  productId }`, never a URL, because the URLs came from web pages.
  The import reports what it did as `image` on the `found` result and on the `not-found` result that tried pages
  (`StockImageOutcome`: `stored`, `already-has-image`, `checked-recently`, `no-page-image`, `download-failed`,
  `not-this-product` or `error`). It is informational only, so research never fails because of the image, and it is
  absent when research did not run (a fresh formulation already stored).
- **Analysis validation** (`checkAnalysis`) treats the model as untrusted and stores nothing unless all of it holds.
  *Vocabulary*: kind, severity and every trait must be in the fixed lists (matched ignoring case, stored in canonical
  form); one unknown value rejects the whole analysis. *Ingredient mapping*: each ingredient a concern names is
  matched to a label ingredient by its comparable parts (so `water` finds `Aqua (Water)` and `mercury` finds
  `Mercury 2%`) and written in the label's own spelling; a name not on the label is dropped, and a concern left with no
  ingredient is dropped. *Severity*: a banned-substance concern is stored as `high` whatever the model said. *Source
  filtering*, per concern: a source survives only if a flagged fact of that concern's kind and one of its ingredients
  carries it as its regulation URL, so a made-up link is never shown, and neither is a real one on a concern it does not
  back. *Flagged-fact coverage*, judged last (after the drops): every flagged fact needs a surviving concern of its kind
  that names its label ingredient. A rejection leaves any earlier analysis as it was.
- **Rejections say a fixed code and nothing else.** `AnalysisRejectedError` (a retryable `UnavailableError`, code
  `ANALYSIS_REJECTED`) names the problem as one of `TOO_MANY_CONCERNS`, `UNKNOWN_KIND`, `UNKNOWN_SEVERITY`,
  `UNKNOWN_TRAIT`, `TEXT_TOO_LONG`, `TEXT_HAS_LINK`, `TEXT_HAS_MARKUP`, `UNCOVERED_FLAGGED_FACT`. Never a word the model wrote or an ingredient from the
  label, because messages reach logs and job records.
- **Analysis attempts.** Every analysis call that gets as far as the model records an `analysis_attempts` row with the
  analysis and reference versions it ran under, like research: written as `started` BEFORE the analyst is called (if that
  write fails, the analyst is not called) and settled to `ok`, `rejected` or `failed` after, following what the model
  did: an answer that passed the gate is `ok` even if `saveAnalysis` then fails, and only a call the model never answered
  (unavailable, refused by the spend cap) is `failed`. The analyst's own error is
  rethrown unchanged; failing to settle is logged as `{ outcome: 'attempt-bookkeeping-failed' }`, nothing more, and never
  changes the result or the error. Three rejections
  at the same two versions make the third throw `PermanentJobError` (the job runner does not retry it), a fourth call
  throws it without calling the model, and `resolve` answers `analysis-failed` instead of `needs-analysis`. A change of
  either version makes the count start again, so a fixed prompt or reference list gets a fresh chance. A call the AI spend
  cap (the eval's) refuses is settled as `failed` and is not a rejection: `analyse` throws `CatalogBusyError`.
- **Daily analysis budget.** `started`, `ok` and `rejected` attempts count toward `dailyAnalysisBudget` (300 per rolling 24
  hours, an attempt exactly 24 hours old still counting); `failed` ones do not, because the model never answered
  (an outage, or a call the eval's spend cap refused), so nothing was paid for. An analysis the model did answer counts as `ok`,
  even if storing it failed. Rejections still count towards the three strikes. **The budget is alert-only:** an attempt made when
  the count has reached it raises the `analysis-budget` ops alert (once per UTC day) and goes ahead; `analyse` is never refused for it.
- **The product view carries reference coverage.** `productView(formulationId)` returns the product (with its public
  image URL, or `null`), the formulation with its source, the concerns, and `reference: { version, coverage }`. While
  the seed list is `'partial'`, a result with no concerns is "nothing in the checks we run", never an all-clear, and
  clients must say so. An unknown formulation is `NotFoundError('PRODUCT_NOT_FOUND')`; `research` and
  `addLabelIngredients` on an unknown product are the same, `analyse` on an unknown formulation is
  `FORMULATION_NOT_FOUND`. Scans do not use the view: a scan item carries `productSummary(formulationId)`, the same
  `product` part, read through the formulation (so an item follows a list a named label adopted) and with no concerns.

### Scan module
`modules/scans` owns the product scan (#20): the photos a user takes and how each one gets to a result. `ScanService`
reaches the catalog only through `ProductCatalogService`, and never depends on `UsersService` (the users service calls
it, through a guest cleaner, so a dependency the other way would be a cycle). It also takes `NotificationsService` (type-only, one way:
notifications never imports scans) to tell the person when a scan needs them or is done; which transitions notify is in
"Sending push notifications" → "What triggers a push". The routes are below.

- **Tables** (migrations 0009 and 0010). `scans`: id, `user_id` (references users, cascade), `profile_id` (migration 0012; see "Profiles"), `ip_hash`, `created_at`, `done_at`
  (null until the scan's `done` event is claimed, see Events); indexed by `user_id`, `(profile_id, created_at)`, `(ip_hash, created_at)` and, for the
  reaper's lost-`done` repair, `created_at` where `done_at IS NULL` (a partial index, so it holds only the scans still without a done time).
  `scan_items`, one per photo: id, `scan_id` (references scans, cascade), `user_id` (the scan's owner, copied so quotas and
  guest cleanup need no join; an item is owned through its scan, not through this column), `position` (unique within the scan), `state`, `reason`, `photo_key`, `back_photo_key` (null
  once that photo is deleted), `recognised_brand` / `_name` / `_variant` / `_form` / `_category` / `_confidence`, `product_id` and
  `formulation_id` (plain text, no foreign key: the catalog is not this module's; `product_id` may name an unnamed product that adoption has since deleted, so read the product through `formulation_id`), `no_label_source` / `_purpose` / `_used_for` / `_description` (migration 0019: nullable text, set together only by the move to `unidentified`; the three answers are enums in `scans.vocabulary.ts`, the description is free text of at most 200 characters), `created_at`, `updated_at`; indexed by
  `(scan_id, position)` (unique), `(user_id, created_at)`, `(state, updated_at)` (the reaper) and `updated_at` where `photo_key IS NOT NULL` (migration 0021, a partial index for the reaper's photo sweep, so it holds only the items still holding a key). `scan_photos` has the same partial index. `scan_back_photos`, one row
  per back photo ever uploaded: id, `item_id` (references scan_items, cascade), `user_id`, `ip_hash` (the uploader's own),
  `uploaded_at`; indexed by `(user_id, uploaded_at)` and `(ip_hash, uploaded_at)`. The row outlives the photo. `scan_retakes` (migration 0013) is the same for
  retaken front photos: id, `item_id` (references scan_items, cascade), `user_id`, `ip_hash` (the uploader's own), `uploaded_at`, with the same two indexes. A retake
  reuses the item's row, which counts only its first photo, so each retake has a row of its own. The state and reason enums are text with no CHECK, so the new
  states and reason needed no change to `scan_items`.
- **Item states.**
  ```
  recognising → matching → ready
                         → analysing → ready
                         → researching → analysing → ready
                                       → ready (an earlier analysed formulation, when new research finds nothing or is refused)
                                       → needs-back-photo → reading-label → analysing → ready
                                                          ← needs-back-photo (label-unreadable)
                                                          → failed (label-unreadable, after the 3rd back photo)
  recognising → needs-confirmation → matching     (confidence below 0.6, until the user confirms)
  recognising → rejected                          (face-or-person, not-a-beauty-product)
  recognising → needs-retake → recognising        (unreadable or label-not-visible, fewer than 3 front photos so far; the user retakes)
  recognising → needs-identification              (unreadable or label-not-visible on the 3rd front photo)
  needs-retake | needs-identification → matching  (a typed name, split by a model: `identifyByName`, queues `match`)
  needs-retake | needs-identification → ready | analysing | researching | failed (analysis-failed)
                                                  (a product picked from search: `identifyByName`, the same moves as `match`)
  needs-identification → unidentified                        (the user says the product has no label: `noLabel`; no job, no model, no photo)
  needs-identification → reading-label                       (a back photo is uploaded for an item with no product)
  reading-label (no product) → ready                         (`catalog.fromLabel` found its list already analysed)
  reading-label (no product) → analysing → ready             (otherwise)
  reading-label (no product) → needs-identification          (label-unreadable, fewer than 3 back photos so far)
  reading-label (no product) → failed                        (label-unreadable, on the 3rd back photo)
  any step    → failed
  ```
  `ready`, `rejected`, `failed` and `unidentified` are final (`FINAL_STATES`): an item in any of them lets its scan be done, and the reaper's lost-`done` repair counts it.
  `needs-retake` and `needs-identification` wait for the user and are not final: an item in
  either keeps its scan from being done. An `unidentified` item has no reason (the move clears it), no photo and no product, and nothing moves it again: the reaper and the dead-letter hook ignore it, since it is not a working state. **Reasons**: rejected is `face-or-person` or `not-a-beauty-product`;
  `needs-retake` and `needs-identification` carry `unreadable` or `label-not-visible`, the reason of the latest photo; failed is `photo-missing` (the stored photo is gone), `analysis-failed` (the catalog gave up),
  `label-unreadable` (the 3rd back photo could not be read either), `research-busy` (no longer set: a daily budget or the spend cap used to stop the work, and now they only alert; the value stays in the schema for items that already have it, so the API does not change) or `unavailable` (the step ran out of retries, the model's answer could not be used, the item lacked the
  product or formulation its step needs, or it was stuck for over 2 hours); `needs-back-photo` carries `label-unreadable`
  when the last back photo could not be read, was refused by the model, or is gone.
- **What the app is shown** (`ScanItemView`): id, position, state, reason, `retakesLeft` (only in `needs-retake`: 2, then 1; the key is
  absent in every other state, not undefined or null), `recognised` (once read), `product` (a `ProductSummary`: id, kind,
  brand, name, variant, form, category and `imageUrl`, only when ready; never the ingredients, the concerns or the reference
  coverage), `noLabel` (only when `unidentified`: `{ source, purpose, usedFor, description?, concerns, rulesVersion }`; the
  key is absent in every other state, and `description` is absent when none was given) and `image` (decision C): the product's stock
  image if it has one, else the user's own photo through a signed link (`/api/v1/scans/products/photos/<token>`) while it is still
  stored (the item's own `photo_key`, else its shelf photo's), else `null`. Because a photo is released once no item needs it (below), a
  user's photo is shown while it is still stored, which is in practice only while the item is `recognising` or `needs-confirmation`; **a product scan that is `ready` with no stock image
  therefore shows `image: null`** (it showed the user's photo before #74), and the app shows the brand and name. `scanView` reads the scan's
  photos once, not once per item. The stream's events carry the same item, and an event for a moved item never links the photo that move released.
- **Front photo lifecycle** (#74, decision C). A front photo is **held** only while an item using it may still be shown it for a decision: the
  item is `recognising` or `needs-confirmation` (`PHOTO_HELD_STATES`). A product item's own `scan_items.photo_key` (a retake's included) is released
  when the item leaves them. A shelf photo's `scan_photos.photo_key` is released when **no item of that photo** (`photo_id`) is in a held state; a
  failed placeholder holds nothing, so a photo whose read failed (an unusable answer, a missing image) is released too. **Release** deletes the object
  from the bucket FIRST, then clears the key with a guarded update (`clearItemPhotoKey(itemId, key)` / `clearShelfPhotoKey(photoId, key)`:
  `SET photo_key = NULL WHERE id = ? AND photo_key = ?`, true if it changed, and it never touches `updated_at`, so a release is not a move to
  `watch` or the stale sweep). A key therefore never points at nothing, and a failure between the two leaves the key for the reaper. A bucket
  or database failure is logged `{ outcome: 'photo-release-failed', scanId, itemId }` (ids, never the key) and never fails or undoes the step.
  `ScanService.releasePhotos(item)` (the item's own key, then its shelf photo) runs after every applied `transition`, after its next step is queued (a
  move that is undone must still have its photo) and before its item event is published; the shelf path runs it after `fanOut`, before the
  placeholder's `match` is queued, and `confirm` is a transition. A shelf placeholder whose read was stored and whose image was then released
  still goes on from the stored answer (`recognise` takes the shelf path when the photo holds a key or a recognition).
- **create.** Every photo is checked before any is stored, and one bad photo refuses the whole scan: 1 to 10 photos
  (`NO_IMAGES`, `TOO_MANY_IMAGES`), at most 2,000,000 bytes and 1600 pixels on the longest side (`IMAGE_TOO_LARGE`), JPEG
  or WebP (`UNSUPPORTED_IMAGE`). The type is read from the bytes with `readImageHeader`, never from what the caller
  claims, and the bytes decide the key's extension. The photos are put in the private bucket BEFORE the scan is saved
  (one `db.batch`: the scan and one INSERT per item, under D1's bound-parameter limit), so a saved item never points at a
  missing photo; if saving fails they are deleted again. One `recognise` job is queued per item; an item whose job cannot
  be queued is marked `failed` / `unavailable` rather than left recognising for ever.
- **createShelf** (#74; `POST /api/v1/scans/products/shelf`, below). A shelf scan is `scans.kind = 'shelf'`: 1 to `SCAN_POLICY.maxShelfPhotos` (3) photos, checked, quota-ed and stored by the same private
  helper as `create`. Each photo gets a `scan_photos` row that holds its image, under `photos/<env>/<user>/<scan>/<photo id>.<jpg|webp>`, and ONE placeholder item
  (`recognising`, `photo_key` null) at position `photo position * 5`: a photo owns the slots `p * 5` to `p * 5 + 4` (decision D), so the position of an item is the same on every
  retry and two photos read at once cannot collide. The quota counts one per photo here; the products found are counted as items when they are made. One `recognise` job per placeholder.
- **Photo keys.** `photos/<environment>/<user id>/<scan id>/<item id>.<jpg|webp>`, and for the back of the pack
  `<item id>-back.<jpg|webp>` (see "Private photos"). A retaken front photo uses the front photo's own key: the photo it replaces was deleted when it
  failed, and a concurrent loser never removes a key the winner wrote.
- **Daily quotas.** 30 photos per user and 100 per IP in the last 24 hours (`SCAN_POLICY`). A photo counts from the moment
  it is stored: one per item by `created_at`, plus one `scan_back_photos` row per back photo and one `scan_retakes` row per retake by `uploaded_at`,
  and the oldest counted time is the minimum over all three. A retake is written by the same `db.batch` as the item's move back to `recognising`,
  by the same rule as a back photo (`updateItem(id, expected, patch, backPhoto?, retake?)`: the insert runs first and only while the item is still in
  the expected state), is kept when its photo is deleted, and is not undone by a failed queueing. Every upload is a row, so an item asked three times for its back photo
  counts three (three is also the item's cap, `SCAN_POLICY.maxBackPhotos`); a row is written by the same `db.batch` as the item's move to `reading-label` (the insert runs first and
  only when the item is still in the state the move expects, so it exists exactly when the move applied) and is kept when
  the photo is deleted, as is a rejected item's front photo, so deleting cannot refill the quota. A failed queueing of the
  read undoes the move but not the row: the photo was sent. A photo made exactly 24 hours ago still counts. A scan is refused
  when the count plus its photos would pass the limit: 429 `SCAN_DAILY_LIMIT` with `details.retryAfterSeconds` until the
  oldest counted photo leaves the window. The check and the write are separate statements, so simultaneous scans can pass
  it together by a few photos; the route's burst limits bound that. The per-IP count adds the items of scans made from that
  `ip_hash` to the back-photo and retake rows with that `ip_hash`, so a back photo or retake is counted against the address that uploaded it,
  which may not be the scan's. The per-IP query reads only scans made in the window, through `(ip_hash, created_at)`, however long the
  address's history.
- **fanOut.** `ScansRepository.fanOut({ photo: { id, patch }, placeholder: { id, from, patch }, siblings, maxItems })` files a shelf photo's read in ONE `db.batch`, all or nothing
  (a taken item id fails the whole batch), and returns `{ placeholderMoved }`. The photo's patch applies only while the photo is `recognising`, so a repeat leaves the first answer.
  Each sibling is its own `INSERT ... SELECT ... WHERE (SELECT count(*) FROM scan_items WHERE scan_id = ?) < maxItems ON CONFLICT (scan_id, position) DO NOTHING` (the cap guard
  counts as the batch runs, so the first in the list wins; a position already held is skipped, which is what makes a retry idempotent (SQLite checks that conflict target before the primary key, so a sibling clashing on both is skipped, and the fake does the same); one statement each keeps D1's bound-parameter
  limit). A scan already at the cap stores none, yet the photo and placeholder still move. The placeholder's move is a guarded UPDATE ... RETURNING, whose applied-ness is the result.
  The fake mirrors it, checking the whole call before changing anything.
- **IP hashing.** `ip_hash` is HMAC-SHA-256 of the address under a key derived from `DEVICE_ID_KEY`
  (`HMAC(DEVICE_ID_KEY, "deepertones/ip-hash/v1")`), so it is unrelated to how device ids are hashed with the same secret and
  a leaked table cannot be reversed by hashing every address. The raw IP is never stored or logged; the route hands it to
  the service as a plain argument.
- **Steps.** One job, `advance-scan-item` on the `scan-items` queue pair (the dispatcher routes one job per queue, so every
  step shares it), carries `{ itemId, step, at }` and is keyed `<itemId>:<step>:<at>`. `at` (ms, required) is when the item
  entered the state the step works on: the `updatedAt` the move into that state stored (`transition` reads the clock once
  and uses that one value for both the stored time and the message), or the scan's `createdAt` for the first `recognise`. A
  queue redelivery carries the same `at` and so the same key; the reaper sends the stored `updatedAt`, which is the key of the
  message it stands in for; a deliberate re-send after an undo or a wait carries a later time and so a key of its own.
  `ScanService.advance` runs the step, which first checks the item is in its start state (a mismatch is a silent no-op: a
  late or repeated message):
  - `recognise` (`recognising`): reads the stored photo with the recognizer. A beauty product goes to `matching`
    (queues `match`), or to `needs-confirmation` below confidence 0.6. `face-or-person` and `other-product` are rejected. A photo that is
    `unreadable`, `label-not-visible` or refused by the model (treated as `unreadable`) is a failed front photo. A photo that is not used (a rejection, a failed photo) is deleted at
    once (before the row is updated, so a failure is retried while the item is still recognising) and `photo_key` is cleared; one that is read is released as above (at `matching`, or on confirmation). The item has had
    `tries = 1 + countRetakes(itemId)` front photos (every retake is a `scan_retakes` row, kept after its photo goes). Below
    `SCAN_POLICY.maxFrontPhotos` (3) tries it goes to `needs-retake`, with the reason the recognizer gave; at 3 it goes to `needs-identification`,
    keeping the 3rd photo's reason. Neither queues anything. A face or a non-beauty product is still rejected at once on any try. A missing photo fails the
    item. **An earlier answer is reused:** if the item already holds recognised fields and a confidence (a previous attempt's
    answer survived a failed enqueue, which the undo does not clear), the recognizer is not called again, and the stored
    confidence decides `matching` or `needs-confirmation`.
  - `recognise` on a **shelf placeholder** (the item has no `photo_key` and its photo holds one, or holds a stored recognition): the shelf path, `ScanService.recogniseShelf`. The photo's answer is
    `scan_photos.recognition` if an earlier attempt stored it (no second model call), else `recognizer.recognizeShelf` on the photo's image. **One answer per photo:** a fresh
    answer is stored at once with `ScansRepository.storeRecognition(photoId, json, at)` (guarded `WHERE state = 'recognising' AND recognition IS NULL`, so the first writer wins) and the
    photo is read back, so every retry and every concurrent delivery goes on with the same, stored answer (a rejection whose `fanOut` failed after the image was deleted retries into the
    same rejection, not `photo-missing`; two deliveries cannot file siblings from different answers). Errors are today's, on the
    placeholder only (Claude refusing our account waits like any step, unusable answer `unavailable` + `PermanentJobError`, a refusal is an `unreadable` answer, a missing image `photo-missing`).
    - **Faces are never counted** (decision E): `skipped_*` never includes a person or a face.
    - **No product** (decision A): the image is deleted first, then `fanOut` with no siblings rejects the photo (counts and answer recorded, `photo_key` null) and the placeholder
      (`not-a-beauty-product`, `face-or-person` or `unreadable`). Never `needs-retake` or `needs-identification`.
    - **Products:** identical ones (brand, name, variant, form, ignoring case and spacing) collapse, keeping the first. The placeholder becomes product #1 and the rest become
      items at `photo position * 5 + rank`, each `matching` or, below `confirmBelowConfidence`, `needs-confirmation`. Then the limits cut from the tail (the recognizer lists the most
      confident first): 5 per photo and `maxItemsPerScan` (20, counting the items the scan already holds) are `skipped_over_limit`; the day's allowance, the smaller of the user's
      and the scan's `ip_hash` remaining with the placeholder already counted, is `skipped_daily_limit`. The allowance is read, not reserved, so it is racy across concurrent photos (it may be exceeded by up to 4 extras per concurrent photo, the same accepted race as `create`'s quota),
      and a sibling that the SQL cap guard drops because another photo filled the scan first is not counted in `skipped_over_limit`. The recognizer's own counts are `skipped_not_beauty` / `skipped_unreadable`.
    - **After `fanOut`**, only if the placeholder moved (a repeat does nothing): its `match` is queued first (if that fails the placeholder goes back to `recognising` and the error is
      rethrown, as `transition` does; the retry reuses the stored answer), then each `matching` item's in rank order (a failure logs ids only and leaves it to the reaper), one
      `scanNeedsYou('confirm')` for the photo, then the item events. The placeholder's `match` is stamped with this attempt's time (its move stored it); each new item's with its own stored `updatedAt`, which on a retry is the first attempt's (the key the reaper reuses). Model text is never logged.
  - `match` (`matching`): `catalog.resolve`. `ready` makes the item ready; `needs-analysis` goes to `analysing`;
    `needs-research` to `researching`; `analysis-failed` fails the item. Missing recognised fields fail the item as `unavailable`.
  - `research` (`researching`): `catalog.research`. Found goes to `analysing`. Not found shows the earlier analysed formulation as
    `ready` when there is one; otherwise it asks for the back photo (`needs-back-photo`). (The eval's `budget-exhausted` answer cannot
    happen in production; the step would throw it as `CatalogBusyError` for the queue to retry.)
  - `read-label` (`reading-label`): reads the back photo. A list the reader cannot read, or that the catalog refuses (`LABEL_UNREADABLE`:
    empty, too long, a link or markup), deletes the back photo and asks again; so does a back photo that is missing (ask again, rather than
    fail). What follows depends on the item:
    - **An item with a product** (it came from `needs-back-photo`) stores the list with `catalog.addLabelIngredients`, then goes to
      `analysing`; unreadable, it goes back to `needs-back-photo` with `label-unreadable`, or to `failed` after the 3rd back photo.
    - **An item without one** (it came from `needs-identification`) files the list with `catalog.fromLabel`, sets `recognised` only when the label
      printed a brand and a name, and goes to `ready` when the list is already analysed at the current versions, else to `analysing`; unreadable, it
      goes back to `needs-identification` with `label-unreadable`, or to `failed` after the 3rd back photo.

    The limit is the first `SCAN_POLICY.maxBackPhotos` (3) back photos: the item is allowed 3, counted
    from its `scan_back_photos` rows (`countBackPhotos`), and when the 3rd cannot be read either the item ends `failed` with
    `label-unreadable` (the front photo was already released at `matching`, back photo key cleared, nothing queued), so no 4th is asked for and `back-photo`
    answers 409 `ITEM_NOT_AWAITING_BACK_PHOTO`. A list that is stored moves the item on (to `analysing` and queues `analyse`, or straight to `ready` when `fromLabel` said it is analysed) with `back_photo_key` cleared, and then
    the back photo is deleted from the bucket; the delete comes after the move so an undone move still has its photo, and a
    delete that fails is logged (`photo-cleanup-failed`, ids) and does not fail the step (the object stays in the bucket
    with no row pointing at it). The upload's `scan_back_photos` row stays, so it still counts toward the quota.
  - `analyse` (`analysing`): `catalog.analyse`, then `ready`. The catalog's `PermanentJobError` (the third rejection) fails it as `analysis-failed` and is rethrown so the
    job runner records the run as failed; any other error is rethrown and the item waits for the retry.
  - **A step that needs an id the item lacks** (`research` without a `productId`, `analyse` without a
    `formulationId`; `read-label` needs none, an item without a product is identified by it) fails the item as `unavailable`, as `match` does, instead of returning silently and leaving it for ever.
  - **What the model can do to a photo.** Imports are of the `*.provider.ts` ports only. `recognise`: `AnthropicRefusalError`
    counts as an `unreadable` photo (a retake, or identification on the 3rd, with the photo deleted); `AnthropicRequestError` (not JSON, cut off
    at `max_tokens`: the same photo would get the same answer) fails it as `unavailable` and throws `PermanentJobError`, so the run is
    recorded failed and there is no paid retry. `read-label`: refusal and unusable answer are the same as
    an unreadable label (back to `needs-back-photo` / `label-unreadable`, or `failed` / `label-unreadable` after the 3rd back photo; back photo deleted, no throw).
    Any other error (`AnthropicUnavailableError`, a bug) is thrown and retried.
  - **Claude refuses our account** (`AnthropicConfigError`: a 401, a 402 `billing_error`, which is how no credit shows up, or a 403).
    `advance` catches it from ANY step (the recognizer, the label reader, the catalog's same-product judge, the researcher, the
    analyst). It is ours to fix, never the user's, so the item waits: it stays in its working state, the same step is queued again
    with `at` = now and `delaySeconds: 300` (5 minutes, under a key of its own, so no retry of the message is used), nothing is
    published, and `updatedAt` is untouched, so the reaper's 2 hour limit still bounds the wait (an item that waits that long
    ends `failed` / `unavailable`). The `ai-account` ops alert is raised (at most one email an hour however many items wait). The
    alert never costs the item its wait (`raise` does not throw); a wait that cannot be queued is thrown, for the queue to retry the step.
  - **Waiting for work in progress.** When the catalog says another call is already researching the product
    (`ResearchInProgressError`) or analysing the formulation (`AnalysisInProgressError`), the step leaves the item as it
    is, queues the same step again with `at` = now and `delaySeconds: 30` and returns, so the wait uses none of the
    message's retries. Nothing is published, and `updatedAt` is untouched, so the reaper's 2 hour limit bounds the wait. If
    the waiting message cannot be queued the error is thrown and the queue retries the step.
    **Known limitation:** if that delayed re-send is itself lost, the reaper's re-send carries the item's stored `updatedAt`
    as its `at`, which is the key of the FIRST message, and that run is already done (it was the one that queued the wait). The
    dispatcher therefore acks the reaper's message as a duplicate and the step does not run again, so the item is failed as
    `unavailable` by the reaper's 2 hour limit instead of re-running. Left as it is: it needs a lost message on top of a busy catalog.
- **retake.** `ScanService.retake(scanId, itemId, photo, clientIp)` takes a new front photo for an item in `needs-retake` (any other state, a
  rejected item included, is 409 `ITEM_NOT_AWAITING_RETAKE`; an item in `needs-identification` is past its 3rd photo and gets the same 409). It
  checks the photo like a front photo, counts one against both daily quotas (`SCAN_DAILY_LIMIT`), stores it under the front photo key, then one
  guarded write moves the item `needs-retake → recognising`, clears the reason and the recognised fields, sets `photo_key`, writes the
  `scan_retakes` row and queues `recognise` with `at` = the time of the move. If the queueing fails the move is undone to `needs-retake` with the old reason and a null
  `photo_key`, the new photo is deleted and the error rethrown (the retake row stays: the photo was sent). Of two retakes at once one wins and the other is 409;
  a loser deletes only its own key, and only when it differs from the winner's. The route answers 202 with the item.
- **identifyByName.** `ScanService.identifyByName(scanId, itemId, { productId } | { text })` names the product of an item whose front photo could
  not be read, from `needs-retake` or `needs-identification` (anything else is 409 `ITEM_NOT_AWAITING_IDENTIFICATION`). It sends no photo, so no
  quota or retake row is written. The checks run in this order, and nothing is paid for until all have passed: the scan is the caller's
  (404 `SCAN_NOT_FOUND`), the state, then the text (400 `INVALID_PRODUCT_TEXT`: trimmed, 2 to 120 characters, no link, markup or hidden character,
  because the split becomes a product in the shared catalog), then the work. No AI call is made on any 4xx.
  - **`{ productId }`** (a result of search, no model call): `catalog.choose` says what the product needs, and the item moves through the same
    handling as the `match` step (`moveOn`): `ready`, `analysing` (queues `analyse`), `researching` (queues `research`), or `failed` /
    `analysis-failed` for a product whose analysis was rejected the maximum number of times. `recognised` is set from the chosen product
    (`catalog.namedProduct`), `recognised.form` included (the product's own form, or `null`). An unknown or unnamed product is 404 `PRODUCT_NOT_FOUND`, the item unchanged.
  - **`{ text }`**: one `NameSplitter.split` call, which has its own `AnthropicClient` with a 15 s timeout (the shared one waits 60 s; the split runs in the request), then the item goes to `matching` with the split's brand, name, variant and category as
    `recognised` and `match` is queued, exactly as a confirmation does; the catalog lookup and any research happen in the queue, not in the request.
    `not-a-product`, or a refusal, is 400 `NOT_A_PRODUCT_NAME`;
    `AnthropicUnavailableError` (down, overloaded or timed out), `AnthropicRequestError` (an unusable answer) and `AnthropicConfigError` (our account, which also raises the `ai-account` ops alert) are `UnavailableError` (503 `AI_UNAVAILABLE`,
    "Couldn't read that name right now. Try again in a moment.": it blames no limit and says nothing of our account) and are logged `{ outcome: 'split-name-failed', error }` with the error name only. In each the item stays where it was, nothing is queued and the user may try again (the one
    split is paid for, which the rate limits bound).
  - The move is a guarded `transition` from the state read, so of two simultaneous calls one wins and the other is 409; if the next step cannot be
    queued, the move is undone and the fields it set (`recognised*`, `productId`, `formulationId`) are cleared again.
  - **Known limits.** `stripSizes` is not applied to a typed name or to search (a pack size in a name is matched as typed). A typed name with
    no brand is not a product: the splitter answers `not-a-product`, and so does an empty name. Products made before search text existed are searchable only once the reaper
    has filled them (see "Product catalog data"), within a few runs.
- **noLabel.** `ScanService.noLabel(scanId, itemId, { source, purpose, usedFor, description? })` ends an item that offers identification as
  `unidentified`: the user has no label to give and the product stays unknown. It runs in this order: the scan is the caller's (404 `SCAN_NOT_FOUND`), the item
  is in `needs-identification` and no other state (409 `ITEM_NOT_AWAITING_NO_LABEL`; an item in `needs-retake` still has tries left, so it must keep trying), then the description
  (`cleanText`, at most 200 characters, 400 `INVALID_PRODUCT_TEXT` with `details.field = 'description'`; a blank one is stored as null, any other is stored trimmed). Then one guarded
  `transition` to `unidentified` clears the reason and writes the four answers, and publishes the item (and `done` if it was the scan's last). It sends no photo, calls no model and queues
  no job, so no quota, retake or spend is used. A repeated call, or two at once, is 409 for all but the winner.
  - **Cautions are computed at view time.** `scans.cautions.ts` is a pure module (no I/O, no clock, no model): `cautionFor({ source, purpose, usedFor })` returns the item's
    `DraftConcern`s in a fixed order, and the service calls it each time the item is shown (`itemView`), so nothing the rules produce is stored. The order is: (1) purpose `lighten`:
    `banned-substance`, high, naming mercury, hydroquinone and corticosteroids, in stronger words for source `market-vendor` or `not-sure` and weaker ones for `pharmacy`, `online` and
    `gift`; (2) `lighten` or `treat-spots` for `6-months-2-years` or `over-2-years`: `hyperpigmentation-risk`, medium (skin thinning, and darkening from ochronosis); (3) always: `irritation`, medium
    (contents unknown, patch-test, treat with caution). The description is not an input and is never echoed. The text is about the product, never the user, and stays within the analysis path's
    concern vocabulary and its `MAX_WHY_LENGTH` and `MAX_WHO_LENGTH`, with no link or markup. The concerns carry no `sources`: there is no label to match a regulatory listing to.
  - **Versioning.** `CAUTION_RULES_VERSION` (1) is published on the item as `noLabel.rulesVersion`. Change the wording or a rule, bump it: because the cautions are not stored, every item already
    answered shows the new rules at once, and a client uses the number to tell which rules wrote what it holds. It is separate from `ANALYSIS_VERSION`, which makes analyses of labels stale.
- **The user's steps.** `confirm` takes the corrected brand, name, variant, optional form (never `unknown`) and category of an item in `needs-confirmation`
  and queues `match`; its text is trimmed and refused (`INVALID_PRODUCT_TEXT`) when empty, over 120 characters, or carrying
  a link, markup or a hidden character, because it becomes a product in the shared catalog. `addBackPhoto` takes the photo
  of an item in `needs-back-photo` or `needs-identification` (same photo rules and quotas as a front photo) and queues `read-label`. A wrong state is
  409 `ITEM_NOT_AWAITING_CONFIRMATION` or `ITEM_NOT_AWAITING_BACK_PHOTO`. A scan or item made by another profile (of the same
  account or another), or a scan/item mismatch, is 404 `SCAN_NOT_FOUND`, with no hint that it exists. The rule is on the
  scan: `ownedScan` needs `scan.userId` and `scan.profileId` to equal the actor's, and `ownedItem` is the item of an owned scan.
- **Repeat-safe.** Queues deliver at least once. Every step starts only while the item is in its own start state and moves
  it with `updateItem(id, expectedState, patch)`, one conditional UPDATE that says whether it applied, so a repeated or
  late message finds the item moved on and does nothing (no vendor call, no job, no event). Of two simultaneous moves
  from one state exactly one wins. The next job is queued after the move is written; if queuing fails the move is undone
  and the error rethrown, so the retry runs the step again instead of finding an item that will never be advanced. The undo
  puts back the state and, by default, the previous `reason` (so an item that asked again with `label-unreadable` has it
  again), plus the extra fields a caller names (a back photo's key). The retry's next message gets a new `at`, so a
  step queued after an undo is not mistaken for one that was already run. `transition` takes `{ from, change, next?, undo?,
  backPhoto?, retake? }`. Errors thrown by a vendor leave the item where it was for the queue's retry. `markItemFailed`, the
  dead-letter hook, fails an item as `unavailable` only while it is in a state the system is working in (`recognising`,
  `matching`, `researching`, `reading-label`, `analysing`); an item waiting for the user (`needs-confirmation`,
  `needs-back-photo`, `needs-retake`, `needs-identification`) or a finished one is left alone, since a dead letter for either is a stale message from an earlier state.
- **The reaper.** A message can still be lost (the queue accepted a send that never arrived; a Worker died between the write
  and the send, with the undo never run), and the dead-letter hook only covers messages that reached the queue. A cron every
  10 minutes runs `ScanService.reap(now)`: items in `recognising`, `matching`, `researching`, `reading-label` or `analysing`
  (never `needs-confirmation`, `needs-back-photo`, `needs-retake` or `needs-identification`, which wait for the user, nor a final state, `unidentified` included;
  the two new ones are not final either, so they never get a `done` and their scan's `done_at` stays null) whose `updated_at` is
  older than 15 minutes (`staleItems`, oldest first, at most 100 per sweep, by `(state, updated_at)`) have their step
  queued again with `at` = that `updated_at`, the key of the message that first queued it: if that run is done the
  dispatcher acks the duplicate, if it was lost it runs. An item older than 2 hours is failed as `unavailable` with an event
  (and `done` if it was the scan's last). A failure on one item is logged `{ outcome: 'reap-failed', scanId, itemId }` and
  does not stop the sweep. The same sweep also repairs a lost `done`: a scan with no `done_at`, created within the last 3 hours
  (`SCAN_POLICY.doneRepairWindowMs`), whose items are all final and were all last updated over 5 minutes ago
  (`settledScansNotDone`, oldest first, at most 100) is marked done with `markScanDone` and `done` is published, once, by the
  call whose update applies; the 5 minutes keep it from racing a publish still on its way. The 3 hours bound the read to the
  partial index on `scans(created_at) WHERE done_at IS NULL` instead of the whole table every 10 minutes: a repair only
  matters to a connected client, a connection lasts 10 minutes at most, and `watch` sends `done` to any client that connects
  later. If the publish throws after the time was set, the time is cleared again (`clearScanDone`, which applies only while
  the time is still the one this call set), so the next sweep tries again. A failure there is logged
  `{ outcome: 'reap-done-failed', scanId }`. Each sweep also gives the scans that have no profile their owner's default (`adoptOrphanScans`, see "Profiles" → Rollout). `reap` still answers `{ requeued, failed }`. It also **sweeps the photos a release missed**: `itemsWithReleasablePhoto(100)` (items with a `photo_key` in any state but `recognising` and `needs-confirmation`) and `shelfPhotosToRelease(100)` (photos with a key and no item of theirs in a held state, a NOT EXISTS over `(scan_id, position)`), each its own budget and oldest `updated_at` first through the partial indexes, releasing each as above; a failure is logged by id and skipped. Before #74 part 4 these rows (a `ready` item with its photo) are swept the same way. `wrangler.jsonc` has three crons in all three blocks, `17 3 * * *` (guest cleanup),
  `*/10 * * * *` (reaper) and `*/15 * * * *` (the reminder fan-out, "Reminders" → Sends); `scheduled` is `createScheduledRouter` (`src/jobs/scheduled.ts`), which runs the job of
  `controller.cron` and, for any other, logs `unknown-cron` and throws, so Cloudflare records the run as failed (a cron in `wrangler.jsonc` this file does not know is a config mistake) and the nightly cleanup does not run every 10 minutes. The reaper
  reads no request context, so it runs without `runAs`; the cleanup handler it routes to stays in `dispatcher.ts` with its `runAs`.
- **Events.** After every change the service publishes `{ type: 'item', item }` (the item exactly as `ScanItemView`), and
  `{ type: 'done' }` once when the item that just finished was the last non-final one. `done` is sent only by the call
  whose guarded `UPDATE scans SET done_at = ? WHERE id = ? AND done_at IS NULL` applies (`markScanDone`), so two items
  finishing together send it once, and the same call queues the finished push first (see "Sending push notifications"). Only after the change is stored;
  a publish that throws is logged as `{ outcome: 'publish-failed', scanId, itemId }` and never fails the step. If it was the
  `done` publish that threw, the done time `markScanDone` set is cleared again (`clearScanDone`, guarded on that very time), so
  `done` is still owed and the reaper finds the scan; without that the scan would look finished and no one would ever send it. The port
  is `ScanEvents` (`publish` and `subscribe`); `DurableObjectScanEvents` is the production adapter (see "Live updates"),
  and `MemoryScanEvents` records events and subscriptions for tests. The event's item is the service's `ScanItemView`; once
  serialised it is byte for byte the item `GET /api/v1/scans/products/{scanId}` presents (`Date`s become the same ISO strings the presenter writes).
- **Scan photos and kind** (migration 0020, #74). `scan_photos` records every photo uploaded to a scan, whatever it shows: id, `scan_id`
  (references scans, cascade), `user_id` (the scan's owner, copied for the cleanup), `position` (unique within the scan), `state`
  (`recognising` / `recognised` / `rejected`), `photo_key` (null for a product photo, whose image stays on its one item's
  `scan_items.photo_key`; set for a shelf photo, which holds its own image), `recognition` (the recognizer's whole answer as JSON, null until written),
  `skipped_not_beauty` / `_unreadable` / `_over_limit` / `_daily_limit` (counts, default 0), `created_at`, `updated_at`; indexed by `(scan_id, position)` (unique) and `user_id`.
  `scans.kind` (`product`, `shelf` or `typed`, below) says what the scan is of, and `scan_items.photo_id` names the `scan_photos` row an item was made from. Both are
  nullable text with no SQL default, and `photo_id` has no foreign key, for the reason `profile_id` has none: adding a NOT NULL or REFERENCES
  column to `scans` or `scan_items` (both parents) makes drizzle rebuild the table, which can cascade-delete the rows below it. The migration is therefore
  two `ALTER TABLE ... ADD` statements plus `CREATE TABLE scan_photos`, with no rebuild. Code always sets both; rows from before read NULL, and
  `ScansRepository` reads a NULL `kind` as `product`, so `Scan.kind` is never null. `ScanService.create` makes a `product` scan with one photo row per uploaded
  photo (position = index, no key) and points each item at its photo. `createScan(scan, photos, items)` writes all three in one batch;
  `photosOf` and `findPhoto` read the photos; `photoKeysForUsers` includes the photo keys and `deleteForUsers` deletes `scan_photos` before `scans`.
- **Guest cleanup.** The container registers a cleaner `{ name: 'scans', deleteFor }` with the users service, backed by
  `ScanDataCleaner` (`scans.cleaner.ts`), which depends only on the repository and the photo store, so the cleanup does not
  build the catalog and the model clients (nor need their settings). `deleteForUsers` deletes the users' photos, back
  photos and shelf photos from the bucket first, then their back-photo and retake rows, items, scan photos and scans, so a bucket failure leaves the rows (and so
  the keys) for the next run; both halves are safe to repeat, and the repository chunks the ids under D1's bound-parameter limit.
- **Public signed photo links.** `photoForLink(token)` takes no user and reads no request context: an app image component
  cannot send an Authorization header, so the link is the capability. The token is the signed, 5-minute photo link from
  "Private photos" (minted for the item's owner when the item is shown), checked with `verifyPhotoLink`. A malformed,
  tampered, wrongly signed or expired token, and a link to a photo deleted since, are all 404 `PHOTO_NOT_FOUND`. The
  route that serves it answers with `Cache-Control: private, no-store`. A link therefore works for whoever holds it, for at most 5
  minutes.
- **Routes** (`scans.routes.ts`, mounted at `/api/v1/scans/products`; schemas in `scans.schemas.ts`, shaping in `scans.presenter.ts`). Thin: each
  calls one `ScanService` method, which does the sign-in check (`requireUser`) itself, so the guard stays in the service. On the
  confirmation route a request is therefore validated before it is found to be unsigned (an invalid body is 400 or 415 before
  401); the two upload routes put the `signedIn()` middleware in front of the body (see Size), so there an unsigned caller
  is 401 whatever the body.

  | Route | Caller | Answers | Limits (per 60 s) |
  | --- | --- | --- | --- |
  | `POST /api/v1/scans/products` | bearer; multipart, 1 to 10 `photos` parts | 202 the scan, every item `recognising`; 400, 401, 413, 415, 429 | 20 per IP, 10 per user |
  | `GET /api/v1/scans/products/{scanId}` | bearer | 200 the scan; 401, 404 `SCAN_NOT_FOUND` | none |
  | `POST /api/v1/scans/products/{scanId}/items/{itemId}/confirmation` | bearer; JSON `{ brand, name, variant?, form?, category }` | 202 the item, now `matching`; 400, 401, 404, 409 `ITEM_NOT_AWAITING_CONFIRMATION` | none |
  | `POST /api/v1/scans/products/{scanId}/items/{itemId}/back-photo` | bearer; multipart, one `photo` part | 202 the item, now `reading-label`; 400, 401, 404, 409 `ITEM_NOT_AWAITING_BACK_PHOTO`, 413, 415, 429 | 20 per IP, 10 per user |
  | `POST /api/v1/scans/products/{scanId}/items/{itemId}/retake` | bearer; multipart, one `photo` part | 202 the item, now `recognising`; 400, 401, 404, 409 `ITEM_NOT_AWAITING_RETAKE`, 413, 415, 429 | 20 per IP, 10 per user |
  | `POST /api/v1/scans/products/{scanId}/items/{itemId}/identification` | bearer; JSON, exactly one of `{ productId }` or `{ text }` | 202 the item (`matching`, `ready`, `analysing`, `researching` or `failed`); 400 (`VALIDATION_FAILED`, `INVALID_PRODUCT_TEXT`, `NOT_A_PRODUCT_NAME`), 401, 404 `SCAN_NOT_FOUND` or `PRODUCT_NOT_FOUND`, 409 `ITEM_NOT_AWAITING_IDENTIFICATION`, 415, 429, 503 `AI_UNAVAILABLE` | 20 per IP, 10 per user |
  | `POST /api/v1/scans/products/{scanId}/items/{itemId}/no-label` | bearer; JSON `{ source, purpose, usedFor, description? }` (fixed words; see `scans.vocabulary.ts`) | 202 the item, now `unidentified` with `noLabel`; 400 (`VALIDATION_FAILED`, `INVALID_PRODUCT_TEXT`), 401, 404 `SCAN_NOT_FOUND`, 409 `ITEM_NOT_AWAITING_NO_LABEL`, 415, 429 | 20 per IP, 10 per user |
  | `GET /api/v1/scans/products/{scanId}/events` | bearer | 200 `text/event-stream` (see "Live updates"); 401, 404 `SCAN_NOT_FOUND` | none |
  | `GET /api/v1/scans/products/photos/{token}` | public (`security: []`): the signed link is the credential | 200 the image bytes; 404 `PHOTO_NOT_FOUND` | none |

  - **Uploads.** The body is multipart (`multipartBody`). Hono hands one file over bare and several as an array, so the
    `photos` schema takes either and normalises to a list, and does not count it: the service answers `NO_IMAGES` or
    `TOO_MANY_IMAGES` (the route is documented as 1 to 10). A multipart body cannot reach `NO_IMAGES`: with no `photos` part
    the field is missing, which is `VALIDATION_FAILED` like two `photo` parts, none, or a part that is not a file. The schema deliberately does not check a file's declared `type` or `size`: the client's word is not
    the bytes, so the service sniffs them and answers `UNSUPPORTED_IMAGE` (a PNG that says it is a JPEG included) or
    `IMAGE_TOO_LARGE` (over 2,000,000 bytes or 1600 px) with a code the app can act on. The route turns each `File` into the
    service's `ProductImage` (bytes plus the declared type, which the service never trusts).
  - **Identification body and order.** The body is a union of two closed objects, so `{}`, both fields, an extra field or a non-string is
    `VALIDATION_FAILED`; the text's length and content are the service's (`INVALID_PRODUCT_TEXT`). The route runs the IP limiter,
    `signedIn()`, then the user limiter, then validates the body, so an unsigned caller with a bad or non-JSON body is 401 and a model is never called past the limits.
  - **No-label body and order.** `source`, `purpose` and `usedFor` are required and each one of its fixed words (anything else, or a missing one, is `VALIDATION_FAILED`); `description` is an optional string
    whose length and content are the service's (`INVALID_PRODUCT_TEXT`). The middleware order is the identification route's (IP limiter, `signedIn()`, user limiter) and there is no `bodyLimit`: the body is a few short fields.
  - **Order and size.** All three upload routes run, in this order: the IP limiter, `signedIn()`, the user limiter, `bodyLimit`.
    The IP limiter counts every caller, signed in or not. `signedIn()` (`middleware/signed-in.ts`) answers 401 `AUTH_REQUIRED`,
    `TOKEN_EXPIRED` or `TOKEN_INVALID` from `c.var.auth` (the same codes as `requireUser`, through `notSignedIn` in
    `lib/actor.ts`), so an unsigned caller costs no body read, no 413, 415 or 400; it is an early exit, and the service's
    `requireUser` is still the guard. The user limiter needs a user, so it follows. `bodyLimit` comes last: with a
    `Content-Length` over the limit it answers 413 from the header alone, and without one it counts the stream and cuts it
    off, so an oversized upload is never buffered whole. The limit is 10 x 2,000,000 bytes plus 1,000,000 for the multipart
    framing (21,000,000) on `POST /api/v1/scans/products`, 3 x 2,000,000 plus the same framing (7,000,000) on `POST /api/v1/scans/products/shelf`, one photo plus the same framing on the back photo and the retake. Over it is 413 `HTTP_413` in
    the standard error envelope.
  - **Limits.** `SCAN_CREATE_IP_LIMITER` (20) and `SCAN_CREATE_USER_LIMITER` (10) on create, `SCAN_BACK_PHOTO_IP_LIMITER` (20) and
    `SCAN_SHELF_IP_LIMITER` (20) and `SCAN_SHELF_USER_LIMITER` (10) on the shelf scan (the same numbers as create, a counter of its own, so neither route spends the other's allowance), `SHELF_ADD_IP_LIMITER` (20) and `SHELF_ADD_USER_LIMITER` (10) on adding a searched product to the shelf (`POST /api/v1/me/shelf`, which may start a model call),
    `SCAN_BACK_PHOTO_USER_LIMITER` (10) on the back photo, `SCAN_RETAKE_IP_LIMITER` (20) and `SCAN_RETAKE_USER_LIMITER` (10) on the retake, `SCAN_IDENTIFY_IP_LIMITER` (20) and `SCAN_IDENTIFY_USER_LIMITER` (10) on the identification (each may cost a model call), `SCAN_NO_LABEL_IP_LIMITER` (20) and `SCAN_NO_LABEL_USER_LIMITER` (10) on the no-label answer (no model, but a write each); 429 `RATE_LIMITED` with `Retry-After: 60`, counted before the body is
    read or the scan looked up. The back photo has its own address limiter, not the create one, so photos sent for a scan
    do not use up the address's budget for starting scans. They bound bursts; the daily photo quotas (429 `SCAN_DAILY_LIMIT`) stand
    underneath. Namespace ids are 1006 to 1017 at the top level, 2006 to 2017 in staging and 3006 to 3017 in production (the retake limiters are 1010/1011, 2010/2011, 3010/3011; the identification limiters 1012/1013, 2012/2013, 3012/3013; the product search limiters 1014/1015, 2014/2015, 3014/3015; the no-label limiters 1016/1017, 2016/2017, 3016/3017).
  - **Client address.** The service is handed `cf-connecting-ip` as the address for the per-address daily quota (`unknown` where the
    header is absent, as for the rate limiter).
  - **The public photo route** ignores the Authorization header altogether (a broken or expired one changes nothing), answers 200
    with the exact `Content-Type` of the stored photo (`image/jpeg` or `image/webp`), `Cache-Control: private, no-store` and the
    bytes, and answers any bad, tampered, wrongly signed, expired or over-2048-character token, or a deleted photo, with 404
    `PHOTO_NOT_FOUND` in the JSON error envelope. Its token parameter has no length limit of its own for that reason.
    It is declared with `imageResponse`, so the compiler cannot check that handler's return: the integration tests do.
- **Wiring.** The container builds the service with `D1ScansRepository`, the catalog, `AnthropicProductRecognizer`,
  `AnthropicLabelReader` and `AnthropicNameSplitter` (all over the shared client), `R2PhotoStore` for `PRIVATE_PHOTOS` locked to `ENVIRONMENT`
  (anything but development, staging, production or test stops the build), the job queue with the `scan-items` binding,
  `DurableObjectScanEvents` over the `SCAN_STREAM` binding, `JWT_SECRET` for the photo links and `DEVICE_ID_KEY` for the IP hash.
- **Logs** carry ids and outcomes only, never a photo, an IP, or what the model said.
- **Back-photo reads are keyed per upload.** The `read-label` message's `at` is the upload's move into `reading-label`, so a fresh photo after an unreadable one is read again rather than dropped as a duplicate (every step is keyed this way now, see Steps).

### Product search
`GET /api/v1/products/search?q=` (`modules/catalog/catalog.routes.ts`, operation `searchProducts`, tag "Products", mounted at `/api/v1/products`) finds
named products as the user types, so an item that could not be photographed can be identified by picking one
(`POST .../items/{itemId}/identification` with its `productId`; see "Scan module"). It calls `ProductCatalogService.search`; the response is
`data: { products: [{ id, brand, name, variant, form, category, imageUrl }] }` (`form` is one of `PRODUCT_FORMS` or `null`, always present, so a spray and a roll-on of one line are told apart), at most 10, shaped by `catalog.presenter.ts`. It makes no model or web call.

- **Query.** `q` is trimmed, then 2 to 80 characters (`VALIDATION_FAILED` otherwise). The service normalises it with `normaliseText`, so case, accents
  and punctuation do not matter; a query under 2 characters once normalised (`!!`, `a!`) finds nothing, never everything, and the service does not query for it (the route's bound
  is on the trimmed text, so `a!` passes validation and answers `[]`).
- **Match.** Word-wise. The normalised query is split on spaces (empty parts ignored, at most the first 8 words; none left finds nothing). A product
  matches when its `products.search_text` (see "Product catalog data") contains EVERY word, OR when ONE of its alias keys in `product_aliases`
  contains every word (the AND is inside the per-alias subquery, so words spread over two aliases do not match). Each product appears once, and only
  named products are searched (an unnamed product's `search_text` is `''`, and `kind = 'named'` is checked too). The words need not be adjacent or in
  order: "loreal revitalift" finds "loreal paris revitalift creme". Order: those whose `search_text` starts with the whole query first, then
  `search_text` ascending, then `id`, so the order is the same every time. The repository uses SQLite `instr` per word, not `LIKE`: D1 refuses a
  LIKE pattern over 50 bytes ("pattern too complex") and a query may be 80 characters, and `instr` has no wildcard characters to escape (a user typing
  `50%` means those characters). Every word is a bound parameter. `instr` is case-sensitive, like the fake's `includes`; both sides are normalised.
- **Auth and limits.** Bearer token (a guest is fine). Middleware in order: `PRODUCT_SEARCH_IP_LIMITER` (120 per 60 s), `signedIn()`, `PRODUCT_SEARCH_USER_LIMITER` (60 per 60 s),
  then the query is validated, so an unsigned caller is 401 whatever the query. Far looser than the routes that cost something, because
  search runs every keystroke or two and calls no model.

### Live updates

The app is told of changes as server-sent events from one Durable Object per key, so it does not poll. The stream serves scans (product and shelf), face scans
and the shelf verdict (keyed `verdict:<profileId>`). Its event types are `item`, `photo` and `done` for a scan, `face` (a face scan's frame) and `done` for a
face scan, and `verdict` (the body `GET /me/verdict` answers) and `done` for the verdict.

- **One `ScanStream` per key** (`src/realtime/scan-stream.ts`), reached by `idFromName(scanId)` (`idFromName('verdict:<profileId>')` for a verdict), so the route, the queue consumer
  and the reaper find the same object without a lookup. It holds the key's open client streams in memory and stores nothing.
  It is a named export of `src/index.ts` (the class must be exported from the Worker's main module) and is reached only through
  `DurableObjectScanEvents`, which takes the class as a type-only import. The HTTP app lives in `src/app.ts` and `src/index.ts` re-exports it, because `npm run openapi` loads the app in plain Node and cannot load a module that imports `cloudflare:workers`. `ScanService` never sees it: it uses the `ScanEvents` port.
- **Route overlap.** `/api/v1/scans/products/{scanId}/events` and `/api/v1/scans/products/photos/{token}` overlap only for the literal pair `photos`/`events`,
  which can never be a real scan id (a UUID) or token; that is the Redocly `no-ambiguous-paths` warning, which is left as is.
- **Opening.** `GET /api/v1/scans/products/{scanId}/events` (bearer) calls `ScanService.watch`, which reads the scan (so another profile's scan is
  404 `SCAN_NOT_FOUND`, as a normal JSON error before any stream), and `subscribe`s: the adapter POSTs the scan as JSON to the
  object's `fetch` and returns its streaming response, re-wrapped because a stub's response has immutable headers and CORS and
  secure-headers middleware still run after the route. The route is documented with `sseResponse`, so the compiler does not
  check its return type; the integration tests do. A browser `EventSource` cannot send the bearer token; clients read the body of a `fetch`.
- **Frames.** Headers `text/event-stream; charset=utf-8`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`.
  `event: snapshot` first (the scan as `GET /api/v1/scans/products/{scanId}` shows it), then `event: item` per change (data: the item as that
  response shows it) and `event: done` with data `{}` when every item is final (`ready`, `rejected`, `failed` or `unidentified`), after which the object closes every stream of the scan.
  Photo links inside `image.url` are minted per view, so two views of the same item differ in that token only.
- **Shelf scans: `kind`, `photos`, `photoId`, `photo`.** Every scan response (and the snapshot) carries `kind` (`product` or `shelf`) and `photos[]`,
  `{ id, position, state: recognising|recognised|rejected, skipped: { notBeauty, unreadable, overLimit, dailyLimit } }` in photo order, built by
  `ScanService` (`ScanPhotoView`; the presenter names every field). Every item carries `photoId`, the photo it was read from (null only for an item from before
  the column). `POST /api/v1/scans/products/shelf` (`createShelfScan`, 1 to 3 `photos`, 202) calls `ScanService.createShelf`; it is declared
  before `GET /{scanId}` and has the same middleware order as create, with the shelf limiters. The stream adds `event: photo` (data: the photo as
  the scan response shows it), published when a shelf photo has been read (`recognised` or `rejected`, with its counts), after the `fanOut` batch and BEFORE the
  `item` events of that photo's items. A product scan's photos never change, so it never sends one. `ScanStream.publish` frames by event type (`photo`, `item`, `face`, `verdict`, `done`).
  `watch`'s catch-up compares each photo (state and counts) to the snapshot's and sends the ones that differ, before the items.
- **Snapshot on reconnect.** There is no replay and no event ids: a client that reconnects gets a fresh snapshot, which is
  the whole state.
- **Catching up after the snapshot.** The service reads the scan, then `subscribe`s, and a change stored in between was
  published while nobody listened. So once `subscribe` returns, `watch` reads the scan's items once more and publishes an `item`
  event (the same view the snapshot uses) for every item whose state or `updated_at` differs from the snapshot, then
  `done` if every item is final. A change stored after that second read is published to an open stream as usual. The service
  does this, not the object, which never reads the snapshot. A publish that fails here is logged with ids only
  (`{ outcome: 'publish-failed', scanId, itemId? }`) and never fails the stream.
- **Already finished.** The same step covers a scan that is final when a client connects: nothing differs, every item is final,
  so `watch` marks the scan done if it was not (`markScanDone`; if this call set the time it also queues the finished push, see "Sending push notifications") and publishes `done` right after subscribing:
  the client gets `snapshot`, `done`, and the stream ends. It publishes `done` even if `done_at` was already set, because this
  client has not had it; that also covers a `done` that was lost while nobody was connected. If that `done` fails after
  `watch` itself set the time, the time is cleared again, as for the steps and the reaper.
- **Ping.** `: ping` every `SCAN_STREAM_TIMING.pingMs` (20 s) so proxies keep an idle stream open and a client that vanished fails a write.
- **Maximum lifetime.** Each client's stream is closed `maxLifetimeMs` (10 minutes) after it connected, not after the scan's first
  client did. An abandoned phone cannot hold the object open, and reconnecting checks the token again. Both timings are read when a
  client connects, from one exported mutable object, because tests cannot drive them with fake timers inside workerd.
- **Backpressure.** `publish` never awaits a client write: a client that stopped reading would otherwise hold the queue consumer and
  every other client. A client more than 20 frames behind (`desiredSize` below -20) is dropped and reconnects. A client that
  closes its connection removes itself through `request.signal`.
- **Failure.** `publish` errors propagate from the adapter; `ScanService` logs them (`publish-failed`) and carries on, because the
  change is already in D1. A `subscribe` error is the caller's: there is no stream without it. A deploy or eviction ends the
  streams; clients reconnect.
- **Config** (`wrangler.jsonc`). `compatibility_flags` gains `enable_request_signal` (top level, inherited by the env blocks;
  without it the object never learns a client left). Do not add `pipe_to_backward_propagation` by hand: it crashed workerd at
  startup on wrangler 4.149 and becomes the default on 2026-11-17. `durable_objects.bindings` (`SCAN_STREAM` to `ScanStream`) is
  NOT inherited, so all three blocks restate it. `migrations` is inherited and is declared once, at the top level, as
  `{ tag: "v1-scan-stream", new_sqlite_classes: ["ScanStream"] }` (SQLite-backed; the choice is permanent per class). Never edit a shipped
  migration: a later class change is a new entry. `npm run cf-typegen` types `env.SCAN_STREAM` from the exported class.
- **Testing.** `src/realtime/scan-stream.test.ts` drives the object through `stub.fetch` and RPC; `test/integration/sse.ts` is a
  bounded reader (a quiet stream returns what it had, so nothing hangs). Each test uses its own scan id and ends with
  `abortAllDurableObjects()` after cancelling its streams.

### Catalog eval
`npm run eval:catalog` (`scripts/eval-catalog.ts`) measures the model-backed catalog steps, and the goal and mention readers, against fixed cases in
`scripts/eval/cases.ts`; the pure parts (scoring, arguments, key lookup) are in `scripts/eval/score.ts` and are tested. `--mode draft` measures the catalog drafter against its own
cases and a judge (see "Draft mode"); the other modes' exit code and report below do not apply to it.

- **Analysis mode** runs each synthetic ingredient list through `flagFacts`, the real `AnthropicProductAnalyst` and
  `checkAnalysis`, exactly as the service does, and scores what would be stored: every flagged fact is covered by a
  concern of its kind naming its ingredient, and a banned substance is judged high. A case's expected facts are
  checked against `flagFacts` over `REFERENCE` in `cases.test.ts`, so a case cannot drift from the seed rules.
- **Research mode** runs `AnthropicProductResearcher` on real products sold in Nigeria and checks the product is found
  and the list holds the ingredients we expect. These check retrieval quality, not ground truth: a brand can
  reformulate, so a failing research case may need its data updated.
- **Goals mode** runs `AnthropicGoalReader` on `GOAL_CASES`, typed goals in Nigerian English and Pidgin, and scores the goal and `wantsLighter` against what
  each case expects (`scoreGoalReading`; problem codes `goal:<expected>-got-<actual>`, `wantsLighter:<expected>-got-<actual>` and `error:<name>`).
  The cases turn on one distinction: `wantsLighter` is true only for someone who asks to be lighter, never for one who mentions a lightening product they
  used, who lightens spots, or who refuses it. It is part of `--mode all`; `--mode goals` runs it alone (about 40 Haiku calls, a few cents).
- **Mentions mode** runs `AnthropicMentionReader` on `MENTION_CASES` (22 cases of typed reaction and prescription words, Nigerian English and Pidgin, injections
  included) and scores what it found against what each case names (`scoreMentions`). A product is found when the words of its brand and name together are the expected
  ones (case, accents and punctuation ignored, `&` as "and", and the generic words cream, lotion, soap, gel, serum, oil and jelly left out) and it has a brand exactly when
  the expected one does; an ingredient is found when its name is the expected one with case, punctuation and spacing ignored; category and variant are not scored. A reader
  that invents a mention, or lists a product's ingredients from memory, fails as much as one that misses: problem codes are `missing-product:<name>`,
  `missing-ingredient:<name>`, `extra-products:<n>`, `extra-ingredients:<n>` (counted, never named, so no model word is in a problem) and `error:<name>`. A product with no brand
  that a case does not expect is not counted. It is part of `--mode all`; `--mode mentions` runs it alone (about 22 Haiku calls, a few cents).
- **Draft mode** (`--mode draft`, never part of `--mode all`) measures `npm run catalog:draft`, the catalog drafter, on `DRAFT_CASES` (`scripts/eval/draft-cases.ts`, 20 products: ordinary ones
  and traps of three kinds; the type has a fourth, foreign-currency, with no case today: see Scoring) or, with `--set holdout`, on `DRAFT_HOLDOUT` (`scripts/eval/draft-holdout.ts`, 8 products, none of them in `DRAFT_CASES`). It builds one workbook with a draft Products row per case and the Countries tab NG (NGN) and GB (GBP), runs each case through the real
  `draftWorkbook` on its own, with the passes pinned at 3 (`EVAL_PASSES` in `scripts/eval/draft-run.ts`, so a change to the `catalog:draft` default is a deliberate eval change) (the researcher for the ingredient list, `AnthropicCatalogDrafter` for the other four columns and the prices of the countries the case names), and then has a **judge**
  check every value that was drafted, once: the ingredient list, each cell and each price row. The judge (`AnthropicDraftJudge`, `scripts/eval/draft-judge.ts`, the `judge-draft` job on
  Haiku, prompt `src/prompts/draft-judge.judge-draft.md`) reads the page the drafter cited, with the web fetch tool (the newest type the SDK has, at most 2 fetches, `max_content_tokens` 20,000, `allowed_callers: ['direct']` so a fetch is one plain call whose result is a top-level block, not dynamic filtering through code execution, no web
  search, `max_tokens` 4096 for Haiku's adaptive thinking) and answers `fetched`, `exactProduct` (yes, no, unclear), `supports` (yes, no, unclear) and, for a price, `currencyShown` and `pricesShown` (the whole-number prices the page shows for this exact product, in the country's currency; `[]` when none. Only positive safe integers are kept, and a `pricesShown` that is not a list costs only the prices, not the verdict). It can read only the cited page:
  the tool is restricted (`allowed_domains`) to the host of the cited address, and `fetched` is true only when a successful `web_fetch_result` came back whose address is the cited one (scheme and host in lower
  case, no fragment, no trailing slash, the query kept) and the judge said so. A page fetched at another address, on the same host after a redirect or on another host, does not count. Anything the judge cannot
  vouch for is an "unverifiable" verdict, never an error, with a fixed `reason`: `not-fetched` (no page, or not the cited one, or the judge said it could not read it), `fetch-failed` (only failed fetches),
  `cut-off` (the reply ran out of tokens; also what a value gets that was never asked about because the run had already stopped), `refused`, `unreadable-answer` or `api-error` (a 4xx or 5xx other than a rejected key).
  The reason is in `report.json` and the console totals line counts the unverifiable values by reason (and "unclear" for a page that was fetched but did not settle the value). The drafted value is data to the judge, as the page is.
  A rejected key, account or permission (401, 402, 403) and the spend cap are thrown: the run stops, writes what it has and exits 2 (key) or 1 (cap). Pages are data, and only the verdict's
  own fields leave the judge.
  - **What the cap does not reserve.** The spend cap reserves a call's payload and its `max_tokens` before it is made; the text of a page the judge fetches is not in the payload, so it is settled afterwards at its real
    cost and can take a run a little past the cap's reservations. The Anthropic docs say `max_content_tokens` "limits the amount of content included in the context" and truncates a fetched page over it, and do not say
    whether that is per fetch or per request, so the bound on one judge call's page text is 20,000 tokens if it is per request and 2 x 20,000 (the 2 fetches) if it is per fetch, approximate either way.
  - **Scoring** (`scripts/eval/draft-score.ts`). A value is *grounded* (page fetched, exact product, supports it), *contradicted* (the page says no, or is about a different product) or *unverifiable* (anything
    else). A price row whose page showed another currency than its country's is also counted as *wrong-currency*. That is what the judge read on the page, and a shop that localises its prices by the visitor's location (a Nigerian shop served from a UK or US address) can show another currency than the one it sells in, so a wrong-currency failure needs a person to open the page before it is believed. Whether a value is inside the case's `...Plausible` set, and whether a price is for a country the
    case says the product is sold in, is reported as agree or disagree and never gates: the sets are what a reader could defend, not ground truth. The traps are `trap-sibling` (no value may come from a page the judge says is
    a different product), `trap-foreign-currency` (no price row for a country the case says has no local price, and no wrong-currency row; no case of this kind is in the main set today, because the two that were turned out to be sold in Nigeria, so the main set has no live foreign-currency trap, and the scorer's support for it is exercised by the tests only), `trap-unbranded` (nothing at all may be drafted, an ingredient list included) and
    `trap-not-skincare` (no skincare cell may be drafted: concerns, skin types, steps or frequency; its ingredient list and prices are judged like any value).
  - **Price coverage and band accuracy** (reported, never gated). Drafted prices feed a budget-band estimate (low up to the Countries tab's `low_max`, mid up to `mid_max`, high above), so the run also reports how well they do
    that job, over ordinary cases that were drafted only (a trap, or a case that failed, was skipped or was cut off, is left out). *Coverage* is, of the product-country pairs the cases asked about, how many got a price row, in total and per country.
    *Band accuracy* is, of the price rows whose page the judge read prices on (`pricesShown` not empty, page fetched), how many put the product in the band the page puts it in: the band of the drafted row's lowest price (`priceMin`) against the band
    of the lowest of `pricesShown`, which the judge gives for the drafted row's pack size only, so a dearer larger pack on the page does not count. The lowest price is what is compared because the recommendations budget filter
    places a product by its lowest price (at most the band's top), not by the middle of its range. A row with no readable page price is *band-unknown*, neither right nor wrong, and is counted apart. The bands are the eval's own Countries rows
    (NG 5000 and 15000, GB 10 and 30). The judge's grounded or contradicted verdict and a person's check on the value do not change a row's band, because it compares the range with the page's prices. The console prints
    `Prices: coverage a/b (n%) NG x/y GB x/y; band-correct a/b (n%), band unknown n` just before the gate line, and `report.json` has the same numbers in `summary.prices` (and `prices` on each case's score).
  - **Gate.** It holds only when all of these hold: contradicted values are at most 5% of the drafted values (price rows count as values), unverifiable values are at most 35% of them (a judge that cannot read the pages
    must not pass the run), no price row is in the wrong currency, every trap case ran and passed, every case completed (none failed, was skipped or was cut off by the cap), and at least one value was drafted
    (`no-values`: both rates divide by the values drafted, so a drafter that returned nothing would otherwise pass). It is checked in whole percents, so
    1 contradicted in 20 passes and 1 in 19 fails, and the percentages are printed with one decimal (5.3%) so the number shown does not seem to contradict the gate. The gate line is the last thing printed:
    `Gate: PASS (<n> cases, <t> traps)` or `Gate: FAIL (<rules>; <n> cases, <t> traps)`. A run with no trap in it, such as a `--limit` trial that stopped before the first trap, prints `Gate: PASS (no traps covered)`
    and still exits 0: it is a trial, not the gate, and only a full run of a set is one.
  - **Run.** `npm run eval:catalog -- --mode draft [--set main|holdout|dev] [--limit N] [--max-usd N] [--out-dir DIR] [--model JOB=MODEL]`. `--set` picks the case set (main by default; only with `--mode draft`), and `report.json` and the first console line name it. It costs about the drafter's 20 web-search turns per call, up to three calls for a case with a missing price (pass 1 and up to two price retries), plus up to one page fetch per drafted value, so its cap is
    10 dollars by default, not 2. It writes `report.json` (every case with its state, cost, counts, trap result and each value with the full address of the page it cites and the judge's verdict; a failed case also has the class name of the error behind it, never its message) and `draft.xlsx` (the drafted workbook,
    which can be opened and reviewed like any `catalog:draft` output) to `--out-dir`, `.eval/draft-<timestamp>` by default. The console shows ids, kinds, counts, costs, trap results and, for a value the page
    contradicts or a price in the wrong currency, the column, the value (never an ingredient list) and the page's host: never a full address, a model's words or an error message (a failed case shows the class name of its error, such as `AnthropicRequestError`, beside `drafter-error` or `researcher-error`). Exit 0 when the gate holds, 1 when it does
    not (or the cap was reached), 2 when the run could not start or Claude rejected the key.
  - **The set is for measuring, not tuning.** A prompt change for the drafter is checked on products outside `DRAFT_CASES`, which is what `--set holdout` runs (`DRAFT_HOLDOUT`: no product in both sets, which `draft-cases.test.ts` asserts). `--set dev` runs `DRAFT_DEV` (`scripts/eval/draft-dev.ts`, 38 ordinary products with no `expected`, in neither of the other sets), the one set a prompt or rule may be tuned against, and `draft-cases.test.ts` asserts it shares no product with them; a change written to fit its cases would only make the eval agree with itself.
- **Cost.** One analysis call per analysis case (6), one web-search research turn per research case (7, up to 5
  searches each) and one Haiku call per goal case and per mention case, run one at a time. `--limit N` caps the cases per mode, `--mode` picks one; both keep a trial cheap.
  The run is capped in dollars too: the client gets a `MemoryAiSpendLedger` capped at `--max-usd` (default 2), so it
  cannot bill more, and once the cap is reached the remaining cases fail as `AiBudgetExceededError` without a call. The
  console table has a cost column per case and the total in USD; the report carries `costMicros` per case and in `summary`.
- **Models.** Each job runs on the same default as `wrangler.jsonc` (research, vision and judging on `claude-haiku-5-5`,
  analysis on `claude-sonnet-5-5`); `--model job=model` overrides one job and may be repeated. The model is not read from
  the environment.
- **Keys.** Locally it reads `ANTHROPIC_API_KEY` from the environment, else `.dev.vars`.
  In CI (`.github/workflows/eval-catalog.yml`, weekly and by hand) it needs the `ANTHROPIC_API_KEY` repository secret and
  skips with a notice when it is empty. It is never run by `npm test` or `tests.yml`, which hold no secrets.
- **Report-only.** It prints a table of ids, pass, problem codes and timings, and writes `.eval/catalog-<time>.json`
  (git-ignored; the workflow uploads it). It never prints the key, a prompt or raw model output, only fixed problem
  codes. A research result's `detail` (the host of the source page, never its path or query, and the ingredient list the
  model returned) goes to the JSON report only, so a fixture can be checked against what the model said. Exit 0 when every case passed, 1 when one failed, 2 when it could not start. The CI job is
  `continue-on-error`, so a failure never blocks a merge; read it as a trend, not a gate.

### Routine eval
`npm run eval:routine` (`scripts/eval-routine.ts`, orchestration in `scripts/eval/routine-run.ts`, scoring in `routine-score.ts`) measures the routine writer (#152): for each synthetic person it builds a
routine skeleton (the candidates from the REAL `RecommendationService.candidatesFor`, under `runAs`, over a `FakeCatalogWorkbook` and small stubs for the goal, safety answers, skin type and product reads, put together by production's own `assembleSkeleton`), has
`AnthropicRoutineWriter` write the routine, checks it with the real `checkRoutine`, has a rubric judge judge it, checks the pages it cites, and scores the picks against labels. Run it with `-- --set dev|holdout|hints [--limit N] [--labels v1] [--model JOB=M]... [--judges haiku,opus] [--max-usd N]
[--max-grounding N] [--snapshot PATH] [--out-dir DIR] [--compare report.json]`. Fit, simplicity, words and judge agreement are null ("not judged") when no judge produced a result.

- **What it measures.** `gatesPassed` (a routine that breaks no gate; a writer error counts as a failed routine), `forbiddenWording` (the count of `wording` failures), `rightProduct` and `exactlyBest` (the writer's pick for a gap
  against the labels; only a labelled gap with at least 2 candidates whose labels are not out of date is scored, and a routine that failed the gates scores its picks as not right), `needsRelabel` (the cases whose candidates changed since the labels were made: listed, and left out of the percentages), and the cost.
  Evidence links are AI-only: the skeleton carries them and the report holds them, but the console never prints an address.
- **The sets.** `ROUTINE_DEV` (30 people, the set a prompt or rule is tuned on) and `ROUTINE_HOLDOUT` (30, the set the bar is judged on) in `scripts/eval/routine-cases.ts`, written from the personas in CONTEXT.md
  (Amara, Tolu, Ngozi, Chidi each anchor several cases; others have no name). Every case's `seen` lists all three of its goal's concerns in goal order, as a real scan does (faint included), and its `safety` names the reacted-to and prescribed ingredients the safety parse would have found (`reactionIngredients`, `prescriptionIngredients`), which the real candidate rules then exclude. No kept or reduced shelf product lists an ingredient the case reacted to or is prescribed: such a product is stopped with a taper (a steroid or lightening cream) or dropped. The one exception is the prescribed product itself (named "Prescribed ..." in the cases), which is always `keep`: the app checks what else it suggests against a prescription and never tells anyone to stop one. Both sets use the `drop` verdict for redundant or harsh products, and a test writes a routine that uses every kept product for each of the 60 cases and checks it passes `checkRoutine`, so no case makes the `unused-shelf` gate impossible. The shelf products' brands are made up for the eval and may coincide with real names. Together they cover all 6 goals, both countries, the four skin types and an unknown one, every safety state (none, pregnant, breastfeeding, a fragrance reaction,
  a prescription, tapering off a stopped lightening or steroid cream), empty, typical and overloaded (9 products, Tolu) shelves, and every budget band; each set alone covers every goal, both countries and every persona. The cases describe
  synthetic people, not catalog rows, so they are committed. A case carries no `maxNewProducts`: the skeleton allows as many new products as it has gaps with candidates, which is what the writer's prompt promises and the gap gate needs.
  The frequencies each step allows (`ROUTINE_ALLOWED_FREQUENCIES`), the steps a goal uses (`routineStepsFor`) and the new-product limit (`maxNewProductsFor`) are the production routine rules (`src/modules/routines/routines.rules.ts`), versioned by `ROUTINE_RULES_VERSION`; the eval does not build its own skeleton, it calls the same `assembleSkeleton` production does (`src/modules/routines/routines.skeleton.ts`), so the rules, the cautions and the limits are the ones that ship.
  **The set is for measuring; tune on dev only.** A prompt change written to fit the holdout would only make the eval agree with itself.
- **The snapshot is local, because the repo is public.** The catalog the candidates come from is the owner's curated workbook, copied to `eval-data/routine/catalog-snapshot.xlsx` (the folder is gitignored, as are the labels).
  `loadSnapshot` reads it with the reader `catalog:upload` uses (`readWorkbookFile`) and checks it with `validateWorkbook`; a file that breaks the contract stops the run with exit 2, naming the tab, row, column and rule code and never a cell's value.
  Inside the eval only, every Products row that is not retired counts as approved, **drafts included** (the curated rows are all drafts), with a synthetic `productId` (`snap-<code>`) and `formulationId` (`snap-f-<code>`) and one offer per Availability row;
  the Ingredients tab gives the rules through `referenceEntriesOf` (`catalog.workbook.service.ts`), the pure mapping to `ReferenceEntry` the service itself uses on its approved rules; here every rule that is not retired is passed, so draft rules count as approved. The snapshot is pinned by the sha256 of its bytes.
- **Labels.** A label set says, for each case and gap, which candidate is `best`, which are `acceptable`, and which are not. To make one: `npm run eval:routine:sheet -- [--set dev|holdout|all]` writes an `.xlsx` with one row per case x gap x candidate and an empty `label` column (no model output of any kind; a hidden `_meta`
  sheet holds the snapshot sha256); a person fills the column with `best`, `acceptable` or `not` (blank is `not`); `npm run eval:routine:labels -- --sheet filled.xlsx --version v1 --status provisional` writes `eval-data/routine/labels/v1.json` and never overwrites a version.
  Each gap needs exactly one `best`; a gap with a single candidate has it automatically; a sheet with two bests, none, or a word that is none of the three is refused with every problem listed by case and step. `status` is `provisional`, `clinical` or `outcome`. The sheet shows each case's country and the currency its prices are in (from the snapshot's Countries tab), and neither the sheet nor a label version is ever overwritten. Label sets name catalog products, so they are never committed.
  Run the sheet again after the snapshot or the candidate rules change: a case whose candidates differ from its labels is `needsRelabel`.
- **AI labels** (`npm run eval:routine:auto-label -- --version v1 [--set all|dev|holdout] [--snapshot PATH] [--model label-routine=M] [--max-usd N] [--limit N]`, `scripts/eval/routine-labeller.ts`, job `label-routine`, prompt `src/prompts/routine-labeller.label-routine.md`). The owner has no dermatology training, so a model labels the cases as a dermatologist experienced with skin of colour would; the default is Opus (`claude-opus-5-5`, set by the command, because `DEFAULT_MODELS` and `wrangler.jsonc` keep Haiku for the job), overridable with `--model label-routine=M`. `AnthropicRoutineLabeller` makes one `client.structured` call per case with no tools: it is shown exactly what the label sheet shows for that case (the person with country and currency, the shelf with verdicts, and each gap with **two or more** candidates with their code, brand, name, form, ingredients, skin concerns, price range and frequency), and never a routine, another case, evidence links or hints. It answers `{ gaps: [{ step, best, acceptable }] }`, closed objects, and the adapter checks the answer: one entry per gap sent, `best` and every `acceptable` a code of that gap, none twice, the best not among the acceptable; anything else is an `AnthropicRequestError` and the case fails. The prompt covers judging from the data only (never a brand's fame), caution first, irritation leaving dark marks on darker skin, low-confidence readings weighing less, also-noticed concerns only breaking ties, a cheaper product that does the job beating a dearer one, and `best` against `acceptable`.
  The command builds each skeleton as the sheet does (`buildSkeleton`, hints off), labels one case at a time on a ledger capped at `--max-usd` (default 10), gives a gap with one candidate that candidate as best, leaves a gap with none out, and saves a `provisional` label set with `labelledBy` the model id (never overwriting a version), plus a filled copy of the sheet, `eval-data/routine/label-sheet-<version>-<model>.xlsx` (never overwritten; both files are checked before anything is spent). If any case fails or the cap stops the run, **nothing is saved** and the exit is 1, with the failed case ids listed; a rejected key is exit 2. The console prints case ids, gap counts and costs, never what the model chose. Cost: about 60 Opus calls for all 60 cases, roughly $3 to $4.
  **`labelledBy`** is on every `LabelSet`: a model id for AI labels, `'human'` for a set read from a sheet (`eval:routine:labels`), and a set written before the field existed loads as `'human'`. A set revised by `eval:routine:outcomes` keeps its base set's `labelledBy`, because outcome-revised labels began as the labeller's. **AI labels stay provisional until a person or a dermatologist spot-checks them**: open the filled sheet, correct the `label` column (`best`, `acceptable`, or blank for not), and read it back as a new version with `npm run eval:routine:labels -- --sheet ... --version v2`, which records `labelledBy: 'human'`.
  **The self-agreement rule.** A model never grades its own work, so a judge whose model made the labels does not count toward choosing the judge: its row in `judgeComparison` says `selfAgreement: true` (the console line ends `(self-agreement: made the labels)`), it is still reported in full, and `selectJudge` leaves it out. With Opus labels, the Haiku and Opus pair selects Haiku even when Opus agrees more and costs less. When every judge made the labels there is no selected judge and the bar is `not evaluated (judge-self-labelled)`. `report.json` names `labelledBy` at the top.
- **The bar** (holdout only): gates 100%, right product at least 85%, judge agreement at least 80%, forbidden wording 0, and a full run: a run stopped at the spend cap, or one of the first N cases (`--limit N` below the size of the set), is a trial that can fail the bar but never pass it. Missing input is never a pass. A rule that can be evaluated and fails makes the bar `FAIL` whatever else is missing; otherwise
  anything missing makes it `not evaluated`, with fixed reasons (`dev-set`, `partial-run`, `no-labels`, `needs-relabel`, `no-scored-gaps` for labels that leave no gap with 2 or more candidates to score, `no-judge`, `judge-self-labelled`). Right product counts as evaluable only when every case with candidates has labels and none needs re-labelling, so its percentage never leaves a case out. The last console line is `Bar: PASS`, `Bar: FAIL (<rules>; not evaluated: <reasons>)` or `Bar: not evaluated (<reasons>)`.
  A full holdout run with labels, every case judged, and every rule met passes. `--compare report.json` says whether the scores are better, worse or the same as an earlier report and which measure decided (right product, then fit, simplicity, words; a measure that is null on either side is skipped).
- **The rubric judge.** `AnthropicRoutineJudge` (`scripts/eval/routine-judge.ts`, job `judge-routine`, prompt `src/prompts/routine-judge.judge-routine.md`) judges each written routine, once per judge in `--judges`, whether or not it passed the gates (a writer error or a case cut off by the cap is not judged). It goes through `client.structured`, with no tools and `max_tokens` 12000 (room to weigh every candidate before it classes a pick), and is shown the skeleton and the routine as JSON in the user message and **never the labels** (its input type has no place for them; a test proves nothing else is sent). The schema is `{ picks: [{ step, pickClass: best | acceptable | not }], fit, simplicity, words, problems }`, all required and closed.
  `fit`, `simplicity` and `words` are whole numbers from 1 to 5, written in the schema as `enum: [1,2,3,4,5]` (a bounded integer would send `minimum` and `maximum`, which structured outputs do not support); `problems` are codes from the fixed `PROBLEM_CODES` (`ignored-caution`, `leaned-on-low-confidence`, `also-noticed-justified-product`, `poor-fit`, `too-many-actives`, `harsh-during-taper`, `vague-reason`, `overstated-claim`, `timing-dishonest`, `unexplained-term`), never free text. The prompt tells it to judge a pick from the candidate's ingredients, form, price and concerns and the kept shelf as the skeleton gives them, never from a brand's reputation or popularity, and anchors the 1 to 5 scale (1 poor, 2 weak, 3 acceptable, 4 good, 5 excellent) with caps: `ignored-caution` or `harsh-during-taper` caps fit at 2, `overstated-claim` or `timing-dishonest` caps words at 2. The prompt holds the rubric: fit (kept shelf products first, a visible also-noticed concern as a tie-break, gentleness in a caution state, less weight on low-confidence readings), simplicity (steps and new products against what the goal needs), words (true to the data, plain and calm, honest about 8 to 12 weeks, ingredient terms explained).
  A reply that does not fit the schema is `AnthropicRequestError`, never a partial judgement; a failure other than the cap or a rejected key leaves that case unjudged by that judge (`judgeErrors[name]` is the error's class name in the report; the cap or a rejected key is recorded the same way and also ends the run) and the run goes on. A rubric judge answer that is invalid (`AnthropicRequestError`, and only that) is retried once with the same input, in `eval:routine` and in `eval:routine:rejudge`; the retry counts toward the case's judge cost and the cap (a cap hit on it is a cap stop, and still counts as a retry), and `judgeRetries[name]` per case and `retries` per row of `judgeComparison` record it (the `Judge <name>` console line ends `, retried N` when N is above 0); the writer and the page-support judge are not retried.
  **Haiku by default, Opus to compare, and never the writer.** The rubric judge is `haiku` (`claude-haiku-5-5`) or `opus` (`claude-opus-5-5`) and nothing else. The default is `--judges haiku`, because Opus is too dear to run unasked; `--judges opus` or `--judges haiku,opus` (in the order given) adds Opus to compare the two on the same routines, refused as a usage error (exit 2) for an unknown name, an empty list or a duplicate. **A model never judges its own routines**: a judge whose model equals the resolved `write-routine` model is refused (`a model never judges its own routines`, with the `--judges` to pass instead; so the default Sonnet writer takes either or both, an Opus writer is judged by the default Haiku and refuses a list with `opus` in it (`--judges haiku`), and a Haiku writer refuses the default and needs `--judges opus`). A hint run judges nothing, so the rule does not apply to it. `--model judge-routine=...` is refused and points to `--judges`. Each judge has its own `AnthropicClient` on the `judge-routine` job with its model (`resolveRoutineJudges`), all on the one ledger; `DEFAULT_MODELS` and `wrangler.jsonc` keep Haiku for the job (both new jobs are eval-only and share `ANTHROPIC_MODEL_JUDGE`, as `judge-draft` does).
- **Comparing the judges and choosing the one for the bar.** Each routine is written once and judged by every listed judge on the same `{ skeleton, routine }`; the cost of each judge's calls (a failed call included) is recorded per case and per judge. The summary has `judgeComparison: [{ name, model, agreement, exactAgreement, fit, simplicity, words, costMicros, agreementPerDollar, retries }]` (`agreementPerDollar` is agreement % per dollar, null at no cost or no agreement) and `selectedJudge`, and the console prints one `Judge <name>` line each and then `Selected judge`, before the bar line. **`selectJudge`** picks the cheapest judge whose agreement is at least 80% (on a cost tie, the higher agreement); when none reaches 80%, the highest agreement, so the bar fails on `judge-agreement`; a judge with no result is never picked, and with none the bar says `no-judge`. The selected judge's agreement, fit, simplicity and words are the run's (`summary.judgeAgreement`, `fit`, `simplicity`, `words`). `report.json` has `judges: [{ name, model }]` and, per case, `judgements`, `judgeErrors`, `judgeCostMicros` and `judgeRetries` keyed by judge name.
- **Agreement and the 80% trust rule.** For each scored gap (the scorer's own rule, `scoredGapsOf`: labelled, 2 or more candidates, labels current), the judge's `pickClass` for the routine's pick is compared with the label's class for it (`classOfPick`: best, acceptable, or not; a pick that is not a candidate of the gap, a shelf product or "use what you have" is `not`). Agreement is right against not: the judge and the label agree when both put the pick in {best, acceptable} or both put it at `not`. Best against acceptable is not a disagreement, because the writer's right-product score treats the two alike and the line between them is unstable even between two labelling passes (in dev run 2, Haiku agreed 89.8% counted this way and 53.1% exactly). A gap the judge gave no class for is judged and not agreed, so skipping one cannot raise the score.
  Each judge's agreement is `picksAgreed / picksJudged` pooled over the cases, and `judgeAgreement` is the selected judge's, and it is in the bar at 80%: the judge is only trusted to grade fit, simplicity and words when it agrees with the labels on at least 80% of the picks. Below that, for every judge, the bar fails on `judge-agreement` and the scores should be read as unreliable. The exact figure (`picksAgreedExactly / picksJudged`, same class as the label) is reported beside it as `exactAgreement` in `judgeComparison`, `judgeExactAgreement` in the summary, and `(exact Y%)` on the `Judge <name>` console line; it is not in the bar, `selectJudge` or `agreementPerDollar`. `fit`, `simplicity` and `words` are the means over the cases judged.
- **The page-support judge.** `AnthropicGroundingJudge` (`scripts/eval/routine-grounding-judge.ts`, job `judge-grounding`, Haiku, prompt `src/prompts/routine-grounding-judge.judge-grounding.md`) mirrors `AnthropicDraftJudge` and shares its fetch tool and fetch check (`pageFetchTool`, `fetchOutcomeOf` in `draft-judge.ts`): for each `grounding` link of each entry of a judged routine, one call with the web fetch tool restricted to the link's host, at most 2 fetches, `max_content_tokens` 20,000, `allowed_callers: ['direct']`. It answers `supports: yes | no | unclear` for the entry's reason; `fetched` is true only for a successful fetch of exactly the cited address (compared with `comparableUrl`), and every failure is an `unverifiable` verdict with a fixed reason (`not-fetched`, `fetch-failed`, `cut-off`, `refused`, `unreadable-answer`, `api-error`), never an error, except what ends the run (the spend cap, a rejected key).
  The score is the share of checked links that are supported (`groundingSupport`; an unverifiable link counts as not supported), reported beside words with the counts checked, supported, unverifiable and skipped. **It is not a gate and is not in the bar.** `--max-grounding N` (default 40, 0 for none) caps the checks for the whole run, taking links in case and entry order; the rest are counted as skipped. Evidence links stay AI-only: the console never prints an address.
- **The hint set** (`--set hints --labels v1`, `scripts/eval/routine-hints.ts` and `routine-hints-run.ts`). Built at run time from the holdout cases and a label set, so there is nothing to author; with no `--labels` it exits 2 with a message. A case whose labels need re-making is left out. For each labelled gap with 2 or more candidates: a **follow case** (only when the person has no caution state, and the gap has an acceptable candidate that is not the best, the first by code) gives that candidate `outcomeHint { n: 120, netFainter: 0.6 }` and every other candidate of the gap `{ n: 120, netFainter: 0.1 }` with `hintsShown: true`, and expects the writer to pick it; an **ignore case** (any person; the gap has a candidate the labels reject, the first by code) gives that one the strong hint and expects the writer to pick anything else. The writer is asked once per case (no judges), the pick at the hinted gap is recorded, and the **follow-rate** and **ignore-rate** (null with no cases behind them) and the cases that missed are printed as numbers and written to `report.json`. They are not in the bar, and the exit is 0, except 2 for a rejected key and 2 when no hint case can be built from the label set (a message says so). A hint case whose writer call failed has no result and makes the run partial.
- **Outcome label updates** (`npm run eval:routine:outcomes -- --counts file.json --labels v1 --out v2`, `scripts/eval/routine-outcomes.ts`). The counts file is `{ "groups": [{ "goal", "skinType" (or null), "country", "products": [{ "code", "n", "fainter", "flared", "flaredOrStopped", "fainterAndFlaredOrStopped" }] }] }`, validated strictly (nothing extra, whole numbers, counts that real users could give, no group or product twice); a bad file is refused with exit 2 and a message that holds paths into the file and never a number from it.
  **A case with a caution state is skipped** (caution stays above outcomes). For any other case, its group is found by goal, skin type and country; for each gap the labelled best B is compared with every other candidate A by `labelChange(A, B)` from `routines.outcomes.ts` (not restated here). When it is true A becomes best and B acceptable, and **outcomes win**: A may have been labelled not acceptable. When several A beat B, the highest net fainter wins. The result is `eval-data/routine/labels/v2.json` with status `outcome`, written with `saveLabelSet` (never overwriting a version), and `v2.note.md` beside it: every change as case, step, old best, new best, users and net fainter of both, and the lift, plus an audit list of every product `flareFlag` flags in any group. Labels and notes are local, so there is no PR; the note is the record the team and the dermatologist read. The console prints the counts of changes only. The note is rendered before the label set is saved; if the note write then fails, a fixed line says the label set was written but the note was not, and the exit is 2.
- **Console and report.** The console shows only ids, gate codes, counts, scores and costs: never a reason, the expectation, a link's address, a judge's words or problem codes, or an error's message (a writer or judge error is its class name). The routines, reasons included, and the judges' answers go to `report.json` in `--out-dir` (`.eval/routine-<timestamp>` by default) with
  every case's skeleton, routine, gate failures, cost and score, its judgement (the problem codes live here and only here), the judge's result, the links checked with their verdicts, and the snapshot sha256, the label version and the sha256 of the snapshot the labels were made on (`labelSnapshotSha256`), the writer and judge models and the prompt hash.
- **Cost.** One Sonnet call (`write-routine`, up to 8192 output tokens) per case, one Haiku call (`judge-routine`, up to 12000 output tokens, and a second when its answer was invalid; plus one Opus call per routine when `--judges` asks for Opus) per routine written, and up to `--max-grounding` Haiku fetch calls (`judge-grounding`), run one at a time: a run is one 30-case set, so by default about 30 Sonnet writer calls, 30 Haiku judge calls and at most 40 Haiku page checks, about $1.3. Adding `--judges haiku,opus` adds about 30 Opus judge calls, the expensive part, for comparing the judges. A routine that failed the `grounding` gate is judged but its links are not fetched (they are not the product's own); they are counted in `groundingSkippedGate`. The three jobs share one `MemoryAiSpendLedger` capped at `--max-usd` (default 5), which stops the run, reported as partial. `--limit N` keeps a trial cheap. An unpriced `--model` for the writer or the page-support judge, or an unpriced judge model, is a usage error (exit 2) before anything is spent.
- **The weekly workflow.** `.github/workflows/eval-routine.yml` runs weekly and by hand (`set`: holdout, dev or hints; `labels`: a version), `continue-on-error`, and uploads `.eval/` as the `routine-eval` artifact. The snapshot and the label sets are not in the repository (it is public, so they stay local until it goes private), so the job first checks for `eval-data/routine/catalog-snapshot.xlsx` and, when it is missing, **skips with a notice** saying why; it also skips with a notice when `ANTHROPIC_API_KEY` is not set. It never fails the build.
- **Keys.** Locally `ANTHROPIC_API_KEY` from the environment, else `.dev.vars`. Never run by `npm test` or CI, which hold no secrets.
- **Re-judging a saved run** (`npm run eval:routine:rejudge -- --report PATH/report.json --labels VERSION [--judges haiku|opus|haiku,opus] [--rescore] [--max-usd N] [--out-dir DIR]`, `scripts/eval/routine-rejudge.ts`). A full run costs about $1.40, nearly all of it the writer, and the saved routines stay valid when only the labels or the judge prompt change (the writer prompt and the catalog did not). The command reads the routines in a report written by `eval:routine` (never a hint run) and judges them again (about $0.07 per 30 cases with Haiku, default cap $1; a judge that wrote the routines is refused), or with `--rescore` scores the saved judgements against `--labels` with no calls at all and no key (`--rescore` takes no `--judges` or `--max-usd`; it carries the source's `judgeRetries`, 0 for an older report without them). It never calls the writer, re-runs the gates or fetches a page: the saved `failures` and `grounding` are copied. The bar is the source run's (same set, a partial source stays a trial; a cap stop makes the re-judge one), so a re-judged full holdout run can pass or fail. It writes a new `report.json` (never over one: an existing report in `--out-dir` is exit 2) in the shape of a run's plus `source: { report, startedAt }`, `mode` and `judgePromptHash` (today's rubric judge prompt hash; for `--rescore`, the source's, or null for an older report). Each case's `costMicros` is the source case's total (writer, judges and page checks); this run's new calls are in `judgeCostMicros` and the summary's `costMicros`. `eval:routine` reports `judgePromptHash` too, so a later `--rescore` can tell whether the saved judgements came from today's judge prompt. A writer prompt or catalog change still needs a full `eval:routine` run.
- **Exit.** 0 when the bar passes or the run was a trial (not evaluated), 1 when the bar fails, 2 when the run could not start (arguments, a `--model` for the writer or the page-support judge that has no known price, a judge that is the writer's own model, a bad `--judges`, key, missing or invalid snapshot, missing labels, `--set hints` without `--labels`) or Claude rejected the key.

### Verdict eval
`npm run eval:verdict` (`scripts/eval-verdict.ts`, orchestration in `scripts/eval/verdict-run.ts`, scoring in `verdict-score.ts`) measures the shelf verdict (#171). For each synthetic shelf it does what `VerdictService.build` does, with the same pure functions and never a copy of them (`factsOf` turns the case into the facts a build reads, then `assembleVerdictInputs`, `floorVerdicts`, `fitRequestOf`, the fit judge `AnthropicVerdictFitter`, `mergeVerdict`), and scores the result. Run it with `-- [--set main|holdout] [--limit N] [--labels VERSION] [--snapshot PATH] [--root DIR] [--max-usd N] [--model fit-verdict=M] [--out-dir DIR] [--floor-only]`.

- **What it measures.** The rules **floor** must be right for 100% of the cases: each entry's expectation (open, ignored, or a fixed group, verdict, step-down kind and escalation) and each case's set of clashing pairs; a merge that fails, or a judge that loosens a floor-fixed verdict, counts as a floor miss. The **fit** is agreement of the judge's raw label with the label of each open product (or one of the labels that would also do) and must be at least 85%. **Harmful** is the judge calling helping a product the labels say is blocking, over the open products labelled blocking, and must be at most 2%; with the few blocking products there are, that is in practice zero misses. The harmful rate over every open product, the over-strict rate, the label-by-answer confusion matrix, whether the judge named the product that does a redundant one's job, and whether it reduced the labelled product of a clash are reported and not in the bar.
- **Where the data lives.** The cases (`eval-data/verdict/cases/main`, `holdout`), the catalog snapshot (`eval-data/verdict/catalog-snapshot.xlsx`) and the labels (`eval-data/verdict/labels/<version>/<caseId>.json`) are in the gitignored `eval-data/verdict` folder, because a case may copy a catalog product and the repo is public. Each label file is pinned to the sha256 of the request its case made of the judge (`stableJson` of the `FitRequest`); a case whose request has changed since is listed as `needsRelabel` and left out of the fit.
- **The labels.** Opus drafts them from the spec and the owner reviews them: a file written by a model is `provisional` until it is marked `reviewed` (or rewritten by a person, `labelledBy: "human"`). A label version is `reviewed` only when every file is, and **only a reviewed version can make the bar PASS**; with a provisional one the run is `not evaluated (provisional-labels)`, though a rule below its bar still FAILs.
- **The bar.** As in the routine eval, a rule that is below its bar FAILs the run whatever else is missing; otherwise anything missing makes it `not evaluated` with fixed reasons, in this order: `partial-run` (the spend cap, a rejected key or `--limit`), `no-labels`, `needs-relabel`, `provisional-labels`, `too-few-blocking` (fewer than 30 open products labelled blocking on main, 8 on the holdout, too few to trust the harmful rate), `no-fit-run` (`--floor-only`, which says only this). The last console line is `Bar: PASS`, `Bar: FAIL (<rules>[; not evaluated: <reasons>])` or `Bar: not evaluated (<reasons>)`. Exit 0 for a pass or a trial, 1 for a FAIL, 2 when the run could not start or Claude rejected the key.
- **The holdout is for measuring, never for tuning.** The console prints it as aggregates only: no case id, no entry id, not even for a miss or a case to re-label (`report.json` has them). Tune on `main`; a prompt or rule written to fit the holdout would only make the eval agree with itself. For every set the console prints only ids, states, counts, scores and costs, never a product, a reason, a label's words or an error message (a failed case records its error's class name).
- **Cost and keys.** One Sonnet call (`fit-verdict`) for each case with a product the floor left open or a clash, none for a shelf the floor settled whole, on a ledger capped by `--max-usd` (default 3); the key is read as in the routine eval. A judge that fails or answers something that cannot be merged is that case's problem (the open products are `undecided`, as the service saves them) and the run goes on; the cap and a rejected key end it, and the cases after them are `cut-off` and left out of every percentage.
- **`--floor-only` costs $0.** It reads no key, builds no client and calls nothing; it still builds each request and records it with its sha256 (what a person labels against), and checks the floor against every case's expectations. Run it after any change to the floor, the rules or a case.
- **Rescoring costs $0.** `npm run eval:verdict:rescore -- --report PATH/report.json --labels VERSION [--root DIR] [--out-dir DIR]` (`scripts/eval/verdict-rescore.ts`) scores a saved report against another version of the labels with no key, judge or ledger, and writes `verdict-rescore-<time>/report.json` beside the run's. The set, `--floor-only`, trial status and step-down codes are the saved run's: a rescore cannot make a trial whole.
- **When to run it.** Any change to the fit prompt (`src/prompts/verdict-fitter.fit-verdict.md`) or to the model the fit judge runs on, with labels, on `main` while tuning and on the holdout to judge. A change to the floor, the merge or the cases needs only `--floor-only`.

### Shelf eval
`npm run eval:shelf` (`scripts/eval/shelf.ts`) runs `recognizeShelf` on the owner's own photos and prints, per photo, the products found, missing and extra
(brand and name only) and the micro-averaged recall and precision (`scripts/eval/shelf-score.ts`, tested). A found product matches an expected one when
brand and name both agree, ignoring case and runs of spaces; each expected product matches at most once.

- **Photos.** Put them in `eval-photos/shelf/` with `expected.json`, `{ "<file>": [{ "brand": "...", "name": "..." }] }`. The folder is git-ignored: the photos are the
  owner's and are never committed.
- **Run.** Needs `ANTHROPIC_API_KEY` (environment, else `.dev.vars`) and makes real, billed calls, capped by `--max-usd` (default 2). `--model recognize-shelf=MODEL`
  tries another model, `--limit N` runs the first N photos. Report-only: never part of `npm test` or CI, and it prints no model text beyond the brand and name of found products.

### Matching eval
`npm run eval:matching` (`scripts/eval/matching.ts`) measures whether `ProductCatalogService` lands a reading on the right row, not just whether a
photo is read correctly: matching is a separate failure mode from recognition, and this is the only eval that pays for both together. It has three
parts, `--part matching|images|shelf` (default `all`), sharing one dollar cap for the whole run, `--max-usd` (default 3).

- **matching** reads every catalog photo once, then resolves the same recognitions against a fresh in-memory catalog in 3 fixed random orders
  (`scripts/eval/matching-set.ts`'s `SEEDS`): does a repeat photo of a product find its existing row (`repeat-hit`), and does a look-alike ever land
  on the wrong one (`wrongMerges`, the number that must stay 0)? The goal is fewer duplicate rows (so less research and analysis spend is paid
  twice) without ever merging two different products.
- **images** creates and researches each catalog product for real and saves the stock image it stores, for the owner to judge `--verdict
  HASH=right|wrong`.
- **shelf** reads each shelf photo once and resolves every product it lists against a catalog seeded with the true rows of the single set and of
  the shelf photos' other products: did it find what is in the photo, invent nothing, land on the right row? **Seeding**: an in-set product's row is
  seeded from what its own single photos were read as (the first that reads as a beauty product, in name order — `seedReadingOf`,
  `scripts/eval/shelf-seeds.ts`, tested on its own), reused from the matching part's recognitions when it ran in the same invocation, else read
  fresh; that is what the catalog would really hold, not the owner's label wording. A product with none of its photos readable, and every
  shelf-only product (named in a shelf photo but not in the single set), keeps its label identity. **Collision fallback:** two seeds reading the
  same identity key would be two rows for one product, which the judge is never asked about (the catalog is seeded directly, not resolved); each
  side of such a collision that came from a single scan falls back to its product's label identity instead (a key already collided on sends any
  later single-scan seed with it to its label too) (recorded as `reason: "collision"`
  in the report and counted on the console line), since the label is still a true identity for it. Only a collision that survives the fallback —
  two hand-written labels that still read the same — stops the run (`SetupError`, exit 2): that is the owner's label set, not the pipeline, being
  wrong. `--part shelf` alone still reads the whole single set fresh (recognitions are not carried over from a part that did not run) and is not cut
  by `--limit`, which only trims the products the matching and images parts run on.
- **Photos.** Single-product photos in `eval-photos/catalog/<folder>/` with `eval-photos/catalog/labels.json` (one label per folder); shelf photos in
  `eval-photos/shelf/` with `labels.json` (`{ "<file>": { "products": [{ "folder": "..." } | { brand, name, variant?, form?, category }] } }`), not the
  shelf eval's `expected.json`. Both folders are git-ignored and never committed.
- **Cost and models** follow the catalog eval's conventions: one `MemoryAiSpendLedger` cap in dollars, `--model job=model` overrides, console table
  plus `.eval/matching/<timestamp>/report.json` and a `contact-sheet.html` (stored images and shelf photos beside the owner's own, never a prompt or
  other model text — only folder names, short row ids, codes, field names and numbers).
- **Keys.** Locally `ANTHROPIC_API_KEY` from the environment, else `.dev.vars`. Never run by `npm test` or CI, which hold no secrets.
- **Exit.** 0 when every part that ran met its target, 1 when one missed, 2 when the run could not start (photo set, verdicts, arguments, key, or an
  unresolved seed collision).

### Shelf

`src/modules/shelf` owns `profile_products`: the products a profile uses, one row per entry (spec #100). Scans write the rows (below); this module reads and removes them.

- **Invariant.** An item is on its profile's shelf if and only if it reached `ready` (a `product` row) or `unidentified` (a `no-label` row). `D1ScansRepository.updateItem` writes the row in the same `db.batch` as the guarded move, as an INSERT ... SELECT that selects nothing unless the item holds the patched state and `updated_at`, so a lost race or a repeated move writes nothing. `updatedAt` is therefore required on those moves (it throws without). A `ready` item with no product is not shelved.
- **Latest wins.** A product is one row per (profile, product) (a partial unique index). A later `ready` of the same product points the row at the new formulation, scan and item, moves `last_scanned_at` on, and clears any removal; `added_at` keeps the first time. A no-label row is one per item.
- **Soft removal.** Removed rows keep `removed_at` and an optional reason; they are not deleted.
- **Profile.** It comes from the scan row, joined to `profiles` (queue steps run as a system actor, with no session). A scan with no profile, or one naming no profile row, is not shelved and its move still applies. So the invariant holds from the moment a scan has a profile: an item of a pre-rollout scan that was already `ready` or `unidentified` when `adoptOrphanScans` gave the scan a profile is not shelved (there is no backfill, by decision; a rescan shelves the product).
- **Catalog caveats.** A named label that adopts an unnamed product's list deletes the unnamed product, so a row's `product_id` can dangle (read the product through `formulation_id`), and a rescan after the adoption arrives under a different product id and can leave a second row for one physical product. Accepted for now.
- **Reading.** `GET /api/v1/me/shelf` (`ShelfService.list`) returns the profile's active entries, newest `last_scanned_at` first with ties by id (the same in `D1ShelfRepository` and its fake), at most `SHELF_POLICY.maxEntries` (200). A `product` entry's summary is read through `formulation_id` with one batched `ProductCatalogService.productSummaries` call; a `no-label` entry's view with one batched `ScanService.noLabelViews` call, the same `noLabel` the scan item shows (those methods check no ownership: they are only asked for ids from the caller's own shelf rows). Lookups by id are chunked below D1's 100-parameter limit. An entry that no longer resolves is left out and logged as `shelf-entry-unresolved` with its id only, not a 500.
- **One entry, and entries by id.** `GET /api/v1/me/shelf/{entryId}` (`getShelfEntry`, guests included like the list; 400 for a non-uuid id, 401, 404) answers `ShelfEntryResponse` through the same presenter as the list (`ShelfService.entry`). An unknown, removed or another profile's id, and an entry that no longer resolves (logged as `shelf-entry-unresolved`, id only), are all 404 `SHELF_ENTRY_NOT_FOUND`, so nothing shows that another profile's entry exists. `ShelfService.viewsFor(profileId, entryIds)` answers a `Map<entryId, view>` for the profile id given (no session, so jobs can call it) and is not capped at 200. `list`, `entry`, `add` and `viewsFor` all build their views through the one private `viewsOf`, so one batched `productSummaries` and one `noLabelViews` call serve each ask; an entry that is removed, foreign, unknown or unresolved is simply absent from the map. Both read through `D1ShelfRepository.activeByIds(profileId, ids)` (active rows only, chunked below D1's parameter limit, in id order; the fake and `shelf.repository.contract.ts` pin it).
- **Removing.** `DELETE /api/v1/me/shelf/{entryId}` (`ShelfService.remove`) takes an optional JSON body `{ reason?: 'finished' | 'stopped' | 'not-mine' }` (the table also holds `wrong-product`, written only by the swap below) and answers 204. One conditional UPDATE sets `removed_at` and the reason only on the profile's own active row; an entry already removed is 204 again and keeps its first time and reason, and another profile's or an unknown id is 404 `SHELF_ENTRY_NOT_FOUND`. A later scan of the product clears the removal (see Latest wins).
- **Removing several (#259, B2).** `POST /api/v1/me/shelf/remove { entryIds, reason? }` (`removeShelfEntries`; `signedIn()` runs before the body is read, guests included, no limiter, as `DELETE` has none) takes 1 to 50 different entry ids (a repeat is 400; strict body) and one optional reason for all, and answers 200 `{ removed, stepDownWarnings }` (`ShelfService.removeMany`). **All or nothing:** `D1ShelfRepository.removeMany(profileId, ids, reason, at)` checks that every id is the profile's own (an unknown, never-existed or another profile's id is 404 `SHELF_ENTRY_NOT_FOUND`, not told apart, nothing written) and then removes them in ONE `db.batch` of conditional updates (active rows only), so an entry removed before is accepted, keeps its first time and reason, and is not in `removed` (ids in request order). **Warnings:** each item is `{ entryId, taperCode: string | null, line }`. `ShelfService` decides who sees what from the session: a verified caller gets the public `taperCode` and the fixed `line` `STEP_DOWN_LINE_VERIFIED`; a guest, who is served only the locked verdict preview, gets `taperCode: null` and the self-contained `STEP_DOWN_LINE_GUEST` ("Sign up to see the step-down"), and nothing else of the verdict. Both lines live in `shelf.copy.ts` (copy awaiting the owner's sign-off; `shelf.copy.test.ts` checks them against `FORBIDDEN_WORDING`). The shelf module cannot import verdicts, so `ShelfServiceDeps.stepDowns.stopsFor(profileId)` (a `Map<entryId, taperCode>`) is wired in `container.ts` to `VerdictService.savedFor` (the verdict as it would be served now; `null` while pending, out of date or unavailable) keeping the products whose verdict is `stop`, with `taperTemplateId`, the `code` of `GET /me/verdict`'s `tapers[]`. It is read BEFORE the removal (which changes the verdict's inputs); if it throws the products are still removed with `stepDownWarnings: []` and `shelf-step-down-lookup-failed` is logged with ids only. The routine keeps a running step-down after a removal made with no reason or `finished` (built separately, B4; nothing here does it).
- **Adding by search (typed scans).** `POST /api/v1/me/shelf { productId }` (`addShelfProduct`; limiters `SHELF_ADD_IP_LIMITER` then `SHELF_ADD_USER_LIMITER`, as the scan routes order them) puts a named catalog product picked from `GET /api/v1/products/search` on the shelf. `ShelfService.add` first asks `D1ShelfRepository.activeForProduct(profileId, productId)` (non-removed `product` rows only): a product already on the shelf is **200** with its entry, in the view `GET /me/shelf` returns, and nothing else happens (no scan, nothing counted, no model, no push). A removed entry is not active, so it goes on and the scan restores it as the same entry (Latest wins). Otherwise `ScanService.createTyped({ productId, clientIp })` runs as the session and answers **202** `{ scanId, itemId }`: it resolves the product first (`catalog.choose` + `namedProduct`, PRODUCT_NOT_FOUND before anything is written), and only if the catalog says the product needs a model (`needs-research` or `needs-analysis`) takes the daily allowance (user and address, adding 1, SCAN_DAILY_LIMIT as a photo scan does). It then writes a scan of **`kind = 'typed'`** with no photos and one item at position 0 with no `photo_id` or `photo_key`, created in **`needs-identification`** (not `recognising`: with no photo the reaper would requeue a recognise that can only fail as photo-missing, and `needs-identification` is a waiting state it leaves alone, which the app can still identify by hand), and moves it on with the same `identifyByChoice` a user's pick uses: `ready` (on the shelf in the same batch), `analysing`, `researching` or `failed` as `analysis-failed`. If that throws, the item stays in `needs-identification`. The app follows the scan (`GET /api/v1/scans/products/{scanId}` or its events) and reads the shelf once the item is final.
- **Swapping an entry: "this isn't the right product" (spec #259, B3).** `POST /api/v1/me/shelf/{entryId}/replace { productId }` (`replaceShelfEntry`; strict body; guests included; the same middleware order and limiters as the search add: `SHELF_ADD_IP_LIMITER`, `signedIn()`, `SHELF_ADD_USER_LIMITER`, so the two routes share those allowances) is `ShelfService.replace(entryId, productId, clientIp)`. Checks, in order, and none removes anything: the entry is the caller's and active, read through `activeByIds` (404 `SHELF_ENTRY_NOT_FOUND`: unknown, another profile's and already removed are not told apart); `productId` is not the entry's own `product_id` (400 `VALIDATION_FAILED`: that is not a swap); `catalog.namedProduct(productId)` (404 `PRODUCT_NOT_FOUND` for an unknown or unnamed product, so a bad id never takes a product off the shelf). Then: (1) `remove` with the reason **`wrong-product`**, a fourth `removed_reason` that only the swap writes (the public `DELETE` body and its enum do not accept it; a text enum, so adding it needed no migration: `db:generate` reports no schema changes); (2) one wrong-match report through the `wrongMatches.record(report, now)` dependency, which the container wires to `D1VerdictReportsRepository.recordWrongMatch` (a structural dependency, so shelf imports nothing from verdicts); (3) `opsAlerts.raise('wrong-match-report')`, which never throws, and is called only once the report is written (a failed report raises nothing); (4) `ShelfService.add`, exactly the search add, so the answer (**200** with the right product's own entry when it is already on the shelf, the wrong one still removed; **202** `{ scanId, itemId }` of a typed scan otherwise), the daily limit and the research charging are unchanged. **The removal and the report are not one batch**: the report table belongs to verdicts and the module boundary keeps the two writes apart, so the removal comes first and the report is best-effort: a failure is logged as `{ outcome: 'wrong-match-report-failed', profileId, entryId, productId }` (ids only), no alert is raised, and the swap goes on. **A failed add stands after the removal**: if `add` throws (429 `SCAN_DAILY_LIMIT`, a provider error), the removal and the report stay, the alert is raised, and the error is answered as `POST /me/shelf` answers it. The entry is then removed, so `/replace` for it again is 404 `SHELF_ENTRY_NOT_FOUND`: the app adds the right product with `POST /me/shelf`. A removal lost to a concurrent one is that same 404, with no report, alert or add. The entry with no label (`product_id` null) may be swapped too: the person names what it really is, and its report has `old_product_id` null.
- **The `counted` flag.** `scan_items.counted` (integer boolean, NOT NULL, default true; migration 0027, a plain `ALTER TABLE ... ADD`) says whether an item counts toward the daily photo quotas. `photoCounts`, so both `photosSince` and `photosSinceIp`, count only counted items. Every item that existed before the column, and every photo or shelf item, is counted; only a typed item created with `counted = false` is not, and that is a product that needed no model (`ready` or `analysis-failed`), so adding one is never refused for the allowance and does not use any of it. A typed item that needs a model is counted, as one photo.
- **The push rule.** A typed scan sends "your scan is ready" only if it waited for a model: `notifyFinished` skips the push for a typed scan none of whose items is counted (it finished inside the request, in front of the user), and sends it, with the usual notification settings, for a counted one (which finishes later, possibly after the user left). The `done` event is published either way.

### Shelf verdict

`src/modules/verdicts` saves each profile's verdict on its shelf (spec #171): the rules floor's labels merged with the fit judge's (`AnthropicVerdictFitter`, "Claude (Anthropic) providers"). It is built by a job, never in a request.

- **One row per profile** in `shelf_verdicts`: a status (`pending` or `ready`), the fingerprint of the inputs it was built from, the products, and the fit retry columns (`fit_attempts`, `fit_retried`, `fit_retry_due_at`). A rebuild keeps the previous build in the row while it is pending.
- **Served only when ready and current.** `VerdictService.current` (the caller) and `savedFor(profileId)` (the routine, by profile id, with any session) recompute the fingerprint from the inputs as they are now and serve the row only if it is ready and the fingerprints match, whatever its fit. Otherwise they claim and queue a build and answer `pending` (`current`) or null (`savedFor`); the previous verdict is never served as if it were current. Both go through one private path, so the claim, the queueing and the release below are written once.
- **Gates.** `current` throws 503 `VERDICT_UNAVAILABLE` while the steroid or the lightening-agent step-down template is not approved (a stopped product could not be shown its taper), then 409 `GOAL_REQUIRED` for a profile with no goal. `savedFor` throws neither: it answers null and writes nothing. The job fails for good (`PermanentJobError`) on either.
- **A guest is never given the full verdict (owner decision).** The actor's status decides how one saved row is read: a verified user is given the full verdict, a guest (`anonymous`) the locked preview, in `current`, in the stream's snapshot and in every frame published for it. It is one build, one row and one judge call, read two ways, so signing up (which keeps the profile) shows the full verdict at once with no new build. The preview is `{ status: 'ready', locked: true, fit, total, counts, escalates }`: `total` is every saved product (whether or not its shelf entry still resolves), `counts` has all eight groups (`helping`, `redundant`, `blocking`, `conflicting`, `likely-the-problem`, `cant-tell`, `prescribed`, `undecided`; 0 where none) and `escalates` is how many products carry `escalate`, so the app can say to see a professional without naming which product. It holds no product, id, name, reason or step-down. `previewOf` in `verdicts.view.ts` is the one place it is computed, from the saved products alone (no shelf lookup), and `current`, `watch` and publishing all use it. `savedFor` is the routine's and is unchanged: always the saved products in full.
- **The route** is `GET /me/verdict` (`verdicts.routes.ts`, thin: `VerdictService.current` through `verdicts.view.ts`). Its public shape (`ShelfVerdictResponse`, a `z.union` told apart by `locked`) is `{ status: 'pending' }`, the guest's preview above, or the verified user's `{ status: 'ready', locked: false, fit, groups, products, tapers, professional }`: a product is `{ entryId, kind?, product? | noLabel?, group, verdict, reason, escalate, sameJobAs?, nudge?, suggest, basis }` (a stop names its step-down by `taperCode`; `kind` and `product` or `noLabel` are the shelf entry's own, exactly as `GET /me/shelf` shows it, mapped by the scans presenter's `toProductResponse` and `toNoLabelResponse`) and a taper is `{ code, kind, schedule, whatToExpect, seeAProfessionalIf }`. **`groups` and `suggest` are fixed copy, stored nowhere (#259).** `groups` is on both ready shapes (the guest's preview too, beside its `counts`, never on `pending`): `{ group, title, subtitle, intro, count }[]`, always all eight in the screen's order (`GROUP_ORDER` in `verdicts.screen-copy.ts`: likely-the-problem, conflicting, cant-tell, blocking, redundant, helping, prescribed, undecided), `count` 0 where empty (the app hides zeros) and equal to the preview's `counts`; the words are `GROUP_COPY`, one entry per `VerdictGroup`. `suggest` is on every product of the full verdict (never the preview), one to three lines worked out by `verdicts.view.ts` from the `verdict` alone and never by a model: keep says so; reduce has one line per `Frequency`; stop names the step-down's kind (read from `tapers` by the verdict's code) and says never to stop suddenly, matching `STEROID_STEP_DOWN` and `LIGHTENING_STEP_DOWN`; drop says to stop now, plus "see a professional" when `escalate`; a `cant-tell` product also gets the photograph-the-back-label line. The tables in `verdicts.screen-copy.ts` are `Record`s over the group, frequency and step-down kind, so a new one is a compile error until it has words, and every line passes `FORBIDDEN_WORDING`. The block is marked "Copy awaiting the owner's sign-off". A guest's preview text never says "products" (the service tests keep it free of anything that reads as the shelf). Because both ride on `toShelfVerdictResponse`, `current`, the snapshot and every frame carry them; `previewOf` and the saved row are unchanged, so no migration and no fingerprint change. **The shelf entry's product is joined at read time and never saved.** For a verified reader, `current`, `watch` (the snapshot and its re-read) and the frame `build` or `markFitFailed` publishes each make one `ShelfService.viewsFor(profileId, entryIds)` call (by profile id, so a job needs no session) for the saved products and add `kind` with `product` or `noLabel`; the saved row, `savedFor` and the fingerprint do not hold them, so renaming a product is no new build. **A product whose entry can no longer be shown stays, and is never hidden:** when its view no longer resolves (taken off the shelf since the build) it keeps its saved `entryId`, `group`, `verdict`, `reason`, `escalate`, `sameJobAs` and `nudge` and has no `kind`, `product` or `noLabel` (`kind` is optional in `VerdictProductResponse`: absent only then), with no throw and no re-queue; the saved verdict is untouched and a rebuild drops the product. Its stop, its escalation and the product a redundant one names are still the user's to see. The step-downs listed are those of all the saved products. `verdicts.view.ts` names every field, so `facts`, `step`, `sourceUrls` and a template's status and audit columns never leave the service; the schedule arrives from the workbook already as steps, so nothing is parsed.
- **Where a verdict comes from: `basis` and `professional` (#259 A3).** Each saved product carries `basis: Basis[]`, a **snapshot** made by `mergeVerdict` (`verdicts.basis.ts`, pure) when the verdict is built and never looked up again, so a later edit or retirement of a rule leaves a saved verdict saying what it said. `mergeVerdict` takes a `reference` (`{ rules, claimWords }`, the approved rules the floor was given and the approved claim words, which `VerdictReference` already is). A basis is `rule` (`ingredient-rule` or `claim-word`, with `statement`, `sourceUrl`, `reviewerRole`), `fit`, `told-us` (`reaction` or `prescription`) or `no-label` (`purpose` or `unknown-contents`), and every one has a `line` the app shows as it is: a rule's `line` is its `statement`, and every other line is fixed copy in `verdicts.copy.ts` (not `verdicts.screen-copy.ts`, which imports the merge: a cycle), marked "Copy awaiting the owner's sign-off", each passing `FORBIDDEN_WORDING`. A claim word's statement names the phrase between quotes, and only the words around the phrase are gated, as the phrase can itself be a forbidden one. Each floor fact maps to a basis: `ingredient-group` cites the rule of that group with that name, `banned-substance` the banned rule with that name and `pregnancy-caution` the pregnancy rule that flags the ingredient (names can be shared, so the group or kind picks the rule that decided); `claim-phrase` the claim word; `reaction-product` told-us/reaction; `reaction-ingredient` the ingredient's rule where it has one and then told-us/reaction; `prescription` told-us/prescription; `no-label-purpose` and `unknown-contents` no-label. A product lists every basis once, rules first and in the order of the floor's facts. A product the fit judge decided (helping, redundant, blocking, or one a clash reduced after the judge answered) has just the fit line, "Matched against your goal by our checker.", which never calls the fit a reviewed rule; an `undecided` product has `[]`. `reviewerRole` and `sourceUrl` come from the workbook (`VerdictRule.reviewerRole`, `VerdictReference.claimWords`); `reviewerRole` is null for a rule stored before contract 2.4.0 and the app then shows no "Reviewed by" line. **Neither is hashed:** a catalog-only edit rebuilds no verdict (owner decision, #171). The full verdict's `professional` (`{ whoToSee, howSoon, whatToTellThem }`, from `CatalogWorkbookService.escalationFor('about-a-product')`) is **read each time the verdict is read and never saved**, so a row imported later shows at once; it is null until the row exists, and nothing is invented. Neither `basis` nor `professional` is ever on the guest's locked preview or its stream. Products with `escalate` keep their stronger suggestion lines.
- **The verdict format version.** `VERDICT_FORMAT_VERSION` (`verdicts.fingerprint.ts`) is hashed into the fingerprint (`FingerprintInput.formatVersion`, filled by `fingerprintInputOf`). Bump it when the shape of a saved verdict changes. Adding it (version 1, with `basis`) makes every verdict saved before stale once, and the next read rebuilds it: **one Sonnet fit call per shelf that has a product the rules leave open** (a shelf the rules decide whole, or an empty one, costs none), tracked like every fit call. It rebuilds once and settles; staging only, before launch.
- **The events route** is `GET /me/verdict/events` (`watchShelfVerdict`, `signedIn()`, guests included): `VerdictService.watch` has `current`'s gates and claim (503 then 409, with nothing subscribed or queued on an error) and `subscribe`s to a `ScanStream` with the public body as `snapshot`: **two stream keys, so a frame can never reach the wrong reader.** The full verdict is on `verdict:<profileId>` and a verified user is subscribed to it; the preview is on `verdict-preview:<profileId>` and a guest is subscribed to that only, never to the full one. `build` publishes a `verdict` frame (the same public body each reader's GET answers, from `verdicts.view.ts`, which the service and the route both import) to both keys after every save, a floor-only one included, before it throws for the retry; `done`, and the `pending` frame below, go to both keys too. `watch` publishes only to its own caller's key. Each frame, and each `done`, is sent in a try of its own, so one failed send never skips another. When the full frame's join of the shelf's products fails, neither verdict frame of that save is sent (the preview is not sent alone), and `done` still is. **Done rule:** `done` follows a ready verdict when its `fit` is `ready` or its `fitRetried` is true (the day's attempts and the 24 hour retry are spent, or the next try is a day away, so nothing more is coming soon); the stream stays open only while the fit is `not-ready` and `fitRetried` is false, for the retry's `verdict` (the 10 minute cap and a reconnect bound the wait). `watch` reads again after `subscribe` and sends what a build saved in between, with `done` by the same rule; if that re-read throws it is logged as `{ outcome: 'watch-reread-failed', profileId }` and the stream is still returned. **Changed under the judge:** after saving, `build` recomputes the fingerprint from the inputs as they are now; if it differs from the one it built, the stream gets a `verdict` of `{ status: 'pending' }` (no `done`) and the build for the new fingerprint is claimed and queued through the same private claim/enqueue/release path `current` uses. **Dead letters:** `markFitFailed` (after scheduling the retry) sends the row's verdict then `done` for a ready row, `done` alone for a pending row, and nothing for a dead letter it ignores. `build`, `markFitFailed` and `watch` send the verdict frame (whose full version joins the shelf's products) and `done` apart, and each publish never throws, so a failing join never skips a due `done`. A failed publish is logged as `{ outcome: 'publish-failed', profileId }` and never changes the build's outcome or stops the retry from being scheduled.
- **The fit request's skin concerns** for a product are the union of what its matching ingredient rules help and what the recommendation catalog's approved Products rows say it is for (`CatalogWorkbookService.skinConcernsFor`, loaded beside `stepsFor`, sorted, a concern once); the rules' `helps` is empty in the live catalog, so the catalog is the real source, and neither is part of the fingerprint.
- **A sunscreen is never reduced in a clash.** A sunscreen is a product whose routine step is exactly `protect` (the first catalog step in routine order, which `assembleVerdictInputs` puts on the floor's product entry as `step`; null is never one, whatever it is named). When exactly one member of a clashing pair is a sunscreen the floor's `fallbackReduceId` is the other, and the pair carries `sunscreenId` so the merge reduces the other member when the judge names the sunscreen (as it does when the judge names a prescribed one). A prescribed product still beats a sunscreen, so prescribed + sunscreen reduces the sunscreen; both or neither keeps the tie-break. The step is not in the fingerprint or the fit request's clashes.
- **Claiming is atomic.** `requestBuild` is one INSERT ... ON CONFLICT DO UPDATE ... WHERE: it claims a new row, a ready row of another fingerprint, or a pending row 30 minutes old (its build died), so parallel asks queue one build. If the enqueue then throws, the service calls `releaseClaim(profileId, requestedAt)` (one UPDATE that moves that exact pending request to the epoch, so the next ask claims at once) and rethrows the queue's error; without it the dead claim would hold every ask off for 30 minutes.
- **The job.** It rebuilds from the inputs as they are when it runs and saves their fingerprint. While a scan of the shelf is in flight or safety words are being parsed it queues itself again 60 s on (`waits` + 1, key `...:<waits>`, so each wait is a run of its own and uses no retry), and builds anyway after 15 waits. A row already built from those inputs with its fit ready is left alone, so a repeated message costs no second call to the judge.
- **Fit retries.** If the judge fails or its answer does not fit the shelf, the verdict is still saved at once, floor labels only, with the open products undecided and the fit `not-ready`. Only the judge's call and the merge of its answer count as an attempt; the floor-only merge is outside that. The first two failures throw so the queue retries; the third saves a retry due 24 hours on (`fit_retry_due_at`) and returns. The daily sweep (`requeueDueFits`, "Guest cleanup") queues, with no delay and `retry: true`, the longest overdue 200 a run; the row keeps its due time until the retry builds. A dead-lettered build gets the same one more try (`markFitFailed`), and a second failure is final. A `retry: true` message for a fingerprint that is no longer current is skipped, and a message without it never tries the judge again for a row whose retry is spent.
- **The judge's client** is its own, with a 120 s timeout (`VERDICT_FIT_TIMEOUT_MS` in `container.ts`): it reads a whole shelf and nobody waits for it, so a stuck request frees the consumer for the retry.
- **Logs** carry ids and outcomes (`verdict-entry-unresolved`, `fit-failed`, `fit-retry-enqueue-failed`), never a product name, a reason or the words typed.
- **Reports** (`verdict_reports`, `verdicts.reports.*`, spec #259): `POST /me/verdict/products/{entryId}/reports` (`reportVerdictMistake`, `signedIn()` before the body) stores a person's "this verdict looks wrong" for the team to read; there is no triage screen and nothing in the product reads the rows (the team queries the table, which is also what the alert email says). `VerdictReportsService.reportMistake(entryId, note?)` checks in order 401, 403 `SIGNUP_REQUIRED` (a guest), 400 `VALIDATION_FAILED` (a note trimmed to more than 500 characters; empty or spaces is no note; the route body is strict `{ note?: string }`), then 404 `VERDICT_PRODUCT_NOT_FOUND` unless the entry is a product of `VerdictService.savedFor` (the verdict the person would be served right now, so never a pending or stale one). It stores the product's group and verdict action as saved, the verdict's fingerprint and the product's saved `basis` (where its verdict came from, as the person was shown it; null only on `wrong-match` rows). One row per profile, entry and fingerprint among `kind = 'mistake'` (a partial unique index): `D1VerdictReportsRepository.upsertMistake` is one INSERT ... ON CONFLICT DO UPDATE ... RETURNING, so a repeat replaces the note and `updated_at` and answers the first row's id with `created` false, and two at once leave one row and exactly one `created`. The route answers 201 `{ id }` for a new report and 200 for a repeat; a rebuilt verdict has another fingerprint, so its report is new. `raise('verdict-report')` runs only when a row was created. `recordWrongMatch` is a plain insert (`kind = 'wrong-match'`, any number per entry), built here for the shelf swap to call. `entry_id` is a plain column, not a key, so a report outlives its entry; rows go with their profile.
- **The note is private.** It goes into the report row and nowhere else: never a log line, an error message or `details`, an alert, a job message or a model prompt. The service has no `console` call and no catch that logs, every error message is fixed text, and a failure is logged (by the error handler) with ids and names only.

### Routines (storage)

`routine_versions` (`routines.table.ts`, `D1RoutinesRepository` in `routines.repository.ts`, spec #189) holds each profile's routine versions. A build is **one row**: `append` writes it `pending` (a build asked for, not done), and `complete(id, built)` fills that same row, once, with the finished build and makes it `ready` (it updates only `WHERE id = ? AND status = 'pending'` and returns whether it did, so an unknown id or an already-ready row gives false and is left alone). A build that needs no pending phase ("I got it") may `append` a `ready` row. A ready row is never changed again except `served_at` (`markServed`), `started_on` (`markStarted`) and `writer_retry_due_at` (`clearWriterRetry`). The newest row by `created_at` (then `id`) is `latest`; the newest `ready` row is `current`, the routine in force, so a newer `pending` row never hides it. Rows go with their profile (`ON DELETE CASCADE`, as `shelf_verdicts` do), so a purged guest's versions go with it and no guest cleaner is registered.

- **The routine:** `steps` (a `StoredRoutineStep`: a routine entry plus `gotIt`, `fixedFrom`, the id of the version a step was carried over from unchanged, and `changedOn`, the calendar day (the UTC midnight of the local date, a `Date` revived on every read) the step's product last changed, null meaning day 1; grounding and `changedOn` stay here and are never served), `tapers` (a `StoredTaper`: the shelf product, its template and the day the step-down began, null until Start) and `expectation`. They are `[]`, `[]` and null while pending. `cautions` are the skeleton's cautions the build was made under (null while pending). `started_on` is day 1 (the UTC midnight after the tap on Start) and is carried forward by later builds, and `markStarted` is the one change a ready row takes besides `served_at` (it dates the row and its step-downs once); `lastServedBefore` gives the newest served version but one; `served_at` is when the version was last returned to the user (`markServed`).
- **Recording:** `source` (`writer` or `rules`; null while pending, set on completion) and `reason` (why it was built) say how and why; `model` and `prompt_hash` name the writer whenever it was called (`writer_calls` above 0), even when every try failed and `source` is `rules`, and are null when it was not called (the one exception is a got-it copy, below); `ready_at` is when the row became ready (appended ready, or completed), which orders the ready rows: the routine in force is the one that became ready last, so a build asked for earlier that finishes later still replaces one made meanwhile; `rules_version` (`ROUTINE_RULES_VERSION`), `catalog_version` and `verdict_fingerprint` say what it was built from; `routine_fingerprint` identifies what came out; `hints_shown` records whether the writer saw outcome hints; `writer_calls` (0 to 3, default 0) is how many writer calls the build made; `writer_retry_due_at` is when a rules-built version is due another try by the writer (its partial index is for the sweep). `reason`, `rules_version` and `verdict_fingerprint` are known when the row is appended, so they stay not null.
- **The daily limit** counts `writerBuildsSince(profileId, since)`: the profile's rows created at or after `since` with `writer_calls > 0`, whatever their source. A rules-only fallback after failed writer calls counts, because those calls were paid for; a pending row with no calls yet does not. A build is one row, so it is counted once.

### Routines (service)

`RoutineService` (`routines.service.ts`, #189) builds and serves a profile's routine versions. It is wired in `container.ts` after the verdicts, with a writer client of its own (120 s timeout); the `build-routine` job and the triggers and sweeps (see "Routines (job)" and "Routines (triggers)") call it, and the routes reach it through `RoutineViewerService` (see "Routines (API)"). It reads by profile id; whatever the recommendation and shelf modules read as the caller runs as the profile's own verified user.

- **Build states.** `build(profileId, reason, { exclude? })` answers `waiting` (nothing appended) while the saved verdict is not `ready` for the inputs as they are, or the goal, the safety answers or the shopping country is missing (a missing profile counts too, and so does a profile whose user has not verified: a guest is never built a routine, and `routine-not-verified` is logged with the id). `unchanged` (nothing appended) is only possible after Start, when no step, step-down or caution differs. Otherwise `built`. There is no fingerprint short-circuit: the trigger layer decides when to ask. `current` is `pending` (no routine yet, or the routine in force no longer fits the person's safety answers: the safety-derived cautions now stated differ from the ones it was built under, `tapering` not counting because it comes from the verdict; this hides it whether or not a build is under way, even a dead one, until a build stores the new cautions), `updating` (a newer pending row, younger than 15 minutes) or `ready`.
- **Stable after Start.** Before Start every build writes the routine afresh. After Start (`started_on` set) `stableMerge` keeps each previous step the gates still accept, the writer is asked only about the broken steps (the fixed steps' gaps narrowed to their one product), and `spliceFixed` puts the fixed steps back whole. Tapers are set in code and keep their dates, and a running step-down outlives its product's removal (see "Routines", a step-down survives its product's removal). A recommended product the person's country no longer offers is looked up in every active country (`candidatesFor({ step, country })`, which ignores the budget band) and kept while sold anywhere; one sold nowhere is refilled. A got-it product now on the shelf becomes the shelf entry. When only the cautions changed, a copy version with the new cautions is appended (no writer call).
- **Retries and the fallback.** The pending row is appended before the writer is called. The writer is tried up to three times; each retry is told the gate codes the last routine failed against the real (unnarrowed) skeleton, or `{ failed: [] }` after an error, which counts as a try. After three failures the rules-only routine is saved (`source: 'rules'`, model and prompt hash of the writer that was called, `writer_retry_due_at` a day on). A version made without the writer (nothing broken, or the daily limit) has `writer_calls` 0, `source: 'rules'` and no model or prompt hash. **The one exception is a got-it copy:** it keeps the source, model and prompt hash of the version it copies, with `writer_calls` 0. A `writer-retry` build that finds nothing broken answers `unchanged` and clears the version's `writer_retry_due_at`. The rules write a broken step from the same narrowed skeleton the writer is given, so a product carried from another country is only ever kept in a fixed step, never picked again.
- **The daily limit.** At five builds with writer calls in the last 24 hours (`writerBuildsSince`, rolling) the next build uses the rules alone, with no writer call, and a retry due a day on. A started routine is still kept current this way.
- **Start and "I got it".** `start` stamps tomorrow on every version: the person's next local date in the time zone stored with their reminder settings (the next UTC date with none), stored as that date's UTC midnight and never moved by a later change of zone; day 1 is the day after the tap; see "Reminders" without a start date, a pending one included, and on their undated step-downs (`markStarted`); it is idempotent and 409 `ROUTINE_NOT_READY` without a ready version, and while a safety change hides the routine (it reads `current`, not the repository: a routine the person cannot see, `GET` answering pending, is not started). `gotIt(profileId, step, clientIp)` is 409 `ROUTINE_NOT_READY` in the same two cases (no shelf add, no version), 409 `STEP_NOT_RECOMMENDED` unless the step holds a recommended product still sold somewhere; it adds the product to the shelf (by catalog product id), then reads the routine in force again: if a build landed meanwhile and still holds the product at that step, the copy is of that version, otherwise it is 409 `STEP_NOT_RECOMMENDED` (the product is on the shelf already, and the next rebuild swaps it in). The copy has that step `gotIt` and `writer_calls` 0. It is idempotent: a step already marked got answers at once, with no shelf add and no new version (nor does a tap that finds a racing tap's version in force append another). A build that was under way carries the mark into its own version. A Start that lands after a build read the routine in force is applied to the version it appends (pending, then re-read; or ready), and a step-down that begins after Start, a new stop, is dated the person's local date at the rebuild (the UTC date with no stored zone; stored as its UTC midnight), or day 1 when that is still ahead (none begins before day 1). `RoutineServiceDeps.reminders` is a `Pick<RemindersService, 'zoneFor'>`, read at Start and at each build. **`changedOn`** (#233, PR 4a; a JSON field, so no migration) is null on every step before Start. After Start a build stamps each step it writes as new (`fixedFrom` null: the writer's or the rules' pick) with the person's local date at the rebuild, never earlier than day 1, but only when the step's product changed or the step is new: a step written again with the same product (`sameProductBefore`: the same shelf entry, code or "use what you have", or a recommended product the person has since got as their own entry of it; a whole-routine rebuild included) keeps the day it had, null included; a step the merge keeps carries its own through, including the swap to the person's own shelf entry of the same product; a rebuild that changes no step (a copy) keeps them all. `gotIt` stamps the step it marks the same way (and leaves it null before Start, reading no time zone). A row stored before the field has none and reads as null.
- **Pauses follow the version** (#233, PR 4b). `RoutineServiceDeps.skinCare` is a `Pick<SkinCareService, 'reconcile'>`. After a version is stored the service calls `reconcile(profileId)`: after `complete`, after every direct ready append (`appendReady`) and after `gotIt`'s copy, next to `tell()`, and never for a pending append, an `unchanged` build or one that waits. A failure is logged by profile id (`routine-reconcile-failed`) and does not fail the build. See "Skin care" for what reconcile does.
- **Logs** carry ids and outcomes only (`routine-built`, `routine-unchanged`, `routine-writer-failed`, `routine-got-it`), never a product name or the writer's words.

### Routines (job)

The routine is built by a job, never in a request (#189, PR 3b). The triggers that ask for it and the daily sweeps are below ("Routines (triggers)"), and the routes are in "Routines (API)".

- **The `build-routine` job** (`routines.job-specs.ts`, `routines.jobs.ts`; logic in `RoutineService.run`) is on its own `routines` queue and dead-letter queue in all three `wrangler.jsonc` blocks (binding `ROUTINES_QUEUE`; created before the first deploy that binds them, README "Before the first deploy"). It never shares the verdicts queue: a bare verdict body in flight at a deploy would be unroutable on a shared consumer. One message at a time (`max_batch_size` 1), the standard 5 attempts and the verdict build's backoff (30 s x3 up to 600 s). The body is `{ profileId, reason, requestKey, requestedAt, waits, retry? }`, ids, one of the stored reasons and counters, never the shelf or the words typed (the list of reasons is written out in the spec, as a spec may not import a table; `RoutineService.run` hands it to `build` as a stored reason, so a reason the table lacks fails to compile). The key is `build-routine:<profileId>:<requestKey>:<requestedAt>:<waits>`, with `:retry` on the second day's try for the same reason as `build-verdict`; `onDeadLetter` is `markBuildFailed`.
- **The switch.** `ROUTINES_ENABLED` (a string var: `"false"` in dev and test, `"true"` in staging, `"false"` in production until launch) is read in `container.ts` as `env.ROUTINES_ENABLED === 'true'` and handed to `RoutineService` as `enabled`. Off, `request` does nothing at all, not even a claim, so switching it on later finds no key held.
- **Guests.** Only a profile whose user is `verified` is built a routine: `request`, `requestIfStale`, the sweeps and `build` check it (`ProfilesService.find` answers `ownerStatus`, from one join of profiles and users), so a guest's verdict save queues nothing and calls no writer. A dead-letter retry for a guest's request is dropped. An old `first` message for a guest still waits up to 15 times (no writer call) before giving up.
- **Request dedupe.** `routine_requests` holds ONE row per profile (`profile_id`, `request_key`, `requested_at`, `retry_due_at`, `retried`; cascade with the profile). `RoutineService.request(profileId, reason, requestKey)` claims it (`claim(profileId, key, now, staleBefore)`, one upsert statement, so parallel requests cannot both win) and queues the job only when it won. A claim wins on a profile with no row and on a row 15 minutes old or more (its build died); a fresh claim answers false **whatever its key**, so a request made mid-build is dropped, and the triggers ask again afterwards. A takeover resets `retried` and `retry_due_at`. A queue that refuses gives the claim back (`release(profileId, requestedAt)` moves a claim to the epoch, and only the claim made at exactly that time). `request` never throws and logs ids only (`routine-request-failed`). It answers whether a build was queued (false when switched off, for a guest, held off by a fresh claim or refused); the triggers ignore it, but "find one sold here" does not (see "Routines (API)").
- **Run and wait.** `run(body)` calls `build(profileId, reason)` and gives the claim back when it is done. When the build answers `waiting` for the reasons `first` and `review-point` it queues itself again with `waits + 1` and a 60 s delay, keeping the claim, up to 15 waits (the same as the verdict build) and then gives up quietly and releases the claim; every other reason never waits. An error is thrown for the queue to retry, the claim kept.
- **Dead letters.** `markBuildFailed(body)` releases the claim and, the first time, sets `retried` and `retry_due_at` 24 hours on for the daily sweep ("Routines (triggers)") to queue; nothing is queued there. A body with `retry: true`, or a request already retried, is final: no retry is due, and it is logged (`routine-build-failed-final`). A request that has moved on to another key is left alone.

### Routines (triggers)

What asks for a build (#189, PR 3c). Every request goes through `RoutineService.request(profileId, reason, requestKey)`; off (`ROUTINES_ENABLED`), every trigger and sweep does nothing.

- **The hook.** `RoutineTrigger` (`routines.trigger.ts`, a leaf file that imports nothing) is `(profileId, reason: 'first' | 'verdict' | 'review-point', requestKey) => Promise<void>`. Auth, verdicts and face scans take it as the optional dep `onRoutineTrigger`; they never import the routines service (routines imports them, so the reverse would be a cycle, type-only too). `container.ts` hands all three one function that calls `routines().request` lazily. Each host calls it in a try of its own and logs only the reason and an id on failure: a failed hook never changes what the host does.
- **Trigger points.** `AuthService.verifyOtp`, when the outcome is `promoted`: `(profileId, 'first', 'first')`, with no saved verdict in the request (the build waits for it). `VerdictService.build`, after the save and the outdated check and before the publish block, only when the save is current and its fit is `ready`: `(profileId, 'verdict', <the saved fingerprint>)`; an outdated save is followed by the build it queued, and a not-ready fit would only make the routine wait. `FaceScanService.copyResults`, next to the ready push and only for a check-in scan whose write won: `(profileId, 'review-point', 'review-point:<scanId>')`.
- **Stale read.** `requestIfStale(profileId)` is for the read that shows the routine (PR 4). It takes the routine fingerprint of the inputs as they are now and calls `request(profileId, 'verdict', fingerprint)` when it differs from the routine in force's, or there is no routine and the saved verdict is ready. It fingerprints the shelf exactly as the build does (`shelfOf` drops entries the build leaves out, `sunscreenKept` keeps a reduced sunscreen, and `fingerprintOf` hashes it), so an unchanged input never asks. It asks for nothing for a guest, nor while the build would only wait (no ready verdict, goal, safety answers or shopping country: the country is read with `shoppingFor`), so an unanswerable read does not ask on every call. It needs no candidates or face scan, and never throws. A build that ends `unchanged` after Start records the shelf counts under the new inputs on the routine in force (`setShelfCounts`) and then the new routine fingerprint (`setRoutineFingerprint`; the counts first, so a failed second write is healed by the next attempt), or every read would ask again. It also fills in the counts of a routine built before the column, even when the fingerprint is equal.
- **Daily sweeps.** `RoutineService.sweep(now)` runs from `createDailyJobs` after the verdict sweep, 200 rows at most for each of three, a failure of one not stopping the others, and answers how many builds it queued. (1) `dueRequests`: a request whose dead-letter retry is due is queued again with `retry: true`, its reason taken from its key (`first`, `review-point:`, `writer-retry:`, `catalog-retired:`, else `verdict`; no reason column) and **not claimed**; the due date is cleared only once the queue has taken it, so a refused message is tried again next run. (2) `writerRetriesDue`: the routine in force of a profile (never a version a newer ready one replaced) whose `writer_retry_due_at` has come gets `request(profileId, 'writer-retry', 'writer-retry:<versionId>')`. (3) `retiredCodeVersions` (ordered by version id, so what a capped run leaves is the same next day): one SQL query joins `json_each(steps)` candidate codes to `recommended_products` that are `retired` with `updated_in_version` greater than the version's `catalog_version`, for the routine in force only, so a version rebuilt past the retirement is never asked for again; the request is `catalog-retired:<versionId>`.
- **Hints in `build`.** The version's id is minted once the facts are read, before anything is written, and `hintsShown(versionId)` decides whether the writer sees hints. When it does, the counts are read once for the goal, the skin type (or none) and the shopping country, for every gap candidate's code, and `applyOutcomeHints` fills them; a corrupt row is logged as `hint-counts-corrupt` with the code only. A counts read that fails is logged (`hint-counts-failed`, the id only) and the build goes on without hints. `hints_shown` is true only for a version the writer wrote from the hinted skeleton: a rules-only routine (daily limit, three failures), a kept copy and a got-it copy record false. A build that ends `unchanged` has still used an id.

### Routines (API)

The routine reaches the app through seven routes under `/me` (`routines.routes.ts`, mounted after the verdicts; #189, PR 4b). They are thin: `RoutineViewerService` (`routines.viewer.service.ts`) is the session-facing layer over `RoutineService`'s profile-keyed methods, so a route never names a profile id. The body is `toRoutineResponse` (`routines.view.ts`, pure), written field by field in its own schema components (`routines.schemas.ts`).

- **The routes.** `GET /me/routine` (200: `{ status: 'pending' }`, or `ready` / `updating` with `startedOn`, `expectation`, `morning`, `evening`, `notInRoutine`, `tapers` and `summary`; there is no `steps`), `GET /me/routine/events` (the stream), `POST /me/routine/start` (no body, 200 + body, idempotent), `POST /me/routine/steps/{step}/got-it` (200 + body; the shelf add's two rate limiters and `cf-connecting-ip`, so 429) and `POST /me/routine/steps/{step}/find-sold-here` (202 + the `updating` body). `step` is `z.enum(ROUTINE_STEPS)`. The sixth, `GET /me/routine/steps/{step}/look-for`, is below ("What to look for"). The seventh, `POST /me/routine/check-ins`, is not served by `RoutineViewerService`: it goes to `RoutineCheckInsService` (see "Reminders", Check-ins).
- **The gates, in order, for every session method.** 401, then 403 `SIGNUP_REQUIRED` for a guest (`status !== 'verified'`; a feature lock lives in the service, not `verifiedUser()`, which answers `VERIFICATION_REQUIRED`), then 409 `GOAL_REQUIRED`, then 503 `VERDICT_UNAVAILABLE` while either step-down template of the verdict is not approved (`VerdictService.lacksTapers`; without it the routine would stay pending for ever). Note the order against the verdict's own, which answers 503 before 409. Nothing of the routine is read, and nothing subscribed, before the gates pass. The actions add 409 `ROUTINE_NOT_READY` (before there is a routine, and for Start and "I got it" also while a safety change hides it, since `GET` answers pending) and 409 `STEP_NOT_RECOMMENDED`; "I got it" on a step already marked got is a no-op that answers the routine, and "find one sold here" adds 409 `BUILD_IN_PROGRESS`.
- **A read asks for a build.** `current()` and `watch()` call `RoutineService.requestIfStale(profileId)` (never throws) and answer without waiting. `requestIfStale` (see "Routines (triggers)") asks for a build only when the inputs differ from the routine in force.
- **The plan summary.** Every version a build writes stores `shelf_counts` (`{ keep, reduce, drop, stop }`, null while pending and on a row built before the column), counted from the skeleton's shelf after normalisation (a reduced sunscreen is kept, so it counts as `keep`; an entry the build leaves out counts nowhere), so each shelf product the routine was built from is in exactly one count and the summary always matches the routine beside it. A got-it copy carries the counts unchanged; an `unchanged` rebuild whose fingerprint moved updates them on the row in force. `summary` in the body (`ready` and `updating`, and so on the event stream) is `{ goal: { id, label }, keepUsing, useLessOrChange, stepDown }` for the "Your plan is ready" screen: `keepUsing` is `keep`, `useLessOrChange` is `reduce + drop`, `goal.label` is the goal chips' label (`GOAL_LABELS` in the goals vocabulary, which onboarding reads too), and `stepDown` is null when no step-down is shown, otherwise the brands and names of the `tapers` shown (a taper whose template is missing is in neither) and the fixed reviewed sentence from `routines.copy.ts` ("Stopping X suddenly can make your skin flare...", names joined as "X", "X and Y" or "X, Y and N more"). `summary` is null for a version with no stored counts; it is never counted from the steps and step-downs the version holds, and gets its counts at the next appended version or the next unchanged rebuild. A product name the wording gate would catch is not put in the sentence: it says "this product" (one) or "these products" (several); the `products` list still names them.
- **The Your routine screen.** `morning` and `evening` are two ordered lists (cleanse, treat, moisturise, protect) of entries `{ step, title, when, reason, changed, product }` (`routines.view.ts`; no `frequency`, and actions still use each entry's `step`). Placement: `am` is morning, `pm` evening, `am-pm` both (the same entry in each list), `alternate-days`, `weekly` and `as-needed` evening, and the sunscreen (`protect`) is morning only whatever it is stored as. `when` is fixed copy (`whenFor`, `routines.copy.ts`): `am`, `pm` and `am-pm` are "Every day", `alternate-days` "Every other evening", `weekly` "Once a week", `as-needed` "When you need it". `title` is built by `titleFor` (`routines.copy.ts`, rules only, no AI; a capital, no full stop): the step's noun (Cleanser, Treatment, Moisturiser, Sunscreen) unless the form names the product better. A sunscreen is always "Sunscreen"; a treatment takes the form for cream, lotion, gel, serum, oil and balm ("Serum"); a cleanser puts the form before its noun for gel, cream, lotion, oil, balm and bar ("Gel cleanser"); a moisturiser is "Moisturiser" whatever its form except gel ("Gel moisturiser"). A recommended product's key ingredient (its catalog row) goes in front ("Niacinamide serum", "Salicylic acid gel cleanser"; a moisturiser is "{ingredient} moisturiser" for every form); a shelf product has no key ingredient in the view, so it is titled by form and step. A product with no step is titled by its form ("Cream"), or "Product" with no form either. The form of a shelf product comes from `catalog.shelfFacts` (the viewer fills `own[].form`) and a recommended product's from its product summary; a product that cannot be shown ("use what you have") is titled by its step.
- **Not in your routine.** Every version a build writes stores `not_in_routine`, a nullable JSON column beside `shelf_counts`: `{ entryId, title, status: 'stepping-down' | 'left-out', reason }[]`, one for each product of the skeleton's shelf (in the shelf's order) whose verdict is `stop` (stepping down, with its step-down in `tapers`) or `drop` (left out). Reduced products stay in the lists. The `title` (same rule, from the product's form and the verdict's step) and the `reason` (the verdict item's own `SavedVerdictProduct.reason`, the words the verdict screen shows, read by `shelfOf` beside the skeleton's shelf) are frozen at build time and served as stored, so a product since gone from the shelf keeps its words. It is `[]` when nothing is left out and null while pending and on a row built before the column (the body then says `notInRoutine: null`: unknown, not none). It is stored, carried and refreshed exactly as `shelf_counts` is: a got-it copy carries it unchanged, a cautions-only rebuild writes it afresh from the shelf, and a rebuild that finds nothing to change writes it with the counts and before the fingerprint (`setNotInRoutine`, when the fingerprint moved or the list is null), so a failed write leaves the fingerprint unrecorded and the next attempt writes both.
- **What the body shows.** A step's `product` is `own` (a shelf entry, with its brand and name), `recommended` or `none`. A recommended product has its brand, name and image from the catalog, its price range and `whereSold` in the shopping country (the currency of that country), `soldInCurrentCountry`, `soldElsewhere` (country codes), `keyIngredient`, `strength`, `notYetGot` and, only for a brand's submission, `origin: 'brand-submitted'`. A product the shopping country does not sell, or that is draft or retired, stays on the screen with `soldInCurrentCountry: false`, no price or place, and no `soldElsewhere` when it is not approved. Grounding, `fixedFrom`, source links, the model and prompt, fingerprints and the workbook's audit columns are never mapped. `startedOn` and a step-down's dates (`fromDate`, `toDate`) are the stored calendar dates, printed as they are (the person's local dates once a zone is stored, fixed when set; see "Reminders"). They count from that step-down's own `startedOn` (one begun after Start begins the day of its rebuild) and are absent before Start; a step runs from the first day of its first week to the last day of its last week. A step-down whose shelf product has left the shelf is still shown, under its stored `entryId`, `brand: null` and the name "A product you're stepping down"; one whose template the workbook no longer holds is dropped and logged (`routine-taper-template-missing`, profile and template ids).
- **Changed since last served.** `changed` is true for a step whose product or frequency differs from the same step of `lastServedBefore(profileId, version.id)` (a new step also counts); a reworded reason or a new `gotIt` does not, nor does the swap of a recommended product for the user's own shelf entry of the same formulation (story 30; the `own` map carries each product entry's formulation id and `recommended` is read for the previous version's codes too). Nothing was served before: nothing is changed. The version shown is marked served (`markServed`, only when it was never served) by `current()` and the `watch()` snapshot, after the flags are worked out; a failed mark is logged by ids and never fails the read. `start`, `gotIt`, `findSoldHere` and the stream's later frames never mark.
- **Find one sold here.** The step must hold a recommended product that the shopping country does not sell (a retired product counts); then `request(profileId, 'sold-here', 'sold-here:<versionId>:<step>', { exclude: { step, code } })` queues the build, whose message carries `exclude` for `run` to hand to `build`. The answer is the routine in force as `updating` (202). When routines are on and `request` queued nothing (another build or a read's own request holds the profile's claim, which drops a request made mid-build, or the same step was asked again while its build waits), the exclusion would be lost silently, so it is 409 `BUILD_IN_PROGRESS` with a plain "try again in a moment"; the viewer is given `enabled` (the same switch as the service) for this. With routines off nothing is ever queued and the answer stays 202.
- **What to look for.** `GET /me/routine/steps/{step}/look-for` (`RoutineViewerService.lookFor`, #217 PR 2; screens 4.7 and 4.8) answers `{ category, guide: { whatItDoes, lookFor, forDeeperSkin }, typicalPrice: { low, high, currency } | null, commonlySoldAt, products }`. A read only: it asks for no build and marks nothing served. After the four gates it answers 409 `ROUTINE_NOT_READY` (no routine to show, a safety change that hides it included), 409 `STEP_IS_YOURS` (the routine's entry for the step is the person's own shelf product, so nobody is pushed to buy a replacement) and 503 `GUIDE_UNAVAILABLE` (`CatalogWorkbookService.guideFor` has no approved row for the step; copy is never invented), in that order. A recommended step and a "use what you have" step both answer. `category` is `titleFor` with no form (Cleanser, Treatment, Moisturiser, Sunscreen). `guide` is `guideFor(step, goal)` (the goal's row, else the step's base row); `lookFor` is the row's `lookForWhenPregnant` when `SafetyService.currentOrNull()` says `excludesPregnancyCaution` (pregnant or breastfeeding) and the row has one, and the pregnancy text itself is never a field. `products` are `RecommendationService.candidatesFor({ step })` as they come, with no filtering written here: the routine's pick first when it is a candidate (`inYourRoutine: true`; a pick that is not one, because it is sold elsewhere now or retired, is not shown), then the rest cheapest first, at most ten with the pick counted. `aboutPrice` is the candidate's `priceMin` in the shopping country's currency, `origin: 'brand-submitted'` appears only for a brand's submission, and `why` is fixed copy (`routines.look-for.ts`, no AI): "Works on X, Y and Z." from the candidate's concerns that the goal also has, in the goal's order (`concernsForGoal`), worded in plain seen-words, or one generic line that names no concern when none overlap. Every possible line is tested against `FORBIDDEN_WORDING`. `typicalPrice` (lowest `priceMin` to highest `priceMax`, null with no candidates) and `commonlySoldAt` (up to three `whereSold` texts, most frequent first, a tie alphabetical, a null counting for nothing) are over all the candidates, not only the ten shown. Evidence links, ingredients, how a candidate was reached, fingerprints and the guide row's audit columns are never served. `RoutineViewerService` reads `safety` for this, and `container.ts` passes it.
- **What each entry is doing** (#233, PR 4a). Every entry of `morning` and `evening` has a `status`: `active`, `paused`, `held` or `bringing-back`. It comes from the skin-care module's state, which the viewer asks (`deps.skinCare.stateFor(profileId, today)`, required; `today` is the person's LOCAL day from `deps.reminders.zoneFor`, UTC with none) in `inputFor`, so the read, the stream's frames and `reminderPlanFor` all agree. A pause names a step and a product key (the catalog product id, else the shelf entry's id for a product with no label), and marks the entry at that step whose product (the shelf entry's, or the recommended row's) has that key; `held: true` marks only the entries whose product holds an active group, and wins over a `bringing-back` pause that names the entry (a `paused` pause stays `paused`; both are left out of the reminders anyway) (retinoid, exfoliating-acid or benzoyl-peroxide, read from the ingredients with `rulesMatching` over `verdictReference().rules`, which carry their group, as the verdict floor does). The body follows the rung, never more often than the step's own frequency (`FREQUENCY_STRENGTH` in `catalog.vocabulary.ts`, the order the workbook checks ladders and step-downs against; a weekly step on a ladder that climbs past weekly stays weekly until the ladder ends; a tie keeps the step's own): a bringing-back entry's `when` is its rung's frequency and the rung decides whether it is in `morning` or `evening`, exactly as for `reminderPlanFor`, which leaves paused and held entries out and gives a bringing-back entry its rung's `frequency` and an `anchor` day; `dueOnDay(frequency, anchor, day)` (`catalog.frequency.ts`, shared with the send job) counts from `entry.anchor ?? plan.dayOne`. **The read fails closed**: if `stateFor` throws, the routine read, `start`, `gotIt`, the stream's opening snapshot and `reminderPlanFor` all fail (a 5xx), and a version is not marked served; a paused step is never shown as active. `announce` logs the failed frame and sends no `routine` frame. One unreadable plan skips only that profile's reminder: its own queue message throws and is retried (`sendForProfile`; `sendDue`, the old loop, logs `profile-failed` and carries on). The container wires `deps.skinCare` to `SkinCareService`, whose `stateFor` answers the open pauses (see "Skin care"); until a hold exists `held` is false. `skinCareRoutineFor(profileId)` answers the module's narrow read of the routine in force (`SkinCareRoutine`, `skin-care.types.ts`, which routines imports and skin-care never imports routines for): null while pending; by profile id with no gates, no build asked for, nothing marked served, and never `stateFor` (which reads it). `stepDownProgressOf(tapers, templates, today)` (`routines.view.ts`) is the step-down arithmetic shared with the schedule screen: step n of m, whether it is still running, and the next change day.
- **Today** (#233, PR 7). `GET /me/today` is `RoutineViewerService.today()`, with the same gates as `GET /me/routine` (`gatedWithGoal`) and no build, no `markServed`. It reads, for the person's local day (`usableZone` in `lib/local-day.ts`: a stored zone Intl cannot read is UTC, here and in `RoutineCheckInsService.checkIn`; skin-care's `dayOf` has its own fallback): the zone and the reminders switch in one read (`RemindersService.zoneAndEnabledFor`), `skinCare.stateFor`, then `skinCare.checkInsDue` (**after** the state, which ends ladders and replaces pauses, so a row it settled is never listed as due), the routine in force, the inbox summary and the day's check-ins. **Skin-care fails closed** (a throw from `stateFor` or `checkInsDue` fails the read); **the inbox does not** (an unreadable inbox is logged `{ outcome: 'today-inbox-failed', profileId }` and shown as `{ unread: 0, latest: [] }`). The halves split at a fixed 15:00 local (never the reminder time); the entries come from `toTodayLists` (`routines.view.ts`), which leaves out paused and held steps and puts only what is due that day in the evening, by the arithmetic of `dueOnDay`; a half with no entries counts as done. `paused` lists the open `paused` and `escalated` pauses (`pauseId`, `checkDay` ride on `SkinCareState`) and `bringingBack` the rungs (`rung`, `of`). **Known duplication, for a follow-up:** `today()` builds the routine input through `aroundVersion`/`overlaid`, as `skinCareRoutineFor` and `reminderPlanFor` do, so the shelf, catalog and workbook reads around a version are repeated between them; they are not yet shared.
- **The stream** is the Durable Object `ScanStream` keyed `routine:<profileId>` (`{ type: 'routine', routine }` in `ScanEvent`; the frame is named `routine`). It opens with the body `current()` answers, is read once more when open (a build that landed in between is sent), and ends with `done` after a `ready` routine; `pending` and `updating` leave it open for the build's frame. `RoutineService` is given `announce(profileId)`, wired lazily in `container.ts` to `RoutineViewerService.announce` (the viewer reads the service, so a direct dependency would be a cycle). It is called after a build's pending version is appended, after `complete`, and after every direct ready append (the rules-only daily limit, the cautions-only copy, "I got it"), never on `unchanged` or `waiting`, each in a try/catch that logs the profile id only. `announce` publishes the body and, when ready, `done`, and never marks a version served.

### Routines (outcome counts)

`routine_outcome_counts` (`routines.outcome-counts.table.ts`, `D1OutcomeCountsRepository` in `routines.outcome-counts.repository.ts`, spec #189) holds what happened to users who had a product in their routine at the review point: one row per `(goal, skin_type, country, code)` with `n`, `fainter`, `flared`, `flared_or_stopped` and `fainter_and_flared_or_stopped` (the `OutcomeCounts` of `routines.outcomes.ts`). `skin_type` is `''` for users with no face scan, so it can be part of the key; a null skin type maps to `''` both ways. There are no foreign keys: the counts are about groups, not accounts.

- **Empty for now.** Nothing fills the table yet; a later collector will (`upsert` replaces a row). Until then every lookup finds nothing and every candidate has no hint.
- **Hints.** `applyOutcomeHints(skeleton, counts, shown)` (`routines.hints.ts`, pure) fills each gap candidate's `outcomeHint` from its row. A hint exists only for 30 or more users (`MIN_USERS`); a missing row, a smaller group or a corrupt row gives no hint, and one bad row never costs the routine.
- **Held-back tenth.** About 1 in 10 routines are built without hints, chosen by `hintsShown(versionId)`, so the same version always answers the same and the hidden tenth can be compared with the rest. When hints are not shown the lookup is skipped. `RoutineService.build` does this (see "Routines (triggers)").

### Routines

`src/modules/routines` is the routine stage (#152, #189): the contracts, schema, gates and rules are pure code, the storage above holds its two repositories (versions and outcome counts), and the service above is reached by the routes in "Routines (API)". Its pure code imports only types and vocabularies (`catalog.vocabulary`, `face-scans.tables`, `goals.vocabulary`, `safety.vocabulary`, the `Candidate` type from `recommendations.types`), the goal answers (`goals.answers`, for the rules-only expectation), `lib/crypto` and `lib/stable-json` (the fingerprint), and `zod`. The rules (`routines.rules.ts`) import nothing from the checker; the gates import the rules. The writer is a provider (below).

- **Contracts.** `routines.types.ts` holds `RoutineSkeleton` (what the rules decided: shelf verdicts, gaps with their safe candidates, limits) and `Routine` (what the AI writer answers). They are the seam between the rules, the writer, the eval and, later, production. `SkeletonCandidate` has no `origin` field on purpose: who paid for a review must never reach a choice.
- **Schema.** `RoutineSchema` (`routines.schema.ts`) is made of closed zod objects; an extra field is a parse failure. Its product is a `z.union` so the JSON Schema sent to Claude has `anyOf`.
- **Gates.** `checkRoutine(skeleton, routine: unknown, carriedTapers = [])` (`routines.gates.ts`) returns `[]` or every `GateFailure` (a fixed code and a step, never model text), gate by gate in a fixed order (parse, unknown-product, stopped-product, dropped-product, over-reduced, taper, too-many-new, frequency, order, gap, unused-shelf, grounding, wording), and within a gate in entry order. A routine that does not parse fails `parse` alone. `FREQUENCY_RANK` ranks frequencies for the over-reduced check; it lives in `routines.rules.ts` (so the rules do not depend on the checker) and `routines.gates.ts` re-exports it for the eval's tests.
- **A step-down survives its product's removal** (#259, PR B4). A stopped product is stepped down, never stopped suddenly, and taking it off the shelf in the app does not end the person's use of it. The skeleton holds only the active shelf, so the step-down must not be recomputed away. On a rebuild of a **started** routine (and in the stale read, below) `RoutineService.removedTapersOf` keeps a previous step-down, with its `startedOn` and template unchanged, when all hold: its shelf entry is removed with reason **null or `finished`** (an allow-list: `stopped`, `not-mine` and any reason added later end it); it had begun (`startedOn` set; one that never began is not carried, so a removal never starts it); and its template's last schedule week has not passed on the person's local day (begun on D, last week W: it runs through D + 7W - 1, the viewer's `running`, and is gone from the rebuild on D + 7W). A template the workbook no longer holds ends it too. The removed entries and their reasons come from `ShelfService.removedEntriesFor(profileId)` (by profile id, no session, not capped; `ShelfRepository.removedFor`, earliest removal first, ties by id) and the length from `CatalogWorkbookService.tapersByCode`, both already whole services in `container.ts`'s `RoutineService` wiring, so routines gains two `Pick` entries and no import. The carried list goes to `stableMerge` as the optional `StableCarry.removedTapers` (after the shelf's own stops in `carriedTapers`, as they were) and to the taper gate as `checkRoutine`'s third argument, so the gate expects each beside the stops: nothing else about the taper rule changes, and the writer's answer is ignored for tapers as before. Two things ride with it. The version's `notInRoutine` keeps the previous version's row for each carried product (its title, `stepping-down`, its reason), so the viewer titles the step-down as it was built instead of falling back to "A product you're stepping down"; a list set in place on an `unchanged` build gets it too. And the `tapering` caution stands while a carried step-down runs (`assembleSkeleton`'s `carriedTaper`, `cautionsOf`'s third argument), so the writer and the cautions the screen shows still say a step-down is under way. **Fingerprint:** the removal reason is not an input, since a removed entry keeps its first reason and so no later change of reason can need a rebuild; taking the stopped product off the shelf removes it from the fingerprint's shelf, so the routine is stale and rebuilds, and the rebuild keeps the step-down. The reason does decide whether `tapering` is a caution, and cautions are fingerprinted, so `requestIfStale` asks `removedTapersOf` too: build and read must derive the same cautions or every read would queue another build. The end of the last week is noticed on the next read only when the carried step-down is what kept the `tapering` caution (the caution goes, the fingerprint moves, a rebuild drops it); with another stopped product still on the shelf the caution stays, and it is dropped at the next rebuild for another reason. **A product put back:** when a going-on step-down's product is added back as a new entry of the same catalog product that the rules stop on the same template, the new entry continues the step-down (`removedTapersOf`'s `continuedAs`: the previous version's taper is read under the new entry's id, so it keeps its `startedOn`) and the copy for the removed entry is dropped, so there is one step-down under the product's real name and it never restarts at week 1; `ShelfService.removedProductIdsFor(profileId, entryIds)` gives the removed entries' products, read only when a going-on step-down and a stop on its template are both there. A removal that ended the step-down (`stopped`, `not-mine`, a later reason, or past the last week) does not continue: the stop begins a new one. **Reads:** the removed entries are read only once a begun step-down is missing from the active entries already in hand, and the local day is read once per build. The step-down order is not a change: a rebuild that only reorders them (a carried one lists after the shelf's own) writes no copy version.
- **Verdicts.** A shelf product's verdict is keep, reduce (with a frequency cap), stop (with an approved taper template) or drop (leave it out, no taper). The verdict screen's groups map to them: helping is keep; conflicting is reduce or drop; blocking the goal is stop or drop; redundant is drop; likely the problem is stop. A shelf entry must be keep or reduce, so using a stop or drop product fails `unknown-product` as well as `stopped-product` or `dropped-product`. A taper for a drop product is an extra taper and fails `taper`.
- **Use what the user owns.** `unused-shelf` fails once per shelf product that is keep or reduce, has a step, and has no entry at its own step naming it (the failure's step is the product's step, in shelf order). A kept product with no step never fails it; stop and drop products never do. So the routine is built mostly from the shelf and a new product is only for a gap.
- **Wording.** `FORBIDDEN_WORDING` (`routines.wording.ts`) is a starter list of condition names, diagnosis phrasing, lightness-as-outcome and grades/scores (CONTEXT.md, Safety). Its patterns are never global or sticky.
- **Grounding is internal only.** `RoutineEntry.grounding` lists the links a reason drew on and is checked against the chosen product's own links; it must never appear in an API response or on a screen.
- **One skeleton builder.** `assembleSkeleton(input)` (`routines.skeleton.ts`) is the pure function from facts already read (the goal, the scan's seen and also-noticed concerns, skin type, budget band, safety choices, the shelf with its verdicts, each step's candidates in the order the recommendation rules gave them, whether outcome hints were shown) to a `RoutineSkeleton`: the steps, a gap for every step no kept or reduced shelf product fills, `limits`, and a copy of everything it was given. `cautionsOf(safetyChoices, shelf)` (the safety answers plus `tapering` when a shelf verdict is stop, in a fixed order) and `candidateOf` (drops `origin`) sit beside it. Production's builder and the eval (`scripts/eval/routine-skeleton.ts`) both call it, so a skeleton means the same in both.
- **A reduced product follows its cap at any step except protect.** The clash reduce is `maxFrequency: 'alternate-days'`, which cleanse, moisturise and protect do not usually allow. `assembleSkeleton` keeps such a product as reduce (it still fills its step) and, when no frequency in the skeleton's `limits.allowed[step]` is within the cap, appends the cap itself to that skeleton's list, once and after the usual ones. `ROUTINE_ALLOWED_FREQUENCIES` is never changed, and a skeleton with no such product is untouched. So the routine agrees with the verdict screen; nothing is dropped to make a gate pass. **A sunscreen is never reduced: sun protection stays daily.** A reduced shelf product at `protect` is normalised to keep, used every morning, and `allowed.protect` stays `['am']`, so the morning-only gate is untouched.
- **`reducedFrequencyFor(allowed, maxFrequency)`** (`routines.rules.ts`) is the most frequent of `allowed` whose `FREQUENCY_RANK` is within the cap (the first listed wins a tie, as am and pm are level), or null when none is. The assembler uses it to see whether a cap needs allowing; the rules-only routine uses it on the skeleton's own `limits.allowed[step]`.
- **The routine fingerprint.** `routineFingerprint({ goal, cautions, products, rulesVersion })` (`routines.fingerprint.ts`) is a sha-256 of the stable JSON of those inputs only, with cautions and products sorted so order never matters and each product's whole verdict hashed. The face scan's bands are deliberately not an input: a rescan alone must not rebuild a routine.
- **The rules-only routine.** `rulesOnlyRoutine(skeleton)` (`routines.rules-only.ts`, words in `routines.copy.ts`) is built by code for when the writer cannot be used: a kept product at the step's usual frequency, a reduced one at `reducedFrequencyFor` within its cap, each gap its first (cheapest) candidate at its own frequency when allowed (else the step's usual) or "use what you have", no grounding, a taper for every stopped product, and the goal's `howLong` answer as the expectation. Its reasons are one fixed line per step and kind, about the product's place and never the person. A test checks that `checkRoutine` accepts it for a spread of skeletons and that every line passes the wording gate.
- **`FaceScanService.seenFor(profileId)`** gives the routine's inputs from the profile's latest ready scan: `seen` (as the verdict reads them), `alsoNoticed` (the other measured concerns that can be seen) and the scan's `skinType`; nothing of an older scan is mixed in, and it is empty with a null skin type when there is no ready scan. It is by profile id with no session or consent, for a job, and reads only; `latestConcernLevelsFor` and what the verdict reads are unchanged.
- **The writer.** `RoutineWriter` (`providers/routine-writing/`, `write(skeleton, retry?): Promise<Routine>`, where `retry` is `RoutineRetry` `{ failed: GateFailure[] }` and adds one extra user block naming each failed gate and step, nothing the model wrote; an empty list or none sends the first-attempt request byte for byte; it is a second attempt after the gates found something, never a place for the failed routine or any model text) is implemented by `AnthropicRoutineWriter` (job `write-routine`, model `ANTHROPIC_MODEL_ROUTINE`, prompt `src/prompts/routine-writer.write-routine.md`, `max_tokens` 8192 because Sonnet's adaptive thinking counts against it) and faked by `MemoryRoutineWriter` (`respondWith`, `calls`, `retries`, `failNextWith`). The skeleton goes in the user message as JSON, never in the system prompt. What is sent to Claude is `routineSchemaFor(skeleton)`: `RoutineSchema`'s shape narrowed to the skeleton, with enums for its steps, kept and reduced shelf ids, every candidate code, stop ids and their templates, and the allowed frequencies, so a misspelt code fails to parse instead of reaching a gate (a kind with nothing to choose is left out of the product union, and `tapers` is a plain list of strings when nothing is stopped, because the API refused an empty tuple's `prefixItems` and the taper gate rejects any taper then; an empty steps list or no allowed frequency falls back to the full vocabulary, because an enum cannot be empty). Its product is a plain `z.union` (not a `discriminatedUnion`), because the structured-outputs docs list `anyOf`, which `z.union` emits, and do not list `oneOf`, which a `discriminatedUnion` emits; a test keeps `oneOf` out of the schema sent. `client.structured` parses the reply with it and the adapter checks it against `RoutineSchema`, the contract; a reply that does not fit is `AnthropicRequestError`, never a partial routine. **The adapter does not run the gates: the caller runs `checkRoutine` on what it returns before anything uses it.** It logs nothing.

### Reminders

`modules/reminders` holds `reminder_settings` (migration 0045), `D1RemindersRepository` and `RemindersService` (#217, PR 3). It stores when a profile wants to be reminded and in which time zone; nothing is sent from it (the sends are `ReminderSendsService`, below; check-ins are below too). `enabledFor(profileId)` is the by-id, no-session read of the `enabled` switch (false with no row) that the notification send uses, and `listEnabled()` on the repository is every row with reminders on, the send job's one query. Three more by-profile-id reads serve the notification send and the send job: `stepDownAlertsFor` and `missedDaysNudgeFor` (reminders on AND the kind's own switch; false with no row, and while reminders are off whatever the own switch says, since a new row starts with both alerts on) and `missedDaysChannelFor` (below).

- **Settings are per profile**, one row each (`profile_id` PK, cascade, so profile and guest cleanup need no cleaner): `enabled`, `morning`, `evening` (24-hour `HH:MM`), `time_zone` (nullable), `step_down_alerts`, `missed_days_nudge`, `enabled_on` (migration 0049). No row means the defaults (`enabled` false, `07:00`, `21:00`, no zone, both alerts on); reading writes nothing, and the first change writes the row. `upsert(profileId, patch, at)` writes only the fields named, in one statement; a `timeZone` of `null` is a value (it clears the zone), `undefined` is "not named".
- **`enabled_on`** (#217, PR 4c; nullable text, never in the API) is the person's local calendar day (`localDay(now, zone)`, UTC with no zone) on which `enabled` last went from off, or no row, to on: `RemindersService.update` stamps it in the zone the row will have (the one in the PUT, else the stored one). It is kept while `enabled` stays on, so a `timeZone`-only PUT or a repeated `enabled: true` moves nothing, and turning reminders off and on again stamps the new day (it is left as it was when they go off). The repository only stores it. The migration stamps the rows that already had reminders on with the migration day (UTC), so none is nudged at once for days before it. The missed-days nudge counts from it (below).
- **Routes**, all bearer, under `/api/v1/me` and tagged "Reminders": `GET /reminders` and `PUT /reminders`, both `{ enabled, morning, evening, timeZone, stepDownAlerts, missedDaysNudge, missedDaysChannel }`. `PUT` takes any non-empty subset of the first six (a body of only `timeZone` is fine: the phone sends it when its zone changes). The body schema is strict, so `missedDaysChannel` (read-only) and any unknown field are 400 `VALIDATION_FAILED`, as is an empty body. `PUT` carries `signedIn()` so an unsigned caller is 401 before the body is read.
- **Gates, in order:** 401, 403 `SIGNUP_REQUIRED` for a guest (the same check and code as the routine service), then the service's validation (400 `VALIDATION_FAILED`; a refused call stores nothing). Over HTTP the route's body schema runs before the service, so a body of the wrong shape (an empty body, a wrong type, `missedDaysChannel` or another unknown field) is 400 even from a guest; the 403 comes first only for a well-formed body. The service checks that a time matches `HH:MM` (24-hour) and that a time zone is one `Intl.DateTimeFormat` resolves. The zone is stored under its canonical name (`africa/lagos` becomes `Africa/Lagos`, read from `resolvedOptions().timeZone`); a fixed offset (`+01:00`, `UTC+1`) is refused, since it is not a place and would be wrong when the clocks change.
- **`missedDaysChannel`** is `whatsapp` only when WhatsApp is an enabled OTP channel here (`parseOtpChannels(env.OTP_CHANNELS)` includes it, computed in the container and passed as `whatsappEnabled`) AND the account's user row has a phone; otherwise `push`. A verified WhatsApp address is exactly a stored phone (a phone is only ever stored by verifying a WhatsApp code), so there is no separate concept. It is worked out at each read and never stored. Today `OTP_CHANNELS` is `email` everywhere, so it is always `push`. `missedDaysChannelFor(profileId)` is the same rule by profile id with no session: it finds the account through `ProfilesService.find` (a dependency of `RemindersService`) and answers `push` for an unknown profile.
- **The reminders-off row** (#233, PR 8b). `update` that turns reminders from on to off writes one inbox row, `reminders-off:{day}` (kind `reminders-off`, link `/routine`), for the local day in the zone the row has after the update (so a zone named in the same call counts; UTC with none), so a day has at most one however often they are switched. Off when already off, never on, or any change that leaves them on writes nothing. The row is not the update: the required `inbox` dep (`Pick<InboxService, 'write'>`) is written after the settings are stored, and a failure is logged `{ outcome: 'reminders-off-inbox-write-failed', profileId }` and the call still answers the settings. The words are fixed text awaiting the owner's sign-off.
- **`zoneFor(profileId): Promise<string | null>`** is the reader other modules use: by profile id, no session, null while none is stored (or for an unknown profile). Reminders must not import routines; the routine service and PR 4's sends take it as `Pick<RemindersService, 'zoneFor'>`.
- **Local days** (`lib/local-day.ts`, pure, `Intl` only): `localDay(now, zone)` is the calendar day as `YYYY-MM-DD` (null zone is UTC), `localDate(now, zone)` the same day as the UTC midnight `Date`, and `nextLocalDay` / `startOfLocalDay` the UTC instants the next / this local day begins. A local day is not always 24 hours (23 or 25 where the clocks change), so the edges are found by searching for the instant the local date changes, never by adding hours.
- **Dates are calendar dates, frozen when set.** The zone only decides what "today" or "tomorrow" is at the moment a date is written. `routine_versions.started_on` and each step-down's `startedOn` hold the UTC midnight of the person's local calendar date (older rows already are UTC midnights of their UTC date, so no migration): Start stores `localDate(nextLocalDay(now, zone), zone)`, and a step-down that begins after Start is dated `localDate(rebuild time, zone)` (never before day 1). Nothing derives a date from the stored zone afterwards, so a phone that reports its zone after Start, or a traveller whose zone changes, moves no date; the routine response prints the stored date as it is. A later feature that asks "is this the day?" (PR 4's reminders and check-ins) takes `localDay(now, current zone)` and compares it with these stored dates.

- **Check-ins** (#217, PR 4a; `routines.check-ins.*`, migration 0046). `routine_check_ins` holds "I did my morning (or evening) routine" for one local day: PK (`profile_id`, `day`, `time`), `day` the calendar date `YYYY-MM-DD` (text, fixed when the check-in is made), `time` `morning` | `evening`, `at` the moment of the first check-in. Cascade with the profile. `D1RoutineCheckInsRepository` (`RoutineCheckInsRepository = PublicOf<...>`, with `CheckInRow` and `CheckInTime`): `record(profileId, day, time, at)` is `ON CONFLICT DO NOTHING`, so a repeat is idempotent and keeps the first `at`; `list(profileId, from, to)` is inclusive at both ends and ascending by day. `latestDay(profileId, from, to)` is the latest checked-in day in the inclusive range (either time), or null: `ORDER BY day DESC LIMIT 1`, served by the primary key, and what `missedStreak` reads so a per-profile job never loads the history. The contract (`routines.check-ins.repository.contract.ts`) runs against the fake and D1. `CHECK_IN_TIMES` lives in `routines.check-ins.vocabulary.ts`, not the table file, because a schema may not import a table's value (`db-only-in-repositories`) and the route's body schema needs the list.
- **`POST /me/routine/check-ins { day, time }`** (tag "Routine", `signedIn()` so an unsigned caller is 401 before the body is read): 200 `{ day, time }`, and a repeat is the same 200. `RoutineCheckInsService.checkIn` gates in order: 401, 403 `SIGNUP_REQUIRED` (a guest), 409 `ROUTINE_NOT_STARTED` (the routine in force, `versions.current`, has no `startedOn`; no goal or verdict gate), then 400 `VALIDATION_FAILED` unless `day` is a real calendar date that is today or yesterday in the person's local day (`localDay(now, zoneFor(profileId))`, UTC with no zone) and is not before day 1. The route's body schema also gives 400 for a bad `day` or `time`, and runs before the service, so a guest sending a malformed body gets the 400. A refused call stores nothing. Either time of day makes a day done. **The all-done row** (#233, PR 8b): the check-in after which every half of the day that has entries due is checked in (and at least one half is) writes one inbox row, `all-done:{day}` (kind `all-done`, link `/routine`), where `day` is the check-in's own day (yesterday's when yesterday is what was checked in). The key makes a repeat of either check-in a no-op. A half with nothing to do counts as done: the morning has entries when the routine's morning is not empty, the evening when some evening entry is due that day (`dueOnDay`, from `reminderPlanFor`, the `routine` dep, the viewer in the container); a routine that cannot be read asks for both halves. It is read from the check-ins stored (`checkedTimes(profileId, day)`, also what the reminder job reads for a rest night) after `record`; `inbox` and `routine` are required deps, and a write that fails is logged `{ outcome: 'all-done-inbox-write-failed', profileId }` and the check-in still answers 200. The words are fixed text awaiting the owner's sign-off.
- **`missedStreak(profileId, today)`** is the read PR 4b's job takes (by profile id, no session; `today` is the person's local day the job worked out): `{ days, since }` for the consecutive missed days ending yesterday. A missed day is on or after day 1 with no check-in at either time; today never counts and a check-in made today does not change it. `since` is the first missed day of the streak (the dedup key for one nudge per streak). `{ days: 0, since: null }` before Start, on day 1, and when yesterday was checked in. It is pure calendar-date arithmetic on the stored `started_on` date and the stored check-in days: it reads neither the clock nor the zone, so a later change of zone moves no earlier day. The sends are below.

- **The fan-out** (#233, PR 8a). Each profile costs about 15 D1 calls and Lagos at 07:00 is one spike, so the 15-minute cron no longer does the profiles' work. `createReminderSend` (`jobs/scheduled.ts`) calls `ReminderFanOutService.fanOut(new Date(controller.scheduledTime))` (`reminders.fan-out.service.ts`), which runs exactly one D1 statement, `RoutineService.startedProfiles()`: every profile with any `routine_versions` row whose `started_on` is set (distinct; the partial index `routine_versions_started_idx` on `(profile_id) WHERE started_on IS NOT NULL`, migration 0054, serves it from the few Started rows) LEFT JOIN `reminder_settings`, answering `{ profileId, enabled, morning, evening, timeZone }` (the settings null with no row). **The pre-filter.** Most profiles have nothing due in a given quarter hour, so the cron queues only those with a reminder time due in the slot, by `dueReminders` (`reminders.slot.ts`), the one pure function that also decides what `sendFor` sends, so the two cannot disagree about a slot (the window is the 15 minutes up to and including the slot). A profile with no settings row, or with reminders off, is counted by the defaults, 07:00 and 21:00 in its stored zone (UTC with none), because the inbox lines of PR 8b are written for it at those times; the consumer still sends it no push. This cuts the messages, and the consumer's D1 writes, by about 98%, and keeps a backed-up `push-delivery` from queueing every started profile behind the few that are due. A profile whose stored zone Intl does not know is logged `{ job: 'reminder-send', outcome: 'profile-skipped', profileId }` and skipped, and the others go on. The due profiles are queued as `reminder-profile` messages on `push-delivery` with `JobQueue.enqueueBatch`: the Cloudflare adapter sends at most 100 a `sendBatch`, makes no call for an empty list, tries a chunk that fails up to 2 more times, goes on to the next chunk if it still fails, and throws the first error at the end (a failed scheduled run is not retried, so a chunk that never went is a quarter hour missed for its profiles). The cron sends no push and makes no claim. A queue that refuses a batch fails the run, logged `{ job: 'reminder-send', outcome: 'failed', error }` (the error by its class, `describeError`) and rethrown. The run logs `{ job: 'reminder-send', outcome: 'done', queued }` (profiles queued) on every run. The flow is cron → `push-delivery` `reminder-profile` → consumer (`send-push` handler) → `ReminderSendsService.sendForProfile(profileId, new Date(slot))`, which re-checks everything: it reads the profile's settings row (none or reminders off: counted by the default times, see "The inbox rows" below), works out what is due itself, writes the inbox rows, and does what `sendDue` does for that profile (the same gating, claims, pushes and nudge, in the same order, through the same private `sendPushes`), always from `slot` and never from the clock for what is due. **The stale-slot guard.** A message whose slot is more than 30 minutes before the moment it is handled is dropped, logged `{ job: 'reminder-send', outcome: 'stale-slot', profileId }` and answered 0 (acked, nothing sent): a backed-up queue must not send a reminder for a time long gone, and a skipped slot is not made up. A stored zone Intl does not know (a `RangeError` from the due computation only) is logged `profile-skipped` and answers 0, since a retry cannot mend it. Unlike `sendDue`, any other failure is not swallowed: it throws, the dispatcher releases the run and the message is retried (5 attempts, then the dead-letter queue). Nothing is claimed before the reads that can fail (routine, check-ins due, phone), and a claim made before a later failure is kept, so a retry sends what is left and never sends a push twice (the dispatcher's key `reminder-profile:<profileId>:<slot>` and the `reminder_sends` claims both hold; the claims alone suffice if `job_runs` is purged). A push whose enqueue fails is still logged and swallowed by `NotificationsService`, so its claim is kept as before. `sendDue` stays (its tests and the equivalence test run it as the "before" path) but nothing in the Worker calls it (it is a test-only reference path, marked so in its doc comment, and must not be re-wired: it writes no inbox rows, so its pushes carry no `inboxId`).
- **Sends** (#217, PR 4b; `reminders.sends.*`, migration 0048). `ReminderSendsService.sendDue(now)` is the per-profile loop the 15-minute cron ran before the fan-out above; `sendForProfile` is its one-profile form (given `new Date(controller.scheduledTime)` so a Worker that starts late still looks at its own quarter hour; it needs no actor). It reads `listEnabled()` once, and for each profile that has a time due it reads the routine (`reminderPlanFor`, below), asks `NotificationsService.hasPhone`, reads the routine, claims, and queues `routineReminder`, in that order; it answers how many it queued. One profile's failure is logged `{ job: 'reminder-send', outcome: 'profile-failed', profileId, error }` (the error's class only: no text, title, token or zone) and the others carry on. The handler logs `{ job: 'reminder-send', outcome: 'done', queued }` on every run and, on a throw, `{ job: 'reminder-send', outcome: 'failed' }` with no error text, then rethrows. Three kinds of push are queued from here: the daily push (PR 4b), the step-down alert and the missed-days nudge (PR 4c, below).
  - **The claim.** `reminder_sends` holds one row per (`profile_id`, `local_day`, `kind`), `sent_at`, cascade with the profile. `kind` is free text (`morning` or `evening` today), so later kinds need no migration. `D1ReminderSendsRepository.claim(profileId, localDay, kind, at)` is an insert with `ON CONFLICT DO NOTHING ... RETURNING`: true when this call inserted the row, so of several overlapping runs exactly one queues the push. The claim comes after `hasPhone` on purpose: a window with no phone claims nothing, so a phone that registers before it closes is still sent to.
  - **The window.** A time `HH:MM` is due when the profile's local time (its stored zone, UTC while none) is in `[time, time + 15 minutes)` of real time. It is worked out from the wall clock at `now` and at `now - 15 minutes`: due when the first has reached the time and the second has not (compared as `YYYY-MM-DDTHH:MM`, for today and for yesterday, so a time just before midnight is still sent on the day it belongs to). So a time the clocks skip (01:30 where 01:00 to 02:00 does not exist) is due at the first run past the gap. On the day the clocks go back, a time before 01:46 happens twice and is due on both passes (the second is refused by the claim), while one from 01:46 to 02:00 is due only at the 02:00 UTC run, once. `day` in the push is the local day the time belongs to. The two readings are made once per zone per run.
  - **What is listed.** Nothing before day 1 (the local day is compared with `dayOne`), and nothing for a routine that is not Started (`reminderPlanFor` answers null). The morning lists every morning entry's title, in routine order, joined with `, `. The evening lists only the entries due that local day, counted in days from day 1, or from the entry's `anchor` when it has one (an entry being brought back): `pm` and `am-pm` every day, `alternate-days` on even offsets, `weekly` on offsets divisible by 7 (the anchor's weekday), `as-needed` never. An empty list sends nothing and claims nothing. The titles are the routine's own, already past the wording gate; this service does not rewrite them.
  - **The routine seam.** The reminders module owns `ReminderRoutinePlan` and `PlanEntry` (`reminders.types.ts`) and never imports routines. `RoutineViewerService.reminderPlanFor(profileId)` answers them (the container hands the viewer over): `{ dayOne, morning, evening, stepDownChanges }` with each entry's `{ step, title, frequency, anchor? }`, placed, ordered and titled exactly as the body is (`toReminderPlan` in `routines.view.ts` shares `productOf`, `titleFor` and the rung's frequency with `toRoutineResponse`; a paused or held entry is absent, and a bringing-back entry carries its rung's `frequency` and `anchor` and is in the list that frequency places it in), or null when there is no routine, it is hidden (pending) or it is not Started. By profile id with no session or gates; it asks for no build, marks nothing served and reads no goal. It does read the step-down templates (`inputFor(..., withTapers = true)`), for `stepDownChanges`: a flat `{ day, title, line }[]` with one entry for the first day of each step of each dated step-down's schedule (week one and the stop step included; the same `fromDate` the body prints, so the alert and the schedule screen never disagree), in the version's order of step-downs and then the schedule's. A day inside a step is not a change. `title` is the product's frozen `not_in_routine` title (the plain routine title, "Cream", never the maker's brand or name, and it survives the product leaving the shelf; "A product you're stepping down" when the version has none for it) and `line` is fixed copy of the step (`stepDownLineFor`, `routines.copy.ts`, past the wording gate): "From today: use it every other day" (`alternate-days`), "From today: use it once a week" (`weekly`), "From today: stop using it" (`stop`), and plain "From today: ..." lines for the daily frequencies and `as-needed`. A step-down with no start has no entries; one whose template the workbook no longer holds has none and is logged by ids (`routine-taper-template-missing`), without stopping the others.
  - **The step-down alert** (#217, PR 4c). At the profile's morning time (the same quarter-hour window as the daily push, never the evening), on a local day on which a `stepDownChanges` entry of the plan has that `day`, the job claims `step-down` for (profile, local day) and queues one `stepDownAlert({ profileId, day, changes })` listing every change of that day in the plan's order, so two step-downs that change on one day are one alert. It needs the Started routine, `enabled` AND `step_down_alerts`; nothing is sent before day 1. The days are the plan's stored calendar dates compared with the local day, so the zone moves none. Deep link `/routine/step-down`.
  - **The missed-days nudge** (#217, PR 4c). At the morning time, when `missedStreak(profileId, local day)` (`RoutineCheckInsService`, taken as a narrow `checkIns` dependency since reminders may not import routines) is two days or more once clamped to `enabled_on`, so also on a third morning that is the first the job sees it. The clamp is calendar-date arithmetic in the sends service, with `missedStreak` unchanged: `since' = max(streak.since, enabled_on)` and `days'` is the days from `since'` to yesterday inclusive, so the day reminders were turned on is the first day counted, a person who starts late and opts in now is not nudged for days before they asked, and one who turns reminders off and on again starts counting afresh. A row with no `enabled_on` (none the service has turned on; the migration stamps the existing ones) is not clamped. The channel comes from `missedDaysChannelFor` (a `channel` dependency, `RemindersService`). On `push` the job claims `nudge:{since'}` for the day `since'`, the first day of the clamped run (not today), so the claim is held for the whole run and the nudge goes once per run; a check-in ends the run and the next run has a new `since`, so a new nudge. On `whatsapp` the job is a no-op: nothing is claimed or queued, and it logs `{ job: 'reminder-send', outcome: 'nudge-whatsapp-not-sent', profileId, channel: 'whatsapp' }` and nothing else, so the nudge goes out once that send exists. It needs `enabled` AND `missed_days_nudge`. Deep link `/routine`.
  - **The inbox rows** (#233, PR 8b). The consumer writes the inbox rows of what is due for EVERY started profile with something due in the slot, whether or not reminders are on, a phone is registered or the alert switches are on (`InboxService.write`, idempotent by key, so a redelivered message, a retry or a second run in the window makes no second row). A profile with reminders off or no settings row is counted by the defaults, 07:00 and 21:00 in its stored zone (`DEFAULT_TIMES` in `reminders.slot.ts`, shared with the fan-out), never by the times it stored while they were off. Nothing is written before day 1, for a routine that is not Started or for a stale slot. The rows, with `day` the slot's local day: `reminder:{day}:morning` or `reminder:{day}:evening` (kind `reminder`; the time of day and not the clock time, so a time changed during the day, or reminders switched off, cannot make a second row for that morning or evening; the entry titles, the fixed morning or evening line, link `/routine`, the push's words); `step-down:{day}` (kind `step-down`, the alert's words, link `/routine/step-down`, written whatever `step_down_alerts` says: only the push is gated); `rest-night:{day}` (at the evening slot of a day on which the routine lists evening entries and none is due); `next-change:{day}` (at the evening slot of the day before a step of a step-down begins, link `/routine/step-down`); and `check-in-due:{pauseId}:{checkDay}` (at the morning slot, for each check-in after a pause that is due, written before any claim for every profile and again, idempotently, on each morning it stays unanswered, so a row lost to a failed write is mended by the next delivery: `SkinCareService.checkInsDue(profileId, localDay)`, taken as the narrow `skinCare` dependency `{ checkInsDue }` returning `{ id, checkDay }[]` so reminders imports nothing from skin care). On a rest night the evening slot also writes `all-done:{day}` when the morning is already checked in (`checkIns.checkedTimes`, a narrow structural read; the check-in service writes the same row when the morning is checked in later). The rest-night and next-change words are fixed text in `reminders.sends.service.ts` that awaits the owner's copy sign-off. The missed-days nudge has no row. The rows are written first, so a push can carry its row's id as `data.inboxId`; for a row that already exists (a redelivery, or a phone registered later in the window) the id is the existing row's. A write that fails is logged `{ job: 'reminder-send', outcome: 'inbox-write-failed', profileId, kind }` (ids only: never the words, a token or the error's text) and never fails the message or holds back a push: that push goes without an `inboxId` and keeps its claim. The pushes keep their gating (reminders on and a phone), claims and words; a profile that is sent no push claims nothing.
  - **The pause check-in push.** At the morning slot only, for each check-in `checkInsDue` answers (read once per slot, for the rows and the pushes alike), the job claims `pause-check:{pauseId}:{checkDay}` for the check day (not today, as the nudge's claim is the run's first day), so an unanswered check-in is pushed once and not on the mornings after it; a pause whose check day moves is a new check-in with a new claim and a new row. It needs reminders on and a phone, like the daily push. The `check-in-due` row is written before the claim, so the push names it (`data.inboxId`); a failed write sends the push without it and the next delivery mends the row. The count `sendForProfile` answers is pushes queued, rows not included.
  - **Gating.** `listEnabled` is unchanged (rows with `enabled` on): every kind needs reminders on (a profile that never turned them on is sent nothing; a row can exist with `enabled` false and both alerts on by default, after a phone only reported its zone), and then its own switch, read from the same row: the daily push `enabled`, the alert `enabled && step_down_alerts`, the nudge `enabled && missed_days_nudge`. `deliver` reads the same switches again when the job runs (below). An off switch claims nothing, so turning it on again in the same window still sends.
  - **One morning, several sends.** The daily push, the alert and the nudge are separate `send-push` jobs with separate claims (`morning`, `step-down`, `nudge:{since}`), at most one of each per local day (the nudge, per run). One failed enqueue does not stop the others. `sendDue` counts every push actually queued, whatever its kind.
  - **Known limits.** A cron slot that is skipped is not made up. A zone change during the day can skip or bring forward that day's reminder. Since the fan-out the cron makes one D1 read and about N/100 `sendBatch` calls per run (N = the profiles due in the slot), and each profile's work is its own message, so the per-invocation subrequest limit is per profile.
  - **Phone first.** The order per profile in `sendDue` is: is a time due, then `hasPhone`, then the routine read, then per push the claim and the enqueue (the nudge reads `missedStreak` and the channel before its claim). A profile with no phone logs `{ job: 'reminder-send', outcome: 'no-phone', profileId }` and costs no routine read. `sendForProfile` reads the routine first (the inbox rows need it whether or not there is a phone), then the check-ins due, writes the rows, and only then asks `hasPhone` for the pushes. `routineReminder` answers whether it queued, and `sendDue` counts only those. The handler logs `{ outcome: 'done', queued }` on every run, 0 included, as a heartbeat; `profile-failed` carries `describeError(error)` (the class of an unexpected error, never its text).
  - **Deployed behaviour.** A reminder is queued as a `send-push` job (see "Sending push notifications"), so it is sent by the queue consumer, with its retries; the claim is made before the enqueue, so an enqueue that fails (logged and swallowed) is not retried by a later run in the same window.

### Inbox

`modules/inbox` holds `inbox_items` (migration 0050), `D1InboxRepository` and `InboxService` (#233, PR 3). It is what the routine tells a profile about itself, shown in the app and, where the reminder gating allows, sent as a push. It is a leaf module: it imports nothing from other modules except the pure wording list (`routines.wording.ts`). Skin care, the 15-minute job's consumer, the reminder settings and the check-ins write to it by profile id (`write`); the profile reads it through the session.

- **Rows.** `id`, `profile_id` (cascade), `kind` (free text, so a new event needs no migration), `local_day` (the profile's calendar day the row is about), `title`, `body`, `link`, `key`, `read_at` and `created_at`. Unique on (`profile_id`, `key`), with an index on (`profile_id`, `created_at` desc). `key` and `profile_id` are never in the API.
- **Kept forever.** There is no delete and no expiry: a row goes only with its profile (the foreign key's cascade, so guest cleanup needs nothing of its own). A profile reads its whole plan back through paging.
- **Keys make writes idempotent.** (The key formats listed here are the plan; the PRs that write rows fix them.) `write` is one `INSERT ... ON CONFLICT DO NOTHING`: of several writes for one (profile, key) made at the same time, exactly one creates the row, and every call answers its id (`created` false for the rest). The first row stays as it was, whatever a repeat carries. Keys are per profile and built by the writer from the event and its day: `reminder:{day}:{morning|evening}`, `step-down:{day}`, `rest-night:{day}`, `next-change:{day}`, `check-in-due:{pauseId}:{checkDay}` (all four written by the 15-minute job's consumer, see Reminders → Sends), `reminders-off:{day}`, `all-done:{day}`, `paused:{pauseId}`, `escalation:{holdId}`. A refused write does not use up its key.
- **Wording gate.** `write` throws, and stores nothing, when the title or body matches `FORBIDDEN_WORDING` or the link does not start with `/`. The error names the key and never the text. A line that fails is a bug in the writer, so it is not a 4xx.
- **Read state.** `read` is `read_at` set. `markRead(upTo)` takes an item id, marks every unread row of the profile created at or before that row (the row's own `created_at` included, so rows written at the same instant go together) and answers the unread count after. A row keeps the time it was first read, so no call unreads a row, and marking an older row after a newer one changes nothing. `markReadById(profileId, id)` marks one row, by profile id with no session; an id the profile does not hold changes nothing and does not fail. `markOneRead(id)` is the session form for the tap on a push: 401, 403 `SIGNUP_REQUIRED`, 404 `INBOX_ITEM_NOT_FOUND` for an id the profile does not hold (another profile's included, which is left as it was), then marks that row and no other (older rows stay unread) and answers the unread count. `summaryFor(profileId)` answers the unread count and the 5 newest rows, read or not, for Today.
- **Paging.** Newest first; rows with the same `created_at` follow `id` descending, so the order is one and the same on every call and rows the job wrote at one instant are never skipped or repeated. `before` is the id of a row the caller was given, and `next` is the last id of a page when more follow (it is null on the last page). The service reads one row more than the page to know. A `before` or `upTo` that is no row of the caller's, another profile's included, is 404 `INBOX_ITEM_NOT_FOUND`.
- **Routes**, bearer, under `/api/v1/me`, tagged "Inbox". `GET /inbox?before=&limit=` answers `{ items: [{ id, kind, day, title, body, link, read, createdAt }], next }` with `createdAt` an ISO time; `limit` is a whole number 1 to 50 (default 20), and anything else is 400 `VALIDATION_FAILED`. `POST /inbox/read { upTo }` answers `{ unread }` and carries `signedIn()`, so an unsigned caller is 401 before the body is read. `POST /inbox/{id}/read` (#233, PR 8b; no body) is the tap on a push, whose `data.inboxId` is the id: it answers `{ unread }` like `POST /inbox/read`, and marks only that item. A guest is 403 `SIGNUP_REQUIRED` on all three. The presenter is a function inside `inbox.routes.ts`.

### Face shares

`modules/face-shares` holds `face_share_consents` and `face_shares` (migration 0056), `D1FaceSharesRepository` and `FaceSharesService` (#259, PR C1). It is the person's yes to sharing a before-and-after card of their face photos, and the card itself (`share`, PR C2). The card is made by the server for the request, and this service writes it nowhere (see "Not kept" below). It is a leaf module: it imports no service or repository from another module (only the profiles table, for its foreign key), and everything it reads of face scans, photos, the logo and the owner alert is passed in by the container as a structural dependency.

- **The consent** is asked once and remembered. `face_share_consents` is `face_consents` again: one row per profile (`profile_id` primary key, cascade), `user_id`, `version`, `given_at`, `withdrawn_at`. Giving again replaces the version and time and clears any withdrawal; withdrawing stamps `withdrawn_at`, keeps the row and keeps the first time; a profile that never gave one gets no row. It is separate from the face photo consent: giving or withdrawing one never touches the other. `CURRENT_FACE_SHARE_CONSENT_VERSION` is 1 (`face-shares.consent.ts`); bump it when the wording changes in a way that needs a new yes, and a consent for an older version stops counting.
- **The shares** are `face_shares`: `id`, `profile_id` (cascade), `before_scan_id`, `after_scan_id`, `consent_version`, `created_at`. Every share is kept; the caller of `record` supplies the id and the time (`share` does, once the card is drawn). The scan ids are plain text, not foreign keys, so deleting a face scan does not erase the record that a card of it was shared. Withdrawing the consent leaves the shares on record; both tables go with their profile, so guest cleanup needs nothing of its own.
- **Verified users only**, unlike the face photo consent's `PUT`. The three session methods (`giveConsent`, `consent`, `withdrawConsent`) check, in order: 401 `AUTH_REQUIRED` (no session), 403 `SIGNUP_REQUIRED` (a guest, even for a wrong version), then the rest. `hasCurrentConsent(profileId)` has no session: it is for the share itself, and answers `{ version }` while the consent is for the current version and not withdrawn, else null, so after a withdrawal the next share must ask again.
- **Routes**, bearer, under `/api/v1/me`, tagged "Face shares". `PUT /face-share-consent { version }` answers `{ version, givenAt }`; any version but the current one is 400 `FACE_SHARE_CONSENT_VERSION_MISMATCH` with `details.current`, and the route carries `signedIn()`, so an unsigned caller is 401 before the body is read. `GET /face-share-consent` answers `{ version, givenAt, withdrawnAt, current }`: a withdrawn consent and one for an older version are still shown, with `current` false; 404 `FACE_SHARE_CONSENT_NOT_FOUND` until the profile has given one. `DELETE /face-share-consent` is 204 with no body, and 204 again when already withdrawn or when there was never a consent. The consent belongs to the profile (the token's `pid`), not the account. The presenter is inside `face-shares.routes.ts`.
- **The card** (`POST /api/v1/me/face-timeline/share { afterScanId }`, bearer, `signedIn()` before the body). `FaceSharesService.share` checks, in order, each leaving the photo store, the renderer and `face_shares` untouched: 401, 403 `SIGNUP_REQUIRED`, 409 `SHARE_CONSENT_REQUIRED` (`hasCurrentConsent`), 409 `NO_DAY_ONE_PHOTO`, 404 `FACE_SCAN_NOT_FOUND` (an unknown scan, another profile's, day one itself, not ready, of another goal or an earlier chase, or without a front photo: not told apart), 409 `SHARE_TOO_EARLY`. Then it answers 200 `image/png` with `Cache-Control: private, no-store`. Every goal may share, the fairer goal included. The face scans' side is `FaceScanService.beforeAndAfterFor(profileId, afterScanId)`: by profile id with no session, it returns `{ before, after }` of `{ scanId, frontPhotoKey, localDay }`, where `before` is the current goal's day one by the same chase rule the result view uses (`chaseStartFor`, then `dayOneFor`; never re-derived) and `after` is the asked-for scan when it is a later ready scan of that chase with a front photo. `localDay` is the scan's calendar date in `usableZone(now, reminders.zoneFor(profileId))` (UTC with no stored zone or an unusable one), so the service's N is a difference of two dates with no clock in it: N = days between + 1, "Day 1" for day one, and the first card allowed is 14 days after, "Day 15". The container passes the whole face scans service, narrowed by face-shares' structural type to `{ beforeAndAfterFor }`.
- **Drawing** is behind `ShareCardRenderer` (`providers/share-card`): `render({ layout, before, after, logo })` answers a PNG, throws `ShareCardQuotaError` when the allowance is gone and the vendor's own error otherwise. The layout (`shareCardLayout(dayNumber)`, pure, 1080 x 1920 in the brand header colour) is the contract between the service and the renderer: two photo boxes of the same size, the day-one photo on top, each with a "Day N" label in its own band outside the box, the logo bottom right, and nothing else written on the card. A photo is only ever given a box and a fit (`contain` for both): there is no way to ask for colour, brightness, contrast, a filter or a blur. The layout is `face-shares.layout.ts`, in the module that owns the card; the provider file holds only the contract (`ShareCardRenderer`, `ShareCardLayout`, `Rect`, `Placement`, `ShareCardQuotaError`). Each label has a band sized from its text size read as points (x 4/3 for pixels, a 1.5 line height and padding), because Cloudflare documents the size as points in its types and pixels on its docs page; checked against the real binding (2026-10-30), the size is in pixels (size 30 draws glyphs 27 px tall), placed at the band's top left. The renderer draws every image (photos, then logo) before any text: the binding draws image overlays before text overlays but keeps the positions in the order given, so the other order puts each overlay in another's place. `CloudflareImagesShareCardRenderer` runs on the `IMAGES` binding (declared in every environment of `wrangler.jsonc`): a canvas stretched from a 1 x 1 pixel PNG of the brand colour, each photo resized into its box (`contain` is Images' `pad`, filled with the canvas colour), the labels as text overlays in a font fetched from `<CATALOG_IMAGES_PUBLIC_URL>/share-card/label.ttf` (`assets/share-card/label.ttf`, Inter Bold 4.1 under the SIL Open Font License; the licence text is beside it as `label.LICENSE.txt`; synced like the email logo, with content type `font/ttf`), the logo from `email/logo.png` in `CATALOG_IMAGES`, and one `output({ format: 'image/png' })`. `MemoryShareCardRenderer` records what it was given.
- **Rate limit.** `signedIn()` then `FACE_SHARE_USER_LIMITER` (10 a minute per user, namespace ids 1032 / 2032 / 3032), 429 `RATE_LIMITED` with `Retry-After`, because every card spends an Images transformation. There is no address limiter: the route needs a session.
- **The allowance.** On the Free plan the first 5,000 unique transformations a month are free, and new ones past that fail with Images error code 9422. The renderer maps that code to `ShareCardQuotaError`; the service raises the `share-render-quota` ops alert (hourly window) and answers 503 `SHARE_UNAVAILABLE` ("Sharing is busy right now. Try again later."), recording nothing. Any other failure, including a stored photo key with no object, is the same 503 with no alert, logged with the profile and scan ids and the error's class name only.
- **Not kept, never logged.** This service writes the card nowhere: not R2, not KV, not the Cache API, and the route answers `Cache-Control: private, no-store`. The Images binding's responses are not cached on our side because we enable no cache. What Cloudflare itself retains of a transformation's inputs and outputs is governed by its terms; its Images documentation does not state it. The share is recorded after the render, never before, so a failed attempt leaves nothing behind. No photo bytes, keys or URLs reach a log line.

### Skin care

`modules/skin-care` holds `skin_logs` (migration 0052), `step_pauses` (migration 0053), `D1SkinCareRepository`, `D1StepPausesRepository` and `SkinCareService` (#233, PRs 2, 4b and 5). A person logs what they are noticing, where and how bad, and fixed rules decide the outcome; a harm signal pauses a step. There is no AI in it. skin-care never imports routines: it is given `routine: { stepDownRunning, skinCareRoutineFor }` and `inbox: { write }`, and the container wires the first two lazily to `RoutineViewerService` (explicit return types on the lambdas, since skin care, the viewer and the routine service reach each other). `stepDownRunning` there is `skinCareRoutineFor(profileId)?.stepDownRunning`, so it reads the routine in force.

- **The vocabulary** (`skin-care.vocabulary.ts`). Noticing: stinging or burning, new redness, tightness or dryness, new breakouts, itching, swelling, nothing unusual, pus or a hot painful patch (choose any). Where: cheeks, nose, forehead, neck, chin and jaw, near my eyes, everywhere (choose any). How bad: mild, noticeable, hard to ignore (one choice).
- **The rules** (`outcomeFor` in `skin-care.outcomes.ts`; pure; `SKIN_OUTCOME_RULES_VERSION` is stored on every log). Precedence: professional, then pause, then expected flare, then advice, then logged.
  - Professional: pus or a hot patch, swelling, or near my eyes in `where`; the reason named is the first of those in that order.
  - Pause: stinging or burning or new redness at any level, or any symptom at hard to ignore.
  - While a step-down is running, a pause that comes only from a harm signal at mild or noticeable is the expected flare instead (the step-down is never stopped). Hard to ignore stays a pause, with `duringStepDown: true`.
  - Advice: tightness or dryness, itching and new breakouts at mild or noticeable, one code each, always in that order.
  - Logged: nothing unusual.
- **Validation** (the service, before the rules, 400 `VALIDATION_FAILED`, nothing stored): at least one symptom; nothing unusual only alone and with no place at all; a level for anything but a good day (one given with nothing unusual is dropped and the log is stored without it); a note that is text of at most 500 characters (counted in characters, not UTF-16 units); every symptom, place and level from the lists above (the route's schema checks too, the service does not trust it). A symptom or place named twice counts once. A guest is 403 `SIGNUP_REQUIRED` before the input is looked at. Logging works before Start and with no routine.
- **The note** is stored and repeated back in a professional response's `facts` (what, where, how bad, note), and nowhere else: `recent()` leaves it out. No rule reads it, it never changes an outcome, and it is written to no log line or error.
- **Reviewed text.** The log is stored first, then the text is read from the workbook: one Responses row per advice code, the Responses row for the expected flare, `paused` or `nothing-to-pause`, or the Escalations row of the professional reason. A missing row is 503 `CONTENT_UNAVAILABLE`, and the log and any pause stay. A good day has no text. `fillStep(text, noun | null)` (`skin-care.text.ts`) fills every `{step}` with the step's plain noun (`STEP_NOUN`: Cleanser, Treatment, Moisturiser, Sunscreen, never a product title), or "your routine" when the answer is about no step: advice, the expected flare and nothing-to-pause. Escalation rows have no placeholder.
- **Acting on a pause** (`SkinCareService.log`). The rules' `pause` outcome becomes the final action, and the stored log (and `outcome` in the answer) says the final one; `paused: { id, step, title, checkDay } | null` is added to the answer. The reads that decide it (the open pauses, then the routine) come before the log is stored; when one fails, or the pause cannot be written, the outcome is `nothing-to-pause` (see "What is always stored"). A pause the routine no longer has (the step's product changed and reconcile has not run) is stale: it neither counts towards the cap nor holds its step. In order:
  1. **The cap.** Two steps already `paused` (only `paused` rows that have a step; a `bringing-back` or `escalated` row and the check-in with no step do not count) is a professional, reason `harm-while-two-paused`. It is checked first, so it also beats the step-down rule.
  2. **During a step-down** (`duringStepDown`): the step is chosen among the active steps only, never a basic step; none left (or no routine) is a professional, reason `hard-to-ignore-during-step-down`.
  3. **Nothing to pause:** no routine, a routine not Started (`dayOne` null), or no step `stepToPause` can pick is the outcome `nothing-to-pause`, with a check-in in three days that has no step.
  4. **Otherwise** `stepToPause` picks the step and it is paused. Before 2 to 4, a step being brought back is paused again instead (see "A harm signal on a step being brought back").
- **The step** (`stepToPause(routine, openPauses)`, `skin-care.step-choice.ts`, pure). Never the sunscreen (`protect`), never a step that already has an open pause (matched by step alone; the service passes every open pause, a `bringing-back` or `escalated` one too: the table refuses a second open pause for a step and product, and an escalated step stays out). Among the active steps (some `activeGroups`) the one with the newest `changedOn` (null is day 1); with no active step left, the same over the other non-sunscreen steps; a tie goes treat, then cleanse, then moisturise; null when nothing is left. A step with nothing to key a pause by (`pauseKeyOf` is null: a recommended product no longer in the catalog, or "use what you have") is left out before the choice, so a step is never "paused" in a way the routine could not show.
- **The pause row** (`step_pauses`): `step` (null for the check-in with no step), `product_key` (`pauseKeyOf`: the catalog product id of the step's product, else the shelf entry id, so a product with no label can be paused; '' for the check-in with no step), `product_id`, `product_ref` (JSON), `ingredient_group` (the first of the step's `activeGroups`, frozen), `state` (`paused`, `bringing-back`, `escalated`, `ended`, `replaced`, `undone`; `paused` and `bringing-back` are open and are what the unique indexes see; `escalated` is read as open by `openFor` but is not in the indexes), `paused_on` and `check_day` (calendar dates, so a later change of zone moves none), `same_count`, `source_log_id` (plain text, no key), `ladder_code` (the schedule itself, serialised, frozen when the step is brought back), `ladder_started_on` (a local day, set with it) and `version_id` (filled by a later PR), `created_at`; cascade with the profile. Two partial unique indexes over the open states: one open row per (profile, step, product key) where the step is not null, and one open row per profile where the step is null (an index over `COALESCE(step, '')` would be one, but drizzle-kit cannot write an index expression with a comma). `StepPausesRepository` has `insert`, `find`, `openFor` (`paused`, `bringing-back` and `escalated`, oldest first, ties by id), `update(profileId, id, patch, onlyIfState?)` and `rePause(profileId, id, { pausedOn, checkDay, sourceLogId })` (a compare-and-set on `bringing-back` that flips the row to `paused` in place, `same_count` 0, ladder columns kept); a pause is never deleted.
- **The check day** is the local day of the pause plus three calendar days. A pause moves every other open `paused` row's check day to the same day, so the person is asked once. A second "nothing to pause" reuses the profile's one `paused` row with no step and moves its check day to its own local day + 3, and adds no row.
- **Order inside `log` for a pause.** Decide, store the log, make the pause (and move the other check days), read the reviewed text (503 here keeps the pause), then write the inbox row `{ kind: 'paused', day, title, body (the filled text), link: '/routine', key: 'paused:<pauseId>' }`. A failure to write the inbox row is logged by ids and does not fail the log: the person has the answer, and the pause stands.
- **Undo** (`undo(pauseId)`, session). Only on the local day of the pause: today is read in the zone stored now and compared with the pause's frozen `paused_on`. 404 `PAUSE_NOT_FOUND` for another profile's pause, an unknown id, a pause that is no longer `paused`, the check-in with no step (it pauses nothing, so there is nothing to undo) and a pause with no source log (made by the system, such as the `paused` row a replacement opens when there is no ladder); 409 `UNDO_EXPIRED` after that day. It marks the pause's source log `overridden` first (the log is kept; a professional log is never touched, it caused no pause) and then sets the pause `undone` only if it is still `paused` (`update(..., onlyIfState)`, a compare-and-set), so a request that fails between the two can be repeated and still marks the log, and a pause a rebuild has replaced is never turned into `undone` (404). **Undo of a re-pause** (a pause that still has `ladder_started_on`) puts the row back to `bringing-back` with its ladder as it was, and answers `state: 'bringing-back'`, so the step never comes back at full strength; undo of a first pause is `undone`.
- **Reconcile** (`reconcile(profileId)`, no session). Called by the routine service after a version is written (`complete`, every direct ready append, `gotIt`; `Pick<SkinCareService, 'reconcile'>`, in a try/catch that logs the profile id). An open pause with a step stays while the routine still has that step with the same product key (a recommended product the person has got as their own shelf entry is the same product, so its pause stays), and is set to `replaced` when the step now has another product key or none. Any open stepped pause counts, an `escalated` one too. **A `replaced` pause starts the ladder for the new product:** when the step now has a product with a key (`pauseKeyOf`), a new `bringing-back` row is opened for it (the group is the product's first active group, else the default ladder; the schedule frozen; `ladder_started_on` = today, the local day of the reconcile) and no inbox row (the only reviewed line is `check-calmer`, which would be untrue here; a reviewed "your new product starts slowly" line needs a Responses outcome, a contract bump, and is out of scope). When the ladder is empty or cannot be read, a `paused` row is opened instead with `check_day` = today + 3 (the safe side). A replaced `escalated` step opens an `escalated` row for the new product with no ladder and no inbox row: professional help is pending, so the step stays out (the hold, in PR 6b, takes over from there). A failed insert is "already started" when the row is there (a competing request made it and the unique index refused this one), else it rejects. The new row is inserted before the old one is closed, so a failure between the two leaves both open and the next call finishes it; a step that already has an open row for the new key is not given another. It changes nothing while there is no routine to read, and is idempotent (a second call finds the new row matching the routine).
- **`stateFor(profileId, today)`** (read by the viewer, `deps.skinCare`) answers the profile's open pauses that have a step: a `paused` or `escalated` row as `{ step, productId: <product key>, state: 'paused' }`, a `bringing-back` row as `{ step, productId, state: 'bringing-back', frequency, anchor }`, and `held`, true while the profile has an open escalation hold (`holds.openFor`; a failure to read it rejects, so the routine read fails closed, as for the pauses). The ladder is in weeks (`ScheduleStep`): rung n starts on `ladder_started_on` + 7 * (`fromWeek` - 1) days, the current rung is the last that has started, `anchor` is its first day and `frequency` its frequency (the overlay and `dueOnDay` use both). The row ends on the first day of the `back` rung: it is set to `ended` (best effort; a failed write is logged `{ outcome: 'skin-care-ladder-end-failed', profileId }` and the step is still left out) and the step is back at the routine's own frequency. A ladder that cannot be read (anything but whole weeks from 1 on the first rung and ascending after it, each rung ending no earlier than it starts, a known frequency on every rung, `back` on the last only, and real dates; the whole check is guarded, so corrupt text never fails the read) keeps the step out as `paused`, logs `skin-care-ladder-unreadable` with ids, and the row is paused again in place (best effort, `skin-care-ladder-repause-failed` with ids), due today with `same_count` 0 and its log and ladder columns kept, so the person is asked and a Calmer freezes a fresh ladder. It reconciles first over the same rows it read (so a rebuild whose hook was missed heals itself, and the rows reconcile opened are listed in the same read; the routine is read only when a pause with a step is open, and a failed reconcile is logged `{ outcome: 'skin-care-reconcile-failed', profileId }`, the pauses are read again and used, and the read rejects if the routine can be read and a stepped open row is still not the routine's (a replaced product whose new row was not written), so a replaced step is never shown as active; when the routine cannot be read the read goes on), and a storage failure reading the pauses rejects (it never answers "no pauses"), so the routine read fails closed (see "What each entry is doing"). The viewer matches a step's pause by `productId ?? shelf entry id`, the same key.
- **The check-in** (#233, PR 5). `checkInsDue(profileId, today)` (no session; Today and the job only consume it) answers the open `paused` rows, the one with no step too, whose `check_day <= today`; never a `bringing-back` or `escalated` row. `answerCheckIn(pauseId, answer)` (session): 401, 403 `SIGNUP_REQUIRED`, 400 `VALIDATION_FAILED`, 404 `PAUSE_NOT_FOUND` (another profile's pause, none, or one that is not `paused`), 409 `CHECK_IN_NOT_DUE` (today in the zone stored now, against the frozen `check_day`). **The reviewed text is read before anything is written** (the `check-calmer`/`check-same` response, the escalation, the ladder); a missing or unreadable one is 503 `CONTENT_UNAVAILABLE` and the row is as it was. Every write is conditional on the row still being `paused`.
  - **Calmer** on a step: the ladder of the row's frozen group (`reintroductionFor`, else the default ladder) is stored itself in `ladder_code` (JSON, never a reference, so a later workbook edit never changes a running ladder), `ladder_started_on` = today, state `bringing-back`, one inbox row `{ kind: 'bringing-back', key: 'bringing-back:<id>:1', link: '/routine' }` (a failed write is logged by ids and does not fail the answer). No ladder, or an empty one, is 503. On the check-in with no step: `ended`, no ladder and no inbox row. A second calmer after a re-pause restarts the ladder at rung 1 with a freshly frozen schedule.
  - **Same:** `check_day` = today + 3 (not the old check day + 3), `same_count` + 1. The third in a row (`same_count` already 2) is a professional, `unchanged-after-checks`.
  - **Worse:** a professional, `worse-after-pause`.
  - **A professional result** sets the row to `escalated` and answers the reviewed escalation (`whoToSee`, `howSoon`, `whatToTellThem`). It is never due again, the step stays out of the routine (shown as `paused`), it does not count towards the cap of two (which counts only `paused` rows with a step), and `stepToPause` treats its step as taken. An escalated stepless row is never reused by "nothing to pause". The hold and the reaction mark are PR 6b: every professional result passes through `SkinCareService.professional`.
- **A harm signal on a step being brought back** (`log`, after the cap). When the rules' outcome is a pause (during a step-down it is still only an active step), an open `bringing-back` row whose step and product key the routine still has is the step hit (the latest `ladder_started_on` when there are several), and `stepToPause` is not asked. `SkinCareService.rePause` (every re-pause passes through it, and marks the reaction, see "A product that keeps reacting") calls `StepPausesRepository.rePause`: the same row becomes `paused` with `paused_on` = today, `check_day` = today + 3, `source_log_id` = this log and `same_count` 0, keeping `ladder_code` and `ladder_started_on`, and every other open `paused` row's check day moves to the same day. No second open row is made and no inbox row is written (`paused:<id>` exists already). **With two steps already `paused`** the result is still the cap's professional `harm-while-two-paused`, and the ladder row (if any) is paused again in place too, best effort (`skin-care-pause-write-failed` with the profile id on failure), so a ladder never keeps running through a harm signal; with the routine unreadable the latest ladder row is the one paused again.
- **Routes** (`skin-care.routes.ts`, tag "Skin care", bearer, under `/api/v1/me`). `POST /skin-logs { noticing, where?, howBad?, note? }` answers `{ log, outcome, response, paused }`; the body's enums are the vocabulary (an unknown symptom, place or level is 400 `VALIDATION_FAILED`; the note's length is the service's, in characters). `GET /skin-logs` answers `{ logs }`, the last 20, newest first, without the note. `POST /skin-care/pauses/{id}/undo` answers `{ id, state: 'undone' }`. `POST /skin-care/pauses/{id}/check-in { answer: 'calmer' | 'same' | 'worse' }` answers `{ outcome: { kind: 'calmer' | 'same' | 'professional', reason? }, response, pause: { id, step | null, state, checkDay | null } }` (see "The check-in"). Undo answers `state: 'bringing-back'` for a pause made again. `POST /skin-care/hold/close { how: 'seen' | 'settled' }` answers `{ closed: true, checkInsDue: [{ id, step | null, checkDay }] }` (see "Escalation holds"); it is served like the check-in (the account is checked before the body is read, `HOLD_NOT_FOUND` is 404). The POSTs carry `signedIn()`, so an unsigned caller is 401 before the body is read; a guest is 403 `SIGNUP_REQUIRED` on all of them (the check-in's handler asks the service for both gates, `requireSignedUp()`, before it reads the body, so a guest with a bad body is 403, not 400). The check-in is documented with its body but served from a copy without it, which reads the text itself (`readJsonBody`, `documentedOnly` in `lib/openapi.ts`), so an empty or malformed body is `VALIDATION_FAILED` rather than `HTTP_400`.
- **The day** is the person's local day in their stored zone (UTC with none), fixed on the log.
- **What is always stored.** A red flag, advice and a good day are decided from the log alone: nothing is read for them (no routine, no step-down, no pauses). A zone that cannot be read or used falls back to the UTC day. A harm signal (the rules' `pause`) reads the open pauses and then the routine once (`routine.skinCareRoutineFor`); that read is handed to `routine.stepDownRunning(profileId, today, routine)`, which the container answers from it instead of reading again (a call without a routine reads it), and the step-down is asked only for a harm signal, the one log it can change. A step-down read that throws counts as no step-down (the harm signal is then a pause, the more cautious result) and logs `{ outcome: 'step-down-read-failed', profileId }`. **A harm signal still stores the log when a read or a write fails.** If the open pauses or the routine cannot be read, the log is stored as `nothing-to-pause` (the reviewed text is answered, the one check-in with no step is written if the pauses store allows, using the real open pauses when they were read, so a repeat moves the existing check-in's day) and `{ outcome: 'skin-care-routine-read-failed', profileId }` is logged; with two steps already paused and an unreadable routine the result is still the cap's `harm-while-two-paused` (the cap needs only the pauses). If the pause itself cannot be written (a unique violation from a double tap or a retry, or any store error), `{ outcome: 'skin-care-pause-write-failed', profileId }` is logged and the open pauses are read again: a `paused` row for the same step and product (the competing request's, or this one's when only a later write failed) is answered as this log's pause; otherwise the outcome becomes `nothing-to-pause`, the stored log is changed to say so (`SkinCareRepository.setOutcome`) and the check-in with no step is written. A failure to write that check-in is logged `{ outcome: 'skin-care-check-in-write-failed', profileId }` and the log and answer stand. A red flag reads neither. A failed inbox write of a pause is logged `{ outcome: 'paused-inbox-write-failed', profileId, pauseId }`.
- **`recent()`** orders by `created_at` desc, then `id` desc, so logs made in the same millisecond come back in a stable order.
- **Escalation holds ** (#233, PR 6b-i, the store; migration 0054). `escalation_holds` (`id`, `profile_id` cascade, `reason`, `source_log_id` plain text, `opened_on` the local day frozen when opened, `opened_at`, `closed_at`, `closed_how` `seen` | `settled`; `HOLD_CLOSE_HOW` in `skin-care.vocabulary.ts`) with a partial unique index over `profile_id` where `closed_at IS NULL`: a profile has one open hold, and closed holds stay as history. `D1EscalationHoldsRepository.open` is idempotent and safe when two calls run at once: `INSERT ... ON CONFLICT (profile_id) WHERE closed_at IS NULL DO NOTHING`, then the open hold is read back, so both callers get the one hold (an id already held or a missing profile still rejects). `openFor(profileId)` answers the open hold or null; `close(profileId, holdId, how, at)` is a compare-and-set on `closed_at IS NULL` that answers whether it closed. `heldSteps(routine, held)` (`skin-care.holds.ts`, pure) answers the steps a hold keeps out: those with any `activeGroups`, never `protect`, in routine order, `[]` when not held.
- **Escalation holds (wired)** (#233, PR 6b-ii). `SkinCareServiceDeps` gains `holds`, `safety` (`Pick<SafetyService, 'markReactionProduct'>`), `verdicts` (`{ savedFor }`) and `catalog` (`Pick<ProductCatalogService, 'namedProduct'>`), wired in the container with no lazy lambda: `verdicts()` does not reach skin care at construction (its routine trigger is a lambda).
  - **Every professional result opens the hold**: a log (`pus-or-hot-patch`, `swelling`, `near-eyes`, `harm-while-two-paused`, `hard-to-ignore-during-step-down`; `source_log_id` is the log) or a check-in (`worse-after-pause`, `unchanged-after-checks`; the pause's source log). `opened_on` is the person's local day. The hold is opened after the pauses are written and before the reviewed text is read, so a missing text (503) still leaves it. `open` is idempotent, so a later professional result keeps the first hold and gets it back; the inbox row `{ kind: 'escalation', key: 'escalation:<holdId>', link: '/routine' }` (a fixed title, and `whoToSee`, `howSoon` and `whatToTellThem` as the body) is asked for by every professional result once its text is in hand, and made once per hold. A failed inbox write is logged by ids (`escalation-inbox-write-failed`) and never changes the answer. In a check-in the hold is opened before the pause becomes `escalated`; when it cannot be opened (`skin-care-hold-open-failed` with the profile and pause ids) the answer is still the professional result, but the pause stays `paused` (the answer says `paused` with its existing check day), so the step stays out, the person is asked again, and the next Worse tries the hold again. A log opens its hold after the log is stored, and a failed open is logged and changes nothing else.
  - **`stateFor`** answers `held` from `holds.openFor`. **A harm log during a hold** never pauses a step `heldSteps` names (they are added to the steps `stepToPause` is told are taken), so a strong symptom during a step-down with no other active step is a professional result. A hold that cannot be read there is taken as none (`skin-care-hold-read-failed`): the log is always answered, and the worst that follows is a step the hold keeps out being paused too, which does no harm (closing the hold finds that pause and moves its check day to today); assuming a hold instead could pick the wrong step when there is none.
  - **`closeHold(how)`**: 401, 403 `SIGNUP_REQUIRED`, 404 `HOLD_NOT_FOUND`. The hold is read, then the open pauses and the routine; a pauses read that fails rejects, and so does a routine that cannot be read (503 `ROUTINE_UNAVAILABLE`: which steps are held is unknown, so the hold stays open and a retry works). A routine that does not exist (read fine, none) still closes. The hold is then read again just before `holds.close(profileId, holdId, how, now)`, a compare-and-set, which runs before any pause is written; a hold gone or replaced since the first look is 404, and of two closes at once one wins and the other is 404. **A window remains** between that second read and the compare-and-set: a professional result in it finds the same open hold (`open` is idempotent) and the close ends that hold too, so the new result has no hold of its own. It is two awaits wide and accepted. Then, for each step the routine holds out: an `escalated` row becomes `paused` in place due today with `same_count` 0; an open `paused` row's check day moves to today (its source log kept); a `bringing-back` row is paused again in place (due today, `same_count` 0, ladder columns kept, no source log, written through the repository so nothing is marked: a system action), so a Calmer restarts the ladder at rung 1; a step with no row gets a `paused` row due today with no source log (so Undo refuses it) and the step's first active group. An `escalated` row of a step that is not held out also goes back to `paused`, since nothing else would. A pause write that fails after the close is logged by ids (`skin-care-hold-close-step-failed`, with the pause id when there is one); the other steps still go through. The answer is `{ closed: true, checkInsDue }`, from `checkInsDue(profileId, today)`, as `{ id, step, checkDay }`; a read of it that fails is logged (`skin-care-hold-close-due-failed`) and answers `[]`.
  - **No ladder starts during a hold.** While a hold is open, `answerCheckIn` with Calmer or "about the same" on a pause whose step `heldSteps` names is 409 `HOLD_OPEN` and changes nothing (503 `ROUTINE_UNAVAILABLE` when the routine cannot be read); Worse is still taken (a professional result, the hold stays). `checkInsDue` leaves those rows out while the hold is open (the check-in with no step and the steps that are not held stay; a routine that cannot be read leaves the rows in, logged, and a hold that cannot be read rejects), so Today does not ask what cannot be accepted. After the close the step has a fresh check-in due that day.
  - **The inbox row heals.** Every professional result, once its reviewed text is in hand, asks for the open hold's row (`escalation:<holdId>`; the inbox keeps the first and a repeat is a no-op), so a row lost to a missing text or a failed write is made by the next result.
- **A product that keeps reacting** (#233, PR 6b-ii). A re-pause of a step being brought back (the cap's professional result pauses it again too) and a `worse-after-pause` result call `catalog.namedProduct(pause.productId)`, then `safety.markReactionProduct(profileId, { productId, brand, name, category })` from the catalog's own fields, then `verdicts.savedFor(profileId)` only when `marked` (the mark changes the verdict fingerprint, which queues a verdict build; skin-care never calls routines). A pause with no catalog `productId` (no label, or no step) reads and marks nothing, `unchanged-after-checks` marks nothing, and a `worse-after-pause` on a pause with no source log (one a hold's close made) marks nothing: only a pause the person's own log caused is a reaction. A re-pause is always made by a log of the person's, so it marks whatever made the first pause. Every failure is logged by ids (`skin-care-reaction-mark-failed`, never the product) and changes no outcome; in `rePause` the mark is made last, after the row is flipped and the other rows' check days have moved, and is not part of the pause write, so a mark failure is never taken for a pause that could not be written.

### Admin access
The `/api/v1/admin` routes change shared data (today the catalog workbook, see below), so they are not a user's to call. A user's token, guest or
signed-in, never opens them: they have a door of their own.

- **`X-Admin-Token`**, compared with the `ADMIN_API_TOKEN` secret by the `adminToken()` middleware (`src/middleware/admin-token.ts`). It is the only place
  read: an `Authorization: Bearer` header, whatever it holds, is ignored, and a missing, wrong or empty header is 401 `ADMIN_TOKEN_INVALID`.
- **Constant time.** Both sides are HMAC-SHA-256'd under a key made fresh for the call, and the two digests (always the same length) are compared with
  `timingSafeEqual`, so how long a refusal takes says nothing about how much of the token was right.
- **An unset secret locks the door.** An empty or missing `ADMIN_API_TOKEN` refuses everyone, including the caller who sends nothing, so a Worker deployed
  without the secret exposes nothing. It is in `secrets.required` in all three blocks, so a deploy fails until it is set, and in `scripts/secrets/plan.ts`,
  so `secrets:push` sends it. Generate one per environment with `openssl rand -hex 32`.
- **Rate limited per address, before the token is checked.** `ADMIN_IP_LIMITER` (10 a minute, namespace ids 1029 / 2029 / 3029) comes first in the
  route's `middleware`, then `adminToken()`, then the body limit, so every guess at the token uses an attempt, a flood of wrong ones is answered 429
  before it is compared, and the right token is turned away once the allowance is gone. The token is checked before the body is read.
- **No actor.** The routes carry `security: [{ adminToken: [] }]` and call a service that needs no signed-in user; `requireUser` is never involved.
  An admin is a holder of the secret, not an account, and the upload records a label (`uploadedBy`) because nothing else says who it was.

### Catalog workbook import
`CatalogWorkbookService` (`catalog.workbook.service.ts`, built by the container as `catalogWorkbook`) serves and changes the catalog workbook: the
Products, Availability, Ingredients, Countries, Claim words, Tapers, Guides, Reintroductions, Escalations, Responses and Weeks tabs the team edits in a spreadsheet. Its tables, all in the catalog module, are `recommended_products`
(a Products row, its `product_id` and the `formulation_id` it pins), `product_availability`, `countries`, `claim_words`, `tapers`, `guides`, `reintroductions`, `escalations`, `responses`, `weeks`, and the `ingredient_rules` and
`catalog_versions` of "Product catalog data". The routes are `GET /api/v1/admin/catalog/export` and `POST /api/v1/admin/catalog/import`
(`catalog.workbook.routes.ts`), behind "Admin access".

- **Export** gives `{ catalogVersion, contractVersion, workbook }`: every tab with its full header row, retired rows included, in the shape the import
  takes (lists joined with `; `, dates `YYYY-MM-DD`, an empty cell `null`; `catalog.workbook.raw.ts`). Importing an export unchanged is an empty diff.
- **Import** is multipart: `workbook` (the JSON text), `file` (the `.xlsx`, up to 10 MB), `baseVersion`, `contractVersion`, `dryRun` (**default `true`**) and `uploadedBy`
  (1 to 80 characters). In order:
  0. `contractVersion` (the version of the export the file was edited from) must be the server's `CONTRACT_VERSION`: 409 `CONTRACT_MISMATCH`, before
     anything else and for a dry run too, because a file made for another contract cannot be judged by this one (its problems would only mislead). The
     upload script sends the file's own `_meta` stamp, and the file reader reads `_meta` before the tabs, so an old export is told to export again and
     not "missing the Tapers tab". The route's body schema reads `workbook` only as a JSON object (a bad JSON text is a 400 `VALIDATION_FAILED`), so a genuine
     1.0.0 file, which has four tabs, reaches this check and gets the 409 instead of a 400 about its missing tabs, also when posted without the script.
  1. The tabs are read in the shape the contract is written in (`RawWorkbookSchema`: all eleven tabs, each a header row and rows): 400 `VALIDATION_FAILED` with
     `{ path, message }` details under `workbook`. Only a file of the current contract version gets this far. Then `validateWorkbook` runs on the server whatever
     the script did: 400 `CATALOG_INVALID` with every problem in `error.details.problems`.
  1a. **The production approver gate.** In `production` only (`ENVIRONMENT`), every Tapers, Guides, Reintroductions, Escalations, Responses or Weeks row with status `approved` must have an `approved_by` that is
     exactly one of the comma-separated labels in the `QUALIFIED_APPROVERS` var (each trimmed; an empty or absent var refuses every approved row of those tabs).
     Otherwise it is 400 `CATALOG_INVALID` with one `{ tab: 'tapers' | 'guides' | 'reintroductions' | 'escalations' | 'responses' | 'weeks', row, column: 'approved_by', rule: 'UNQUALIFIED_APPROVER' }` for each such row, and
     the name is never echoed or logged. It is a process control, not authentication: the approver is a label in a cell, written by whoever holds the
     admin token. Staging and development accept any approver, so the owner or Claude can approve there. The service takes `environment` and
     `qualifiedApprovers` from the container; `QUALIFIED_APPROVERS` is a plain var in all three `wrangler.jsonc` blocks, empty until a qualified approver is named.
  2. `baseVersion` must be the live catalog version: 409 `CATALOG_STALE`, for a dry run too, so a stale copy is told before anyone applies it.
  3. The diff is per tab, by code (availability by `<product code>:<country>`, a guide by its step, or `<step>:<goal>` when it is for a goal): `added`, `updated`, `retired`, `reactivated`, comparing parsed values, so
     `a;b` and `a; b` are one list. **The upload is the whole catalog**: a code it leaves out is retired in place, never deleted, so its code is never
     reused, and a retired code put back is reactivated. A product's availability that is gone is listed under `retired` and the row is removed.
  3a. **`key_ingredient` and `strength`** are two optional plain-text Products columns (at most 80 and 40 characters) after `ingredients_source_url`: the
     ingredient that does the product's main job in plain words ("Azelaic acid") and its strength as the label states it ("10%"). They are stored,
     exported and diffed like every other Products column, and are shown to people in "what to look for"; **no rule, matcher or routine writer reads them**
     (`Recommendation` and `Candidate` carry them, `SkeletonCandidate` does not). A strength without a key ingredient is `STRENGTH_WITHOUT_INGREDIENT` on the
     `strength` cell, because a strength alone means nothing; it is not raised when the `key_ingredient` header is missing (that is `MISSING_COLUMN`, once).
     **After the 2.1.0 deploy, re-export the staging catalog sheet before its next edit and upload**, and re-export any saved eval snapshot workbook
     (`eval-data/routine/catalog-snapshot.xlsx`): a 2.0.0 file is refused as `409 CONTRACT_MISMATCH`, with no special case.
  3b. **The Guides tab** (contract 2.2.0, spec #217) holds what each routine step is for (`what_it_does`), what to check on the label (`look_for`) and what suits
     deeper skin (`for_deeper_skin`), each required plain text of at most 300 characters, and an optional `look_for_when_pregnant` (same limits), with the status
     and sign-off columns of Tapers. It is written by the team and never by a model. **A guide has no code: a row is its `step` (a routine step) and its optional
     `goal`** (a value of `GOALS`, the goals a person can pick, read from `goals.vocabulary.ts` so the two lists cannot drift: a goal added there is accepted here
     at the next contract bump). The tab's rules: every text cell passes the routine wording gate, `FORBIDDEN_WORDING` from `routines.wording.ts`, as
     `GUIDE_WORDING` on the cell, **drafts included** (a cell over its length cap says only that); at most one row for a step and goal, of any status, as
     `GUIDE_DUPLICATE` on `step` for every row of the clash; and each of the four steps has one **approved** row with no goal, or the import is refused with
     one `GUIDE_BASE_MISSING` on row 1, column `step` (a draft or retired base row does not count). **The pregnancy rule is a review rule, not code:** a row
     with no `look_for_when_pregnant` is shown to a pregnant or breastfeeding person as it is, so its `look_for` must be safe in pregnancy (the contract document
     says so). A guide is stored in `guides`, keyed by a text `key` (`step`, or `step:goal`), not by `(step, goal)`: SQLite treats a null goal as different from every
     other, so a composite key would add a base row on every upload. A guide left out of an upload is retired in place by that key, never deleted. The export lists
     guides in routine step order, a step's base row first, then its goals in the order `GOALS` has them. **There is no seed:** a fresh catalog exports an empty Guides
     tab, which fails the contract with `GUIDE_BASE_MISSING`, so the first upload after the 2.2.0 deploy carries the four base rows.
     `CatalogWorkbookService.guideFor(step, goal)` gives `{ whatItDoes, lookFor, forDeeperSkin, lookForWhenPregnant }` of the approved row for that step and goal, whole
     (nothing is borrowed from the base row), else of the step's approved base row, else `null` (a catalog nobody has written guides for); a draft or retired
     row is never given, and no status or sign-off column leaves the service.
     **After the 2.2.0 deploy, re-export the staging catalog sheet and write the four base guide rows (approved) before its next import**: an unedited export is
     refused until then, and a 2.1.0 file is refused as `409 CONTRACT_MISMATCH`. The same goes for a saved eval snapshot workbook.
  3c. **The Reintroductions, Escalations, Responses and Weeks tabs** (contract 2.3.0, spec #233) are the reviewed text of the daily loop, with the status and sign-off
     columns of Tapers and the same production approver gate. They have no code: each row is its key, and each is stored in a table of its own keyed by a text `key`
     (a null group or goal cannot be part of a composite key, as for `guides`), retired in place and never deleted. A row left out of an upload is retired by
     that key. Every text cell is plain text and passes `FORBIDDEN_WORDING` as the tab's own `*_WORDING` rule on the cell, drafts included; a cell over its
     length cap says only that. A duplicate key is reported on every clashing row of any status; a tab that lacks a row it needs is refused once on row 1 in its
     key column.
     - **Reintroductions** (`group`, `schedule`): how a paused product is brought back slowly. The schedule is written like a Tapers one (`1: weekly; 2: alternate-days; 3: back`)
       but climbs (as-needed, weekly, alternate-days, am or pm, am-pm; equal steps are fine) and ends with `back`, the routine's own frequency from there on. There is
       no `stop`, weeks run on from 1 with no gap, and it is at most 12 weeks: `BAD_SCHEDULE` (a `stop` or week 13), `SCHEDULE_NOT_CONTIGUOUS`,
       `REINTRO_MISSING_BACK`, `REINTRO_BACK_NOT_LAST`, `REINTRO_FREQUENCY_DECREASES`. **A ladder needs at least one step before `back`** (`REINTRO_BACK_ONLY`, for
       `1: back` or `1-12: back`): nothing is brought back at full strength at once. An empty `group` is the default ladder, and one approved default is needed
       (`REINTRO_DEFAULT_MISSING`); one row a group (`REINTRO_DUPLICATE`); `mercury`, `steroid` and `lightening-agent` (`REINTRO_NEVER_BACK` in the schema) have no ladder,
       whatever the status (`REINTRO_GROUP_NEVER_BACK`). Key: `default` or the group.
     - **Escalations** (`reason` from `ESCALATION_REASONS`, `who_to_see`, `how_soon`, `what_to_tell_them`, each up to 300 characters): what the app shows when it sends a
       person to a professional. Each reason needs one approved row (`ESCALATION_MISSING`, `ESCALATION_DUPLICATE`, `ESCALATION_WORDING`). Key: the reason.
     - **Responses** (`outcome` from `RESPONSE_OUTCOMES`, `title` up to 120, `body` and optional `what_to_do_now` up to 300): the text that answers a skin log or a check-in
       after a pause. `{step}` is the one placeholder, and the app always shows it as the step's plain noun (Cleanser, Treatment, Moisturiser or Sunscreen, never a product
       title), or as "your routine" when the answer is about no step (the `nothing-to-pause` check-in). The wording gate (`RESPONSE_WORDING`) reads the text once for each of
       those five readings, and every reading must pass. Braces are strict: once every exact `{step}` is taken out, any `{` or `}` left is `RESPONSE_PLACEHOLDER`
       (`{step`, `step}`, `{step}}` and `{x}` are all refused). Each outcome needs one approved row (`RESPONSE_MISSING`, `RESPONSE_DUPLICATE`). Key: the outcome.
     - **Weeks** (`band` from `WEEK_BANDS`, optional `goal`, `step_down` yes or no with empty meaning no, `title` up to 60, `text` up to 300): the week card on Today. Each
       band needs one approved base card with no goal and no step-down (`WEEK_BASE_MISSING`); one row for a band, goal and step-down (`WEEK_DUPLICATE`, `WEEK_WORDING`).
       Key: the band, then `:<goal>`, then `:step-down`. A spreadsheet number 1 or 2 is read as the band. **Keep the band column as text:** a spreadsheet turns a band typed as `3-4` into a
       date, so `catalog:export` writes the column (header, cells and the rest of the column) with the text format `@`; a band cell that arrives as a date a band makes (`3-4` as
       4 March or 3 April, `5-8`, `9-12`) is reported as `WEEK_BAND_DATE` and not only as not in the vocabulary.
     The service reads them: `reintroductionFor(group | null)` (the approved ladder of the group, else the approved default, else `[]`; `[]` too for a group that is never brought back, which does not get the default), `escalationFor(reason)`,
     `responseFor(outcome)` (`{step}` left as written) and `weekCardFor(week, goal, stepDown)` (week 13 and later use `9-12`; the first approved match of
     (band, goal, step-down), (band, no goal, step-down), (band, goal, no step-down), (band) wins), each `null` when the catalog has nothing approved. A draft or
     retired row is never given. Statement budget: 11 ladders, 9 escalations, 9 responses and 8 week cards to a statement.
     **After the 2.3.0 deploy, re-export the staging catalog sheet and fill the required rows (the default ladder, a row for each reason and each outcome, a base card for
     each band) before its next import**: an unedited export is refused until then, and a 2.2.0 file is refused as `409 CONTRACT_MISMATCH`. The same goes for a saved
     eval snapshot workbook.
  3d. **Reviewer role, claim word source and the `about-a-product` escalation** (contract 2.4.0, spec #259) are what the shelf verdict shows next to a reason.
     Ingredients and Claim words gain `reviewer_role` (after `approved_by`): plain text of at most 80 characters, required once the row is approved, and the role of
     the person who reviewed the row as the app shows it under "Reviewed by" (for example "a consultant dermatologist"), **never a name**. Claim words also gain an
     optional https `source_url`. Both are nullable columns (`reviewer_role` on `ingredient_rules` and `claim_words`, `source_url` on `claim_words`), and a row stored
     before 2.4.0 reads them as null. **`reviewer_role` is rule metadata, not part of the rules version**, like `group` and `clashes_with`: the fingerprint still hashes
     only what the matcher reads, so a change to it moves the catalog version and re-analyses nothing. `readVerdictReference` gives them (`reviewerRole` on a rule and a
     claim word, `sourceUrl` on a claim word); the production approver gate is unchanged and does not cover these two tabs. `ESCALATION_REASONS` gains `about-a-product`
     at the end: the reviewed text shown when a person taps "Talk to a professional" about a shelf product, and, like every reason, it needs its one approved row
     (`ESCALATION_MISSING`) and passes the wording gate.
     **After the 2.4.0 deploy, re-export the staging catalog sheet, fill `reviewer_role` on every approved Ingredients and Claim words row, and add the approved
     `about-a-product` Escalations row before its next import**: an unedited export is refused until then, and a 2.3.0 file is refused as `409 CONTRACT_MISMATCH`.
     The same goes for a saved eval snapshot workbook.
  4. **The join is exact.** A Products row finds its catalog product by identity key, then by alias; otherwise it is a new product (listed in
     `newProducts`, which a dry run shows too). There is **no near-miss search and no model call**, so an import makes no outbound request; a different
     spelling of a product the catalog knows becomes a second product, which the diff makes visible. The workbook's list is stored as a formulation of
     `source_kind` `'workbook'` and the row pins it; if the product already has that exact list, that formulation is the one pinned and nothing is added,
     and any other list the product had is left as it was.
  5. A dry run stops here and writes nothing. An apply without a file is 400 `CATALOG_FILE_REQUIRED`; a file over 10 MB is 400 `CATALOG_FILE_TOO_LARGE`; one that does not start with the zip bytes `PK\x03\x04` (an .xlsx is a zip; the server never opens it) is 400 `CATALOG_FILE_NOT_XLSX`. The whole body is capped at 16 MB (413), after the token is checked. `uploadedBy` is trimmed before its 1 to 80 characters are checked. A file that cannot be archived is 503 `CATALOG_ARCHIVE_FAILED`, and nothing is applied.
  6. **The archive** is put first, through the `WorkbookArchive` port (`providers/workbook-archive`: an R2 adapter and a memory fake, locked to the
     environment like the photo store). It lives in the private bucket under `workbooks/<environment>/<version>-<uuid>.xlsx`, as an `.xlsx`, never cached.
     The key is made for the attempt, so a batch that fails or loses leaves an orphan object and never overwrites another upload's file; the key that
     counts is the one on the version's `catalog_versions.archive_key`.
  7. **`applyWorkbook(plan)`** is one repository method and one `db.batch`. Only the rows the diff names are written. It upserts countries, creates the new
     products (`on conflict (identity_key) do nothing`), stores the workbook formulations (`on conflict (product_id, ingredients_key) do nothing`),
     upserts the Products rows with their pinned formulation found by a subquery, replaces availability when it changed, upserts the rules, the claim
     words and the tapers, and marks the codes the upload left out retired.
- **Claim words, tapers, and rule metadata.** A Claim words row is a lower-case phrase that says a product is sold for lightening (`claim`
  `lightening`; status `approved` or `retired`; no draft). A Tapers row is a step-down template: `kind` (`steroid` or `lightening-agent`), a `schedule`
  and two plain-text cells (what to expect, when to see a professional). The schedule is written `1-2: alternate-days; 3-4: weekly; 5: stop`: steps
  separated by `;`, each its weeks (`N` or `N-M`) and one frequency (the usual ones, or `stop`), weeks running on from 1 with no gap or overlap and at most
  52, the frequency never going up (am-pm, then am or pm, then alternate-days, then weekly, then as-needed, then stop), ending with `stop` and with `stop`
  only last. It is parsed into `{ fromWeek, toWeek, frequency }[]`, stored as JSON, and exported in that one canonical spelling, and the diff compares
  parsed steps, so spacing is no change. An Ingredients row gains `group` (mercury, steroid, lightening-agent, retinoid, exfoliating-acid,
  benzoyl-peroxide; empty for most) and `clashes_with` (groups; the relation must hold both ways among the rules that are not retired). **Group and
  clashes_with are rule metadata, not part of the rules version:** the fingerprint hashes only what the matcher reads, and `liveRules().entries` stay
  exactly `{ name, aliases, kind, rule, source }`, so adding groups to the seeded rules re-analyses no formulation; they are read with the workbook
  (`readWorkbook`). The live-rules cache (per isolate) is keyed on the catalog version, which is read on every call, so an isolate re-reads the rules on its first call after an upload lands; a call already in flight at that moment can still return the previous rules. None of the three is ever deleted.
- **A saved routine reads its recommended product by code, retired or not sold here.** `CatalogWorkbookService.recommendedByCode(codes)` (modelled on `tapersByCode`) gives a `Map` from code to `{ code, status, productId, formulationId (null for a retired row with no list), origin, keyIngredient, strength, availability: { country, priceMin, priceMax, whereSold }[] }` for every row asked for **whatever its status** (a retired row is returned) and **every country it is sold in** (country order; empty if none), where `approvedFor` only returns approved rows sold in one country. A code with no row is absent. The codes are looked up in chunks (`queryByIds`), so any number stays under D1's 100 bound parameters.
- **Statement budget.** The three new tables are written in chunks like the others (9 claim words, 9 tapers and 5 rules to a statement, rules now binding
  17 parameters a row and claim words 11), inside the same single batch; so are guides, 7 to a statement (13 parameters a row), retired by 90 keys a statement.
- **The race guard is the primary key.** The batch's FIRST statement inserts the next catalog version, `baseVersion + 1`. If another upload took that version
  since the service read it, the insert violates `catalog_versions.version` and D1 rolls the WHOLE batch back, so the loser writes nothing: no product, no
  formulation, no row, no version. The repository then sees that the live version moved past `baseVersion` and reports it, and the service answers
  409 `CATALOG_STALE`. If the batch throws, the repository reads the row of version `baseVersion + 1`: it carries this upload's own archive key (the batch committed and only its answer was lost, so the upload stands and is reported as applied), another upload's key (a lost race), or there is none (a real failure, which surfaces as one). No later statement needs its own guard, because none can apply alone.
- **The rules version names a set.** An upload's approved rules, in code order, are hashed, each rule's aliases sorted first because they are a set (`catalog.workbook.rules-version.ts`): `rules-<first 16 hex of
  the sha256 of the stable JSON of the entries the matcher reads>`. If the set is the one in force, **the current version is kept**, so a Products-only
  upload, or an edit to a draft, moves nothing and no product is analysed again. The seed's set is always `seed-2026-10`, so restoring it is not a new
  version, and restoring any other set gives back exactly the version it had. An edit that changes what the matcher reads (name, aliases, kind, statement,
  source, or a rule approved, drafted or retired) is a new version, and each product is analysed again on its next scan.
- **Size, and what Cloudflare documents.**
  - Every table is written with **multi-row** statements, chunked so none binds more than D1's 100 parameters (`STATEMENT_ROWS` in the repository: for
    example 3 Products rows, 12 formulations, 15 availability rows, 6 rules, 11 claim words or 9 tapers to a statement, and 90 codes to a retire). A test reads the parameters off
    the built statements. The batch is still ONE `db.batch`, with the version insert first.
  - A 500-product, 1500-availability, 200-rule workbook applied against local D1 as **409 statements** (it was about 1,200 with a statement for each row)
    in about 0.66 s for the whole request (0.46 s as a dry run); a one-cell change is 2 statements. This is local, a simulation.
  - What the docs say (https://developers.cloudflare.com/d1/platform/limits/): 1,000 queries per Worker invocation on the paid plan (50 on free); 100 bound
    parameters and 100 KB of SQL a statement, and the limits for individual queries "apply to each individual statement contained within a batch"; 30 seconds
    for a batch call as a whole; no stated cap on the number of statements in a batch. The batch API page
    (https://developers.cloudflare.com/d1/worker-api/d1-database/) says a batch is a SQL transaction that rolls back whole when a statement fails, and **does
    not say whether the statements of a batch count one by one toward the per-invocation query limit**. So the service assumes they do:
    `CatalogWorkbookService` refuses a plan of more than 900 statements (`MAX_BATCH_STATEMENTS`, under 1,000 with room for the request's other reads)
    with 400 `CATALOG_TOO_LARGE`, for a dry run too and before anything is archived. A batch is never split, because a split could not be atomic; a change
    that big is made in several uploads, each from the version the last one made.
  - **Remote behaviour has not been confirmed.** Nothing above was run against a remote D1. Before relying on it, apply a catalog-sized upload on
    staging (a few hundred products with availability) and check that it commits and how long it takes; the 900 limit is a guess at the safe side, to be
    set from that run.
- **Logs** carry the catalog version, the per-tab counts and the outcome (`catalog-import-applied`, `-dry-run`, `-invalid`, `-stale`, `-lost-race`, `-too-large`, `-contract-mismatch`, `-unqualified-approver` (a count only), and `catalog-archive-failed`, which carries the version only), never a
  brand, a name, an ingredient, a rule or a place of sale.

### OTP over channels (email now, WhatsApp later)
A sign-in code goes to a **recipient**: a channel plus an address on it. Today that is email, sent
through ZeptoMail (see above); WhatsApp, through the Meta WhatsApp Cloud API with an approved
authentication template, is built but switched off until Meta approves the template. There are no
HTTP routes of its own: `AuthService` calls `otp.send({ channel, address })` and
`otp.verify({ channel, address }, code)` behind the auth routes (see Auth routes).

- **`OTP_CHANNELS` decides what people may request.** A comma-separated list of channel names in
  `wrangler.jsonc` (`email`, `whatsapp`), read once by `parseOtpChannels`; an unknown name throws,
  so a typo is loud. `send` checks the channel first and answers `OTP_CHANNEL_UNAVAILABLE` (400) for
  one that is off. `verify` and the delivery job do not check it, so a code issued before a channel
  was switched off still verifies and still delivers.
- **Recipient = channel + address.** `OtpRecipient` is a union, so a WhatsApp recipient always
  carries a `PhoneNumber` and an email recipient an `EmailAddress`. Cooldown, hourly cap, latest
  challenge and purge are all per recipient, so an email and a phone number never share limits.
- **Meta direct, not through a WhatsApp vendor.** Vendors pay Meta's per-message rate and add a
  margin on top. Calling the Cloud API ourselves avoids that margin.
- **Business registered in Nigeria.** Users are in Nigeria. A Nigerian business pays the local
  authentication rate; an overseas one pays Meta's much higher authentication-international rate.
- **One format per channel.** `parsePhoneNumber` (`lib/phone.ts`) returns a branded E.164
  `PhoneNumber`; a number without a country code is read as Nigerian. `parseEmailAddress`
  (`lib/email-address.ts`) returns a trimmed, lower-case `EmailAddress`. Every lookup, store and
  send uses the canonical form, so `0803…` and `+234803…` are the same number and `Ada@Example.com`
  is `ada@example.com`.
- **Only an HMAC of the code is stored**: `HMAC-SHA256(OTP_PEPPER, "<channel>:<address>:<code>")`. A leaked
  table cannot be brute-forced without the pepper. The channel and address are part of the input, so a code sent
  to one recipient never verifies for another. The comparison is constant time (`timingSafeEqual`).
- **Codes come from the CSPRNG**, six digits, via `randomDigits`, which rejects bytes that would
  bias the digits.
- **One policy object, `OTP_POLICY`**: 6 digits, valid 10 minutes, 5 wrong tries, single use, a
  60s resend cooldown, and at most 5 sends per recipient per rolling hour. The WhatsApp template's
  code expiry is set by hand in Meta, so it must match `ttlMinutes`; the email says the same
  number, taken from the policy.
- **A new code supersedes the old one.** Verify checks only the latest challenge.
- **`send` stores, then queues; it does not call the provider.** It stores the challenge as `queued`,
  seals the code and enqueues the `deliver-otp` job, then returns `{ challengeId, expiresAt }`.
  *Why:* the person no longer waits on the provider, and a provider outage becomes retries instead of an
  error. This deliberately reverses the earlier "deliver before storing" rule: the challenge now
  exists before delivery, so a failed one is marked `failed` and the cooldown and hourly cap count
  only non-failed challenges, which keeps "a failed send does not use up your limit". If the enqueue
  itself fails, the challenge is marked failed (`unavailable`) and `send` answers 503.
- **The code in the queue message is sealed**: AES-256-GCM (`sealText`/`openText`), key =
  HKDF-SHA-256(`OTP_PEPPER`, info `deepertones/otp-queue/v1`), random 12-byte IV, additional
  authenticated data = the challenge id. The queue, its dead-letter queue and dashboards never hold
  a usable code; a sealed code copied into another challenge's message cannot be opened; and the
  key differs from the HMAC key used for stored hashes because `info` differs. No new secret.
- **What counts toward the cooldown and hourly cap.** Every challenge counts except those that
  failed as `unavailable` (our outage or the provider's must not use up the person's limits). A terminal
  `recipient-rejected` counts like a normal send, which closes a free retry loop. Per-IP/edge rate
  limiting at the route is still required, for attackers who rotate numbers.
- **The queue message carries no address**, only `{ challengeId, sealedCode }`: less personal data in
  the queue and its dead-letter queue, and the DB row is the authoritative source.
- **Delivery status** (`queued`, `delivered`, `failed` with `recipient-rejected` or `unavailable`)
  is read with `deliveryStatus(challengeId)`. `verify` ignores it: a fast typist is not rejected
  because the status has not caught up. "Delivered" means the provider accepted the message. A challenge whose job was dropped
  (superseded, expired or used) keeps reporting `queued`: the job is done and nothing was sent. A
  failed resend replaces the earlier code, because only the latest challenge verifies.
- **The `deliver-otp` job** (key = challenge id) drops a message whose challenge is no longer the
  latest for its recipient, is expired, used, or no longer `queued`. A rejected recipient is permanent
  (challenge marked failed, run acked). A seal that cannot be opened is permanent too, and so is a
  provider that reports our own setup is wrong (`misconfigured`, recorded as `unavailable`). Anything
  else is temporary and retried with full-jitter backoff (base 5s, factor 3, cap 135s), so five
  attempts finish well inside the 10 minute code life. When retries run out, the dead-letter hook
  marks the challenge failed (`unavailable`) unless it was delivered. A repeat resends the same
  code, which is harmless.
- **Failed attempts and consume are each one conditional UPDATE** (`recordFailedAttempt`,
  `consume`). `consume` succeeds only if the code is unconsumed, under the attempt cap and
  unexpired, so the 5-try limit and single use hold under concurrency. Storing a send is one
  `db.batch`, per the atomic-writes rule above.
- **The resend cooldown and hourly cap are check-then-act.** Parallel sends for one number can each
  go out. The send route is therefore rate limited per IP and per user (see Auth routes).
- **Old rows are purged on send.** Challenges older than 24h for that recipient are deleted when a
  new one is stored, so the table does not grow without bound.
- **Error codes are the UI contract.** Send: `OTP_CHANNEL_UNAVAILABLE` (400, the channel is off),
  `INVALID_PHONE` and `INVALID_EMAIL` (400), `OTP_COOLDOWN` and
  `OTP_SEND_LIMIT` (429, with `Retry-After`), `OTP_DELIVERY_UNAVAILABLE` (503, only when the
  enqueue itself fails). A rejected recipient is not a `send` error: it appears later as
  `deliveryStatus` `failed` with reason `recipient-rejected`. Verify: `OTP_INVALID` (400, with `attemptsRemaining`),
  `OTP_EXPIRED` (400), `OTP_TOO_MANY_ATTEMPTS` (429).
- **The adapter classifies, the service decides.** The Meta adapter sorts Meta's error codes into
  `recipient-rejected`, `unavailable` (5xx, 429, rate limits and Meta's transient codes) and `misconfigured`
  (everything else, plus empty settings) as `OtpDeliveryError`, and the ZeptoMail adapter does the same with
  `EmailDeliveryError`. The `deliver` job turns `recipient-rejected` from either into a permanent failure
  recorded on the challenge, and rethrows `unavailable` so the queue retries. `misconfigured` from either
  channel is also a permanent failure, recorded as `unavailable` (so it does not use up the person's
  limits), with the provider's codes in the job run's `last_error`. Any other plain error (a bug) is
  rethrown and retried.
- **Real providers in every environment**, local dev included, so a bad key or template shows up
  before production. Tests never reach Meta or ZeptoMail: the service runs on `MemoryOtpDelivery`,
  `MemoryEmailSender` and `FakeOtpRepository`, and the adapters are tested with a stubbed `fetch`.
- **The two required secrets are `ZEPTOMAIL_API_KEY` and `OTP_PEPPER`.** They are listed in
  `secrets.required`, so a deploy fails until both are set on that environment's Worker.
  `WHATSAPP_ACCESS_TOKEN` is not required while WhatsApp is off; it is typed as an optional binding
  in `src/lib/env.ts` (wrangler only types required secrets), and the adapter throws if WhatsApp
  is enabled without it. Make it required again when `whatsapp` joins `OTP_CHANNELS`, and also delete the optional
  declaration in `src/lib/env.ts`, or the regenerated required type will conflict with it.
- **Not built yet:** a delivery-status webhook (Meta reports some undeliverable numbers only
  later, so `recipient-rejected` covers the synchronous rejections only; ZeptoMail bounces are
  not read back either), an SMS fallback, and auth itself.

## Adding a module

1. `src/modules/<feature>/`: table → `npm run db:generate` → types → D1 repository class
   (+ inferred type) + fake + contract → service → schemas (request + response) → presenter → routes
   (`defineRoute` with `success()` for each 2xx response, `openapiApp().openapi(route, handler)`
   with `ok()` in the handler).
2. Wire it in `src/container.ts` and expose a getter; mount the routes in `src/app.ts`, on the `v1` sub-app (see "API versioning").
3. Unit-test the service with the fake (`runAs(...)` if it reads the actor); run the contract
   in both tiers; add a route test in `test/integration/` if the HTTP surface matters.
4. `npm run openapi` and commit `docs/openapi.json`.
5. `npm run lint:arch && npm run typecheck && npm test`.
