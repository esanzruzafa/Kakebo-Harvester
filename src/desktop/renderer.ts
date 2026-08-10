import type {
  AuthorizationUiResult,
  BankOption,
  DesktopBootstrap,
  SelectedCardFile
} from "./contracts.js";
import { rowDropInsertionIndex } from "./row-drop.js";
import type { CardImportProfile } from "../settings/card-import-profiles-store.js";
import type { CategoryDefinition } from "../settings/categories-store.js";
import type {
  CategorizationExclusion,
  CategorizationRule
} from "../settings/categorization-rules-store.js";
import type {
  ExportField,
  ExportSettings
} from "../settings/export-settings-store.js";
import type { EditableAccount } from "../storage/repositories/account-repository.js";
import type { AuditRunView } from "../storage/repositories/desktop-run-repository.js";
import type {
  SyncProgressEvent,
  SyncStep
} from "../sync/sync-runner.js";

interface ProgressEntry {
  key: string;
  event: SyncProgressEvent;
  time: Date;
}

let state: DesktopBootstrap;
let currentTranslations: Record<string, string> = {};
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let progressEntries: ProgressEntry[] = [];
let operationInProgress = false;
let closePromptOpen = false;
const savedTabSnapshots = new Map<string, string>();
let selectedCardFiles: Array<
  SelectedCardFile & { included: boolean; profileId: string }
> = [];
let connectionWizardBanks: BankOption[] = [];
let selectedConnectionBank: BankOption | undefined;
let connectionWizardBusy = false;
let bankLoadRequest = 0;

const connectionCountryCodes = [
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE",
  "GR", "HU", "IS", "IE", "IT", "LV", "LI", "LT", "LU", "MT", "NL",
  "NO", "PL", "PT", "RO", "SK", "SI", "ES", "SE", "GB"
] as const;

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
  return currentTranslations[key] ?? fallback;
}

function tf(
  key: string,
  fallback: string,
  values: Record<string, string | number>
): string {
  let result = t(key, fallback);
  for (const [name, value] of Object.entries(values)) {
    result = result.replaceAll(`{${name}}`, String(value));
  }
  return result;
}

function applyTranslations(): void {
  currentTranslations = state.translations;
  document.documentElement.lang = state.language;
  for (const item of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = item.dataset["i18n"];
    if (key) item.textContent = t(key, item.textContent || key);
  }
  for (const item of document.querySelectorAll<HTMLElement>(
    "[data-i18n-title]"
  )) {
    const key = item.dataset["i18nTitle"];
    if (key) item.title = t(key, item.title || key);
  }
  for (const item of document.querySelectorAll<HTMLElement>(
    "[data-i18n-tooltip]"
  )) {
    const key = item.dataset["i18nTooltip"];
    if (!key) continue;
    const value = t(key, item.dataset["tooltip"] || key);
    item.dataset["tooltip"] = value;
    item.removeAttribute("title");
    item.setAttribute("aria-label", value);
  }
  for (const item of document.querySelectorAll<HTMLElement>(
    "[data-i18n-aria-label]"
  )) {
    const key = item.dataset["i18nAriaLabel"];
    if (key) item.setAttribute("aria-label", t(key, key));
  }
  element<HTMLSelectElement>("language-selector").value = state.language;
}

function errorMessage(error: unknown): string {
  let message = error instanceof Error ? error.message : String(error);
  message = message.replace(
    /^Error invoking remote method '[^']+':\s*(?:(?:[A-Za-z]+Error):\s*)*/u,
    ""
  );
  const retryAtMatch =
    /Próximo intento permitido: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)/u.exec(
      message
    );
  const providerCodeMatch =
    /\b(ASPSP_RATE_LIMIT_EXCEEDED|RATE_LIMIT_EXCEEDED)\b/u.exec(message);
  if (providerCodeMatch) {
    const base =
      providerCodeMatch[1] === "ASPSP_RATE_LIMIT_EXCEEDED"
        ? t(
            "error.aspspRateLimit",
            "The bank has reached its request limit."
          )
        : t(
            "error.enableBankingRateLimit",
            "Enable Banking has temporarily limited requests."
          );
    return retryAtMatch
      ? `${base} ${tf(
          "error.retryAt",
          "Try again after {date}.",
          { date: localDate(retryAtMatch[1] ?? "") }
        )} (${providerCodeMatch[1]})`
      : `${base} (${providerCodeMatch[1]})`;
  }
  const knownMessages: Array<[string, string, string]> = [
    [
      "Enable Banking rechazó la autenticación de la aplicación.",
      "error.enableBankingAuthentication",
      "Enable Banking rejected application authentication."
    ],
    [
      "La autorización bancaria fue cancelada o denegada.",
      "error.authorizationDenied",
      "Bank authorization was cancelled or denied."
    ],
    [
      "El parámetro state no es válido, ha caducado o ya fue utilizado.",
      "error.invalidState",
      "The authorization state is invalid, expired, or already used."
    ],
    [
      "La sesión bancaria ha caducado.",
      "error.sessionExpired",
      "The bank session expired."
    ],
    [
      "Hace falta volver a autorizar la conexión bancaria.",
      "error.reauthorizationRequired",
      "The bank connection must be authorized again."
    ],
    [
      "Ya hay otra sincronización en curso. Espera a que termine.",
      "error.syncAlreadyRunning",
      "Another synchronization is running. Wait for it to finish."
    ],
    [
      "El banco no está disponible temporalmente.",
      "error.bankUnavailable",
      "The bank is temporarily unavailable."
    ],
    [
      "Enable Banking devolvió una respuesta con formato inesperado.",
      "error.unexpectedProviderResponse",
      "Enable Banking returned an unexpected response format."
    ],
    [
      "Una o más conexiones bancarias requieren autorización.",
      "error.connectionsRequireAuthorization",
      "One or more bank connections require authorization."
    ],
    [
      "No se puede realizar una consulta online porque faltan cabeceras PSU obligatorias reales:",
      "error.psuHeadersUnavailable",
      "The online request cannot be made because truthful required PSU headers are unavailable:"
    ]
  ];
  for (const [source, key, english] of knownMessages) {
    if (message.includes(source)) {
      message = message.replace(source, t(key, english));
    }
  }
  return message;
}

function showToast(message: string, isError = false): void {
  const toast = element<HTMLDivElement>("toast");
  toast.textContent = message;
  toast.classList.toggle("is-error", isError);
  toast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, 4_500);
}

function localDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(state.language, {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(date);
}

function statusClass(status: string): "success" | "warning" | "error" | "neutral" {
  if (status === "AUTHORIZED" || status === "SUCCESS") return "success";
  if (
    status.includes("PENDING") ||
    status === "REAUTHORIZATION_REQUIRED" ||
    status === "RUNNING"
  ) {
    return "warning";
  }
  if (status === "FAILED" || status === "DENIED" || status.includes("ERROR")) {
    return "error";
  }
  return "neutral";
}

function statusLabel(status: string): string {
  return t(`status.${status.toLowerCase()}`, status.replaceAll("_", " "));
}

function badge(status: string): HTMLSpanElement {
  const result = document.createElement("span");
  result.className = `status-badge ${statusClass(status)}`;
  result.textContent = statusLabel(status);
  return result;
}

function button(label: string, className = "button secondary"): HTMLButtonElement {
  const result = document.createElement("button");
  result.type = "button";
  result.className = className;
  result.textContent = label;
  return result;
}

function onClick(
  target: HTMLButtonElement,
  listener: () => Promise<void>
): void {
  target.addEventListener("click", () => {
    void listener();
  });
}

type ModalChoice = "confirm" | "discard" | "cancel";

interface AppModalOptions {
  title: string;
  detail: string;
  confirmLabel: string;
  discardLabel?: string;
  danger?: boolean;
}

function showAppModal(options: AppModalOptions): Promise<ModalChoice> {
  const modal = element<HTMLElement>("app-modal");
  element("app-modal-kicker").textContent = t(
    "dialog.kicker",
    "Confirmation"
  );
  element("app-modal-title").textContent = options.title;
  element("app-modal-detail").textContent = options.detail;
  const accept = element<HTMLButtonElement>("app-modal-confirm");
  const discard = element<HTMLButtonElement>("app-modal-discard");
  const cancel = element<HTMLButtonElement>("app-modal-cancel");
  accept.textContent = options.confirmLabel;
  accept.className = options.danger ? "button danger" : "button primary";
  discard.hidden = !options.discardLabel;
  discard.textContent = options.discardLabel ?? "";
  cancel.textContent = t("common.cancel", "Cancel");
  modal.hidden = false;
  accept.focus();
  return new Promise((resolve) => {
    const finish = (value: ModalChoice): void => {
      modal.hidden = true;
      accept.onclick = null;
      discard.onclick = null;
      cancel.onclick = null;
      resolve(value);
    };
    accept.onclick = () => finish("confirm");
    discard.onclick = () => finish("discard");
    cancel.onclick = () => finish("cancel");
  });
}

async function confirmInApp(
  title: string,
  detail: string,
  confirmLabel: string
): Promise<boolean> {
  return (
    (await showAppModal({
      title,
      detail,
      confirmLabel,
      danger: true
    })) === "confirm"
  );
}

function connectionCountryLabel(country: string): string {
  try {
    return new Intl.DisplayNames([state.language], { type: "region" }).of(
      country
    ) ?? country;
  } catch {
    return country;
  }
}

function setConnectionWizardStatus(message: string, isError = false): void {
  const status = element<HTMLElement>("connection-wizard-status");
  status.textContent = message;
  status.classList.toggle("is-error", isError);
}

function renderConnectionCountries(): void {
  const select = element<HTMLSelectElement>("connection-country");
  const selected = select.value || state.defaultCountry;
  const countries = [...connectionCountryCodes];
  if (!countries.includes(state.defaultCountry as (typeof countries)[number])) {
    countries.push(state.defaultCountry as (typeof countries)[number]);
  }
  countries.sort((left, right) =>
    connectionCountryLabel(left).localeCompare(connectionCountryLabel(right))
  );
  select.replaceChildren();
  for (const country of countries) {
    const option = document.createElement("option");
    option.value = country;
    option.textContent = `${connectionCountryLabel(country)} (${country})`;
    select.append(option);
  }
  select.value = countries.includes(selected as (typeof countries)[number])
    ? selected
    : state.defaultCountry;
}

function connectionPsuLabel(psuType: "personal" | "business"): string {
  return t(
    `connectionWizard.${psuType}`,
    psuType === "personal" ? "Personal" : "Business"
  );
}

function renderConnectionBankList(): void {
  const container = element<HTMLDivElement>("connection-bank-list");
  const search = element<HTMLInputElement>("connection-bank-search").value
    .trim()
    .toLocaleLowerCase();
  const banks = connectionWizardBanks.filter((bank) =>
    bank.name.toLocaleLowerCase().includes(search)
  );
  container.replaceChildren();
  if (banks.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = search
      ? t("connectionWizard.noMatches", "No banks match the search.")
      : t(
          "connectionWizard.noBanks",
          "No banks are currently available for this country."
        );
    container.append(empty);
    return;
  }
  for (const bank of banks) {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "connection-bank-option";
    option.setAttribute("role", "option");
    const selected =
      selectedConnectionBank?.name === bank.name &&
      selectedConnectionBank.country === bank.country;
    option.classList.toggle("is-selected", selected);
    option.setAttribute("aria-selected", String(selected));
    const details = document.createElement("span");
    const name = document.createElement("strong");
    name.textContent = bank.name;
    const types = document.createElement("small");
    const authentication = bank.authentication
      .map((method) => method.name)
      .filter((value, index, values) => values.indexOf(value) === index)
      .join(", ");
    types.textContent = tf(
      "connectionWizard.bankDetails",
      "{types} · {authentication}",
      {
        types: bank.psuTypes.map(connectionPsuLabel).join(", "),
        authentication:
          authentication ||
          t(
            "connectionWizard.authenticationUnknown",
            "Not provided by Enable Banking"
          )
      }
    );
    details.append(name, types);
    const country = document.createElement("span");
    country.className = "status-badge neutral";
    country.textContent = bank.country;
    option.append(details, country);
    option.addEventListener("click", () => {
      selectedConnectionBank = bank;
      renderConnectionBankList();
      renderConnectionBankSelection();
    });
    container.append(option);
  }
}

function renderConnectionBankSelection(): void {
  const psuType = element<HTMLSelectElement>("connection-psu-type");
  const authentication = element<HTMLElement>("connection-authentication");
  const start = element<HTMLButtonElement>("connection-wizard-start");
  const bank = selectedConnectionBank;
  const previouslySelected = psuType.value as "personal" | "business";
  psuType.replaceChildren();
  if (!bank) {
    psuType.disabled = true;
    authentication.textContent = "—";
    start.disabled = true;
    return;
  }
  const selectedPsuType = bank.psuTypes.includes(previouslySelected)
    ? previouslySelected
    : bank.psuTypes.includes(state.defaultPsuType)
      ? state.defaultPsuType
      : bank.psuTypes[0];
  for (const type of bank.psuTypes) {
    const option = document.createElement("option");
    option.value = type;
    option.textContent = connectionPsuLabel(type);
    option.selected = type === selectedPsuType;
    psuType.append(option);
  }
  psuType.disabled = connectionWizardBusy;
  const methods = bank.authentication
    .filter((method) => method.psuType === selectedPsuType)
    .map((method) => method.name);
  authentication.textContent =
    methods.join(", ") ||
    t(
      "connectionWizard.authenticationUnknown",
      "Not provided by Enable Banking"
    );
  start.disabled = connectionWizardBusy || !state.callbackReady;
}

async function saveAccountsBeforeConnecting(): Promise<boolean> {
  if (!tabHasUnsavedChanges("accounts")) return true;
  const choice = await showAppModal({
    title: t("dialog.unsavedNavigation.title", "Unsaved changes"),
    detail: t(
      "dialog.unsavedNavigation.detail",
      "Save the changes on this page before leaving?"
    ),
    confirmLabel: t("dialog.unsaved.saveAndContinue", "Save and continue"),
    discardLabel: t("dialog.unsaved.discardAndContinue", "Discard and continue")
  });
  if (choice === "cancel") return false;
  if (choice === "confirm") {
    await saveTab("accounts", false);
  } else {
    await refresh();
  }
  return true;
}

async function loadConnectionBanks(): Promise<void> {
  if (connectionWizardBusy || !state.callbackReady) return;
  const request = ++bankLoadRequest;
  const country = element<HTMLSelectElement>("connection-country").value;
  const reload = element<HTMLButtonElement>("reload-banks");
  const countrySelect = element<HTMLSelectElement>("connection-country");
  reload.disabled = true;
  countrySelect.disabled = true;
  selectedConnectionBank = undefined;
  renderConnectionBankSelection();
  setConnectionWizardStatus(
    t("connectionWizard.loadingBanks", "Loading available banks…")
  );
  element<HTMLDivElement>("connection-bank-list").replaceChildren();
  try {
    const banks = await window.kakebo.listBanks(country);
    if (request !== bankLoadRequest) return;
    connectionWizardBanks = banks;
    renderConnectionBankList();
    setConnectionWizardStatus(
      banks.length === 0
        ? t(
            "connectionWizard.noBanks",
            "No banks are currently available for this country."
          )
        : t("connectionWizard.selectBank", "Select a bank to continue.")
    );
  } catch (error) {
    if (request !== bankLoadRequest) return;
    connectionWizardBanks = [];
    renderConnectionBankList();
    setConnectionWizardStatus(errorMessage(error), true);
  } finally {
    if (request === bankLoadRequest) {
      reload.disabled = false;
      countrySelect.disabled = false;
    }
  }
}

async function openConnectionWizard(): Promise<void> {
  if (operationInProgress) {
    showToast(
      t(
        "error.connectDuringSync",
        "Wait for the synchronization to finish before connecting a bank."
      ),
      true
    );
    return;
  }
  if (!(await saveAccountsBeforeConnecting())) return;
  connectionWizardBanks = [];
  selectedConnectionBank = undefined;
  connectionWizardBusy = false;
  element<HTMLInputElement>("connection-bank-search").value = "";
  renderConnectionCountries();
  renderConnectionBankSelection();
  renderConnectionBankList();
  element<HTMLElement>("connection-wizard").hidden = false;
  if (!state.callbackReady) {
    setConnectionWizardStatus(
      t(
        "connectionWizard.callbackUnavailable",
        "Local HTTPS is not ready. Prepare HTTPS from Settings before connecting a bank."
      ),
      true
    );
    return;
  }
  await loadConnectionBanks();
}

function closeConnectionWizard(): void {
  if (connectionWizardBusy) return;
  bankLoadRequest += 1;
  element<HTMLElement>("connection-wizard").hidden = true;
}

async function startBankConnection(): Promise<void> {
  const bank = selectedConnectionBank;
  if (!bank || connectionWizardBusy) return;
  if (!state.callbackReady) {
    setConnectionWizardStatus(
      t(
        "connectionWizard.callbackUnavailable",
        "Local HTTPS is not ready. Prepare HTTPS from Settings before connecting a bank."
      ),
      true
    );
    return;
  }
  const psuType = element<HTMLSelectElement>("connection-psu-type").value as
    | "personal"
    | "business";
  connectionWizardBusy = true;
  operationInProgress = true;
  const start = element<HTMLButtonElement>("connection-wizard-start");
  const cancel = element<HTMLButtonElement>("connection-wizard-cancel");
  const reload = element<HTMLButtonElement>("reload-banks");
  start.disabled = true;
  cancel.disabled = true;
  reload.disabled = true;
  element<HTMLSelectElement>("connection-country").disabled = true;
  element<HTMLInputElement>("connection-bank-search").disabled = true;
  setConnectionWizardStatus(
    t(
      "connectionWizard.opening",
      "Opening the secure bank authorization in your browser…"
    )
  );
  try {
    const connection = window.kakebo.connectBank({
      bankName: bank.name,
      country: bank.country,
      psuType
    });
    setConnectionWizardStatus(
      t(
        "connectionWizard.waiting",
        "Waiting for the bank authorization. Complete it in your browser, then return here."
      )
    );
    await connection;
    element<HTMLElement>("connection-wizard").hidden = true;
    await refresh();
  } catch (error) {
    const message = errorMessage(error);
    setConnectionWizardStatus(message, true);
    showToast(message, true);
    await refresh().catch(() => undefined);
  } finally {
    connectionWizardBusy = false;
    operationInProgress = false;
    cancel.disabled = false;
    reload.disabled = false;
    element<HTMLSelectElement>("connection-country").disabled = false;
    element<HTMLInputElement>("connection-bank-search").disabled = false;
    renderConnectionBankSelection();
  }
}

function renderSummary(): void {
  const activeConnections = state.connections.filter(
    (connection) => connection.status !== "REVOKED"
  );
  const authorized = activeConnections.filter(
    (connection) => connection.status === "AUTHORIZED"
  );
  element("summary-connections").textContent = String(activeConnections.length);
  element("summary-connection-detail").textContent =
    authorized.length === activeConnections.length
      ? tf("summary.authorized", "{count} authorized", {
          count: authorized.length
        })
      : tf(
          "summary.authorizedReview",
          "{count} authorized · review required",
          { count: authorized.length }
        );

  const lastSync = state.connections
    .map((connection) => connection.lastSyncAt)
    .filter((value): value is string => value !== null)
    .sort()
    .at(-1);
  element("summary-last-sync").textContent = lastSync
    ? localDate(lastSync)
    : t("common.never", "Never");
  element("summary-last-sync-detail").textContent = lastSync
    ? t("summary.lastCompleted", "Last completed run")
    : t("summary.noActivity", "No recorded activity");

  const enabledAccounts = state.accounts.filter(
    (account) => account.providerActive && account.syncEnabled
  );
  element("summary-accounts").textContent = String(enabledAccounts.length);
  element("summary-accounts-detail").textContent = tf(
    "summary.detected",
    "{count} detected",
    { count: state.accounts.length }
  );
}

function renderConnections(): void {
  const container = element<HTMLDivElement>("connection-list");
  container.replaceChildren();
  if (state.connections.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = t(
      "connections.empty",
      "There are no bank connections yet."
    );
    container.append(empty);
    return;
  }
  for (const connection of state.connections) {
    const row = document.createElement("div");
    row.className = "connection-item";

    const name = document.createElement("div");
    name.className = "connection-name";
    const strong = document.createElement("strong");
    strong.textContent = connection.alias;
    const bank = document.createElement("span");
    bank.textContent = connection.bank;
    name.append(strong, bank);

    const validity = document.createElement("span");
    validity.className = "connection-validity";
    const rateLimited =
      connection.retryAfterAt &&
      new Date(connection.retryAfterAt).getTime() > Date.now();
    validity.textContent = rateLimited
      ? tf(
          "connections.rateLimitedUntil",
          "Bank limit active until {date}",
          { date: localDate(connection.retryAfterAt) }
        ) + (connection.errorCode ? ` (${connection.errorCode})` : "")
      : connection.validUntil
        ? tf("connections.validUntil", "Valid until {date}", {
            date: localDate(connection.validUntil)
          })
        : t("connections.validityUnknown", "Validity not provided");

    const action = document.createElement("div");
    action.className = "button-row";
    action.append(badge(connection.status));
    if (connection.status !== "REVOKED") {
      const idleLabel = connection.reauthorizationRequired
        ? t("connections.reconnect", "Reconnect now")
        : t("connections.renew", "Renew access");
      const reconnect = button(idleLabel);
      onClick(reconnect, async () => {
        reconnect.disabled = true;
        reconnect.textContent = t("connections.waiting", "Waiting for the bank…");
        try {
          await window.kakebo.reauthorize(connection.id);
          showToast(t("toast.connectionRenewed", "The bank connection was renewed."));
          await refresh();
        } catch (error) {
          showToast(errorMessage(error), true);
        } finally {
          reconnect.disabled = false;
          reconnect.textContent = idleLabel;
        }
      });
      const revokeLabel = t("connections.revoke", "Revoke consent");
      const revoke = button(revokeLabel, "button danger");
      onClick(revoke, async () => {
        const confirmed = await confirmInApp(
          tf("dialog.revoke.title", "Revoke {bank} consent?", {
            bank: connection.alias
          }),
          t(
            "dialog.revoke.detail",
            "The local session will be deleted and this connection will stop synchronizing. Historical movements and exports are preserved. If remote revocation cannot be confirmed, revoke the consent from the bank or Enable Banking too."
          ),
          t("dialog.revoke.confirm", "Revoke consent")
        );
        if (!confirmed) return;
        operationInProgress = true;
        reconnect.disabled = true;
        revoke.disabled = true;
        revoke.textContent = t("connections.revoking", "Revoking…");
        try {
          const result = await window.kakebo.disconnectBank(connection.id);
          showToast(
            result.remoteRevocationAttempted && result.remoteRevoked
              ? t(
                  "toast.connectionRevoked",
                  "Bank consent revoked. Historical movements were preserved."
                )
              : t(
                  "toast.connectionRevokedLocalOnly",
                  "Local connection revoked. Historical movements were preserved; also revoke the consent from the bank or Enable Banking."
                )
          );
          await refresh();
        } catch (error) {
          showToast(errorMessage(error), true);
        } finally {
          operationInProgress = false;
          reconnect.disabled = false;
          revoke.disabled = false;
          revoke.textContent = revokeLabel;
        }
      });
      action.append(reconnect, revoke);
    }
    row.append(name, validity, action);
    container.append(row);
  }
}

function balanceLabel(account: {
  amount: string | null;
  currency: string | null;
}): string {
  if (account.amount === null) return t("audit.noBalance", "No balance");
  const amount = Number(account.amount);
  if (!Number.isFinite(amount)) {
    return [account.amount, account.currency].filter(Boolean).join(" ");
  }
  try {
    return new Intl.NumberFormat(state.language, {
      style: account.currency ? "currency" : "decimal",
      ...(account.currency ? { currency: account.currency } : {}),
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(amount);
  } catch {
    return [account.amount, account.currency].filter(Boolean).join(" ");
  }
}

function createAuditRun(run: AuditRunView, expanded = false): HTMLElement {
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
  const started = document.createElement("strong");
  started.textContent = localDate(run.startedAt);
  const steps = document.createElement("span");
  steps.textContent = run.steps
    .map((step) => t(`step.${step}`, step))
    .join(" · ");
  title.append(started, steps);
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
      : tf("audit.total", "Total: {amount}", {
          amount: run.totals.map(balanceLabel).join(" + ")
        });
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
    const strong = document.createElement("strong");
    strong.textContent = account.account;
    const bank = document.createElement("span");
    bank.textContent = account.bank;
    name.append(strong, bank);
    const balance = document.createElement("span");
    balance.className = "audit-balance";
    balance.textContent = balanceLabel(account);
    if (account.referenceDate) {
      balance.title = tf("audit.balanceDate", "Balance date: {date}", {
        date: account.referenceDate
      });
    }
    row.append(name, balance);
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
    message.textContent = errorMessage(run.error);
    error.append(message);
  }
  article.append(header, error, accounts);
  return article;
}

function renderRecentRuns(): void {
  element("runs-this-year").textContent = String(state.runsThisYear);
  element<HTMLSelectElement>("recent-runs-limit").value = String(
    state.auditHistoryLimit
  );
  const container = element<HTMLDivElement>("recent-runs");
  container.replaceChildren();
  if (state.recentRuns.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = t(
      "audit.empty",
      "There are no synchronization runs in the local audit history."
    );
    container.append(empty);
    return;
  }
  container.append(
    ...state.recentRuns.map((run, index) => createAuditRun(run, index === 0))
  );
}

function textInput(
  value: string,
  className = "input",
  type: "text" | "number" = "text"
): HTMLInputElement {
  const input = document.createElement("input");
  input.type = type;
  input.className = className;
  input.value = value;
  return input;
}

function checkbox(checked: boolean, label: string): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "checkbox";
  input.className = "table-check";
  input.checked = checked;
  input.setAttribute("aria-label", label);
  return input;
}

function renderAccounts(): void {
  const body = element<HTMLTableSectionElement>("accounts-body");
  body.replaceChildren();
  if (state.accounts.length === 0) {
    const row = body.insertRow();
    const cell = row.insertCell();
    cell.colSpan = 5;
    cell.className = "empty-state";
    cell.textContent = t(
      "accounts.empty",
      "Synchronize accounts before configuring aliases."
    );
    return;
  }
  for (const account of state.accounts) {
    const row = body.insertRow();
    row.dataset["accountId"] = account.id;

    const nameCell = row.insertCell();
    const name = document.createElement("div");
    name.className = "table-primary";
    const strong = document.createElement("strong");
    strong.textContent = account.alias || account.account;
    const bank = document.createElement("span");
    bank.textContent = `${account.bank} · ${account.account}`;
    name.append(strong, bank);
    nameCell.append(name);

    row.insertCell().textContent = account.masked ?? "—";
    const aliasCell = row.insertCell();
    const aliasInput = textInput(account.alias);
    aliasInput.dataset["field"] = "alias";
    aliasInput.maxLength = 120;
    aliasInput.placeholder = account.account;
    aliasCell.append(aliasInput);

    const syncCell = row.insertCell();
    const syncInput = checkbox(
      account.syncEnabled,
      tf("accounts.syncAria", "Synchronize {account}", {
        account: account.account
      })
    );
    syncInput.dataset["field"] = "syncEnabled";
    syncInput.disabled = !account.providerActive;
    syncCell.append(syncInput);

    const exportCell = row.insertCell();
    const exportInput = checkbox(
      account.exportEnabled,
      tf("accounts.exportAria", "Export {account}", {
        account: account.account
      })
    );
    exportInput.dataset["field"] = "exportEnabled";
    exportCell.append(exportInput);
  }
}

function optionSelect<T extends string>(
  values: readonly T[],
  selected: T,
  labels: Partial<Record<T, string>> = {}
): HTMLSelectElement {
  const select = document.createElement("select");
  select.className = "select";
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = labels[value] ?? value;
    option.selected = selected === value;
    select.append(option);
  }
  return select;
}

function renderCardFiles(): void {
  const body = element<HTMLTableSectionElement>("card-files-body");
  body.replaceChildren();
  const profiles = state.cardImportProfiles.filter((profile) => profile.enabled);
  if (selectedCardFiles.length === 0) {
    const row = body.insertRow();
    const cell = row.insertCell();
    cell.colSpan = 3;
    cell.className = "empty-state";
    cell.textContent = t(
      "cards.noFiles",
      "No workbooks selected. Choose one or more XLSX statements."
    );
    return;
  }
  selectedCardFiles.forEach((file, index) => {
    if (!profiles.some((profile) => profile.id === file.profileId)) {
      file.profileId = profiles[0]?.id ?? "";
    }
    const row = body.insertRow();
    row.dataset["cardFileIndex"] = String(index);
    const includeCell = row.insertCell();
    const include = checkbox(
      file.included,
      tf("cards.includeFileAria", "Include {file}", { file: file.name })
    );
    include.addEventListener("change", () => {
      file.included = include.checked;
    });
    includeCell.append(include);

    const fileCell = row.insertCell();
    const fileName = document.createElement("div");
    fileName.className = "table-primary";
    const name = document.createElement("strong");
    name.textContent = file.name;
    const path = document.createElement("span");
    path.textContent = file.path;
    fileName.append(name, path);
    fileCell.append(fileName);

    const profileCell = row.insertCell();
    const select = document.createElement("select");
    select.className = "select";
    for (const profile of profiles) {
      const option = document.createElement("option");
      option.value = profile.id;
      option.textContent = `${profile.name} · ${profile.cardName}`;
      option.selected = profile.id === file.profileId;
      select.append(option);
    }
    select.disabled = profiles.length === 0;
    select.addEventListener("change", () => {
      file.profileId = select.value;
    });
    profileCell.append(select);
  });
}

function renderCardProfiles(): void {
  const body = element<HTMLTableSectionElement>("card-profiles-body");
  body.replaceChildren();
  state.cardImportProfiles.forEach((profile, index) => {
    const row = body.insertRow();
    row.dataset["cardProfileIndex"] = String(index);
    row.dataset["cardProfileId"] = profile.id;

    const enabledCell = row.insertCell();
    const enabled = checkbox(
      profile.enabled,
      tf("cards.enableProfileAria", "Enable {profile}", {
        profile: profile.name
      })
    );
    enabled.dataset["field"] = "enabled";
    enabledCell.append(enabled);

    const addText = (
      value: string,
      field: string,
      options: { required?: boolean; maxLength?: number } = {}
    ): void => {
      const cell = row.insertCell();
      const input = textInput(value);
      input.dataset["field"] = field;
      input.required = options.required ?? false;
      if (options.maxLength) input.maxLength = options.maxLength;
      cell.append(input);
    };
    addText(profile.name, "name", { required: true, maxLength: 120 });
    addText(profile.bankName, "bankName", { required: true, maxLength: 120 });
    addText(profile.cardName, "cardName", { required: true, maxLength: 120 });
    addText(profile.sheet, "sheet", { maxLength: 120 });

    const startCell = row.insertCell();
    const startRow = textInput(String(profile.startRow), "input", "number");
    startRow.min = "1";
    startRow.max = "1048576";
    startRow.dataset["field"] = "startRow";
    startCell.append(startRow);

    addText(profile.columns.date, "date", { required: true, maxLength: 3 });
    addText(profile.columns.description, "description", {
      required: true,
      maxLength: 3
    });
    addText(profile.columns.valueDate ?? "", "valueDate", { maxLength: 3 });
    addText(profile.columns.amount, "amount", { required: true, maxLength: 3 });

    const dateFormatCell = row.insertCell();
    const dateFormat = optionSelect(
      ["auto", "dmy", "ymd", "mdy"] as const,
      profile.dateFormat,
      {
        auto: t("common.auto", "Auto"),
        dmy: "DD/MM/YYYY",
        ymd: "YYYY-MM-DD",
        mdy: "MM/DD/YYYY"
      }
    );
    dateFormat.dataset["field"] = "dateFormat";
    dateFormatCell.append(dateFormat);

    const decimalCell = row.insertCell();
    const decimal = optionSelect(
      ["auto", ",", "."] as const,
      profile.decimalSeparator,
      { auto: t("common.auto", "Auto") }
    );
    decimal.dataset["field"] = "decimalSeparator";
    decimalCell.append(decimal);

    const invertCell = row.insertCell();
    const invert = checkbox(
      profile.invertAmountSign,
      tf("cards.invertAria", "Invert amount signs for {profile}", {
        profile: profile.name
      })
    );
    invert.dataset["field"] = "invertAmountSign";
    invertCell.append(invert);

    addText(profile.currency, "currency", { required: true, maxLength: 3 });

    const deleteCell = row.insertCell();
    const remove = button("×", "icon-button");
    remove.disabled = state.cardImportProfiles.length <= 1;
    remove.setAttribute(
      "aria-label",
      tf("cards.deleteProfileAria", "Delete profile {number}", {
        number: index + 1
      })
    );
    remove.addEventListener("click", () => {
      const profiles = cardProfileValues();
      profiles.splice(index, 1);
      state.cardImportProfiles = profiles;
      renderCardProfiles();
      renderCardFiles();
    });
    deleteCell.append(remove);
  });
}

function cardProfileValues(): CardImportProfile[] {
  return [
    ...document.querySelectorAll<HTMLTableRowElement>(
      "#card-profiles-body tr[data-card-profile-index]"
    )
  ].map((row) => {
    const readInput = (field: string): HTMLInputElement => {
      const value = row.querySelector(`[data-field="${field}"]`);
      if (!(value instanceof HTMLInputElement)) {
        throw new Error(`Missing card profile input: ${field}`);
      }
      return value;
    };
    const readSelect = (field: string): HTMLSelectElement => {
      const value = row.querySelector(`[data-field="${field}"]`);
      if (!(value instanceof HTMLSelectElement)) {
        throw new Error(`Missing card profile select: ${field}`);
      }
      return value;
    };
    const valueDate = readInput("valueDate").value.trim().toUpperCase();
    return {
      id: row.dataset["cardProfileId"] ?? "",
      enabled: readInput("enabled").checked,
      name: readInput("name").value,
      bankName: readInput("bankName").value,
      cardName: readInput("cardName").value,
      sheet: readInput("sheet").value,
      startRow: Number(readInput("startRow").value),
      columns: {
        date: readInput("date").value.trim().toUpperCase(),
        description: readInput("description").value.trim().toUpperCase(),
        valueDate: valueDate || null,
        amount: readInput("amount").value.trim().toUpperCase()
      },
      dateFormat: readSelect(
        "dateFormat"
      ).value as CardImportProfile["dateFormat"],
      decimalSeparator: readSelect(
        "decimalSeparator"
      ).value as CardImportProfile["decimalSeparator"],
      invertAmountSign: readInput("invertAmountSign").checked,
      currency: readInput("currency").value.trim().toUpperCase()
    };
  });
}

function ruleOperator(value: CategorizationRule["operator"]): HTMLSelectElement {
  const select = document.createElement("select");
  select.className = "select";
  select.dataset["field"] = "operator";
  for (const optionValue of ["contains", "equals", "startsWith", "regex"] as const) {
    const option = document.createElement("option");
    option.value = optionValue;
    option.textContent = t(`operator.${optionValue}`, optionValue);
    option.selected = optionValue === value;
    select.append(option);
  }
  return select;
}

function selectFromValues(
  values: string[],
  current: string,
  placeholder: string
): HTMLSelectElement {
  const select = document.createElement("select");
  select.className = "select";
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = placeholder;
  select.append(empty);
  const unique = [...new Set([...values, ...(current ? [current] : [])])];
  for (const value of unique) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    option.selected = value === current;
    select.append(option);
  }
  return select;
}

function subcategoriesFor(categoryName: string): string[] {
  return (
    state.categories.find((category) => category.name === categoryName)
      ?.subcategories ?? []
  );
}

function dragHandle(label: string): HTMLButtonElement {
  const handle = button("⋮⋮", "drag-handle");
  handle.draggable = true;
  handle.setAttribute("aria-label", label);
  handle.title = label;
  return handle;
}

function enableRowDrop(
  row: HTMLTableRowElement,
  index: number,
  move: (from: number, to: number) => void
): void {
  row.addEventListener("dragover", (event) => {
    if (!event.dataTransfer?.types.includes("text/x-kakebo-row")) return;
    event.preventDefault();
    row.classList.add("is-drop-target");
  });
  row.addEventListener("dragleave", () => row.classList.remove("is-drop-target"));
  row.addEventListener("drop", (event) => {
    event.preventDefault();
    row.classList.remove("is-drop-target");
    const source = event.dataTransfer?.getData("text/x-kakebo-row");
    if (source === undefined || source === "") return;
    const from = Number(source);
    if (!Number.isInteger(from)) return;
    const bounds = row.getBoundingClientRect();
    const dropAfter = event.clientY >= bounds.top + bounds.height / 2;
    const to = rowDropInsertionIndex(from, index, dropAfter);
    if (from !== to) move(from, to);
  });
}

function activateDrag(
  handle: HTMLButtonElement,
  row: HTMLTableRowElement,
  index: number
): void {
  handle.addEventListener("dragstart", (event) => {
    row.classList.add("is-dragging");
    event.dataTransfer?.setData("text/x-kakebo-row", String(index));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  });
  handle.addEventListener("dragend", () => {
    row.classList.remove("is-dragging");
    for (const candidate of document.querySelectorAll(".is-drop-target")) {
      candidate.classList.remove("is-drop-target");
    }
  });
}

function moveRule(from: number, to: number): void {
  const rules = ruleValues();
  const [moved] = rules.splice(from, 1);
  if (!moved) return;
  rules.splice(to, 0, moved);
  state.rules = rules.map((rule, index) => ({
    ...rule,
    priority: (index + 1) * 10
  }));
  renderRules();
}

function moveExclusion(from: number, to: number): void {
  const exclusions = exclusionValues();
  const [moved] = exclusions.splice(from, 1);
  if (!moved) return;
  exclusions.splice(to, 0, moved);
  state.exclusions = exclusions.map((exclusion, index) => ({
    ...exclusion,
    priority: (index + 1) * 10
  }));
  renderExclusions();
}

function renderExclusions(): void {
  const body = element<HTMLTableSectionElement>("exclusions-body");
  body.replaceChildren();
  if (state.exclusions.length === 0) {
    const row = body.insertRow();
    const cell = row.insertCell();
    cell.colSpan = 6;
    cell.className = "empty-state";
    cell.textContent = t(
      "exclusions.empty",
      "Add an exclusion to leave matching movements uncategorized."
    );
    return;
  }
  state.exclusions.forEach((exclusion, index) => {
    const row = body.insertRow();
    row.dataset["exclusionIndex"] = String(index);
    const handleCell = row.insertCell();
    const handle = dragHandle(
      tf("exclusions.dragAria", "Move exclusion {number}", {
        number: index + 1
      })
    );
    activateDrag(handle, row, index);
    handleCell.append(handle);
    enableRowDrop(row, index, moveExclusion);

    const numberCell = row.insertCell();
    numberCell.className = "row-number";
    numberCell.textContent = String(index + 1);

    const enabledCell = row.insertCell();
    const enabled = checkbox(
      exclusion.enabled,
      tf("exclusions.enableAria", "Enable exclusion {number}", {
        number: index + 1
      })
    );
    enabled.dataset["field"] = "enabled";
    enabledCell.append(enabled);

    row.insertCell().append(ruleOperator(exclusion.operator));

    const valueCell = row.insertCell();
    const value = textInput(exclusion.value, "input rule-value");
    value.dataset["field"] = "value";
    value.required = true;
    valueCell.append(value);

    const deleteCell = row.insertCell();
    const remove = button("Ã—", "icon-button");
    remove.setAttribute(
      "aria-label",
      tf("exclusions.deleteAria", "Delete exclusion {number}", {
        number: index + 1
      })
    );
    remove.addEventListener("click", () => {
      const pending = exclusionValues();
      pending.splice(index, 1);
      state.exclusions = pending;
      renderExclusions();
    });
    deleteCell.append(remove);
  });
}

function renderRules(): void {
  const body = element<HTMLTableSectionElement>("rules-body");
  body.replaceChildren();
  if (state.rules.length === 0) {
    const row = body.insertRow();
    const cell = row.insertCell();
    cell.colSpan = 8;
    cell.className = "empty-state";
    cell.textContent = t("rules.empty", "Add the first rule to get started.");
    return;
  }
  state.rules.forEach((rule, index) => {
    const row = body.insertRow();
    row.dataset["ruleIndex"] = String(index);

    const handleCell = row.insertCell();
    const handle = dragHandle(
      tf("rules.dragAria", "Move rule {number}", { number: index + 1 })
    );
    activateDrag(handle, row, index);
    handleCell.append(handle);
    enableRowDrop(row, index, moveRule);

    const numberCell = row.insertCell();
    numberCell.className = "row-number";
    numberCell.textContent = String(index + 1);

    const enabledCell = row.insertCell();
    const enabled = checkbox(
      rule.enabled,
      tf("rules.enableAria", "Enable rule {number}", { number: index + 1 })
    );
    enabled.dataset["field"] = "enabled";
    enabledCell.append(enabled);

    row.insertCell().append(ruleOperator(rule.operator));

    const valueCell = row.insertCell();
    const value = textInput(rule.value, "input rule-value");
    value.dataset["field"] = "value";
    value.required = true;
    valueCell.append(value);

    const categoryCell = row.insertCell();
    const category = selectFromValues(
      state.categories.map((item) => item.name),
      rule.category,
      t("rules.selectCategory", "Select category")
    );
    category.dataset["field"] = "category";
    category.required = true;
    categoryCell.append(category);

    const subcategoryCell = row.insertCell();
    const subcategory = selectFromValues(
      subcategoriesFor(rule.category),
      rule.subcategory ?? "",
      t("rules.noSubcategory", "No subcategory")
    );
    subcategory.dataset["field"] = "subcategory";
    subcategoryCell.append(subcategory);
    category.addEventListener("change", () => {
      const replacement = selectFromValues(
        subcategoriesFor(category.value),
        "",
        t("rules.noSubcategory", "No subcategory")
      );
      replacement.dataset["field"] = "subcategory";
      subcategory.replaceWith(replacement);
    });

    const deleteCell = row.insertCell();
    const remove = button("×", "icon-button");
    remove.setAttribute(
      "aria-label",
      tf("rules.deleteAria", "Delete rule {number}", { number: index + 1 })
    );
    remove.addEventListener("click", () => {
      const pendingRules = ruleValues();
      pendingRules.splice(index, 1);
      state.rules = pendingRules;
      renderRules();
    });
    deleteCell.append(remove);
  });
}

function renderCategories(): void {
  const body = element<HTMLTableSectionElement>("categories-body");
  body.replaceChildren();
  if (state.categories.length === 0) {
    const row = body.insertRow();
    const cell = row.insertCell();
    cell.colSpan = 3;
    cell.className = "empty-state";
    cell.textContent = t(
      "categories.empty",
      "Add a category to populate the rule picklists."
    );
    return;
  }
  state.categories.forEach((category, index) => {
    const row = body.insertRow();
    row.dataset["categoryIndex"] = String(index);
    const nameCell = row.insertCell();
    const name = textInput(category.name);
    name.dataset["field"] = "name";
    name.required = true;
    nameCell.append(name);
    const valuesCell = row.insertCell();
    const values = textInput(category.subcategories.join(", "));
    values.dataset["field"] = "subcategories";
    values.placeholder = t(
      "categories.placeholder",
      "Groceries, Restaurants, Transport"
    );
    valuesCell.append(values);
    const deleteCell = row.insertCell();
    const remove = button("×", "icon-button");
    remove.setAttribute(
      "aria-label",
      tf("categories.deleteAria", "Delete category {number}", {
        number: index + 1
      })
    );
    remove.addEventListener("click", () => {
      const pending = categoryValues();
      pending.splice(index, 1);
      state.categories = pending;
      renderCategories();
    });
    deleteCell.append(remove);
  });
}

function exportFieldLabel(field: ExportField): string {
  return t(`export.field.${field}`, field);
}

function moveExportColumn(from: number, to: number): void {
  const settings = exportValues();
  if (!settings.columns[from]?.enabled || !settings.columns[to]?.enabled) return;
  const [moved] = settings.columns.splice(from, 1);
  if (!moved) return;
  settings.columns.splice(to, 0, moved);
  state.exportSettings = settings;
  renderExportSettings();
}

function renderExportSettings(): void {
  const settings = state.exportSettings;
  element<HTMLSelectElement>("export-format").value = settings.format;
  element<HTMLSelectElement>("csv-field-separator").value =
    settings.csv.fieldSeparator;
  element<HTMLSelectElement>("csv-decimal-separator").value =
    settings.csv.decimalSeparator;
  element<HTMLSelectElement>("csv-date-format").value =
    settings.csv.dateFormat;
  element<HTMLInputElement>("csv-bom").checked = settings.csv.includeBom;
  document.body.dataset["exportFormat"] = settings.format;

  const body = element<HTMLTableSectionElement>("export-columns-body");
  body.replaceChildren();
  settings.columns.forEach((column, index) => {
    const row = body.insertRow();
    row.dataset["exportColumnIndex"] = String(index);
    const handleCell = row.insertCell();
    if (column.enabled) {
      const handle = dragHandle(tf("export.dragAria", "Move export column {number}", { number: index + 1 }));
      activateDrag(handle, row, index);
      handleCell.append(handle);
      enableRowDrop(row, index, moveExportColumn);
    }
    const numberCell = row.insertCell();
    numberCell.className = "row-number";
    numberCell.textContent = column.enabled
      ? String(settings.columns.slice(0, index + 1).filter((item) => item.enabled).length)
      : "";
    const enabledCell = row.insertCell();
    const enabled = checkbox(
      column.enabled,
      tf("export.includeAria", "Include {field}", {
        field: exportFieldLabel(column.field)
      })
    );
    enabled.dataset["field"] = "enabled";
    enabled.addEventListener("change", () => {
      state.exportSettings = exportValues();
      renderExportSettings();
    });
    enabledCell.append(enabled);
    const fieldCell = row.insertCell();
    fieldCell.textContent = exportFieldLabel(column.field);
    fieldCell.dataset["exportField"] = column.field;
    const headerCell = row.insertCell();
    const header = textInput(column.header);
    header.dataset["field"] = "header";
    header.required = true;
    header.maxLength = 120;
    headerCell.append(header);
  });
}

function renderPaths(): void {
  element("path-root").textContent = state.paths.root;
  element("path-export").textContent = state.paths.exportDirectory;
  element("path-database").textContent = state.paths.database;
  element<HTMLInputElement>("scheduled-command").value = state.scheduledCommand;
}

function renderAll(): void {
  element("sidebar-version").textContent = tf(
    "sidebar.version",
    "v{version} · Local HTTPS",
    { version: state.version }
  );
  const serverStatus = element("server-status");
  const serverStatusText = serverStatus.lastElementChild;
  if (serverStatusText) {
    serverStatusText.textContent = state.callbackReady
      ? t("callback.ready", "HTTPS callback ready")
      : t("callback.unavailable", "HTTPS callback unavailable");
  }
  renderSummary();
  renderConnections();
  renderRecentRuns();
  renderAccounts();
  renderCardFiles();
  renderCardProfiles();
  renderRules();
  renderExclusions();
  renderCategories();
  renderExportSettings();
  renderPaths();
  renderProgress();
}

async function refresh(): Promise<void> {
  state = await window.kakebo.bootstrap();
  applyTranslations();
  renderAll();
  rememberAllSavedTabs();
}

function selectedSteps(): SyncStep[] {
  return [...document.querySelectorAll<HTMLInputElement>("[data-sync-step]")]
    .filter((input) => input.checked)
    .map((input) => input.value as SyncStep);
}

function applyPreset(value: string): void {
  const selected =
    value === "full"
      ? new Set(["accounts", "balances", "transactions", "export"])
      : value === "transactions"
        ? new Set(["transactions", "export"])
        : value === "export"
          ? new Set(["export"])
          : undefined;
  if (!selected) return;
  for (const input of document.querySelectorAll<HTMLInputElement>("[data-sync-step]")) {
    input.checked = selected.has(input.value);
  }
}

function resetProgress(): void {
  progressEntries = [];
  element<HTMLElement>("run-result").hidden = true;
  const status = element("run-status");
  status.className = "status-badge warning";
  status.textContent = t("progress.running", "Running");
  element<HTMLElement>("progress-fill").style.width = "0%";
  renderProgress();
}

function progressLabel(event: SyncProgressEvent): string {
  if (event.type === "run-started") {
    return t("progress.runStarted", "Synchronization started");
  }
  if (event.type === "reauthorization-required") {
    return t(
      "progress.reauthorization",
      "The session expired. Complete the connection in your browser."
    );
  }
  if (event.type === "run-completed") {
    return t("progress.runCompleted", "Synchronization completed");
  }
  if (event.type === "run-failed") {
    return tf("progress.failed", "Error: {message}", { message: event.message });
  }
  const step = event.step
    ? t(`step.${event.step}`, event.step)
    : t("progress.step", "Step");
  return event.type === "step-started"
    ? tf("progress.stepRunning", "{step}: running", { step })
    : tf("progress.stepCompleted", "{step}: completed", { step });
}

function progressKey(event: SyncProgressEvent): string {
  if (event.type.startsWith("run-")) return event.type;
  return event.step ? `step-${event.step}` : event.type;
}

function renderProgress(): void {
  const list = element<HTMLOListElement>("progress-list");
  list.replaceChildren();
  if (progressEntries.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-state";
    empty.textContent = t("progress.empty", "Set the dates and select start.");
    list.append(empty);
  }
  for (const entry of progressEntries) {
    const item = document.createElement("li");
    const marker = document.createElement("span");
    marker.className = "progress-marker";
    marker.textContent =
      entry.event.type === "run-failed"
        ? "!"
        : entry.event.type === "reauthorization-required"
          ? "↗"
          : entry.event.type.includes("completed")
            ? "✓"
            : "·";
    const text = document.createElement("span");
    text.textContent = progressLabel(entry.event);
    const time = document.createElement("time");
    time.textContent = new Intl.DateTimeFormat(state.language, {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    }).format(entry.time);
    item.append(marker, text, time);
    list.append(item);
  }
}

function handleProgress(event: SyncProgressEvent): void {
  const key = progressKey(event);
  const existing = progressEntries.findIndex((entry) => entry.key === key);
  const entry = { key, event, time: new Date() };
  if (existing >= 0) {
    progressEntries.splice(existing, 1, entry);
  } else {
    progressEntries.push(entry);
  }
  renderProgress();
  const percent =
    event.type === "run-completed"
      ? 100
      : Math.round((event.completedSteps / Math.max(1, event.totalSteps)) * 100);
  element<HTMLElement>("progress-fill").style.width = `${percent}%`;
}

function handleAuthorization(result: AuthorizationUiResult): void {
  showToast(
    result.status === "authorized"
      ? tf("toast.connectionCompleted", "{bank}: connection completed.", {
          bank: result.bankName
        })
      : tf("toast.connectionFailed", "{bank}: {message}", {
          bank: result.bankName,
          message:
            result.message ??
            t("connections.notCompleted", "connection was not completed")
        }),
    result.status !== "authorized"
  );
}

function accountValues(): EditableAccount[] {
  return state.accounts.map((account) => {
    const row = document.querySelector<HTMLTableRowElement>(
      `#accounts-body tr[data-account-id="${CSS.escape(account.id)}"]`
    );
    if (!row) return account;
    return {
      ...account,
      alias:
        row.querySelector<HTMLInputElement>('[data-field="alias"]')?.value ?? "",
      syncEnabled:
        row.querySelector<HTMLInputElement>('[data-field="syncEnabled"]')?.checked ??
        false,
      exportEnabled:
        row.querySelector<HTMLInputElement>('[data-field="exportEnabled"]')?.checked ??
        false
    };
  });
}

function ruleValues(): CategorizationRule[] {
  const rows = [
    ...document.querySelectorAll<HTMLTableRowElement>(
      "#rules-body tr[data-rule-index]"
    )
  ];
  return rows.map((row, index) => {
    const readInput = (field: string): HTMLInputElement => {
      const input = row.querySelector(`[data-field="${field}"]`);
      if (!(input instanceof HTMLInputElement)) {
        throw new Error(`Missing rule input: ${field}`);
      }
      return input;
    };
    const readSelect = (field: string): HTMLSelectElement => {
      const input = row.querySelector(`[data-field="${field}"]`);
      if (!(input instanceof HTMLSelectElement)) {
        throw new Error(`Missing rule select: ${field}`);
      }
      return input;
    };
    const subcategory = readSelect("subcategory").value.trim();
    return {
      enabled: readInput("enabled").checked,
      priority: (index + 1) * 10,
      field: "descriptionNormalized",
      operator: readSelect("operator").value as CategorizationRule["operator"],
      value: readInput("value").value,
      category: readSelect("category").value,
      ...(subcategory ? { subcategory } : {})
    };
  });
}

function exclusionValues(): CategorizationExclusion[] {
  const rows = [
    ...document.querySelectorAll<HTMLTableRowElement>(
      "#exclusions-body tr[data-exclusion-index]"
    )
  ];
  return rows.map((row, index) => {
    const enabled = row.querySelector<HTMLInputElement>('[data-field="enabled"]');
    const operator = row.querySelector<HTMLSelectElement>('[data-field="operator"]');
    const value = row.querySelector<HTMLInputElement>('[data-field="value"]');
    if (!enabled || !operator || !value) {
      throw new Error("Missing exclusion input.");
    }
    return {
      enabled: enabled.checked,
      priority: (index + 1) * 10,
      field: "descriptionNormalized",
      operator: operator.value as CategorizationExclusion["operator"],
      value: value.value
    };
  });
}

function categoryValues(): CategoryDefinition[] {
  return [
    ...document.querySelectorAll<HTMLTableRowElement>(
      "#categories-body tr[data-category-index]"
    )
  ].map((row) => {
    const name =
      row.querySelector<HTMLInputElement>('[data-field="name"]')?.value ?? "";
    const subcategories =
      row.querySelector<HTMLInputElement>('[data-field="subcategories"]')?.value ??
      "";
    return {
      name,
      subcategories: subcategories
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    };
  });
}

function exportValues(normalizeOrder = false): ExportSettings {
  const columns = [
    ...document.querySelectorAll<HTMLTableRowElement>(
      "#export-columns-body tr[data-export-column-index]"
    )
  ].map((row) => {
    const field = row
      .querySelector<HTMLElement>("[data-export-field]")
      ?.dataset["exportField"] as ExportField | undefined;
    const enabled = row.querySelector<HTMLInputElement>('[data-field="enabled"]');
    const header = row.querySelector<HTMLInputElement>('[data-field="header"]');
    if (!field || !enabled || !header) {
      throw new Error("An export column is incomplete.");
    }
    return { field, enabled: enabled.checked, header: header.value };
  });
  const orderedColumns = normalizeOrder
    ? [
        ...columns.filter((column) => column.enabled),
        ...columns.filter((column) => !column.enabled)
      ]
    : columns;
  return {
    format: element<HTMLSelectElement>("export-format").value as "csv" | "xlsx",
    csv: {
      fieldSeparator: element<HTMLSelectElement>("csv-field-separator")
        .value as ExportSettings["csv"]["fieldSeparator"],
      decimalSeparator: element<HTMLSelectElement>("csv-decimal-separator")
        .value as ExportSettings["csv"]["decimalSeparator"],
      dateFormat: element<HTMLSelectElement>("csv-date-format")
        .value as ExportSettings["csv"]["dateFormat"],
      includeBom: element<HTMLInputElement>("csv-bom").checked
    },
    columns: orderedColumns
  };
}

function pageTitle(tab: string): string {
  return t(`nav.${tab}`, "Kakebo Harvester");
}

const editableTabs = ["accounts", "cards", "categories", "export"] as const;
type EditableTab = (typeof editableTabs)[number];

function isEditableTab(tab: string): tab is EditableTab {
  return editableTabs.includes(tab as EditableTab);
}

function tabSnapshot(tab: EditableTab): string {
  if (tab === "accounts") return JSON.stringify(accountValues());
  if (tab === "cards") return JSON.stringify(cardProfileValues());
  if (tab === "categories") {
    return JSON.stringify({
      exclusions: exclusionValues(),
      rules: ruleValues(),
      categories: categoryValues()
    });
  }
  return JSON.stringify(exportValues());
}

function rememberSavedTab(tab: EditableTab): void {
  savedTabSnapshots.set(tab, tabSnapshot(tab));
}

function rememberAllSavedTabs(): void {
  for (const tab of editableTabs) rememberSavedTab(tab);
}

function tabHasUnsavedChanges(tab: string): tab is EditableTab {
  return (
    isEditableTab(tab) &&
    savedTabSnapshots.get(tab) !== tabSnapshot(tab)
  );
}

function unsavedTabs(): EditableTab[] {
  return editableTabs.filter((tab) => tabHasUnsavedChanges(tab));
}

async function saveTab(tab: EditableTab, notify = true): Promise<void> {
  if (tab === "accounts") {
    state.accounts = await window.kakebo.saveAccounts(accountValues());
    renderAccounts();
    renderSummary();
  } else if (tab === "cards") {
    state.cardImportProfiles = await window.kakebo.saveCardImportProfiles(
      cardProfileValues()
    );
    renderCardProfiles();
    renderCardFiles();
  } else if (tab === "categories") {
    const categories = categoryValues();
    const rules = ruleValues();
    const exclusions = exclusionValues();
    state.categories = await window.kakebo.saveCategories(categories);
    const saved = await window.kakebo.saveRules({ exclusions, rules });
    state.exclusions = saved.exclusions;
    state.rules = saved.rules;
    renderCategories();
    renderRules();
    renderExclusions();
  } else {
    state.exportSettings = await window.kakebo.saveExportSettings(
      exportValues(true)
    );
    renderExportSettings();
  }
  rememberSavedTab(tab);
  if (notify) {
    showToast(t("toast.changesSaved", "Changes saved."));
  }
}

function setupNavigation(): void {
  for (const item of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
    item.addEventListener("click", () => {
      const tab = item.dataset["tab"];
      if (!tab) return;
      const active = document.querySelector<HTMLButtonElement>(
        "[data-tab].is-active"
      )?.dataset["tab"];
      if (
        active &&
        active !== tab &&
        (tabHasUnsavedChanges(active) || operationInProgress)
      ) {
        void confirmNavigation(active, tab);
        return;
      }
      activateTab(tab);
    });
  }
}

function activateTab(tab: string): void {
  for (const item of document.querySelectorAll<HTMLButtonElement>("[data-tab]")) {
    item.classList.toggle("is-active", item.dataset["tab"] === tab);
  }
  for (const view of document.querySelectorAll<HTMLElement>(".view")) {
    view.classList.toggle("is-visible", view.id === `view-${tab}`);
  }
  element("page-title").textContent = pageTitle(tab);
}

async function confirmNavigation(from: string, to: string): Promise<void> {
  if (operationInProgress) {
    const proceed = await confirmInApp(
      t("dialog.operationNavigation.title", "Operation in progress"),
      t(
        "dialog.operationNavigation.detail",
        "The operation will continue in the background if you leave this page."
      ),
      t("dialog.operationNavigation.confirm", "Leave page")
    );
    if (!proceed) return;
  }
  if (!tabHasUnsavedChanges(from)) {
    activateTab(to);
    return;
  }
  const choice = await showAppModal({
    title: t("dialog.unsavedNavigation.title", "Unsaved changes"),
    detail: t(
      "dialog.unsavedNavigation.detail",
      "Save the changes on this page before leaving?"
    ),
    confirmLabel: t("dialog.unsaved.saveAndContinue", "Save and continue"),
    discardLabel: t("dialog.unsaved.discardAndContinue", "Discard and continue")
  });
  if (choice === "cancel") return;
  if (choice === "confirm") {
    try {
      await saveTab(from);
    } catch (error) {
      showToast(errorMessage(error), true);
      return;
    }
  } else {
    await refresh();
  }
  activateTab(to);
}

function refreshCurrentPageTitle(): void {
  const active = document.querySelector<HTMLButtonElement>(
    "[data-tab].is-active"
  );
  element("page-title").textContent = pageTitle(active?.dataset["tab"] ?? "sync");
}

const doctorCheckKeys: Record<string, string> = {
  "Clave privada": "doctor.check.privateKey",
  "Certificado HTTPS local": "doctor.check.httpsCertificate",
  "Contraseña HTTPS local": "doctor.check.httpsPassphrase",
  "Directorio SQLite": "doctor.check.sqliteDirectory",
  "Directorio de exportación": "doctor.check.exportDirectory",
  "Directorio raw": "doctor.check.rawDirectory",
  "Aislamiento de entorno": "doctor.check.environmentIsolation"
};

const doctorDetailKeys: Record<string, string> = {
  legible: "doctor.detail.readable",
  "no se puede leer": "doctor.detail.unreadable",
  escribible: "doctor.detail.writable",
  "no se puede escribir": "doctor.detail.unwritable",
  "aplicación accesible": "doctor.detail.applicationAccessible",
  "autenticación rechazada; comprueba el application ID, el PEM y el entorno":
    "doctor.detail.authenticationRejected",
  "el PEM no permite generar un JWT RS256 válido": "doctor.detail.invalidPem",
  "cadena TLS no confiable; configura NODE_USE_SYSTEM_CA=1":
    "doctor.detail.untrustedTls",
  "sin conectividad o API no disponible": "doctor.detail.apiUnavailable",
  "respuesta inesperada de Enable Banking": "doctor.detail.unexpectedResponse"
};

function localizedDoctorValue(
  value: string,
  keys: Record<string, string>
): string {
  const key = keys[value];
  return key ? t(key, value) : value;
}

function setupActions(): void {
  element<HTMLSelectElement>("sync-preset").addEventListener("change", (event) =>
    applyPreset((event.currentTarget as HTMLSelectElement).value)
  );
  for (const input of document.querySelectorAll<HTMLInputElement>("[data-sync-step]")) {
    input.addEventListener("change", () => {
      element<HTMLSelectElement>("sync-preset").value = "custom";
    });
  }
  element<HTMLSelectElement>("recent-runs-limit").addEventListener(
    "change",
    (event) => {
      void (async () => {
        const select = event.currentTarget as HTMLSelectElement;
        select.disabled = true;
        try {
          const limit = Number(select.value) as
            | 5
            | 10
            | 20
            | 50
            | 100;
          state.recentRuns = await window.kakebo.setAuditHistoryLimit(limit);
          state.auditHistoryLimit = limit;
          renderRecentRuns();
        } catch (error) {
          select.value = String(state.auditHistoryLimit);
          showToast(errorMessage(error), true);
        } finally {
          select.disabled = false;
        }
      })();
    }
  );

  onClick(element<HTMLButtonElement>("connect-bank"), async () => {
    try {
      await openConnectionWizard();
    } catch (error) {
      showToast(errorMessage(error), true);
    }
  });

  onClick(element<HTMLButtonElement>("reload-banks"), async () => {
    await loadConnectionBanks();
  });

  element<HTMLSelectElement>("connection-country").addEventListener(
    "change",
    () => {
      void loadConnectionBanks();
    }
  );
  element<HTMLInputElement>("connection-bank-search").addEventListener(
    "input",
    () => renderConnectionBankList()
  );
  element<HTMLSelectElement>("connection-psu-type").addEventListener(
    "change",
    () => renderConnectionBankSelection()
  );
  element<HTMLButtonElement>("connection-wizard-cancel").addEventListener(
    "click",
    closeConnectionWizard
  );
  onClick(element<HTMLButtonElement>("connection-wizard-start"), async () => {
    await startBankConnection();
  });

  onClick(element<HTMLButtonElement>("start-sync"), async () => {
    const start = element<HTMLButtonElement>("start-sync");
    const steps = selectedSteps();
    const accessesBank = steps.some((step) => step !== "export");
    const limited = accessesBank
      ? state.connections.filter(
          (connection) =>
            connection.retryAfterAt &&
            new Date(connection.retryAfterAt).getTime() > Date.now()
        )
      : [];
    let allowRateLimitOverride = false;
    if (limited.length > 0) {
      const retryAt = limited
        .map((connection) => connection.retryAfterAt)
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1);
      if (limited.some((connection) => connection.onlineRetryUsed)) {
        await showAppModal({
          title: t(
            "dialog.onlineRetryUsed.title",
            "Online attempt already used"
          ),
          detail: tf(
            "dialog.onlineRetryUsed.detail",
            "The bank still applies its limit. Try again after {date}.",
            { date: localDate(retryAt ?? "") }
          ),
          confirmLabel: t("common.accept", "OK")
        });
        return;
      }
      const choice = await showAppModal({
        title: t(
          "dialog.onlineRetry.title",
          "Bank request limit active"
        ),
        detail: tf(
          "dialog.onlineRetry.detail",
          "Background access is blocked until {date}. You can make one explicit attempt now as an online request using the real application User-Agent and language.",
          { date: localDate(retryAt ?? "") }
        ),
        confirmLabel: t(
          "dialog.onlineRetry.confirm",
          "Try once as online"
        )
      });
      if (choice !== "confirm") return;
      allowRateLimitOverride = true;
    }
    operationInProgress = true;
    start.disabled = true;
    start.textContent = t("sync.running", "Synchronizing…");
    resetProgress();
    try {
      const result = await window.kakebo.startSync({
        steps,
        dateFrom: element<HTMLInputElement>("date-from").value,
        dateTo: element<HTMLInputElement>("date-to").value,
        ...(allowRateLimitOverride
          ? { allowRateLimitOverride: true }
          : {})
      });
      const status = element("run-status");
      status.className = "status-badge success";
      status.textContent = t("progress.completed", "Completed");
      const summary = element<HTMLElement>("run-result");
      summary.textContent = [
        result.accounts === undefined
          ? null
          : tf("result.accounts", "{count} accounts", {
              count: result.accounts
            }),
        result.balances === undefined
          ? null
          : tf("result.balances", "{count} balances", {
              count: result.balances
            }),
        result.transactions === undefined
          ? null
          : tf("result.movements", "{count} movements received", {
              count: result.transactions.received
            }),
        result.export === undefined
          ? null
          : tf("result.rows", "{count} rows exported", {
              count: result.export.rows
            })
      ]
        .filter((value): value is string => value !== null)
        .join(" · ");
      summary.hidden = false;
      showToast(
        t("toast.syncCompleted", "Synchronization completed successfully.")
      );
      await refresh();
    } catch (error) {
      const status = element("run-status");
      status.className = "status-badge error";
      status.textContent = t("progress.error", "Error");
      showToast(errorMessage(error), true);
      await refresh().catch(() => undefined);
    } finally {
      operationInProgress = false;
      start.disabled = false;
      start.textContent = t("sync.start", "Start synchronization");
    }
  });

  onClick(element<HTMLButtonElement>("open-latest-export"), async () => {
    try {
      await window.kakebo.openPath("export-file");
    } catch (error) {
      showToast(errorMessage(error), true);
    }
  });

  onClick(element<HTMLButtonElement>("clear-exports"), async () => {
    try {
      if (!(await confirmInApp(t("dialog.clearExports.message", "Reset all locally collected financial data?"), t("dialog.clearExports.detail", "This permanently removes exports, movements, balances, raw responses, and execution history. Bank connections, account preferences, and all configuration files are preserved."), t("dialog.clearExports.confirm", "Reset local data")))) return;
      const reset = await window.kakebo.clearExportFiles();
      showToast(
        reset.exportFiles + reset.transactions + reset.balances + reset.synchronizationRuns > 0
          ? tf("toast.localDataReset", "Local data reset: {transactions} movements and {balances} balances removed.", {
              transactions: reset.transactions,
              balances: reset.balances
            })
          : t("toast.noLocalDataReset", "There was no local financial history to remove.")
      );
    } catch (error) {
      showToast(errorMessage(error), true);
    }
  });

  onClick(element<HTMLButtonElement>("open-audit"), async () => {
    try {
      await window.kakebo.openAuditHistory();
    } catch (error) {
      showToast(errorMessage(error), true);
    }
  });

  onClick(element<HTMLButtonElement>("clear-audit"), async () => {
    try {
      if (!(await confirmInApp(t("dialog.clearAudit.message", "Delete the complete local execution history?"), t("dialog.clearAudit.detail", "This removes the audit entries and stored balance snapshots. Exported result files are not deleted."), t("dialog.clearAudit.confirm", "Delete history")))) return;
      const deleted = await window.kakebo.clearAuditHistory();
      if (deleted > 0) {
        showToast(
          tf("toast.auditDeleted", "{count} execution records deleted.", {
            count: deleted
          })
        );
        await refresh();
      }
    } catch (error) {
      showToast(errorMessage(error), true);
    }
  });

  onClick(element<HTMLButtonElement>("save-accounts"), async () => {
    const save = element<HTMLButtonElement>("save-accounts");
    save.disabled = true;
    try {
      state.accounts = await window.kakebo.saveAccounts(accountValues());
      renderAccounts();
      renderSummary();
      rememberSavedTab("accounts");
      showToast(t("toast.accountsSaved", "Aliases and preferences saved."));
    } catch (error) {
      showToast(errorMessage(error), true);
    } finally {
      save.disabled = false;
    }
  });

  onClick(element<HTMLButtonElement>("select-card-files"), async () => {
    try {
      const files = await window.kakebo.selectCardFiles();
      if (files.length === 0) return;
      const firstProfile = state.cardImportProfiles.find(
        (profile) => profile.enabled
      );
      if (!firstProfile) {
        throw new Error(
          t(
            "cards.noEnabledProfiles",
            "Enable and save at least one card profile first."
          )
        );
      }
      selectedCardFiles = files.map((file) => ({
        ...file,
        included: true,
        profileId: firstProfile.id
      }));
      renderCardFiles();
    } catch (error) {
      showToast(errorMessage(error), true);
    }
  });

  element<HTMLButtonElement>("add-card-profile").addEventListener("click", () => {
    const current = cardProfileValues();
    const template = current.at(-1) ?? state.cardImportProfiles.at(-1);
    const id = `card-${crypto.randomUUID()}`;
    current.push({
      id,
      enabled: true,
      name: "",
      bankName: template?.bankName ?? "",
      cardName: "",
      sheet: template?.sheet ?? "",
      startRow: template?.startRow ?? 1,
      columns: template?.columns ?? {
        date: "A",
        description: "B",
        valueDate: "C",
        amount: "D"
      },
      dateFormat: template?.dateFormat ?? "auto",
      decimalSeparator: template?.decimalSeparator ?? "auto",
      invertAmountSign: template?.invertAmountSign ?? false,
      currency: template?.currency ?? "EUR"
    });
    state.cardImportProfiles = current;
    renderCardProfiles();
  });

  onClick(element<HTMLButtonElement>("save-card-profiles"), async () => {
    const save = element<HTMLButtonElement>("save-card-profiles");
    save.disabled = true;
    try {
      state.cardImportProfiles = await window.kakebo.saveCardImportProfiles(
        cardProfileValues()
      );
      renderCardProfiles();
      renderCardFiles();
      rememberSavedTab("cards");
      showToast(t("toast.cardProfilesSaved", "Card import profiles saved."));
    } catch (error) {
      showToast(errorMessage(error), true);
    } finally {
      save.disabled = false;
    }
  });

  onClick(element<HTMLButtonElement>("import-card-files"), async () => {
    const importButton = element<HTMLButtonElement>("import-card-files");
    operationInProgress = true;
    importButton.disabled = true;
    importButton.textContent = t("cards.importing", "Importing…");
    try {
      state.cardImportProfiles = await window.kakebo.saveCardImportProfiles(
        cardProfileValues()
      );
      const files = selectedCardFiles
        .filter((file) => file.included)
        .map((file) => ({ path: file.path, profileId: file.profileId }));
      if (files.length === 0) {
        throw new Error(
          t("cards.selectAtLeastOne", "Select at least one workbook to import.")
        );
      }
      const result = await window.kakebo.importCardFiles({ files });
      const summary = element<HTMLElement>("card-import-result");
      summary.textContent = tf(
        "cards.importSummary",
        "{rows} rows read · {inserted} new · {duplicates} already stored · {updated} updated",
        {
          rows: result.rows,
          inserted: result.inserted,
          duplicates: result.duplicates,
          updated: result.updated + result.reconciled
        }
      );
      summary.hidden = false;
      showToast(
        t(
          "toast.cardsImported",
          "Card movements were merged, categorized, and exported."
        )
      );
      await refresh();
    } catch (error) {
      showToast(errorMessage(error), true);
    } finally {
      operationInProgress = false;
      importButton.disabled = false;
      importButton.textContent = t("cards.importSelected", "Import selected");
    }
  });

  element<HTMLButtonElement>("add-rule").addEventListener("click", () => {
    state.rules = ruleValues();
    const firstCategory = state.categories[0];
    state.rules.push({
      enabled: true,
      priority: (state.rules.length + 1) * 10,
      field: "descriptionNormalized",
      operator: "contains",
      value: "",
      category: firstCategory?.name ?? ""
    });
    renderRules();
  });

  element<HTMLButtonElement>("add-exclusion").addEventListener("click", () => {
    state.exclusions = exclusionValues();
    state.exclusions.push({
      enabled: true,
      priority: (state.exclusions.length + 1) * 10,
      field: "descriptionNormalized",
      operator: "contains",
      value: ""
    });
    renderExclusions();
  });

  onClick(element<HTMLButtonElement>("save-rules"), async () => {
    const save = element<HTMLButtonElement>("save-rules");
    save.disabled = true;
    try {
      await saveTab("categories", false);
      showToast(t("toast.rulesSaved", "Rules saved."));
    } catch (error) {
      showToast(errorMessage(error), true);
    } finally {
      save.disabled = false;
    }
  });

  onClick(element<HTMLButtonElement>("save-exclusions"), async () => {
    const save = element<HTMLButtonElement>("save-exclusions");
    save.disabled = true;
    try {
      await saveTab("categories", false);
      showToast(t("toast.exclusionsSaved", "Exclusions saved."));
    } catch (error) {
      showToast(errorMessage(error), true);
    } finally {
      save.disabled = false;
    }
  });

  element<HTMLButtonElement>("add-category").addEventListener("click", () => {
    state.categories = categoryValues();
    state.categories.push({ name: "", subcategories: [] });
    renderCategories();
  });

  onClick(element<HTMLButtonElement>("save-categories"), async () => {
    const save = element<HTMLButtonElement>("save-categories");
    save.disabled = true;
    try {
      await saveTab("categories", false);
      showToast(
        t("toast.categoriesSaved", "Category dependencies saved.")
      );
    } catch (error) {
      showToast(errorMessage(error), true);
    } finally {
      save.disabled = false;
    }
  });

  element<HTMLSelectElement>("export-format").addEventListener("change", () => {
    document.body.dataset["exportFormat"] =
      element<HTMLSelectElement>("export-format").value;
  });

  onClick(element<HTMLButtonElement>("save-export-settings"), async () => {
    const save = element<HTMLButtonElement>("save-export-settings");
    save.disabled = true;
    try {
      state.exportSettings = await window.kakebo.saveExportSettings(
        exportValues(true)
      );
      renderExportSettings();
      rememberSavedTab("export");
      showToast(
        t(
          "toast.exportSettingsSaved",
          "Export profile saved. It will be used by manual and scheduled runs."
        )
      );
    } catch (error) {
      showToast(errorMessage(error), true);
    } finally {
      save.disabled = false;
    }
  });

  onClick(element<HTMLButtonElement>("reapply-rules"), async () => {
    const reapply = element<HTMLButtonElement>("reapply-rules");
    reapply.disabled = true;
    reapply.textContent = t("rules.applying", "Applying…");
    try {
      const result = await window.kakebo.reapplyRules();
      showToast(
        tf(
          "toast.rulesReapplied",
          "{count} movements reviewed and the export was updated.",
          { count: result.updated }
        )
      );
    } catch (error) {
      showToast(errorMessage(error), true);
    } finally {
      reapply.disabled = false;
      reapply.textContent = t("rules.reapply", "Apply to history");
    }
  });

  onClick(element<HTMLButtonElement>("run-doctor"), async () => {
    const run = element<HTMLButtonElement>("run-doctor");
    run.disabled = true;
    try {
      const checks = await window.kakebo.runDoctor();
      const container = element("doctor-results");
      container.replaceChildren();
      for (const check of checks) {
        const row = document.createElement("div");
        row.className = `diagnostic-item${check.ok ? "" : " is-error"}`;
        const icon = document.createElement("span");
        icon.className = "diagnostic-icon";
        icon.textContent = check.ok ? "✓" : "!";
        const detail = document.createElement("div");
        const label = document.createElement("strong");
        label.textContent = localizedDoctorValue(check.check, doctorCheckKeys);
        const value = document.createElement("small");
        value.textContent = localizedDoctorValue(check.detail, doctorDetailKeys);
        detail.append(label, value);
        row.append(icon, detail);
        container.append(row);
      }
    } catch (error) {
      showToast(errorMessage(error), true);
    } finally {
      run.disabled = false;
    }
  });

  for (const open of document.querySelectorAll<HTMLButtonElement>("[data-open-path]")) {
    onClick(open, async () => {
      const target = open.dataset["openPath"];
      if (!target) return;
      try {
        await window.kakebo.openPath(
          target as Parameters<typeof window.kakebo.openPath>[0]
        );
      } catch (error) {
        showToast(errorMessage(error), true);
      }
    });
  }

  onClick(element<HTMLButtonElement>("copy-command"), async () => {
    const input = element<HTMLInputElement>("scheduled-command");
    await window.kakebo.copyText(input.value);
    showToast(t("toast.commandCopied", "Command copied."));
  });

  element<HTMLSelectElement>("language-selector").addEventListener(
    "change",
    (event) => {
      void (async () => {
        const selector = event.currentTarget as HTMLSelectElement;
        selector.disabled = true;
        try {
          state = await window.kakebo.setLanguage(
            selector.value as "en" | "es"
          );
          applyTranslations();
          renderAll();
          refreshCurrentPageTitle();
          showToast(t("toast.languageChanged", "Language changed."));
        } catch (error) {
          selector.value = state.language;
          showToast(errorMessage(error), true);
        } finally {
          selector.disabled = false;
        }
      })();
    }
  );

  onClick(element<HTMLButtonElement>("setup-https"), async () => {
    const setup = element<HTMLButtonElement>("setup-https");
    setup.disabled = true;
    setup.textContent = t("portability.preparing", "Preparing HTTPS…");
    try {
      const changed = await window.kakebo.setupLocalHttps();
      if (changed) {
        await refresh();
        showToast(
          t("toast.httpsReady", "The local HTTPS certificate is ready.")
        );
      }
    } catch (error) {
      showToast(errorMessage(error), true);
    } finally {
      setup.disabled = false;
      setup.textContent = t(
        "portability.https",
        "Prepare HTTPS on this computer"
      );
    }
  });
}

async function handleCloseRequest(): Promise<void> {
  if (operationInProgress) {
    const proceed = await confirmInApp(
      t("dialog.operationClose.title", "Operation in progress"),
      t(
        "dialog.operationClose.detail",
        "The window will close. Kakebo Harvester will wait for active local work to finish safely; an authorization waiting in the browser may be cancelled."
      ),
      t("dialog.operationClose.confirm", "Close when finished")
    );
    if (!proceed) return;
  }

  const pending = unsavedTabs();
  if (pending.length > 0) {
    const choice = await showAppModal({
      title: t("dialog.unsavedClose.title", "Unsaved changes"),
      detail: tf(
        "dialog.unsavedClose.detail",
        "There are unsaved changes in {count} section(s). Save them before closing?",
        { count: pending.length }
      ),
      confirmLabel: t("dialog.unsaved.saveAndClose", "Save and close"),
      discardLabel: t(
        "dialog.unsaved.discardAndClose",
        "Discard and close"
      )
    });
    if (choice === "cancel") return;
    if (choice === "confirm") {
      try {
        for (const tab of pending) await saveTab(tab, false);
      } catch (error) {
        showToast(errorMessage(error), true);
        return;
      }
    }
  }
  await window.kakebo.confirmClose();
}

async function initialize(): Promise<void> {
  setupNavigation();
  setupActions();
  window.kakebo.onSyncProgress(handleProgress);
  window.kakebo.onAuthorizationResult(handleAuthorization);
  window.kakebo.onCloseRequested(() => {
    if (closePromptOpen) return;
    closePromptOpen = true;
    void handleCloseRequest().finally(() => {
      closePromptOpen = false;
    });
  });
  await refresh();
  element<HTMLInputElement>("date-from").value = state.defaultDateFrom;
  element<HTMLInputElement>("date-to").value = state.defaultDateTo;
  refreshCurrentPageTitle();
}

void initialize().catch((error: unknown) => {
  const message = errorMessage(error);
  element("sidebar-version").textContent = "Load error";
  const serverStatus = element("server-status");
  serverStatus.replaceChildren();
  serverStatus.textContent = "The application could not be loaded";
  showToast(message, true);
});
