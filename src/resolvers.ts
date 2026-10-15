import {
  buildSchema,
  defaultFieldResolver,
  getNamedType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  type GraphQLField,
  type GraphQLFieldResolver,
  type GraphQLInterfaceType,
  type GraphQLObjectType,
  type GraphQLSchema,
  type GraphQLType,
} from "graphql";
import { runtime } from "./runtime.ts";

type FieldOwner = GraphQLObjectType | GraphQLInterfaceType;

export function buildExecutableSchema(sdl: string): GraphQLSchema {
  const schema = buildSchema(sdl);
  attachResolvers(schema);
  return schema;
}

export function attachResolvers(schema: GraphQLSchema): void {
  const rootTypeNames = new Set(
    [schema.getQueryType(), schema.getMutationType(), schema.getSubscriptionType()]
      .filter((type): type is GraphQLObjectType => Boolean(type))
      .map((type) => type.name),
  );

  for (const type of Object.values(schema.getTypeMap())) {
    if (type.name.startsWith("__")) continue;
    if (isObjectType(type) || isInterfaceType(type)) {
      attachTypeResolvers(type, rootTypeNames.has(type.name));
    }
  }
}

function attachTypeResolvers(type: FieldOwner, isRoot: boolean): void {
  for (const field of Object.values(type.getFields())) {
    field.resolve = createFieldResolver(type.name, field, isRoot);
  }
}

function createFieldResolver(
  ownerTypeName: string,
  field: GraphQLField<unknown, unknown>,
  isRoot: boolean,
): GraphQLFieldResolver<unknown, unknown> {
  return (parent, args, context, info) => {
    if (isRoot) {
      const exported = runtime.modules.root.get(ownerTypeName)?.get(field.name)?.default;
      if (typeof exported === "function") {
        return (exported as GraphQLFieldResolver<unknown, unknown>)(parent, args, context, info);
      }
      if (exported !== undefined) return exported;
    } else {
      const module = runtime.modules.entities.get(ownerTypeName);
      const exported = module?.[field.name];
      if (typeof exported === "function") {
        return exported(parent, args, context, info);
      }
      if (exported !== undefined) return exported;
    }

    const value = defaultFieldResolver(parent as never, args, context, info);
    if (value !== undefined) return value;

    return mockFallback(field.type);
  };
}

function mockFallback(returnType: GraphQLType): unknown {
  const named = getNamedType(returnType);
  const module = runtime.modules.entities.get(named.name);
  if (!module) return null;

  let value = module.default;
  if (typeof value === "function") {
    value = (value as () => unknown)();
  }
  if (value === undefined || value === null) return null;

  const isList = isListType(isNonNullType(returnType) ? returnType.ofType : returnType);
  if (isList) return Array.isArray(value) ? value : [value];
  return Array.isArray(value) ? (value[0] ?? null) : value;
}
