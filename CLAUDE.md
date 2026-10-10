# deepertones-be

Hono API on Cloudflare Workers. Before writing code, read `docs/architecture.md` and follow it:
thin routes → services → repositories (D1/Drizzle), third parties behind providers, wiring only in
`src/container.ts`. `src/modules/health` is the reference module.

- Before saying work is done, run: `npm run lint:arch && npm run typecheck && npm test`.
- After changing any route or schema, run `npm run openapi` and commit `docs/openapi.json` (CI fails if stale).
- Never loosen a rule in `.dependency-cruiser.cjs` to make code pass. Change the code, or raise it.
- TypeScript stays at 6.x until dependency-cruiser supports 7 (it silently checks nothing on 7).
- After `npm install <pkg>`, if vitest fails with "Cannot find native binding", regenerate the
  lockfile (README → Troubleshooting).
- Branches: `staging` deploys staging, `main` is production (via release-please). No other long-lived branches.
