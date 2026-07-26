import { describe, expect, it } from "vitest";
import { monthsAgoIso, todayIso } from "../../src/utils/dates.js";

describe("desktop date defaults", () => {
  it("uses local calendar dates", () => {
    expect(todayIso(new Date(2026, 6, 26, 23, 59, 59))).toBe("2026-07-26");
  });

  it("subtracts three calendar months and clamps the day", () => {
    expect(monthsAgoIso(3, new Date(2026, 6, 31, 12))).toBe("2026-04-30");
    expect(monthsAgoIso(3, new Date(2026, 6, 26, 12))).toBe("2026-04-26");
  });
});
