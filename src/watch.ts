import { watch, type FSWatcher } from "node:fs";
import { BUNDLE_DIR } from "./mocks.ts";

const DEBOUNCE_MS = 150;

export function watchWorkspace(
  dir: string,
  onChange: (changedFiles: string[]) => void,
): FSWatcher {
  const pending = new Set<string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const watcher = watch(dir, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const relative = filename.toString();
    if (relative.split(/[\\/]/)[0] === BUNDLE_DIR) return;

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
