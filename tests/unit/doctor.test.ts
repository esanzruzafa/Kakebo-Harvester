import { describe, expect, it } from "vitest";
import { isSupportedNodeVersion } from "../../src/doctor.js";

describe("doctor runtime requirements", () => {
  it("matches the Node.js engine floor used by the application", () => {
    expect(isSupportedNodeVersion("20.20.0")).toBe(false);
    expect(isSupportedNodeVersion("22.18.9")).toBe(false);
    expect(isSupportedNodeVersion("22.19.0")).toBe(true);
    expect(isSupportedNodeVersion("24.0.0")).toBe(true);
    expect(isSupportedNodeVersion("invalid")).toBe(false);
  });
});
