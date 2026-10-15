---
name: backeneko-mocks
description: Use when writing or editing mock files in a generated .backeneko workspace — generated/ or override/ under entities/, queries/, mutations/, or subscriptions/ — or when pinning entity field values with the @backeneko/@mock directives for a backeneko mock GraphQL backend.
---

# Writing backeneko mocks

The `.backeneko` workspace has a disposable `generated/` mirror plus a
user-owned `override/` with the same structure:

```
.backeneko/
├── generated/                      # rewritten on every --source start
│   ├── entities/<TypeName>.ts      # object/interface/union mocks
│   ├── queries/<fieldName>.ts      # one file per Query field
│   ├── mutations/<fieldName>.ts    # one file per Mutation field
│   └── subscriptions/<fieldName>.ts
└── override/                       # your files; never written or removed
    └── entities/<TypeName>.ts      # e.g. shadows generated/entities/<TypeName>.ts
```

- **Generated files are disposable.** With `--source`, `generated/**` is
  rewritten on every start; edits made directly there are lost. Put lasting
  changes in `override/` under the same path — an override file always wins
  over the generated one of the same name.
- `backeneko` bundles and imports these files and hot-reloads them on change.

## Entities (`<entities>/<TypeName>.ts`)

The `default` export is the value used when a field resolves to that type — an
object, an array, or a function returning one:

```ts
export default {
  id: "1",
  name: "Ada Lovelace",
};

// named export = resolver for that field of the type
export const name = (parent, args, context, info) => parent.name.toUpperCase();
```

Fields whose type is another object/interface/union are generated as getters
that reference the related entity through the `@entities/...` alias, so
relations and cycles resolve out of the box and follow your overrides:

```ts
import CustomerLocation from "@entities/CustomerLocation.ts";

export default {
  cartId: "1",
  get location() { return CustomerLocation; },
};
```

`@entities/*` maps to `override/entities/*` first, then `generated/entities/*`.
A file copied from `generated/` into `override/` keeps working unchanged.

## Pinning field values (`@backeneko` / `@mock`)

Annotate an entity field in the schema to pin its generated value instead of
editing the generated mock. `@backeneko` and `@mock` are aliases; no
declaration is needed — backeneko provides the directive:

```graphql
type Product {
  title: String @backeneko(value: "Pinned Title")
  price: Int @mock(value: "199")
  inStock: Boolean @backeneko(value: "true")
}
```

- The value is a string and is cast to the field type: `Int`/`Float` → number,
  `Boolean` → `true`/`false`, `String`/`ID`/enum/custom scalars → string.
- An uncastable value (`"abc"` on `Int`) is ignored with a warning and the type
  default is kept.
- Only single scalar/enum fields are supported. On list or
  object/interface/union fields the directive is ignored with a warning.
- Use this for schema-driven defaults; use an `override/` file when you need
  logic or relations.

## Root fields (`<queries|mutations|subscriptions>/<fieldName>.ts`)

The `default` export is a function `(parent, args, context, info) => value`:

```ts
import User from "@entities/User.ts";

export default function user(_parent, args) {
  return { ...User, id: args.id };
}
```

- If a root field file (or its `default` export) is missing, backeneko falls back
  to the entity mock of the field's named return type.
- Shape coercion is automatic: a single object is wrapped into a list for a list
  field, and a list is reduced to its first item for a single field.
- Abstract return types (interface/union) need `__typename` in the mock so
  GraphQL can resolve the concrete type.

## Tips

- Multiple records for a list query: `export default () => [ {...}, {...} ]`.
- Mutations read their input from `args`, e.g. `args.input`.
- Verify a change by re-running the query — no restart needed:

  ```bash
  curl -s localhost:4000/graphql -H 'content-type: application/json' \
    -d '{"query":"{ users { id name } }"}'
  ```
- Never rename a file away from the GraphQL type/field name.
