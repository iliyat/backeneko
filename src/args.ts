import { parseArgs } from "node:util";

export interface CliOptions {
  source: string | null;
  port: number;
  dir: string;
  validate: boolean;
  proxyTo: string | null;
  proxyTimeout: number;
  help: boolean;
}

export const DEFAULT_PORT = 4000;
export const DEFAULT_WORKSPACE_DIR = ".backeneko";
export const DEFAULT_PROXY_TIMEOUT_MS = 30_000;

export function parseCliArgs(argv: string[] = process.argv.slice(2)): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      source: { type: "string" },
      port: { type: "string" },
      dir: { type: "string" },
      "no-validate": { type: "boolean" },
      "proxy-to": { type: "string" },
      "proxy-timeout": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: true,
  });

  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid --port value: ${values.port}`);
  }

  const proxyTimeout =
    values["proxy-timeout"] === undefined
      ? DEFAULT_PROXY_TIMEOUT_MS
      : Number(values["proxy-timeout"]);
  if (!Number.isInteger(proxyTimeout) || proxyTimeout < 1) {
    throw new Error(`invalid --proxy-timeout value: ${values["proxy-timeout"]}`);
  }

  return {
    source: values.source ?? null,
    port,
    dir: values.dir ?? DEFAULT_WORKSPACE_DIR,
    validate: !(values["no-validate"] ?? false),
    proxyTo: values["proxy-to"] === undefined ? null : parseProxyTarget(values["proxy-to"]),
    proxyTimeout,
    help: values.help ?? false,
  };
}

function parseProxyTarget(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`invalid --proxy-to value: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`--proxy-to must be an http(s) URL: ${value}`);
  }
  return url.toString();
}

export function printHelp(): void {
  console.log(`backeneko — mock GraphQL backend generated from .graphql schema files

Usage:
  backeneko [--source=<schema-directory>] [options]

Options:
  --source=<dir>   Directory with .graphql/.gql schema files. Regenerates the
                   workspace: overwrites schema.graphql and everything under
                   generated/, leaves override/ alone. Omit to serve <dir> as-is.
  --port=<n>       HTTP port (default: ${DEFAULT_PORT})
  --dir=<dir>      Workspace directory (default: ${DEFAULT_WORKSPACE_DIR})
  --no-validate    Skip validating queries against the schema (default: validate)
  --proxy-to=<url> Forward requests to an existing GraphQL backend. Root fields
                   with an override/queries|mutations file are answered locally,
                   everything else is proxied.
  --proxy-timeout=<ms>
                   Timeout for a proxied request (default: ${DEFAULT_PROXY_TIMEOUT_MS})
  -h, --help       Show this help

Behavior:
  * with --source: schema.graphql and generated/ are rewritten on every start,
    including files whose type or field disappeared from the schema, and the
    source directory is watched — editing, adding or removing .graphql/.gql
    files regenerates the workspace and hot-reloads the schema and mocks
    (.git, node_modules and dist are ignored)
  * override/entities|queries|mutations|subscriptions/<name>.ts wins over
    generated/<same path>; overrides are loaded, never written or removed
  * without --source: an existing <dir> is served unchanged
  * mock files and schema hot-reload on change`);
}
