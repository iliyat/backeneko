import {
  GraphQLError,
  execute,
  getOperationAST,
  parse,
  print,
  validate,
  type DocumentNode,
  type GraphQLSchema,
} from "graphql";
import { collectRootFields, fragmentMap, mentionedRootFieldNames } from "./split.ts";
import {
  normalizeVariables,
  operationMode,
  runAfter,
  runBefore,
  selectInterceptors,
  type InterceptBaseContext,
  type InterceptRoute,
} from "./intercept.ts";
import { log } from "../log.ts";
import {
  forwardToUpstream,
  mergeResults,
  pickVariables,
  planRequest,
  readUpstreamResult,
  type ProxyOptions,
  type UpstreamResult,
} from "./proxy.ts";
import { runtime } from "../runtime.ts";

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

  return executeLocally(payload, document, schema, validateQueries);
}

async function executeLocally(
  payload: GraphQLRequestPayload,
  document: DocumentNode,
  schema: GraphQLSchema,
  validateQueries: boolean,
): Promise<Response> {
  const base = requestContext(document, payload.operationName, "local", null, payload);
  const selected = selectInterceptors(runtime.interceptors, base);
  const before = await runBefore(
    selected,
    {
      query: payload.query,
      variables: payload.variables,
      operationName: payload.operationName,
    },
    base,
    { allowQuery: false },
  );

  try {
    if (validateQueries) {
      const validationErrors = validate(schema, document);
      if (validationErrors.length > 0) return json({ errors: validationErrors });
    }
    const result = await execute({
      schema,
      document,
      variableValues: before.variables as never,
      operationName: payload.operationName ?? undefined,
      contextValue: {},
    });
    return json(await runAfter(selected, result, base));
  } catch (error) {
    return json({ errors: [errorEntry(error)] }, 500);
  }
}

// Returns null when the request is handled locally, so the caller falls back to
// the regular mock execution (which runs the interceptors of the local route).
async function handleProxiedRequest(
  request: Request,
  payload: GraphQLRequestPayload,
  document: DocumentNode,
  proxy: ProxyOptions,
  validateQueries: boolean,
): Promise<Response | null> {
  const operationName = effectiveOperationName(document, payload.operationName);
  const mode = operationMode(runtime.interceptors, operationName);
  const plan = planRequest({
    document,
    operationName: payload.operationName,
    schema: runtime.schema,
    overriddenRoot: runtime.modules.overriddenRoot,
    mode,
  });

  if (plan.mode === "error") {
    return json({ errors: [{ message: plan.error }] }, 400);
  }

  if (plan.mode === "local") return null;

  const label = operationLabel(document, payload.operationName);

  if (plan.mode === "proxy") {
    const base = requestContext(document, payload.operationName, "remote", proxy.target, payload);
    const selected = selectInterceptors(runtime.interceptors, base);
    const outgoing = await runBefore(
      selected,
      {
        query: payload.query,
        variables: payload.variables,
        operationName: payload.operationName,
      },
      base,
    );

    const outcome = await forwardToUpstream(proxy, outgoing, request.headers);
    if (!outcome.ok) {
      log(`proxy failed → ${proxy.target} (${label}, ${outcome.status}, ${outcome.durationMs}ms)`);
      return json({ errors: [{ message: `proxy request failed: ${outcome.message}` }] }, outcome.status);
    }
    log(`proxied → ${proxy.target} (${label}, ${outcome.status}, ${outcome.durationMs}ms)`);
    const result = await runAfter(selected, readUpstreamResult(outcome.result), base);
    return json(result, outcome.status);
  }

  // In split mode the operation-wide interceptor wraps the whole request; field
  // interceptors only see their own part, so no hook runs twice. The operation
  // hook runs before the split, so a field `match()` sees the variables it
  // actually forwards.
  const base = requestContext(document, payload.operationName, "split", proxy.target, payload);
  const whole = selectInterceptors(runtime.interceptors, base, { field: false });
  const before = await runBefore(
    whole,
    {
      query: payload.query,
      variables: payload.variables,
      operationName: payload.operationName,
    },
    base,
    { allowQuery: false },
  );

  const remotePayload = {
    query: print(plan.remoteDocument),
    variables: pickVariables(before.variables, plan.remoteVariables),
    operationName: payload.operationName,
  };
  const localPayload = {
    query: payload.query,
    variables: before.variables,
    operationName: payload.operationName,
  };

  const remoteBase = {
    ...base,
    rootFields: plan.remoteFieldNames,
    query: remotePayload.query,
    variables: normalizeVariables(remotePayload.variables),
  };
  const localBase = {
    ...base,
    rootFields: plan.localFieldNames,
    query: localPayload.query,
    variables: normalizeVariables(localPayload.variables),
  };
  const remoteSelected = selectInterceptors(runtime.interceptors, remoteBase, { operation: false });
  const localSelected = selectInterceptors(runtime.interceptors, localBase, { operation: false });

  const forwarded = await runBefore(remoteSelected, remotePayload, remoteBase, { allowQuery: false });
  const executed = await runBefore(localSelected, localPayload, localBase, { allowQuery: false });

  const remoteOutcome = await forwardToUpstream(proxy, forwarded, request.headers);
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
    executed.variables,
    plan.localVariables,
    validateQueries,
  );
  const remoteResult = await runAfter(
    remoteSelected,
    readUpstreamResult(remoteOutcome.result),
    remoteBase,
  );
  const localResult = await runAfter(localSelected, local, localBase);
  const merged = mergeResults(
    readUpstreamResult(localResult),
    readUpstreamResult(remoteResult),
    plan.order,
    plan.localKeys,
    plan.remoteKeys,
  );
  return json(await runAfter(whole, merged, base));
}

function requestContext(
  document: DocumentNode,
  operationName: string | null,
  route: InterceptRoute,
  target: string | null,
  payload: GraphQLRequestPayload,
): InterceptBaseContext {
  const operation = getOperationAST(document, operationName ?? undefined);
  const fragments = fragmentMap(document);
  const fields = operation ? collectRootFields(operation, fragments) : null;
  const rootFields = fields
    ? [...new Set(fields.map((field) => field.name))]
    : operation
      ? mentionedRootFieldNames(operation, fragments)
      : [];
  return {
    operationName: effectiveOperationName(document, operationName),
    operationType: operation?.operation ?? "query",
    rootFields,
    route,
    target,
    query: payload.query,
    variables: normalizeVariables(payload.variables),
  };
}

// The request field may be omitted for a document with a single named
// operation; intercept/operations/<name>.ts should still match it.
function effectiveOperationName(
  document: DocumentNode,
  operationName: string | null,
): string | null {
  if (operationName) return operationName;
  return getOperationAST(document)?.name?.value ?? null;
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
