import { randomUUID } from "node:crypto";
import type { AppEnvironment } from "../config.js";
import type { SqliteDatabase } from "../storage/database.js";
import { Categorizer } from "../transactions/categorization.js";
import { TransactionRepository, type UpsertOutcome } from "../transactions/deduplication.js";
import { createMovementKey, createReconciliationKey } from "../transactions/movement-key.js";
import { normalizeDecimal, type NormalizedTransaction } from "../transactions/transaction-mapper.js";
import { sha256, stableJson } from "../utils/crypto.js";
import { assertIsoDate } from "../utils/dates.js";
import { normalizeText } from "../utils/text.js";
import type { KutxabankTableMovement } from "./kutxabank-table.js";

const PROVIDER = "kutxabank-browser";
const PAN = /(?<!\d)\d(?:[ -]?\d){12,18}(?![ -]?\d)/gu;

export interface KutxabankLocalConnection {
  id: string;
  provider: typeof PROVIDER;
  environment: AppEnvironment;
  alias: string;
  active: boolean;
}

export interface KutxabankLocalCard {
  id: string;
  connectionId: string;
  alias: string;
  last4: string;
  active: boolean;
  syncEnabled: boolean;
  balance: { text: string; isRed: boolean; readAt: string } | null;
}

export interface KutxabankSyncCard extends KutxabankLocalCard {
  fingerprint: string | null;
}

type ObservedBalance = { text: string; isRed: boolean };

function validatedBalance(balance: ObservedBalance | undefined): ObservedBalance | undefined {
  if (!balance) return undefined;
  const text = balance.text.replace(/\s+/gu, " ").trim();
  if (!/^-?(?:(?:\d{1,3}(?:\.\d{3})+)|\d+),\d{2} €$/u.test(text)) throw new Error("INVALID_BALANCE");
  return { text, isRed: balance.isRed };
}

export interface KutxabankIngestRequest {
  connectionId: string;
  accountId: string;
  dateFrom: string;
  dateTo: string;
  movements: KutxabankTableMovement[];
}

export interface KutxabankIngestResult {
  rows: number;
  inserted: number;
  updated: number;
  duplicates: number;
  reconciled: number;
}

interface ValidMovement {
  bookingDate: string;
  valueDate: string | null;
  description: string;
  descriptionNormalized: string;
  amount: string;
  direction: string;
  status: "pending" | "unknown";
  occurrence: number;
}

function requiredAlias(value: string): string {
  const alias = value.trim();
  if (!alias || alias.length > 120) throw new Error("INVALID_ALIAS");
  return alias;
}

function sanitizeDescription(value: unknown): string {
  return typeof value === "string" ? value.replace(PAN, "[TARJETA OCULTA]").trim() : "";
}

function nullableDate(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error();
  return assertIsoDate(value, "Fecha valor");
}

function validateBatch(request: KutxabankIngestRequest, maxRows: number): ValidMovement[] {
  try {
    const dateFrom = assertIsoDate(request.dateFrom, "Fecha inicial");
    const dateTo = assertIsoDate(request.dateTo, "Fecha final");
    if (
      dateFrom > dateTo ||
      !Array.isArray(request.movements) ||
      request.movements.length > maxRows
    ) throw new Error();
    const occurrences = new Map<string, number>();
    return request.movements.map((movement) => {
      // Sanitize first so neither a downstream error nor any derived key can contain a PAN.
      const candidate = movement as unknown as Record<string, unknown>;
      const description = sanitizeDescription(candidate["description"]);
      const date = candidate["date"];
      const rawValueDate = candidate["valueDate"];
      const amount = candidate["amount"];
      if (typeof date !== "string" || typeof amount !== "string") throw new Error();
      const bookingDate = assertIsoDate(date, "Fecha");
      const valueDate = nullableDate(rawValueDate);
      if (
        !description ||
        bookingDate < dateFrom ||
        bookingDate > dateTo ||
        candidate["currency"] !== "EUR" ||
        (candidate["status"] !== "pending" && candidate["status"] !== "unspecified")
      ) throw new Error();
      const money = normalizeDecimal(amount);
      const descriptionNormalized = normalizeText(description);
      // Status and value date are deliberately excluded: the portal may add them later.
      const semantic = stableJson({ bookingDate, descriptionNormalized, amount: money.amount, currency: "EUR", direction: money.direction });
      const occurrence = (occurrences.get(semantic) ?? 0) + 1;
      occurrences.set(semantic, occurrence);
      return {
        bookingDate,
        valueDate,
        description,
        descriptionNormalized,
        amount: money.amount,
        direction: money.direction,
        status: candidate["status"] === "pending" ? "pending" : "unknown",
        occurrence
      };
    });
  } catch {
    throw new Error("INVALID_MOVEMENT");
  }
}

export class KutxabankSyncService {
  public constructor(
    private readonly database: SqliteDatabase,
    private readonly config: { appEnv: AppEnvironment; maxCardImportRows?: number },
    private readonly categorizer: Categorizer
  ) {}

  public createConnection(aliasValue: string): KutxabankLocalConnection {
    const alias = requiredAlias(aliasValue);
    const id = randomUUID();
    const now = new Date().toISOString();
    this.database.prepare(
      `INSERT INTO bank_connections
       (id, provider, environment, bank_name, bank_country, psu_type, alias, status,
        created_at, last_authorized_at, reauthorization_required)
       VALUES (?, ?, ?, 'Kutxabank', 'ES', 'personal', ?, 'LOCAL', ?, ?, 0)`
    ).run(id, PROVIDER, this.config.appEnv, alias, now, now);
    return { id, provider: PROVIDER, environment: this.config.appEnv, alias, active: true };
  }

  public createCard(connectionId: string, aliasValue: string, last4Value: string,
    observedBalance?: ObservedBalance, restoredId?: string, fingerprint?: string): KutxabankLocalCard {
    const alias = requiredAlias(aliasValue);
    const last4 = last4Value.trim();
    if (!/^\d{4}$/u.test(last4)) throw new Error("INVALID_LAST4");
    if (fingerprint !== undefined && !/^[0-9a-f]{64}$/u.test(fingerprint)) throw new Error("CARD_ASSOCIATION_CHANGED");
    this.requireConnection(connectionId);
    const id = restoredId ?? randomUUID();
    const now = new Date().toISOString();
    const balance = validatedBalance(observedBalance);
    this.database.prepare(
      `INSERT INTO cards
       (id, bank_connection_id, alias, last4, active, first_seen_at, last_seen_at,
        sync_enabled, export_enabled, balance_text, balance_is_red, balance_read_at, identity_fingerprint)
       VALUES (?, ?, ?, ?, 1, ?, ?, 1, 1, ?, ?, ?, ?)`
    ).run(id, connectionId, alias, last4, now, now,
      balance?.text ?? null, balance ? Number(balance.isRed) : null, balance ? now : null,
      fingerprint ?? null);
    return { id, connectionId, alias, last4, active: true, syncEnabled: true,
      balance: balance ? { ...balance, readAt: now } : null };
  }

  public listConnections(): Array<{ id: string; alias: string; cards: KutxabankLocalCard[] }> {
    const rows = this.database.prepare(
      `SELECT id, alias FROM bank_connections
       WHERE provider = ? AND environment = ? AND status = 'LOCAL'
       ORDER BY created_at, rowid`
    ).all(PROVIDER, this.config.appEnv) as Array<{ id: string; alias: string }>;
    return rows.map((row) => ({ ...row, cards: this.listCards(row.id) }));
  }

  public reusableConnectionId(): string | undefined {
    const row = this.database.prepare(`SELECT id FROM bank_connections
      WHERE provider = ? AND environment = ? AND status IN ('LOCAL', 'INACTIVE')
      ORDER BY CASE status WHEN 'LOCAL' THEN 0 ELSE 1 END, created_at, rowid LIMIT 1`
    ).get(PROVIDER, this.config.appEnv) as { id: string } | undefined;
    return row?.id;
  }

  public listCards(connectionId: string): KutxabankLocalCard[] {
    const rows = this.database.prepare(
      `SELECT a.id, a.bank_connection_id, a.alias, a.last4, a.active, a.sync_enabled,
        a.balance_text, a.balance_is_red, a.balance_read_at
       FROM cards a JOIN bank_connections c ON c.id = a.bank_connection_id
       WHERE a.bank_connection_id = ? AND c.provider = ? AND c.environment = ?
         AND c.status = 'LOCAL' AND a.active = 1
       ORDER BY a.first_seen_at, a.rowid`
    ).all(connectionId, PROVIDER, this.config.appEnv) as Array<{
      id: string; bank_connection_id: string; alias: string;
      last4: string; active: number; sync_enabled: number;
      balance_text: string | null; balance_is_red: number | null; balance_read_at: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      connectionId: row.bank_connection_id,
      alias: row.alias,
      last4: row.last4,
      active: row.active === 1,
      syncEnabled: row.sync_enabled === 1,
      balance: row.balance_text && row.balance_read_at
        ? { text: row.balance_text, isRed: row.balance_is_red === 1, readAt: row.balance_read_at } : null
    }));
  }

  public listConnectionsForSync(): Array<{ id: string; alias: string; cards: KutxabankSyncCard[] }> {
    const fingerprints = new Map((this.database.prepare(
      "SELECT id, identity_fingerprint FROM cards"
    ).all() as Array<{ id: string; identity_fingerprint: string | null }>).map(row =>
      [row.id, row.identity_fingerprint]));
    return this.listConnections().map(connection => ({ ...connection, cards: connection.cards.map(card => ({
      ...card, fingerprint: fingerprints.get(card.id) ?? null
    })) }));
  }

  public reconcileDiscoveredCards(connectionId: string, discovered: readonly {
    last4: string; alias: string; fingerprint: string; balance?: ObservedBalance
  }[]): KutxabankLocalCard[] {
    const requestedConnection = this.database.prepare(`SELECT status FROM bank_connections
      WHERE id = ? AND provider = ? AND environment = ? AND status IN ('LOCAL', 'INACTIVE')`
    ).get(connectionId, PROVIDER, this.config.appEnv) as { status: string } | undefined;
    if (!requestedConnection) throw new Error("CONNECTION_UNAVAILABLE");
    if (discovered.some(card => !/^\d{4}$/u.test(card.last4) ||
        !/^[0-9a-f]{64}$/u.test(card.fingerprint)) ||
        new Set(discovered.map(card => card.fingerprint)).size !== discovered.length) {
      throw new Error("CARD_ASSOCIATION_CHANGED");
    }
    return this.database.transaction(() => {
      if (requestedConnection.status === "INACTIVE") {
        this.database.prepare("UPDATE bank_connections SET status = 'LOCAL' WHERE id = ?").run(connectionId);
        this.database.prepare("UPDATE cards SET active = 1 WHERE bank_connection_id = ?").run(connectionId);
      }
      const existing = this.database.prepare(`SELECT a.id, a.bank_connection_id AS connectionId,
        a.last4, a.identity_fingerprint AS fingerprint
        FROM cards a JOIN bank_connections c ON c.id = a.bank_connection_id
        WHERE c.provider = ? AND c.environment = ? AND c.status IN ('LOCAL', 'INACTIVE')`
      ).all(PROVIDER, this.config.appEnv) as Array<{
        id: string; connectionId: string; last4: string; fingerprint: string | null;
      }>;
      const byFingerprint = new Map(existing.filter(card => card.fingerprint)
        .map(card => [card.fingerprint, card]));
      return discovered.map(({ last4, alias, fingerprint, balance: observedBalance }) => {
        const card = byFingerprint.get(fingerprint);
        if (card) {
          if (card.last4 !== last4) throw new Error("CARD_ASSOCIATION_CHANGED");
          this.database.prepare("UPDATE bank_connections SET status = 'LOCAL' WHERE id = ?")
            .run(card.connectionId);
          this.database.prepare("UPDATE cards SET active = 1 WHERE bank_connection_id = ?")
            .run(card.connectionId);
          const now = new Date().toISOString();
          const balance = validatedBalance(observedBalance);
          this.database.prepare(`UPDATE cards SET last_seen_at = ?,
            balance_text = COALESCE(?, balance_text),
            balance_is_red = COALESCE(?, balance_is_red),
            balance_read_at = COALESCE(?, balance_read_at)
            WHERE id = ?`).run(now, balance?.text ?? null, balance ? Number(balance.isRed) : null,
            balance ? now : null, card.id);
          const current = this.listCards(card.connectionId).find(item => item.id === card.id);
          if (!current) throw new Error("CARD_ASSOCIATION_CHANGED");
          return current;
        }
        // Pre-fingerprint test catalogs cannot establish identity from four digits.
        if (existing.some(item => item.last4 === last4 && !item.fingerprint))
          throw new Error("CARD_ASSOCIATION_CHANGED");
        const historical = this.database.prepare(`SELECT DISTINCT t.account_id AS id,
            t.bank_connection_id AS connectionId
          FROM transactions t
          JOIN bank_connections bc ON bc.id = t.bank_connection_id
          LEFT JOIN cards c ON c.id = t.account_id
          WHERE t.provider = ? AND t.environment = ? AND t.card_fingerprint_snapshot = ?
            AND bc.provider = ? AND bc.environment = ? AND bc.status IN ('LOCAL', 'INACTIVE')
            AND c.id IS NULL`).all(
          PROVIDER, this.config.appEnv, fingerprint, PROVIDER, this.config.appEnv
        ) as Array<{ id: string; connectionId: string }>;
        if (historical.length > 1) throw new Error("CARD_ASSOCIATION_CHANGED");
        const restored = historical[0];
        const targetConnectionId = restored?.connectionId ?? connectionId;
        this.database.prepare("UPDATE bank_connections SET status = 'LOCAL' WHERE id = ?")
          .run(targetConnectionId);
        const created = this.createCard(targetConnectionId, requiredAlias(alias), last4, observedBalance,
          restored?.id, fingerprint);
        existing.push({ id: created.id, connectionId: created.connectionId, last4, fingerprint });
        byFingerprint.set(fingerprint, { id: created.id, connectionId: created.connectionId, last4, fingerprint });
        return created;
      });
    })();
  }

  public setCardSyncEnabled(connectionId: string, accountId: string, enabled: boolean): void {
    this.requireConnection(connectionId);
    const updated = this.database.prepare(
      `UPDATE cards SET sync_enabled = ? WHERE id = ? AND bank_connection_id = ? AND active = 1`
    ).run(enabled ? 1 : 0, accountId, connectionId);
    if (updated.changes !== 1) throw new Error("ACCOUNT_UNAVAILABLE");
  }

  public setCardAlias(connectionId: string, accountId: string, aliasValue: string): void {
    const alias = requiredAlias(aliasValue);
    this.requireConnection(connectionId);
    const updated = this.database.prepare(
      `UPDATE cards SET alias = ? WHERE id = ? AND bank_connection_id = ? AND active = 1`
    ).run(alias, accountId, connectionId);
    if (updated.changes !== 1) throw new Error("ACCOUNT_UNAVAILABLE");
  }

  public deleteCard(connectionId: string, accountId: string): void {
    this.requireConnection(connectionId);
    this.database.transaction(() => {
      const card = this.database.prepare("SELECT alias, last4, identity_fingerprint FROM cards WHERE id = ? AND bank_connection_id = ?")
        .get(accountId, connectionId) as { alias: string; last4: string; identity_fingerprint: string | null } | undefined;
      if (!card) throw new Error("ACCOUNT_UNAVAILABLE");
      this.database.prepare(`UPDATE transactions SET card_alias_snapshot = ?, card_last4_snapshot = ?,
        card_fingerprint_snapshot = ?
        WHERE account_id = ? AND bank_connection_id = ? AND provider = ? AND environment = ?`)
        .run(card.alias, card.last4, card.identity_fingerprint, accountId, connectionId, PROVIDER, this.config.appEnv);
      this.database.prepare("DELETE FROM cards WHERE id = ? AND bank_connection_id = ?")
        .run(accountId, connectionId);
    })();
  }

  public ingest(request: KutxabankIngestRequest): KutxabankIngestResult {
    const rows = validateBatch(request, this.config.maxCardImportRows ?? 250_000);
    const account = this.requireAccount(request.connectionId, request.accountId);
    const repository = new TransactionRepository(this.database);
    const result: KutxabankIngestResult = { rows: rows.length, inserted: 0, updated: 0, duplicates: 0, reconciled: 0 };
    this.database.transaction(() => {
      const transactions = this.matchTransactions(request, sha256(`kutxabank-local-card|${account.id}`), rows);
      for (const transaction of transactions) {
        const outcome: UpsertOutcome = repository.upsert(transaction);
        // An absent portal marker is current evidence of unknown status, not booked.
        // Override the generic AIS repository's monotonic pending-status policy locally.
        this.database.prepare("UPDATE transactions SET status = ? WHERE movement_key = ?")
          .run(transaction.status, transaction.movement_key);
        result[outcome === "duplicate" ? "duplicates" : outcome] += 1;
      }
      this.database.prepare("UPDATE bank_connections SET last_sync_at = ? WHERE id = ?").run(new Date().toISOString(), request.connectionId);
    })();
    return result;
  }

  private matchTransactions(request: KutxabankIngestRequest, accountStableKey: string, rows: ValidMovement[]): NormalizedTransaction[] {
    const existing = this.database.prepare(
      `SELECT * FROM transactions WHERE provider = ? AND environment = ?
       AND bank_connection_id = ? AND account_id = ? AND booking_date BETWEEN ? AND ?
       ORDER BY first_seen_at, id`
    ).all(PROVIDER, this.config.appEnv, request.connectionId, request.accountId, request.dateFrom, request.dateTo) as NormalizedTransaction[];
    const semantic = (row: NormalizedTransaction): string => stableJson([
      row.booking_date, row.description_normalized, row.amount, row.currency, row.direction
    ]);
    const evidence = (row: NormalizedTransaction): string => stableJson([row.status, row.value_date]);
    const oldGroups = new Map<string, NormalizedTransaction[]>();
    for (const row of existing) {
      const key = semantic(row);
      const group = oldGroups.get(key) ?? [];
      group.push(row);
      oldGroups.set(key, group);
    }
    const incomingGroups = new Map<string, Array<{ row: ValidMovement; transaction: NormalizedTransaction }>>();
    for (const row of rows) {
      const transaction = this.toTransaction(request, accountStableKey, row);
      const key = semantic(transaction);
      const group = incomingGroups.get(key) ?? [];
      group.push({ row, transaction });
      incomingGroups.set(key, group);
    }
    const result: NormalizedTransaction[] = [];
    for (const [key, incoming] of incomingGroups) {
      const previous = oldGroups.get(key) ?? [];
      const available = new Set(previous);
      const matched = new Map<NormalizedTransaction, NormalizedTransaction>();
      const exactCandidates = new Map<string, NormalizedTransaction[]>();
      for (const old of [...previous].reverse()) {
        const details = evidence(old);
        const candidates = exactCandidates.get(details) ?? [];
        candidates.push(old);
        exactCandidates.set(details, candidates);
      }
      // Reserve every exact observation before considering status/date transitions.
      for (const { transaction } of incoming) {
        const exact = exactCandidates.get(evidence(transaction))?.pop();
        if (exact) {
          matched.set(transaction, exact);
          available.delete(exact);
        }
      }
      // A unique non-null value date can identify a status-only transition.
      const oldByDate = new Map<string, NormalizedTransaction[]>();
      const newByDate = new Map<string, NormalizedTransaction[]>();
      for (const old of available) {
        if (old.value_date === null) continue;
        const candidates = oldByDate.get(old.value_date) ?? [];
        candidates.push(old);
        oldByDate.set(old.value_date, candidates);
      }
      for (const { transaction } of incoming) {
        if (matched.has(transaction) || transaction.value_date === null) continue;
        const peers = newByDate.get(transaction.value_date) ?? [];
        peers.push(transaction);
        newByDate.set(transaction.value_date, peers);
      }
      for (const [date, peers] of newByDate) {
        const candidates = oldByDate.get(date) ?? [];
        const candidate = candidates[0];
        const peer = peers[0];
        if (candidates.length === 1 && peers.length === 1 && candidate && peer) {
          matched.set(peer, candidate);
          available.delete(candidate);
        }
      }
      const remaining = incoming.filter(item => !matched.has(item.transaction));
      if (available.size && remaining.length) {
        // Do not assign distinguishable unmatched purchases to arbitrary reviewed rows.
        if (new Set([...available].map(evidence)).size > 1 ||
            new Set(remaining.map(item => evidence(item.transaction))).size > 1) {
          throw new Error("INVALID_MOVEMENT");
        }
        const oldRows = [...available];
        for (const [index, item] of remaining.entries()) {
          const old = oldRows[index];
          if (old) matched.set(item.transaction, old);
        }
      }
      const reservedIds = new Set(previous.map(old => old.provider_transaction_id));
      let occurrence = 1;
      for (const item of incoming) {
        const old = matched.get(item.transaction);
        if (old) {
          result.push({ ...item.transaction, provider_transaction_id: old.provider_transaction_id,
            movement_key: old.movement_key });
        } else {
          let transaction: NormalizedTransaction;
          do {
            transaction = this.toTransaction(request, accountStableKey, { ...item.row, occurrence: occurrence++ });
          } while (reservedIds.has(transaction.provider_transaction_id));
          reservedIds.add(transaction.provider_transaction_id);
          result.push(transaction);
        }
      }
    }
    return result;
  }

  public disconnect(connectionId: string): void {
    this.requireConnection(connectionId);
    this.database.transaction(() => {
      this.database.prepare("UPDATE bank_connections SET status = 'INACTIVE' WHERE id = ?").run(connectionId);
      this.database.prepare("UPDATE cards SET active = 0 WHERE bank_connection_id = ?").run(connectionId);
    })();
  }

  private requireConnection(id: string): void {
    const connection = this.database.prepare(
      "SELECT 1 FROM bank_connections WHERE id = ? AND provider = ? AND environment = ? AND status = 'LOCAL'"
    ).get(id, PROVIDER, this.config.appEnv);
    if (!connection) throw new Error("CONNECTION_UNAVAILABLE");
  }

  private requireAccount(connectionId: string, accountId: string): { id: string } {
    const account = this.database.prepare(
      `SELECT a.id FROM cards a
       JOIN bank_connections c ON c.id = a.bank_connection_id
       WHERE a.id = ? AND a.bank_connection_id = ? AND a.active = 1 AND a.sync_enabled = 1
         AND c.provider = ? AND c.environment = ? AND c.status = 'LOCAL'`
    ).get(accountId, connectionId, PROVIDER, this.config.appEnv) as { id: string } | undefined;
    if (!account) throw new Error("ACCOUNT_UNAVAILABLE");
    return account;
  }

  private toTransaction(request: KutxabankIngestRequest, accountStableKey: string, row: ValidMovement): NormalizedTransaction {
    const providerTransactionId = sha256(stableJson({ provider: PROVIDER, environment: this.config.appEnv, connectionId: request.connectionId, accountId: request.accountId, bookingDate: row.bookingDate, description: row.descriptionNormalized, amount: row.amount, currency: "EUR", direction: row.direction, occurrence: row.occurrence }));
    const keyInput = { accountStableKey, status: row.status, providerTransactionId, bookingDate: row.bookingDate, valueDate: row.valueDate, amount: row.amount, currency: "EUR", direction: row.direction, descriptionNormalized: row.descriptionNormalized, counterparty: row.descriptionNormalized };
    const category = /^pago\s+recibo\b/iu.test(row.descriptionNormalized)
      ? { category: null, subcategory: null }
      : this.categorizer.categorize(row.descriptionNormalized);
    return {
      movement_key: createMovementKey(keyInput), reconciliation_key: createReconciliationKey(keyInput),
      provider: PROVIDER, environment: this.config.appEnv, bank_connection_id: request.connectionId,
      account_id: request.accountId, provider_transaction_id: providerTransactionId, entry_reference: null,
      fallback_occurrence: null, status: row.status, booking_date: row.bookingDate, value_date: row.valueDate,
      transaction_datetime: null, amount: row.amount, currency: "EUR", direction: row.direction,
      description_raw: row.description, description_normalized: row.descriptionNormalized, merchant_name: row.description,
      creditor_name: row.direction === "expense" ? row.description : null,
      debtor_name: row.direction === "income" ? row.description : null, counterparty_iban_masked: null,
      counterparty_identification_hash: null, bank_transaction_code: null, merchant_category_code: null,
      balance_after: null, category_auto: category.category, subcategory_auto: category.subcategory,
      source_raw_file: null,
      raw_fingerprint: sha256(stableJson({ bookingDate: row.bookingDate, valueDate: row.valueDate, description: row.description, amount: row.amount, currency: "EUR", status: row.status }))
    };
  }
}
