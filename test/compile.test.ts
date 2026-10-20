import { describe, expect, test } from "bun:test";
import { graphql, parse, print, type GraphQLObjectType } from "graphql";
import { compileDocument } from "../src/compile.ts";
import { buildExecutableSchema } from "../src/resolvers.ts";
import { runtime } from "../src/runtime.ts";
import { emptyMockModules } from "../src/mocks.ts";
import { mockModules } from "./helpers.ts";

function compile(sdl: string) {
  return compileDocument(parse(sdl));
}

describe("compileDocument", () => {
  test("prunes only the field that references an unknown type", () => {
    const result = compile(`
      type Query { ok: String, bad: Absent }
      type Other { id: ID }
    `);

    expect(result.skipped.map((entry) => entry.name)).toEqual(["Query.bad"]);
    expect(result.skipped[0]!.reason).toContain('Unknown type "Absent"');
    expect(result.schema.getTypeMap().Other).toBeDefined();
    expect(Object.keys(result.schema.getQueryType()!.getFields())).toEqual(["ok"]);
  });

  test("drops a type that has no remaining fields", () => {
    const result = compile(`
      type Query { ok: String }
      type Broken { field: Missing }
    `);

    expect(result.skipped.map((entry) => entry.name)).toEqual(["Broken"]);
    expect(result.schema.getTypeMap().Broken).toBeUndefined();
  });

  test("drops unknown directives instead of pruning the type", () => {
    const result = compile(`
      type Query { user: User }
      type User { id: ID! @client, name: String @connection }
    `);

    expect(result.skipped).toEqual([]);
    expect(result.warnings.some((line) => line.includes("@client"))).toBe(true);
    expect(result.warnings.some((line) => line.includes("@connection"))).toBe(true);
    expect(result.schema.getTypeMap().User).toBeDefined();
  });

  test("keeps directives that are defined in the schema", () => {
    const result = compile(`
      directive @auth on FIELD_DEFINITION
      type Query { secret: String @auth }
    `);

    expect(result.skipped).toEqual([]);
    expect(result.warnings.some((line) => line.includes("@auth"))).toBe(false);
  });

  test("prunes a duplicate field introduced by an extension", () => {
    const result = compile(`
      type Query { user: User }
      type User { id: ID! }
      extend type User { id: ID! }
    `);

    expect(result.skipped.some((entry) => entry.reason.includes("only be defined once"))).toBe(true);
    expect(result.schema.getTypeMap().User).toBeDefined();
    const user = result.schema.getType("User") as GraphQLObjectType;
    expect(Object.keys(user.getFields())).toEqual(["id"]);
  });

  test("keeps a valid extension whose base type lost a bad field", () => {
    const result = compile(`
      type Query { good: String, bad: Absent }
      type Post { id: ID! }
      extend type Query { post: Post }
    `);

    const fields = Object.keys(result.schema.getQueryType()!.getFields());
    expect(fields).toEqual(["good", "post"]);
    expect(result.skipped.map((entry) => entry.name)).toEqual(["Query.bad"]);
  });

  test("keeps the project mock directives without a declaration", () => {
    const result = compile(`
      type Query { user: User }
      type User { name: String @backeneko(value: "x"), email: String @mock(value: "y") }
    `);

    expect(result.skipped).toEqual([]);
    expect(result.warnings.some((line) => line.includes("@backeneko"))).toBe(false);
    expect(result.warnings.some((line) => line.includes("@mock"))).toBe(false);
    expect(print(result.document)).toContain(
      "directive @backeneko(value: String, empty: Boolean)",
    );
  });

  test("completes a user-declared mock directive that lacks the empty argument", () => {
    const result = compile(`
      directive @backeneko(value: String) on FIELD_DEFINITION
      type Query { user: User }
      type User { name: String @backeneko(empty: true) }
    `);

    expect(result.skipped).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(
      Object.keys((result.schema.getType("User") as GraphQLObjectType).getFields()),
    ).toEqual(["name"]);
  });

  test("adds a placeholder Query when none is present", () => {
    const result = compile("type User { id: ID! }");

    expect(result.schema.getQueryType()).toBeDefined();
    expect(result.warnings.some((line) => line.includes("no Query type"))).toBe(true);
  });

  test("produces a runnable schema from a partially broken document", async () => {
    const result = compile(`
      type Query { ok: String }
      type Broken { field: Missing }
    `);

    const schema = buildExecutableSchema(print(result.document));
    runtime.modules = mockModules({ root: { Query: { ok: { default: () => "hello" } } } });
    const response = await graphql({ schema, source: "{ ok }" });
    runtime.modules = emptyMockModules();

    expect(response.errors).toBeUndefined();
    expect(response.data).toEqual({ ok: "hello" });
  });
});
