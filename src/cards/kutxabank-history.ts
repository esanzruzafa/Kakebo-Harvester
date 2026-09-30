import { sha256, stableJson } from "../utils/crypto.js";
import { assertIsoDate } from "../utils/dates.js";
import { parseKutxabankTable, type KutxabankTableMovement, type KutxabankTableSnapshot } from "./kutxabank-table.js";
import type { KutxabankPeriod } from "../desktop/kutxabank-period.js";

export interface KutxabankHistoryQuery {
  productKey: string;
  dateFrom: string;
  dateTo: string;
  period?: KutxabankPeriod | undefined;
}

export type KutxabankHistoryPage =
  | ({ state: "table"; table: KutxabankTableSnapshot; hasNext: boolean; hasPrevious: boolean } & KutxabankHistoryQuery)
  | { state: "authorization-required" | "session-expired" | "loading" };

export interface KutxabankHistoryReader {
  first(query: KutxabankHistoryQuery): Promise<KutxabankHistoryPage>;
  next(): Promise<KutxabankHistoryPage>;
}

export async function readKutxabankHistory(
  reader: KutxabankHistoryReader,
  query: KutxabankHistoryQuery,
  options: { maxPages?: number; signal?: AbortSignal } = {}
): Promise<KutxabankTableMovement[]> {
  const maxPages = options.maxPages ?? 500;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1 || maxPages > 500) {
    throw new Error("INVALID_PAGE_LIMIT");
  }
  assertIsoDate(query.dateFrom, "Fecha inicial");
  assertIsoDate(query.dateTo, "Fecha final");
  if (!query.productKey.trim() || query.dateFrom > query.dateTo) throw new Error("INVALID_QUERY");
  // Hold all pages until traversal succeeds. The caller must never persist a partial batch.
  const result: KutxabankTableMovement[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < maxPages; index += 1) {
    if (options.signal?.aborted) throw new Error("CANCELLED");
    let page: KutxabankHistoryPage;
    try {
      page = await (index === 0 ? reader.first({ ...query }) : reader.next());
    } catch {
      throw new Error(options.signal?.aborted ? "CANCELLED" : "SOURCE_UNAVAILABLE");
    }
    if (options.signal?.aborted) throw new Error("CANCELLED");
    if (page.state === "authorization-required") throw new Error("AUTHORIZATION_REQUIRED");
    if (page.state === "session-expired") throw new Error("REAUTHENTICATION_REQUIRED");
    if (page.state !== "table") throw new Error("INCOMPLETE_PAGE");
    if (page.hasPrevious !== (index > 0)) throw new Error("INCOMPLETE_PAGE");
    if (page.productKey !== query.productKey || page.dateFrom !== query.dateFrom || page.dateTo !== query.dateTo) {
      throw new Error("QUERY_CHANGED");
    }
    const rows = parseKutxabankTable(page.table);
    if ((!query.period || query.period === "between") && rows.some(row => row.date < query.dateFrom || row.date > query.dateTo)) {
      throw new Error("QUERY_CHANGED");
    }
    // An empty page after Next is not proof that an asynchronous update completed.
    if (!rows.length && (index > 0 || page.hasNext)) throw new Error("INCOMPLETE_PAGE");
    const fingerprint = sha256(stableJson(rows));
    if (seen.has(fingerprint)) throw new Error("INCOMPLETE_PAGE");
    seen.add(fingerprint);
    result.push(...rows);
    if (!page.hasNext) return result;
  }
  throw new Error("INCOMPLETE_PAGE");
}
