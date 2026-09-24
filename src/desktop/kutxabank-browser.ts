import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { BrowserWindow, BrowserWindowConstructorOptions, Session } from "electron";
import type {
  KutxabankHistoryPage,
  KutxabankHistoryQuery,
  KutxabankHistoryReader
} from "../cards/kutxabank-history.js";
import type { KutxabankTableSnapshot } from "../cards/kutxabank-table.js";
import type { KutxabankPeriod } from "./kutxabank-period.js";

export type KutxabankBrowserSnapshot =
  | { state: "login" | "authorization-required" | "session-expired" | "loading" }
  | { state: "cards"; cards: Array<{ controlId: string; panText: string; alias?: string;
      balance?: { text: string; isRed: boolean } }> }
  | ({
      state: "table";
      table: KutxabankTableSnapshot;
      hasNext: boolean;
      hasPrevious: boolean;
      selectedControlId: string;
      selectedPeriod?: KutxabankPeriod | "three-months";
    } & KutxabankHistoryQuery);

export interface KutxabankBrowserDriver {
  open(): Promise<void>;
  close(): Promise<void>;
  forgetDevice?(): Promise<void>;
  onClosed?(handler: () => void): void;
  snapshot(mode?: "cards"): Promise<KutxabankBrowserSnapshot>;
  selectCard(controlId: string): Promise<void>;
  showMovements(): Promise<void>;
  setDateRange(dateFrom: string, dateTo: string): Promise<void>;
  setPeriod?(period: Exclude<KutxabankPeriod, "between">): Promise<void>;
  showResults(): Promise<void>;
  nextPage(): Promise<void>;
  reportPageState?(state: KutxabankPageStateDiagnostic): void;
}

interface KutxabankPageStateDiagnostic {
  event: "page-ready" | "page-wait-timeout";
  stage: "first" | "next";
  state: KutxabankBrowserSnapshot["state"];
  hasNext?: boolean;
  hasPrevious?: boolean;
  selectionMatches?: boolean;
  criteriaMatches?: boolean;
  tableChanged?: boolean;
  clickDelivered?: boolean;
  trustedClick?: boolean;
  requestSent?: boolean;
  requestCompleted?: boolean;
  requestFailed?: boolean;
}

export interface DiscoveredKutxabankCard {
  selectionToken: string;
  last4: string;
  alias: string;
  fingerprint: string;
  balance?: { text: string; isRed: boolean };
}

interface ControllerOptions {
  token?: () => string;
  fingerprintKey?: Buffer;
  maxPolls?: number;
  pollIntervalMs?: number;
  onClosed?: () => void;
}

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

function safeLast4(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 4 || digits.length > 19) throw new Error("FORMAT_CHANGED");
  return digits.slice(-4);
}

function safeDriverError(error: unknown): Error {
  const code = error instanceof Error ? error.message : "";
  return new Error(["NAVIGATION_BLOCKED", "BANK_LOAD_FAILED", "BROWSER_CLOSED", "BANK_PROCESS_GONE"].includes(code)
    ? code : "SOURCE_UNAVAILABLE");
}

export interface KutxabankBrowserDiagnostic {
  at: string;
  event: "session-open" | "session-close" | "window-created" | "window-close-requested" | "window-closed" |
    "popup-allowed" | "popup-denied" | "navigation-allowed" | "navigation-blocked" | "subframe-blocked" |
    "load-aborted-continued" | "load-failed" | "process-gone" | "action-failed" |
    "page-ready" | "page-wait-timeout";
  window: number;
  route?: string;
  errorCode?: number;
  cascade?: boolean;
  action?: "select-card" | "show-movements" | "set-date-range" | "show-results" | "next-page";
  reason?: "missing-control" | "date-rejected" | "date-reset" | "page-update-timeout" | "click-target-obscured" | "bank-busy" |
    "BROWSER_CLOSED" | "NAVIGATION_BLOCKED" | "other";
  stage?: "first" | "next";
  state?: KutxabankBrowserSnapshot["state"];
  hasNext?: boolean;
  hasPrevious?: boolean;
  selectionMatches?: boolean;
  criteriaMatches?: boolean;
  tableChanged?: boolean;
  clickDelivered?: boolean;
  trustedClick?: boolean;
  requestSent?: boolean;
  requestCompleted?: boolean;
  requestFailed?: boolean;
}

export class KutxabankBrowserController {
  readonly #driver: KutxabankBrowserDriver;
  readonly #token: () => string;
  readonly #maxPolls: number;
  readonly #pollIntervalMs: number;
  readonly #fingerprintKey: Buffer;
  #open = false;
  #generation = "";
  #selections = new Map<string, { controlId: string; last4: string; alias: string; fingerprint: string }>();
  #lastPageFingerprint = "";
  #activeQuery: KutxabankHistoryQuery | undefined;

  constructor(driver: KutxabankBrowserDriver, options: ControllerOptions = {}) {
    this.#driver = driver;
    this.#token = options.token ?? randomUUID;
    this.#fingerprintKey = Buffer.from(options.fingerprintKey ?? randomBytes(32));
    this.#maxPolls = options.maxPolls ?? 80;
    this.#pollIntervalMs = options.pollIntervalMs ?? 250;
    driver.onClosed?.(() => {
      this.#invalidate();
      options.onClosed?.();
    });
    if (!Number.isSafeInteger(this.#maxPolls) || this.#maxPolls < 1 || this.#maxPolls > 240) {
      throw new Error("INVALID_WAIT_LIMIT");
    }
  }

  async open(): Promise<void> {
    await this.#driver.open();
    this.#open = true;
    this.#generation = this.#token();
    this.#selections.clear();
    this.#lastPageFingerprint = "";
    this.#activeQuery = undefined;
  }

  async discoverCards(): Promise<readonly DiscoveredKutxabankCard[]> {
    this.#assertOpen();
    let snapshot = await this.#safeSnapshot("cards");
    for (let attempt = 1; snapshot.state === "loading" && attempt < this.#maxPolls; attempt += 1) {
      await wait(this.#pollIntervalMs);
      snapshot = await this.#safeSnapshot("cards");
    }
    if (snapshot.state === "login" || snapshot.state === "session-expired") {
      throw new Error("AUTHENTICATION_REQUIRED");
    }
    if (snapshot.state !== "cards") throw new Error("SOURCE_NOT_READY");
    const next = new Map<string, { controlId: string; last4: string; alias: string; fingerprint: string }>();
    const result = snapshot.cards.map((card, index) => {
      const selectionToken = `${this.#generation}-${index}`;
      const last4 = safeLast4(card.panText);
      const digits = card.panText.replace(/\D/gu, "");
      const fingerprint = createHmac("sha256", this.#fingerprintKey)
        .update(`kutxabank-card-v1\0${digits}`).digest("hex");
      const alias = card.alias?.trim();
      const balanceText = card.balance?.text.replace(/\s+/gu, " ").trim();
      const balance = balanceText && /^-?(?:(?:\d{1,3}(?:\.\d{3})+)|\d+),\d{2} €$/u.test(balanceText)
        ? { text: balanceText, isRed: card.balance?.isRed === true } : undefined;
      const selected = { selectionToken, last4, fingerprint,
        alias: alias && alias.length <= 120 && !/(?<!\d)\d(?:[ -]?\d){12,18}(?![ -]?\d)/u.test(alias)
          ? alias : "Tarjeta",
        ...(balance ? { balance } : {}) };
      next.set(selectionToken, { controlId: card.controlId, last4, alias: selected.alias, fingerprint });
      return selected;
    });
    if (!result.length) throw new Error("FORMAT_CHANGED");
    this.#selections = next;
    return result;
  }

  async selectCard(selectionToken: string): Promise<DiscoveredKutxabankCard> {
    this.#assertOpen();
    const selection = this.#selection(selectionToken);
    return await Promise.resolve({ selectionToken, last4: selection.last4,
      alias: selection.alias, fingerprint: selection.fingerprint });
  }

  reader(selectionToken: string): KutxabankHistoryReader {
    this.#assertOpen();
    this.#selection(selectionToken);
    return {
      first: async (query) => this.#first(selectionToken, query),
      next: async () => this.#next(selectionToken)
    };
  }

  async close(): Promise<void> {
    const wasOpen = this.#open;
    this.#invalidate();
    if (wasOpen) await this.#driver.close();
  }

  async forgetDevice(): Promise<void> {
    if (this.#open) throw new Error("BANK_WINDOW_OPEN");
    if (!this.#driver.forgetDevice) throw new Error("SOURCE_UNAVAILABLE");
    await this.#driver.forgetDevice();
  }

  get isOpen(): boolean { return this.#open; }

  #invalidate(): void {
    this.#selections.clear();
    this.#generation = "";
    this.#lastPageFingerprint = "";
    this.#activeQuery = undefined;
    this.#open = false;
  }

  async #first(selectionToken: string, query: KutxabankHistoryQuery): Promise<KutxabankHistoryPage> {
    this.#assertOpen();
    if (query.productKey !== selectionToken) throw new Error("SELECTION_EXPIRED");
    const selection = this.#selection(selectionToken);
    await this.#safeAction(() => this.#driver.selectCard(selection.controlId));
    await this.#safeAction(() => this.#driver.showMovements());
    if (query.period && query.period !== "between") {
      if (!this.#driver.setPeriod) throw new Error("SOURCE_UNAVAILABLE");
      await this.#safeAction(async () => {
        await this.#driver.setPeriod?.(query.period as Exclude<KutxabankPeriod, "between">);
      });
    } else {
      await this.#safeAction(() => this.#driver.setDateRange(query.dateFrom, query.dateTo));
    }
    // Native period radios submit their query immediately. Only the custom
    // date range exposes the bank's explicit "Mostrar" control.
    if (!query.period || query.period === "between")
      await this.#safeAction(() => this.#driver.showResults());
    this.#activeQuery = query;
    this.#lastPageFingerprint = "";
    return this.#awaitPage(selectionToken, selection.controlId, query, false);
  }

  async #next(selectionToken: string): Promise<KutxabankHistoryPage> {
    this.#assertOpen();
    const selection = this.#selection(selectionToken);
    await this.#safeAction(() => this.#driver.nextPage());
    return this.#awaitPage(selectionToken, selection.controlId, this.#activeQuery, true);
  }

  async #awaitPage(
    selectionToken: string,
    expectedControlId: string,
    query: KutxabankHistoryQuery | undefined,
    requirePrevious: boolean
  ): Promise<KutxabankHistoryPage> {
    let lastState: KutxabankPageStateDiagnostic | undefined;
    for (let attempt = 0; attempt < this.#maxPolls; attempt += 1) {
      this.#assertOpen();
      const snapshot = await this.#safeSnapshot();
      const stage = requirePrevious ? "next" : "first";
      lastState = snapshot.state === "table" ? {
        event: "page-wait-timeout", stage, state: "table",
        hasNext: snapshot.hasNext, hasPrevious: snapshot.hasPrevious,
        selectionMatches: snapshot.selectedControlId === expectedControlId,
        criteriaMatches: query?.period && query.period !== "between"
          ? snapshot.selectedPeriod === query.period
          : query !== undefined && snapshot.dateFrom === query.dateFrom && snapshot.dateTo === query.dateTo,
        tableChanged: JSON.stringify(snapshot.table) !== this.#lastPageFingerprint
      } : { event: "page-wait-timeout", stage, state: snapshot.state };
      if (snapshot.state === "authorization-required") return { state: "authorization-required" };
      if (snapshot.state === "session-expired") return { state: "session-expired" };
      if (snapshot.state === "login") return { state: "session-expired" };
      if (snapshot.state === "table") {
        const expected = query ?? snapshot;
        if (
          (expected.period && expected.period !== "between"
            ? snapshot.selectedPeriod === expected.period
            : snapshot.dateFrom === expected.dateFrom && snapshot.dateTo === expected.dateTo) &&
          snapshot.hasPrevious === requirePrevious &&
          snapshot.selectedControlId === expectedControlId
        ) {
          const fingerprint = JSON.stringify(snapshot.table);
          if (requirePrevious && fingerprint === this.#lastPageFingerprint) {
            if (attempt + 1 < this.#maxPolls) await wait(this.#pollIntervalMs);
            continue;
          }
          this.#lastPageFingerprint = fingerprint;
          try { this.#driver.reportPageState?.({ ...lastState, event: "page-ready" }); }
          catch { /* Diagnostics must not interrupt banking. */ }
          return { ...snapshot, productKey: selectionToken,
            dateFrom: expected.dateFrom, dateTo: expected.dateTo, period: expected.period };
        }
      }
      if (attempt + 1 < this.#maxPolls) await wait(this.#pollIntervalMs);
    }
    if (lastState) {
      try { this.#driver.reportPageState?.(lastState); }
      catch { /* Diagnostics must not interrupt banking. */ }
    }
    return { state: "loading" };
  }

  #assertOpen(): void {
    if (!this.#open) throw new Error("BROWSER_CLOSED");
  }

  #selection(selectionToken: string): { controlId: string; last4: string; alias: string; fingerprint: string } {
    const value = this.#selections.get(selectionToken);
    if (!value) throw new Error("SELECTION_EXPIRED");
    return value;
  }

  async #safeSnapshot(mode?: "cards"): Promise<KutxabankBrowserSnapshot> {
    try {
      return await this.#driver.snapshot(mode);
    } catch (error) {
      throw safeDriverError(error);
    }
  }

  async #safeAction(action: () => Promise<void>): Promise<void> {
    try {
      await action();
    } catch (error) {
      throw safeDriverError(error);
    }
  }
}

type BrowserWindowClass = new (options: BrowserWindowConstructorOptions) => BrowserWindow;

export const kutxabankNavigationPolicy = {
  loginUrl: "https://portal.kutxabank.es/cs/Satellite/kb/es/banca-personal",
  allowedEntryUrls: ["https://portal.kutxabank.es/cs/Satellite/kb/es/banca-personal"],
  allowedOrigin: "https://www.kutxabank.es",
  allowedPathPrefixes: [
    "/NASApp/BesaideNet2/Gestor",
    "/NASApp/BesaideNet2/pages/login/",
    "/NASApp/BesaideNet2/pages/resumen/resumen_posiciones.iface",
    "/NASApp/BesaideNet2/pages/tarjetas/tarjetas_movimientos_seleccion.iface",
    "/NASApp/BesaideNet2/pages/comun/pantalla_blanco.iface",
    "/NASApp/BesaideNet2/pages/comun/timeout.jsp"
  ]
} as const;

/** Creates the production Electron host; callers provide the observed bank URL/origin. */
export function createElectronKutxabankBrowserDriver(input: {
  BrowserWindow: BrowserWindowClass;
  browserSession: Session;
  loginUrl: string;
  allowedOrigin: string;
  allowedPathPrefixes: readonly string[];
  allowedEntryUrls?: readonly string[];
  onDiagnostics?: (entries: readonly KutxabankBrowserDiagnostic[]) => void;
}): KutxabankBrowserDriver {
  let window: BrowserWindow | undefined;
  let closedHandler: (() => void) | undefined;
  let ownedWindows = new Set<BrowserWindow>();
  let terminalError: string | undefined;
  let diagnostics: KutxabankBrowserDiagnostic[] = [];
  let nextPageProbe: { requestIds: Set<number>; completed: number; failed: number;
    clickDelivered?: boolean; trustedClick?: boolean } | undefined;
  const activeBankRequests = new Set<number>();
  let lastBankRequestAt = 0;
  const origin = new URL(input.allowedOrigin).origin;
  const entryPages = (input.allowedEntryUrls ?? []).map(value => new URL(value));
  if (entryPages.some(url => url.protocol !== "https:" || url.username || url.password)) {
    throw new Error("INVALID_NAVIGATION_POLICY");
  }
  if (!input.allowedPathPrefixes.length || input.allowedPathPrefixes.some((path) => !path.startsWith("/"))) {
    throw new Error("INVALID_NAVIGATION_POLICY");
  }
  const isAllowedUrl = (value: string): boolean => {
    const url = new URL(value);
    return (url.origin === origin && input.allowedPathPrefixes.some((prefix) => url.pathname.startsWith(prefix))) ||
      entryPages.some(entry => url.origin === entry.origin && url.pathname === entry.pathname);
  };
  if (!isAllowedUrl(input.loginUrl)) throw new Error("INVALID_NAVIGATION_POLICY");
  // Never retain URL queries, fragments, session path parameters or foreign hosts.
  // Only static bank page filenames are useful for reviewing navigation policy.
  const diagnosticRoute = (value: string): string => {
    try {
      const url = new URL(value);
      if (value === "about:blank") return "blank";
      if (entryPages.some(entry => url.origin === entry.origin && url.pathname === entry.pathname)) return "public-entry";
      if (url.origin !== origin) return "other-origin";
      const path = url.pathname.split(";")[0] ?? "";
      if (!path.startsWith("/NASApp/BesaideNet2/") || path.length > 256 ||
          path.includes("%") || !/^\/[A-Za-z0-9._/-]+$/u.test(path)) return "bank-other-path";
      const safePath = path.split("/").map(segment =>
        /^(?:\d{4,}|[A-Fa-f0-9]{24,}|[A-Za-z0-9_-]{48,})$/u.test(segment) ? "[redacted]" : segment
      ).join("/");
      return safePath;
    } catch { return "invalid-url"; }
  };
  const record = (event: KutxabankBrowserDiagnostic["event"], windowId = 0, url?: string,
    detail: Pick<KutxabankBrowserDiagnostic, "errorCode" | "cascade" | "action" | "reason" |
      "stage" | "state" | "hasNext" | "hasPrevious" | "selectionMatches" | "criteriaMatches" |
      "tableChanged" | "clickDelivered" | "trustedClick" | "requestSent" | "requestCompleted" |
      "requestFailed"> = {}): void => {
    diagnostics = [...diagnostics.slice(-127), { at: new Date().toISOString(), event, window: windowId,
      ...(url === undefined ? {} : { route: diagnosticRoute(url) }), ...detail }];
    try { input.onDiagnostics?.(diagnostics); } catch { /* Diagnostics must not interrupt banking. */ }
  };
  const options = (): BrowserWindowConstructorOptions => ({
    width: 1100,
    height: 820,
    show: true,
    title: "Kutxabank · Kakebo Harvester",
    webPreferences: {
      session: input.browserSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  const page = (): BrowserWindow => {
    if (terminalError) throw new Error(terminalError);
    if (!window || window.isDestroyed()) throw new Error("BROWSER_CLOSED");
    return window;
  };
  const execute = async <T>(script: string): Promise<T> =>
    page().webContents.executeJavaScript(script, true) as Promise<T>;
  const click = async (id: string): Promise<void> => {
    const changed = await execute<boolean>(`(() => {
      const element = document.getElementById(${JSON.stringify(id)});
      if (!(element instanceof HTMLElement)) throw new Error("missing-control");
      if (element instanceof HTMLInputElement && element.type === 'radio' && element.checked) return false;
      const state = { changed: false, at: Date.now(), observer: undefined };
      const previousTable = document.getElementById('formListado:dataContent');
      const requiresTableChange = ${id === "formCriterios:mostrar" || id === "formListado:siguiente"};
      state.observer = new MutationObserver(records => {
        if (requiresTableChange && previousTable &&
            document.getElementById('formListado:dataContent') === previousTable &&
            !records.some(record => previousTable.contains(record.target))) return;
        state.changed = true; state.at = Date.now();
      });
      state.observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      globalThis.__kakeboReadAction?.observer?.disconnect();
      globalThis.__kakeboReadAction = state;
      element.click();
      return true;
    })()`);
    if (!changed) return;
    // Wait for either a complete navigation or a settled AJAX response. Never accept
    // the old table simply because the date inputs already contain the new range.
    for (let attempt = 0; attempt < 80; attempt += 1) {
      await wait(250);
      if (page().webContents.isLoading()) continue;
      const ready = await execute<boolean>(`(() => {
        const state = globalThis.__kakeboReadAction;
        return document.readyState === 'complete' && (!state || (state.changed && Date.now() - state.at >= 250));
      })()`);
      if (ready) {
        await execute(`(() => {
          globalThis.__kakeboReadAction?.observer?.disconnect();
          delete globalThis.__kakeboReadAction;
        })()`);
        return;
      }
    }
    throw new Error("page-update-timeout");
  };
  const waitForControls = async (ids: readonly string[]): Promise<void> => {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const ready = await execute<boolean>(`(() => {
        const ids = ${JSON.stringify(ids)};
        return ids.every(id => document.getElementById(id) instanceof HTMLElement);
      })()`);
      if (ready) return;
      if (attempt + 1 < 80) await wait(250);
    }
    throw new Error("missing-control");
  };
  const clickLabelFor = async (id: string, labelText: RegExp): Promise<void> => {
    const point = await execute<{ x: number; y: number }>(`(() => {
      const control = document.getElementById(${JSON.stringify(id)});
      if (!(control instanceof HTMLInputElement)) throw new Error('missing-control');
      const labels = [...document.querySelectorAll('label')];
      const label = labels.find(candidate => candidate.htmlFor === control.id) ??
        labels.find(candidate => ${labelText.toString()}.test((candidate.textContent || '').trim()));
      if (!(label instanceof HTMLElement)) throw new Error('missing-control');
      label.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = label.getBoundingClientRect();
      if (!rect.width || !rect.height) throw new Error('missing-control');
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    })()`);
    const bankWindow = page();
    bankWindow.focus();
    bankWindow.webContents.sendInputEvent({ type: "mouseMove", ...point });
    bankWindow.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
    bankWindow.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
  };
  const clickLabelAndWait = async (id: string, labelText: RegExp, requireTableUpdate = false): Promise<void> => {
    const alreadySelected = await execute<boolean>(`(() => {
      const control = document.getElementById(${JSON.stringify(id)});
      if (!(control instanceof HTMLInputElement) || control.type !== 'radio') throw new Error('missing-control');
      return control.checked;
    })()`);
    if (alreadySelected && !requireTableUpdate) return;
    await execute(`(() => {
      globalThis.__kakeboReadAction?.observer?.disconnect();
      const state = { changed: false, at: Date.now(), observer: undefined };
      const previousTable = document.getElementById('formListado:dataContent');
      state.observer = new MutationObserver(records => {
        if (${JSON.stringify(requireTableUpdate)} && previousTable &&
            document.getElementById('formListado:dataContent') === previousTable &&
            !records.some(record => previousTable.contains(record.target) &&
              (record.type === 'childList' || record.type === 'characterData'))) return;
        state.changed = true; state.at = Date.now();
      });
      state.observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
      globalThis.__kakeboReadAction = state;
    })()`);
    await clickLabelFor(id, labelText);
    for (let attempt = 0; attempt < 80; attempt += 1) {
      await wait(250);
      if (page().webContents.isLoading()) continue;
      const ready = await execute<boolean>(`(() => {
        const control = document.getElementById(${JSON.stringify(id)});
        const state = globalThis.__kakeboReadAction;
        return control instanceof HTMLInputElement && control.checked &&
          (!state || (state.changed && Date.now() - state.at >= 250));
      })()`);
      if (ready) {
        await execute(`(() => {
          globalThis.__kakeboReadAction?.observer?.disconnect();
          delete globalThis.__kakeboReadAction;
        })()`);
        return;
      }
    }
    throw new Error("page-update-timeout");
  };
  const runAction = async (
    action: NonNullable<KutxabankBrowserDiagnostic["action"]>,
    operation: () => Promise<void>
  ): Promise<void> => {
    try {
      await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const knownReasons = ["missing-control", "date-rejected", "date-reset", "page-update-timeout", "bank-busy",
        "click-target-obscured", "BROWSER_CLOSED", "NAVIGATION_BLOCKED"] as const;
      const reason = knownReasons.find(value => message.includes(value)) ?? "other";
      record("action-failed", 0, undefined, { action, reason });
      throw error;
    }
  };

  return {
    onClosed(handler) { closedHandler = handler; },
    async forgetDevice() {
      if (ownedWindows.size || (window && !window.isDestroyed())) throw new Error("BANK_WINDOW_OPEN");
      await input.browserSession.clearData();
    },
    reportPageState(state) {
      const probe = state.stage === "next" ? nextPageProbe : undefined;
      record(state.event, 0, undefined, {
        ...state,
        ...(probe ? { clickDelivered: probe.clickDelivered, trustedClick: probe.trustedClick,
          requestSent: probe.requestIds.size > 0, requestCompleted: probe.completed > 0,
          requestFailed: probe.failed > 0 } : {})
      });
    },
    async open() {
      if (window && !window.isDestroyed()) { window.show(); return; }
      terminalError = undefined;
      diagnostics = [];
      nextPageProbe = undefined;
      activeBankRequests.clear();
      lastBankRequestAt = 0;
      record("session-open");
      const sessionOptions = options();
      window = new input.BrowserWindow(sessionOptions);
      const openedWindow = window;
      const group = new Set<BrowserWindow>();
      ownedWindows = group;
      let navigationBlocked = false;
      const requestObserver = (window.webContents.session as Partial<Session>).webRequest;
      const isBankRequest = (details: { url: string; method: string }): boolean => {
        try { return details.method === "POST" && new URL(details.url).origin === origin; }
        catch { return false; }
      };
      requestObserver?.onSendHeaders(details => {
        if (!isBankRequest(details)) return;
        activeBankRequests.add(details.id);
        lastBankRequestAt = Date.now();
        nextPageProbe?.requestIds.add(details.id);
      });
      requestObserver?.onCompleted(details => {
        if (activeBankRequests.delete(details.id)) lastBankRequestAt = Date.now();
        if (nextPageProbe?.requestIds.has(details.id)) nextPageProbe.completed += 1;
      });
      requestObserver?.onErrorOccurred(details => {
        if (activeBankRequests.delete(details.id)) lastBankRequestAt = Date.now();
        if (nextPageProbe?.requestIds.has(details.id)) nextPageProbe.failed += 1;
      });
      let closingGroup = false;
      let nextWindowId = 0;
      const installWindow = (target: BrowserWindow, allowInitialBlank = false): void => {
        group.add(target);
        const windowId = ++nextWindowId;
        record("window-created", windowId);
        let initialBlank = allowInitialBlank;
        target.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
        target.webContents.setWindowOpenHandler(({ url }) => {
          try {
            const current = new URL(target.webContents.getURL());
            const isEntry = entryPages.some(entry => current.origin === entry.origin && current.pathname === entry.pathname);
            const blankLoginPopup = isEntry && (url === "about:blank" || url === "");
            const bankLoginPopup = new URL(url || "about:blank").origin === origin && isAllowedUrl(url);
            if (group.size === 1 && (blankLoginPopup || bankLoginPopup)) {
              record("popup-allowed", windowId, url);
              return { action: "allow", overrideBrowserWindowOptions: sessionOptions };
            }
          } catch { /* Reject malformed or unrelated popup destinations. */ }
          record("popup-denied", windowId, url);
          return { action: "deny" };
        });
        target.webContents.on("did-create-window", child => {
          installWindow(child, true);
          window = child;
          target.hide();
        });
        const permitted = (url: string): boolean => {
          if (initialBlank && url === "about:blank") return true;
          initialBlank = false;
          return isAllowedUrl(url);
        };
        const enforceNavigation = (
          event: { preventDefault(): void; url?: string; isMainFrame?: boolean },
          url: string, _isInPlace?: boolean, isMainFrame?: boolean
        ) => {
          if ((event.isMainFrame ?? isMainFrame) === false) {
            try { if (isAllowedUrl(event.url ?? url)) return; } catch { /* Block only the subframe. */ }
            event.preventDefault();
            record("subframe-blocked", windowId, event.url ?? url);
            return;
          }
          try { if (permitted(event.url ?? url)) { record("navigation-allowed", windowId, event.url ?? url); return; } } catch { /* Fail closed. */ }
          navigationBlocked = true;
          terminalError = "NAVIGATION_BLOCKED";
          record("navigation-blocked", windowId, event.url ?? url);
          event.preventDefault();
          target.destroy();
        };
        target.webContents.on("will-navigate", enforceNavigation);
        target.webContents.on("will-redirect", enforceNavigation);
        target.webContents.on("did-navigate", (_event, url) => {
          try { if (permitted(url)) { record("navigation-allowed", windowId, url); return; } } catch { /* Fail closed. */ }
          navigationBlocked = true;
          terminalError = "NAVIGATION_BLOCKED";
          record("navigation-blocked", windowId, url);
          target.destroy();
        });
        target.webContents.on("did-fail-load", (_event, errorCode, _description, url, isMainFrame) => {
          if (isMainFrame) record("load-failed", windowId, url, { errorCode });
        });
        target.webContents.on("render-process-gone", (_event, details) => {
          terminalError ??= "BANK_PROCESS_GONE";
          record("process-gone", windowId, undefined, { errorCode: details.exitCode });
        });
        target.on("close", () => { record("window-close-requested", windowId); });
        target.on("closed", () => {
          record("window-closed", windowId, undefined, { cascade: closingGroup });
          if (closingGroup) return;
          closingGroup = true;
          if (window && group.has(window)) window = undefined;
          for (const member of group) if (!member.isDestroyed()) member.destroy();
          group.clear();
          closedHandler?.();
        });
      };
      installWindow(openedWindow);
      try {
        await openedWindow.loadURL(input.loginUrl);
        if (openedWindow.isDestroyed()) throw new Error("BROWSER_CLOSED");
        if (!isAllowedUrl(openedWindow.webContents.getURL())) {
          navigationBlocked = true;
          throw new Error("NAVIGATION_BLOCKED");
        }
      } catch (error) {
        const aborted = error instanceof Error && /\bERR_ABORTED\b/u.test(error.message);
        if (aborted && !openedWindow.isDestroyed()) {
          const currentUrl = openedWindow.webContents.getURL();
          if (isAllowedUrl(currentUrl)) {
            record("load-aborted-continued", 1, currentUrl);
            return;
          }
        }
        if (!openedWindow.isDestroyed()) openedWindow.destroy();
        if (window === openedWindow) window = undefined;
        throw new Error(navigationBlocked ? "NAVIGATION_BLOCKED" : "BANK_LOAD_FAILED", { cause: error });
      }
    },
    close() {
      record("session-close");
      const closing = [...ownedWindows];
      window = undefined;
      for (const member of closing) if (!member.isDestroyed()) member.destroy();
      ownedWindows.clear();
      return Promise.resolve();
    },
    async snapshot(mode) {
      if (page().webContents.getURL() === "about:blank") return { state: "loading" };
      if (!isAllowedUrl(page().webContents.getURL())) {
        page().destroy();
        throw new Error("unexpected-navigation");
      }
      return execute<KutxabankBrowserSnapshot>(`(() => {
        const text = document.body?.innerText || "";
        if (text.includes("Autorización de consulta")) return { state: "authorization-required" };
        const readCards = () => {
          const controls = [...document.querySelectorAll(
            'input[type="radio"][id^="formMenuOpciones:PanelSeries:"][id*="SelectRadioMenuContratos"]'
          )];
          return controls.map(control => {
            const scope = control.closest('tr') || control.parentElement;
            const candidates = [...(scope?.querySelectorAll('span, label, td, a') || [])];
            const matches = candidates.map(node => (node.textContent || '').trim())
              .filter(value => /^(?:\\d[ -]?){13,19}$/.test(value));
            const unique = [...new Set(matches.map(value => value.replace(/\\D/g, '')))];
            if (unique.length !== 1) throw new Error('ambiguous-pan');
            const cells = [...(scope?.querySelectorAll('td') || [])];
            const alias = (cells[2]?.textContent || '').trim();
            const balanceCell = cells[3];
            const balanceText = (balanceCell?.textContent || '').replace(/\\s+/g, ' ').trim();
            const red = balanceCell && [balanceCell, ...balanceCell.querySelectorAll('*')].some(node => {
              const color = typeof getComputedStyle === 'function' ? getComputedStyle(node).color : '';
              const values = /rgba?\\(\\s*(\\d+)[, ]+\\s*(\\d+)[, ]+\\s*(\\d+)/i.exec(color);
              return !!values && Number(values[1]) >= 100 && Number(values[1]) > Number(values[2]) * 1.4 &&
                Number(values[1]) > Number(values[3]) * 1.4;
            });
            return { controlId: control.id, panText: unique[0], alias,
              ...(balanceText ? { balance: { text: balanceText, isRed: !!red } } : {}) };
          });
        };
        if (${mode === "cards"}) {
          const cards = readCards();
          if (cards.length) return { state: "cards", cards };
          const movements = [...document.querySelectorAll('#formTAR a')]
            .find(node => (node.textContent || '').trim() === 'Movimientos');
          if (movements instanceof HTMLElement) { movements.click(); return { state: "loading" }; }
        }
        const table = document.getElementById("formListado:dataContent");
        if (table) {
          const headers = [...document.querySelectorAll('[id="formListado:data"] th')].map(node => (node.textContent || "").trim());
          const rows = [...table.querySelectorAll(':scope > tbody > tr')].map(row => [0,1,2,3,4].map(index => {
            const cell = row.querySelector('[id$="gridContent-0-' + index + '"]');
            return (cell?.textContent || "").trim();
          }));
          const value = id => document.getElementById(id)?.value || "";
          const iso = prefix => value(prefix + '_cmb_anyo') + '-' + value(prefix + '_cmb_mes').padStart(2,'0') + '-' + value(prefix + '_cmb_dias').padStart(2,'0');
          const selected = document.querySelector('[id^="formMenuOpciones:PanelSeries:"][id*="SelectRadioMenuContratos"]:checked');
          const criterion = document.querySelector('input[id^="formCriterios:criteriosMovimientos:"]:checked');
          const criterionLabel = [...document.querySelectorAll('label')]
            .find(label => label.htmlFor === criterion?.id)?.textContent?.trim() || '';
          const selectedPeriod = /3 meses/iu.test(criterionLabel) ? 'three-months'
            : /quince días/iu.test(criterionLabel) ? 'fifteen-days'
            : /^Hoy$/iu.test(criterionLabel) ? 'today'
            : /Última semana/iu.test(criterionLabel) ? 'week'
            : /Último mes/iu.test(criterionLabel) ? 'month'
            : /Entre fechas/iu.test(criterionLabel) ? 'between' : undefined;
          return { state: "table", productKey: "", dateFrom: iso('formCriterios:calendarioDesde'),
            dateTo: iso('formCriterios:calendarioHasta'), headers, table: { headers, rows },
            selectedPeriod,
            selectedControlId: selected?.id || "",
            hasNext: !!document.getElementById('formListado:siguiente'),
            hasPrevious: !!document.getElementById('formListado:anterior') };
        }
        const cards = readCards();
        if (cards.length) return { state: "cards", cards };
        if (/sesión.*(caduc|expir)|identifícate|acceso clientes/i.test(text)) return { state: "session-expired" };
        return document.readyState === "complete" ? { state: "login" } : { state: "loading" };
      })()`);
    },
    async selectCard(controlId) {
      await runAction("select-card", async () => await clickLabelAndWait(controlId, /./u));
    },
    async showMovements() {
      await runAction("show-movements", async () => {
        const controlId = await execute<string | null>(`(() => {
          if (document.getElementById('formCriterios:mostrar')) return null;
          const controls = [...document.querySelectorAll('[id="formMenuOpciones"] input[type="radio"], [id="formMenuOpciones"] label')];
          const labeled = controls.find(node => /Movimientos/i.test(node.textContent || node.value || ""));
          const control = labeled instanceof HTMLLabelElement && labeled.htmlFor ? document.getElementById(labeled.htmlFor) : labeled;
          if (!(control instanceof HTMLElement) || !control.id) throw new Error("missing-control"); return control.id; })()`);
        if (controlId) {
          const alreadySelected = await execute<boolean>(`(() => {
            const control = document.getElementById(${JSON.stringify(controlId)});
            return control instanceof HTMLInputElement && control.checked;
          })()`);
          // This radio is replaced with a different generated id after the bank
          // renders its criteria, so waiting for the old id would time out.
          if (!alreadySelected) await clickLabelFor(controlId, /Movimientos/iu);
        }
        await waitForControls(["formCriterios:criteriosMovimientos:_5"]);
      });
    },
    async setDateRange(dateFrom, dateTo) {
      const script = (prefix: string, iso: string) => {
        const [year, month, day] = iso.split("-");
        return `for (const [suffix,value] of ${JSON.stringify([["dias", day], ["mes", month], ["anyo", year]])}) {
          const field = document.getElementById(${JSON.stringify(prefix)} + '_cmb_' + suffix);
          if (!(field instanceof HTMLInputElement)) throw new Error('missing-control');
          field.focus(); field.value = value; field.dispatchEvent(new Event('input', { bubbles: true }));
          field.dispatchEvent(new Event('change', { bubbles: true })); field.blur();
          if (Number(field.value) !== Number(value)) throw new Error('date-rejected');
        }`;
      };
      await runAction("set-date-range", async () => {
        await clickLabelFor("formCriterios:criteriosMovimientos:_5", /Entre fechas/iu);
        await waitForControls([
          "formCriterios:calendarioDesde_cmb_dias",
          "formCriterios:calendarioDesde_cmb_mes",
          "formCriterios:calendarioDesde_cmb_anyo",
          "formCriterios:calendarioHasta_cmb_dias",
          "formCriterios:calendarioHasta_cmb_mes",
          "formCriterios:calendarioHasta_cmb_anyo"
        ]);
        await execute(`(async () => {
        const pause = () => new Promise(resolve => setTimeout(resolve, 150));
        ${script("formCriterios:calendarioDesde", dateFrom)}
        await pause();
        const read = prefix => ['anyo','mes','dias'].map(suffix => Number(document.getElementById(prefix + '_cmb_' + suffix)?.value)).join('-');
        const expected = iso => iso.split('-').map(Number).join('-');
        if (read('formCriterios:calendarioDesde') !== expected(${JSON.stringify(dateFrom)})) throw new Error('date-reset');
        ${script("formCriterios:calendarioHasta", dateTo)}
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await pause();
          if (read('formCriterios:calendarioDesde') === expected(${JSON.stringify(dateFrom)}) &&
              read('formCriterios:calendarioHasta') === expected(${JSON.stringify(dateTo)})) return;
          if (read('formCriterios:calendarioDesde') !== expected(${JSON.stringify(dateFrom)})) throw new Error('date-reset');
          ${script("formCriterios:calendarioHasta", dateTo)}
        }
        throw new Error('date-reset');
      })()`);
      });
    },
    async setPeriod(period) {
      await runAction("set-date-range", async () => {
        const choices: Record<Exclude<KutxabankPeriod, "between">, RegExp> = {
          "fifteen-days": /Últimos quince días/iu,
          today: /^Hoy$/iu,
          week: /Última semana/iu,
          month: /Último mes/iu
        };
        const label = choices[period];
        const controlId = await execute<string>(`(() => {
          const found = [...document.querySelectorAll('label')].find(candidate =>
            ${label.toString()}.test((candidate.textContent || '').trim()));
          if (!(found instanceof HTMLLabelElement) || !found.htmlFor ||
              !(document.getElementById(found.htmlFor) instanceof HTMLInputElement)) throw new Error('missing-control');
          return found.htmlFor;
        })()`);
        const alreadySelected = await execute<boolean>(`(() => {
          const control = document.getElementById(${JSON.stringify(controlId)});
          return control instanceof HTMLInputElement && control.checked;
        })()`);
        if (alreadySelected) {
          const switchedAt = Date.now();
          await clickLabelFor("formCriterios:criteriosMovimientos:_5", /Entre fechas/iu);
          // The bank may still be processing this radio's AJAX update. Do not
          // attribute its response to the query submitted by the next click.
          for (let attempt = 0; attempt < 150; attempt += 1) {
            if (!activeBankRequests.size && !page().webContents.isLoading() &&
                Date.now() - Math.max(lastBankRequestAt, switchedAt) >= 2000) break;
            if (attempt === 149) throw new Error("bank-busy");
            await wait(100);
          }
          const toggled = await execute<boolean>(`(() => {
            const chosen = document.getElementById(${JSON.stringify(controlId)});
            const between = document.getElementById('formCriterios:criteriosMovimientos:_5');
            return chosen instanceof HTMLInputElement && between instanceof HTMLInputElement &&
              !chosen.checked && between.checked;
          })()`);
          if (!toggled) throw new Error("page-update-timeout");
        }
        await clickLabelAndWait(controlId, label, true);
      });
    },
    async showResults() { await runAction("show-results", async () => await click("formCriterios:mostrar")); },
    async nextPage() {
      await runAction("next-page", async () => {
        for (let attempt = 0; attempt < 150; attempt += 1) {
          if (!activeBankRequests.size && Date.now() - lastBankRequestAt >= 2000) break;
          if (attempt === 149) throw new Error("bank-busy");
          await wait(100);
        }
        const bankWindow = page();
        bankWindow.focus();
        let point: { x: number; y: number } | undefined;
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const target = await execute<{ x: number; y: number; hit: boolean }>(`(() => {
            const control = document.getElementById('formListado:siguiente');
            if (!(control instanceof HTMLElement)) throw new Error('missing-control');
            control.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
            const rect = control.getBoundingClientRect();
            if (!rect.width || !rect.height) throw new Error('missing-control');
            const x = Math.round(rect.left + rect.width / 2);
            const y = Math.round(rect.top + rect.height / 2);
            const hit = document.elementFromPoint(x, y);
            return { x, y, hit: hit === control || control.contains(hit) };
          })()`);
          if (target.hit) { point = { x: target.x, y: target.y }; break; }
          await wait(50);
        }
        if (!point) throw new Error("click-target-obscured");
        nextPageProbe = { requestIds: new Set(), completed: 0, failed: 0 };
        await execute(`(() => {
          globalThis.__kakeboNextPageProbe?.remove?.();
          const control = document.getElementById('formListado:siguiente');
          const probe = { delivered: false, trusted: false, remove: undefined };
          const listener = event => {
            if (event.target === control || control?.contains(event.target)) {
              probe.delivered = true;
              probe.trusted = event.isTrusted;
            }
          };
          document.addEventListener('click', listener, true);
          probe.remove = () => document.removeEventListener('click', listener, true);
          globalThis.__kakeboNextPageProbe = probe;
        })()`);
        bankWindow.webContents.sendInputEvent({ type: "mouseMove", ...point });
        bankWindow.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
        bankWindow.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
        await wait(100);
        const click = await execute<{ delivered: boolean; trusted: boolean }>(`(() => {
          const probe = globalThis.__kakeboNextPageProbe;
          probe?.remove?.();
          delete globalThis.__kakeboNextPageProbe;
          return { delivered: !!probe?.delivered, trusted: !!probe?.trusted };
        })()`).catch(() => undefined);
        if (click) {
          nextPageProbe.clickDelivered = click.delivered;
          nextPageProbe.trustedClick = click.trusted;
        }
      });
    }
  };
}
