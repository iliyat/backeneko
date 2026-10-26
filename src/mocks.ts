import { existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ENTITY_DIR,
  GENERATED_DIR,
  OVERRIDE_DIR,
  ROOT_DIRS,
  TSCONFIG_FILE,
  ensureWorkspaceTsconfig,
} from "./generate.ts";

export type MockModule = Record<string, unknown>;

export interface MockModules {
  entities: Map<string, MockModule>;
  root: Map<string, Map<string, MockModule>>;
  // Root fields that come from a user-owned `override/<kind>/` file. Only these
  // are treated as "handled locally" when requests are proxied.
  overriddenRoot: Map<string, Set<string>>;
}

// Bundles live inside the workspace, not in the OS temp dir; `watch.ts` skips
// this directory so writing a bundle never triggers a reload.
export const BUNDLE_DIR = "cache";
const MODULE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs"]);

// Where mock files are looked up, most specific first: user overrides, then the
// generated mirror.
const LAYOUTS = [OVERRIDE_DIR, GENERATED_DIR] as const;

export type MockLayout = (typeof LAYOUTS)[number];

export interface ResolvedMockFile {
  file: string;
  layout: MockLayout;
}

function contentHash(content: string): string {
  const hasher = new Bun.CryptoHasher("sha1");
  hasher.update(content);
  return hasher.digest("hex").slice(0, 16);
}

async function importMockModule(
  filePath: string,
  bundleRoot: string,
  tsconfig?: string,
): Promise<MockModule> {
  const build = await Bun.build({
    entrypoints: [filePath],
    target: "bun",
    sourcemap: "none",
    ...(tsconfig ? { tsconfig } : {}),
  });
  if (!build.success) {
    throw new Error(build.logs.map((log) => String(log)).join("\n"));
  }
  const output = build.outputs[0];
  if (!output) throw new Error("empty build output");

  const code = await output.text();
  // Two Bun constraints force this layout:
  //  - a `data:` URL breaks once the module gets large (`NameTooLong`);
  //  - a file created in a directory that was already imported from is never
  //    found, so every bundle gets its own content-hashed directory. Changed
  //    modules land in a new directory and are re-imported; unchanged ones are
  //    served from Bun's module cache.
  const name = path.basename(filePath, path.extname(filePath));
  const bundleDir = path.join(bundleRoot, `${name}-${contentHash(code)}`);
  const cachePath = path.join(bundleDir, `${name}.mjs`);
  if (!existsSync(cachePath)) {
    await mkdir(bundleDir, { recursive: true });
    await writeFile(cachePath, code, "utf8");
    await pruneStaleBundles(name, bundleDir, bundleRoot);
  }

  return (await import(pathToFileURL(cachePath).href)) as MockModule;
}

async function pruneStaleBundles(name: string, keepDir: string, bundleRoot: string): Promise<void> {
  const prefix = `${name}-`;
  const entries = await readdir(bundleRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const fullPath = path.join(bundleRoot, entry.name);
    if (fullPath === keepDir) continue;
    await rm(fullPath, { recursive: true, force: true });
  }
}

export function emptyMockModules(): MockModules {
  return { entities: new Map(), root: new Map(), overriddenRoot: new Map() };
}

export async function loadMockModules(dir: string, previous?: MockModules): Promise<MockModules> {
  const modules = emptyMockModules();
  const bundleRoot = path.join(dir, BUNDLE_DIR);
  const tsconfigFile = path.join(dir, TSCONFIG_FILE);
  if (!existsSync(tsconfigFile)) await ensureWorkspaceTsconfig(dir);
  const tsconfig = existsSync(tsconfigFile) ? tsconfigFile : undefined;

  await loadFiles(
    await resolveMockFiles(dir, ENTITY_DIR),
    bundleRoot,
    modules.entities,
    previous?.entities,
    tsconfig,
  );

  for (const [typeName, folder] of Object.entries(ROOT_DIRS)) {
    const resolvers = new Map<string, MockModule>();
    const files = await resolveMockFiles(dir, folder);
    await loadFiles(files, bundleRoot, resolvers, previous?.root.get(typeName), tsconfig);
    if (resolvers.size > 0) modules.root.set(typeName, resolvers);

    const overridden = new Set<string>();
    for (const [fieldName, entry] of files) {
      if (entry.layout === OVERRIDE_DIR) overridden.add(fieldName);
    }
    if (overridden.size > 0) modules.overriddenRoot.set(typeName, overridden);
  }

  return modules;
}

// Resolves the file to load for every key, override-first: an `override/` file
// hides the `generated/` one of the same name.
async function resolveMockFiles(dir: string, folder: string): Promise<Map<string, ResolvedMockFile>> {
  const files = new Map<string, ResolvedMockFile>();

  for (const layout of LAYOUTS) {
    const directory = path.join(dir, layout, folder);
    if (!existsSync(directory)) continue;
    for (const entry of await moduleFiles(directory)) {
      const key = path.basename(entry.name, path.extname(entry.name));
      if (files.has(key)) continue;
      files.set(key, { file: path.join(directory, entry.name), layout });
    }
  }

  return files;
}

async function loadFiles(
  files: Map<string, ResolvedMockFile>,
  bundleRoot: string,
  target: Map<string, MockModule>,
  previous: Map<string, MockModule> | undefined,
  tsconfig?: string,
): Promise<void> {
  for (const [key, entry] of files) {
    try {
      target.set(key, await importMockModule(entry.file, bundleRoot, tsconfig));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(
        `[backeneko] failed to load ${path.relative(process.cwd(), entry.file)}: ${message}`,
      );
      const fallback = previous?.get(key);
      if (fallback) target.set(key, fallback);
    }
  }
}

async function moduleFiles(directory: string) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && MODULE_EXTENSIONS.has(path.extname(entry.name)))
    .sort((a, b) => a.name.localeCompare(b.name));
}
