import { watch, type FSWatcher } from "node:fs";
import { BUNDLE_DIR } from "./mocks.ts";

const DEBOUNCE_MS = 150;

export interface WatchOptions {
  // Decides which events are dropped before batching; receives the path as
  // reported by fs.watch (relative to the watched directory).
  ignore?: (relativePath: string) => boolean;
}

export function watchTree(
  dir: string,
  onChange: (changedFiles: string[]) => void,
  options: WatchOptions = {},
): FSWatcher {
  const ignore = options.ignore ?? ((relative: string) => relative.split(/[\\/]/)[0] === BUNDLE_DIR);
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const watcher = watch(dir, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const relative = filename.toString();
    if (ignore(relative)) return;

    pending.add(relative);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      const changed = [...pending];
      pending.clear();
      onChange(changed);
    }, DEBOUNCE_MS);
  });

  return watcher;
}
