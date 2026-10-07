import { describe, expect, it } from "vitest";
import { parseKutxabankTable } from "../../src/cards/kutxabank-table.js";

const headers = ["Fecha", "Concepto", "Fecha imputación", "Importe", "Situación"];
const purchase = ["05/08/2026", "COMERCIO SINTÉTICO", "06/08/2026", "-1.234,50 €", ""];

describe("Kutxabank observed table format", () => {
  it("preserves legitimate identical purchases and exact decimal amounts", () => {
    const result = parseKutxabankTable({ headers, rows: [purchase, [...purchase]] });
    expect(result).toEqual(Array.from({ length: 2 }, () => ({
      date: "2026-08-05", valueDate: "2026-08-06", description: "COMERCIO SINTÉTICO",
      amount: "-1234.5", currency: "EUR", status: "unspecified"
    })));
  });

  it("preserves pending status and refunds without inventing booked status", () => {
    expect(parseKutxabankTable({ headers, rows: [
      ["01/09/2026", "COMPRA SINTÉTICA", "", "-2,00 €", "P (*)"],
      ["02/09/2026", "DEVOLUCIÓN SINTÉTICA", "02/09/2026", "2,00 €", ""]
    ] })).toMatchObject([
      { status: "pending", valueDate: null, amount: "-2" },
      { status: "unspecified", amount: "2" }
    ]);
  });

  it.each(["4111111111111111", "4111 1111 1111 1111", "4111-1111-1111-1111"])(
    "removes synthetic card identifiers from settlement descriptions: %s", (pan) => {
      const result = parseKutxabankTable({ headers, rows: [
        ["01/09/2026", `PAGO RECIBO ${pan}`, "01/09/2026", "42,00 €", ""]
      ] });
      expect(result[0]?.description).toBe("PAGO RECIBO [TARJETA OCULTA]");
      expect(JSON.stringify(result)).not.toContain(pan);
    }
  );

  it.each([
    ["31/02/2026", "TEST", "01/03/2026", "-2,00 €", ""],
    ["01/09/2026", "TEST", "", "1.23,00 €", ""],
    ["01/09/2026", "TEST", "", "2,00 USD", ""],
    ["01/09/2026", "TEST", "", "2,00 €", "NEW"],
    ["01/09/2026", "TEST", "", "2,00 €"],
    ["01/09/2026", "", "", "2,00 €", ""]
  ])("rejects malformed or changed rows without returning a partial batch", (...row) => {
    expect(() => parseKutxabankTable({ headers, rows: [purchase, row] })).toThrow();
  });

  it("rejects a login page or a changed table instead of treating it as zero transactions", () => {
    expect(() => parseKutxabankTable({ headers: [], rows: [] })).toThrow();
    expect(() => parseKutxabankTable({ headers: headers.slice(0, 4), rows: [purchase] })).toThrow();
    expect(parseKutxabankTable({ headers, rows: [] })).toEqual([]);
  });

  it("keeps malformed source data out of errors", () => {
    try {
      parseKutxabankTable({ headers, rows: [["SECRET", "4111111111111111", "", "SECRET", ""]] });
      expect.fail("Expected invalid row to be rejected");
    } catch (error) {
      expect(String(error)).not.toContain("SECRET");
      expect(String(error)).not.toContain("4111111111111111");
      expect(String(error)).toContain("fila 1");
    }
  });
});
