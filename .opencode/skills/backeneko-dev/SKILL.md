---
name: backeneko-dev
description: Use when developing or modifying the backeneko tool itself — CLI parsing, schema collection/merging, workspace generation, resolvers, HTTP server, or hot reload. Not for writing mock data files.
---

# Developing backeneko

backeneko is a Bun CLI that generates a `.backeneko` workspace (schema + a
disposable `generated/` mock mirror + a user-owned `override/`) from a directory
of GraphQL schemas and serves it as a mock GraphQL backend.

## Workflow

1. Read `AGENTS.md` for the architecture table and behavior rules.
2. Keep the workspace directory name `.backeneko` (intentional typo).
3. Run `bun run typecheck` and `bun test` after every change.
4. Smoke test manually:

   ```bash
   rm -rf .backeneko
   bun run src/cli.ts --source=examples/source --port=4123 &
   curl -s localhost:4123/graphql -H 'content-type: application/json' \
     -d '{"query":"{ users { id name role } }"}'
   ```

## Non-obvious constraints

- **Cache busting:** Bun ignores `?t=` query strings when re-importing the same
  file, and a `data:text/javascript;base64,...` URL fails once a module is large
  (`NameTooLong`). Worse, Bun does not resolve files that appear in a directory
  *after* the first import from that directory. So `src/mocks.ts` bundles each
  mock with `Bun.build` and imports it from its own content-hashed directory
  under `.backeneko/cache/<name>-<hash>/<name>.mjs`. `watch.ts` skips the
  `cache` directory so writing a bundle does not trigger a reload. Never drop
  the per-bundle directory or fall back to query-string busting.
- **Resolver timing:** field resolvers read `runtime.modules` on every
  execution, so reloading mocks never rebuilds the schema. Only
  `schema.graphql` changes trigger a rebuild.
- **generated/ vs override/:** `generateWorkspace` rewrites `generated/**`
  (write-if-changed) and prunes files whose type/field left the schema; it must
  never touch `override/**`. The loader in `src/mocks.ts` resolves
  `override/<kind>/<name>.ts` first, then `generated/<kind>/<name>.ts`.
  `MockModules.overriddenRoot` lists the root fields that come from an
  `override/` file — only those are answered locally when the request is
  proxied.
- **Proxying:** `--proxy-to=<url>` routes a request in `src/proxy.ts`:
  `local` (every root field has an override), `proxy` (none has) or `split`
  (some have — the overridden fields run locally, the rest is forwarded and the
  results are merged). `src/graphql/split.ts` does the AST surgery; only the
  variables and root keys the forwarded part uses are sent upstream.
- **Path aliases:** generation emits `@entities/...` (etc.) imports and writes a
  `.backeneko/tsconfig.json` mapping each alias to
  `override/<dir>/*`, `generated/<dir>/*`, `<dir>/*`, plus
  `allowImportingTsExtensions`/`noEmit` so editors accept the `.ts` specifiers.
  `src/mocks.ts` passes that tsconfig explicitly to `Bun.build` (`tsconfig`
  option) — without it Bun falls back to the repo tsconfig and the aliases fail
  to resolve. This is how a generated relation getter picks up a user override.
- **Merging:** duplicate type definitions across files become `extend` blocks
  and are emitted after all first definitions (graphql-js requires the base
  type to exist first).
- **Existing workspace:** with `--source`, generation runs on every start;
  without it, the existing `.backeneko` is served as-is.

## When adding a dependency

Only `graphql` is a runtime dependency. Prefer the Bun standard library
(`Bun.serve`, `Bun.build`, `Bun.file`, `node:fs`, `node:util.parseArgs`) and
justify anything new in the PR/commit.
