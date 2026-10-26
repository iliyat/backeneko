import {
  getOperationAST,
  Kind,
  type DocumentNode,
  type ExecutionResult,
  type FragmentDefinitionNode,
  type GraphQLError,
  type GraphQLSchema,
  type OperationDefinitionNode,
} from "graphql";
import {
  buildSubDocument,
  collectRootFields,
  fragmentMap,
  mentionedRootFieldNames,
  type RootField,
} from "./graphql/split.ts";

export const DEFAULT_PROXY_TIMEOUT_MS = 30_000;

export interface ProxyOptions {
  target: string;
  timeoutMs?: number;
}

export interface ProxyPayload {
  query: string;
  variables?: unknown;
  operationName?: string | null;
}

export type RouteMode = "local" | "proxy" | "split" | "error";

export type RoutePlan =
  | { mode: "local" }
  | { mode: "proxy" }
  | { mode: "error"; error: string }
  | {
      mode: "split";
      localDocument: DocumentNode;
      remoteDocument: DocumentNode;
      localVariables: string[];
      remoteVariables: string[];
      order: string[];
      localKeys: string[];
      remoteKeys: string[];
    };

const ROOT_TYPE_BY_OPERATION: Record<"query" | "mutation" | "subscription", string> = {
  query: "Query",
  mutation: "Mutation",
  subscription: "Subscription",
};

// Decides where a request goes: local execution, the upstream service, or a
// split where overridden root fields are answered locally and the rest is
// forwarded. A root field is local when the user has an `override/<kind>/`
// file for it and the local schema knows the field.
export function planRequest(input: {
  document: DocumentNode;
  operationName: string | null;
  schema: GraphQLSchema | null;
  overriddenRoot: Map<string, Set<string>>;
}): RoutePlan {
  const { document, operationName, schema, overriddenRoot } = input;
  const fragments = fragmentMap(document);
  const operation = getOperationAST(document, operationName ?? undefined);

  if (!operation) {
    if (documentHasOverriddenRoot(document, fragments, schema, overriddenRoot)) {
      return { mode: "error", error: operationErrorMessage(operationName) };
    }
    return { mode: "proxy" };
  }

  const rootTypeName = ROOT_TYPE_BY_OPERATION[operation.operation];
  const rootFields = collectRootFields(operation, fragments);

  if (!rootFields) {
    const mentioned = mentionedRootFieldNames(operation, fragments);
    const local = mentioned.some((name) =>
      isLocalField(name, operation, rootTypeName, schema, overriddenRoot),
    );
    return { mode: local ? "local" : "proxy" };
  }

  const local: RootField[] = [];
  const remote: RootField[] = [];
  for (const field of rootFields) {
    if (isLocalField(field.name, operation, rootTypeName, schema, overriddenRoot)) local.push(field);
    else remote.push(field);
  }

  if (remote.length === 0) return { mode: "local" };
  if (local.length === 0) return { mode: "proxy" };

  const localSub = buildSubDocument(operation, local, fragments, rootTypeName);
  const remoteSub = buildSubDocument(operation, remote, fragments, rootTypeName);

  return {
    mode: "split",
    localDocument: localSub.document,
    remoteDocument: remoteSub.document,
    localVariables: localSub.variables,
    remoteVariables: remoteSub.variables,
    order: rootFields.map((field) => field.key),
    localKeys: local.map((field) => field.key),
    remoteKeys: remote.map((field) => field.key),
  };
}

function isLocalField(
  name: string,
  operation: OperationDefinitionNode,
  rootTypeName: string,
  schema: GraphQLSchema | null,
  overriddenRoot: Map<string, Set<string>>,
): boolean {
  if (!overriddenRoot.get(rootTypeName)?.has(name)) return false;
  if (!schema) return false;
  const rootType = schema.getRootType(operation.operation);
  if (!rootType) return false;
  return Boolean(rootType.getFields()[name]);
}

function documentHasOverriddenRoot(
  document: DocumentNode,
  fragments: Map<string, FragmentDefinitionNode>,
  schema: GraphQLSchema | null,
  overriddenRoot: Map<string, Set<string>>,
): boolean {
  for (const definition of document.definitions) {
    if (definition.kind !== Kind.OPERATION_DEFINITION) continue;
    const rootTypeName = ROOT_TYPE_BY_OPERATION[definition.operation];
    const fields = collectRootFields(definition, fragments);
    const names = fields
      ? fields.map((field) => field.name)
      : mentionedRootFieldNames(definition, fragments);
    for (const name of names) {
      if (isLocalField(name, definition, rootTypeName, schema, overriddenRoot)) return true;
    }
  }
  return false;
}

function operationErrorMessage(operationName: string | null): string {
  if (operationName) return `Unknown operation named "${operationName}".`;
  return "Must provide operation name if query contains multiple operations.";
}

// Only the variables the sub-document uses are sent along: an unused variable
// is a validation error in most GraphQL servers.
export function pickVariables(variables: unknown, names: string[] | undefined): unknown {
  if (!names || variables === null || typeof variables !== "object") return variables;
  const source = variables as Record<string, unknown>;
  const picked: Record<string, unknown> = {};
  for (const name of names) {
    if (name in source) picked[name] = source[name];
  }
  return picked;
}

const HOP_BY_HOP_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "content-encoding",
  "accept-encoding",
  "origin",
  "referer",
]);

export function forwardHeaders(source: Headers): Headers {
  const headers = new Headers();
  source.forEach((value, key) => {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) return;
    headers.set(key, value);
  });
  headers.set("content-type", "application/json");
  return headers;
}

export interface ProxyOutcome {
  ok: boolean;
  status: number;
  durationMs: number;
  result?: unknown;
  message?: string;
}

export async function forwardToUpstream(
  options: ProxyOptions,
  payload: ProxyPayload,
  source: Headers,
): Promise<ProxyOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROXY_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();

  try {
    const response = await fetch(options.target, {
      method: "POST",
      headers: forwardHeaders(source),
      body: JSON.stringify({
        query: payload.query,
        variables: payload.variables ?? null,
        operationName: payload.operationName ?? null,
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    const durationMs = Date.now() - started;

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {
        ok: false,
        status: 502,
        durationMs,
        message: `upstream returned a non-JSON response (HTTP ${response.status})`,
      };
    }

    return { ok: true, status: response.status, durationMs, result: parsed };
  } catch (error) {
    const durationMs = Date.now() - started;
    const aborted = controller.signal.aborted;
    return {
      ok: false,
      status: aborted ? 504 : 502,
      durationMs,
      message: aborted ? `timeout after ${timeoutMs}ms` : error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

// Merges the locally executed part with the upstream result. A null side means
// a non-null field failed there, which nulls the whole response just like a
// plain GraphQL execution would.
export function mergeResults(
  local: UpstreamResult,
  remote: UpstreamResult,
  order: string[],
  localKeys: string[],
  remoteKeys: string[],
): ExecutionResult {
  const merged: ExecutionResult = {};

  const data = mergeData(local.data, remote.data, order, localKeys, remoteKeys);
  if (data !== undefined) merged.data = data;

  const errors = orderErrors([...(local.errors ?? []), ...(remote.errors ?? [])], order);
  if (errors.length > 0) merged.errors = errors;

  const extensions = { ...(remote.extensions ?? {}), ...(local.extensions ?? {}) };
  if (Object.keys(extensions).length > 0) merged.extensions = extensions;

  return merged;
}

export interface UpstreamResult {
  data?: Record<string, unknown> | null;
  errors?: readonly GraphQLError[];
  extensions?: Record<string, unknown>;
}

// Reads the GraphQL-shaped part of an upstream response; anything else is
// ignored so a non-GraphQL payload cannot break the merge.
export function readUpstreamResult(value: unknown): UpstreamResult {
  if (!value || typeof value !== "object") return {};
  const record = value as { data?: unknown; errors?: unknown; extensions?: unknown };
  const result: UpstreamResult = {};
  if (record.data === null || (record.data !== undefined && typeof record.data === "object")) {
    result.data = record.data as Record<string, unknown> | null;
  }
  if (Array.isArray(record.errors)) result.errors = record.errors as GraphQLError[];
  if (record.extensions && typeof record.extensions === "object") {
    result.extensions = record.extensions as Record<string, unknown>;
  }
  return result;
}

function mergeData(
  local: Record<string, unknown> | null | undefined,
  remote: Record<string, unknown> | null | undefined,
  order: string[],
  localKeys: string[],
  remoteKeys: string[],
): Record<string, unknown> | null | undefined {
  if (local === undefined && remote === undefined) return undefined;
  if (local === null || remote === null) return null;

  const localData = local ?? {};
  const remoteData = remote ?? {};
  const merged: Record<string, unknown> = {};

  for (const key of order) {
    if (localKeys.includes(key)) {
      if (key in localData) merged[key] = localData[key];
    } else if (remoteKeys.includes(key)) {
      if (key in remoteData) merged[key] = remoteData[key];
    }
  }

  return merged;
}

function orderErrors(errors: readonly GraphQLError[], order: string[]): GraphQLError[] {
  const index = (error: GraphQLError): number => {
    const key = error.path?.[0];
    if (typeof key !== "string") return order.length;
    const position = order.indexOf(key);
    return position === -1 ? order.length : position;
  };
  return [...errors].sort((a, b) => index(a) - index(b));
}
