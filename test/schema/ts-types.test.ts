import { describe, expect, test } from "bun:test";
import { buildASTSchema, parse } from "graphql";
import { renderSchemaNamespace } from "../../src/schema/ts-types.ts";

const SDL = `
scalar DateTime

enum Role {
  ADMIN
  VIEWER
}

interface Node {
  id: ID!
}

type User implements Node {
  id: ID!
  name: String
  role: Role!
  tags: [String]
  scores: [Int!]!
  createdAt: DateTime
  friends: [User!]!
  editor: User
}

type Post implements Node {
  id: ID!
  title: String!
}

union SearchResult = User | Post

input CreateUserInput {
  name: String!
  email: String
  age: Int! = 18
  role: Role
}

type Query {
  users: [User!]!
  search: [SearchResult!]!
}
`;

const rendered = renderSchemaNamespace(buildASTSchema(parse(SDL)));

describe("renderSchemaNamespace", () => {
  test("wraps declarations in Backeneko.Schema", () => {
    expect(rendered.startsWith("  namespace Schema {\n")).toBe(true);
    expect(rendered.endsWith("\n  }")).toBe(true);
  });

  test("maps scalars, enums and unions", () => {
    expect(rendered).toContain("    type DateTime = any;");
    expect(rendered).toContain('    type Role = "ADMIN" | "VIEWER";');
    expect(rendered).toContain("    type SearchResult = User | Post;");
  });

  test("renders object and interface fields with nullability", () => {
    expect(rendered).toContain("    interface Node {");
    expect(rendered).toContain("      id: string;");
    expect(rendered).toContain("    interface User {");
    expect(rendered).toContain("      name: string | null;");
    expect(rendered).toContain("      role: Role;");
    expect(rendered).toContain("      tags: (string | null)[] | null;");
    expect(rendered).toContain("      scores: number[];");
    expect(rendered).toContain("      createdAt: DateTime | null;");
    expect(rendered).toContain("      friends: User[];");
    expect(rendered).toContain("      editor: User | null;");
  });

  test("renders input fields as optional when nullable or defaulted", () => {
    expect(rendered).toContain("    interface CreateUserInput {");
    expect(rendered).toContain("      name: string;");
    expect(rendered).toContain("      email?: string | null;");
    expect(rendered).toContain("      age?: number;");
    expect(rendered).toContain("      role?: Role | null;");
  });

  test("includes root types", () => {
    expect(rendered).toContain("    interface Query {");
    expect(rendered).toContain("      users: User[];");
    expect(rendered).toContain("      search: SearchResult[];");
  });
});
