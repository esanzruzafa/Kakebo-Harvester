import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KutxabankSyncService } from "../../src/cards/kutxabank-sync-service.js";
import type { KutxabankTableMovement } from "../../src/cards/kutxabank-table.js";
import { CategorizationRulesStore } from "../../src/settings/categorization-rules-store.js";
import { AccountsConfigStore } from "../../src/settings/accounts-config-store.js";
import { CardsConfigStore } from "../../src/settings/cards-config-store.js";
import { CsvExporter } from "../../src/export/csv-exporter.js";
import { ExportSettingsStore, createDefaultExportSettings } from "../../src/settings/export-settings-store.js";
import { createDatabase, type SqliteDatabase } from "../../src/storage/database.js";
import { AccountRepository } from "../../src/storage/repositories/account-repository.js";
import { Categorizer } from "../../src/transactions/categorization.js";
import { testConfig } from "../helpers.js";

let root: string | undefined;
let database: SqliteDatabase | undefined;

afterEach(async () => {
  database?.close();
  database = undefined;
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function setup(environment: "sandbox" | "production" = "sandbox") {
  root = await mkdtemp(join(tmpdir(), "kakebo-kutxabank-sync-"));
  database = createDatabase(join(root, "db.sqlite"));
  const rulesPath = join(root, "rules.json");
  await new CategorizationRulesStore(rulesPath).save([
    { id: "coffee", enabled: true, priority: 1, field: "descriptionNormalized", operator: "contains", value: "coffee", category: "Food" }
  ]);
  return {
    database,
    service: new KutxabankSyncService(database, { appEnv: environment }, new Categorizer(rulesPath))
  };
}

function movement(overrides: Partial<KutxabankTableMovement> = {}): KutxabankTableMovement {
  return {
    date: "2026-09-10",
    valueDate: "2026-09-11",
    description: "Coffee shop",
    amount: "-4.5",
    currency: "EUR",
    status: "unspecified",
    ...overrides
  };
}

const fingerprint1234 = "a".repeat(64);
const fingerprint5678 = "b".repeat(64);

describe("KutxabankSyncService", () => {
  it("keeps different cards with the same final digits separate across bank logins", async () => {
    const { service } = await setup();
    const firstLogin = service.createConnection("First login");
    const secondLogin = service.createConnection("Second login");
    const [first] = service.reconcileDiscoveredCards(firstLogin.id, [
      { last4: "1234", alias: "First card", fingerprint: "a".repeat(64) }
    ]);
    const [second] = service.reconcileDiscoveredCards(secondLogin.id, [
      { last4: "1234", alias: "Second card", fingerprint: "b".repeat(64) }
    ]);
    expect(first?.id).not.toBe(second?.id);
    expect(service.listConnections().flatMap(connection => connection.cards)).toHaveLength(2);
  });

  it("keeps a same-digit collision separate when the app reuses its default local connection", async () => {
    const { service } = await setup();
    const defaultConnection = service.createConnection("Kutxabank");
    const [first] = service.reconcileDiscoveredCards(defaultConnection.id, [
      { last4: "1234", alias: "First card", fingerprint: fingerprint1234 }
    ]);
    const [second] = service.reconcileDiscoveredCards(defaultConnection.id, [
      { last4: "1234", alias: "Second card", fingerprint: fingerprint5678 }
    ]);
    expect(first?.id).not.toBe(second?.id);
    expect(service.listConnections().flatMap(connection => connection.cards)).toHaveLength(2);
    expect(service.listConnectionsForSync().flatMap(connection => connection.cards)
      .map(card => card.fingerprint)).toEqual([fingerprint1234, fingerprint5678]);
  });

  it("reactivates the same card and history after disconnecting its local connection", async () => {
    const { service } = await setup();
    const connection = service.createConnection("Kutxabank");
    const [card] = service.reconcileDiscoveredCards(connection.id, [
      { last4: "1234", alias: "Compras", fingerprint: fingerprint1234 }
    ]);
    if (!card) throw new Error("fixture");
    service.disconnect(connection.id);
    expect(service.listConnections()).toEqual([]);
    const [reconnected] = service.reconcileDiscoveredCards(connection.id, [
      { last4: "1234", alias: "Compras", fingerprint: fingerprint1234 }
    ]);
    expect(reconnected?.id).toBe(card.id);
    expect(service.listConnections()[0]?.cards[0]?.id).toBe(card.id);
  });

  it("restores a deleted card's original identity despite another card sharing its final digits", async () => {
    const { service } = await setup();
    const connection = service.createConnection("Kutxabank");
    const [original] = service.reconcileDiscoveredCards(connection.id, [
      { last4: "1234", alias: "Original", fingerprint: fingerprint1234 }
    ]);
    if (!original) throw new Error("fixture");
    service.ingest({ connectionId: connection.id, accountId: original.id,
      dateFrom: "2026-09-01", dateTo: "2026-09-30", movements: [movement()] });
    service.deleteCard(connection.id, original.id);
    service.reconcileDiscoveredCards(connection.id, [
      { last4: "1234", alias: "Other", fingerprint: fingerprint5678 }
    ]);
    const [restored] = service.reconcileDiscoveredCards(connection.id, [
      { last4: "1234", alias: "Original", fingerprint: fingerprint1234 }
    ]);
    expect(restored?.id).toBe(original.id);
    expect(restored?.connectionId).toBe(connection.id);
    expect(service.ingest({ connectionId: connection.id, accountId: original.id,
      dateFrom: "2026-09-01", dateTo: "2026-09-30", movements: [movement()] }).duplicates).toBe(1);
  });

  it("keeps the last card balance and its reading time across sessions", async () => {
    const { service, database: initialDb } = await setup();
    const connection = service.createConnection("Personal");
    const [created] = service.reconcileDiscoveredCards(connection.id, [
      { last4: "1234", alias: "Visa", fingerprint: fingerprint1234,
        balance: { text: "194,55 €", isRed: true } }
    ]);
    expect(created?.balance).toMatchObject({ text: "194,55 €", isRed: true });
    expect(created?.balance?.readAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    service.reconcileDiscoveredCards(connection.id, [{ last4: "1234", alias: "Visa", fingerprint: fingerprint1234 }]);
    expect(service.listCards(connection.id)[0]?.balance).toEqual(created?.balance);
    initialDb.close();
    const reopened = createDatabase(join(root ?? "", "db.sqlite"));
    database = reopened;
    const persistent = new KutxabankSyncService(reopened, { appEnv: "sandbox" },
      new Categorizer(join(root ?? "", "rules.json")));
    expect(persistent.listCards(connection.id)[0]?.balance).toEqual(created?.balance);
    const cardsPath = join(root ?? "", "cards.json");
    await new CardsConfigStore(cardsPath).save(persistent.listCards(connection.id));
    expect(JSON.parse(await readFile(cardsPath, "utf8"))).toMatchObject({
      cards: [{ balance: created?.balance }]
    });
  });

  it("deletes a card from the catalog without deleting movements and recreates it on rediscovery", async () => {
    const { service, database } = await setup();
    const connection = service.createConnection("Personal");
    const card = service.createCard(connection.id, "Antigua", "1234", undefined, undefined, fingerprint1234);
    service.ingest({ connectionId: connection.id, accountId: card.id,
      dateFrom: "2026-09-01", dateTo: "2026-09-30", movements: [movement()] });
    service.deleteCard(connection.id, card.id);
    expect(service.listCards(connection.id)).toEqual([]);
    expect(database.prepare("SELECT COUNT(*) total FROM transactions WHERE account_id = ?").get(card.id))
      .toEqual({ total: 1 });
    const cardsPath = join(root ?? "", "cards.json");
    await new CardsConfigStore(cardsPath).save(service.listCards(connection.id));
    expect(JSON.parse(await readFile(cardsPath, "utf8"))).toEqual({ version: 1, cards: [] });
    expect(database.prepare("SELECT card_alias_snapshot, card_last4_snapshot FROM transactions WHERE account_id = ?")
      .get(card.id)).toEqual({ card_alias_snapshot: "Antigua", card_last4_snapshot: "1234" });
    const config = testConfig(root ?? "");
    const settings = createDefaultExportSettings(",", ";");
    settings.format = "csv";
    await new ExportSettingsStore(config.exportSettingsPath, settings).save(settings);
    const historicalExport = await new CsvExporter(config, database).export();
    const historicalCsv = await readFile(historicalExport.path, "utf8");
    expect(historicalCsv).toContain("Coffee shop");
    expect(historicalCsv).toContain("Antigua");
    const [recreated] = service.reconcileDiscoveredCards(connection.id, [
      { last4: "1234", alias: "Nueva", fingerprint: fingerprint1234 }
    ]);
    expect(recreated?.id).toBe(card.id);
    expect(recreated?.alias).toBe("Nueva");
    expect(service.ingest({ connectionId: connection.id, accountId: recreated?.id ?? "",
      dateFrom: "2026-09-01", dateTo: "2026-09-30", movements: [movement()] }).duplicates).toBe(1);
    expect(service.listCards(connection.id)).toHaveLength(1);
    expect(database.prepare("SELECT COUNT(*) total FROM transactions WHERE account_id = ?").get(card.id))
      .toEqual({ total: 1 });
    const output = await new CsvExporter(config, database).export();
    expect(await readFile(output.path, "utf8")).toContain("Coffee shop");
  });

  it("restores a deleted card's history when it reappears under other bank credentials", async () => {
    const { service } = await setup();
    const original = service.createConnection("First");
    const card = service.createCard(original.id, "Old alias", "1234", undefined, undefined, fingerprint1234);
    service.ingest({ connectionId: original.id, accountId: card.id,
      dateFrom: "2026-09-01", dateTo: "2026-09-30", movements: [movement()] });
    service.deleteCard(original.id, card.id);
    const later = service.createConnection("Later");
    expect(service.reconcileDiscoveredCards(later.id, [
      { last4: "1234", alias: "Bank alias", fingerprint: fingerprint1234 }
    ]))
      .toEqual([expect.objectContaining({ id: card.id, connectionId: original.id, alias: "Bank alias" })]);
  });

  it("keeps discovered cards and sync preferences when a later bank visit omits one", async () => {
    const { service, database: initialDb } = await setup();
    const connection = service.createConnection("Personal");
    const first = service.reconcileDiscoveredCards(connection.id, [
      { last4: "1234", alias: "Visa compras", fingerprint: fingerprint1234 },
      { last4: "5678", alias: "Viajes", fingerprint: fingerprint5678 }
    ]);
    expect(first).toHaveLength(2);
    expect(first.map(card => card.alias)).toEqual(["Visa compras", "Viajes"]);
    service.setCardSyncEnabled(connection.id, first[0]?.id ?? "", false);

    const later = service.reconcileDiscoveredCards(connection.id, [
      { last4: "5678", alias: "Alias cambiado en banco", fingerprint: fingerprint5678 }
    ]);

    expect(later).toEqual([expect.objectContaining({ id: first[1]?.id, last4: "5678" })]);
    expect(service.listCards(connection.id)).toEqual([
      expect.objectContaining({ id: first[0]?.id, last4: "1234", syncEnabled: false }),
      expect.objectContaining({ id: first[1]?.id, last4: "5678", alias: "Viajes", syncEnabled: true })
    ]);
    expect(initialDb.prepare("SELECT COUNT(*) total FROM cards WHERE bank_connection_id = ?").get(connection.id))
      .toEqual({ total: 2 });
    const savedCards = service.listCards(connection.id);
    initialDb.close();
    const reopened = createDatabase(join(root ?? "", "db.sqlite"));
    database = reopened;
    const persistent = new KutxabankSyncService(reopened, { appEnv: "sandbox" },
      new Categorizer(join(root ?? "", "rules.json")));
    expect(persistent.listCards(connection.id)).toEqual(savedCards);
  });

  it("reuses a card globally when it appears under different bank credentials", async () => {
    const { service } = await setup();
    const original = service.createConnection("Original");
    const later = service.createConnection("Later");
    const [card] = service.reconcileDiscoveredCards(original.id, [
      { last4: "1234", alias: "Banco", fingerprint: fingerprint1234 }
    ]);
    if (!card) throw new Error("fixture");
    service.setCardAlias(original.id, card.id, "Mi alias");
    service.setCardSyncEnabled(original.id, card.id, false);

    expect(service.reconcileDiscoveredCards(later.id, [
      { last4: "1234", alias: "Otro nombre", fingerprint: fingerprint1234 }
    ]))
      .toEqual([expect.objectContaining({ id: card.id, alias: "Mi alias", syncEnabled: false })]);
    expect(service.listCards(later.id)).toEqual([]);
  });

  it("refuses an ambiguous masked-card association without changing the catalog", async () => {
    const { service } = await setup();
    const connection = service.createConnection("Personal");
    expect(() => service.reconcileDiscoveredCards(connection.id, [
      { last4: "1234", alias: "Una", fingerprint: fingerprint1234 },
      { last4: "1234", alias: "Otra", fingerprint: fingerprint1234 }
    ]))
      .toThrow("CARD_ASSOCIATION_CHANGED");
    expect(service.listCards(connection.id)).toEqual([]);
  });

  it("renames only a card in the selected connection and preserves the alias after reopening", async () => {
    const { service, database: initialDb } = await setup();
    const firstConnection = service.createConnection("First");
    const secondConnection = service.createConnection("Second");
    const firstCard = service.createCard(firstConnection.id, "Original", "1234");
    const secondCard = service.createCard(secondConnection.id, "Other", "1234");

    expect(() => service.setCardAlias(secondConnection.id, firstCard.id, "Wrong"))
      .toThrow("ACCOUNT_UNAVAILABLE");
    service.setCardAlias(firstConnection.id, firstCard.id, "Viajes");
    expect(service.listCards(firstConnection.id)[0]?.alias).toBe("Viajes");
    expect(service.listCards(secondConnection.id)[0]?.id).toBe(secondCard.id);
    initialDb.close();
    const reopened = createDatabase(join(root ?? "", "db.sqlite"));
    database = reopened;
    const persistent = new KutxabankSyncService(reopened, { appEnv: "sandbox" },
      new Categorizer(join(root ?? "", "rules.json")));
    expect(persistent.listCards(firstConnection.id)[0]?.alias).toBe("Viajes");
  });

  it("creates separate local connections and explicit reusable cards without storing a PAN", async () => {
    const { service, database } = await setup();
    const ana = service.createConnection("Ana");
    const bob = service.createConnection("Bob");
    const card = service.createCard(ana.id, "Compras", "1234");

    expect(ana).toMatchObject({ provider: "kutxabank-browser", environment: "sandbox", alias: "Ana", active: true });
    expect(bob.id).not.toBe(ana.id);
    expect(service.listConnections()).toEqual([
      { id: ana.id, alias: "Ana", cards: [card] },
      { id: bob.id, alias: "Bob", cards: [] }
    ]);
    expect(service.listCards(ana.id)).toEqual([card]);
    expect(service.listCards(bob.id)).toEqual([]);
    expect(card).toMatchObject({ connectionId: ana.id, alias: "Compras", last4: "1234", active: true, syncEnabled: true });
    expect(card.id).not.toBe("1234");
    expect(JSON.stringify(database.prepare("SELECT * FROM bank_connections JOIN accounts ON accounts.bank_connection_id = bank_connections.id").all())).not.toContain("4111111111111111");
  });

  it("rejects invalid aliases and card masks without persisting anything", async () => {
    const { service, database } = await setup();
    expect(() => service.createConnection("   ")).toThrow("INVALID_ALIAS");
    const connection = service.createConnection("Ana");
    expect(() => service.createCard(connection.id, "Visa", "4111111111111111")).toThrow("INVALID_LAST4");
    expect(database.prepare("SELECT COUNT(*) total FROM accounts").get()).toEqual({ total: 0 });
  });

  it("ingests complete repeated and overlapping batches idempotently while retaining equal purchases", async () => {
    const { service, database } = await setup();
    const connection = service.createConnection("Ana");
    const card = service.createCard(connection.id, "Compras", "1234");
    const equal = movement();

    const first = service.ingest({ connectionId: connection.id, accountId: card.id, dateFrom: "2026-09-01", dateTo: "2026-09-30", movements: [equal, equal] });
    const repeated = service.ingest({ connectionId: connection.id, accountId: card.id, dateFrom: "2026-09-01", dateTo: "2026-09-30", movements: [equal, equal] });
    const overlap = service.ingest({ connectionId: connection.id, accountId: card.id, dateFrom: "2026-09-10", dateTo: "2026-09-20", movements: [equal] });

    expect(first).toEqual({ rows: 2, inserted: 2, updated: 0, duplicates: 0, reconciled: 0 });
    expect(repeated).toEqual({ rows: 2, inserted: 0, updated: 0, duplicates: 2, reconciled: 0 });
    expect(overlap).toEqual({ rows: 1, inserted: 0, updated: 0, duplicates: 1, reconciled: 0 });
    expect(database.prepare("SELECT COUNT(*) total FROM transactions").get()).toEqual({ total: 2 });
    expect(database.prepare("SELECT category_auto FROM transactions").all()).toEqual([
      { category_auto: "Food" },
      { category_auto: "Food" }
    ]);
  });

  it("clears an obsolete pending marker without losing identity or reviewed categorization", async () => {
    const { service, database } = await setup();
    const connection = service.createConnection("Ana");
    const card = service.createCard(connection.id, "Compras", "1234");
    service.ingest({ connectionId: connection.id, accountId: card.id, dateFrom: "2026-09-01", dateTo: "2026-09-30", movements: [movement({ status: "pending", valueDate: null })] });
    database.prepare("UPDATE transactions SET reviewed = 1, category_auto = 'Reviewed' WHERE account_id = ?").run(card.id);
    const identity = database.prepare("SELECT id, movement_key FROM transactions").get();
    database.prepare(`INSERT INTO transaction_reconciliations
      (movement_key, reference, kind, representative, amount_snapshot, currency_snapshot, confirmed_at)
      SELECT movement_key, 'synthetic-reference', 'settlement', 1, amount, currency, '2026-09-12T00:00:00Z' FROM transactions`).run();
    const reconciliation = database.prepare("SELECT * FROM transaction_reconciliations").get();

    const result = service.ingest({ connectionId: connection.id, accountId: card.id, dateFrom: "2026-09-01", dateTo: "2026-09-30", movements: [movement({ status: "unspecified", valueDate: "2026-09-12" })] });

    expect(result).toMatchObject({ inserted: 0, updated: 1 });
    expect(database.prepare("SELECT status, value_date, reviewed, category_auto FROM transactions WHERE account_id = ?").all(card.id)).toEqual([
      { status: "unknown", value_date: "2026-09-12", reviewed: 1, category_auto: "Reviewed" }
    ]);
    expect(database.prepare("SELECT id, movement_key FROM transactions").get()).toEqual(identity);
    expect(database.prepare("SELECT * FROM transaction_reconciliations").get()).toEqual(reconciliation);
  });

  it("keeps exact identities when equal purchases reorder", async () => {
    const { service, database } = await setup();
    const connection = service.createConnection("Ana");
    const card = service.createCard(connection.id, "Compras", "1234");
    const request = { connectionId: connection.id, accountId: card.id, dateFrom: "2026-09-01", dateTo: "2026-09-30" };
    const pending = movement({ status: "pending", valueDate: null });
    const settled = movement({ valueDate: "2026-09-12" });
    service.ingest({ ...request, movements: [pending, settled] });
    database.prepare("UPDATE transactions SET reviewed = 1, category_auto = 'Reviewed' WHERE status = 'pending'").run();
    const before = database.prepare("SELECT id, movement_key, status, value_date, reviewed, category_auto FROM transactions ORDER BY id").all();
    expect(service.ingest({ ...request, movements: [settled, pending] })).toMatchObject({ duplicates: 2, updated: 0, inserted: 0 });
    expect(database.prepare("SELECT id, movement_key, status, value_date, reviewed, category_auto FROM transactions ORDER BY id").all()).toEqual(before);
  });

  it("rejects ambiguous detail transitions atomically rather than reassigning reviewed identities", async () => {
    const { service, database } = await setup();
    const connection = service.createConnection("Ana");
    const card = service.createCard(connection.id, "Compras", "1234");
    const request = { connectionId: connection.id, accountId: card.id, dateFrom: "2026-09-01", dateTo: "2026-09-30" };
    service.ingest({ ...request, movements: [movement({ valueDate: "2026-09-11" }), movement({ valueDate: "2026-09-12" })] });
    const before = database.prepare("SELECT * FROM transactions ORDER BY id").all();
    expect(() => service.ingest({ ...request, movements: [movement({ description: "New purchase" }), movement({ valueDate: "2026-09-13" })] })).toThrow("INVALID_MOVEMENT");
    expect(database.prepare("SELECT * FROM transactions ORDER BY id").all()).toEqual(before);
  });

  it("matches an unchanged purchase before a pending transition and retains new equal purchases", async () => {
    const { service, database } = await setup();
    const connection = service.createConnection("Ana");
    const card = service.createCard(connection.id, "Compras", "1234");
    const request = { connectionId: connection.id, accountId: card.id, dateFrom: "2026-09-01", dateTo: "2026-09-30" };
    const pending = movement({ status: "pending", valueDate: null });
    const unchanged = movement({ valueDate: "2026-09-11" });
    service.ingest({ ...request, movements: [pending, unchanged] });
    database.prepare("UPDATE transactions SET reviewed = 1, category_auto = 'Reviewed' WHERE status = 'pending'").run();
    const identity = database.prepare("SELECT id, movement_key FROM transactions WHERE reviewed = 1").get();
    const transition = movement({ valueDate: "2026-09-12" });
    expect(service.ingest({ ...request, movements: [unchanged, transition] })).toMatchObject({ inserted: 0, updated: 1, duplicates: 1 });
    expect(database.prepare("SELECT id, movement_key FROM transactions WHERE reviewed = 1").get()).toEqual(identity);
    expect(database.prepare("SELECT status, value_date, category_auto FROM transactions WHERE reviewed = 1").get())
      .toEqual({ status: "unknown", value_date: "2026-09-12", category_auto: "Reviewed" });
    expect(service.ingest({ ...request, movements: [transition, unchanged, unchanged] })).toMatchObject({ inserted: 1, duplicates: 2 });
    expect(service.ingest({ ...request, movements: [unchanged, transition, unchanged] })).toMatchObject({ inserted: 0, duplicates: 3 });
    expect(database.prepare("SELECT COUNT(*) total FROM transactions").get()).toEqual({ total: 3 });
  });

  it("accepts the workflow's 120-character alias boundary", async () => {
    const { service } = await setup();
    const alias = "A".repeat(120);
    const connection = service.createConnection(alias);
    expect(service.createCard(connection.id, alias, "1234").alias).toBe(alias);
    expect(() => service.createConnection("A".repeat(121))).toThrow("INVALID_ALIAS");
    expect(() => service.createCard(connection.id, "A".repeat(121), "1234")).toThrow("INVALID_ALIAS");
  });

  it("validates the whole batch before an atomic write and removes PANs before errors or storage", async () => {
    const { service, database } = await setup();
    const connection = service.createConnection("Ana");
    const card = service.createCard(connection.id, "Compras", "1234");
    expect(() => service.ingest({ connectionId: connection.id, accountId: card.id, dateFrom: "2026-09-01", dateTo: "2026-09-30", movements: [movement({ description: "RECIBO 4111 1111 1111 1111" }), movement({ amount: "oops" })] })).toThrow("INVALID_MOVEMENT");
    expect(database.prepare("SELECT COUNT(*) total FROM transactions").get()).toEqual({ total: 0 });

    service.ingest({ connectionId: connection.id, accountId: card.id, dateFrom: "2026-09-01", dateTo: "2026-09-30", movements: [movement({ description: "RECIBO 4111 1111 1111 1111" })] });
    const stored = database.prepare("SELECT description_raw, source_raw_file, category_auto FROM transactions").get();
    expect(stored).toEqual({ description_raw: "RECIBO [TARJETA OCULTA]", source_raw_file: null, category_auto: null });
    expect(JSON.stringify(stored)).not.toContain("4111");
  });

  it("rejects inactive, disabled, wrong-source, wrong-environment and cross-connection accounts", async () => {
    const { service, database } = await setup();
    const first = service.createConnection("Ana");
    const second = service.createConnection("Bob");
    const card = service.createCard(first.id, "Compras", "1234");
    const request = { connectionId: first.id, accountId: card.id, dateFrom: "2026-09-01", dateTo: "2026-09-30", movements: [movement()] };
    database.prepare("UPDATE cards SET sync_enabled = 0 WHERE id = ?").run(card.id);
    expect(() => service.ingest(request)).toThrow("ACCOUNT_UNAVAILABLE");
    database.prepare("UPDATE cards SET sync_enabled = 1, bank_connection_id = ? WHERE id = ?").run(second.id, card.id);
    expect(() => service.ingest(request)).toThrow("ACCOUNT_UNAVAILABLE");
    database.prepare("UPDATE cards SET bank_connection_id = ?, active = 0 WHERE id = ?").run(first.id, card.id);
    expect(() => service.ingest(request)).toThrow("ACCOUNT_UNAVAILABLE");
    database.prepare("UPDATE cards SET active = 1 WHERE id = ?").run(card.id);
    database.prepare("UPDATE bank_connections SET provider = 'manual-card' WHERE id = ?").run(first.id);
    expect(() => service.ingest(request)).toThrow("ACCOUNT_UNAVAILABLE");
    database.prepare("UPDATE bank_connections SET provider = 'kutxabank-browser', environment = 'production' WHERE id = ?").run(first.id);
    expect(() => service.ingest(request)).toThrow("ACCOUNT_UNAVAILABLE");
  });

  it("disconnects only the selected local connection without deleting history", async () => {
    const { service, database } = await setup();
    const first = service.createConnection("Ana");
    const second = service.createConnection("Bob");
    const card = service.createCard(first.id, "Compras", "1234");
    service.ingest({ connectionId: first.id, accountId: card.id, dateFrom: "2026-09-01", dateTo: "2026-09-30", movements: [movement()] });
    service.disconnect(first.id);
    expect(service.listCards(first.id)).toEqual([]);
    expect(database.prepare("SELECT COUNT(*) total FROM transactions WHERE account_id = ?").get(card.id)).toEqual({ total: 1 });
    expect(database.prepare("SELECT status FROM bank_connections WHERE id IN (?, ?) ORDER BY id").all(first.id, second.id)).toEqual(expect.arrayContaining([{ status: "INACTIVE" }, { status: "LOCAL" }]));
  });

  it("keeps Kutxabank cards outside the bank accounts catalogue", async () => {
    const { service, database } = await setup();
    const connection = service.createConnection("Ana");
    const card = service.createCard(connection.id, "Compras", "1234");

    expect(new AccountRepository(database).listEditable()).toEqual([]);
    expect(database.prepare("SELECT id, alias, last4 FROM cards WHERE id = ?").get(card.id))
      .toEqual({ id: card.id, alias: "Compras", last4: "1234" });
    expect(database.prepare("SELECT id FROM accounts WHERE id = ?").get(card.id)).toBeUndefined();
    const accountsPath = join(root ?? "", "accounts.json");
    const cardsPath = join(root ?? "", "cards.json");
    await new AccountsConfigStore(accountsPath).save(new AccountRepository(database).listEditable());
    await new CardsConfigStore(cardsPath).save(service.listCards(connection.id));
    expect(JSON.parse(await readFile(accountsPath, "utf8"))).toEqual({ version: 1, accounts: [] });
    expect(JSON.parse(await readFile(cardsPath, "utf8"))).toEqual({ version: 1,
      cards: [{ id: card.id, alias: "Compras", last4: "1234", syncEnabled: true, balance: null }] });
  });

  it("exports a card movement using its card alias after the catalogue is separated", async () => {
    const { service, database } = await setup();
    const connection = service.createConnection("Personal");
    const card = service.createCard(connection.id, "Viajes", "5678");
    service.ingest({ connectionId: connection.id, accountId: card.id,
      dateFrom: "2026-09-01", dateTo: "2026-09-30", movements: [movement()] });
    const config = testConfig(root ?? "");
    const settings = createDefaultExportSettings(",", ";");
    settings.format = "csv";
    await new ExportSettingsStore(config.exportSettingsPath, settings).save(settings);
    const output = await new CsvExporter(config, database).export();
    expect(await readFile(output.path, "utf8")).toContain("Viajes");
  });
});
