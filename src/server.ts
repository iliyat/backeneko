import {
  GraphQLError,
  execute,
  getOperationAST,
  parse,
  print,
  validate,
  type DocumentNode,
} from "graphql";
import { log } from "./log.ts";
import {
  forwardToUpstream,
  mergeResults,
  pickVariables,
  planRequest,
  readUpstreamResult,
  type ProxyOptions,
  type UpstreamResult,
} from "./proxy.ts";
import { runtime } from "./runtime.ts";

export interface ServerHandle {
  port: number;
  stop(): void;
}

export interface ServerOptions {
  validate?: boolean;
  proxy?: ProxyOptions | null;
}

// Parsing depends only on the query text, so this survives schema reloads.
const documentCache = new Map<string, DocumentNode>();

function parseCached(source: string): DocumentNode {
  let document = documentCache.get(source);
  if (!document) {
    document = parse(source);
    documentCache.set(source, document);
  }
  return document;
}

function errorEntry(error: unknown): unknown {
  if (error instanceof GraphQLError) return error;
  return { message: error instanceof Error ? error.message : String(error) };
}

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

export function startServer(port: number, options: ServerOptions = {}): ServerHandle {
  const validateQueries = options.validate ?? true;
  const server = Bun.serve({
    port,
    fetch: (request) => handleRequest(request, validateQueries, options.proxy ?? null),
  });
  return {
    port: server.port ?? port,
    stop: () => {
      server.stop(true);
    },
  };
}

async function handleRequest(
  request: Request,
  validateQueries: boolean,
  proxy: ProxyOptions | null,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/") {
    return new Response(INSPECTOR_HTML, {
      headers: { "content-type": "text/html; charset=utf-8", ...CORS_HEADERS },
    });
  }

  if (url.pathname !== "/graphql") {
    return json({ errors: [{ message: "not found" }] }, 404);
  }

  const payload = await readGraphQLRequest(request, url);
  if ("error" in payload) return json({ errors: [{ message: payload.error }] }, 400);

  let document: DocumentNode;
  try {
    document = parseCached(payload.query);
  } catch (error) {
    return json({ errors: [errorEntry(error)] });
  }

  if (proxy) {
    const routed = await handleProxiedRequest(request, payload, document, proxy, validateQueries);
    if (routed) return routed;
  }

  const schema = runtime.schema;
  if (!schema) {
    return json({ errors: [{ message: "schema is not loaded yet" }] }, 503);
  }

  try {
    if (validateQueries) {
      const validationErrors = validate(schema, document);
      if (validationErrors.length > 0) return json({ errors: validationErrors });
    }
    const result = await execute({
      schema,
      document,
      variableValues: payload.variables as never,
      operationName: payload.operationName ?? undefined,
      contextValue: {},
    });
    return json(result);
  } catch (error) {
    return json({ errors: [errorEntry(error)] }, 500);
  }
}

// Returns null when the request is handled locally, so the caller falls back to
// the regular mock execution.
async function handleProxiedRequest(
  request: Request,
  payload: GraphQLRequestPayload,
  document: DocumentNode,
  proxy: ProxyOptions,
  validateQueries: boolean,
): Promise<Response | null> {
  const plan = planRequest({
    document,
    operationName: payload.operationName,
    schema: runtime.schema,
    overriddenRoot: runtime.modules.overriddenRoot,
  });

  if (plan.mode === "error") {
    return json({ errors: [{ message: plan.error }] }, 400);
  }

  if (plan.mode === "local") return null;

  const label = operationLabel(document, payload.operationName);

  if (plan.mode === "proxy") {
    const outcome = await forwardToUpstream(
      proxy,
      {
        query: payload.query,
        variables: payload.variables,
        operationName: payload.operationName,
      },
      request.headers,
    );
    if (!outcome.ok) {
      log(`proxy failed → ${proxy.target} (${label}, ${outcome.status}, ${outcome.durationMs}ms)`);
      return json({ errors: [{ message: `proxy request failed: ${outcome.message}` }] }, outcome.status);
    }
    log(`proxied → ${proxy.target} (${label}, ${outcome.status}, ${outcome.durationMs}ms)`);
    return json(outcome.result, outcome.status);
  }

  const remoteOutcome = await forwardToUpstream(
    proxy,
    {
      query: print(plan.remoteDocument),
      variables: pickVariables(payload.variables, plan.remoteVariables),
      operationName: payload.operationName,
    },
    request.headers,
  );
  if (!remoteOutcome.ok) {
    log(`proxy failed → ${proxy.target} (${label}, ${remoteOutcome.status}, ${remoteOutcome.durationMs}ms)`);
    return json(
      { errors: [{ message: `proxy request failed: ${remoteOutcome.message}` }] },
      remoteOutcome.status,
    );
  }
  log(`proxied → ${proxy.target} (${label}, ${remoteOutcome.status}, ${remoteOutcome.durationMs}ms)`);

  const local = await executeLocal(
    plan.localDocument,
    payload.variables,
    plan.localVariables,
    validateQueries,
  );
  const remote = readUpstreamResult(remoteOutcome.result);
  const merged = mergeResults(local, remote, plan.order, plan.localKeys, plan.remoteKeys);
  return json(merged);
}

function operationLabel(document: DocumentNode, operationName: string | null | undefined): string {
  if (operationName) return operationName;
  const operation = getOperationAST(document);
  if (!operation) return "<multiple operations>";
  return operation.name?.value ?? "<anonymous>";
}

async function executeLocal(
  document: DocumentNode,
  variables: unknown,
  names: string[] | undefined,
  validateQueries: boolean,
): Promise<UpstreamResult> {
  const schema = runtime.schema;
  if (!schema) return { errors: [new GraphQLError("schema is not loaded yet")] };

  if (validateQueries) {
    const validationErrors = validate(schema, document);
    if (validationErrors.length > 0) return { errors: validationErrors };
  }

  const result = await execute({
    schema,
    document,
    variableValues: pickVariables(variables, names) as never,
    contextValue: {},
  });
  return { data: result.data, errors: result.errors, extensions: result.extensions };
}

interface GraphQLRequestPayload {
  query: string;
  variables: unknown;
  operationName: string | null;
}

async function readGraphQLRequest(
  request: Request,
  url: URL,
): Promise<GraphQLRequestPayload | { error: string }> {
  if (request.method === "GET") {
    const variables = parseVariables(url.searchParams.get("variables"));
    if (variables instanceof Error) return { error: variables.message };
    const query = url.searchParams.get("query");
    if (!query) return { error: "missing ?query parameter" };
    return { query, variables, operationName: url.searchParams.get("operationName") };
  }

  if (request.method !== "POST") return { error: `method ${request.method} not allowed` };

  const contentType = request.headers.get("content-type") ?? "";
  const body = await request.text();

  if (contentType.includes("application/graphql")) {
    return { query: body, variables: undefined, operationName: null };
  }

  if (contentType.includes("application/json")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      return { error: `invalid JSON body: ${error instanceof Error ? error.message : String(error)}` };
    }
    const record = (parsed ?? {}) as Record<string, unknown>;
    if (typeof record.query !== "string") return { error: "missing \"query\" field" };
    return {
      query: record.query,
      variables: record.variables,
      operationName: typeof record.operationName === "string" ? record.operationName : null,
    };
  }

  const params = new URLSearchParams(body);
  const query = params.get("query");
  if (!query) return { error: "missing \"query\" field" };
  const variables = parseVariables(params.get("variables"));
  if (variables instanceof Error) return { error: variables.message };
  return { query, variables, operationName: params.get("operationName") };
}

function parseVariables(raw: string | null): unknown | Error {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch (error) {
    return new Error(`invalid variables JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const INSPECTOR_HTML = [
  "<!doctype html>",
  "<html lang=\"en\">",
  "<head>",
  "<meta charset=\"utf-8\" />",
  "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />",
  "<title>backeneko mock backend</title>",
  "<style>",
  "  body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; margin: 2rem; background: #111; color: #eee; }",
  "  h1 { font-size: 1rem; color: #7dd3fc; }",
  "  pre.logo { color: #7dd3fc; line-height: 1.15; margin: 0 0 .75rem; background: transparent; border: 0; padding: 0; }",
  "  textarea { width: 100%; box-sizing: border-box; background: #1b1b1b; color: #eee; border: 1px solid #333; border-radius: 4px; padding: .5rem; }",
  "  button { margin: .5rem 0; padding: .4rem 1rem; background: #2563eb; color: white; border: 0; border-radius: 4px; cursor: pointer; }",
  "  pre { background: #1b1b1b; border: 1px solid #333; border-radius: 4px; padding: .75rem; overflow: auto; }",
  "  label { display: block; margin-top: .75rem; color: #9ca3af; font-size: .8rem; }",
  "</style>",
  "</head>",
  "<body>",
  "<pre class=\"logo\">",
  "   /\\_/\\",
  "  ( =.= ) ( (",
  "  /    \\  / /",
  " (_|__|_)/_/",
  "</pre>",
  "<h1>backeneko mock GraphQL backend</h1>",
  "<label for=\"query\">query</label>",
  "<textarea id=\"query\" rows=\"8\">{ __typename }</textarea>",
  "<label for=\"vars\">variables (JSON)</label>",
  "<textarea id=\"vars\" rows=\"3\"></textarea>",
  "<button id=\"run\" type=\"button\">Run</button>",
  "<pre id=\"out\">ready</pre>",
  "<script>",
  "  var out = document.getElementById('out');",
  "  document.getElementById('run').addEventListener('click', async function () {",
  "    var query = document.getElementById('query').value;",
  "    var rawVars = document.getElementById('vars').value;",
  "    var variables = null;",
  "    try { variables = rawVars.trim() ? JSON.parse(rawVars) : null; }",
  "    catch (e) { out.textContent = 'Bad variables JSON: ' + e.message; return; }",
  "    out.textContent = 'loading...';",
  "    try {",
  "      var res = await fetch('/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: query, variables: variables }) });",
  "      out.textContent = JSON.stringify(await res.json(), null, 2);",
  "    } catch (e) { out.textContent = String(e); }",
  "  });",
  "</script>",
  "</body>",
  "</html>",
  "",
].join("\n");
