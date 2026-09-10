import { describe, expect, it } from "vitest";
import {
  assertIsoDate,
  daysBeforeIso,
  monthsAgoIso,
  todayIso
} from "../../src/utils/dates.js";

describe("desktop date defaults", () => {
  it("uses local calendar dates", () => {
    expect(todayIso(new Date(2026, 6, 26, 23, 59, 59))).toBe("2026-07-26");
  });

  it("subtracts three calendar months and clamps the day", () => {
    expect(monthsAgoIso(3, new Date(2026, 6, 31, 12))).toBe("2026-04-30");
    expect(monthsAgoIso(3, new Date(2026, 6, 26, 12))).toBe("2026-04-26");
  });

  it("subtracts days from ISO dates without using the local timezone", () => {
    expect(daysBeforeIso("2026-01-01", 1)).toBe("2025-12-31");
    expect(daysBeforeIso("2026-03-01", 1)).toBe("2026-02-28");
    expect(daysBeforeIso("2028-03-01", 1)).toBe("2028-02-29");
  });

  it("rejects ISO-shaped dates that are not calendar dates", () => {
    expect(() => assertIsoDate("2026-02-29", "--from")).toThrow();
    expect(() => assertIsoDate("2026-02-31", "--from")).toThrow();
    expect(assertIsoDate("2028-02-29", "--from")).toBe("2028-02-29");
  });
});
