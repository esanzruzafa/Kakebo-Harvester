import { describe, expect, it } from "vitest";
import { kutxabankPeriodDates } from "../../src/desktop/kutxabank-period.js";

describe("Kutxabank movement periods", () => {
  it("matches the five selectable periods with inclusive calendar ranges", () => {
    const custom = { dateFrom: "2026-09-01", dateTo: "2026-09-20" };
    expect(kutxabankPeriodDates("today", "2026-09-22", custom)).toEqual({ dateFrom: "2026-09-22", dateTo: "2026-09-22" });
    expect(kutxabankPeriodDates("week", "2026-09-22", custom)).toEqual({ dateFrom: "2026-09-16", dateTo: "2026-09-22" });
    expect(kutxabankPeriodDates("fifteen-days", "2026-09-22", custom)).toEqual({ dateFrom: "2026-09-08", dateTo: "2026-09-22" });
    expect(kutxabankPeriodDates("month", "2026-09-22", custom)).toEqual({ dateFrom: "2026-08-22", dateTo: "2026-09-22" });
    expect(kutxabankPeriodDates("between", "2026-09-22", custom)).toEqual(custom);
  });

  it("clamps month ends without rolling into the following month", () => {
    expect(kutxabankPeriodDates("month", "2026-03-31", { dateFrom: "", dateTo: "" }))
      .toEqual({ dateFrom: "2026-02-28", dateTo: "2026-03-31" });
  });
});
