import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  isApiBaseUrlAllowed,
  isAppBaseUrlAllowed,
  isRedirectUrlAllowed,
  isSafeDataLayout,
  isValidSessionEncryptionKey,
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

  it("prefers an environment file in the private directory", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-config-"));
    const privateDirectory = join(root, "private");
    const privatePath = join(privateDirectory, ".env.production");
    await mkdir(privateDirectory);
    await Promise.all([
      writeFile(privatePath, "APP_ENV=production\n"),
      writeFile(join(root, ".env.production"), "APP_ENV=production\n")
    ]);

    expect(resolveEnvironmentFile(undefined, root)).toBe(privatePath);
  });

  it("requires an explicit choice when both environments exist", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-config-"));
    await Promise.all([
      writeFile(join(root, ".env.sandbox"), "APP_ENV=sandbox\n"),
      writeFile(join(root, ".env.production"), "APP_ENV=production\n")
    ]);

    expect(() => resolveEnvironmentFile(undefined, root)).toThrow(ConfigurationError);
  });

  it("rejects a missing explicitly selected environment file", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-config-"));

    expect(() => resolveEnvironmentFile("private/.env.production", root)).toThrow(
      ConfigurationError
    );
  });
});

describe("security-sensitive environment values", () => {
  it("accepts only canonical 32-byte base64 encryption keys", () => {
    const valid = Buffer.alloc(32, 7).toString("base64");
    expect(isValidSessionEncryptionKey(valid)).toBe(true);
    expect(isValidSessionEncryptionKey(`${valid}\n`)).toBe(false);
    expect(isValidSessionEncryptionKey(valid.replace(/=$/u, ""))).toBe(false);
    expect(isValidSessionEncryptionKey(Buffer.alloc(31, 7).toString("base64"))).toBe(
      false
    );
    expect(isValidSessionEncryptionKey("!".repeat(44))).toBe(false);
  });

  it("requires a credential-free HTTPS provider base URL", () => {
    expect(isApiBaseUrlAllowed("https://api.enablebanking.com")).toBe(true);
    expect(isApiBaseUrlAllowed("https://api.example.com/v1/")).toBe(true);
    expect(isApiBaseUrlAllowed("http://api.enablebanking.com")).toBe(false);
    expect(isApiBaseUrlAllowed("https://user:secret@example.com")).toBe(false);
    expect(isApiBaseUrlAllowed("https://example.com?token=secret")).toBe(false);
    expect(isApiBaseUrlAllowed("https://example.com/#fragment")).toBe(false);
  });

  it("requires raw data and exports to be safe siblings of the database", () => {
    const dataRoot = join("C:\\", "Kakebo", "data", "production");
    expect(
      isSafeDataLayout(
        join(dataRoot, "kakebo-production.sqlite"),
        join(dataRoot, "raw"),
        join(dataRoot, "exports")
      )
    ).toBe(true);
    expect(
      isSafeDataLayout(
        join(dataRoot, "kakebo-production.sqlite"),
        dataRoot,
        join(dataRoot, "exports")
      )
    ).toBe(false);
    expect(
      isSafeDataLayout(
        join(dataRoot, "kakebo-production.sqlite"),
        join(dataRoot, "raw"),
        join(dataRoot, "raw")
      )
    ).toBe(false);
    expect(
      isSafeDataLayout(
        join(dataRoot, "kakebo-production.sqlite"),
        join(dataRoot, "raw"),
        join(dataRoot, "nested", "exports")
      )
    ).toBe(false);
    expect(
      isSafeDataLayout(
        join(dataRoot, "kakebo-production.sqlite"),
        join(dataRoot, "documents"),
        join(dataRoot, "exports")
      )
    ).toBe(false);
    expect(
      isSafeDataLayout(
        join(dataRoot, "kakebo-production.sqlite"),
        join(dataRoot, "raw"),
        join(dataRoot, "backups")
      )
    ).toBe(false);
  });
});

describe("redirect URL isolation", () => {
  it("keeps sandbox callbacks on the local loopback server", () => {
    expect(
      isRedirectUrlAllowed("sandbox", "http://localhost:8000/callback", 8_000)
    ).toBe(true);
    expect(
      isRedirectUrlAllowed("sandbox", "https://example.com/callback", 8_000)
    ).toBe(false);
  });

  it("requires an HTTPS loopback callback in production", () => {
    expect(
      isRedirectUrlAllowed(
        "production",
        "https://localhost:8000/callback",
        8_000
      )
    ).toBe(true);
    expect(
      isRedirectUrlAllowed(
        "production",
        "http://localhost:8000/callback",
        8_000
      )
    ).toBe(false);
    expect(
      isRedirectUrlAllowed(
        "production",
        "https://example.com/callback",
        8_000
      )
    ).toBe(false);
  });

  it("matches the exact listener host, port, and callback path", () => {
    for (const invalid of [
      "https://127.0.0.1:8000/callback",
      "https://localhost:9000/callback",
      "https://localhost:8000/other",
      "https://localhost:8000/callback?unexpected=true"
    ]) {
      expect(isRedirectUrlAllowed("production", invalid, 8_000)).toBe(false);
    }
    expect(
      isRedirectUrlAllowed(
        "production",
        "https://localhost:8443/callback",
        8_443
      )
    ).toBe(true);
  });

  it("matches APP_BASE_URL to the same local listener", () => {
    expect(
      isAppBaseUrlAllowed("production", "https://localhost:8000", 8_000)
    ).toBe(true);
    expect(
      isAppBaseUrlAllowed("production", "https://localhost:9000", 8_000)
    ).toBe(false);
    expect(
      isAppBaseUrlAllowed("sandbox", "https://localhost:8000", 8_000)
    ).toBe(false);
  });
});
