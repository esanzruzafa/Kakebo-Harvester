import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveDesktopAssetDestination,
  resolveDesktopAssetSource
} from "../../scripts/desktop-assets.mjs";

describe("desktop asset paths", () => {
  const projectRoot = resolve("project-root");

  it("accepts project inputs and dist destinations", () => {
    expect(
      resolveDesktopAssetSource(projectRoot, "src/desktop/index.html")
    ).toBe(resolve(projectRoot, "src/desktop/index.html"));
    expect(
      resolveDesktopAssetDestination(
        projectRoot,
        "dist/src/desktop/index.html"
      )
    ).toBe(resolve(projectRoot, "dist/src/desktop/index.html"));
  });

  it("rejects paths that escape their allowed roots", () => {
    expect(() =>
      resolveDesktopAssetSource(projectRoot, "../private.txt")
    ).toThrow(/outside the project/u);
    expect(() =>
      resolveDesktopAssetDestination(projectRoot, "src/desktop/index.html")
    ).toThrow(/outside dist/u);
    expect(() =>
      resolveDesktopAssetDestination(projectRoot, "../unrelated")
    ).toThrow(/outside dist/u);
  });
});
