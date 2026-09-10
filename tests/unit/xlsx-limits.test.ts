import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import writeXlsxFile from "write-excel-file/node";
import { afterEach, describe, expect, it } from "vitest";
import { assertWorkbookCanBeParsed } from "../../src/cards/xlsx-limits.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("assertWorkbookCanBeParsed", () => {
  it("rejects a selected worksheet before it exceeds the configured row allowance", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-xlsx-limit-"));
    const workbook = join(root, "statement.xlsx");
    await writeXlsxFile([
      [{ value: "Date", type: String }],
      [{ value: "2026-08-01", type: String }],
      [{ value: "2026-08-02", type: String }]
    ]).toFile(workbook);

    await expect(assertWorkbookCanBeParsed(workbook, undefined, 2)).rejects.toThrow(
      "MAX_CARD_IMPORT_ROWS=2"
    );
  });

  it("uses workbook order when no worksheet is selected", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-xlsx-default-sheet-"));
    const workbook = join(root, "statement.xlsx");
    await writeXlsxFile([
      {
        sheet: "Small",
        data: [[{ value: "Date", type: String }]]
      },
      {
        sheet: "Large",
        data: [
          [{ value: "Date", type: String }],
          [{ value: "2026-08-01", type: String }],
          [{ value: "2026-08-02", type: String }]
        ]
      }
    ]).toFile(workbook);
    const archive = unzipSync(await readFile(workbook));
    const workbookEntry = archive["xl/workbook.xml"];
    if (!workbookEntry) throw new Error("Test workbook is missing workbook.xml.");
    const workbookXml = strFromU8(workbookEntry);
    archive["xl/workbook.xml"] = strToU8(
      workbookXml.replace(/(<sheet\b[^>]*name="Small"[^>]*\/>)(\s*)(<sheet\b[^>]*name="Large"[^>]*\/>)/u, "$3$2$1")
    );
    await writeFile(workbook, zipSync(archive));

    await expect(assertWorkbookCanBeParsed(workbook, undefined, 2)).rejects.toThrow(
      "MAX_CARD_IMPORT_ROWS=2"
    );
  });
});
