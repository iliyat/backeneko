import { describe, expect, test } from "bun:test";
import { buildASTSchema, parse, print, type GraphQLObjectType } from "graphql";
import {
  collectFieldDirectives,
  fieldShape,
  renderMockValue,
  withMockDirectives,
} from "../src/directives.ts";

describe("withMockDirectives", () => {
  test("injects a definition for an undeclared directive", () => {
    const document = withMockDirectives(parse("type User { name: String @backeneko(value: \"x\") }"));
    const printed = print(document);

    expect(printed).toContain(
      "directive @backeneko(value: String, empty: Boolean) on FIELD_DEFINITION",
    );
    expect(buildASTSchema(document)).toBeDefined();
  });

  test("injects both project directives when both are used", () => {
    const document = withMockDirectives(
      parse('type User { a: String @backeneko(value: "x") b: String @mock(value: "y") }'),
    );
    const printed = print(document);

    expect(printed).toContain("directive @backeneko(value: String, empty: Boolean)");
    expect(printed).toContain("directive @mock(value: String, empty: Boolean)");
  });

  test("leaves the document untouched when the directive is unused", () => {
    const document = withMockDirectives(parse("type User { name: String }"));
    expect(print(document)).not.toContain("directive @backeneko");
  });

  test("does not duplicate a user-declared directive", () => {
    const document = withMockDirectives(
      parse(`
        directive @backeneko(value: String) on FIELD_DEFINITION
        type User { name: String @backeneko(value: "x") }
      `),
    );
    const count = print(document).split("directive @backeneko").length - 1;
    expect(count).toBe(1);
  });

  test("completes missing backeneko arguments on a user-declared directive", () => {
    const document = withMockDirectives(
      parse(`
        directive @backeneko(value: String) on FIELD_DEFINITION
        type User { name: String @backeneko(empty: true) }
      `),
    );

    expect(print(document)).toContain(
      "directive @backeneko(value: String, empty: Boolean) on FIELD_DEFINITION",
    );
    expect(buildASTSchema(document)).toBeDefined();
  });

  test("leaves a fully declared directive as is", () => {
    const source = `
      directive @mock(value: String, empty: Boolean) on FIELD_DEFINITION
      type User { name: String @mock(empty: true) }
    `;
    expect(print(withMockDirectives(parse(source)))).toBe(print(parse(source)));
  });
});

describe("collectFieldDirectives", () => {
  test("collects values from definitions and extensions", () => {
    const document = withMockDirectives(
      parse(`
        type User { id: ID! name: String @backeneko(value: "Ada") }
        extend type User { email: String @mock(value: "ada@example.com") }
      `),
    );

    const values = collectFieldDirectives(document);
    expect(values.get("User.name")).toEqual({ empty: false, value: "Ada" });
    expect(values.get("User.email")).toEqual({ empty: false, value: "ada@example.com" });
    expect(values.has("User.id")).toBe(false);
  });

  test("collects empty usages and skips empty: false", () => {
    const document = withMockDirectives(
      parse(`
        type User {
          name: String @backeneko(empty: true)
          bio: String @mock(empty: false)
          tags: [String] @mock(value: "x", empty: true)
        }
      `),
    );

    const values = collectFieldDirectives(document);
    expect(values.get("User.name")).toEqual({ empty: true });
    expect(values.get("User.tags")).toEqual({ empty: true, value: "x" });
    expect(values.has("User.bio")).toBe(false);
  });
});

describe("renderMockValue", () => {
  const schema = buildASTSchema(
    parse(`
      scalar Custom
      enum Role { ADMIN VIEWER }
      type Thing { name: String }
      type T {
        s: String
        id: ID
        n: Int
        f: Float
        b: Boolean
        r: Role
        c: Custom
        nn: Int!
        bangName: String!
        thing: Thing
        tags: [String!]
        ints: [Int]!
      }
    `),
  );

  const fields = (schema.getType("T") as GraphQLObjectType).getFields();
  const shapeOf = (name: string) => fieldShape(fields[name]!.type);

  const valueCases: Array<[string, string, string | null]> = [
    ["s", "hello", '"hello"'],
    ["id", "abc", '"abc"'],
    ["n", "42", "42"],
    ["f", "3.5", "3.5"],
    ["b", "true", "true"],
    ["b", "false", "false"],
    ["r", "ADMIN", '"ADMIN"'],
    ["c", "anything", '"anything"'],
    ["nn", "42", "42"],
    ["n", "abc", null],
    ["f", "abc", null],
    ["b", "yes", null],
    ["tags", "x", null],
  ];

  for (const [field, value, expected] of valueCases) {
    test(`${field} ${JSON.stringify(value)}`, () => {
      const result = renderMockValue({ empty: false, value }, shapeOf(field));
      if (expected === null) {
        expect(result.ok).toBe(false);
      } else {
        expect(result).toEqual({ ok: true, expression: expected });
      }
    });
  }

  const emptyCases: Array<[string, string | null]> = [
    ["s", '""'],
    ["id", '""'],
    ["bangName", '""'],
    ["tags", "[]"],
    ["ints", "[]"],
    ["n", "null"],
    ["c", "null"],
    ["r", "null"],
    ["thing", "null"],
    ["nn", null],
  ];

  for (const [field, expected] of emptyCases) {
    test(`empty ${field}`, () => {
      const result = renderMockValue({ empty: true }, shapeOf(field));
      if (expected === null) {
        expect(result.ok).toBe(false);
      } else {
        expect(result).toEqual({ ok: true, expression: expected });
      }
    });
  }

  test("empty: true wins over value and says so", () => {
    expect(renderMockValue({ empty: true, value: "x" }, shapeOf("s"))).toEqual({
      ok: true,
      expression: '""',
      warning: 'empty: true overrides value: "x"',
    });
  });
});
