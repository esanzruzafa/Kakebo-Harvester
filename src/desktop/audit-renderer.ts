import type {
  AuditHistoryLimit,
  TranslationDictionary
} from "../settings/localization-store.js";
import type { AuditRunView } from "../storage/repositories/desktop-run-repository.js";
import { formatExactCurrencyDecimal } from "../utils/currency.js";

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

function balance(run: {
  amount: string | null;
  currency: string | null;
}): string {
  if (run.amount === null) return t("audit.noBalance", "No balance");
  return formatExactCurrencyDecimal(run.amount, run.currency, language);
}

function renderRun(run: AuditRunView, expanded = false): HTMLElement {
  const article = document.createElement("details");
  article.className = "audit-run";
  article.open = expanded;
  const header = document.createElement("summary");
  header.className = "audit-run-header";
  const toggle = document.createElement("span");
  toggle.className = "audit-run-toggle";
  toggle.setAttribute("aria-hidden", "true");
  toggle.textContent = "›";
  const title = document.createElement("div");
  title.className = "audit-run-title";
  const date = document.createElement("strong");
  date.textContent = localDate(run.startedAt);
  const steps = document.createElement("span");
  steps.textContent = run.steps
    .map((step) => t(`step.${step}`, step))
    .join(" · ");
  title.append(date, steps);
  const meta = document.createElement("div");
  meta.className = "audit-run-meta";
  const range = document.createElement("span");
  range.className = "audit-run-range";
  range.textContent = `${run.dateFrom} → ${run.dateTo}`;
  const total = document.createElement("strong");
  total.className = "audit-run-total";
  total.textContent =
    run.totals.length === 0
      ? t("audit.noBalance", "No balance")
      : t("audit.total", "Total: {amount}").replace(
          "{amount}",
          run.totals.map(balance).join(" + ")
        );
  meta.append(range, total);
  header.append(toggle, title, meta, badge(run.status));

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
  const error = document.createElement("div");
  error.className = "audit-run-error";
  error.hidden = !run.error;
  if (run.errorCode) {
    const code = document.createElement("strong");
    code.textContent = run.errorCode;
    error.append(code);
  }
  if (run.error) {
    const message = document.createElement("span");
    message.textContent = run.error;
    error.append(message);
  }
  article.append(header, error, accounts);
  return article;
}

function renderRuns(runs: AuditRunView[]): void {
  const container = element<HTMLDivElement>("audit-runs");
  container.replaceChildren();
  if (runs.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = t("audit.empty", "There are no synchronization runs.");
    container.append(empty);
    return;
  }
  container.append(
    ...runs.map((run, index) => renderRun(run, index === 0))
  );
}

async function refreshHistory(): Promise<void> {
  const api = window.kakeboAudit;
  if (!api) throw new Error("The audit bridge is unavailable.");
  const data = await api.listHistory();
  renderRuns(data.runs);
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
  element("audit-limit-label").textContent = t(
    "audit.showLatest",
    "Show latest"
  );
  const limit = element<HTMLSelectElement>("audit-limit");
  limit.value = String(data.limit);
  limit.addEventListener("change", () => {
    void (async () => {
      limit.disabled = true;
      try {
        renderRuns(
          await api.setHistoryLimit(
            Number(limit.value) as AuditHistoryLimit
          )
        );
      } finally {
        limit.disabled = false;
      }
    })();
  });
  const close = element<HTMLButtonElement>("close-audit");
  close.textContent = t("common.close", "Close");
  close.addEventListener("click", () => {
    void api.close();
  });
  api.onHistoryChanged(() => {
    void refreshHistory();
  });
  renderRuns(data.runs);
}

void initialize();
