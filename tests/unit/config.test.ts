import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isRedirectUrlAllowed,
  resolveEnvironmentFile
} from "../../src/config.js";
import { ConfigurationError } from "../../src/errors.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("environment file selection", () => {
  it("automatically selects the only environment file", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-config-"));
    const sandboxPath = join(root, ".env.sandbox");
    await writeFile(sandboxPath, "APP_ENV=sandbox\n");

    expect(resolveEnvironmentFile(undefined, root)).toBe(sandboxPath);
  });

  it("requires an explicit choice when both environments exist", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-config-"));
    await Promise.all([
      writeFile(join(root, ".env.sandbox"), "APP_ENV=sandbox\n"),
      writeFile(join(root, ".env.production"), "APP_ENV=production\n")
    ]);

    expect(() => resolveEnvironmentFile(undefined, root)).toThrow(ConfigurationError);
  });
});

describe("redirect URL isolation", () => {
  it("keeps sandbox callbacks on the local loopback server", () => {
    expect(
      isRedirectUrlAllowed("sandbox", "http://localhost:8000/callback")
    ).toBe(true);
    expect(
      isRedirectUrlAllowed("sandbox", "https://example.com/callback")
    ).toBe(false);
  });

  it("requires an HTTPS loopback callback in production", () => {
    expect(
      isRedirectUrlAllowed("production", "https://localhost:8000/callback")
    ).toBe(true);
    expect(
      isRedirectUrlAllowed("production", "http://localhost:8000/callback")
    ).toBe(false);
    expect(
      isRedirectUrlAllowed("production", "https://example.com/callback")
    ).toBe(false);
  });
});
