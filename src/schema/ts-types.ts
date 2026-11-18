import {
  isEnumType,
  isInputObjectType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  isScalarType,
  isSpecifiedScalarType,
  isUnionType,
  type GraphQLInputObjectType,
  type GraphQLNamedType,
  type GraphQLScalarType,
  type GraphQLSchema,
  type GraphQLType,
} from "graphql";

// Response fields are always present when requested, so nullability becomes
// `| null` without `?`. Input fields with a default may be omitted.
export function renderSchemaNamespace(schema: GraphQLSchema): string {
  const types = Object.values(schema.getTypeMap())
    .filter((type) => !type.name.startsWith("__"))
    .filter((type) => !(isScalarType(type) && isSpecifiedScalarType(type)))
    .sort((a, b) => a.name.localeCompare(b.name));

  const blocks = types.map((type) =>
    renderType(type)
      .map((line) => `    ${line}`)
      .join("\n"),
  );
  return ["  namespace Schema {", blocks.filter(Boolean).join("\n\n"), "  }"]
    .filter((line) => line !== "")
    .join("\n");
}

function renderType(type: GraphQLNamedType): string[] {
  if (isScalarType(type)) return [`type ${type.name} = any;`];
  if (isEnumType(type)) {
    const values = type.getValues().map((value) => JSON.stringify(value.name));
    return [`type ${type.name} = ${values.join(" | ") || "never"};`];
  }
  if (isUnionType(type)) {
    const members = type.getTypes().map((member) => member.name);
    return [`type ${type.name} = ${members.join(" | ") || "never"};`];
  }
  if (isInterfaceType(type) || isObjectType(type)) {
    return renderInterface(type.name, Object.values(type.getFields()));
  }
  if (isInputObjectType(type)) return renderInput(type);
  return [];
}

function renderInterface(
  name: string,
  fields: Array<{ name: string; type: GraphQLType }>,
): string[] {
  return [
    `interface ${name} {`,
    ...fields.map((field) => `  ${field.name}: ${renderTypeRef(field.type)};`),
    "}",
  ];
}

function renderInput(type: GraphQLInputObjectType): string[] {
  const fields = Object.values(type.getFields());
  const lines = fields.map((field) => {
    const optional = !isNonNullType(field.type) || field.defaultValue !== undefined;
    return `  ${field.name}${optional ? "?" : ""}: ${renderTypeRef(field.type)};`;
  });
  return [`interface ${type.name} {`, ...lines, "}"];
}

function renderTypeRef(type: GraphQLType): string {
  if (isNonNullType(type)) return renderNonNull(type.ofType);
  return `${renderNonNull(type)} | null`;
}

function renderNonNull(type: GraphQLType): string {
  if (isListType(type)) {
    const item = renderTypeRef(type.ofType);
    return item.includes(" | ") ? `(${item})[]` : `${item}[]`;
  }
  if (isScalarType(type)) return scalarType(type) ?? type.name;
  return type.name;
}

function scalarType(type: GraphQLScalarType): string | null {
  switch (type.name) {
    case "ID":
    case "String":
      return "string";
    case "Int":
    case "Float":
      return "number";
    case "Boolean":
      return "boolean";
    default:
      return null;
  }
}
