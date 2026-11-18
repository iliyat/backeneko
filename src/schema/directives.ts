import {
  Kind,
  getNamedType,
  isEnumType,
  isListType,
  isNonNullType,
  isScalarType,
  parse,
  visit,
  type ConstDirectiveNode,
  type DefinitionNode,
  type DirectiveDefinitionNode,
  type DocumentNode,
  type FieldDefinitionNode,
  type GraphQLNamedType,
  type GraphQLType,
} from "graphql";

// The two project directives are interchangeable: `@backeneko` and `@mock`.
export const MOCK_DIRECTIVES: readonly string[] = ["backeneko", "mock"];
export const MOCK_DIRECTIVE_ARG = "value";
export const MOCK_EMPTY_ARG = "empty";

const MOCK_DIRECTIVE_ARGS = `${MOCK_DIRECTIVE_ARG}: String, ${MOCK_EMPTY_ARG}: Boolean`;

// `empty: true` asks for the type's empty value and wins over `value`.
export type MockDirectiveUsage =
  | { empty: true; value?: string }
  | { empty: false; value: string };

export type MockValueResult =
  | { ok: true; expression: string; warning?: string }
  | { ok: false; reason: string };

// `list` describes the outermost list, `nullable` the field itself.
export interface FieldShape {
  named: GraphQLNamedType;
  list: boolean;
  nullable: boolean;
}

// backeneko owns these directives, so a schema may use them without declaring
// them. When a name is used but not defined, its definition is injected before
// SDL validation (otherwise `stripUnknownDirectives` would drop the usage).
// A user-declared definition is kept, but missing backeneko arguments are
// appended so both arguments always validate.
export function withMockDirectives(document: DocumentNode): DocumentNode {
  const used = new Set<string>();
  visit(document, {
    Directive(node) {
      if (MOCK_DIRECTIVES.includes(node.name.value)) used.add(node.name.value);
    },
  });

  const defined = new Set<string>();
  for (const def of document.definitions) {
    if (def.kind === Kind.DIRECTIVE_DEFINITION) defined.add(def.name.value);
  }

  let changed = false;
  const definitions = document.definitions.map((definition): DefinitionNode => {
    if (definition.kind !== Kind.DIRECTIVE_DEFINITION) return definition;
    if (!used.has(definition.name.value)) return definition;
    const completed = withOwnedArguments(definition);
    if (completed === definition) return definition;
    changed = true;
    return completed;
  });

  const additions: DefinitionNode[] = [];
  for (const name of MOCK_DIRECTIVES) {
    if (!used.has(name) || defined.has(name)) continue;
    additions.push(
      ...parse(`directive @${name}(${MOCK_DIRECTIVE_ARGS}) on FIELD_DEFINITION`).definitions,
    );
  }
  if (!changed && additions.length === 0) return document;

  return { kind: Kind.DOCUMENT, definitions: [...additions, ...definitions] };
}

function withOwnedArguments(definition: DirectiveDefinitionNode): DirectiveDefinitionNode {
  const owned = parse(`directive @owned(${MOCK_DIRECTIVE_ARGS}) on FIELD_DEFINITION`)
    .definitions[0] as DirectiveDefinitionNode;
  const present = new Set((definition.arguments ?? []).map((argument) => argument.name.value));
  const missing = (owned.arguments ?? []).filter((argument) => !present.has(argument.name.value));
  if (missing.length === 0) return definition;
  return { ...definition, arguments: [...(definition.arguments ?? []), ...missing] };
}

// Collects `Type.field` -> usage for every field annotated with a mock
// directive. Covers type definitions and extensions.
export function collectFieldDirectives(
  document: DocumentNode,
): Map<string, MockDirectiveUsage> {
  const values = new Map<string, MockDirectiveUsage>();

  for (const definition of document.definitions) {
    const name = "name" in definition ? definition.name?.value : undefined;
    const fields = fieldDefinitions(definition);
    if (!name || fields.length === 0) continue;

    for (const field of fields) {
      const key = `${name}.${field.name.value}`;
      if (values.has(key)) continue;
      const usage = mockDirectiveUsage(field.directives);
      if (usage !== undefined) values.set(key, usage);
    }
  }

  return values;
}

export function fieldShape(type: GraphQLType): FieldShape {
  let nullable = true;
  let inner: GraphQLType = type;
  if (isNonNullType(inner)) {
    nullable = false;
    inner = inner.ofType;
  }

  let list = false;
  if (isListType(inner)) {
    list = true;
    inner = inner.ofType;
    while (isNonNullType(inner)) inner = inner.ofType;
  }

  return { named: getNamedType(inner), list, nullable };
}

// An empty value is `[]` for lists, `""` for String/ID and `null` for anything
// else — but only where `null` is legal, i.e. on a nullable field.
export function renderMockValue(
  usage: MockDirectiveUsage,
  shape: FieldShape,
): MockValueResult {
  const { named, list, nullable } = shape;

  if (usage.empty) {
    const warning =
      usage.value === undefined
        ? undefined
        : `empty: true overrides value: ${JSON.stringify(usage.value)}`;
    if (list) return emptyResult("[]", warning);
    if (isStringScalar(named)) return emptyResult('""', warning);
    if (nullable) return emptyResult("null", warning);
    return { ok: false, reason: `empty: true requires a nullable field, but ${named.name} is not` };
  }

  const value = usage.value;

  if (list) return { ok: false, reason: "list fields are not supported yet" };

  if (isEnumType(named)) return { ok: true, expression: JSON.stringify(value) };

  if (isScalarType(named)) {
    switch (named.name) {
      case "Int": {
        const parsed = Number(value);
        if (Number.isSafeInteger(parsed) && String(parsed) === value.trim()) {
          return { ok: true, expression: String(parsed) };
        }
        return { ok: false, reason: `"${value}" is not an Int` };
      }
      case "Float": {
        const parsed = Number(value);
        if (value.trim() !== "" && Number.isFinite(parsed)) {
          return { ok: true, expression: String(parsed) };
        }
        return { ok: false, reason: `"${value}" is not a Float` };
      }
      case "Boolean": {
        if (value === "true") return { ok: true, expression: "true" };
        if (value === "false") return { ok: true, expression: "false" };
        return { ok: false, reason: `"${value}" is not a Boolean` };
      }
      default:
        // String, ID and custom scalars keep the raw string.
        return { ok: true, expression: JSON.stringify(value) };
    }
  }

  return { ok: false, reason: "only scalar and enum fields are supported" };
}

function emptyResult(expression: string, warning: string | undefined): MockValueResult {
  return warning === undefined ? { ok: true, expression } : { ok: true, expression, warning };
}

function isStringScalar(named: GraphQLNamedType): boolean {
  return isScalarType(named) && (named.name === "String" || named.name === "ID");
}

function mockDirectiveUsage(
  directives: readonly ConstDirectiveNode[] | undefined,
): MockDirectiveUsage | undefined {
  for (const directive of directives ?? []) {
    if (!MOCK_DIRECTIVES.includes(directive.name.value)) continue;

    let value: string | undefined;
    let empty = false;
    for (const argument of directive.arguments ?? []) {
      if (argument.name.value === MOCK_DIRECTIVE_ARG && argument.value.kind === Kind.STRING) {
        value = argument.value.value;
      } else if (argument.name.value === MOCK_EMPTY_ARG && argument.value.kind === Kind.BOOLEAN) {
        empty = argument.value.value;
      }
    }

    if (empty) return value === undefined ? { empty: true } : { empty: true, value };
    if (value !== undefined) return { empty: false, value };
  }
  return undefined;
}

function fieldDefinitions(definition: DefinitionNode): readonly FieldDefinitionNode[] {
  if (!("fields" in definition)) return [];
  const fields = (definition as { fields?: unknown }).fields;
  return Array.isArray(fields) ? (fields as readonly FieldDefinitionNode[]) : [];
}
