# backeneko
```text
   /\_/\
  ( =.= ) ( (
  /    \  / /
 (_|__|_)/_/
```


Mock GraphQL backend generated from `.graphql` schema files, with hot reload.

## Requirements

Bun >= 1.1 — backeneko runs on Bun (`Bun.serve`, `Bun.build`, recursive
`fs.watch`).

## Install

```bash
bun add -g backeneko   # or: npm i -g backeneko
```

## Quick start

```bash
backeneko --source=./schemas --port=4000
```

`--source` is scanned recursively for `*.graphql` / `*.gql`. Open
<http://localhost:4000/> for a minimal query inspector, or POST to `/graphql`:

```bash
curl -s http://localhost:4000/graphql \
  -H 'content-type: application/json' \
  -d '{"query":"{ users { id name role } }"}'
```

## How it works

On the first run backeneko scans `--source`, merges the files into one schema
and creates a workspace:

```
.backeneko/
├── schema.graphql              # merged schema (rewritten each start)
├── tsconfig.json               # @<kind>/* aliases: override → generated
├── generated/                  # disposable mirror, rewritten each start
│   ├── entities/
│   │   ├── User.ts             # mock entity (default export)
│   │   └── Post.ts
│   ├── queries/
│   │   ├── users.ts            # one file per Query field: (parent, args, ...) => value
│   │   └── user.ts
│   └── mutations/
│       └── createUser.ts
├── override/                   # your files win; never written by backeneko
│   └── entities/User.ts        # shadows generated/entities/User.ts
└── cache/                      # bundled mock modules (per content hash)
```

- Every root field gets its own TS file exporting a resolver function.
- Every entity type gets a file exporting a `default` mock value.
- `generated/` is disposable: with `--source` it is rewritten on every start
  (added/removed fields and types are synced) and files you edited there are
  overwritten.
- Put lasting changes in `override/` with the same path — an override file
  always shadows the generated one and is never written or removed. For
  example, create `override/entities/User.ts` to replace the generated
  `generated/entities/User.ts`.
- Relations are imported through `@entities/...`, which resolves override-first,
  so a generated entity picks up your overridden related entity automatically.
- Edit any mock file — the backend reloads automatically.
- Entity named exports matching a field name override that field's resolver.

Without `--source`, an existing `.backeneko` is served as-is.

## Mock directives

Pin an entity field's generated value straight from the schema with
`@backeneko(value: "...")` or its alias `@mock(value: "...")`:

```graphql
type Product {
  id: ID!
  title: String @backeneko(value: "Pinned Title")
  price: Int @mock(value: "199")
  inStock: Boolean @backeneko(value: "true")
  tags: [String] @backeneko(empty: true)
  note: String @mock(empty: true)
}
```

- No need to declare the directive — backeneko provides it on its own. If the
  schema does declare it, missing backeneko arguments (`value: String`,
  `empty: Boolean`) are appended so both always validate.
- The value is a string and is cast to the field's type where possible:
  `Int`/`Float` → number, `Boolean` → boolean, `String`/`ID`/enum/custom
  scalars → string. An uncastable value is ignored with a warning and the type
  default is kept.
- `empty: true` asks for the type's empty value instead of `value`: `""` for
  `String`/`ID`, `[]` for lists and `null` for any other scalar — but only when
  the field is nullable; on a non-null field with no empty value (`Int!`, a
  non-null relation) it is ignored with a warning. `empty: true` wins over
  `value` (with a warning).
- `value` only supports single scalar/enum fields. On list or object/interface/
  union fields it is ignored with a warning — use `empty: true` there.
- Object/interface/union fields (including lists of them) are pre-filled with
  the related entity through a getter — `get pharmacies() { return [Pharmacy]; }`
  or `get author() { return Author; }` — unless an `override/entities/<Type>.ts`
  replaces that entity. The entity is auto-coerced to the field shape: a list
  field wraps the value (`[]` when the entity mock is empty), a singular field
  takes the first element, so the generated literal only decides null-vs-present.
- Both arguments only apply to entity fields, like everything else here; root
  fields fall back to the entity mock of their return type.
- Generated values are only defaults: an `override/<kind>/<name>.ts` file still
  replaces them entirely.

## CLI

```
backeneko --source=<dir> [--port=4000] [--dir=.backeneko] [--no-validate]
```

- `--source=<dir>` — directory with schema files (recursive).
- `--port=<n>` — HTTP port (default `4000`).
- `--dir=<dir>` — workspace directory (default `.backeneko`).
- `--no-validate` — skip validating incoming queries against the schema.

## Development

```bash
bun install
bun run demo        # run against examples/source on :4000
bun run typecheck
bun test
```

## Publishing

Releases are published to npm by the [Publish](.github/workflows/publish.yml)
GitHub Actions workflow. To cut a release:

1. Bump `version` in `package.json` and commit it to `master`.
2. Push a matching tag on that `master` commit: `git tag v0.1.0 && git push origin v0.1.0`.

The workflow refuses to publish if the tag's commit is not an ancestor of
`master`.

The workflow runs typecheck + tests and publishes with provenance using npm
[Trusted Publishing](https://docs.npmjs.com/trusted-publishers) (OIDC), so no
`NPM_TOKEN` secret is required. It relies on:

See `AGENTS.md` for contributor guidance.
