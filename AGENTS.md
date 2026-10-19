# AGENTS.md

Guidance for agents and contributors working on **backeneko**.

## What this project is

A Bun CLI that turns a directory of `.graphql` schema files into a runnable
**mock GraphQL backend**:

1. scans `--source` recursively for `*.graphql` / `*.gql`,
2. merges them into a single SDL (duplicate types become `extend`),
3. generates a workspace directory (default `.backeneko`) with
   `schema.graphql`, a disposable `generated/` mirror (`entities/<TypeName>.ts`
   and one function file per root field under `queries/`, `mutations/`,
   `subscriptions/`) plus a user-owned `override/` tree with the same layout,
4. serves the schema over HTTP with mock data resolved from those directories,
5. hot-reloads mocks (and the schema) when files in the workspace change.

The workspace directory name is intentionally **`.backeneko`** (not
`backend`) — do not "fix" it.

## Commands

```bash
bun install                 # install deps
bun run typecheck           # tsc --noEmit (must pass)
bun test                    # bun test (must pass)
bun run start -- --source=<dir> [--port=4000] [--dir=.backeneko]
bun run demo                # run against examples/source on :4000
```

Always run `bun run typecheck` and `bun test` before considering a task done.

## Architecture

| File | Responsibility |
| --- | --- |
| `src/cli.ts` | entry point: parse args, generate workspace, start server + watcher |
| `src/args.ts` | CLI argument parsing and help text |
| `src/collect.ts` | recursive discovery of `.graphql`/`.gql` files |
| `src/merge.ts` | merge SDL documents; repeated types → `extend`, `renderSdl` |
| `src/compile.ts` | tolerant schema build: drop unknown directives, prune broken defs |
| `src/graphql-internal.ts` | the single deep import of `graphql`'s internal `validateSDL` |
| `src/generate.ts` | rewrite `schema.graphql`, `generated/**`, workspace `tsconfig.json` |
| `src/directives.ts` | `@backeneko`/`@mock` directives: auto-declare, collect field values |
| `src/mocks.ts` | load mock modules (override-first) with `Bun.build`, `data:`-free cache dirs |
| `src/resolvers.ts` | build executable schema, attach resolvers, mock fallback |
| `src/runtime.ts` | mutable shared state (`schema`, `modules`) |
| `src/server.ts` | `Bun.serve` HTTP: `/graphql` (GET/POST), HTML inspector at `/` |
| `src/watch.ts` | recursive `fs.watch` with debounce (workspace, `--source` tree) |

### Behavior rules

- With `--source`, generation runs on every start: `schema.graphql` and the
  whole `generated/` tree are rewritten (files are only touched when their
  content changes; files whose type/field left the schema are pruned). The
  `override/` tree is **never** written or removed. Without `--source`, an
  existing workspace is served as-is.
- With `--source`, the source tree is watched as well: any change to its
  `.graphql`/`.gql` files re-runs generation and then reloads schema + mocks
  (only if generation actually wrote something). `.git`, `node_modules` and
  `dist` are ignored. Generation never exits the process while watching — a
  broken source logs an error and the last good workspace keeps serving.
- Loading prefers `override/<kind>/<name>.ts` over `generated/<kind>/<name>.ts`
  over the pre-`generated/` top-level `<kind>/` layout (and the legacy `mocks/`
  directory last), so a user override always shadows the generated file.
- Compilation is **tolerant**: unparseable files, unknown directives, and
  definitions that fail SDL validation are dropped with a warning instead of
  aborting the run. Pruning is field-level where possible; a type is dropped
  only when it loses every field. A missing `Query` gets a placeholder.
- Resolvers read `runtime.modules` at execution time, so mock changes do not
  require rebuilding the GraphQL schema.
- Incoming queries are validated against the schema by default; `--no-validate`
  skips the validation step (unknown fields are then silently dropped). Parsed
  documents are cached by query text, which is schema-independent.

### Workspace layout and mock contract

```
.backeneko/
├── schema.graphql                  # merged schema (rewritten each start)
├── tsconfig.json                   # written by backeneko: @<dir>/* aliases, allowImportingTsExtensions
├── generated/                      # disposable mirror of the schema
│   ├── entities/<TypeName>.ts      # one file per object/interface/union type
│   ├── queries/<fieldName>.ts      # one file per Query field
│   ├── mutations/<fieldName>.ts    # one file per Mutation field
│   └── subscriptions/<fieldName>.ts
├── override/                       # user-owned; same structure, never written
└── cache/<name>-<hash>/<name>.mjs  # bundled mock modules
```

- Generation emits imports through the workspace path aliases
  (`@entities/Post.ts`, `@queries/...`, ...), whose workspace `tsconfig.json`
  maps override-first → generated → legacy top-level. Because `Bun.build` is
  given that tsconfig explicitly, generated relation getters pick up the user's
  override for the related type without regeneration knowing about it.
- An **entity** file's `default` export is the value used when a field
  resolves to that type (object, array, or a function returning one). A named
  export matching a field name overrides that field's resolver.
- Object/interface/union fields are pre-filled with the related entity through a
  getter (`get location() { return CustomerLocation; }`) and an `@entities/...`
  import, so relations resolve out of the box. Getters keep cyclic relations
  (A → B → A) from breaking module initialization.
- A **root field** file's `default` export is a function
  `(parent, args, context, info) => value`. If the file (or export) is missing,
  the resolver falls back to the entity mock of the field's named return type.
- Fallback shape coercion: single values are wrapped into lists and lists are
  reduced to their first element to match the field shape.
- **Mock directives** `@backeneko(value: "...")` and `@mock(value: "...")` (both
  names are equivalent) pin an entity field's generated value. backeneko owns
  them: if a schema uses one without declaring it, `src/compile.ts` injects
  `directive @<name>(value: String) on FIELD_DEFINITION` before SDL validation
  (a user declaration is respected). The value is always a string and is cast
  to the field's type where possible (`Int`/`Float`→number, `Boolean`→bool,
  `String`/`ID`/enum/custom scalars→string). Only single scalar/enum fields are
  supported; on list or object/interface/union fields the directive is ignored
  with a warning and the type default is kept. Warnings are returned in
  `GenerationResult.warnings` and printed by the CLI.
- The legacy single `mocks/` directory (one file per type, named exports for
  root fields) is still loaded if present.

### Hot reload

`fs.watch` is recursive and debounced (150 ms). Mock files are re-imported by
bundling with `Bun.build` and writing the JS to a per-bundle directory inside
the workspace, `.backeneko/cache/<name>-<contentHash>/<name>.mjs`, then
importing that path. Three Bun constraints dictate this:
- `?t=` query-string cache busting does not work in Bun;
- a `data:text/javascript;base64,...` URL breaks once a module gets large
  (`ResolveMessage: NameTooLong`);
- Bun stops resolving files created in a directory *after* the first import
  from that directory, so each bundle needs its own content-hashed directory
  (new content → new directory → re-imported; unchanged content → module cache).

Changing `schema.graphql` rebuilds the schema.

## Conventions

- TypeScript strict, ESM, `.ts` import specifiers (see `tsconfig.json`).
- Only runtime dependency is `graphql`; prefer the Bun standard library over
  new packages.
- No comments in source unless they explain a non-obvious constraint.
- Keep functions small and pure where possible; IO lives in `cli.ts` /
  `server.ts` / `watch.ts`.
