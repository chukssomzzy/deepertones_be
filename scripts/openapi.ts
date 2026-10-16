// Writes docs/openapi.json from the app's routes: `npm run openapi`.
// Commit the result. CI regenerates it and fails if the committed file is stale,
// so every API change shows up as a readable diff in its PR.
import { writeFileSync } from 'node:fs'
import { apiDocument } from '../src/docs'
import { app } from '../src/app'

const path = 'docs/openapi.json'
writeFileSync(path, `${JSON.stringify(app.getOpenAPI31Document(apiDocument), null, 2)}\n`)
console.log(`wrote ${path}`)
