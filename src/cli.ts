#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseCliArgs, printHelp } from "./args.ts";
import { collectSchemaFiles } from "./collect.ts";
import { compileDocument } from "./compile.ts";
import {
  GENERATED_DIR,
  OVERRIDE_DIR,
  ensureWorkspaceTsconfig,
  generateWorkspace,
} from "./generate.ts";
import { mergeSchemaDocuments, renderSdl } from "./merge.ts";
import { loadMockModules } from "./mocks.ts";
import { buildExecutableSchema } from "./resolvers.ts";
import { runtime } from "./runtime.ts";
import { startServer } from "./server.ts";
import { watchWorkspace } from "./watch.ts";

function colorEnabled(stream: { isTTY?: boolean }): boolean {
  if (process.env.NO_COLOR) return false;
  const force = process.env.FORCE_COLOR;
  if (force !== undefined && force !== "" && force !== "0") return true;
  return Boolean(stream.isTTY);
}

function paint(stream: { isTTY?: boolean }, code: string, text: string): string {
  return colorEnabled(stream) ? `\u001b[${code}m${text}\u001b[0m` : text;
}

function log(message: string): void {
  console.log(`[backeneko] ${message}`);
}

function warn(message: string): void {
  console.warn(paint(process.stderr, "1;33", `[backeneko] warning: ${message}`));
}

function logError(message: string): void {
  console.error(paint(process.stderr, "1;31", `[backeneko] error: ${message}`));
}

function fail(message: string): never {
  console.error(paint(process.stderr, "1;31", `[backeneko] error: ${message}`));
  process.exit(1);
}

const LOGO = [
  "   /\\_/\\",
  "  ( =.= ) ( (",
  "  /    \\  / /",
  " (_|__|_)/_/",
].join("\n");

function printLogo(): void {
  console.log(paint(process.stdout, "36", LOGO));
  console.log("");
}

async function main(): Promise<void> {
  printLogo();

  const options = parseCliArgs();

  if (options.help) {
    printHelp();
    return;
  }

  const cwd = process.cwd();
  const targetDir = path.resolve(cwd, options.dir);
  const schemaPath = path.join(targetDir, "schema.graphql");

  if (options.source) {
    await generateFromSource(path.resolve(cwd, options.source), targetDir);
  } else if (!existsSync(targetDir)) {
    printHelp();
    fail(`--source is required when ${options.dir} does not exist`);
  } else {
    log(`serving existing ${options.dir} as-is (no --source, schema not regenerated)`);
    await ensureWorkspaceTsconfig(targetDir);
  }

  if (!existsSync(schemaPath)) {
    fail(`no schema found at ${path.relative(cwd, schemaPath)}`);
  }

  await loadSchema(schemaPath);
  runtime.modules = await loadMockModules(targetDir);
  await logSummary(targetDir);

  const server = startServer(options.port, { validate: options.validate });
  log(`mock GraphQL backend on http://localhost:${server.port}/graphql`);
  if (!options.validate) warn("query validation disabled");
  log(`hot reload watching ${path.relative(cwd, targetDir)}`);

  watchWorkspace(targetDir, async (changed) => {
    const rel = changed.map((file) => path.relative(cwd, path.join(targetDir, file))).join(", ");
    if (changed.some((file) => path.basename(file) === "schema.graphql")) {
      try {
        await loadSchema(schemaPath);
        log(`schema reloaded (${rel})`);
      } catch (error) {
        console.error(
          paint(
            process.stderr,
            "1;31",
            `[backeneko] schema reload failed: ${error instanceof Error ? error.message : error}`,
          ),
        );
      }
    }
    const previous = runtime.modules;
    runtime.modules = await loadMockModules(targetDir, previous);
    log(`mocks reloaded (${rel})`);
  });

  process.on("SIGINT", () => {
    server.stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    server.stop();
    process.exit(0);
  });
}

async function generateFromSource(sourceDir: string, targetDir: string): Promise<void> {
  if (!existsSync(sourceDir)) {
    fail(`source directory not found: ${sourceDir}`);
  }

  const files = await collectSchemaFiles(sourceDir);
  if (files.length === 0) {
    fail(`no .graphql/.gql files found in ${sourceDir}`);
  }

  const merged = mergeSchemaDocuments(files);
  for (const error of merged.errors) logError(error);
  if (merged.skippedExecutables.length > 0) {
    log(`ignored ${merged.skippedExecutables.length} executable definition(s) (queries/fragments are not part of the schema)`);
    for (const entry of merged.skippedExecutables) warn(`skipped ${entry}`);
  }

  const compiled = compileDocument(merged.document);
  for (const entry of compiled.skipped) warn(`skipped "${entry.name}": ${entry.reason}`);
  for (const warning of compiled.warnings) warn(warning);

  const sdl = renderSdl(
    compiled.document,
    files.map((file) => file.relativePath),
    compiled.skipped,
  );
  const result = await generateWorkspace({ targetDir, sdl });

  for (const warning of result.warnings) warn(warning);
  log(`collected ${files.length} schema file(s) from ${sourceDir}`);
  log(`generated ${path.basename(result.schemaPath)}`);
  log(
    `${GENERATED_DIR}/: ${result.created.length} created, ${result.updated.length} updated, ` +
      `${result.unchanged.length} unchanged, ${result.removed.length} removed`,
  );
  if (result.removed.length > 0) log(`pruned ${result.removed.join(", ")}`);
  log(`${OVERRIDE_DIR}/ is never written`);
}

async function logSummary(targetDir: string): Promise<void> {
  const { entities, root } = runtime.modules;
  const parts = [`${entities.size} entit${entities.size === 1 ? "y" : "ies"}`];
  for (const [typeName, resolvers] of root) {
    parts.push(`${resolvers.size} ${typeName.toLowerCase()} resolver(s)`);
  }
  log(`loaded ${parts.join(", ")} from ${path.relative(process.cwd(), targetDir)}`);

  const overrides = await countFiles(path.join(targetDir, OVERRIDE_DIR));
  if (overrides > 0) {
    log(`${overrides} override file(s) in ${path.relative(process.cwd(), path.join(targetDir, OVERRIDE_DIR))}`);
  }
}

async function countFiles(directory: string): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  let count = 0;
  for (const entry of entries) {
    if (entry.isDirectory()) count += await countFiles(path.join(directory, entry.name));
    else count += 1;
  }
  return count;
}

async function loadSchema(schemaPath: string): Promise<void> {
  const sdl = await readFile(schemaPath, "utf8");
  runtime.schema = buildExecutableSchema(sdl);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
