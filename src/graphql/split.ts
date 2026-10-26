import {
  Kind,
  visit,
  type ASTNode,
  type DirectiveNode,
  type DocumentNode,
  type FieldNode,
  type FragmentDefinitionNode,
  type OperationDefinitionNode,
  type SelectionNode,
} from "graphql";

export interface RootField {
  key: string;
  name: string;
  node: FieldNode;
}

export function fragmentMap(document: DocumentNode): Map<string, FragmentDefinitionNode> {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const definition of document.definitions) {
    if (definition.kind === Kind.FRAGMENT_DEFINITION) {
      fragments.set(definition.name.value, definition);
    }
  }
  return fragments;
}

// `@include`/`@skip` on a fragment spread or inline fragment apply to every
// selection inside it, so they can be pushed down onto the expanded fields.
// Any other directive may mean something else for the whole selection set and
// cannot be expanded safely.
function directivesSupported(directives: readonly DirectiveNode[] | undefined): boolean {
  return (directives ?? []).every(
    (directive) => directive.name.value === "include" || directive.name.value === "skip",
  );
}

// The root fields an operation selects. Returns null when the root selection
// set uses a directive that cannot be pushed down onto the individual fields,
// in which case the operation must be handled as a whole.
export function collectRootFields(
  operation: OperationDefinitionNode,
  fragments: Map<string, FragmentDefinitionNode>,
): RootField[] | null {
  const fields: RootField[] = [];
  const visiting = new Set<string>();

  const expand = (selections: readonly SelectionNode[], inherited: readonly DirectiveNode[]): boolean => {
    for (const selection of selections) {
      if (selection.kind === Kind.FIELD) {
        fields.push({
          key: selection.alias?.value ?? selection.name.value,
          name: selection.name.value,
          node:
            inherited.length === 0
              ? selection
              : {
                  ...selection,
                  directives: [...inherited, ...(selection.directives ?? [])],
                },
        });
        continue;
      }

      if (!directivesSupported(selection.directives)) return false;

      if (selection.kind === Kind.INLINE_FRAGMENT) {
        if (!expand(selection.selectionSet.selections, [...inherited, ...(selection.directives ?? [])])) {
          return false;
        }
        continue;
      }

      const name = selection.name.value;
      if (visiting.has(name)) continue;
      const definition = fragments.get(name);
      if (!definition) continue;
      visiting.add(name);
      const ok = expand(definition.selectionSet.selections, [
        ...inherited,
        ...(selection.directives ?? []),
      ]);
      visiting.delete(name);
      if (!ok) return false;
    }
    return true;
  };

  return expand(operation.selectionSet.selections, []) ? fields : null;
}

// Best-effort list of the field names an operation touches at the root level,
// used when the root selection set cannot be expanded safely.
export function mentionedRootFieldNames(
  operation: OperationDefinitionNode,
  fragments: Map<string, FragmentDefinitionNode>,
): string[] {
  const names: string[] = [];
  const visiting = new Set<string>();

  const expand = (selections: readonly SelectionNode[]): void => {
    for (const selection of selections) {
      if (selection.kind === Kind.FIELD) {
        names.push(selection.name.value);
        continue;
      }
      if (selection.kind === Kind.INLINE_FRAGMENT) {
        expand(selection.selectionSet.selections);
        continue;
      }
      const name = selection.name.value;
      if (visiting.has(name)) continue;
      const definition = fragments.get(name);
      if (!definition) continue;
      visiting.add(name);
      expand(definition.selectionSet.selections);
      visiting.delete(name);
    }
  };

  expand(operation.selectionSet.selections);
  return names;
}

export interface SubDocument {
  document: DocumentNode;
  variables: string[];
}

// Builds a document that keeps only the given root fields of the operation.
// Fragments and variables that the kept fields do not use are dropped: an
// unused fragment or variable is a validation error in most GraphQL servers.
export function buildSubDocument(
  operation: OperationDefinitionNode,
  fields: RootField[],
  fragments: Map<string, FragmentDefinitionNode>,
  rootTypeName: string,
): SubDocument {
  const nodes = fields.map((field) => rewriteSpreads(field.node, fragments, rootTypeName));
  const fragmentNames = collectFragmentNames(nodes, fragments);
  const definitions = fragmentNames
    .map((name) => fragments.get(name))
    .filter((definition): definition is FragmentDefinitionNode => definition !== undefined)
    .map((definition) => rewriteSpreads(definition, fragments, rootTypeName));

  const used = collectVariableNames([...nodes, ...definitions]);
  const variableDefinitions = (operation.variableDefinitions ?? []).filter((definition) =>
    used.has(definition.variable.name.value),
  );

  const document: DocumentNode = {
    kind: Kind.DOCUMENT,
    definitions: [
      {
        ...operation,
        selectionSet: { ...operation.selectionSet, selections: nodes },
        variableDefinitions,
      },
      ...definitions,
    ],
  };

  return { document, variables: [...used] };
}

// A fragment on the root type can only be spread at the root, but a field may
// return the root type; such a spread is turned into an inline fragment so it
// cannot pull root fields into a sub-document.
function rewriteSpreads<T extends ASTNode>(
  node: T,
  fragments: Map<string, FragmentDefinitionNode>,
  rootTypeName: string,
): T {
  return visit(node, {
    FragmentSpread(spread) {
      const definition = fragments.get(spread.name.value);
      if (!definition) return undefined;
      if (definition.typeCondition.name.value !== rootTypeName) return undefined;
      return {
        kind: Kind.INLINE_FRAGMENT,
        typeCondition: definition.typeCondition,
        directives: definition.directives,
        selectionSet: definition.selectionSet,
      };
    },
  });
}

function collectFragmentNames(
  nodes: readonly ASTNode[],
  fragments: Map<string, FragmentDefinitionNode>,
): string[] {
  const used = new Set<string>();
  const queue: ASTNode[] = [...nodes];

  while (queue.length > 0) {
    const node = queue.pop();
    if (!node) continue;
    visit(node, {
      FragmentSpread(spread) {
        const name = spread.name.value;
        if (used.has(name)) return;
        used.add(name);
        const definition = fragments.get(name);
        if (definition) queue.push(definition);
      },
    });
  }

  return [...used];
}

function collectVariableNames(nodes: readonly ASTNode[]): Set<string> {
  const names = new Set<string>();
  for (const node of nodes) {
    visit(node, {
      Variable(variable) {
        names.add(variable.name.value);
      },
    });
  }
  return names;
}
