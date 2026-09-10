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

  it("exposes the GitHub token only while publishing the release", async () => {
    const workflow = await readFile(releaseWorkflowPath, "utf8");

    expect(workflow).toMatch(
      /- name: Create GitHub Release\r?\n[\s\S]*?env:\r?\n\s+GH_TOKEN:/u
    );
    expect(workflow).not.toMatch(/^ {6}GH_TOKEN:/mu);
  });
});
