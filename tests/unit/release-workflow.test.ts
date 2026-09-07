import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const releaseWorkflowPath = fileURLToPath(
  new URL("../../.github/workflows/release.yml", import.meta.url)
);

describe("release workflow", () => {
  it("does not overwrite assets of an existing release", async () => {
    const workflow = await readFile(releaseWorkflowPath, "utf8");

    expect(workflow).not.toContain("--clobber");
    expect(workflow).toContain("refusing to overwrite it");
  });
});
