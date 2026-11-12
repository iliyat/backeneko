import { Command } from "commander";

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

interface RawCliOptions {
  source?: string;
  port: number;
  dir?: string;
  validate: boolean;
  proxyTo?: string;
  proxyTimeout: number;
  help?: boolean;
}

function createProgram(): Command {
  return new Command()
    .name("backeneko")
    .description("backeneko — mock GraphQL backend generated from .graphql schema files")
    .usage("[--source=<schema-directory>] [options]")
    .helpOption(false)
    .exitOverride()
    .configureOutput({ writeErr: () => {} })
    .allowExcessArguments(true)
    .option(
      "--source <dir>",
      "Directory with .graphql/.gql schema files. Regenerates the workspace: " +
        "overwrites schema.graphql and everything under generated/, leaves override/ alone. " +
        "Omit to serve <dir> as-is.",
    )
    .option("--port <n>", "HTTP port", parsePort, DEFAULT_PORT)
    .option("--dir <dir>", `Workspace directory (default: ${DEFAULT_WORKSPACE_DIR})`)
    .option("--no-validate", "Skip validating queries against the schema (default: validate)")
    .option(
      "--proxy-to <url>",
      "Forward requests to an existing GraphQL backend. Root fields with an " +
        "override/queries|mutations file are answered locally, everything else is proxied.",
      parseProxyTarget,
    )
    .option(
      "--proxy-timeout <ms>",
      "Timeout for a proxied request",
      parseProxyTimeout,
      DEFAULT_PROXY_TIMEOUT_MS,
    )
    .option("-h, --help", "Show this help")
    .addHelpText(
      "after",
      `
Behavior:
  * with --source: schema.graphql and generated/ are rewritten on every start,
    including files whose type or field disappeared from the schema; a broken
    source logs an error and the last good workspace keeps serving
  * the source directory is watched — editing, adding or removing .graphql/.gql
    files regenerates the workspace and hot-reloads the schema and mocks
    (.git, node_modules and dist are ignored)
  * override/entities|queries|mutations|subscriptions/<name>.ts wins over
    generated/<same path>; overrides are loaded, never written or removed
  * without --source: an existing <dir> is served unchanged; if <dir> does not
    exist, --source is required
  * with --proxy-to: mixed operations are split — overridden root fields run
    locally, the rest is forwarded upstream, and the results are merged
  * mock files and schema hot-reload on change`,
    );
}

export function parseCliArgs(argv: string[] = process.argv.slice(2)): CliOptions {
  const options = createProgram().parse(argv, { from: "user" }).opts<RawCliOptions>();

  return {
    source: options.source ?? null,
    port: options.port,
    dir: options.dir ?? DEFAULT_WORKSPACE_DIR,
    validate: options.validate,
    proxyTo: options.proxyTo ?? null,
    proxyTimeout: options.proxyTimeout,
    help: options.help ?? false,
  };
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid --port value: ${value}`);
  }
  return port;
}

function parseProxyTimeout(value: string): number {
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < 1) {
    throw new Error(`invalid --proxy-timeout value: ${value}`);
  }
  return timeout;
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
  createProgram().outputHelp();
}
