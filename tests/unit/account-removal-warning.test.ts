import { describe, expect, it } from "vitest";
import { formatRawCleanupWarnings } from "../../src/desktop/account-removal-warning.js";

describe("account removal warnings", () => {
  it("describes every retained raw-data cleanup reason", () => {
    const result = formatRawCleanupWarnings(
      ["shared", "outside-root", "symbolic-link"],
      (key, fallback) => `${key}:${fallback}`
    );

    expect(result).toContain("warning.rawCleanup.shared:");
    expect(result).toContain("warning.rawCleanup.outsideRoot:");
    expect(result).toContain("warning.rawCleanup.symbolicLink:");
  });
});
