import { describe, expect, it } from "vitest";
import { getSyncWindow } from "../../src/sync/sync-window.js";

describe("transaction synchronization window", () => {
  it("anchors the default lookback to an explicit end date", () => {
    expect(getSyncWindow(30, undefined, "2020-02-15")).toEqual({
      dateFrom: "2020-01-16",
      dateTo: "2020-02-15"
    });
  });
});
