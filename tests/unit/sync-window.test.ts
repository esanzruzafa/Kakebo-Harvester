import { describe, expect, it } from "vitest";
import { getSyncWindow } from "../../src/sync/sync-window.js";

describe("transaction synchronization window", () => {
  it("anchors the default lookback to an explicit end date", () => {
    expect(getSyncWindow(30, undefined, "2020-02-15")).toEqual({
      dateFrom: "2020-01-16",
      dateTo: "2020-02-15"
    });
  });

  it("keeps an explicit end date stable when deriving its lookback", () => {
    expect(getSyncWindow(1, undefined, "2026-01-01")).toEqual({
      dateFrom: "2025-12-31",
      dateTo: "2026-01-01"
    });
  });
});
