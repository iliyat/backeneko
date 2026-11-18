import { existsSync } from "node:fs";
import path from "node:path";
import { importBundledModule, moduleFiles } from "./bundle.ts";
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

// Where mock files are looked up, most specific first: user overrides, then the
// generated mirror.
const LAYOUTS = [OVERRIDE_DIR, GENERATED_DIR] as const;

export type MockLayout = (typeof LAYOUTS)[number];

export interface ResolvedMockFile {
  file: string;
  layout: MockLayout;
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
      target.set(key, await importBundledModule(entry.file, bundleRoot, { tsconfig }));
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
