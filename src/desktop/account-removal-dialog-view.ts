import type { EditableAccount } from "../storage/repositories/account-repository.js";
import { createAccountRemovalDialogModel } from "./account-removal-dialog.js";

export type Translate = (key: string, fallback: string) => string;

export interface AccountRemovalDialogView {
  modal: HTMLElement;
  identity: HTMLElement;
  modeInputs: HTMLInputElement[];
  cancel: HTMLButtonElement;
  confirm: HTMLButtonElement;
}

function identityRow(
  document: Document,
  label: string,
  value: string | null
): HTMLDivElement | undefined {
  if (!value) return undefined;
  const row = document.createElement("div");
  const name = document.createElement("strong");
  name.textContent = `${label}: `;
  const detail = document.createElement("span");
  detail.textContent = value;
  row.append(name, detail);
  return row;
}

export function renderAccountRemovalDialog(
  document: Document,
  account: EditableAccount,
  t: Translate
): AccountRemovalDialogView {
  const model = createAccountRemovalDialogModel(account);
  const modal = document.createElement("div");
  modal.className = "app-modal";
  modal.setAttribute("role", model.accessibility.role);
  modal.setAttribute("aria-modal", "true");
  modal.setAttribute("aria-labelledby", "account-removal-title");
  modal.setAttribute("aria-describedby", "account-removal-description");
  const card = document.createElement("div");
  card.className = "app-modal-card";
  const kicker = document.createElement("p");
  kicker.className = "section-kicker";
  kicker.textContent = t("dialog.kicker", "Confirmation");
  const title = document.createElement("h2");
  title.id = "account-removal-title";
  title.textContent = t("accountRemoval.title", "Remove local account");
  const description = document.createElement("p");
  description.id = "account-removal-description";
  description.textContent = t("accountRemoval.description", "Remove this account locally.");
  const identity = document.createElement("div");
  identity.className = "account-removal-identity";
  const rows = [
    identityRow(document, t("accountRemoval.identity.bank", "Bank"), model.identity.bank),
    identityRow(
      document,
      t("accountRemoval.identity.connection", "Connection"),
      model.identity.connection
    ),
    identityRow(
      document,
      t("accountRemoval.identity.account", "Account"),
      model.identity.displayName
    ),
    identityRow(document, t("accountRemoval.identity.alias", "Alias"), model.identity.alias),
    identityRow(
      document,
      t("accountRemoval.identity.identifier", "Masked identifier"),
      model.identity.maskedIdentifier
    )
  ].filter((row): row is HTMLDivElement => row !== undefined);
  identity.append(...rows);
  const choices = document.createElement("fieldset");
  choices.className = "field";
  choices.setAttribute("role", model.accessibility.selectionRole);
  const legend = document.createElement("legend");
  legend.textContent = t("accountRemoval.choice", "Removal option");
  choices.append(legend);
  const modeInputs: HTMLInputElement[] = [];
  for (const option of model.options) {
    const label = document.createElement("label");
    label.className = "check-option";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = "account-removal-mode";
    input.value = option.mode;
    input.checked = option.mode === model.initialMode;
    const copy = document.createElement("span");
    const heading = document.createElement("strong");
    heading.textContent = t(
      `accountRemoval.${option.mode === "keep-history" ? "keepHistory" : "deleteHistory"}.label`,
      option.mode
    );
    const detail = document.createElement("small");
    detail.textContent = t(
      `accountRemoval.${option.mode === "keep-history" ? "keepHistory" : "deleteHistory"}.description`,
      ""
    );
    copy.append(heading, detail);
    if (option.destructive) {
      const warning = document.createElement("small");
      warning.className = "account-last-error";
      warning.textContent = t(
        "accountRemoval.deleteHistory.warning",
        "This local history deletion is irreversible."
      );
      copy.append(warning);
    }
    label.append(input, copy);
    choices.append(label);
    modeInputs.push(input);
  }
  const actions = document.createElement("div");
  actions.className = "button-row";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "button secondary";
  cancel.textContent = t("accountRemoval.cancel", "Cancel");
  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = "button danger";
  confirm.textContent = t("accountRemoval.confirm", "Remove account");
  actions.append(cancel, confirm);
  card.append(kicker, title, description, identity, choices, actions);
  modal.append(card);
  return { modal, identity, modeInputs, cancel, confirm };
}
