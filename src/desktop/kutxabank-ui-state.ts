import type {
  KutxabankInspection,
  KutxabankSyncInput
} from "./contracts.js";

export interface KutxabankSelection {
  selectionToken: string;
  connectionMode: "existing" | "new";
  connectionId: string;
  connectionAlias: string;
  accountMode: "existing" | "new";
  accountId: string;
  accountAlias: string;
}

export function createKutxabankSelection(
  inspection: KutxabankInspection
): KutxabankSelection {
  return {
    selectionToken: "",
    connectionMode: "existing",
    connectionId: inspection.connections[0]?.id ?? "",
    connectionAlias: "",
    accountMode: "existing",
    accountId: "",
    accountAlias: ""
  };
}

export function selectKutxabankConnection(
  selection: KutxabankSelection,
  connectionId: string
): KutxabankSelection {
  return {
    ...selection,
    connectionId,
    accountId: "",
    accountAlias: ""
  };
}

export function selectKutxabankConnectionMode(
  selection: KutxabankSelection,
  mode: "existing" | "new"
): KutxabankSelection {
  if (mode === "existing") {
    return { ...selection, connectionMode: mode };
  }
  return {
    ...selection,
    connectionMode: mode,
    connectionId: "",
    accountMode: "new",
    accountId: "",
    accountAlias: ""
  };
}

export async function refreshKutxabankAfterCommit(
  refreshApp: () => Promise<void>,
  refreshInspection?: () => Promise<void>
): Promise<Array<"app" | "inspection">> {
  const failures: Array<"app" | "inspection"> = [];
  try {
    await refreshApp();
  } catch {
    failures.push("app");
  }
  if (refreshInspection) {
    try {
      await refreshInspection();
    } catch {
      failures.push("inspection");
    }
  }
  return failures;
}

export function buildKutxabankSyncInput(
  selection: KutxabankSelection,
  dateFrom: string,
  dateTo: string
): KutxabankSyncInput {
  if (!selection.selectionToken) throw new Error("selectionToken");
  if (!dateFrom || !dateTo || dateFrom > dateTo) throw new Error("dateRange");

  const connection =
    selection.connectionMode === "existing"
      ? selection.connectionId
        ? { connectionId: selection.connectionId }
        : (() => {
            throw new Error("connectionId");
          })()
      : selection.connectionAlias.trim()
        ? { connectionAlias: selection.connectionAlias.trim() }
        : (() => {
            throw new Error("connectionAlias");
          })();
  const account =
    selection.connectionMode === "existing" && selection.accountMode === "existing"
      ? selection.accountId
        ? { accountId: selection.accountId }
        : (() => {
            throw new Error("accountId");
          })()
      : selection.accountAlias.trim()
        ? { accountAlias: selection.accountAlias.trim() }
        : (() => {
            throw new Error("accountAlias");
          })();

  return {
    selectionToken: selection.selectionToken,
    ...connection,
    ...account,
    dateFrom,
    dateTo
  };
}

export function isKutxabankSelectionValid(
  selection: KutxabankSelection,
  dateFrom: string,
  dateTo: string
): boolean {
  try {
    buildKutxabankSyncInput(selection, dateFrom, dateTo);
    return true;
  } catch {
    return false;
  }
}

export function buildReconciliationConfirmation(
  firstKey: string,
  secondKey: string,
  kind: "settlement" | "duplicate"
): { firstKey: string; secondKey: string; kind: "settlement" | "duplicate" } {
  if (!firstKey || !secondKey) throw new Error("movements");
  if (firstKey === secondKey) throw new Error("distinctMovements");
  return { firstKey, secondKey, kind };
}

export function buildReconciliationUndo(movement: {
  reference: string | null;
}): { reference: string } {
  if (!movement.reference) throw new Error("reconciliationReference");
  return { reference: movement.reference };
}
