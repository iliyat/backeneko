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
          [--proxy-to=<url>] [--proxy-timeout=<ms>]
```

- `--source=<dir>` — directory with schema files (recursive).
- `--port=<n>` — HTTP port (default `4000`).
- `--dir=<dir>` — workspace directory (default `.backeneko`).
- `--no-validate` — skip validating incoming queries against the schema.
- `--proxy-to=<url>` — forward requests to an existing GraphQL backend.
- `--proxy-timeout=<ms>` — timeout for a proxied request (default `30000`).

## Proxying to a real backend

`--proxy-to=https://api.example.com/graphql` makes backeneko forward requests
to an existing service instead of answering them from the mocks.

```bash
backeneko --source=./schemas --proxy-to=https://api.example.com/graphql
```

- Root fields with an `override/queries/<field>.ts` or
  `override/mutations/<field>.ts` file are answered **locally**; every other
  root field is proxied. Adding or removing an override file switches a field
  between local and proxied without a restart.
- A query that mixes both is split: the overridden fields are executed against
  the local mocks, the rest is sent upstream, and the two results are merged
  into one response.
- A document with several operations is routed by `operationName`; without it
  the request is forwarded as-is and the upstream reports the ambiguity.
- Only the variables the forwarded part uses are sent, and only the root keys
  the client asked for come back.
- The upstream receives the client's headers (`authorization`, `cookie`, `x-*`);
  hop-by-hop headers are dropped. Requests are normalized to `POST` with a JSON
  body.
- Each proxied request is logged: `[backeneko] proxied → <url> (200, 14ms)`.
  An unreachable upstream answers `502` with the reason.

Request interception (rewriting the payload before it is sent and the response
after it arrives) is planned, not implemented yet — see
[docs/interceptors.md](docs/interceptors.md).

## Development

```bash
bun install
bun run demo        # run against examples/source on :4000
bun run typecheck
bun test
```

See `AGENTS.md` for contributor guidance.
