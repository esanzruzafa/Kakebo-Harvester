import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("local HTTPS setup script", () => {
  it("commits the replacement before best-effort cleanup of the previous trusted CA", async () => {
    const script = await readFile("scripts/setup-local-https.ps1", "utf8");
    const commit = script.indexOf("$setupCompleted = $true");
    const previousCaCleanup = script.indexOf(
      "$previousTrustedCertificate =",
      commit
    );

    expect(commit).toBeGreaterThan(-1);
    expect(previousCaCleanup).toBeGreaterThan(commit);
    expect(script.slice(previousCaCleanup)).toContain("Write-Warning");
  });
});
