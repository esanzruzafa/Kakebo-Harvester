import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const releaseWorkflowPath = fileURLToPath(
  new URL("../../.github/workflows/release.yml", import.meta.url)
);

describe("release workflow", () => {
  it("publishes release assets atomically without overwriting existing releases", async () => {
    const workflow = await readFile(releaseWorkflowPath, "utf8");

    expect(workflow).not.toContain("--clobber");
    expect(workflow).toContain("refusing to overwrite it");
    expect(workflow).toMatch(
      /gh release create \$env:RELEASE_TAG `\r?\n\s+\$executable/u
    );
  });
});
