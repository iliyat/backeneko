import { afterEach, describe, expect, test } from "bun:test";
import { graphql } from "graphql";
import { buildExecutableSchema } from "../src/resolvers.ts";
import { runtime } from "../src/runtime.ts";
import { emptyMockModules } from "../src/mocks.ts";
import { mockModules } from "./helpers.ts";

const SDL = `
type Query {
  user(id: ID): User
  users: [User!]!
}

type User {
  id: ID!
  name: String!
}
`;

async function execute(query: string) {
  const schema = buildExecutableSchema(SDL);
  runtime.schema = schema;
  return graphql({ schema, source: query });
}

afterEach(() => {
  runtime.modules = emptyMockModules();
});

describe("resolvers", () => {
  test("falls back to the entity mock for a single field", async () => {
    runtime.modules = mockModules({ entities: { User: { default: { id: "42", name: "Ada" } } } });

    const result = await execute("{ user { id name } }");

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ user: { id: "42", name: "Ada" } });
  });

  test("wraps a single mock into a list when the field is a list", async () => {
    runtime.modules = mockModules({ entities: { User: { default: { id: "42", name: "Ada" } } } });

    const result = await execute("{ users { id } }");

    expect(result.data).toEqual({ users: [{ id: "42" }] });
  });

  test("uses the query resolver file as a field resolver", async () => {
    runtime.modules = mockModules({
      entities: { User: { default: { id: "42", name: "Ada" } } },
      root: { Query: { user: { default: () => ({ id: "7", name: "Overridden" }) } } },
    });

    const result = await execute("{ user { id name } }");

    expect(result.data).toEqual({ user: { id: "7", name: "Overridden" } });
  });

  test("passes arguments to the query resolver", async () => {
    runtime.modules = mockModules({
      root: {
        Query: {
          user: {
            default: (_parent: unknown, args: Record<string, unknown>) => ({ id: args.id, name: "Ada" }),
          },
        },
      },
    });

    const result = await execute('{ user(id: "7") { id name } }');

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ user: { id: "7", name: "Ada" } });
  });

  test("uses entity field resolvers for nested fields", async () => {
    runtime.modules = mockModules({
      entities: { User: { default: {}, name: () => "Computed" } },
      root: { Query: { user: { default: { id: "1" } } } },
    });

    const result = await execute("{ user { id name } }");

    expect(result.data).toEqual({ user: { id: "1", name: "Computed" } });
  });

  test("returns null when no mock exists for the type", async () => {
    const result = await execute("{ user { id } }");

    expect(result.data).toEqual({ user: null });
  });
});
