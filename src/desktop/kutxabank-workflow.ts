import { z } from "zod";
import { readKutxabankHistory, type KutxabankHistoryReader } from "../cards/kutxabank-history.js";
import type { KutxabankTableMovement } from "../cards/kutxabank-table.js";

const zKutxabankPeriod = z.enum(["fifteen-days", "today", "week", "month", "between"]);

export const kutxabankSyncRequestSchema = z.object({
  selectionToken: z.string().min(1).max(100),
  connectionId: z.uuid().optional(),
  connectionAlias: z.string().trim().min(1).max(120).optional(),
  accountId: z.uuid().optional(),
  accountAlias: z.string().trim().min(1).max(120).optional(),
  dateFrom: z.iso.date(),
  dateTo: z.iso.date()
  , period: zKutxabankPeriod.optional()
}).strict();

export interface KutxabankWorkflowConnection {
  id: string;
  alias: string;
  cards: Array<{ id: string; alias: string; last4: string | null; fingerprint?: string | null;
    syncEnabled?: boolean }>;
}

export interface KutxabankBatchWarning {
  accountId: string;
  code: "CARD_UNAVAILABLE" | "CARD_ASSOCIATION_CHANGED" | "SOURCE_UNAVAILABLE" |
    "AUTHORIZATION_REQUIRED" | "REAUTHENTICATION_REQUIRED" | "INCOMPLETE_PAGE";
}

export interface KutxabankBatchResult extends KutxabankWorkflowResult {
  cardWarnings: KutxabankBatchWarning[];
}

export const kutxabankBatchSyncRequestSchema = z.object({
  dateFrom: z.iso.date(),
  dateTo: z.iso.date()
  , period: zKutxabankPeriod.optional()
}).strict();

export interface KutxabankWorkflowResult {
  rows: number;
  inserted: number;
  updated: number;
  duplicates: number;
  reconciled: number;
}

export interface KutxabankWorkflowDependencies {
  listConnections(): KutxabankWorkflowConnection[];
  selectCard(token: string): Promise<{ productKey: string; last4: string; fingerprint: string }>;
  reader(token: string): KutxabankHistoryReader;
  transaction<T>(operation: () => T): T;
  createConnection(alias: string): { id: string };
  createCard(connectionId: string, alias: string, last4: string, fingerprint: string): { id: string };
  ingest(input: { connectionId: string; accountId: string; dateFrom: string; dateTo: string;
    movements: KutxabankTableMovement[] }): KutxabankWorkflowResult;
}

export async function executeKutxabankBatchSync(
  input: unknown,
  dependencies: KutxabankWorkflowDependencies & {
    discoverCards(): Promise<readonly { selectionToken: string; last4: string; fingerprint: string }[]>;
  },
  signal?: AbortSignal
): Promise<KutxabankBatchResult> {
  const parsed = kutxabankBatchSyncRequestSchema.safeParse(input);
  if (!parsed.success || parsed.data.dateFrom > parsed.data.dateTo) throw new Error("INVALID_QUERY");
  const request = parsed.data;
  const cards = dependencies.listConnections().flatMap(connection =>
    connection.cards.map(card => ({ ...card, connectionId: connection.id })));
  if (signal?.aborted) throw new Error("CANCELLED");
  const discovered = await dependencies.discoverCards();
  const tokens = new Map<string, string[]>();
  for (const item of discovered) tokens.set(item.fingerprint, [...(tokens.get(item.fingerprint) ?? []), item.selectionToken]);
  const localCounts = new Map<string, number>();
  for (const card of cards) if (card.fingerprint)
    localCounts.set(card.fingerprint, (localCounts.get(card.fingerprint) ?? 0) + 1);
  const result: KutxabankBatchResult = {
    rows: 0, inserted: 0, updated: 0, duplicates: 0, reconciled: 0, cardWarnings: []
  };
  for (const card of cards) {
    if (!card.syncEnabled) continue;
    if (signal?.aborted) throw new Error("CANCELLED");
    if (card.fingerprint && (localCounts.get(card.fingerprint) ?? 0) > 1) {
      result.cardWarnings.push({ accountId: card.id, code: "CARD_ASSOCIATION_CHANGED" });
      continue;
    }
    const candidates = tokens.get(card.fingerprint ?? "") ?? [];
    const token = candidates[0];
    if (candidates.length !== 1 || !token) {
      result.cardWarnings.push({ accountId: card.id,
        code: candidates.length > 1 ? "CARD_ASSOCIATION_CHANGED" : "CARD_UNAVAILABLE" });
      continue;
    }
    let movements: KutxabankTableMovement[];
    try {
      const selected = await dependencies.selectCard(token);
      if (selected.fingerprint !== card.fingerprint || selected.last4 !== card.last4)
        throw new Error("CARD_ASSOCIATION_CHANGED");
      movements = await readKutxabankHistory(dependencies.reader(token), {
        productKey: selected.productKey, dateFrom: request.dateFrom, dateTo: request.dateTo,
        period: request.period
      }, signal ? { signal } : {});
    } catch (error) {
      const code = error instanceof Error ? error.message : "";
      if (code === "CANCELLED") throw error;
      result.cardWarnings.push({ accountId: card.id, code:
        code === "AUTHORIZATION_REQUIRED" || code === "REAUTHENTICATION_REQUIRED" ||
        code === "INCOMPLETE_PAGE" || code === "CARD_ASSOCIATION_CHANGED"
          ? code : "SOURCE_UNAVAILABLE" });
      continue;
    }
    if (signal?.aborted) throw new Error("CANCELLED");
    let imported: KutxabankWorkflowResult;
    try {
      imported = dependencies.transaction(() => dependencies.ingest({
        connectionId: card.connectionId, accountId: card.id,
        dateFrom: request.period && request.period !== "between" && movements.length
          ? movements.reduce((value, row) => row.date < value ? row.date : value, movements[0]?.date ?? request.dateFrom)
          : request.dateFrom,
        dateTo: request.period && request.period !== "between" && movements.length
          ? movements.reduce((value, row) => row.date > value ? row.date : value, movements[0]?.date ?? request.dateTo)
          : request.dateTo,
        movements
      }));
    } catch { throw new Error("LOCAL_STORAGE_FAILED"); }
    for (const key of ["rows", "inserted", "updated", "duplicates", "reconciled"] as const) {
      result[key] += imported[key];
    }
  }
  return result;
}

export async function executeKutxabankSync(
  input: unknown,
  dependencies: KutxabankWorkflowDependencies,
  signal?: AbortSignal
): Promise<KutxabankWorkflowResult> {
  const parsed = kutxabankSyncRequestSchema.safeParse(input);
  if (!parsed.success) throw new Error("INVALID_QUERY");
  const request = parsed.data;
  if (
    request.dateFrom > request.dateTo ||
    Boolean(request.connectionId) === Boolean(request.connectionAlias) ||
    Boolean(request.accountId) === Boolean(request.accountAlias) ||
    (request.accountId && !request.connectionId)
  ) throw new Error("INVALID_QUERY");
  const connection = request.connectionId
    ? dependencies.listConnections().find(item => item.id === request.connectionId)
    : undefined;
  if (request.connectionId && !connection) throw new Error("INVALID_CONNECTION");
  const account = request.accountId
    ? connection?.cards.find(item => item.id === request.accountId)
    : undefined;
  if (request.accountId && !account) throw new Error("INVALID_ACCOUNT");
  if (signal?.aborted) throw new Error("CANCELLED");
  const selected = await dependencies.selectCard(request.selectionToken);
  if (account && (account.last4 !== selected.last4 || account.fingerprint !== selected.fingerprint))
    throw new Error("CARD_ASSOCIATION_CHANGED");
  const movements = await readKutxabankHistory(dependencies.reader(request.selectionToken), {
    productKey: selected.productKey,
    dateFrom: request.dateFrom,
    dateTo: request.dateTo,
    period: request.period
  }, signal ? { signal } : {});
  if (signal?.aborted) throw new Error("CANCELLED");
  try {
    return dependencies.transaction(() => {
      const connectionId = connection?.id ?? dependencies.createConnection(request.connectionAlias ?? "").id;
      const accountId = account?.id ?? dependencies.createCard(connectionId, request.accountAlias ?? "",
        selected.last4, selected.fingerprint).id;
      const dates = request.period && request.period !== "between" && movements.length
        ? { dateFrom: movements.reduce((value, row) => row.date < value ? row.date : value, movements[0]?.date ?? request.dateFrom),
            dateTo: movements.reduce((value, row) => row.date > value ? row.date : value, movements[0]?.date ?? request.dateTo) }
        : { dateFrom: request.dateFrom, dateTo: request.dateTo };
      return dependencies.ingest({ connectionId, accountId, ...dates, movements });
    });
  } catch { throw new Error("LOCAL_STORAGE_FAILED"); }
}
