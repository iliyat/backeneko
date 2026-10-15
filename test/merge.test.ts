import { describe, expect, test } from "bun:test";
import { buildASTSchema } from "graphql";
import { mergeSchemaDocuments } from "../src/merge.ts";
import type { SchemaSourceFile } from "../src/collect.ts";

function file(relativePath: string, content: string): SchemaSourceFile {
  return { absolutePath: `/${relativePath}`, relativePath, content };
}

describe("mergeSchemaDocuments", () => {
  test("merges duplicate root types into extensions", () => {
    const { document } = mergeSchemaDocuments([
      file("a.graphql", "type Query { a: String }"),
      file("b.graphql", "type Query { b: String }"),
    ]);

    const schema = buildASTSchema(document);
    expect(Object.keys(schema.getQueryType()!.getFields())).toEqual(["a", "b"]);
  });

  test("keeps explicit extend blocks", () => {
    const { document } = mergeSchemaDocuments([
      file("a.graphql", "type Query { a: String }"),
      file("b.graphql", "extend type Query { b: String }"),
    ]);

    const schema = buildASTSchema(document);
    expect(Object.keys(schema.getQueryType()!.getFields())).toEqual(["a", "b"]);
  });

  test("orders extensions after first definitions", () => {
    const { document } = mergeSchemaDocuments([
      file("a.graphql", "extend type Query { b: String }"),
      file("b.graphql", "type Query { a: String }"),
    ]);

    const schema = buildASTSchema(document);
    expect(Object.keys(schema.getQueryType()!.getFields())).toEqual(["a", "b"]);
  });

  test("skips unparseable files without throwing and keeps the rest", () => {
    const result = mergeSchemaDocuments([
      file("broken.graphql", "type Query {"),
      file("good.graphql", "type Query { a: String }"),
    ]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("broken.graphql");
    expect(() => buildASTSchema(result.document)).not.toThrow();
  });

  test("ignores executable definitions (queries and fragments)", () => {
    const result = mergeSchemaDocuments([
      file("ops.graphql", "query GetUser { user { id } }\nfragment F on User { id }"),
    ]);

    expect(result.skippedExecutables).toEqual(["ops.graphql: query GetUser", "ops.graphql: fragment F"]);
    expect(result.document.definitions).toHaveLength(0);
  });
});
