import { randomUUID } from "node:crypto";
import type { AppEnvironment } from "../config.js";
import type { SqliteDatabase } from "../storage/database.js";
import { assertIsoDate } from "../utils/dates.js";
import { normalizeDecimal } from "./transaction-mapper.js";

export interface ReconciliationMovement {
  movementKey: string;
  date: string | null;
  account: string;
  source: string;
  description: string;
  amount: string;
  currency: string;
  status: string;
  reference: string | null;
}

interface StoredMovement {
  movement_key: string;
  account_id: string;
  amount: string;
  currency: string;
  provider: string;
  status: string;
}

export class SourceReconciliationService {
  constructor(private readonly database: SqliteDatabase, private readonly environment: AppEnvironment) {}

  list(dateFrom: string, dateTo: string): ReconciliationMovement[] {
    assertIsoDate(dateFrom, "Fecha inicial");
    assertIsoDate(dateTo, "Fecha final");
    if (dateFrom > dateTo) throw new Error("INVALID_QUERY");
    return this.database.prepare(`SELECT t.movement_key AS movementKey, t.booking_date AS date,
      COALESCE(NULLIF(a.account_alias, ''), a.display_name, a.name, c.alias,
        t.card_alias_snapshot, c.id) AS account,
      t.provider AS source, COALESCE(t.description_raw, '') AS description,
      t.amount, t.currency, t.status, r.reference
      FROM transactions t LEFT JOIN accounts a ON a.id=t.account_id
      LEFT JOIN cards c ON c.id=t.account_id
      LEFT JOIN transaction_reconciliations r ON r.movement_key=t.movement_key
      WHERE t.environment=? AND t.booking_date BETWEEN ? AND ?
      ORDER BY t.booking_date DESC, t.movement_key LIMIT 501`).all(this.environment, dateFrom, dateTo) as ReconciliationMovement[];
  }

  confirm(firstKey: string, secondKey: string, kind: "settlement" | "duplicate"): string {
    return this.database.transaction(() => {
      if (firstKey === secondKey || !["settlement", "duplicate"].includes(kind)) throw new Error("INVALID_RECONCILIATION");
      const read = this.database.prepare(`SELECT movement_key,account_id,amount,currency,provider,status
        FROM transactions WHERE movement_key=? AND environment=?`);
      const first=read.get(firstKey,this.environment) as StoredMovement | undefined;
      const second=read.get(secondKey,this.environment) as StoredMovement | undefined;
      if (!first || !second || first.account_id === second.account_id || first.currency !== second.currency ||
        [first.status,second.status].some(status=>status !== "booked" && status !== "unknown")) throw new Error("INVALID_RECONCILIATION");
      const firstAmount=normalizeDecimal(first.amount).amount;
      const secondAmount=normalizeDecimal(second.amount).amount;
      const providers=new Set([first.provider,second.provider]);
      if (kind === "duplicate") {
        if (firstAmount !== secondAmount || !providers.has("manual-card") || !providers.has("kutxabank-browser")) throw new Error("INVALID_RECONCILIATION");
      } else {
        const opposite=firstAmount.startsWith("-") ? firstAmount.slice(1) : `-${firstAmount}`;
        if (firstAmount === "0" || opposite !== secondAmount || !providers.has("enable-banking") ||
          !(providers.has("kutxabank-browser") || providers.has("manual-card"))) throw new Error("INVALID_RECONCILIATION");
      }
      if (this.database.prepare(`SELECT 1 FROM transaction_reconciliations WHERE movement_key IN (?,?)`).get(firstKey,secondKey))
        throw new Error("ALREADY_RECONCILED");
      const reference=randomUUID();
      const insert=this.database.prepare(`INSERT INTO transaction_reconciliations
        (movement_key,reference,kind,representative,amount_snapshot,currency_snapshot,confirmed_at) VALUES(?,?,?,?,?,?,?)`);
      for (const [index,row] of [first,second].entries()) insert.run(row.movement_key,reference,kind,
        kind === "duplicate" && index === 1 ? 0 : 1,row.amount,row.currency,new Date().toISOString());
      return reference;
    })();
  }

  undo(reference: string): void {
    this.database.prepare(`DELETE FROM transaction_reconciliations WHERE reference=?
      AND movement_key IN (SELECT movement_key FROM transactions WHERE environment=?)`).run(reference, this.environment);
  }
}
