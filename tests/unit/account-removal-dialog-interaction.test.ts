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

  it("uses Cancel, Escape, and focus trapping through dispatched DOM events", () => {
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
    const finish = vi.fn();

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

    modal.dispatchEvent(keydown("Tab"));
    expect(retain.focused).toBe(true);
    active = retain;
    modal.dispatchEvent(keydown("Tab", true));
    expect(confirm.focused).toBe(true);
    cancel.dispatchEvent(new Event("click"));
    modal.dispatchEvent(keydown("Escape"));
    retain.checked = false;
    destructive.checked = true;
    confirm.dispatchEvent(new Event("click"));

    expect(finish).toHaveBeenNthCalledWith(1, undefined);
    expect(finish).toHaveBeenNthCalledWith(2, undefined);
    expect(finish).toHaveBeenNthCalledWith(3, "delete-history");
    expect(priorFocus.focused).toBe(true);
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
