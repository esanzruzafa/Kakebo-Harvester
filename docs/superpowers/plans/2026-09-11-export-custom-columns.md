# Export Custom Columns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add safe formula and manual export columns whose values persist for existing movements across CSV and XLSX synchronizations.

**Architecture:** Extend export settings with tagged built-in/custom columns, parse a deliberately limited expression syntax locally, and recover custom values from a compatible prior output by `movementKey`. The renderer edits the tagged columns using the existing ordered-table mechanics.

**Tech Stack:** TypeScript, Zod, Vitest, Electron renderer, `write-excel-file`, `read-excel-file`.

**Spec:** `docs/superpowers/specs/2026-09-11-export-custom-columns-design.md`

## Global Constraints

- Do not execute arbitrary code or emit spreadsheet formulas.
- Preserve custom values for existing `movementKey` values in CSV and XLSX.
- Compute formulas and initialize manual values only for new movements.
- Do not commit, push, or modify the base checkout.

---

### Task 1: Profile schema and safe formulas

**Files:**
- Create: `src/export/custom-formula.ts`
- Modify: `src/settings/export-settings-store.ts`
- Test: `tests/unit/export-settings.test.ts`
- Test: `tests/unit/custom-formula.test.ts`

**Interfaces:**
- Produces `evaluateCustomFormula(formula, values): string | number | boolean | null` and `customFormulaSchema`.
- Produces `ExportColumn = BuiltInExportColumn | CustomExportColumn`.

- [ ] **Step 1: Write the failing test**

```ts
expect(() => evaluateCustomFormula("amount * 2", { amount: 12 })).not.toThrow();
expect(evaluateCustomFormula("upper(description)", { description: "coffee" })).toBe("COFFEE");
expect(() => parseCustomFormula("process.exit(1)")).toThrow(/invalid/i);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -- tests/unit/custom-formula.test.ts tests/unit/export-settings.test.ts`

- [ ] **Step 3: Write minimal implementation**

Implement a token parser without `eval`, introduce tagged custom columns, retain legacy built-ins, and require a unique enabled `movementKey` when custom columns are enabled.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm test -- tests/unit/custom-formula.test.ts tests/unit/export-settings.test.ts`

### Task 2: Preserve custom values while exporting

**Files:**
- Modify: `src/export/csv-exporter.ts`
- Test: `tests/unit/csv-exporter.test.ts`

**Interfaces:**
- Consumes `ExportColumn` and `evaluateCustomFormula`.
- Produces CSV/XLSX values retaining prior custom cells by movement key.

- [ ] **Step 1: Write the failing test**

```ts
// First export initializes Formula and Manual; mutate their cells in the prior output.
// A second export with the same movementKey keeps both mutated values.
// A newly inserted movement evaluates Formula and has an empty Manual value.
```

- [ ] **Step 2: Run the focused exporter test to verify it fails**

Run: `npm test -- tests/unit/csv-exporter.test.ts`

- [ ] **Step 3: Write minimal implementation**

Read the prior CSV/XLSX only after profile compatibility is established, map values by `movementKey`, and apply initializers only when that map lacks the key.

- [ ] **Step 4: Run exporter tests to verify they pass**

Run: `npm test -- tests/unit/csv-exporter.test.ts`

### Task 3: Export-profile editor

**Files:**
- Modify: `src/desktop/index.html`
- Modify: `src/desktop/renderer.ts`
- Modify: `src/desktop/locales/en.json`
- Modify: `src/desktop/locales/es.json`
- Test: `tests/unit/export-settings.test.ts`

**Interfaces:**
- Consumes tagged `ExportColumn` definitions.
- Produces valid profile data through the existing `saveExportSettings` bridge.

- [ ] **Step 1: Write the failing test**

```ts
await expect(store.save({ ...settings, columns: [customFormulaWithoutFormula] }))
  .rejects.toThrow(/not valid/i);
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run: `npm test -- tests/unit/export-settings.test.ts`

- [ ] **Step 3: Write minimal implementation**

Add custom-row controls and localized validation copy using the current table, drag/drop, and dirty-tab conventions; do not introduce native dialogs.

- [ ] **Step 4: Run settings and type checks**

Run: `npm test -- tests/unit/export-settings.test.ts && npm run typecheck`

### Task 4: Full verification

**Files:**
- Modify: only files from Tasks 1–3 if review finds a defect.

- [ ] **Step 1: Inspect final diff**

Run: `git diff --check && git diff --stat`

- [ ] **Step 2: Run repository validation**

Run: `npm run check`

- [ ] **Step 3: Report exact evidence and remaining limits**

Do not claim UI interaction coverage without an actual renderer test or manual desktop verification.
