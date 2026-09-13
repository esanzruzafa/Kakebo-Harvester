import { describe, expect, it, vi } from "vitest";
import {
  runCardImportOperation,
  runAccountRemovalOperation,
  runConnectionOperation,
  runDisconnectOperation,
  runRecategorizationOperation
} from "../../src/desktop/committed-operations.js";

const imported = {
  files: [],
  rows: 3,
  inserted: 2,
  updated: 0,
  duplicates: 1,
  reconciled: 0
};

describe("committed desktop operations", () => {
  it("reports a committed card import when every follow-up succeeds", async () => {
    const result = await runCardImportOperation({
      importCards: vi.fn().mockResolvedValue(imported),
      exportCards: vi.fn().mockResolvedValue({ path: "result.xlsx" }),
      saveAccounts: vi.fn().mockResolvedValue(undefined)
    });

    expect(result).toEqual({
      ...imported,
      exportPath: "result.xlsx",
      warnings: []
    });
  });

  it("preserves import counts and runs every follow-up after independent failures", async () => {
    const saveAccounts = vi.fn().mockRejectedValue(
      new Error("Could not write token=secret")
    );
    const result = await runCardImportOperation({
      importCards: vi.fn().mockResolvedValue(imported),
      exportCards: vi.fn().mockRejectedValue(new Error("Export is read-only")),
      saveAccounts
    });

    expect(saveAccounts).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      ...imported,
      exportPath: null,
      warnings: [
        { step: "export", message: "Export is read-only" },
        {
          step: "accounts-config",
          message: "Could not write token=[REDACTED]"
        }
      ]
    });
  });

  it("rejects when the card import itself has not committed", async () => {
    const exportCards = vi.fn();
    const saveAccounts = vi.fn();

    await expect(
      runCardImportOperation({
        importCards: vi.fn().mockRejectedValue(new Error("Invalid workbook")),
        exportCards,
        saveAccounts
      })
    ).rejects.toThrow("Invalid workbook");
    expect(exportCards).not.toHaveBeenCalled();
    expect(saveAccounts).not.toHaveBeenCalled();
  });

  it("returns committed recategorization with an export warning", async () => {
    const result = await runRecategorizationOperation({
      recategorize: () => 4,
      exportTransactions: vi.fn().mockRejectedValue(new Error("File locked"))
    });

    expect(result).toEqual({
      updated: 4,
      exportPath: null,
      warnings: [{ step: "export", message: "File locked" }]
    });
  });

  it("does not hide completed connection changes when the account mirror fails", async () => {
    const connect = vi.fn().mockResolvedValue(undefined);
    const connection = await runConnectionOperation({
      connect,
      saveAccounts: vi.fn().mockRejectedValue(new Error("Mirror locked"))
    });
    expect(connect).toHaveBeenCalledOnce();
    expect(connection.warnings).toEqual([
      { step: "accounts-config", message: "Mirror locked" }
    ]);

    const disconnect = vi.fn().mockResolvedValue({
      remoteRevocationAttempted: true,
      remoteRevoked: false
    });
    const disconnected = await runDisconnectOperation({
      disconnect,
      saveAccounts: vi.fn().mockRejectedValue(new Error("Mirror locked"))
    });
    expect(disconnected).toEqual({
      remoteRevocationAttempted: true,
      remoteRevoked: false,
      warnings: [{ step: "accounts-config", message: "Mirror locked" }]
    });
  });

  it("regenerates exports after destructive removal and reports snapshot failures without private audit fields", async () => {
    const result = await runAccountRemovalOperation({
      remove: vi.fn().mockResolvedValue({
        status: "deleted",
        counts: { accounts: 1, balances: 0, transactions: 2, transactionsRaw: 1, synchronizationRuns: 0 },
        rawCleanup: { removed: 1, warnings: [] },
        audit: { action: "local-account-removal", outcome: "deleted", occurredAt: "2026-09-11T10:00:00.000Z" }
      }),
      regenerateExport: vi.fn().mockResolvedValue({ path: "result.xlsx" }),
      saveAccounts: vi.fn().mockRejectedValue(new Error("Snapshot locked token=secret"))
    });

    expect(result).toEqual({
      status: "deleted",
      counts: { accounts: 1, balances: 0, transactions: 2, transactionsRaw: 1, synchronizationRuns: 0 },
      rawCleanup: { removed: 1, warnings: [] },
      audit: { action: "local-account-removal", outcome: "deleted", occurredAt: "2026-09-11T10:00:00.000Z" },
      exportPath: "result.xlsx",
      warnings: [{ step: "accounts-config", message: "Snapshot locked token=[REDACTED]" }]
    });
    expect(Object.keys(result.audit).sort()).toEqual(["action", "occurredAt", "outcome"]);
  });

  it("does not regenerate exports when retained account history was hidden", async () => {
    const regenerateExport = vi.fn();
    const result = await runAccountRemovalOperation({
      remove: vi.fn().mockResolvedValue({
        status: "hidden",
        counts: { accounts: 0, balances: 0, transactions: 0, transactionsRaw: 0, synchronizationRuns: 0 },
        rawCleanup: { removed: 0, warnings: [] },
        audit: { action: "local-account-removal", outcome: "hidden", occurredAt: "2026-09-11T10:00:00.000Z" }
      }),
      regenerateExport,
      saveAccounts: vi.fn().mockResolvedValue(undefined)
    });
    expect(regenerateExport).not.toHaveBeenCalled();
    expect(result).toMatchObject({ exportPath: null, warnings: [] });
  });
});
