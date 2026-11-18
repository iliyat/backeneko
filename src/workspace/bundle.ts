import { existsSync } from "node:fs";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const MODULE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs"]);

export interface BundleOptions {
  tsconfig?: string;
  // Cache key; bundles under different keys never prune each other.
  key?: string;
}

export async function moduleFiles(directory: string) {
  const entries = await readdir(directory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && MODULE_EXTENSIONS.has(path.extname(entry.name)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function contentHash(content: string): string {
  const hasher = new Bun.CryptoHasher("sha1");
  hasher.update(content);
  return hasher.digest("hex").slice(0, 16);
}

export async function importBundledModule(
  filePath: string,
  bundleRoot: string,
  options: BundleOptions = {},
): Promise<Record<string, unknown>> {
  const build = await Bun.build({
    entrypoints: [filePath],
    target: "bun",
    sourcemap: "none",
    ...(options.tsconfig ? { tsconfig: options.tsconfig } : {}),
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
  const key = options.key ?? name;
  const bundleDir = path.join(bundleRoot, `${key}-${contentHash(code)}`);
  const cachePath = path.join(bundleDir, `${name}.mjs`);
  if (!existsSync(cachePath)) {
    await mkdir(bundleDir, { recursive: true });
    await writeFile(cachePath, code, "utf8");
    await pruneStaleBundles(key, bundleDir, bundleRoot);
  }

  return (await import(pathToFileURL(cachePath).href)) as Record<string, unknown>;
}

async function pruneStaleBundles(key: string, keepDir: string, bundleRoot: string): Promise<void> {
  const prefix = `${key}-`;
  const entries = await readdir(bundleRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const fullPath = path.join(bundleRoot, entry.name);
    if (fullPath === keepDir) continue;
    await rm(fullPath, { recursive: true, force: true });
  }
}
