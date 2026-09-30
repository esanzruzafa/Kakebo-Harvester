import { describe, expect, it, vi } from "vitest";
import { readKutxabankHistory, type KutxabankHistoryPage } from "../../src/cards/kutxabank-history.js";

const query = { productKey: "synthetic-local-product", dateFrom: "2026-08-01", dateTo: "2026-09-15" };
const headers = ["Fecha", "Concepto", "Fecha imputación", "Importe", "Situación"];
function page(amount: string, hasNext = false, hasPrevious = false): KutxabankHistoryPage {
  return { ...query, state: "table", hasNext, hasPrevious, table: { headers, rows: [
    ["01/09/2026", "SYNTHETIC PURCHASE", "01/09/2026", amount, ""]
  ] } };
}

describe("Kutxabank history traversal", () => {
  it("collects the final short page and returns the same complete result on repetition", async () => {
    const first = vi.fn().mockResolvedValue(page("-1,00 €", true));
    const next = vi.fn().mockResolvedValue(page("-2,00 €", false, true));
    const result = await readKutxabankHistory({ first, next }, query);
    expect(result.map(row => row.amount)).toEqual(["-1", "-2"]);
    expect(await readKutxabankHistory({ first, next }, query)).toEqual(result);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it.each(["authorization-required", "session-expired", "loading"] as const)(
    "does not return partial history when the next page is %s", async state => {
      const reader = { first: vi.fn().mockResolvedValue(page("-1,00 €", true)),
        next: vi.fn().mockResolvedValue({ state }) };
      await expect(readKutxabankHistory(reader, query)).rejects.toThrow();
      expect(reader.next).toHaveBeenCalledTimes(1);
    }
  );

  it("stops on repeated page content rather than looping or duplicating it", async () => {
    const reader = { first: vi.fn().mockResolvedValue(page("-1,00 €", true)),
      next: vi.fn().mockResolvedValue(page("-1,00 €", true, true)) };
    await expect(readKutxabankHistory(reader, query)).rejects.toThrow("INCOMPLETE_PAGE");
    expect(reader.next).toHaveBeenCalledTimes(1);
  });

  it.each([
    { productKey: "another-product" }, { dateFrom: "2026-07-01" }, { dateTo: "2026-09-30" }
  ])("rejects a changed product or effective query", async changed => {
    const reader = { first: vi.fn().mockResolvedValue({ ...page("-1,00 €"), ...changed }), next: vi.fn() };
    await expect(readKutxabankHistory(reader, query)).rejects.toThrow("QUERY_CHANGED");
  });

  it("rejects movement dates outside the requested interval", async () => {
    const reader = { first: vi.fn().mockResolvedValue({ ...query, state: "table", hasNext: false,
      hasPrevious: false, table: { headers, rows: [["16/09/2026", "TEST", "16/09/2026", "1,00 €", ""]] } }), next: vi.fn() };
    await expect(readKutxabankHistory(reader, query)).rejects.toThrow("QUERY_CHANGED");
  });

  it("bounds page requests and validates date order before opening the source", async () => {
    const reader = { first: vi.fn().mockResolvedValue(page("1,00 €", true)), next: vi.fn() };
    await expect(readKutxabankHistory(reader, query, { maxPages: 1 })).rejects.toThrow("INCOMPLETE_PAGE");
    expect(reader.next).not.toHaveBeenCalled();
    reader.first.mockClear();
    await expect(readKutxabankHistory(reader, { ...query, dateTo: "2026-07-31" })).rejects.toThrow();
    expect(reader.first).not.toHaveBeenCalled();
  });

  it("honors cancellation before making another page request", async () => {
    const controller = new AbortController();
    const reader = { first: vi.fn().mockImplementation(() => {
      controller.abort(); return Promise.resolve(page("1,00 €", true));
    }), next: vi.fn() };
    await expect(readKutxabankHistory(reader, query, { signal: controller.signal })).rejects.toThrow("CANCELLED");
    expect(reader.next).not.toHaveBeenCalled();
  });

  it("does not expose browser error contents", async () => {
    const reader = { first: vi.fn().mockRejectedValue(new Error("SECRET URL AND COOKIE")), next: vi.fn() };
    await expect(readKutxabankHistory(reader, query)).rejects.toThrow("SOURCE_UNAVAILABLE");
    await expect(readKutxabankHistory(reader, query)).rejects.not.toThrow("SECRET");
  });

  it("rejects a stale last page when restarting the same query", async () => {
    const reader = { first: vi.fn().mockResolvedValue(page("1,00 €", false, true)), next: vi.fn() };
    await expect(readKutxabankHistory(reader, query)).rejects.toThrow("INCOMPLETE_PAGE");
  });

  it("does not accept an empty response after a non-final page as completed history", async () => {
    const reader = { first: vi.fn().mockResolvedValue(page("1,00 €", true)), next: vi.fn().mockResolvedValue({
      ...query, state: "table", hasNext: false, hasPrevious: true, table: { headers, rows: [] }
    }) };
    await expect(readKutxabankHistory(reader, query)).rejects.toThrow("INCOMPLETE_PAGE");
  });
});
