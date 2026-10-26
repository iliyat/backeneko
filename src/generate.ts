import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  buildASTSchema,
  isEnumType,
  isInterfaceType,
  isObjectType,
  isScalarType,
  isUnionType,
  parse,
  type GraphQLEnumType,
  type GraphQLField,
  type GraphQLInterfaceType,
  type GraphQLObjectType,
  type GraphQLScalarType,
  type GraphQLSchema,
  type GraphQLUnionType,
} from "graphql";
import {
  collectFieldDirectives,
  fieldShape,
  renderMockValue,
  withMockDirectives,
  type MockDirectiveUsage,
} from "./directives.ts";

export const ENTITY_DIR = "entities";
export const ROOT_DIRS = {
  Query: "queries",
  Mutation: "mutations",
  Subscription: "subscriptions",
} as const;

// `generated/` is a disposable mirror of the schema, rewritten on every start.
// `override/` holds user files with the same structure and is never touched;
// an override file wins over the generated one of the same name.
export const GENERATED_DIR = "generated";
export const OVERRIDE_DIR = "override";
export const TSCONFIG_FILE = "tsconfig.json";

export const MOCK_DIRS = [ENTITY_DIR, ...Object.values(ROOT_DIRS)];

const JS_RESERVED_WORDS = new Set([
  "break", "case", "catch", "class", "const", "continue", "debugger", "default",
  "delete", "do", "else", "enum", "export", "extends", "false", "finally",
  "for", "function", "if", "import", "in", "instanceof", "new", "null",
  "return", "super", "switch", "this", "throw", "true", "try", "typeof",
  "var", "void", "while", "with", "yield", "let", "static", "await",
]);

export interface GenerationResult {
  schemaPath: string;
  created: string[];
  updated: string[];
  unchanged: string[];
  removed: string[];
  warnings: string[];
}

// The workspace tsconfig maps `@<dir>/<name>` to override-first and
// generated-second, so imported entities pick up user overrides without
// regeneration knowing anything about them. `allowImportingTsExtensions`
// (with `noEmit`) keeps editors happy about the `.ts` import specifiers Bun emits.
export function workspaceTsconfig(): string {
  const paths: Record<string, string[]> = {};
  for (const dir of MOCK_DIRS) {
    paths[`@${dir}/*`] = [
      path.join(OVERRIDE_DIR, dir, "*"),
      path.join(GENERATED_DIR, dir, "*"),
    ];
  }
  const compilerOptions = {
    baseUrl: ".",
    paths,
    target: "ESNext",
    module: "ESNext",
    moduleResolution: "bundler",
    allowImportingTsExtensions: true,
    noEmit: true,
  };
  return `${JSON.stringify({ compilerOptions }, null, 2)}\n`;
}

export async function ensureWorkspaceTsconfig(targetDir: string): Promise<boolean> {
  const file = path.join(targetDir, TSCONFIG_FILE);
  const content = workspaceTsconfig();
  const existing = await readFile(file, "utf8").catch(() => null);
  if (existing === content) return false;
  await mkdir(targetDir, { recursive: true });
  await writeFile(file, content, "utf8");
  return true;
}

export async function generateWorkspace(options: {
  targetDir: string;
  sdl: string;
}): Promise<GenerationResult> {
  const { targetDir, sdl } = options;
  const generatedDir = path.join(targetDir, GENERATED_DIR);
  await mkdir(generatedDir, { recursive: true });
  await ensureWorkspaceTsconfig(targetDir);

  const result: GenerationResult = {
    schemaPath: path.join(targetDir, "schema.graphql"),
    created: [],
    updated: [],
    unchanged: [],
    removed: [],
    warnings: [],
  };
  const expected = new Set<string>();

  await writeGenerated(result, targetDir, result.schemaPath, sdl);

  const document = withMockDirectives(parse(sdl));
  const schema = buildASTSchema(document);
  const directiveValues = collectFieldDirectives(document);
  const warn = (message: string): void => {
    if (!result.warnings.includes(message)) result.warnings.push(message);
  };

  const rootTypeNames = new Set(rootTypes(schema).map((type) => type.name));

  const entityTypes = Object.values(schema.getTypeMap())
    .filter((type) => !type.name.startsWith("__"))
    .filter((type) => isObjectType(type) || isInterfaceType(type) || isUnionType(type))
    .filter((type) => !rootTypeNames.has(type.name));

  for (const type of entityTypes) {
    const file = path.join(generatedDir, ENTITY_DIR, `${type.name}.ts`);
    expected.add(file);
    await writeGenerated(
      result,
      targetDir,
      file,
      entityTemplate(
        schema,
        type as GraphQLObjectType | GraphQLInterfaceType | GraphQLUnionType,
        directiveValues,
        warn,
      ),
    );
  }

  for (const [typeName, directory] of Object.entries(ROOT_DIRS)) {
    const rootType = schema.getType(typeName);
    if (!rootType || !isObjectType(rootType)) continue;

    for (const field of Object.values(rootType.getFields())) {
      const file = path.join(generatedDir, directory, `${field.name}.ts`);
      expected.add(file);
      await writeGenerated(result, targetDir, file, rootFieldTemplate(typeName, field));
    }
  }

  result.removed = await pruneGenerated(targetDir, expected);
  return result;
}

async function writeGenerated(
  result: GenerationResult,
  targetDir: string,
  filePath: string,
  content: string,
): Promise<void> {
  const relative = path.relative(targetDir, filePath);
  const existing = await readFile(filePath, "utf8").catch(() => null);
  if (existing === content) {
    result.unchanged.push(relative);
    return;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
  if (existing === null) result.created.push(relative);
  else result.updated.push(relative);
}

// `generated/` mirrors the schema, so files whose type or field disappeared are
// dropped here instead of lingering as dead mocks.
async function pruneGenerated(
  targetDir: string,
  expected: Set<string>,
): Promise<string[]> {
  const removed: string[] = [];
  for (const dir of MOCK_DIRS) {
    const directory = path.join(targetDir, GENERATED_DIR, dir);
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const file = path.join(directory, entry.name);
      if (expected.has(file)) continue;
      await rm(file, { force: true });
      removed.push(path.relative(targetDir, file));
    }
  }
  return removed;
}

function rootTypes(schema: GraphQLSchema): GraphQLObjectType[] {
  return [schema.getQueryType(), schema.getMutationType(), schema.getSubscriptionType()].filter(
    (type): type is GraphQLObjectType => Boolean(type),
  );
}

function entityTemplate(
  schema: GraphQLSchema,
  type: GraphQLObjectType | GraphQLInterfaceType | GraphQLUnionType,
  directiveValues: Map<string, MockDirectiveUsage>,
  warn: (message: string) => void,
): string {
  if (isUnionType(type)) {
    const first = type.getTypes()[0] ?? null;
    return renderEntity(
      type.name,
      first?.name ?? null,
      first?.name ?? null,
      first?.getFields() ?? {},
      directiveValues,
      warn,
    );
  }
  if (isInterfaceType(type)) {
    const first = schema.getPossibleTypes(type)[0] ?? null;
    return renderEntity(
      type.name,
      first?.name ?? null,
      first?.name ?? null,
      first?.getFields() ?? type.getFields(),
      directiveValues,
      warn,
    );
  }
  return renderEntity(type.name, null, null, type.getFields(), directiveValues, warn);
}

// A mock for an interface or union is really a mock of the concrete type whose
// `__typename` it declares (the first implementor / member), so its full field
// set is rendered — otherwise inline fragments on that type would resolve
// against a bare interface shape. `fieldsTypeName` is null when the fields come
// from `typeName` itself; mock directives prefer the concrete type and fall
// back to `typeName`.
function renderEntity(
  typeName: string,
  fieldsTypeName: string | null,
  typename: string | null,
  fields: Record<string, GraphQLField<unknown, unknown>>,
  directiveValues: Map<string, MockDirectiveUsage>,
  warn: (message: string) => void,
): string {
  const local = localIdentifier(typeName);
  const imports = new Set<string>();
  const body = [`const ${local} = {`];

  if (typename !== null) body.push(`  __typename: ${JSON.stringify(typename)},`);
  for (const field of Object.values(fields)) {
    body.push(fieldLine(typeName, fieldsTypeName, local, field, imports, directiveValues, warn));
  }
  body.push(`};`, ``, `export default ${local};`, "");

  const importLines = [...imports]
    .sort()
    .map((name) => `import ${name} from "@${ENTITY_DIR}/${name}.ts";`);

  return [docComment(`Mock for type "${typeName}"`), ...importLines, ...body].join("\n");
}

// Related entities are referenced through getters so that cyclic relations
// (A -> B -> A) do not break module initialization.
function fieldLine(
  typeName: string,
  fieldsTypeName: string | null,
  local: string,
  field: GraphQLField<unknown, unknown>,
  imports: Set<string>,
  directiveValues: Map<string, MockDirectiveUsage>,
  warn: (message: string) => void,
): string {
  const shape = fieldShape(field.type);
  const { named, list } = shape;
  const usage =
    (fieldsTypeName === null
      ? undefined
      : directiveValues.get(`${fieldsTypeName}.${field.name}`)) ??
    directiveValues.get(`${typeName}.${field.name}`);

  if (usage !== undefined) {
    const rendered = renderMockValue(usage, shape);
    if (rendered.ok) {
      if (rendered.warning) {
        warn(`@backeneko/@mock on ${typeName}.${field.name}: ${rendered.warning}`);
      }
      return `  ${field.name}: ${rendered.expression},`;
    }
    warn(`ignored @backeneko/@mock on ${typeName}.${field.name}: ${rendered.reason}`);
  }

  if (isObjectType(named) || isInterfaceType(named) || isUnionType(named)) {
    const ref = named.name === typeName ? local : importedRef(named.name, imports);
    return `  get ${field.name}() { return ${list ? `[${ref}]` : ref}; },`;
  }
  if (list) return `  ${field.name}: [],`;
  if (isEnumType(named)) return `  ${field.name}: ${literalForEnum(named)},`;
  if (isScalarType(named)) return `  ${field.name}: ${scalarLiteral(named)},`;
  return `  ${field.name}: null,`;
}

function importedRef(name: string, imports: Set<string>): string {
  imports.add(name);
  return name;
}

function localIdentifier(typeName: string): string {
  return JS_RESERVED_WORDS.has(typeName) ? "mock" : typeName;
}

function docComment(title: string): string {
  return [
    `/**`,
    ` * ${title}.`,
    ` * default export: value used when a field resolves to this type.`,
    ` * named export with a field name: custom resolver for that field.`,
    ` */`,
  ].join("\n");
}

function scalarLiteral(type: GraphQLScalarType): string {
  switch (type.name) {
    case "ID":
      return `"1"`;
    case "String":
      return `"Example"`;
    case "Int":
    case "Float":
      return "0";
    case "Boolean":
      return "false";
    default:
      return "null";
  }
}

function literalForEnum(type: GraphQLEnumType): string {
  const first = type.getValues()[0];
  if (!first) return "null";
  return JSON.stringify(first.value);
}

function rootFieldTemplate(typeName: string, field: GraphQLField<unknown, unknown>): string {
  const { imports, expression } = mockExpressionForField(field);
  const name = JS_RESERVED_WORDS.has(field.name) ? "resolver" : field.name;
  const docTitle = `${typeName}.${field.name}`;

  const lines = [
    `/**`,
    ` * Resolver for ${docTitle}.`,
    ` * default export: function called with (parent, args, context, info).`,
    ` */`,
  ];

  for (const importName of imports) {
    lines.push(`import ${importName} from "@${ENTITY_DIR}/${importName}.ts";`);
  }

  lines.push(
    ``,
    `export default function ${name}(_parent: unknown, _args: Record<string, unknown>): unknown {`,
    `  return ${expression};`,
    `}`,
    ``,
  );

  return lines.join("\n");
}

function mockExpressionForField(field: GraphQLField<unknown, unknown>): {
  imports: string[];
  expression: string;
} {
  const imports: string[] = [];
  const { named, list } = fieldShape(field.type);
  let item: string;

  if (isObjectType(named) || isInterfaceType(named) || isUnionType(named)) {
    imports.push(named.name);
    item = named.name;
  } else if (isEnumType(named)) {
    item = literalForEnum(named);
  } else if (isScalarType(named)) {
    item = scalarLiteral(named);
  } else {
    item = "null";
  }

  return { imports, expression: list ? `[${item}]` : item };
}
