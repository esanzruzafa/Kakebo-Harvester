import type { TranslationDictionary } from "../settings/localization-store.js";
import type { AuditRunView } from "../storage/repositories/desktop-run-repository.js";

let language = "en";
let translations: TranslationDictionary = {};

function element<T extends HTMLElement>(
  id: string,
  guard?: (value: HTMLElement) => value is T
): T {
  const result = document.getElementById(id);
  if (!result) throw new Error(`Missing element: ${id}`);
  if (guard && !guard(result)) throw new Error(`Unexpected element type: ${id}`);
  return result as T;
}

function t(key: string, fallback: string): string {
  return translations[key] ?? fallback;
}

function localDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function statusClass(status: string): "success" | "warning" | "error" | "neutral" {
  if (status === "SUCCESS") return "success";
  if (status === "RUNNING") return "warning";
  if (status === "FAILED") return "error";
  return "neutral";
}

function badge(status: string): HTMLSpanElement {
  const result = document.createElement("span");
  result.className = `status-badge ${statusClass(status)}`;
  result.textContent =
    translations[`status.${status.toLowerCase()}`] ??
    status.replaceAll("_", " ");
  return result;
}

function balance(run: AuditRunView["accounts"][number]): string {
  if (run.amount === null) return t("audit.noBalance", "No balance");
  const amount = Number(run.amount);
  if (!Number.isFinite(amount)) {
    return [run.amount, run.currency].filter(Boolean).join(" ");
  }
  try {
    return new Intl.NumberFormat(language, {
      style: run.currency ? "currency" : "decimal",
      ...(run.currency ? { currency: run.currency } : {}),
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(amount);
  } catch {
    return [run.amount, run.currency].filter(Boolean).join(" ");
  }
}

function renderRun(run: AuditRunView): HTMLElement {
  const article = document.createElement("article");
  article.className = "audit-run";
  const header = document.createElement("div");
  header.className = "audit-run-header";
  const title = document.createElement("div");
  title.className = "audit-run-title";
  const date = document.createElement("strong");
  date.textContent = localDate(run.startedAt);
  const steps = document.createElement("span");
  steps.textContent = run.steps
    .map((step) => t(`step.${step}`, step))
    .join(" · ");
  title.append(date, steps);
  const range = document.createElement("span");
  range.className = "audit-run-range";
  range.textContent = `${run.dateFrom} → ${run.dateTo}`;
  header.append(title, range, badge(run.status));

  const accounts = document.createElement("div");
  accounts.className = "audit-account-list";
  if (run.accounts.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = t(
      "audit.noAccounts",
      "No account balance snapshot was available."
    );
    accounts.append(empty);
  }
  for (const account of run.accounts) {
    const row = document.createElement("div");
    row.className = "audit-account";
    const name = document.createElement("div");
    name.className = "audit-account-name";
    const label = document.createElement("strong");
    label.textContent = account.account;
    const bank = document.createElement("span");
    bank.textContent = account.bank;
    name.append(label, bank);
    const value = document.createElement("span");
    value.className = "audit-balance";
    value.textContent = balance(account);
    row.append(name, value);
    accounts.append(row);
  }
  article.append(header, accounts);
  return article;
}

async function initialize(): Promise<void> {
  const api = window.kakeboAudit;
  if (!api) throw new Error("The audit bridge is unavailable.");
  const data = await api.listHistory();
  language = data.language;
  translations = data.translations;
  document.documentElement.lang = language;
  document.title = t(
    "audit.windowTitle",
    "Execution history · Kakebo Harvester"
  );
  element("audit-kicker").textContent = t("audit.kicker", "Local audit");
  element("audit-title").textContent = t("audit.historyTitle", "Execution history");
  element("audit-description").textContent = t(
    "audit.historyDescription",
    "Complete list of persistent synchronization runs and account balance snapshots."
  );
  const close = element<HTMLButtonElement>("close-audit");
  close.textContent = t("common.close", "Close");
  close.addEventListener("click", () => {
    void api.close();
  });
  const container = element<HTMLDivElement>("audit-runs");
  if (data.runs.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = t("audit.empty", "There are no synchronization runs.");
    container.append(empty);
  } else {
    container.append(...data.runs.map(renderRun));
  }
}

void initialize();
