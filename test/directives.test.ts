import { describe, expect, test } from "bun:test";
import { buildASTSchema, parse, print } from "graphql";
import {
  collectFieldDirectives,
  renderMockValue,
  withMockDirectives,
} from "../src/directives.ts";

describe("withMockDirectives", () => {
  test("injects a definition for an undeclared directive", () => {
    const document = withMockDirectives(parse("type User { name: String @backeneko(value: \"x\") }"));
    const printed = print(document);

    expect(printed).toContain("directive @backeneko(value: String) on FIELD_DEFINITION");
    expect(buildASTSchema(document)).toBeDefined();
  });

  test("injects both project directives when both are used", () => {
    const document = withMockDirectives(
      parse('type User { a: String @backeneko(value: "x") b: String @mock(value: "y") }'),
    );
    const printed = print(document);

    expect(printed).toContain("directive @backeneko(value: String)");
    expect(printed).toContain("directive @mock(value: String)");
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
    expect(values.get("User.name")).toBe("Ada");
    expect(values.get("User.email")).toBe("ada@example.com");
    expect(values.has("User.id")).toBe(false);
  });
});

describe("renderMockValue", () => {
  const schema = buildASTSchema(
    parse(`
      scalar Custom
      enum Role { ADMIN VIEWER }
      type T {
        s: String
        id: ID
        n: Int
        f: Float
        b: Boolean
        r: Role
        c: Custom
      }
    `),
  );

  const cases: Array<[string, string, boolean, string | null]> = [
    ["String", "hello", false, '"hello"'],
    ["ID", "abc", false, '"abc"'],
    ["Int", "42", false, "42"],
    ["Float", "3.5", false, "3.5"],
    ["Boolean", "true", false, "true"],
    ["Boolean", "false", false, "false"],
    ["Role", "ADMIN", false, '"ADMIN"'],
    ["Custom", "anything", false, '"anything"'],
    ["Int", "abc", false, null],
    ["Float", "abc", false, null],
    ["Boolean", "yes", false, null],
    ["String", "x", true, null],
  ];

  for (const [typeName, value, list, expected] of cases) {
    test(`${typeName} ${JSON.stringify(value)}${list ? " (list)" : ""}`, () => {
      const type = schema.getType(typeName)!;
      const result = renderMockValue(value, type, list);
      if (expected === null) {
        expect(result.ok).toBe(false);
      } else {
        expect(result).toEqual({ ok: true, expression: expected });
      }
    });
  }
});
