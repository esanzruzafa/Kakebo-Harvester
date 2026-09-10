import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ciWorkflowPath = fileURLToPath(
  new URL("../../.github/workflows/ci.yml", import.meta.url)
);

describe("application validation workflow", () => {
  it("runs the same dependency audit and portable build required for a release", async () => {
    const workflow = await readFile(ciWorkflowPath, "utf8");

    expect(workflow).toContain("npm run audit:all");
    expect(workflow).toContain("npm run desktop:dist");
    expect(workflow).toContain('"vitest.config.mjs"');
  });
});
