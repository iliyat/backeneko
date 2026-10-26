#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parseCliArgs, printHelp } from "./args.ts";
import { collectSchemaFiles, isIgnoredSourcePath } from "./collect.ts";
import { compileDocument } from "./compile.ts";
import {
  GENERATED_DIR,
  OVERRIDE_DIR,
  ensureWorkspaceTsconfig,
  generateWorkspace,
  type GenerationResult,
} from "./generate.ts";
import { mergeSchemaDocuments, renderSdl } from "./merge.ts";
import { loadMockModules } from "./mocks.ts";
import { buildExecutableSchema } from "./resolvers.ts";
import { runtime } from "./runtime.ts";
import { startServer } from "./server.ts";
import { watchTree } from "./watch.ts";
import { log, logError, paint, warn } from "./log.ts";

function fail(message: string): never {
  logError(message);
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

// Generation writes into the watched workspace, so its own fs events would
// otherwise trigger a second, identical reload. Entries are consumed by the
// first event for that path and expire, so a later hand edit still reloads.
const SELF_WRITE_TTL_MS = 30_000;
const selfWrites = new Map<string, number>();

function normalized(file: string): string {
  return file.split(/[\\/]/).join("/");
}

function markSelfWrites(files: string[]): void {
  const until = Date.now() + SELF_WRITE_TTL_MS;
  for (const file of files) selfWrites.set(normalized(file), until);
}

function dropSelfWrites(files: string[]): string[] {
  const now = Date.now();
  return files.filter((file) => {
    const key = normalized(file);
    const until = selfWrites.get(key);
    if (until === undefined) return true;
    selfWrites.delete(key);
    return until <= now;
  });
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
  const sourceDir = options.source === null ? null : path.resolve(cwd, options.source);

  if (sourceDir) {
    const result = await regenerate(sourceDir, targetDir);
    if (!result) fail(`could not generate ${options.dir} from ${path.relative(cwd, sourceDir)}`);
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

  const server = startServer(options.port, {
    validate: options.validate,
    proxy: options.proxyTo
      ? { target: options.proxyTo, timeoutMs: options.proxyTimeout }
      : null,
  });
  log(`mock GraphQL backend on http://localhost:${server.port}/graphql`);
  if (options.proxyTo) logProxyMode(options.proxyTo);
  if (!options.validate) warn("query validation disabled");
  log(`hot reload watching ${path.relative(cwd, targetDir)}`);

  // One queue: regeneration, schema rebuilds and mock reloads never overlap.
  let pending: Promise<void> = Promise.resolve();
  const enqueue = (task: () => Promise<void>): void => {
    pending = pending.then(task).catch((error) => {
      logError(`reload failed: ${error instanceof Error ? error.message : error}`);
    });
  };

  const reloadSchema = async (label: string): Promise<void> => {
    try {
      await loadSchema(schemaPath);
      log(`schema reloaded (${label})`);
    } catch (error) {
      console.error(
        paint(
          process.stderr,
          "1;31",
          `[backeneko] schema reload failed: ${error instanceof Error ? error.message : error}`,
        ),
      );
    }
  };

  const reloadMocks = async (label: string): Promise<void> => {
    runtime.modules = await loadMockModules(targetDir, runtime.modules);
    log(`mocks reloaded (${label})`);
  };

  watchTree(targetDir, (changed) => {
    enqueue(async () => {
      const relevant = dropSelfWrites(changed);
      if (relevant.length === 0) return;
      const rel = relevant.map((file) => path.relative(cwd, path.join(targetDir, file))).join(", ");
      if (relevant.some((file) => path.basename(file) === "schema.graphql")) {
        await reloadSchema(rel);
      }
      await reloadMocks(rel);
    });
  });

  if (sourceDir) {
    log(`watching source ${path.relative(cwd, sourceDir)} for changes`);
    watchTree(
      sourceDir,
      (changed) => {
        enqueue(async () => {
          const rel = changed.map((file) => path.relative(cwd, path.join(sourceDir, file))).join(", ");
          log(`source changed (${rel})`);
          const result = await regenerate(sourceDir, targetDir);
          if (!result) return;

          const written = [...result.created, ...result.updated, ...result.removed];
          if (written.length === 0) {
            log("source change did not affect the schema");
            return;
          }
          markSelfWrites(written);
          if (written.includes("schema.graphql")) await reloadSchema(rel);
          await reloadMocks(rel);
        });
      },
      { ignore: isIgnoredSourcePath },
    );
  }

  process.on("SIGINT", () => {
    server.stop();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    server.stop();
    process.exit(0);
  });
}

// Rebuilds schema.graphql and generated/ from the source directory. Returns
// null (with the problem logged) instead of exiting, so a bad source state
// while watching keeps the last good workspace serving.
async function regenerate(sourceDir: string, targetDir: string): Promise<GenerationResult | null> {
  try {
    if (!existsSync(sourceDir)) {
      logError(`source directory not found: ${sourceDir}`);
      return null;
    }

    const files = await collectSchemaFiles(sourceDir);
    if (files.length === 0) {
      logError(`no .graphql/.gql files found in ${sourceDir}`);
      return null;
    }

    const merged = mergeSchemaDocuments(files);
    for (const error of merged.errors) logError(error);
    if (merged.skippedExecutables.length > 0) {
      log(
        `ignored ${merged.skippedExecutables.length} executable definition(s) (queries/fragments are not part of the schema)`,
      );
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
    return result;
  } catch (error) {
    logError(`regeneration failed: ${error instanceof Error ? error.message : error}`);
    return null;
  }
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

function logProxyMode(target: string): void {
  log(`proxy mode: forwarding to ${target}`);
  const local: string[] = [];
  for (const [typeName, fields] of runtime.modules.overriddenRoot) {
    for (const field of fields) local.push(`${typeName}.${field}`);
  }
  if (local.length > 0) {
    log(`answered locally (override present): ${local.sort().join(", ")}`);
  } else {
    log("no override/queries or override/mutations files — everything is proxied");
  }
}

async function loadSchema(schemaPath: string): Promise<void> {
  const sdl = await readFile(schemaPath, "utf8");
  runtime.schema = buildExecutableSchema(sdl);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
