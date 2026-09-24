import { describe, expect, it, vi } from "vitest";
import { executeKutxabankBatchSync, executeKutxabankSync, type KutxabankWorkflowDependencies } from "../../src/desktop/kutxabank-workflow.js";

const connectionId = "00000000-0000-4000-8000-000000000001";
const accountId = "00000000-0000-4000-8000-000000000002";
const fingerprint1111 = "a".repeat(64);
const fingerprint2222 = "b".repeat(64);
const fingerprint3333 = "c".repeat(64);
const request = { selectionToken: "synthetic-session-selection", connectionId, accountId,
  dateFrom: "2026-08-01", dateTo: "2026-08-31" };
function setup() {
  const first = vi.fn().mockResolvedValue({ state: "table", productKey: "ephemeral-bank-product",
    dateFrom: request.dateFrom, dateTo: request.dateTo, hasPrevious: false, hasNext: false,
    table: { headers: ["Fecha", "Concepto", "Fecha imputación", "Importe", "Situación"],
      rows: [["15/08/2026", "SYNTHETIC", "15/08/2026", "-10,00 €", ""]] }
  });
  const deps = {
    listConnections: vi.fn().mockReturnValue([{ id: connectionId, alias: "Person A", cards: [
      { id: accountId, alias: "Card A", last4: "1111", fingerprint: fingerprint1111 }
    ] }]),
    selectCard: vi.fn().mockResolvedValue({ productKey: "ephemeral-bank-product", last4: "1111",
      fingerprint: fingerprint1111 }),
    reader: vi.fn().mockReturnValue({ first, next: vi.fn() }),
    transaction: <T>(operation: () => T): T => operation(),
    createConnection: vi.fn().mockReturnValue({ id: connectionId }),
    createCard: vi.fn().mockReturnValue({ id: accountId }),
    ingest: vi.fn().mockReturnValue({ rows: 1, inserted: 1, updated: 0, duplicates: 0, reconciled: 0 })
  } satisfies KutxabankWorkflowDependencies;
  return { deps, first };
}

describe("Kutxabank desktop workflow", () => {
  it("rejects the removed three-month period", async () => {
    const { deps } = setup();
    await expect(executeKutxabankBatchSync(
      { dateFrom: request.dateFrom, dateTo: request.dateTo, period: "three-months" },
      { ...deps, discoverCards: vi.fn() }
    )).rejects.toThrow("INVALID_QUERY");
  });

  it("continues with available enabled cards and reports a missing card at the end", async () => {
    const { deps } = setup();
    const availableId = "00000000-0000-4000-8000-000000000003";
    const disabledId = "00000000-0000-4000-8000-000000000004";
    deps.listConnections.mockReturnValue([{ id: connectionId, alias: "Person A", cards: [
      { id: accountId, alias: "Missing", last4: "1111", fingerprint: fingerprint1111, syncEnabled: true },
      { id: availableId, alias: "Available", last4: "2222", fingerprint: fingerprint2222, syncEnabled: true },
      { id: disabledId, alias: "Disabled", last4: "3333", fingerprint: fingerprint3333, syncEnabled: false }
    ] }]);
    const discoverCards = vi.fn().mockResolvedValue([
      { selectionToken: "bank-available", last4: "2222", fingerprint: fingerprint2222 },
      { selectionToken: "bank-disabled", last4: "3333", fingerprint: fingerprint3333 }
    ]);
    deps.selectCard.mockResolvedValue({ productKey: "ephemeral-bank-product", last4: "2222",
      fingerprint: fingerprint2222 });
    const result = await executeKutxabankBatchSync(
      { dateFrom: request.dateFrom, dateTo: request.dateTo },
      { ...deps, discoverCards }
    );
    expect(result).toMatchObject({ inserted: 1, cardWarnings: [
      { accountId, code: "CARD_UNAVAILABLE" }
    ] });
    expect(deps.ingest).toHaveBeenCalledOnce();
    expect(deps.ingest).toHaveBeenCalledWith(expect.objectContaining({ accountId: availableId }));
  });

  it("does not import movements into another person's card with the same final digits", async () => {
    const { deps } = setup();
    deps.listConnections.mockReturnValue([{ id: connectionId, alias: "First person", cards: [
      { id: accountId, alias: "First card", last4: "1111", fingerprint: "a".repeat(64), syncEnabled: true }
    ] }]);
    const result = await executeKutxabankBatchSync(
      { dateFrom: request.dateFrom, dateTo: request.dateTo },
      { ...deps, discoverCards: vi.fn().mockResolvedValue([
        { selectionToken: "other-person-card", last4: "1111", fingerprint: "b".repeat(64) }
      ]) }
    );
    expect(result.cardWarnings).toEqual([{ accountId, code: "CARD_UNAVAILABLE" }]);
    expect(deps.ingest).not.toHaveBeenCalled();
  });

  it("uses one global card list across local connections and skips absent cards", async () => {
    const { deps } = setup();
    const secondConnectionId = "00000000-0000-4000-8000-000000000005";
    const secondCardId = "00000000-0000-4000-8000-000000000006";
    deps.listConnections.mockReturnValue([
      { id: connectionId, alias: "First login", cards: [
        { id: accountId, alias: "Unavailable today", last4: "1111", fingerprint: fingerprint1111, syncEnabled: true }
      ] },
      { id: secondConnectionId, alias: "Second login", cards: [
        { id: secondCardId, alias: "Available today", last4: "2222", fingerprint: fingerprint2222, syncEnabled: true }
      ] }
    ]);
    deps.selectCard.mockResolvedValue({ productKey: "ephemeral-bank-product", last4: "2222",
      fingerprint: fingerprint2222 });
    const result = await executeKutxabankBatchSync(
      { dateFrom: request.dateFrom, dateTo: request.dateTo },
      { ...deps, discoverCards: vi.fn().mockResolvedValue([
        { selectionToken: "available", last4: "2222", fingerprint: fingerprint2222 }
      ]) }
    );
    expect(result).toMatchObject({ inserted: 1, cardWarnings: [{ accountId, code: "CARD_UNAVAILABLE" }] });
    expect(deps.ingest).toHaveBeenCalledWith(expect.objectContaining({
      connectionId: secondConnectionId, accountId: secondCardId
    }));
  });

  it("continues after a card query fails and imports the next card independently", async () => {
    const { deps } = setup();
    const nextId = "00000000-0000-4000-8000-000000000003";
    deps.listConnections.mockReturnValue([{ id: connectionId, alias: "Person A", cards: [
      { id: accountId, alias: "First", last4: "1111", fingerprint: fingerprint1111, syncEnabled: true },
      { id: nextId, alias: "Second", last4: "2222", fingerprint: fingerprint2222, syncEnabled: true }
    ] }]);
    deps.reader.mockImplementation((token: string) => ({
      first: token === "first" ? vi.fn().mockRejectedValue(new Error("SOURCE_UNAVAILABLE"))
        : vi.fn().mockResolvedValue({ state: "table", productKey: "ephemeral-bank-product",
            dateFrom: request.dateFrom, dateTo: request.dateTo, hasPrevious: false, hasNext: false,
            table: { headers: ["Fecha", "Concepto", "Fecha imputación", "Importe", "Situación"],
              rows: [["15/08/2026", "SYNTHETIC", "15/08/2026", "-10,00 €", ""]] } }),
      next: vi.fn()
    }));
    deps.selectCard.mockImplementation((token: string) => Promise.resolve({
      productKey: "ephemeral-bank-product", last4: token === "first" ? "1111" : "2222",
      fingerprint: token === "first" ? fingerprint1111 : fingerprint2222
    }));

    const result = await executeKutxabankBatchSync(
      { dateFrom: request.dateFrom, dateTo: request.dateTo },
      { ...deps, discoverCards: vi.fn().mockResolvedValue([
        { selectionToken: "first", last4: "1111", fingerprint: fingerprint1111 },
        { selectionToken: "second", last4: "2222", fingerprint: fingerprint2222 }
      ]) }
    );

    expect(result).toMatchObject({ inserted: 1, cardWarnings: [
      { accountId, code: "SOURCE_UNAVAILABLE" }
    ] });
    expect(deps.ingest).toHaveBeenCalledWith(expect.objectContaining({ accountId: nextId }));
  });

  it("fails the batch when persistence fails instead of reporting a bank warning", async () => {
    const { deps } = setup();
    deps.listConnections.mockReturnValue([{ id: connectionId, alias: "Person A", cards: [
      { id: accountId, alias: "Card A", last4: "1111", fingerprint: fingerprint1111, syncEnabled: true }
    ] }]);
    deps.ingest.mockImplementation(() => { throw new Error("database is locked"); });

    await expect(executeKutxabankBatchSync(
      { dateFrom: request.dateFrom, dateTo: request.dateTo },
      { ...deps, discoverCards: vi.fn().mockResolvedValue([
        { selectionToken: "bank-card", last4: "1111", fingerprint: fingerprint1111 }
      ]) }
    )).rejects.toThrow("LOCAL_STORAGE_FAILED");
  });

  it("binds ephemeral browser selection to the explicitly selected local account", async () => {
    const { deps } = setup();
    expect(await executeKutxabankSync(request, deps)).toMatchObject({ inserted: 1 });
    expect(deps.ingest).toHaveBeenCalledWith(expect.objectContaining({ connectionId, accountId,
      movements: [expect.objectContaining({ amount: "-10" })] }));
    expect(deps.createCard).not.toHaveBeenCalled();
  });

  it("does not create local records or ingest while the bank needs authorization", async () => {
    const { deps, first } = setup();
    first.mockResolvedValue({ state: "authorization-required" });
    const input = { selectionToken: request.selectionToken, connectionAlias: "Person A", accountAlias: "Card A",
      dateFrom: request.dateFrom, dateTo: request.dateTo };
    await expect(executeKutxabankSync(input, deps)).rejects.toThrow("AUTHORIZATION_REQUIRED");
    expect(deps.createConnection).not.toHaveBeenCalled();
    expect(deps.createCard).not.toHaveBeenCalled();
    expect(deps.ingest).not.toHaveBeenCalled();
  });

  it("creates an explicitly requested connection and card after all pages succeed", async () => {
    const { deps } = setup();
    await executeKutxabankSync({ selectionToken: request.selectionToken, connectionAlias: "Person B",
      accountAlias: "New card", dateFrom: request.dateFrom, dateTo: request.dateTo }, deps);
    expect(deps.createConnection).toHaveBeenCalledWith("Person B");
    expect(deps.createCard).toHaveBeenCalledWith(connectionId, "New card", "1111", fingerprint1111);
  });

  it.each([
    { connectionAlias: "Ambiguous" }, { accountAlias: "Ambiguous" },
    { connectionId: "00000000-0000-4000-8000-000000000003" },
    { accountId: "00000000-0000-4000-8000-000000000004" },
    { dateTo: "2026-07-01" }, { url: "https://untrusted.invalid" }
  ])("rejects ambiguous or invalid input before contacting the bank", async change => {
    const { deps } = setup();
    await expect(executeKutxabankSync({ ...request, ...change }, deps)).rejects.toThrow();
    expect(deps.selectCard).not.toHaveBeenCalled();
  });

  it("stops a mismatched card association without writing", async () => {
    const { deps } = setup();
    deps.selectCard.mockResolvedValue({ productKey: "another-bank-product", last4: "2222",
      fingerprint: fingerprint2222 });
    await expect(executeKutxabankSync(request, deps)).rejects.toThrow("CARD_ASSOCIATION_CHANGED");
    expect(deps.reader).not.toHaveBeenCalled();
    expect(deps.ingest).not.toHaveBeenCalled();
  });
});
