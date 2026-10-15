import {
  Kind,
  isEnumType,
  isScalarType,
  parse,
  visit,
  type ConstDirectiveNode,
  type DefinitionNode,
  type DocumentNode,
  type FieldDefinitionNode,
  type GraphQLNamedType,
} from "graphql";

// The two project directives are interchangeable: `@backeneko` and `@mock`.
export const MOCK_DIRECTIVES: readonly string[] = ["backeneko", "mock"];
export const MOCK_DIRECTIVE_ARG = "value";

export type MockValueResult =
  | { ok: true; expression: string }
  | { ok: false; reason: string };

// backeneko owns these directives, so a schema may use them without declaring
// them. When a name is used but not defined, its definition is injected before
// SDL validation (otherwise `stripUnknownDirectives` would drop the usage).
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

  const additions: DefinitionNode[] = [];
  for (const name of MOCK_DIRECTIVES) {
    if (!used.has(name) || defined.has(name)) continue;
    additions.push(
      ...parse(`directive @${name}(${MOCK_DIRECTIVE_ARG}: String) on FIELD_DEFINITION`).definitions,
    );
  }
  if (additions.length === 0) return document;

  return { kind: Kind.DOCUMENT, definitions: [...additions, ...document.definitions] };
}

// Collects `Type.field` -> raw string value for every field annotated with a
// mock directive. Covers type definitions and extensions.
export function collectFieldDirectives(document: DocumentNode): Map<string, string> {
  const values = new Map<string, string>();

  for (const definition of document.definitions) {
    const name = "name" in definition ? definition.name?.value : undefined;
    const fields = fieldDefinitions(definition);
    if (!name || fields.length === 0) continue;

    for (const field of fields) {
      const key = `${name}.${field.name.value}`;
      if (values.has(key)) continue;
      const value = mockDirectiveValue(field.directives);
      if (value !== undefined) values.set(key, value);
    }
  }

  return values;
}

export function renderMockValue(
  value: string,
  named: GraphQLNamedType,
  list: boolean,
): MockValueResult {
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

function mockDirectiveValue(
  directives: readonly ConstDirectiveNode[] | undefined,
): string | undefined {
  for (const directive of directives ?? []) {
    if (!MOCK_DIRECTIVES.includes(directive.name.value)) continue;
    const argument = directive.arguments?.find((entry) => entry.name.value === MOCK_DIRECTIVE_ARG);
    if (argument && argument.value.kind === Kind.STRING) return argument.value.value;
  }
  return undefined;
}

function fieldDefinitions(definition: DefinitionNode): readonly FieldDefinitionNode[] {
  if (!("fields" in definition)) return [];
  const fields = (definition as { fields?: unknown }).fields;
  return Array.isArray(fields) ? (fields as readonly FieldDefinitionNode[]) : [];
}
