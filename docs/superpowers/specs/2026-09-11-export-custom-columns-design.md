# Export Custom Columns Design

## Goal

Allow export profiles to add ordered custom columns that are either safe formulas or manual cells. A custom value is created only when its movement first appears; subsequent exports preserve the previous value for the same `movementKey`.

## Decisions

- Preserve custom-cell values in both CSV and XLSX exports.
- Use the enabled built-in `movementKey` column as the durable identity. Custom-column exports require it to remain enabled.
- Treat a formula as a first-export initializer, not a live spreadsheet formula. It is evaluated locally only for a newly discovered movement, then persisted from the prior output on later exports.
- A manual column is initialized to an empty string for a newly discovered movement.
- Formula syntax is a small deterministic expression language: numeric/string literals, parentheses, `+`, `-`, `*`, `/`, source field references, and `upper`, `lower`, `coalesce`, `concat`, and `round` calls. No JavaScript, shell, spreadsheet, network, filesystem, or dynamic-property access is supported.
- A profile change that changes the ordered enabled columns or a custom-column definition produces an incompatible fingerprint. Existing output is archived rather than interpreted with mismatched headers.

## Model

Built-in columns keep their existing `{ field, header, enabled }` shape. Custom columns add `{ id, kind: "formula" | "manual", header, enabled, formula? }`. IDs are random UUIDs and make duplicate headers unambiguous. Existing profiles migrate by adding `schemaVersion: 2` and continue to produce the same output.

## Export flow

1. Validate and load the profile.
2. If a compatible previous output exists, read its headers and rows and create a map of `movementKey` to custom values keyed by custom-column ID/header position.
3. For each exported movement, retain stored custom values if the key exists; otherwise evaluate formulas locally or initialize manual cells to `""`.
4. Generate CSV/XLSX with escaped safe text. The prior result is retained atomically until the new file and state are written.

## UI

The export table shows built-in rows and user-created rows. A custom row exposes a type selector, formula input only for formula rows, header, enabled state, ordering, and removal. Save validation reports malformed formulas and missing/disabled `movementKey` before writing the profile.

## Testing

Unit tests cover schema migration and validation, formula parsing/evaluation and safety rejections, CSV/XLSX custom values, and preservation after a second export where source data changes. Existing exports remain unchanged when no custom column is configured.
