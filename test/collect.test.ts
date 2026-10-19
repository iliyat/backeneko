import { describe, expect, test } from "bun:test";
import { isIgnoredSourcePath } from "../src/collect.ts";

describe("isIgnoredSourcePath", () => {
  test("keeps schema files anywhere", () => {
    expect(isIgnoredSourcePath("user.graphql")).toBe(false);
    expect(isIgnoredSourcePath("nested/user.gql")).toBe(false);
    expect(isIgnoredSourcePath("distances.graphql")).toBe(false);
    expect(isIgnoredSourcePath(".hidden.graphql")).toBe(false);
  });

  test("drops everything that is not a schema file", () => {
    expect(isIgnoredSourcePath("")).toBe(true);
    expect(isIgnoredSourcePath("README.md")).toBe(true);
    expect(isIgnoredSourcePath("queries.graphql~")).toBe(true);
    expect(isIgnoredSourcePath("nested")).toBe(true);
    expect(isIgnoredSourcePath("nested/")).toBe(true);
  });

  test("drops schema files below skipped directories", () => {
    expect(isIgnoredSourcePath(".git/config")).toBe(true);
    expect(isIgnoredSourcePath("node_modules/pkg/schema.graphql")).toBe(true);
    expect(isIgnoredSourcePath("dist/out.graphql")).toBe(true);
    expect(isIgnoredSourcePath("nested/.hidden/x.graphql")).toBe(true);
    expect(isIgnoredSourcePath("a/node_modules/b/schema.graphql")).toBe(true);
  });
});
