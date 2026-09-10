import { describe, expect, it } from "vitest";
import {
  cardImportProfileSchema,
  createDefaultCardImportProfiles
} from "../../src/settings/card-import-profiles-store.js";

function defaultProfile() {
  const profile = createDefaultCardImportProfiles()[0];
  if (!profile) throw new Error("The default card profile is missing.");
  return profile;
}

describe("card import profile validation", () => {
  it("rejects mappings that reuse a column for different fields", () => {
    const profile = defaultProfile();
    const result = cardImportProfileSchema.safeParse({
      ...profile,
      columns: { ...profile.columns, amount: profile.columns.date }
    });

    expect(result.success).toBe(false);
  });

  it("rejects columns beyond the XLSX XFD limit", () => {
    const profile = defaultProfile();
    const result = cardImportProfileSchema.safeParse({
      ...profile,
      columns: { ...profile.columns, amount: "XFE" }
    });

    expect(result.success).toBe(false);
  });
});
