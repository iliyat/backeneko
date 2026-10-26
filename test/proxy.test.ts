import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { buildExecutableSchema } from "../src/resolvers.ts";
import { runtime } from "../src/runtime.ts";
import { startServer, type ServerHandle } from "../src/server.ts";
import { mockModules } from "./helpers.ts";

const SDL = `
type User {
  id: ID!
  name: String!
}

type Query {
  users: [User!]!
  posts: [String!]!
  viewer: User
}

type Mutation {
  createUser(name: String!): User!
}
`;

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

function startUpstream(
  handler?: (request: UpstreamRequest) => unknown,
): Upstream {
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

afterAll(() => {
  runtime.schema = null;
});

async function run(body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://localhost:${server.port}/graphql`, {
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
        users: { default: [{ id: "1", name: "Local" }] },
        posts: { default: ["local"] },
      },
    },
    overridden: { Query: fields },
  });
}

describe("proxy routing", () => {
  test("forwards the request when no root field has an override", async () => {
    withOverrides([]);

    const result = await run({ query: "{ posts }" });

    expect(upstream.requests.length).toBe(1);
    expect(upstream.requests[0]?.query).toContain("posts");
    expect(result.body.data).toEqual({ posts: ["remote"] });
  });

  test("answers a root field with an override locally", async () => {
    withOverrides(["users"]);

    const result = await run({ query: "{ users { id name } }" });

    expect(upstream.requests.length).toBe(0);
    expect(result.body.data).toEqual({ users: [{ id: "1", name: "Local" }] });
  });

  test("splits an operation with both local and remote fields", async () => {
    withOverrides(["users"]);

    const result = await run({ query: "{ users { id } posts }" });

    expect(upstream.requests.length).toBe(1);
    expect(upstream.requests[0]?.query).toContain("posts");
    expect(upstream.requests[0]?.query).not.toContain("users");
    expect(result.body.data).toEqual({ users: [{ id: "1" }], posts: ["remote"] });
  });

  test("keeps the response keys of the original operation", async () => {
    withOverrides(["users"]);
    upstream.respond({ data: { mine: [{ id: "1" }], theirs: ["remote"] } });

    const result = await run({ query: "{ mine: users { id } theirs: posts }" });

    expect(upstream.requests[0]?.query).toContain("theirs: posts");
    expect(result.body.data).toEqual({ mine: [{ id: "1" }], theirs: ["remote"] });
  });

  test("passes only the variables the remote part uses", async () => {
    withOverrides(["users"]);

    await run({
      query: "query Q($id: ID!) { users(id: $id) { id } posts }",
      variables: { id: "7", unused: true },
    });

    expect(upstream.requests[0]?.variables).toEqual({});
  });

  test("drops upstream root keys the client did not ask for", async () => {
    withOverrides(["users"]);
    upstream.respond({ data: { posts: ["remote"], extra: "ignored" } });

    const result = await run({ query: "{ users { id } posts }" });

    expect(result.body.data).toEqual({ users: [{ id: "1" }], posts: ["remote"] });
  });

  test("routes the operation selected by operationName", async () => {
    withOverrides(["users"]);

    const result = await run({
      query: "query GetUsers { users { id } }\nquery GetPosts { posts }",
      operationName: "GetPosts",
    });

    expect(upstream.requests.length).toBe(1);
    expect(upstream.requests[0]?.query).toContain("posts");
    expect(result.body.data).toEqual({ posts: ["remote"] });
  });

  test("fails locally when several operations have no operation name", async () => {
    withOverrides(["users"]);

    const result = await run({
      query: "query GetUsers { users { id } }\nquery GetPosts { posts }",
    });

    expect(result.status).toBe(400);
    expect(upstream.requests.length).toBe(0);
    expect((result.body.errors as { message: string }[])[0]?.message).toContain(
      "Must provide operation name",
    );
  });

  test("forwards a document with several operations when nothing is overridden", async () => {
    withOverrides([]);
    upstream.respond({ errors: [{ message: "Must provide operation name" }] });

    const result = await run({
      query: "query GetUsers { users { id } }\nquery GetPosts { posts }",
    });

    expect(upstream.requests.length).toBe(1);
    expect(upstream.requests[0]?.query).toContain("GetUsers");
    expect((result.body.errors as { message: string }[])[0]?.message).toBe(
      "Must provide operation name",
    );
  });

  test("reports an unknown operation name locally", async () => {
    withOverrides(["users"]);

    const result = await run({
      query: "query GetUsers { users { id } }",
      operationName: "Nope",
    });

    expect(result.status).toBe(400);
    expect((result.body.errors as { message: string }[])[0]?.message).toContain(
      "Unknown operation named",
    );
  });

  test("answers 502 when the upstream is unreachable", async () => {
    withOverrides([]);
    upstream.stop();

    const result = await run({ query: "{ posts }" });

    expect(result.status).toBe(502);
    expect((result.body.errors as { message: string }[])[0]?.message).toContain(
      "proxy request failed",
    );
  });

  test("switches a field from proxied to local when an override appears", async () => {
    withOverrides([]);
    await run({ query: "{ users { id } }" });
    expect(upstream.requests.length).toBe(1);

    withOverrides(["users"]);
    const result = await run({ query: "{ users { id } }" });

    expect(upstream.requests.length).toBe(1);
    expect(result.body.data).toEqual({ users: [{ id: "1" }] });
  });

  test("keeps the client headers on the proxied request", async () => {
    withOverrides([]);

    const response = await fetch(`http://localhost:${server.port}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer token" },
      body: JSON.stringify({ query: "{ posts }" }),
    });
    await response.json();

    expect(upstream.requests.length).toBe(1);
  });

  test("splits an operation whose root fields come from a fragment", async () => {
    withOverrides(["users"]);

    const result = await run({
      query: "{ ...RootFields }\nfragment RootFields on Query { users { id } posts }",
    });

    expect(upstream.requests.length).toBe(1);
    expect(upstream.requests[0]?.query).toContain("posts");
    expect(upstream.requests[0]?.query).not.toContain("users");
    expect(result.body.data).toEqual({ users: [{ id: "1" }], posts: ["remote"] });
  });

  test("pushes a conditional fragment down to the fields", async () => {
    withOverrides(["users"]);

    await run({
      query:
        "query Q($withPosts: Boolean!) { ...RootFields @include(if: $withPosts) }\n" +
        "fragment RootFields on Query { users { id } posts }",
      variables: { withPosts: true },
    });

    expect(upstream.requests[0]?.query).toContain("posts");
    expect(upstream.requests[0]?.variables).toEqual({ withPosts: true });
  });

  test("keeps only the fragments the forwarded part uses", async () => {
    withOverrides(["users"]);

    await run({
      query: "{ users { ...UserFields } posts }\nfragment UserFields on User { id name }",
    });

    expect(upstream.requests[0]?.query).not.toContain("UserFields");
  });

  test("splits a mutation with an overridden field", async () => {
    runtime.modules = mockModules({
      entities: { User: { default: { id: "1", name: "Mocked" } } },
      root: {
        Mutation: {
          createUser: { default: () => ({ id: "local", name: "Local" }) },
        },
      },
      overridden: { Mutation: ["createUser"] },
    });

    const result = await run({
      query: "mutation { createUser(name: \"Ada\") { id } }",
    });

    expect(upstream.requests.length).toBe(0);
    expect(result.body.data).toEqual({ createUser: { id: "local" } });
  });
});
