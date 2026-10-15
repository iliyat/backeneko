import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { graphql } from "graphql";
import { generateWorkspace } from "../src/generate.ts";
import { emptyMockModules, loadMockModules } from "../src/mocks.ts";
import { buildExecutableSchema } from "../src/resolvers.ts";
import { runtime } from "../src/runtime.ts";

const SDL = `
type Query {
  user(id: ID): User
  users: [User!]!
  health: String!
}

type Mutation {
  createUser(name: String!): User!
}

type User {
  id: ID!
  name: String!
  role: Role!
  posts: [Post!]!
}

type Post {
  id: ID!
  title: String!
  author: User
}

enum Role {
  ADMIN
  VIEWER
}
`;

const MINIMAL_SDL = `
type Query {
  health: String!
}
`;

function rel(...segments: string[]): string {
  return path.join("generated", ...segments);
}

function generated(dir: string, ...segments: string[]): string {
  return path.join(dir, "generated", ...segments);
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "backeneko-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("generateWorkspace", () => {
  test("writes schema, tsconfig and mock files into generated/", async () => {
    const result = await generateWorkspace({ targetDir: dir, sdl: SDL });

    expect(result.created).toContain(rel("entities", "User.ts"));
    expect(result.created).toContain(rel("entities", "Post.ts"));
    expect(result.created).toContain(rel("queries", "user.ts"));
    expect(result.created).toContain(rel("queries", "users.ts"));
    expect(result.created).toContain(rel("queries", "health.ts"));
    expect(result.created).toContain(rel("mutations", "createUser.ts"));
    expect(result.created).toContain("schema.graphql");
    expect(result.created).not.toContain(rel("entities", "Query.ts"));
    expect(result.created).not.toContain(rel("entities", "Mutation.ts"));
    expect(result.updated).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(existsSync(path.join(dir, "tsconfig.json"))).toBe(true);
    expect(existsSync(path.join(dir, "override"))).toBe(false);
  });

  test("is idempotent when the schema did not change", async () => {
    await generateWorkspace({ targetDir: dir, sdl: SDL });
    const result = await generateWorkspace({ targetDir: dir, sdl: SDL });

    expect(result.created).toEqual([]);
    expect(result.updated).toEqual([]);
    expect(result.unchanged.length).toBeGreaterThan(0);
    expect(result.removed).toEqual([]);
  });

  test("aliases entities to override, then generated, then legacy layout", async () => {
    await generateWorkspace({ targetDir: dir, sdl: SDL });

    const config = JSON.parse(await readFile(path.join(dir, "tsconfig.json"), "utf8"));
    expect(config.compilerOptions.baseUrl).toBe(".");
    expect(config.compilerOptions.allowImportingTsExtensions).toBe(true);
    expect(config.compilerOptions.noEmit).toBe(true);
    expect(config.compilerOptions.paths["@entities/*"]).toEqual([
      "override/entities/*",
      "generated/entities/*",
      "entities/*",
    ]);
  });

  test("fills entity mock values based on field types", async () => {
    await generateWorkspace({ targetDir: dir, sdl: SDL });
    const user = await readFile(generated(dir, "entities", "User.ts"), "utf8");

    expect(user).toContain('id: "1"');
    expect(user).toContain('name: "Example"');
    expect(user).toContain('role: "ADMIN"');
    expect(user).toContain('import Post from "@entities/Post.ts";');
    expect(user).toContain("get posts() { return [Post]; }");
  });

  test("references related entities in both directions", async () => {
    await generateWorkspace({ targetDir: dir, sdl: SDL });
    const post = await readFile(generated(dir, "entities", "Post.ts"), "utf8");

    expect(post).toContain('import User from "@entities/User.ts";');
    expect(post).toContain("get author() { return User; }");
  });

  test("resolves nested relations through a cyclic schema", async () => {
    await generateWorkspace({ targetDir: dir, sdl: SDL });
    const schema = buildExecutableSchema(SDL);
    runtime.schema = schema;
    runtime.modules = await loadMockModules(dir);

    try {
      const result = await graphql({
        schema,
        source: "{ users { id posts { title author { name } } } }",
      });

      expect(result.errors).toBeUndefined();
      expect(result.data).toEqual({
        users: [{ id: "1", posts: [{ title: "Example", author: { name: "Example" } }] }],
      });
    } finally {
      runtime.modules = emptyMockModules();
    }
  });

  test("generates query and mutation fields as functions", async () => {
    await generateWorkspace({ targetDir: dir, sdl: SDL });

    const users = await readFile(generated(dir, "queries", "users.ts"), "utf8");
    expect(users).toContain('import User from "@entities/User.ts";');
    expect(users).toContain("export default function users(");
    expect(users).toContain("return [User];");

    const single = await readFile(generated(dir, "queries", "user.ts"), "utf8");
    expect(single).toContain("return User;");

    const health = await readFile(generated(dir, "queries", "health.ts"), "utf8");
    expect(health).toContain('return "Example";');

    const createUser = await readFile(generated(dir, "mutations", "createUser.ts"), "utf8");
    expect(createUser).toContain("export default function createUser(");
    expect(createUser).toContain("return User;");
  });

  test("overwrites generated files that were edited by hand", async () => {
    await generateWorkspace({ targetDir: dir, sdl: SDL });
    const userPath = generated(dir, "entities", "User.ts");
    await writeFile(userPath, "export default { id: 'custom' };\n", "utf8");

    const result = await generateWorkspace({ targetDir: dir, sdl: SDL });

    expect(result.updated).toContain(rel("entities", "User.ts"));
    expect(await readFile(userPath, "utf8")).toContain('id: "1"');
  });

  test("prunes generated files whose type left the schema", async () => {
    await generateWorkspace({ targetDir: dir, sdl: SDL });
    expect(existsSync(generated(dir, "entities", "Post.ts"))).toBe(true);

    const result = await generateWorkspace({ targetDir: dir, sdl: MINIMAL_SDL });

    expect(result.removed).toContain(rel("entities", "Post.ts"));
    expect(result.removed).toContain(rel("entities", "User.ts"));
    expect(result.removed).toContain(rel("queries", "user.ts"));
    expect(result.removed).toContain(rel("mutations", "createUser.ts"));
    expect(existsSync(generated(dir, "entities", "Post.ts"))).toBe(false);
    expect(existsSync(generated(dir, "queries", "health.ts"))).toBe(true);
    expect(existsSync(path.join(dir, "override"))).toBe(false);
  });
});

describe("override precedence", () => {
  test("loads override entities instead of generated ones", async () => {
    await generateWorkspace({ targetDir: dir, sdl: SDL });
    await mkdir(path.join(dir, "override", "entities"), { recursive: true });
    await writeFile(
      path.join(dir, "override", "entities", "User.ts"),
      "export default { id: 'override-id', name: 'override-name' };\n",
      "utf8",
    );

    const schema = buildExecutableSchema(SDL);
    runtime.schema = schema;
    runtime.modules = await loadMockModules(dir);

    try {
      expect(runtime.modules.entities.get("User")?.default).toEqual({
        id: "override-id",
        name: "override-name",
      });

      const result = await graphql({ schema, source: "{ user { id name } }" });
      expect(result.errors).toBeUndefined();
      expect(result.data).toEqual({ user: { id: "override-id", name: "override-name" } });
    } finally {
      runtime.modules = emptyMockModules();
    }
  });

  test("loads override root resolvers instead of generated ones", async () => {
    await generateWorkspace({ targetDir: dir, sdl: SDL });
    await mkdir(path.join(dir, "override", "queries"), { recursive: true });
    await writeFile(
      path.join(dir, "override", "queries", "user.ts"),
      "export default () => ({ id: 'from-override', name: 'from-override' });\n",
      "utf8",
    );

    const schema = buildExecutableSchema(SDL);
    runtime.schema = schema;
    runtime.modules = await loadMockModules(dir);

    try {
      const result = await graphql({ schema, source: "{ user { id name } }" });
      expect(result.errors).toBeUndefined();
      expect(result.data).toEqual({ user: { id: "from-override", name: "from-override" } });
    } finally {
      runtime.modules = emptyMockModules();
    }
  });

  test("resolves generated relation getters through override entities", async () => {
    await generateWorkspace({ targetDir: dir, sdl: SDL });
    await mkdir(path.join(dir, "override", "entities"), { recursive: true });
    await writeFile(
      path.join(dir, "override", "entities", "Post.ts"),
      "export default { id: 'p1', title: 'from-override' };\n",
      "utf8",
    );

    const schema = buildExecutableSchema(SDL);
    runtime.schema = schema;
    runtime.modules = await loadMockModules(dir);

    try {
      const result = await graphql({ schema, source: "{ users { posts { title } } }" });
      expect(result.errors).toBeUndefined();
      expect(result.data).toEqual({ users: [{ posts: [{ title: "from-override" }] }] });
    } finally {
      runtime.modules = emptyMockModules();
    }
  });
});

describe("mock directives", () => {
  const SDL_WITH_DIRECTIVES = `
    type Query { thing: Thing }
    type Thing {
      id: ID!
      name: String @backeneko(value: "Custom Name")
      code: ID @mock(value: "abc")
      age: Int @backeneko(value: "42")
      ratio: Float @mock(value: "3.5")
      active: Boolean @backeneko(value: "true")
      role: Role @backeneko(value: "ADMIN")
      tags: [String!] @backeneko(value: "nope")
      parent: Thing @backeneko(value: "nope")
    }
    enum Role { ADMIN VIEWER }
  `;

  test("applies and casts mock directive values, ignoring unsupported fields", async () => {
    const result = await generateWorkspace({ targetDir: dir, sdl: SDL_WITH_DIRECTIVES });
    const thing = await readFile(generated(dir, "entities", "Thing.ts"), "utf8");

    expect(thing).toContain('name: "Custom Name"');
    expect(thing).toContain('code: "abc"');
    expect(thing).toContain("age: 42");
    expect(thing).toContain("ratio: 3.5");
    expect(thing).toContain("active: true");
    expect(thing).toContain('role: "ADMIN"');

    expect(thing).toContain("tags: [],");
    expect(thing).toContain("get parent() { return Thing; }");
    expect(result.warnings.length).toBe(2);
    expect(result.warnings.some((line) => line.includes("Thing.tags"))).toBe(true);
    expect(result.warnings.some((line) => line.includes("Thing.parent"))).toBe(true);
  });

  test("warns and keeps the type default when the value cannot be cast", async () => {
    const result = await generateWorkspace({
      targetDir: dir,
      sdl: `
        type Query { thing: Thing }
        type Thing { count: Int @backeneko(value: "abc") }
      `,
    });

    const thing = await readFile(generated(dir, "entities", "Thing.ts"), "utf8");
    expect(thing).toContain("count: 0");
    expect(result.warnings.some((line) => line.includes("Thing.count"))).toBe(true);
  });

  test("does not require the directive to be declared", async () => {
    const result = await generateWorkspace({
      targetDir: dir,
      sdl: `type Query { thing: Thing } type Thing { name: String @backeneko(value: "auto") }`,
    });

    expect(result.schemaPath).toBeTruthy();
    const thing = await readFile(generated(dir, "entities", "Thing.ts"), "utf8");
    expect(thing).toContain('name: "auto"');
    expect(result.warnings).toEqual([]);
  });
});

describe("mock loading", () => {
  test("still loads the pre-generated top-level layout", async () => {
    await mkdir(path.join(dir, "entities"), { recursive: true });
    await writeFile(path.join(dir, "entities", "User.ts"), "export default { id: 'legacy' };\n", "utf8");

    const modules = await loadMockModules(dir);

    expect(modules.entities.get("User")?.default).toEqual({ id: "legacy" });
  });
});
