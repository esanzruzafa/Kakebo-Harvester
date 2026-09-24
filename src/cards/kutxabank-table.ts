import { normalizeDecimal } from "../transactions/transaction-mapper.js";
import { assertIsoDate } from "../utils/dates.js";

export interface KutxabankTableSnapshot {
  headers: string[];
  rows: string[][];
}

export interface KutxabankTableMovement {
  date: string;
  valueDate: string | null;
  description: string;
  amount: string;
  currency: "EUR";
  status: "pending" | "unspecified";
}

const EXPECTED_HEADERS = ["Fecha", "Concepto", "Fecha imputación", "Importe", "Situación"];

function parseDate(value: string): string {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match) throw new Error("Fecha no válida.");
  return assertIsoDate(`${match[3]}-${match[2]}-${match[1]}`, "Fecha");
}

/** Parses observed table cells only; does not establish session, identity or completeness. */
export function parseKutxabankTable(snapshot: KutxabankTableSnapshot): KutxabankTableMovement[] {
  if (
    snapshot.headers.length !== EXPECTED_HEADERS.length ||
    snapshot.headers.some((header, index) => header.trim() !== EXPECTED_HEADERS[index])
  ) {
    throw new Error("No se reconoce la tabla de movimientos de Kutxabank.");
  }

  return snapshot.rows.map((row, index) => {
    try {
      if (row.length !== EXPECTED_HEADERS.length) throw new Error("Columnas no válidas.");
      const [date = "", description = "", valueDate = "", amount = "", status = ""] = row.map(
        (cell) => cell.trim()
      );
      if (!description || (status !== "" && status !== "P (*)")) {
        throw new Error("Concepto o situación no reconocidos.");
      }
      const amountMatch = /^([+-]?(?:\d+|\d{1,3}(?:\.\d{3})+),\d{2})\s*€$/.exec(amount);
      if (!amountMatch?.[1]) throw new Error("Importe no reconocido.");
      return {
        date: parseDate(date),
        valueDate: valueDate ? parseDate(valueDate) : null,
        description: description.replace(/(?<!\d)\d(?:[ -]?\d){12,18}(?![ -]?\d)/g, "[TARJETA OCULTA]"),
        amount: normalizeDecimal(amountMatch[1].replaceAll(".", "")).amount,
        currency: "EUR",
        // An empty portal status is not yet evidence that the movement is booked.
        status: status === "P (*)" ? "pending" : "unspecified"
      };
    } catch {
      // Never include source cells or a nested cause, which may contain a full PAN.
      throw new Error(`Movimiento de Kutxabank no válido en la fila ${index + 1}.`);
    }
  });
}
