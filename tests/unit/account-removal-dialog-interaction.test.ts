import { describe, expect, it, vi } from "vitest";
import type { EditableAccount } from "../../src/storage/repositories/account-repository.js";
import { renderAccountRemovalDialog } from "../../src/desktop/account-removal-dialog-view.js";
import {
  bindAccountRemovalDialogInteractions,
  runAccountRemovalFromDialog
} from "../../src/desktop/account-removal-dialog-interaction.js";

class FakeElement extends EventTarget {
  public readonly children: FakeElement[] = [];
  public readonly attributes = new Map<string, string>();
  public className = "";
  public id = "";
  public textContent = "";
  public type = "";
  public name = "";
  public value = "";
  public checked = false;
  public disabled = false;
  public hidden = false;
  public isConnected = true;
  public focused = false;

  public constructor(public readonly tagName: string) {
    super();
  }

  public append(...children: FakeElement[]): void {
    this.children.push(...children);
  }

  public contains(element: unknown): boolean {
    return element === this || this.children.some((child) => child.contains(element));
  }

  public setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  public focus(): void {
    this.focused = true;
  }

  public closest(): null {
    return null;
  }
}

class FakeDocument {
  public createElement(tagName: string): FakeElement {
    return new FakeElement(tagName);
  }
}

function account(): EditableAccount {
  return {
    id: "account-1",
    identificationHash: "must-never-render",
    bank: "Example Bank",
    connection: "Home connection",
    account: "Daily account",
    masked: "ES** 1234",
    currency: "EUR",
    productType: null,
    alias: "Household",
    providerActive: true,
    syncEnabled: true,
    exportEnabled: true,
    lastError: null
  };
}

function keydown(key: string, shiftKey = false): KeyboardEvent {
  const event = new Event("keydown", { cancelable: true });
  Object.defineProperties(event, {
    key: { value: key },
    shiftKey: { value: shiftKey }
  });
  return event as KeyboardEvent;
}

function textContent(element: FakeElement): string {
  return `${element.textContent}${element.children.map(textContent).join("")}`;
}

function interactionFixture(
  finish: (mode: "keep-history" | "delete-history" | undefined) => void
): {
  modal: FakeElement;
  retain: FakeElement;
  destructive: FakeElement;
  cancel: FakeElement;
  confirm: FakeElement;
  priorFocus: FakeElement;
  setActive: (element: FakeElement) => void;
} {
  const modal = new FakeElement("div");
  const retain = new FakeElement("input");
  retain.value = "keep-history";
  retain.checked = true;
  const destructive = new FakeElement("input");
  destructive.value = "delete-history";
  const cancel = new FakeElement("button");
  const confirm = new FakeElement("button");
  const priorFocus = new FakeElement("button");
  let active: FakeElement = confirm;
  bindAccountRemovalDialogInteractions({
    modal: modal as unknown as HTMLElement,
    controls: [retain, destructive, cancel, confirm] as unknown as Array<
      HTMLInputElement | HTMLButtonElement
    >,
    modeInputs: [retain, destructive] as unknown as HTMLInputElement[],
    cancel: cancel as unknown as HTMLButtonElement,
    confirm: confirm as unknown as HTMLButtonElement,
    previousFocus: priorFocus as unknown as HTMLElement,
    activeElement: () => active as unknown as Element,
    finish
  });
  return {
    modal,
    retain,
    destructive,
    cancel,
    confirm,
    priorFocus,
    setActive: (element) => {
      active = element;
    }
  };
}

describe("account removal dialog renderer interactions", () => {
  it("renders only safe identity and starts with retain-history selected", () => {
    const view = renderAccountRemovalDialog(
      new FakeDocument() as unknown as Document,
      account(),
      (_key, fallback) => fallback
    );

    expect((view.modal as unknown as FakeElement).attributes.get("role")).toBe("dialog");
    expect(textContent(view.identity as unknown as FakeElement)).toContain("ES** 1234");
    expect(textContent(view.identity as unknown as FakeElement)).not.toContain(
      "must-never-render"
    );
    expect(view.modeInputs.map((input) => input.checked)).toEqual([true, false]);
  });

  it("prevents default while wrapping Tab and Shift+Tab focus", () => {
    const finish = vi.fn();
    const dialog = interactionFixture(finish);

    const forward = keydown("Tab");
    dialog.modal.dispatchEvent(forward);
    expect(forward.defaultPrevented).toBe(true);
    expect(dialog.retain.focused).toBe(true);
    dialog.setActive(dialog.retain);
    const backward = keydown("Tab", true);
    dialog.modal.dispatchEvent(backward);
    expect(backward.defaultPrevented).toBe(true);
    expect(dialog.confirm.focused).toBe(true);
    expect(finish).not.toHaveBeenCalled();
  });

  it("traps Shift+Tab from the checked destructive radio option", () => {
    const dialog = interactionFixture(vi.fn());
    dialog.retain.checked = false;
    dialog.destructive.checked = true;
    dialog.setActive(dialog.destructive);
    const backward = keydown("Tab", true);

    dialog.modal.dispatchEvent(backward);

    expect(backward.defaultPrevented).toBe(true);
    expect(dialog.confirm.focused).toBe(true);
  });

  it("Cancel terminally removes dialog listeners, restores focus, and does not remove", async () => {
    let resolveDialog: (mode: "keep-history" | "delete-history" | undefined) => void;
    const openDialog = new Promise<"keep-history" | "delete-history" | undefined>((resolve) => {
      resolveDialog = resolve;
    });
    const finish = vi.fn((mode: "keep-history" | "delete-history" | undefined) => {
      resolveDialog(mode);
    });
    const dialog = interactionFixture(finish);
    const removeAccount = vi.fn();
    const operation = runAccountRemovalFromDialog({
      account: account(),
      openDialog: () => openDialog,
      removeAccount,
      applyBootstrap: vi.fn()
    });

    dialog.cancel.dispatchEvent(new Event("click"));
    dialog.confirm.dispatchEvent(new Event("click"));

    await expect(operation).resolves.toBeUndefined();
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith(undefined);
    expect(dialog.priorFocus.focused).toBe(true);
    expect(removeAccount).not.toHaveBeenCalled();
  });

  it("Escape terminally removes dialog listeners, restores focus, and does not remove", async () => {
    let resolveDialog: (mode: "keep-history" | "delete-history" | undefined) => void;
    const openDialog = new Promise<"keep-history" | "delete-history" | undefined>((resolve) => {
      resolveDialog = resolve;
    });
    const finish = vi.fn((mode: "keep-history" | "delete-history" | undefined) => {
      resolveDialog(mode);
    });
    const dialog = interactionFixture(finish);
    const removeAccount = vi.fn();
    const operation = runAccountRemovalFromDialog({
      account: account(),
      openDialog: () => openDialog,
      removeAccount,
      applyBootstrap: vi.fn()
    });

    dialog.modal.dispatchEvent(keydown("Escape"));
    dialog.confirm.dispatchEvent(new Event("click"));

    await expect(operation).resolves.toBeUndefined();
    expect(finish).toHaveBeenCalledTimes(1);
    expect(finish).toHaveBeenCalledWith(undefined);
    expect(dialog.priorFocus.focused).toBe(true);
    expect(removeAccount).not.toHaveBeenCalled();
  });

  it("sends the explicitly selected destructive mode and applies the returned bootstrap", async () => {
    const bootstrap = { accounts: [{ id: "remaining" }] };
    const removeAccount = vi.fn().mockResolvedValue({ bootstrap, removal: { warnings: [] } });
    const applyBootstrap = vi.fn();

    await runAccountRemovalFromDialog({
      account: account(),
      openDialog: () => Promise.resolve("delete-history"),
      removeAccount,
      applyBootstrap
    });

    expect(removeAccount).toHaveBeenCalledWith({
      id: "account-1",
      mode: "delete-history"
    });
    expect(applyBootstrap).toHaveBeenCalledWith(bootstrap, { preserveUnsaved: true });
  });
});
