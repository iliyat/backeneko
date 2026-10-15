# backeneko

Mock GraphQL backend generated from `.graphql` schema files, with hot reload.

## Quick start

```bash
bun install
bun run src/cli.ts --source=./examples/source --port=4000
```

Open <http://localhost:4000/> for a minimal query inspector, or POST to
`/graphql`:

```bash
curl -s http://localhost:4000/graphql \
  -H 'content-type: application/json' \
  -d '{"query":"{ users { id name role } }"}'
```

## How it works

On the first run backeneko scans `--source` for `*.graphql` / `*.gql`, merges
them into one schema and creates a workspace:

```
.backeneko/
├── schema.graphql              # merged schema (rewritten each start)
├── tsconfig.json               # @entities/... aliases: override → generated
├── generated/                  # disposable mirror, rewritten each start
│   ├── entities/
│   │   ├── User.ts             # mock entity (default export)
│   │   └── Post.ts
│   ├── queries/
│   │   ├── users.ts            # one file per Query field: (parent, args, ...) => value
│   │   └── user.ts
│   └── mutations/
│       └── createUser.ts
└── override/                   # your files win; never written by backeneko
    └── entities/User.ts        # shadows generated/entities/User.ts
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
}
```

- No need to declare the directive — backeneko provides it on its own.
- The value is a string and is cast to the field's type where possible:
  `Int`/`Float` → number, `Boolean` → boolean, `String`/`ID`/enum/custom
  scalars → string. An uncastable value is ignored with a warning and the type
  default is kept.
- Only single scalar/enum fields are supported. On list or object/interface/
  union fields the directive is ignored with a warning.
- Generated values are only defaults: an `override/<kind>/<name>.ts` file still
  replaces them entirely.

## CLI

```
bun run src/cli.ts --source=<dir> [--port=4000] [--dir=.backeneko] [--no-validate]
```

- `--source=<dir>` — directory with schema files (recursive).
- `--port=<n>` — HTTP port (default `4000`).
- `--dir=<dir>` — workspace directory (default `.backeneko`).
- `--no-validate` — skip validating incoming queries against the schema.

See `AGENTS.md` for contributor guidance.
