import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  loadInterceptors,
  operationMode,
  runAfter,
  runBefore,
  selectInterceptors,
  type InterceptBaseContext,
  type Interceptor,
} from "../../src/request/intercept.ts";
import { emptyMockModules } from "../../src/workspace/mocks.ts";
import { buildExecutableSchema } from "../../src/schema/resolvers.ts";
import { runtime } from "../../src/runtime.ts";
import { startServer, type ServerHandle } from "../../src/request/server.ts";
import { mockModules } from "../helpers.ts";

const SDL = `
type User {
  id: ID!
  name: String!
}

type Query {
  users(limit: Int): [User!]!
  posts(limit: Int): [String!]!
  viewer: User
}

type Mutation {
  createUser(name: String!): User!
}
`;

function base(overrides: Partial<InterceptBaseContext> = {}): InterceptBaseContext {
  return {
    operationName: "Q",
    operationType: "query",
    rootFields: ["users"],
    route: "remote",
    target: "http://upstream/graphql",
    query: "query Q { users { id } }",
    variables: {},
    ...overrides,
  };
}

function hook(
  scope: Interceptor["scope"],
  name: string,
  behavior: Partial<Interceptor> = {},
): Interceptor {
  return {
    file: `intercept/${scope}/${name}.ts`,
    scope,
    name,
    ...behavior,
  };
}

function payload(variables: Record<string, unknown> = {}) {
  return { query: "query Q { users { id } }", variables, operationName: "Q" };
}

describe("interceptor selection and pipeline", () => {
  test("selects field interceptors in operation order, then the operation one", () => {
    const users = hook("query", "users");
    const posts = hook("query", "posts");
    const operation = hook("operation", "Q");

    const selected = selectInterceptors([operation, users, posts], base({ rootFields: ["posts", "users"] }));

    expect(selected).toEqual([posts, users, operation]);
  });

  test("skips a field interceptor of another operation type", () => {
    const mutation = hook("mutation", "users");
    expect(selectInterceptors([mutation], base())).toEqual([]);
  });

  test("honours match()", () => {
    const matching = hook("query", "users", { match: () => true });
    const rejected = hook("query", "users", { match: () => false });

    expect(selectInterceptors([rejected, matching], base())).toEqual([matching]);
  });

  test("lets match() inspect query and variables", () => {
    const goldOnly = hook("query", "users", {
      match: (ctx) => ctx.variables?.tier === "gold",
    });
    const previewOnly = hook("query", "users", {
      match: (ctx) => ctx.query.includes("preview"),
    });

    expect(selectInterceptors([goldOnly], base({ variables: { tier: "silver" } }))).toEqual([]);
    expect(selectInterceptors([goldOnly], base({ variables: { tier: "gold" } }))).toEqual([goldOnly]);
    expect(selectInterceptors([goldOnly], base({ variables: null }))).toEqual([]);

    expect(selectInterceptors([previewOnly], base({ query: "query Q { users { id } }" }))).toEqual([]);
    expect(selectInterceptors([previewOnly], base({ query: "query preview { users { id } }" }))).toEqual([
      previewOnly,
    ]);
  });

  test("runs before outside-in and after inside-out", async () => {
    const calls: string[] = [];
    const first = hook("query", "users", {
      file: "intercept/queries/first.ts",
      before: (value) => (calls.push("first before"), value),
      after: (value) => (calls.push("first after"), value),
    });
    const second = hook("query", "users", {
      file: "intercept/queries/second.ts",
      before: (value) => (calls.push("second before"), value),
      after: (value) => (calls.push("second after"), value),
    });

    await runBefore([first, second], payload(), base());
    await runAfter([first, second], { data: {} }, base());

    expect(calls).toEqual(["first before", "second before", "second after", "first after"]);
  });

  test("passes the intercept context with rootField and file", async () => {
    const seen: string[] = [];
    const interceptor = hook("query", "users", {
      before: (_, ctx) => {
        seen.push(`${ctx.route}|${ctx.operationType}|${ctx.rootField}|${ctx.file}|${ctx.target}`);
        return payload();
      },
    });

    await runBefore([interceptor], payload(), base());

    expect(seen).toEqual(["remote|query|users|intercept/query/users.ts|http://upstream/graphql"]);
  });

  test("ignores a thrown hook and a non-object return", async () => {
    const thrown = hook("query", "users", {
      file: "intercept/queries/thrown.ts",
      before: () => {
        throw new Error("boom");
      },
      after: () => {
        throw new Error("boom");
      },
    });
    const wrong = hook("query", "users", {
      file: "intercept/queries/wrong.ts",
      before: () => "nope" as never,
      after: () => 42 as never,
    });

    const outgoing = await runBefore([thrown, wrong], payload(), base());
    const result = await runAfter([thrown, wrong], { data: { posts: [] } }, base());

    expect(outgoing).toEqual(payload());
    expect(result).toEqual({ data: { posts: [] } });
  });

  test("ignores query changes on a parsed local route", async () => {
    const interceptor = hook("query", "users", {
      before: (value) => ({ ...value, query: "{ other }", variables: { limit: 3 } }),
    });

    const outgoing = await runBefore([interceptor], payload(), base({ route: "local" }), {
      allowQuery: false,
    });

    expect(outgoing.query).toBe(payload().query);
    expect(outgoing.variables).toEqual({ limit: 3 });
  });

  test("reads the operation mode by name, defaulting to auto", () => {
    const auto = hook("operation", "Q");
    const proxy = hook("operation", "GetPosts", { mode: "proxy" });

    expect(operationMode([auto, proxy], "Q")).toBe("auto");
    expect(operationMode([auto, proxy], "GetPosts")).toBe("proxy");
    expect(operationMode([auto, proxy], null)).toBe("auto");
  });
});

describe("interceptor loading", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "backeneko-intercept-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function write(relative: string, content: string): Promise<void> {
    const file = path.join(dir, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
  }

  test("loads field and operation interceptors", async () => {
    await write(
      "intercept/queries/users.ts",
      `export function before(payload) {
         return { ...payload, variables: { ...payload.variables, limit: 2 } };
       }
       export function match() { return true; }`,
    );
    await write("intercept/operations/GetUsers.ts", 'export const mode = "local";');

    const interceptors = await loadInterceptors(dir);
    const users = interceptors.find((entry) => entry.name === "users");
    const operation = interceptors.find((entry) => entry.name === "GetUsers");

    expect(users?.scope).toBe("query");
    expect(operation?.scope).toBe("operation");
    expect(operationMode(interceptors, "GetUsers")).toBe("local");

    const outgoing = await runBefore([users!], payload(), base());
    expect(outgoing.variables).toEqual({ limit: 2 });
  });

  test("matches an anonymous operation with operations/default.ts", async () => {
    await write("intercept/operations/default.ts", 'export const mode = "proxy";');

    const interceptors = await loadInterceptors(dir);

    expect(operationMode(interceptors, null)).toBe("proxy");
  });

  test("reloads a changed interceptor without a restart", async () => {
    await write(
      "intercept/queries/users.ts",
      `export function before(payload) { return { ...payload, variables: { version: 1 } }; }`,
    );
    const first = await loadInterceptors(dir);

    await write(
      "intercept/queries/users.ts",
      `export function before(payload) { return { ...payload, variables: { version: 2 } }; }`,
    );
    const second = await loadInterceptors(dir, first);

    const outgoing = await runBefore(second, payload(), base());
    expect(outgoing.variables).toEqual({ version: 2 });
  });

  test("keeps the previous interceptor when a file stops loading", async () => {
    await write(
      "intercept/queries/users.ts",
      `export function before(payload) { return { ...payload, variables: { ok: true } }; }`,
    );
    const first = await loadInterceptors(dir);

    await write("intercept/queries/users.ts", 'throw new Error("boom");');
    const second = await loadInterceptors(dir, first);

    const outgoing = await runBefore(second, payload(), base());
    expect(outgoing.variables).toEqual({ ok: true });
  });

  test("ignores hooks that are not functions", async () => {
    await write("intercept/queries/users.ts", "export const before = 42;");

    const [interceptor] = await loadInterceptors(dir);

    expect(interceptor?.before).toBeUndefined();
  });
});

interface UpstreamRequest {
  query: string;
  variables: unknown;
  operationName: string | null;
}

interface Upstream {
  url: string;
  requests: UpstreamRequest[];
  respond(body: unknown, status?: number): void;
  stop(): void;
}

function startUpstream(handler?: (request: UpstreamRequest) => unknown): Upstream {
  const requests: UpstreamRequest[] = [];
  let response: { body: unknown; status: number } = {
    body: { data: { posts: ["remote"] } },
    status: 200,
  };

  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as UpstreamRequest;
      requests.push(body);
      const result = handler ? handler(body) : undefined;
      return new Response(JSON.stringify(result ?? response.body), {
        status: response.status,
        headers: { "content-type": "application/json" },
      });
    },
  });

  return {
    url: `http://localhost:${server.port}/graphql`,
    requests,
    respond(body, status = 200) {
      response = { body, status };
    },
    stop() {
      server.stop(true);
    },
  };
}

let upstream: Upstream;
let server: ServerHandle;

beforeAll(() => {
  runtime.schema = buildExecutableSchema(SDL);
});

beforeEach(() => {
  upstream = startUpstream();
  server = startServer(0, { proxy: { target: upstream.url } });
});

afterEach(() => {
  server.stop();
  upstream.stop();
  runtime.interceptors = [];
  runtime.modules = emptyMockModules();
});

afterAll(() => {
  runtime.schema = null;
});

async function run(
  body: unknown,
  target: ServerHandle = server,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://localhost:${target.port}/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

function withOverrides(fields: string[]): void {
  runtime.modules = mockModules({
    entities: { User: { default: { id: "1", name: "Mocked" } } },
    root: {
      Query: {
        users: { default: (_parent: unknown, args: Record<string, unknown>) => [{ id: String(args.limit) }] },
        posts: { default: ["local"] },
      },
    },
    overridden: { Query: fields },
  });
}

describe("intercepting proxied requests", () => {
  test("rewrites the payload before it is forwarded", async () => {
    runtime.interceptors = [
      hook("query", "posts", {
        before: (value) => ({ ...value, variables: { ...(value.variables as object), limit: 10 } }),
      }),
    ];

    await run({ query: "query Q($limit: Int) { posts(limit: $limit) }", variables: { limit: 1 } });

    expect(upstream.requests[0]?.variables).toEqual({ limit: 10 });
  });

  test("rewrites the response after it arrives", async () => {
    runtime.interceptors = [
      hook("query", "posts", {
        after: (result) => ({ ...result, data: { posts: ["intercepted"] } }),
      }),
    ];

    const result = await run({ query: "{ posts }" });

    expect(result.body.data).toEqual({ posts: ["intercepted"] });
  });

  test("applies hooks only when match() accepts the payload", async () => {
    runtime.interceptors = [
      hook("query", "posts", {
        match: (ctx) => ctx.variables?.tier === "gold",
        before: (value) => ({ ...value, variables: { limit: 42 } }),
        after: (result) => ({ ...result, data: { posts: ["intercepted"] } }),
      }),
    ];

    const query = "query Q($tier: String, $limit: Int) { posts(limit: $limit) }";
    const silver = await run({ query, variables: { tier: "silver", limit: 1 } });
    const gold = await run({ query, variables: { tier: "gold", limit: 1 } });

    expect(upstream.requests[0]?.variables).toEqual({ tier: "silver", limit: 1 });
    expect(silver.body.data).toEqual({ posts: ["remote"] });
    expect(upstream.requests[1]?.variables).toEqual({ limit: 42 });
    expect(gold.body.data).toEqual({ posts: ["intercepted"] });
  });

  test("applies operation mode local without an override", async () => {
    runtime.modules = mockModules({
      entities: { User: { default: { id: "1", name: "Local" } } },
    });
    runtime.interceptors = [hook("operation", "Q", { mode: "local" })];

    const result = await run({ query: "query Q { users { id name } }" });

    expect(upstream.requests.length).toBe(0);
    expect(result.body.data).toEqual({ users: [{ id: "1", name: "Local" }] });
  });

  test("applies operation mode proxy even when a field is overridden", async () => {
    withOverrides(["users"]);
    runtime.interceptors = [hook("operation", "Q", { mode: "proxy" })];

    await run({ query: "query Q { users { id } }" });

    expect(upstream.requests.length).toBe(1);
    expect(upstream.requests[0]?.query).toContain("users");
  });

  test("uses operations/default.ts for an anonymous operation", async () => {
    withOverrides(["users"]);
    runtime.interceptors = [hook("operation", "default", { mode: "proxy" })];

    await run({ query: "{ users { id } }" });

    expect(upstream.requests.length).toBe(1);
  });

  test("runs each field interceptor on its own part of a split request", async () => {
    withOverrides(["users"]);
    const seen: string[] = [];
    runtime.interceptors = [
      hook("query", "users", {
        before: (value) => {
          seen.push("users");
          return { ...value, variables: { limit: 99 } };
        },
      }),
      hook("query", "posts", {
        before: (value) => {
          seen.push("posts");
          return { ...value, variables: { limit: 7 } };
        },
      }),
    ];

    const result = await run({
      query: "query Q($limit: Int) { users(limit: $limit) { id } posts(limit: $limit) }",
      variables: { limit: 1 },
    });

    expect(seen).toEqual(["posts", "users"]);
    expect(upstream.requests[0]?.variables).toEqual({ limit: 7 });
    expect(result.body.data).toEqual({ users: [{ id: "99" }], posts: ["remote"] });
  });

  test("wraps a split request with the operation interceptor exactly once", async () => {
    withOverrides(["users"]);
    const calls: string[] = [];
    runtime.interceptors = [
      hook("operation", "Q", {
        before: (value) => (calls.push("operation before"), value),
        after: (value) => (calls.push("operation after"), value),
      }),
      hook("query", "posts", {
        before: (value) => (calls.push("posts before"), value),
        after: (value) => (calls.push("posts after"), value),
      }),
    ];

    await run({ query: "query Q { users { id } posts }" });

    expect(calls).toEqual(["operation before", "posts before", "posts after", "operation after"]);
  });

  test("describes the route and fields of a split part", async () => {
    withOverrides(["users"]);
    const seen: string[] = [];
    runtime.interceptors = [
      hook("query", "posts", {
        before: (value, ctx) => {
          seen.push(
            `${ctx.route}|${ctx.operationName}|${ctx.rootFields.join(",")}|${ctx.rootField}|` +
              `${JSON.stringify(ctx.variables)}|${ctx.query.includes("posts")}|${ctx.target}`,
          );
          return value;
        },
      }),
    ];

    await run({
      query: "query Q($limit: Int) { users { id } posts(limit: $limit) }",
      variables: { limit: 1 },
    });

    expect(seen).toEqual([`split|Q|posts|posts|{"limit":1}|true|${upstream.url}`]);
  });

  test("runs interceptors on a local-only server", async () => {
    const local = startServer(0);
    runtime.modules = mockModules({
      entities: { User: { default: { id: "1", name: "Local" } } },
      root: {
        Query: {
          users: {
            default: (_parent: unknown, args: Record<string, unknown>) => [{ id: String(args.limit) }],
          },
        },
      },
    });
    runtime.interceptors = [
      hook("query", "users", {
        before: (value) => ({ ...value, variables: { limit: 5 } }),
        after: (value) => ({ ...value, extensions: { intercepted: true } }),
      }),
    ];

    try {
      const result = await run({ query: "query Q($limit: Int) { users(limit: $limit) { id } }" }, local);

      expect(result.body.data).toEqual({ users: [{ id: "5" }] });
      expect(result.body.extensions).toEqual({ intercepted: true });
    } finally {
      local.stop();
    }
  });
});
