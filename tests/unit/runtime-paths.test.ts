import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runtimeRootDirectory } from "../../src/desktop/runtime-paths.js";

describe("desktop runtime paths", () => {
  it("uses the parent of private as the application folder", () => {
    const root = resolve("portable-root");

    expect(
      runtimeRootDirectory(join(root, "private", ".env.production"))
    ).toBe(root);
  });

  it("keeps the environment-file directory for the legacy root layout", () => {
    const root = resolve("legacy-root");

    expect(runtimeRootDirectory(join(root, ".env.production"))).toBe(root);
  });
});
