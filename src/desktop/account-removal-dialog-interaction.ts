import type { EditableAccount } from "../storage/repositories/account-repository.js";
import {
  selectedAccountRemovalMode,
  type AccountRemovalMode
} from "./account-removal-dialog.js";

export function bindAccountRemovalDialogInteractions(input: {
  modal: HTMLElement;
  controls: Array<HTMLInputElement | HTMLButtonElement>;
  modeInputs: HTMLInputElement[];
  cancel: HTMLButtonElement;
  confirm: HTMLButtonElement;
  previousFocus: HTMLElement | undefined;
  activeElement: () => Element | null;
  finish: (mode: AccountRemovalMode | undefined) => void;
}): () => void {
  const finish = (mode: AccountRemovalMode | undefined): void => {
    input.finish(mode);
    if (input.previousFocus?.isConnected && !input.previousFocus.closest("[inert]")) {
      input.previousFocus.focus();
    }
  };
  const keydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      finish(undefined);
      return;
    }
    if (event.key !== "Tab") return;
    const controls = input.controls.filter((control) => !control.disabled && !control.hidden);
    const first = controls[0];
    const last = controls.at(-1);
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    const active = input.activeElement();
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    } else if (!input.modal.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  };
  const cancel = (): void => finish(undefined);
  const confirm = (): void => {
    const selected = input.modeInputs.find((mode) => mode.checked);
    finish(selectedAccountRemovalMode(selected?.value));
  };
  input.modal.addEventListener("keydown", keydown);
  input.cancel.addEventListener("click", cancel);
  input.confirm.addEventListener("click", confirm);
  return () => {
    input.modal.removeEventListener("keydown", keydown);
    input.cancel.removeEventListener("click", cancel);
    input.confirm.removeEventListener("click", confirm);
  };
}

export async function runAccountRemovalFromDialog<Bootstrap, Removal>(input: {
  account: EditableAccount;
  openDialog: () => Promise<AccountRemovalMode | undefined>;
  removeAccount: (request: {
    id: string;
    mode: AccountRemovalMode;
  }) => Promise<{ bootstrap: Bootstrap; removal: Removal }>;
  applyBootstrap: (bootstrap: Bootstrap, options: { preserveUnsaved: true }) => void;
}): Promise<{ bootstrap: Bootstrap; removal: Removal } | undefined> {
  const mode = await input.openDialog();
  if (!mode) return undefined;
  const result = await input.removeAccount({ id: input.account.id, mode });
  input.applyBootstrap(result.bootstrap, { preserveUnsaved: true });
  return result;
}
