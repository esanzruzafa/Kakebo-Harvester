import type { CardImportProfile } from "../settings/card-import-profiles-store.js";
import type { CategoryDefinition } from "../settings/categories-store.js";
import type {
  CategorizationExclusion,
  CategorizationRule
} from "../settings/categorization-rules-store.js";
import type { ExportSettings } from "../settings/export-settings-store.js";
import type { EditableAccount } from "../storage/repositories/account-repository.js";

export interface EditableDesktopState {
  accounts: EditableAccount[];
  cardImportProfiles: CardImportProfile[];
  exclusions: CategorizationExclusion[];
  rules: CategorizationRule[];
  categories: CategoryDefinition[];
  exportSettings: ExportSettings;
}

export type EditableDrafts = Partial<EditableDesktopState>;

export function mergeEditableDrafts(
  fresh: EditableDesktopState,
  drafts: EditableDrafts
): EditableDesktopState {
  const accountDrafts = new Map(
    (drafts.accounts ?? []).map((account) => [account.id, account])
  );
  return {
    accounts: drafts.accounts
      ? fresh.accounts.map((account) => {
          const draft = accountDrafts.get(account.id);
          return draft
            ? {
                ...account,
                alias: draft.alias,
                syncEnabled: draft.syncEnabled,
                exportEnabled: draft.exportEnabled
              }
            : account;
        })
      : fresh.accounts,
    cardImportProfiles:
      drafts.cardImportProfiles ?? fresh.cardImportProfiles,
    exclusions: drafts.exclusions ?? fresh.exclusions,
    rules: drafts.rules ?? fresh.rules,
    categories: drafts.categories ?? fresh.categories,
    exportSettings: drafts.exportSettings ?? fresh.exportSettings
  };
}
