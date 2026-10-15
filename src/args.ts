import { parseArgs } from "node:util";

export interface CliOptions {
  source: string | null;
  port: number;
  dir: string;
  validate: boolean;
  help: boolean;
}

export const DEFAULT_PORT = 4000;
export const DEFAULT_WORKSPACE_DIR = ".backeneko";

export function parseCliArgs(argv: string[] = process.argv.slice(2)): CliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      source: { type: "string" },
      port: { type: "string" },
      dir: { type: "string" },
      "no-validate": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: true,
    strict: true,
  });

  const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid --port value: ${values.port}`);
  }

  return {
    source: values.source ?? null,
    port,
    dir: values.dir ?? DEFAULT_WORKSPACE_DIR,
    validate: !(values["no-validate"] ?? false),
    help: values.help ?? false,
  };
}

export function printHelp(): void {
  console.log(`backeneko — mock GraphQL backend generated from .graphql schema files

Usage:
  bun run src/cli.ts [--source=<schema-directory>] [options]

Options:
  --source=<dir>   Directory with .graphql/.gql schema files. Regenerates the
                   workspace: overwrites schema.graphql and everything under
                   generated/, leaves override/ alone. Omit to serve <dir> as-is.
  --port=<n>       HTTP port (default: ${DEFAULT_PORT})
  --dir=<dir>      Workspace directory (default: ${DEFAULT_WORKSPACE_DIR})
  --no-validate    Skip validating queries against the schema (default: validate)
  -h, --help       Show this help

Behavior:
  * with --source: schema.graphql and generated/ are rewritten on every start,
    including files whose type or field disappeared from the schema
  * override/entities|queries|mutations|subscriptions/<name>.ts wins over
    generated/<same path>; overrides are loaded, never written or removed
  * without --source: an existing <dir> is served unchanged
  * mock files and schema hot-reload on change`);
}
