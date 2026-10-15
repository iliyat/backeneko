import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { buildExecutableSchema } from "../src/resolvers.ts";
import { runtime } from "../src/runtime.ts";
import { startServer, type ServerHandle } from "../src/server.ts";

const SDL = `
type Query {
  hello: String!
}
`;

beforeAll(() => {
  runtime.schema = buildExecutableSchema(SDL);
});

afterAll(() => {
  runtime.schema = null;
});

async function run(server: ServerHandle, query: string): Promise<Record<string, unknown>> {
  const response = await fetch(`http://localhost:${server.port}/graphql`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query }),
  });
  return (await response.json()) as Record<string, unknown>;
}

describe("server query validation", () => {
  test("rejects unknown fields by default", async () => {
    const server = startServer(0);
    try {
      const body = await run(server, "{ unknownField }");
      const errors = body.errors as { message: string }[];
      expect(errors[0]?.message).toContain("Cannot query field");
    } finally {
      server.stop();
    }
  });

  test("skips validation when disabled", async () => {
    const server = startServer(0, { validate: false });
    try {
      const body = await run(server, "{ unknownField }");
      expect(body.errors).toBeUndefined();
      expect(body.data).toEqual({});
    } finally {
      server.stop();
    }
  });
});
