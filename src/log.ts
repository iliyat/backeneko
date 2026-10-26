function colorEnabled(stream: { isTTY?: boolean }): boolean {
  if (process.env.NO_COLOR) return false;
  const force = process.env.FORCE_COLOR;
  if (force !== undefined && force !== "" && force !== "0") return true;
  return Boolean(stream.isTTY);
}

export function paint(stream: { isTTY?: boolean }, code: string, text: string): string {
  return colorEnabled(stream) ? `\u001b[${code}m${text}\u001b[0m` : text;
}

export function log(message: string): void {
  console.log(`[backeneko] ${message}`);
}

export function warn(message: string): void {
  console.warn(paint(process.stderr, "1;33", `[backeneko] warning: ${message}`));
}

export function logError(message: string): void {
  console.error(paint(process.stderr, "1;31", `[backeneko] error: ${message}`));
}
