import { existsSync } from "node:fs";
import path from "node:path";
import { importBundledModule, moduleFiles } from "../workspace/bundle.ts";
import { INTERCEPT_DIR, TSCONFIG_FILE } from "../workspace/generate.ts";
import { warn } from "../log.ts";
import { BUNDLE_DIR } from "../workspace/mocks.ts";
import type { ProxyPayload } from "./proxy.ts";

export { INTERCEPT_DIR };

export type InterceptMode = "auto" | "proxy" | "local";
export type InterceptRoute = "local" | "remote" | "split";
export type InterceptOperationType = "query" | "mutation" | "subscription";
export type InterceptScope = "query" | "mutation" | "operation";

export interface InterceptContext {
  operationName: string | null;
  operationType: InterceptOperationType;
  rootFields: string[];
  route: InterceptRoute;
  target: string | null;
  // The payload this interceptor was selected for. On a split route these are
  // the part's sub-document and variables, not the client's original request.
  query: string;
  variables: Record<string, unknown> | null;
  rootField?: string;
  file: string;
}

export type InterceptBaseContext = Omit<InterceptContext, "file" | "rootField">;

export interface InterceptResult {
  data?: unknown;
  errors?: readonly unknown[];
  extensions?: Record<string, unknown>;
}

export interface Interceptor {
  file: string;
  scope: InterceptScope;
  name: string;
  mode?: InterceptMode;
  match?(ctx: InterceptContext): boolean;
  before?(payload: ProxyPayload, ctx: InterceptContext): ProxyPayload | Promise<ProxyPayload>;
  after?(result: InterceptResult, ctx: InterceptContext): InterceptResult | Promise<InterceptResult>;
}

export interface SelectOptions {
  field?: boolean;
  operation?: boolean;
}

export interface PipelineOptions {
  // A local route executes an already parsed document, so a rewritten query or
  // operationName cannot be applied; only variables are.
  allowQuery?: boolean;
}

const SCOPES = [
  ["queries", "query"],
  ["mutations", "mutation"],
  ["operations", "operation"],
] as const;

const MODES: ReadonlySet<string> = new Set(["auto", "proxy", "local"]);

export async function loadInterceptors(dir: string, previous: Interceptor[] = []): Promise<Interceptor[]> {
  const root = path.join(dir, INTERCEPT_DIR);
  if (!existsSync(root)) return [];

  const bundleRoot = path.join(dir, BUNDLE_DIR);
  const tsconfigFile = path.join(dir, TSCONFIG_FILE);
  const tsconfig = existsSync(tsconfigFile) ? tsconfigFile : undefined;
  const previousByFile = new Map(previous.map((interceptor) => [interceptor.file, interceptor]));
  const interceptors: Interceptor[] = [];

  for (const [folder, scope] of SCOPES) {
    const directory = path.join(root, folder);
    if (!existsSync(directory)) continue;

    for (const entry of await moduleFiles(directory)) {
      const file = path.join(directory, entry.name);
      const name = path.basename(entry.name, path.extname(entry.name));
      try {
        const module = await importBundledModule(file, bundleRoot, {
          tsconfig,
          key: `${INTERCEPT_DIR}-${folder}-${name}`,
        });
        interceptors.push(readInterceptor(file, scope, name, module));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        warn(`failed to load ${path.relative(process.cwd(), file)}: ${message}`);
        const fallback = previousByFile.get(file);
        if (fallback) interceptors.push(fallback);
      }
    }
  }

  return interceptors;
}

function readInterceptor(
  file: string,
  scope: InterceptScope,
  name: string,
  module: Record<string, unknown>,
): Interceptor {
  const interceptor: Interceptor = { file, scope, name };
  const relative = path.relative(process.cwd(), file);

  if (module.mode !== undefined) {
    if (typeof module.mode === "string" && MODES.has(module.mode)) {
      interceptor.mode = module.mode as InterceptMode;
    } else {
      warn(`${relative}: ignoring mode ${JSON.stringify(module.mode)} (expected "auto", "proxy" or "local")`);
    }
  }

  for (const hook of ["match", "before", "after"] as const) {
    const value = module[hook];
    if (value === undefined) continue;
    if (typeof value !== "function") {
      warn(`${relative}: ignoring ${hook} (not a function)`);
      continue;
    }
    interceptor[hook] = value as never;
  }

  if (scope !== "operation" && interceptor.mode !== undefined) {
    warn(`${relative}: mode only applies to intercept/operations/<name>.ts`);
    interceptor.mode = undefined;
  }

  return interceptor;
}

export function operationMode(
  interceptors: Interceptor[],
  operationName: string | null,
): InterceptMode {
  const name = operationName ?? "default";
  const interceptor = interceptors.find(
    (candidate) => candidate.scope === "operation" && candidate.name === name,
  );
  return interceptor?.mode ?? "auto";
}

export interface InterceptionScope {
  kind: "operation" | "all-fields" | "fields";
  fields: string[];
}

// Describes which hooks actually run for a request: the whole operation, every
// root field, or only some of them. Mode-only files have no hooks and do not
// count as interception.
export function interceptionScope(
  interceptors: Interceptor[],
  rootFields: string[],
): InterceptionScope | null {
  const active = interceptors.filter(
    (interceptor) => interceptor.before || interceptor.after,
  );
  if (active.length === 0) return null;
  if (active.some((interceptor) => interceptor.scope === "operation")) {
    return { kind: "operation", fields: [] };
  }
  const fields = [...new Set(active.map((interceptor) => interceptor.name))];
  const complete = rootFields.length > 0 && rootFields.every((field) => fields.includes(field));
  return { kind: complete ? "all-fields" : "fields", fields };
}

// Field interceptors are selected in operation order, then the operation-wide
// one, so `before` runs outermost-first and `after` mirrors it.
export function selectInterceptors(
  interceptors: Interceptor[],
  base: InterceptBaseContext,
  options: SelectOptions = {},
): Interceptor[] {
  const selected: Interceptor[] = [];
  const seen = new Set<Interceptor>();

  const add = (interceptor: Interceptor): void => {
    if (seen.has(interceptor)) return;
    if (!matches(interceptor, base)) return;
    seen.add(interceptor);
    selected.push(interceptor);
  };

  if (options.field ?? true) {
    const scope =
      base.operationType === "query"
        ? "query"
        : base.operationType === "mutation"
          ? "mutation"
          : null;
    if (scope) {
      for (const field of base.rootFields) {
        for (const interceptor of interceptors) {
          if (interceptor.scope === scope && interceptor.name === field) add(interceptor);
        }
      }
    }
  }

  if (options.operation ?? true) {
    const name = base.operationName ?? "default";
    for (const interceptor of interceptors) {
      if (interceptor.scope === "operation" && interceptor.name === name) add(interceptor);
    }
  }

  return selected;
}

function matches(interceptor: Interceptor, base: InterceptBaseContext): boolean {
  if (!interceptor.match) return true;
  try {
    return interceptor.match(contextFor(interceptor, base));
  } catch (error) {
    warn(`${label(interceptor)}: match threw, interceptor skipped: ${message(error)}`);
    return false;
  }
}

export function contextFor(
  interceptor: Interceptor,
  base: InterceptBaseContext,
): InterceptContext {
  const ctx: InterceptContext = { ...base, file: interceptor.file };
  if (interceptor.scope !== "operation") ctx.rootField = interceptor.name;
  return ctx;
}

// GraphQL variables are a map; anything else (a primitive, an array) is not
// something a match() can inspect key by key.
export function normalizeVariables(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export async function runBefore(
  selected: Interceptor[],
  payload: ProxyPayload,
  base: InterceptBaseContext,
  options: PipelineOptions = {},
): Promise<ProxyPayload> {
  let current = payload;
  for (const interceptor of selected) {
    if (!interceptor.before) continue;
    let next: ProxyPayload;
    try {
      next = await interceptor.before(current, contextFor(interceptor, base));
    } catch (error) {
      warn(`${label(interceptor)}: before threw, payload unchanged: ${message(error)}`);
      continue;
    }
    if (!isRecord(next)) {
      warn(`${label(interceptor)}: before returned ${describe(next)}, payload unchanged`);
      continue;
    }
    if (options.allowQuery === false) {
      if (next.query !== current.query) {
        warn(`${label(interceptor)}: query changes are ignored on the ${base.route} route`);
      }
      if (next.operationName !== current.operationName) {
        warn(`${label(interceptor)}: operationName changes are ignored on the ${base.route} route`);
      }
      current = { ...current, variables: next.variables };
    } else {
      current = next;
    }
  }
  return current;
}

export async function runAfter(
  selected: Interceptor[],
  result: InterceptResult,
  base: InterceptBaseContext,
): Promise<InterceptResult> {
  let current = result;
  for (let index = selected.length - 1; index >= 0; index -= 1) {
    const interceptor = selected[index]!;
    if (!interceptor.after) continue;
    let next: InterceptResult;
    try {
      next = await interceptor.after(current, contextFor(interceptor, base));
    } catch (error) {
      warn(`${label(interceptor)}: after threw, result unchanged: ${message(error)}`);
      continue;
    }
    if (!isRecord(next)) {
      warn(`${label(interceptor)}: after returned ${describe(next)}, result unchanged`);
      continue;
    }
    current = next;
  }
  return current;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

function label(interceptor: Interceptor): string {
  return path.relative(process.cwd(), interceptor.file);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
