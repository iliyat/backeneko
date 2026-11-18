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
  When interceptors handled the request, the line ends with a magenta `⇄`
  marker and its scope: `⇄ operation` (operation-wide hook), `⇄ all fields`
  (every root field intercepted) or `⇄ <field>, ...` (only some fields). An
  unreachable upstream answers `502` with the reason.

## Request interception

Interceptors rewrite the payload before it is sent and the response after it
arrives. They live in the user-owned `.backeneko/intercept/` directory next to
`override/`; the generator never touches it.

```
.backeneko/intercept/
├── queries/<field>.ts          # one root field of a Query
├── mutations/<field>.ts        # one root field of a Mutation
└── operations/<name>.ts        # a whole operation (default.ts when unnamed)
```

A file is a plain TypeScript module with optional exports:

```ts
export function before(
  payload: Backeneko.Proxy.Payload,
  ctx: Backeneko.Intercept.Context,
): Backeneko.Proxy.Payload {
  return { ...payload, variables: { ...payload.variables, limit: 10 } };
}

export function after(
  result: Backeneko.Intercept.Result,
  ctx: Backeneko.Intercept.Context,
): Backeneko.Intercept.Result {
  return { ...result, data: { ...result.data, users: [] } };
}

export function match(ctx: Backeneko.Intercept.Context): boolean {
  return ctx.variables?.tier === "gold" && ctx.query.includes("preview");
}
```

- `match` gets the same context as the hooks, including `query` and `variables`
  (for a split part — that part's sub-document and picked variables). It runs
  once per part before `before`, and gates both `before` and `after` of that
  interceptor: a request that does not match is handled untouched.
- `before` runs outside-in (field interceptors in operation order, then the
  operation one); `after` runs inside-out, so an operation interceptor wraps the
  whole response.
- In a split request each part runs only its own field interceptors; the
  operation interceptor runs once around both.
- A local route (an override, or `mode: "local"`) executes an already parsed
  document, so `before` can change only `variables` there; `query` and
  `operationName` changes are ignored with a warning. In a fully proxied request
  all three fields can be rewritten.
- A thrown hook, or one returning a non-object, is logged as a warning and
  ignored — the request continues with the unchanged payload/result.
- Interceptors also apply without `--proxy-to`, on the plain local route.
- The context also exposes `operationName`, `operationType`, `rootFields` (field
  names without aliases), `route` (`local`/`remote`/`split`), `target` (upstream
  URL), `rootField` (for field files) and `file` (interceptor path).
- Files match the schema field name; operations match `operationName` from the
  request or, when it is omitted, the single operation's name in the document.
  `operations/default.ts` handles an unnamed operation.

`intercept/operations/<name>.ts` additionally exports `mode` to override the
per-field routing of the whole operation:

| mode | behavior |
| --- | --- |
| `auto` (default) | overridden fields are local, the rest is proxied/split |
| `proxy` | the whole operation goes upstream, overrides are ignored |
| `local` | the whole operation is executed locally, even without overrides |

`mode` is only read from `operations/`; in a field file it is ignored with a
warning. A file without `mode` is just an interceptor and does not change
routing.

Adding, changing or removing an `intercept/` file reloads the interceptors
without a restart. The generated `.backeneko/types.d.ts` declares the global
`Backeneko` namespace: `Backeneko.Proxy.Payload`,
`Backeneko.Intercept.Context` / `Result` / `Error` / `Route` / `Mode` /
`Before` / `After` / `Match`, and `Backeneko.Schema.*` built from
`schema.graphql`. Intercept files need no imports; `@intercept/*` resolves
inside the workspace.

### Typing

By default the dynamic parts are loose: `data` and `variables` are
`Record<string, any> | null`, so `result.data.users` compiles without casts. For
precise types, pass the generated schema types as generic parameters:

```ts
type Context = Backeneko.Intercept.Context<{ tier: "gold" | "silver" }>;
type Result = Backeneko.Intercept.Result<{ users: Backeneko.Schema.User[] }>;

export function match(ctx: Context): boolean {
  return ctx.variables?.tier === "gold";
}

export function after(result: Result): Result {
  return { ...result, data: { users: result.data?.users ?? [] } };
}
```

`Backeneko.Proxy.Payload<TVariables>` and `Backeneko.Intercept.Context<TVariables>`
take the same generic, so `before` can type its variables as well. The
`Backeneko.Schema` namespace mirrors every named type of the schema: objects,
interfaces, unions, enums, inputs and custom scalars (as `any`). Nullable fields
become `T | null`; optional input fields become `field?: T`.

### Known limitations

- `mode` on field files (`intercept/queries|mutations/<field>.ts`) is not
  supported yet.
- `intercept/subscriptions/` is not supported until the server gets an SSE/WS
  transport.

## Development

```bash
bun install
bun run demo        # run against examples/source on :4000
bun run typecheck
bun test
```

See `AGENTS.md` for contributor guidance.
