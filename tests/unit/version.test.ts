import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { APPLICATION_VERSION } from "../../src/version.js";

describe("application version", () => {
  it("matches the root package metadata", async () => {
    const metadata = JSON.parse(await readFile("package.json", "utf8")) as {
      version: string;
    };
    expect(APPLICATION_VERSION).toBe(metadata.version);
  });
});
