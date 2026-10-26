import {
  buildASTSchema,
  Kind,
  parse,
  print,
  visit,
  type ASTNode,
  type DefinitionNode,
  type DocumentNode,
  type GraphQLSchema,
} from "graphql";
import { validateSDL } from "./graphql/internal.ts";
import { withMockDirectives } from "./directives.ts";
import type { SkippedDefinition } from "./merge.ts";

export interface CompileResult {
  schema: GraphQLSchema;
  document: DocumentNode;
  skipped: SkippedDefinition[];
  warnings: string[];
}

const BUILT_IN_DIRECTIVES = new Set(["skip", "include", "deprecated", "specifiedBy", "oneOf"]);
const QUERY_PLACEHOLDER = parse("type Query { _empty: String }").definitions[0]!;
const MAX_ITERATIONS = 1000;

type MemberArrayKey = "fields" | "values" | "types";

interface MemberRemoval {
  keys: Set<number>;
  entries: SkippedDefinition[];
}

export function compileDocument(input: DocumentNode): CompileResult {
  const warnings: string[] = [];
  const warningSet = new Set<string>();
  const warn = (message: string): void => {
    if (!warningSet.has(message)) {
      warningSet.add(message);
      warnings.push(message);
    }
  };

  const { document: stripped, droppedDirectives } = stripUnknownDirectives(
    withMockDirectives(input),
  );
  for (const [name, count] of droppedDirectives) {
    warn(`dropped unknown directive @${name} (${count} use${count > 1 ? "s" : ""})`);
  }

  const pruned = pruneInvalidDefinitions(normalize(stripped).definitions.slice(), warn);

  let document: DocumentNode = { kind: Kind.DOCUMENT, definitions: pruned.definitions };
  let schema = buildTolerant(document, warn);

  if (!schema.getQueryType()) {
    document = append(document, QUERY_PLACEHOLDER);
    schema = buildASTSchema(document);
    warn("no Query type found — added `type Query { _empty: String }`");
  }

  return { schema, document, skipped: pruned.skipped, warnings };
}

function pruneInvalidDefinitions(
  initial: DefinitionNode[],
  warn: (message: string) => void,
): { definitions: DefinitionNode[]; skipped: SkippedDefinition[] } {
  let definitions = initial;
  const skipped: SkippedDefinition[] = [];

  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const document: DocumentNode = { kind: Kind.DOCUMENT, definitions };
    const errors = validateSDL(document);
    if (errors.length === 0) break;

    const dropDefinitions = new Set<DefinitionNode>();
    const dropMembers = new Map<DefinitionNode, MemberRemoval>();

    for (const error of errors) {
      const node = lastLocatedNode(error.nodes ?? []);
      if (!node?.loc) {
        warn(`unattributed schema error: ${error.message}`);
        continue;
      }
      const definition = findDefinition(definitions, node.loc.start, node.loc.end);
      if (!definition) {
        warn(`unattributed schema error: ${error.message}`);
        continue;
      }

      const member = findMember(definition, node.loc.start, node.loc.end);
      if (member) {
        const removal = dropMembers.get(definition) ?? { keys: new Set(), entries: [] };
        removal.keys.add(member.key);
        removal.entries.push({
          name: `${definitionName(definition)}.${member.name}`,
          reason: error.message,
        });
        dropMembers.set(definition, removal);
      } else {
        dropDefinitions.add(definition);
        skipped.push({ name: definitionName(definition), reason: error.message });
      }
    }

    const next: DefinitionNode[] = [];
    let changed = false;

    for (const definition of definitions) {
      if (dropDefinitions.has(definition)) {
        changed = true;
        continue;
      }
      const removal = dropMembers.get(definition);
      if (!removal) {
        next.push(definition);
        continue;
      }
      changed = true;
      const filtered = removeMembers(definition, removal.keys);
      if (filtered !== null && membersOf(filtered).length > 0) {
        next.push(filtered);
        skipped.push(...removal.entries);
      } else {
        // The type lost every field, so the definition cannot stand on its own.
        for (const entry of removal.entries) {
          skipped.push({ name: definitionName(definition), reason: entry.reason });
        }
      }
    }

    definitions = next;
    if (!changed) break;
  }

  return { definitions, skipped };
}

function lastLocatedNode(nodes: ReadonlyArray<ASTNode>): ASTNode | null {
  // Duplicate-field errors report every occurrence; the last node is the
  // offending duplicate, so pruning it keeps the original definition intact.
  let found: ASTNode | null = null;
  for (const node of nodes) {
    if (node.loc) found = node;
  }
  return found;
}

function findDefinition(
  definitions: ReadonlyArray<DefinitionNode>,
  start: number,
  end: number,
): DefinitionNode | null {
  for (const definition of definitions) {
    const loc = definition.loc;
    if (loc && start >= loc.start && end <= loc.end) return definition;
  }
  return null;
}

interface MemberInfo {
  key: number;
  name: string;
}

function findMember(definition: DefinitionNode, start: number, end: number): MemberInfo | null {
  for (const member of membersOf(definition)) {
    const loc = member.loc;
    if (loc && start >= loc.start && end <= loc.end) {
      return { key: loc.start, name: memberName(member) };
    }
  }
  return null;
}

function memberArrayKey(definition: DefinitionNode): MemberArrayKey | null {
  switch (definition.kind) {
    case Kind.OBJECT_TYPE_DEFINITION:
    case Kind.OBJECT_TYPE_EXTENSION:
    case Kind.INTERFACE_TYPE_DEFINITION:
    case Kind.INTERFACE_TYPE_EXTENSION:
    case Kind.INPUT_OBJECT_TYPE_DEFINITION:
    case Kind.INPUT_OBJECT_TYPE_EXTENSION:
      return "fields";
    case Kind.ENUM_TYPE_DEFINITION:
    case Kind.ENUM_TYPE_EXTENSION:
      return "values";
    case Kind.UNION_TYPE_DEFINITION:
    case Kind.UNION_TYPE_EXTENSION:
      return "types";
    default:
      return null;
  }
}

function membersOf(definition: DefinitionNode): readonly ASTNode[] {
  const key = memberArrayKey(definition);
  if (!key) return [];
  const value = (definition as unknown as Record<string, unknown>)[key];
  return Array.isArray(value) ? (value as ASTNode[]) : [];
}

function removeMembers(definition: DefinitionNode, keys: Set<number>): DefinitionNode | null {
  const key = memberArrayKey(definition);
  if (!key) return null;
  const members = membersOf(definition).filter((member) => !member.loc || !keys.has(member.loc.start));
  return { ...(definition as object), [key]: members } as unknown as DefinitionNode;
}

function memberName(node: ASTNode): string {
  const name = (node as { name?: { value?: string } }).name;
  return name && typeof name.value === "string" ? name.value : "member";
}

function definitionName(definition: DefinitionNode): string {
  if ("name" in definition && definition.name && typeof definition.name.value === "string") {
    return definition.name.value;
  }
  if (definition.kind === Kind.SCHEMA_DEFINITION || definition.kind === Kind.SCHEMA_EXTENSION) {
    return "schema";
  }
  return definition.kind.toLowerCase().replace(/_/g, " ");
}

function buildTolerant(document: DocumentNode, warn: (message: string) => void): GraphQLSchema {
  try {
    return buildASTSchema(document);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    warn(`schema could not be built (${message}); falling back to an empty schema`);
    return buildASTSchema({ kind: Kind.DOCUMENT, definitions: [] });
  }
}

function stripUnknownDirectives(document: DocumentNode): {
  document: DocumentNode;
  droppedDirectives: Map<string, number>;
} {
  const known = new Set(BUILT_IN_DIRECTIVES);
  for (const def of document.definitions) {
    if (def.kind === Kind.DIRECTIVE_DEFINITION) known.add(def.name.value);
  }

  const droppedDirectives = new Map<string, number>();
  const result = visit(document, {
    Directive(node) {
      if (known.has(node.name.value)) return undefined;
      droppedDirectives.set(node.name.value, (droppedDirectives.get(node.name.value) ?? 0) + 1);
      return null;
    },
  });

  return { document: result, droppedDirectives };
}

function normalize(document: DocumentNode): DocumentNode {
  return parse(print(document));
}

function append(document: DocumentNode, definition: DefinitionNode): DocumentNode {
  return { kind: Kind.DOCUMENT, definitions: [...document.definitions, definition] };
}
