import { describe, expect, test } from "bun:test";
import {
  DEFAULT_PORT,
  DEFAULT_PROXY_TIMEOUT_MS,
  DEFAULT_WORKSPACE_DIR,
  parseCliArgs,
} from "../src/args.ts";

describe("parseCliArgs", () => {
  test("uses defaults", () => {
    expect(parseCliArgs([])).toEqual({
      source: null,
      port: DEFAULT_PORT,
      dir: DEFAULT_WORKSPACE_DIR,
      validate: true,
      proxyTo: null,
      proxyTimeout: DEFAULT_PROXY_TIMEOUT_MS,
      help: false,
    });
  });

  test("parses every supported option", () => {
    expect(
      parseCliArgs([
        "--source=schemas",
        "--port=5000",
        "--dir=workspace",
        "--no-validate",
        "--proxy-to=https://api.example.com/graphql",
        "--proxy-timeout=1500",
      ]),
    ).toEqual({
      source: "schemas",
      port: 5000,
      dir: "workspace",
      validate: false,
      proxyTo: "https://api.example.com/graphql",
      proxyTimeout: 1500,
      help: false,
    });
  });

  test("accepts space-separated values", () => {
    const options = parseCliArgs(["--source", "schemas", "--port", "5000"]);
    expect(options.source).toBe("schemas");
    expect(options.port).toBe(5000);
  });

  test("parses the help flag without exiting", () => {
    expect(parseCliArgs(["-h"]).help).toBe(true);
    expect(parseCliArgs(["--help"]).help).toBe(true);
  });

  test("rejects an invalid port", () => {
    expect(() => parseCliArgs(["--port=0"])).toThrow("invalid --port value: 0");
    expect(() => parseCliArgs(["--port=70000"])).toThrow("invalid --port value: 70000");
    expect(() => parseCliArgs(["--port=abc"])).toThrow("invalid --port value: abc");
  });

  test("rejects an invalid proxy timeout", () => {
    expect(() => parseCliArgs(["--proxy-timeout=0"])).toThrow(
      "invalid --proxy-timeout value: 0",
    );
  });

  test("rejects an invalid proxy target", () => {
    expect(() => parseCliArgs(["--proxy-to=not-a-url"])).toThrow(
      "invalid --proxy-to value: not-a-url",
    );
    expect(() => parseCliArgs(["--proxy-to=ftp://example.com"])).toThrow(
      "--proxy-to must be an http(s) URL: ftp://example.com",
    );
  });

  test("rejects unknown options", () => {
    expect(() => parseCliArgs(["--unknown"])).toThrow("unknown option '--unknown'");
  });
});
