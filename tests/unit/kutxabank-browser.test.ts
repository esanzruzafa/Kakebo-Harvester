import { describe, expect, test, vi } from "vitest";
import {
  KutxabankBrowserController,
  createElectronKutxabankBrowserDriver,
  kutxabankNavigationPolicy,
  type KutxabankBrowserDriver,
  type KutxabankBrowserSnapshot
} from "../../src/desktop/kutxabank-browser.js";

const sharedBankSession = { clearData: vi.fn(() => Promise.resolve()) };

const login: KutxabankBrowserSnapshot = { state: "login" };
const cards: KutxabankBrowserSnapshot = {
  state: "cards",
  cards: [
    { controlId: "formMenuOpciones:PanelSeries:0:SelectRadioMenuContratos:_0", panText: "1111 2222 3333 4444", alias: "Visa compras", balance: { text: "194,55 €", isRed: true } },
    { controlId: "formMenuOpciones:PanelSeries:0:SelectRadioMenuContratos:_1", panText: "5555 6666 7777 8888", alias: "Viajes" }
  ]
};

type TableSnapshot = Extract<KutxabankBrowserSnapshot, { state: "table" }>;
const movementTable = (overrides: Partial<TableSnapshot> = {}): TableSnapshot => ({
  state: "table",
  productKey: "ignored",
  selectedControlId: "formMenuOpciones:PanelSeries:0:SelectRadioMenuContratos:_0",
  dateFrom: "2026-09-01",
  dateTo: "2026-09-15",
  hasNext: false,
  hasPrevious: false,
  table: {
    headers: ["Fecha", "Concepto", "Fecha imputación", "Importe", "Situación"],
    rows: [["02/09/2026", "COMPRA A", "03/09/2026", "-1,00 €", ""]]
  },
  ...overrides
});

function fakeDriver(snapshots: KutxabankBrowserSnapshot[]): KutxabankBrowserDriver & { selected: string[] } {
  const queue = [...snapshots];
  return {
    selected: [],
    open: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    snapshot: vi.fn(() => Promise.resolve(queue.shift() ?? login)),
    selectCard: vi.fn(function (this: { selected: string[] }, id: string) { this.selected.push(id); return Promise.resolve(); }),
    showMovements: vi.fn(() => Promise.resolve()),
    setDateRange: vi.fn(() => Promise.resolve()),
    setPeriod: vi.fn(() => Promise.resolve()),
    showResults: vi.fn(() => Promise.resolve()),
    nextPage: vi.fn(() => Promise.resolve())
  };
}

function onlyCard(cardsFound: readonly { selectionToken: string; last4: string }[]) {
  const card = cardsFound[0];
  if (!card) throw new Error("test fixture must contain a card");
  return card;
}

describe("KutxabankBrowserController", () => {
  test.each(["NAVIGATION_BLOCKED", "BANK_LOAD_FAILED", "BROWSER_CLOSED", "BANK_PROCESS_GONE", "private-token"])("only forwards safe driver errors: %s", async code => {
    const driver = fakeDriver([]);
    driver.snapshot = () => Promise.reject(new Error(code));
    const controller = new KutxabankBrowserController(driver);
    await controller.open();
    await expect(controller.discoverCards()).rejects.toThrow(code === "private-token" ? "SOURCE_UNAVAILABLE" : code);
  });
  test("discovers two cards without returning PAN values", async () => {
    const controller = new KutxabankBrowserController(fakeDriver([cards]), { token: () => "token-a" });
    await controller.open();
    const found = await controller.discoverCards();
    expect(found).toMatchObject([
      { selectionToken: "token-a-0", last4: "4444", alias: "Visa compras",
        balance: { text: "194,55 €", isRed: true } },
      { selectionToken: "token-a-1", last4: "8888", alias: "Viajes" }
    ]);
    expect(found.every(card => /^[0-9a-f]{64}$/u.test(card.fingerprint))).toBe(true);
    expect(JSON.stringify(found)).not.toContain("3333");
  });

  test("uses a stable secret-keyed fingerprint to distinguish cards sharing final digits", async () => {
    const key = Buffer.alloc(32, 7);
    const snapshot: KutxabankBrowserSnapshot = { state: "cards", cards: [
      { controlId: "first", panText: "1111 2222 3333 4444" },
      { controlId: "second", panText: "9999 8888 7777 4444" }
    ] };
    const first = new KutxabankBrowserController(fakeDriver([snapshot]), { fingerprintKey: key });
    const second = new KutxabankBrowserController(fakeDriver([snapshot]), { fingerprintKey: key });
    await first.open();
    await second.open();
    const firstCards = await first.discoverCards();
    const secondCards = await second.discoverCards();
    expect(firstCards.map(card => card.last4)).toEqual(["4444", "4444"]);
    expect(firstCards[0]?.fingerprint).not.toBe(firstCards[1]?.fingerprint);
    expect(firstCards.map(card => card.fingerprint)).toEqual(secondCards.map(card => card.fingerprint));
    expect(JSON.stringify(firstCards)).not.toContain("1111222233334444");
  });

  test("drops balance values that are not a plain euro amount", async () => {
    const unsafe = { state: "cards" as const, cards: [{
      controlId: "card-one", panText: "1111 2222 3333 4444", alias: "Visa",
      balance: { text: "194,55 € SECRET", isRed: true }
    }] };
    const controller = new KutxabankBrowserController(fakeDriver([unsafe]));
    await controller.open();
    const found = await controller.discoverCards();
    expect(found[0]).not.toHaveProperty("balance");
    expect(JSON.stringify(found)).not.toContain("SECRET");
  });

  test("uses a plain fallback alias so the renderer can add one masked number", async () => {
    const controller = new KutxabankBrowserController(fakeDriver([{ state: "cards", cards: [
      { controlId: "card-one", panText: "1111 2222 3333 4444" }
    ] }]));
    await controller.open();
    expect((await controller.discoverCards())[0]?.alias).toBe("Tarjeta");
  });

  test("expires discovery tokens when the window closes", async () => {
    const controller = new KutxabankBrowserController(fakeDriver([cards]), { token: () => "token-a" });
    await controller.open();
    const card = onlyCard(await controller.discoverCards());
    await controller.close();
    await expect(controller.selectCard(card.selectionToken)).rejects.toThrow("BROWSER_CLOSED");
  });

  test("expires discovery tokens when the bank window closes itself", async () => {
    const driver = fakeDriver([cards]);
    let closed: (() => void) | undefined;
    driver.onClosed = handler => { closed = handler; };
    const onClosed = vi.fn();
    const controller = new KutxabankBrowserController(driver, { token: () => "token-a", onClosed });
    await controller.open();
    const card = onlyCard(await controller.discoverCards());
    closed?.();
    await expect(controller.selectCard(card.selectionToken)).rejects.toThrow("BROWSER_CLOSED");
    expect(onClosed).toHaveBeenCalledOnce();
    await controller.open();
    await expect(controller.selectCard(card.selectionToken)).rejects.toThrow("SELECTION_EXPIRED");
  });

  test("rejects an unknown or expired selection without sending it to the bank page", async () => {
    const driver = fakeDriver([cards]);
    const controller = new KutxabankBrowserController(driver, { token: () => "token-a" });
    await controller.open();
    await controller.discoverCards();
    await expect(controller.selectCard("unknown")).rejects.toThrow("SELECTION_EXPIRED");
    expect(driver.selected).toEqual([]);
  });

  test("does not treat authorization as an empty successful table", async () => {
    const driver = fakeDriver([cards, { state: "authorization-required" }]);
    const controller = new KutxabankBrowserController(driver, { token: () => "token-a", pollIntervalMs: 0 });
    await controller.open();
    const card = onlyCard(await controller.discoverCards());
    const reader = controller.reader(card.selectionToken);
    await expect(reader.first({ productKey: card.selectionToken, dateFrom: "2026-06-01", dateTo: "2026-09-15" }))
      .resolves.toEqual({ state: "authorization-required" });
  });

  test("waits past a stale AJAX table for the coherent requested range", async () => {
    const stale: KutxabankBrowserSnapshot = {
      state: "table", productKey: "other", dateFrom: "2026-08-01", dateTo: "2026-08-31",
      selectedControlId: "formMenuOpciones:PanelSeries:0:SelectRadioMenuContratos:_0",
      hasNext: false, hasPrevious: false, table: { headers: [], rows: [] }
    };
    const fresh = movementTable();
    const driver = fakeDriver([cards, stale, fresh]);
    const controller = new KutxabankBrowserController(driver, { token: () => "token-a", pollIntervalMs: 0 });
    await controller.open();
    const card = onlyCard(await controller.discoverCards());
    const page = await controller.reader(card.selectionToken).first({
      productKey: card.selectionToken, dateFrom: "2026-09-01", dateTo: "2026-09-15"
    });
    expect(page).toMatchObject({ state: "table", productKey: card.selectionToken, dateFrom: "2026-09-01" });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(driver.showResults).toHaveBeenCalledOnce();
  });

  test("selects a native bank period without filling dates and waits for that radio to be active", async () => {
    const old = movementTable({ dateFrom: "--", dateTo: "--", selectedPeriod: "week" });
    const selected = movementTable({ dateFrom: "--", dateTo: "--", selectedPeriod: "month" });
    const driver = fakeDriver([cards, old, selected]);
    const controller = new KutxabankBrowserController(driver, { token: () => "token-a", pollIntervalMs: 0 });
    await controller.open();
    const card = onlyCard(await controller.discoverCards());
    await expect(controller.reader(card.selectionToken).first({
      productKey: card.selectionToken, dateFrom: "2026-08-15", dateTo: "2026-09-15", period: "month"
    })).resolves.toMatchObject({ state: "table", selectedPeriod: "month" });
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(driver.setPeriod).toHaveBeenCalledWith("month");
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(driver.setDateRange).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(driver.showResults).not.toHaveBeenCalled();
  });

  test("waits for the next page fingerprint to change instead of accepting stale previous-page content", async () => {
    const first = movementTable({ hasNext: true });
    const staleNext = movementTable({ hasNext: true, hasPrevious: true });
    const freshNext = movementTable({
      hasPrevious: true,
      table: { ...movementTable().table, rows: [["04/09/2026", "COMPRA B", "05/09/2026", "-2,00 €", ""]] }
    });
    const driver = fakeDriver([cards, first, staleNext, freshNext]);
    const controller = new KutxabankBrowserController(driver, { token: () => "token-a", pollIntervalMs: 0 });
    await controller.open();
    const card = onlyCard(await controller.discoverCards());
    const reader = controller.reader(card.selectionToken);
    await reader.first({ productKey: card.selectionToken, dateFrom: "2026-09-01", dateTo: "2026-09-15" });
    await expect(reader.next()).resolves.toMatchObject({
      state: "table",
      table: { rows: [["04/09/2026", "COMPRA B", "05/09/2026", "-2,00 €", ""]] }
    });
    // The driver interface is method-shaped; this assertion intentionally inspects the Vitest replacement.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(driver.snapshot).toHaveBeenCalledTimes(4);
  });

  test("reports only structural reasons when the next page never becomes acceptable", async () => {
    const first = movementTable({ hasNext: true });
    const next = movementTable({ hasPrevious: true, dateFrom: "", table: {
      ...first.table, rows: [["04/09/2026", "PRIVATE DESCRIPTION", "05/09/2026", "-2,00 €", ""]]
    } });
    const reportPageState = vi.fn();
    const driver = Object.assign(fakeDriver([cards, first, next]), { reportPageState });
    const controller = new KutxabankBrowserController(driver, {
      token: () => "token-a", pollIntervalMs: 0, maxPolls: 1
    });
    await controller.open();
    const card = onlyCard(await controller.discoverCards());
    const reader = controller.reader(card.selectionToken);
    await reader.first({ productKey: card.selectionToken, dateFrom: "2026-09-01", dateTo: "2026-09-15" });
    await expect(reader.next()).resolves.toEqual({ state: "loading" });
    expect(reportPageState).toHaveBeenLastCalledWith({ event: "page-wait-timeout", stage: "next",
      state: "table", hasNext: false, hasPrevious: true, selectionMatches: true,
      criteriaMatches: false, tableChanged: true });
    expect(JSON.stringify(reportPageState.mock.calls)).not.toContain("PRIVATE DESCRIPTION");
  });

  test("rejects a table produced for a different selected card", async () => {
    const wrongCard = movementTable({ selectedControlId: "formMenuOpciones:PanelSeries:0:SelectRadioMenuContratos:_1" });
    const driver = fakeDriver([cards, wrongCard, wrongCard]);
    const controller = new KutxabankBrowserController(driver, {
      token: () => "token-a", pollIntervalMs: 0, maxPolls: 2
    });
    await controller.open();
    const card = onlyCard(await controller.discoverCards());
    await expect(controller.reader(card.selectionToken).first({
      productKey: card.selectionToken, dateFrom: "2026-09-01", dateTo: "2026-09-15"
    })).resolves.toEqual({ state: "loading" });
  });

  test("reports an expired session with a safe state", async () => {
    const driver = fakeDriver([cards, { state: "session-expired" }]);
    const controller = new KutxabankBrowserController(driver, { token: () => "token-a", pollIntervalMs: 0 });
    await controller.open();
    const card = onlyCard(await controller.discoverCards());
    await expect(controller.reader(card.selectionToken).first({
      productKey: card.selectionToken, dateFrom: "2026-09-01", dateTo: "2026-09-15"
    })).resolves.toEqual({ state: "session-expired" });
  });

  test("bounds an indefinitely loading page", async () => {
    const driver = fakeDriver([cards, { state: "loading" }, { state: "loading" }]);
    const controller = new KutxabankBrowserController(driver, {
      token: () => "token-a", pollIntervalMs: 0, maxPolls: 2
    });
    await controller.open();
    const card = onlyCard(await controller.discoverCards());
    await expect(controller.reader(card.selectionToken).first({
      productKey: card.selectionToken, dateFrom: "2026-09-01", dateTo: "2026-09-15"
    })).resolves.toEqual({ state: "loading" });
  });

  test("returns immediately for visible user login and lets the caller refresh", async () => {
    const driver = fakeDriver([login, cards]);
    const controller = new KutxabankBrowserController(driver, { token: () => "token-a" });
    await controller.open();
    await expect(controller.discoverCards()).rejects.toThrow("AUTHENTICATION_REQUIRED");
    await expect(controller.discoverCards()).resolves.toHaveLength(2);
  });

  test("Electron host reuses its dedicated session without clearing it on close", async () => {
    const createdOptions: Record<string, unknown>[] = [];
    const bankSession = sharedBankSession;
    let permissionHandler: ((a: unknown, b: unknown, callback: (allowed: boolean) => void) => void) | undefined;
    const navigationHandlers = new Map<string, (...args: never[]) => void>();
    let destroyed = false;
    class FakeWindow {
      destroyed = false;
      webContents = {
        setWindowOpenHandler: vi.fn(),
        session: {
          setPermissionRequestHandler: (handler: typeof permissionHandler) => { permissionHandler = handler; },
          clearStorageData: vi.fn(() => Promise.resolve())
        },
        on: (name: string, handler: (...args: never[]) => void) => { navigationHandlers.set(name, handler); },
        executeJavaScript: vi.fn(),
        getURL: () => "https://bank.example/pages/tarjetas/tarjetas_movimientos_seleccion.iface"
      };
      constructor(options: Record<string, unknown>) { createdOptions.push(options); destroyed = false; }
      isDestroyed() { return destroyed; }
      show() {}
      on() {}
      async loadURL() {}
      destroy() { destroyed = true; }
    }
    const driver = createElectronKutxabankBrowserDriver({ browserSession: sharedBankSession as never,
      BrowserWindow: FakeWindow as never,
      loginUrl: "https://bank.example/login",
      allowedOrigin: "https://bank.example",
      allowedPathPrefixes: ["/login", "/pages/tarjetas/"]
    });
    await driver.open();
    const preferences = createdOptions[0]?.webPreferences as Record<string, unknown>;
    expect(preferences).toMatchObject({ contextIsolation: true, nodeIntegration: false, sandbox: true });
    expect(preferences.session).toBe(bankSession);
    expect(preferences.partition).toBeUndefined();
    await expect(driver.forgetDevice?.()).rejects.toThrow("BANK_WINDOW_OPEN");
    let allowed = true;
    permissionHandler?.(undefined, undefined, (value) => { allowed = value; });
    expect(allowed).toBe(false);
    let subframePrevented = false;
    navigationHandlers.get("will-redirect")?.({
      preventDefault: () => { subframePrevented = true; }, isMainFrame: false,
      url: "https://evil.example/iframe"
    } as never, "https://evil.example/iframe" as never, false as never, false as never);
    expect({ subframePrevented, destroyed }).toEqual({ subframePrevented: true, destroyed: false });
    let prevented = false;
    navigationHandlers.get("will-navigate")?.({ preventDefault: () => { prevented = true; } } as never, "https://evil.example/steal" as never);
    expect({ prevented, destroyed }).toEqual({ prevented: true, destroyed: true });
    await driver.open();
    const secondPreferences = createdOptions[1]?.webPreferences as Record<string, unknown>;
    expect(secondPreferences.session).toBe(bankSession);
    await driver.close();
    expect(destroyed).toBe(true);
    expect(bankSession.clearData).not.toHaveBeenCalled();
    await driver.forgetDevice?.();
    expect(bankSession.clearData).toHaveBeenCalledOnce();
  });

  test.each(["will-navigate", "will-redirect", "did-navigate"])("production policy admits the observed post-login page via %s and rejects unknown pages", async navigationEvent => {
    let currentUrl: string = kutxabankNavigationPolicy.loginUrl;
    let destroyed = false;
    const handlers = new Map<string, (...args: unknown[]) => void>();
    class FakeWindow {
      webContents = {
        session: { setPermissionRequestHandler() {}, clearStorageData: () => Promise.resolve() },
        setWindowOpenHandler() {},
        on: (name: string, handler: (...args: unknown[]) => void) => { handlers.set(name, handler); },
        getURL: () => currentUrl,
        executeJavaScript: () => Promise.resolve({ state: "login" })
      };
      isDestroyed() { return destroyed; } show() {} on() {} destroy() { destroyed = true; }
      loadURL(url: string) { currentUrl = url; return Promise.resolve(); }
    }
    const driver = createElectronKutxabankBrowserDriver({ browserSession: sharedBankSession as never, BrowserWindow: FakeWindow as never, ...kutxabankNavigationPolicy });
    await driver.open();
    let prevented = false;
    const event = { preventDefault: () => { prevented = true; } };
    for (const path of [
      "Gestor",
      "pages/login/login_poslogin.iface",
      "pages/login/entradaBanca.iface",
      "pages/login/next_auth_step.iface",
      "pages/resumen/resumen_posiciones.iface",
      "pages/comun/timeout.jsp"
    ]) {
      handlers.get(navigationEvent)?.(event, `https://www.kutxabank.es/NASApp/BesaideNet2/${path}`, false, true);
      expect({ destroyed, prevented }).toEqual({ destroyed: false, prevented: false });
    }
    handlers.get(navigationEvent)?.(event, "https://www.kutxabank.es/NASApp/BesaideNet2/pages/pagos/unknown.iface", false, true);
    expect(destroyed).toBe(true);
    await driver.close();
  });

  test("rejects a login URL outside the navigation allowlist before opening a window", () => {
    expect(() => createElectronKutxabankBrowserDriver({ browserSession: sharedBankSession as never,
      BrowserWindow: class { readonly marker = true; } as never,
      loginUrl: "https://evil.example/login",
      allowedOrigin: "https://bank.example",
      allowedPathPrefixes: ["/login"]
    })).toThrow("INVALID_NAVIGATION_POLICY");
  });

  test("allows an explicitly configured public login page without trusting other pages on that origin", async () => {
    let currentUrl = "https://portal.bank.example/personal";
    let destroyed = false;
    const handlers = new Map<string, (...args: never[]) => void>();
    class FakeWindow {
      webContents = {
        session: { setPermissionRequestHandler() {}, clearStorageData: () => Promise.resolve() },
        setWindowOpenHandler() {},
        on: (name: string, handler: (...args: never[]) => void) => { handlers.set(name, handler); },
        getURL: () => currentUrl
      };
      isDestroyed() { return destroyed; } show() {} on() {} destroy() { destroyed = true; }
      loadURL(url: string) { currentUrl = url; return Promise.resolve(); }
    }
    const driver = createElectronKutxabankBrowserDriver({ browserSession: sharedBankSession as never,
      BrowserWindow: FakeWindow as never, loginUrl: currentUrl,
      allowedOrigin: "https://bank.example", allowedPathPrefixes: ["/login", "/summary"],
      allowedEntryUrls: ["https://portal.bank.example/personal"]
    });
    await driver.open();
    let prevented = false;
    const event = { preventDefault: () => { prevented = true; } };
    handlers.get("will-navigate")?.(event as never, "https://bank.example/login" as never);
    expect({ destroyed, prevented }).toEqual({ destroyed: false, prevented: false });
    handlers.get("will-navigate")?.(event as never, "https://portal.bank.example/other" as never);
    expect({ destroyed, prevented }).toEqual({ destroyed: true, prevented: true });
  });

  test("diagnoses a blocked bank pathname without retaining session or query data", async () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    let diagnostics: readonly { event: string; route?: string }[] = [];
    class FakeWindow {
      destroyed = false;
      webContents = {
        session: { setPermissionRequestHandler() {}, clearStorageData: () => Promise.resolve() },
        setWindowOpenHandler() {},
        on: (name: string, handler: (...args: unknown[]) => void) => { handlers.set(name, handler); },
        getURL: () => "https://bank.example/login"
      };
      isDestroyed() { return this.destroyed; } show() {} on() {}
      destroy() { this.destroyed = true; }
      loadURL() { return Promise.resolve(); }
    }
    const driver = createElectronKutxabankBrowserDriver({ browserSession: sharedBankSession as never,
      BrowserWindow: FakeWindow as never,
      loginUrl: "https://bank.example/login",
      allowedOrigin: "https://bank.example",
      allowedPathPrefixes: ["/login"],
      onDiagnostics: entries => { diagnostics = entries; }
    });
    await driver.open();
    handlers.get("will-navigate")?.(
      { preventDefault() {}, isMainFrame: true },
      "https://bank.example/NASApp/BesaideNet2/pages/SCA/login/resultado_2.iface;jsessionid=SECRET?code=SECRET#SECRET",
      false,
      true
    );

    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: "navigation-blocked",
      route: "/NASApp/BesaideNet2/pages/SCA/login/resultado_2.iface"
    }));
    expect(JSON.stringify(diagnostics)).not.toMatch(/SECRET|jsessionid|code/);
  });

  test.each(["redirect", "network"] as const)("reports a safe %s opening failure and allows retry", async (failure) => {
    let attempts = 0;
    const windows: FakeWindow[] = [];
    class FakeWindow {
      destroyed = false;
      events = new Map<string, (...args: unknown[]) => void>();
      closed: (() => void) | undefined;
      webContents = {
        session: { setPermissionRequestHandler() {}, clearStorageData: () => Promise.resolve() },
        setWindowOpenHandler() {},
        on: (name: string, handler: (...args: unknown[]) => void) => { this.events.set(name, handler); },
        getURL: () => "https://bank.example/login"
      };
      constructor() { windows.push(this); }
      isDestroyed() { return this.destroyed; }
      show() {}
      on(name: string, handler: () => void) { if (name === "closed") this.closed = handler; }
      destroy() { this.destroyed = true; this.closed?.(); }
      loadURL() {
        attempts += 1;
        if (attempts === 1) {
          if (failure === "redirect") this.events.get("will-redirect")?.(
            { preventDefault() {}, url: "https://bank.example/unexpected?secret=private", isMainFrame: true },
            "https://bank.example/unexpected?secret=private", false, true
          );
          return Promise.reject(new Error(failure === "redirect"
            ? "ERR_ABORTED private URL and token"
            : "ERR_FAILED private URL and token"));
        }
        return Promise.resolve();
      }
    }
    const driver = createElectronKutxabankBrowserDriver({ browserSession: sharedBankSession as never,
      BrowserWindow: FakeWindow as never, loginUrl: "https://bank.example/login",
      allowedOrigin: "https://bank.example", allowedPathPrefixes: ["/login"]
    });
    await expect(driver.open()).rejects.toThrow(failure === "redirect" ? "NAVIGATION_BLOCKED" : "BANK_LOAD_FAILED");
    expect(windows[0]?.destroyed).toBe(true);
    await expect(driver.open()).resolves.toBeUndefined();
    expect(attempts).toBe(2);
    await driver.close();
  });

  test("keeps the entry window open when an allowed cookie reload aborts the initial load", async () => {
    let currentUrl = "https://portal.bank.example/personal";
    let destroyed = false;
    let diagnostics: readonly { event: string; route?: string }[] = [];
    const handlers = new Map<string, (...args: unknown[]) => void>();
    class FakeWindow {
      webContents = {
        session: { setPermissionRequestHandler() {}, clearStorageData: () => Promise.resolve() },
        setWindowOpenHandler() {},
        on: (name: string, handler: (...args: unknown[]) => void) => { handlers.set(name, handler); },
        getURL: () => currentUrl,
        executeJavaScript: () => Promise.resolve({ state: "login" })
      };
      isDestroyed() { return destroyed; } show() {} on() {}
      destroy() { destroyed = true; }
      loadURL(url: string) {
        currentUrl = url;
        handlers.get("will-navigate")?.({ preventDefault() {}, url, isMainFrame: true }, url, false, true);
        return Promise.reject(new Error(`ERR_ABORTED (-3) loading '${url}'`));
      }
    }
    const driver = createElectronKutxabankBrowserDriver({ browserSession: sharedBankSession as never,
      BrowserWindow: FakeWindow as never,
      loginUrl: currentUrl,
      allowedOrigin: "https://bank.example",
      allowedPathPrefixes: ["/login"],
      allowedEntryUrls: [currentUrl],
      onDiagnostics: entries => { diagnostics = entries; }
    });

    await expect(driver.open()).resolves.toBeUndefined();
    expect(destroyed).toBe(false);
    await expect(driver.snapshot()).resolves.toEqual({ state: "login" });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: "load-aborted-continued", route: "public-entry"
    }));
    await driver.close();
  });

  test.each(["https://bank.example/login", "about:blank"])("adopts the login popup %s in the same session and closes both windows together", async (popupUrl) => {
    let diagnostics: readonly { event: string; window: number; route?: string }[] = [];
    const created: FakeWindow[] = [];
    class FakeWindow {
      destroyed = false;
      url = "https://portal.bank.example/personal";
      hidden = false;
      handler: ((details: { url: string }) => { action: string; overrideBrowserWindowOptions?: Record<string, unknown> }) | undefined;
      events = new Map<string, (...args: unknown[]) => void>();
      closed: (() => void) | undefined;
      webContents = {
        session: { setPermissionRequestHandler() {}, clearStorageData: vi.fn(() => Promise.resolve()) },
        setWindowOpenHandler: (handler: typeof this.handler) => { this.handler = handler; },
        on: (name: string, handler: (...args: unknown[]) => void) => { this.events.set(name, handler); },
        getURL: () => this.url,
        executeJavaScript: () => Promise.resolve({ state: "login" })
      };
      constructor(public options: Record<string, unknown>) { created.push(this); }
      isDestroyed() { return this.destroyed; } show() {} hide() { this.hidden = true; }
      on(name: string, handler: () => void) { if (name === "closed") this.closed = handler; }
      destroy() { if (!this.destroyed) { this.destroyed = true; this.closed?.(); } }
      loadURL(url: string) { this.url = url; return Promise.resolve(); }
    }
    const driver = createElectronKutxabankBrowserDriver({ browserSession: sharedBankSession as never,
      BrowserWindow: FakeWindow as never, loginUrl: "https://portal.bank.example/personal",
      allowedOrigin: "https://bank.example", allowedPathPrefixes: ["/login", "/summary"],
      allowedEntryUrls: ["https://portal.bank.example/personal"],
      onDiagnostics: entries => {
        diagnostics = entries;
        if (entries.length === 128) throw new Error("Synthetic diagnostic disk failure");
      }
    });
    await driver.open();
    const entry = created[0];
    if (!entry) throw new Error("Expected entry window");
    expect(entry.handler?.({ url: "https://evil.example/login" }).action).toBe("deny");
    const popup = entry.handler?.({ url: popupUrl });
    expect(popup?.action).toBe("allow");
    expect(popup?.overrideBrowserWindowOptions?.webPreferences).toMatchObject({
      session: sharedBankSession,
      sandbox: true, nodeIntegration: false, contextIsolation: true
    });
    const child = new FakeWindow(popup?.overrideBrowserWindowOptions ?? {});
    child.url = "https://bank.example/summary";
    entry.events.get("did-create-window")?.(child, { url: popupUrl });
    expect(entry.hidden).toBe(true);
    await expect(driver.snapshot()).resolves.toEqual({ state: "login" });
    expect(child.handler?.({ url: "https://bank.example/login" }).action).toBe("deny");
    if (popupUrl === "about:blank") {
      child.events.get("will-navigate")?.({ preventDefault() {} }, "https://bank.example/NASApp/BesaideNet2/pages/login/login_inicio.iface;jsessionid=SECRET?password=SECRET#SECRET");
      expect([entry.destroyed, child.destroyed]).toEqual([true, true]);
      await expect(driver.snapshot()).rejects.toThrow("NAVIGATION_BLOCKED");
      expect(diagnostics).toContainEqual(expect.objectContaining({
        event: "navigation-blocked", window: 2,
        route: "/NASApp/BesaideNet2/pages/login/login_inicio.iface"
      }));
    }
    await driver.close();
    expect([entry.destroyed, child.destroyed]).toEqual([true, true]);
    expect(diagnostics).toContainEqual(expect.objectContaining({ event: "window-created", window: 2 }));
    expect(diagnostics.filter(entry => entry.event === "window-closed")).toHaveLength(2);
    expect(JSON.stringify(diagnostics)).not.toMatch(/SECRET|evil\.example|password|jsessionid/);
    await driver.open();
    expect(diagnostics.map(entry => entry.event)).toEqual(["session-open", "window-created"]);
    const reopened = created[2];
    for (let index = 0; index < 200; index += 1) {
      reopened?.events.get("did-navigate")?.({}, "https://bank.example/summary?token=SECRET");
    }
    expect(diagnostics).toHaveLength(128);
    expect(reopened?.destroyed).toBe(false);
    expect(JSON.stringify(diagnostics)).not.toContain("SECRET");
    await driver.close();
  });

  test("Electron snapshot executes against the DOM and reads a movement table before persistent card controls", async () => {
    class FakeElement {
      id = ""; textContent = ""; value = ""; checked = false;
      children = new Map<string, FakeElement[]>();
      click() {} focus() {} blur() {} dispatchEvent() { return true; }
      querySelectorAll(selector: string) { return this.children.get(selector) ?? []; }
      querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
      closest() { return this; }
    }
    class FakeInput extends FakeElement {}
    class FakeLabel extends FakeElement { htmlFor = ""; }
    vi.stubGlobal("HTMLElement", FakeElement);
    vi.stubGlobal("HTMLInputElement", FakeInput);
    vi.stubGlobal("HTMLLabelElement", FakeLabel);
    const elements = new Map<string, FakeElement>();
    const add = (id: string, value = "") => { const item = new FakeInput(); item.id = id; item.value = value; elements.set(id, item); return item; };
    const table = add("formListado:dataContent");
    const row = new FakeElement();
    for (let index = 0; index < 5; index += 1) {
      const cell = new FakeElement(); cell.textContent = ["02/09/2026", "COMPRA", "03/09/2026", "-1,00 €", ""][index] ?? "";
      row.children.set(`[id$="gridContent-0-${index}"]`, [cell]);
    }
    table.children.set(":scope > tbody > tr", [row]);
    const selected = add("formMenuOpciones:PanelSeries:0:SelectRadioMenuContratos:_0"); selected.checked = true;
    const pan = new FakeElement(); pan.textContent = "1111 2222 3333 4444";
    const balance = new FakeElement(); balance.textContent = "999,99 €";
    selected.children.set("span, label, td, a", [pan, balance]);
    const aliasCells = ["1111 2222 3333 4444", "", "Visa compras", "999,99 €"].map(text => {
      const cell = new FakeElement(); cell.textContent = text; return cell;
    });
    selected.children.set("td", aliasCells);
    vi.stubGlobal("getComputedStyle", (node: FakeElement) => ({ color: node === aliasCells[3] ? "rgb(180, 0, 0)" : "rgb(0, 0, 0)" }));
    for (const [suffix, value] of [["anyo", "2026"], ["mes", "09"], ["dias", "01"]]) add(`formCriterios:calendarioDesde_cmb_${suffix}`, value);
    for (const [suffix, value] of [["anyo", "2026"], ["mes", "09"], ["dias", "15"]]) add(`formCriterios:calendarioHasta_cmb_${suffix}`, value);
    const headerTexts = ["Fecha", "Concepto", "Fecha imputación", "Importe", "Situación"].map(text => { const item = new FakeElement(); item.textContent = text; return item; });
    const document = {
      body: { innerText: "" }, readyState: "complete",
      getElementById: (id: string) => elements.get(id) ?? null,
      querySelectorAll: (selector: string) => selector === '[id="formListado:data"] th' ? headerTexts
        : selector.startsWith('input[type="radio"]') ? [selected] : [],
      querySelector: (selector: string) => selector.includes(":checked") ? selected : null
    };
    let currentUrl = "https://bank.example/pages/tarjetas/tarjetas_movimientos_seleccion.iface";
    class FakeWindow {
      webContents = {
        session: { setPermissionRequestHandler() {}, clearStorageData: () => Promise.resolve() },
        setWindowOpenHandler() {}, on() {}, getURL: () => currentUrl,
        // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return
        executeJavaScript: (script: string) => Function("document", `return ${script}`)(document)
      };
      isDestroyed() { return false; } show() {} on() {} destroy() {}
      loadURL(url: string) { currentUrl = url; return Promise.resolve(); }
    }
    const driver = createElectronKutxabankBrowserDriver({ browserSession: sharedBankSession as never,
      BrowserWindow: FakeWindow as never,
      loginUrl: currentUrl,
      allowedOrigin: "https://bank.example",
      allowedPathPrefixes: ["/pages/tarjetas/"]
    });
    await driver.open();
    await expect(driver.snapshot()).resolves.toMatchObject({
      state: "table",
      selectedControlId: selected.id,
      table: { headers: headerTexts.map(item => item.textContent), rows: [["02/09/2026", "COMPRA", "03/09/2026", "-1,00 €", ""]] }
    });
    await expect(driver.snapshot("cards")).resolves.toEqual({
      state: "cards", cards: [{ controlId: selected.id, panText: "1111222233334444", alias: "Visa compras",
        balance: { text: "999,99 €", isRed: true } }]
    });
    vi.unstubAllGlobals();
  });

  test("Electron actions click the labeled movements radio and fill observed text date inputs after Entre fechas", async () => {
    let mutation: (() => void) | undefined;
    class FakeMutationObserver {
      constructor(callback: () => void) { mutation = callback; }
      observe() {}
      disconnect() { mutation = undefined; }
    }
    vi.stubGlobal("MutationObserver", FakeMutationObserver);
    class FakeElement {
      id = ""; value = ""; textContent = ""; clicks = 0;
      click() { this.clicks += 1; mutation?.(); } focus() {} blur() {} dispatchEvent() { return true; }
      scrollIntoView() {}
      getBoundingClientRect() { return { left: 10, top: 10, width: 28, height: 16 }; }
    }
    class FakeInput extends FakeElement { checked = false; type = "radio"; override click() { super.click(); this.checked = true; } }
    class FakeLabel extends FakeElement { htmlFor = ""; }
    const values = new Map<string, FakeElement>();
    const addInput = (id: string) => { const item = new FakeInput(); item.id = id; values.set(id, item); return item; };
    const between = addInput("formCriterios:criteriosMovimientos:_5");
    const week = addInput("formCriterios:criteriosMovimientos:_1");
    let betweenPending = false;
    between.click = () => {
      between.clicks += 1; between.checked = true; week.checked = false; mutation?.();
      if (between.clicks === 2) {
        betweenPending = true;
        setTimeout(() => { betweenPending = false; }, 350);
      }
    };
    week.click = () => {
      if (betweenPending) throw new Error("overlapping-bank-queries");
      week.clicks += 1; week.checked = true; between.checked = false; mutation?.();
    };
    const movements = addInput("formMenu:movimientos");
    const secondCard = addInput("formMenuOpciones:PanelSeries:0:SelectRadioMenuContratos:_1");
    const cardLabel = new FakeLabel(); cardLabel.htmlFor = secondCard.id;
    let cardScrolled = false;
    cardLabel.scrollIntoView = () => { cardScrolled = true; };
    cardLabel.getBoundingClientRect = () => ({ left: 10, top: cardScrolled ? 70 : -170, width: 28, height: 16 });
    const label = new FakeLabel(); label.textContent = "Movimientos"; label.htmlFor = movements.id;
    label.getBoundingClientRect = () => ({ left: 10, top: 40, width: 28, height: 16 });
    const betweenLabel = new FakeLabel(); betweenLabel.textContent = "Entre fechas"; betweenLabel.htmlFor = between.id;
    betweenLabel.click = () => { between.click(); };
    const weekLabel = new FakeLabel(); weekLabel.textContent = "Última semana"; weekLabel.htmlFor = week.id;
    weekLabel.getBoundingClientRect = () => ({ left: 50, top: 10, width: 28, height: 16 });
    for (const prefix of ["formCriterios:calendarioDesde", "formCriterios:calendarioHasta"])
      for (const suffix of ["dias", "mes", "anyo"]) addInput(`${prefix}_cmb_${suffix}`);
    const document = {
      readyState: "complete", documentElement: {},
      getElementById: (id: string) => values.get(id) ?? null,
      querySelector: (selector: string) => selector.includes('id$=":_5"') ? between : null,
      querySelectorAll: (selector: string) => selector === "label" ? [label, betweenLabel, weekLabel, cardLabel]
        : selector.includes('[id="formMenuOpciones"]') ? [label] : []
    };
    let currentUrl = "https://bank.example/pages/tarjetas/tarjetas_movimientos_seleccion.iface";
    class FakeWindow {
      webContents = {
        session: { setPermissionRequestHandler() {}, clearStorageData: () => Promise.resolve() },
        setWindowOpenHandler() {}, on() {}, getURL: () => currentUrl, isLoading: () => false,
        sendInputEvent: (event: { type: string; x: number; y: number }) => {
          if (event.type === "mouseDown" && event.y < 0) throw new Error("offscreen-click");
          if (event.type === "mouseUp") (event.x > 40 ? week : event.y > 60 ? secondCard : event.y > 20 ? movements : between).click();
        },
        // eslint-disable-next-line @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return
        executeJavaScript: (script: string) => Function(
          "document", "HTMLElement", "HTMLInputElement", "HTMLLabelElement", `return ${script}`
        )(document, FakeElement, FakeInput, FakeLabel)
      };
      isDestroyed() { return false; } show() {} focus() {} on() {} destroy() {}
      loadURL(url: string) { currentUrl = url; return Promise.resolve(); }
    }
    const driver = createElectronKutxabankBrowserDriver({ browserSession: sharedBankSession as never,
      BrowserWindow: FakeWindow as never, loginUrl: currentUrl,
      allowedOrigin: "https://bank.example", allowedPathPrefixes: ["/pages/tarjetas/"]
    });
    await driver.open();
    await driver.selectCard(secondCard.id);
    await driver.showMovements();
    await driver.setDateRange("2026-06-01", "2026-09-15");
    await driver.setPeriod?.("week");
    await driver.setPeriod?.("week");
    await driver.selectCard(secondCard.id);
    expect({ card: secondCard.clicks, movements: movements.clicks, between: between.clicks, week: week.clicks })
      .toEqual({ card: 1, movements: 1, between: 2, week: 2 });
    expect(cardScrolled).toBe(true);
    expect(values.get("formCriterios:calendarioDesde_cmb_dias")?.value).toBe("01");
    expect(values.get("formCriterios:calendarioHasta_cmb_anyo")?.value).toBe("2026");
    vi.unstubAllGlobals();
  });

  test("activates the date range before waiting for its asynchronously rendered fields", async () => {
    let controlChecks = 0;
    let mouseDown = false;
    class FakeWindow {
      webContents = {
        session: { setPermissionRequestHandler() {}, clearStorageData: () => Promise.resolve() },
        setWindowOpenHandler() {}, on() {},
        getURL: () => "https://bank.example/pages/tarjetas/movimientos.iface",
        isLoading: () => false,
        sendInputEvent: (event: { type: string; x: number; y: number }) => {
          if (event.type === "mouseDown" && event.x === 24 && event.y === 18) mouseDown = true;
        },
        executeJavaScript: (script: string) => {
          if (script.includes("const controls = [...document.querySelectorAll")) {
            return Promise.resolve("formMenu:movimientos");
          }
          if (script.includes("const ids =") && script.includes("calendarioDesde")) {
            if (!mouseDown) return Promise.reject(new Error("date-controls-before-mousedown"));
            controlChecks += 1;
            return Promise.resolve(controlChecks >= 3);
          }
          if (script.includes("const ids =") && script.includes("formCriterios:criteriosMovimientos:_5")) {
            return Promise.resolve(true);
          }
          if (script.includes("getBoundingClientRect")) {
            return Promise.resolve({ x: 24, y: 18 });
          }
          if (script.includes("const control = document.getElementById")) {
            return Promise.resolve(script.includes("const state = globalThis.__kakeboReadAction"));
          }
          if (script.includes("const element = document.getElementById")) {
            return Promise.resolve(true);
          }
          if (script.includes("document.readyState === 'complete'")) return Promise.resolve(true);
          return Promise.resolve(undefined);
        }
      };
      isDestroyed() { return false; } show() {} focus() {} on() {} destroy() {}
      loadURL() { return Promise.resolve(); }
    }
    const driver = createElectronKutxabankBrowserDriver({ browserSession: sharedBankSession as never,
      BrowserWindow: FakeWindow as never,
      loginUrl: "https://bank.example/pages/tarjetas/movimientos.iface",
      allowedOrigin: "https://bank.example",
      allowedPathPrefixes: ["/pages/tarjetas/"]
    });
    await driver.open();

    await driver.showMovements();
    await driver.setDateRange("2026-06-01", "2026-09-15");

    expect(mouseDown).toBe(true);
    expect(controlChecks).toBe(3);
  });

  test("waits until the next-page control is under the mouse before clicking", async () => {
    const events: Array<{ type: string; x: number; y: number }> = [];
    let hitChecks = 0;
    class FakeWindow {
      webContents = {
        session: { setPermissionRequestHandler() {}, clearStorageData: () => Promise.resolve() },
        setWindowOpenHandler() {}, on() {},
        getURL: () => "https://bank.example/pages/tarjetas/movimientos.iface",
        isLoading: () => false,
        sendInputEvent: (event: { type: string; x: number; y: number }) => { events.push(event); },
        executeJavaScript: (script: string) => Promise.resolve(
          script.includes("getBoundingClientRect") ? { x: 30, y: 40, hit: ++hitChecks >= 3 } : true)
      };
      isDestroyed() { return false; } show() {} focus() {} on() {} destroy() {}
      loadURL() { return Promise.resolve(); }
    }
    const driver = createElectronKutxabankBrowserDriver({ browserSession: sharedBankSession as never,
      BrowserWindow: FakeWindow as never,
      loginUrl: "https://bank.example/pages/tarjetas/movimientos.iface",
      allowedOrigin: "https://bank.example", allowedPathPrefixes: ["/pages/tarjetas/"]
    });
    await driver.open();
    await driver.nextPage();
    expect(hitChecks).toBe(3);
    expect(events).toEqual([
      expect.objectContaining({ type: "mouseMove", x: 30, y: 40 }),
      expect.objectContaining({ type: "mouseDown", x: 30, y: 40 }),
      expect.objectContaining({ type: "mouseUp", x: 30, y: 40 })
    ]);
  });

  test("records whether a next-page click reached the bank and sent a request", async () => {
    let sent: ((details: { id: number; url: string; method: string }) => void) | undefined;
    let completed: ((details: { id: number; url: string; method: string }) => void) | undefined;
    let diagnostics: readonly { event: string; clickDelivered?: boolean; trustedClick?: boolean;
      requestSent?: boolean; requestCompleted?: boolean }[] = [];
    class FakeWindow {
      webContents = {
        session: {
          setPermissionRequestHandler() {}, clearStorageData: () => Promise.resolve(),
          webRequest: {
            onSendHeaders: (listener: typeof sent) => { sent = listener; },
            onCompleted: (listener: typeof completed) => { completed = listener; },
            onErrorOccurred() {}
          }
        },
        setWindowOpenHandler() {}, on() {},
        getURL: () => "https://bank.example/pages/tarjetas/movimientos.iface",
        sendInputEvent: (event: { type: string }) => {
          if (event.type === "mouseUp") {
            const request = { id: 1,
              url: "https://bank.example/pages/tarjetas/private.iface?secret=never-log", method: "POST" };
            sent?.(request); completed?.(request);
          }
        },
        executeJavaScript: (script: string) => Promise.resolve(
          script.includes("getBoundingClientRect") ? { x: 30, y: 40, hit: true }
            : script.includes("__kakeboNextPageProbe") ? { delivered: true, trusted: true } : true)
      };
      isDestroyed() { return false; } show() {} focus() {} on() {} destroy() {}
      loadURL() { return Promise.resolve(); }
    }
    const driver = createElectronKutxabankBrowserDriver({ browserSession: sharedBankSession as never,
      BrowserWindow: FakeWindow as never,
      loginUrl: "https://bank.example/pages/tarjetas/movimientos.iface",
      allowedOrigin: "https://bank.example", allowedPathPrefixes: ["/pages/tarjetas/"],
      onDiagnostics: entries => { diagnostics = entries; }
    });
    await driver.open();
    await driver.nextPage();
    driver.reportPageState?.({ event: "page-wait-timeout", stage: "next", state: "table" });
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: "page-wait-timeout", clickDelivered: true, trustedClick: true,
      requestSent: true, requestCompleted: true
    }));
    expect(JSON.stringify(diagnostics)).not.toContain("never-log");
  });

  test("waits for bank requests to settle before clicking the next page", async () => {
    const events: string[] = [];
    let sent: ((details: { id: number; url: string; method: string }) => void) | undefined;
    let completed: ((details: { id: number; url: string; method: string }) => void) | undefined;
    class FakeWindow {
      webContents = {
        session: {
          setPermissionRequestHandler() {}, clearStorageData: () => Promise.resolve(),
          webRequest: {
            onSendHeaders: (listener: typeof sent) => { sent = listener; },
            onCompleted: (listener: typeof completed) => { completed = listener; },
            onErrorOccurred() {}
          }
        },
        setWindowOpenHandler() {}, on() {},
        getURL: () => "https://bank.example/pages/tarjetas/movimientos.iface",
        sendInputEvent: (event: { type: string }) => { events.push(event.type); },
        executeJavaScript: (script: string) => Promise.resolve(
          script.includes("getBoundingClientRect") ? { x: 30, y: 40, hit: true }
            : script.includes("__kakeboNextPageProbe") ? { delivered: true, trusted: true } : true)
      };
      isDestroyed() { return false; } show() {} focus() {} on() {} destroy() {}
      loadURL() { return Promise.resolve(); }
    }
    const driver = createElectronKutxabankBrowserDriver({ browserSession: sharedBankSession as never,
      BrowserWindow: FakeWindow as never,
      loginUrl: "https://bank.example/pages/tarjetas/movimientos.iface",
      allowedOrigin: "https://bank.example", allowedPathPrefixes: ["/pages/tarjetas/"]
    });
    await driver.open();
    const request = { id: 1, url: "https://bank.example/pages/tarjetas/private.iface", method: "POST" };
    sent?.(request);
    const advancing = driver.nextPage();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(events).toEqual([]);
    completed?.(request);
    const completedAt = Date.now();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(events).toEqual([]);
    await advancing;
    expect(Date.now() - completedAt).toBeGreaterThanOrEqual(1900);
    expect(events).toEqual(["mouseMove", "mouseDown", "mouseUp"]);
  });

  test("diagnoses a date action failure without recording the requested dates", async () => {
    let diagnostics: readonly { event: string; action?: string; reason?: string }[] = [];
    class FakeWindow {
      webContents = {
        session: { setPermissionRequestHandler() {}, clearStorageData: () => Promise.resolve() },
        setWindowOpenHandler() {}, on() {},
        getURL: () => "https://bank.example/pages/tarjetas/movimientos.iface",
        executeJavaScript: () => Promise.reject(new Error("Error executing JavaScript: date-reset"))
      };
      isDestroyed() { return false; } show() {} on() {} destroy() {}
      loadURL() { return Promise.resolve(); }
    }
    const driver = createElectronKutxabankBrowserDriver({ browserSession: sharedBankSession as never,
      BrowserWindow: FakeWindow as never,
      loginUrl: "https://bank.example/pages/tarjetas/movimientos.iface",
      allowedOrigin: "https://bank.example",
      allowedPathPrefixes: ["/pages/tarjetas/"],
      onDiagnostics: entries => { diagnostics = entries; }
    });
    await driver.open();

    await expect(driver.setDateRange("2025-04-03", "2025-05-06")).rejects.toThrow("date-reset");
    expect(diagnostics).toContainEqual(expect.objectContaining({
      event: "action-failed", action: "set-date-range", reason: "date-reset"
    }));
    expect(JSON.stringify(diagnostics)).not.toMatch(/2025-04-03|2025-05-06/);
  });
});
