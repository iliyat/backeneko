import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

const SCHEMA_EXTENSIONS = new Set([".graphql", ".gql"]);
const IGNORED_DIRECTORIES = new Set(["node_modules", ".git", "dist"]);

// Watches only what `collectSchemaFiles` could read: the final segment must be
// a schema file, and no directory on the way may be one the walker skips
// (`.git`, `node_modules`, `dist`, hidden dirs). Without the extension check
// editor temporaries (`schema.graphql~`, `.swp`) would trigger regeneration.
export function isIgnoredSourcePath(relativePath: string): boolean {
  const segments = relativePath.split(/[\\/]/);
  const file = segments[segments.length - 1];
  if (!file || !SCHEMA_EXTENSIONS.has(path.extname(file))) return true;
  for (const segment of segments.slice(0, -1)) {
    if (segment.startsWith(".") || IGNORED_DIRECTORIES.has(segment)) return true;
  }
  return false;
}

export interface SchemaSourceFile {
  absolutePath: string;
  relativePath: string;
  content: string;
}

export async function collectSchemaFiles(root: string): Promise<SchemaSourceFile[]> {
  const files: SchemaSourceFile[] = [];

  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") || IGNORED_DIRECTORIES.has(entry.name)) continue;
        await walk(path.join(dir, entry.name), relative + "/");
        continue;
      }
      if (!entry.isFile() || !SCHEMA_EXTENSIONS.has(path.extname(entry.name))) continue;
      const absolutePath = path.join(dir, entry.name);
      files.push({
        absolutePath,
        relativePath: relative,
        content: await readFile(absolutePath, "utf8"),
      });
    }
  }

  await walk(root, "");
  return files;
}
