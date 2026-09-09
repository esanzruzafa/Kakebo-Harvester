import { Open, type CentralDirectory, type File } from "unzipper-esm";

const MAX_WORKBOOK_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
const MAX_WORKBOOK_METADATA_BYTES = 1024 * 1024;

function zipEntry(directory: CentralDirectory, path: string): File {
  const entry = directory.files.find((file) => file.path === path);
  if (!entry || entry.type !== "File") {
    throw new Error(`Workbook entry is missing: ${path}`);
  }
  return entry;
}

function ensureEntrySize(entry: File, limit: number, description: string): void {
  if (entry.uncompressedSize > limit) {
    throw new Error(`${description} exceeds the ${limit} byte limit.`);
  }
}

async function readMetadataEntry(
  directory: CentralDirectory,
  path: string
): Promise<string> {
  const entry = zipEntry(directory, path);
  ensureEntrySize(entry, MAX_WORKBOOK_METADATA_BYTES, `Workbook metadata ${path}`);
  return (await entry.buffer()).toString("utf8");
}

function decodeXml(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function attribute(attributes: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}=(['"])(.*?)\\1`, "u").exec(attributes);
  return match?.[2] === undefined ? undefined : decodeXml(match[2]);
}

function resolveRelationshipTarget(target: string): string {
  const normalized = target.replaceAll("\\", "/");
  if (normalized.startsWith("/")) return normalized.slice(1);
  const segments = ["xl", ...normalized.split("/")];
  const resolved: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      resolved.pop();
    } else {
      resolved.push(segment);
    }
  }
  return resolved.join("/");
}

async function selectedWorksheet(
  directory: CentralDirectory,
  sheetName: string | undefined
): Promise<File> {
  const worksheetEntries = directory.files.filter(
    (entry) => entry.type === "File" && /^xl\/worksheets\/[^/]+\.xml$/u.test(entry.path)
  );
  if (!sheetName) {
    const first = worksheetEntries.find((entry) => entry.path === "xl/worksheets/sheet1.xml") ??
      worksheetEntries[0];
    if (!first) throw new Error("Workbook has no worksheets.");
    return first;
  }

  const workbook = await readMetadataEntry(directory, "xl/workbook.xml");
  const sheet = [...workbook.matchAll(/<sheet\b([^>]*)\/?\s*>/gu)].find(
    (match) => attribute(match[1] ?? "", "name") === sheetName
  );
  const relationshipId = sheet ? attribute(sheet[1] ?? "", "r:id") : undefined;
  if (!relationshipId) throw new Error(`Workbook sheet is missing: ${sheetName}`);
  const relationships = await readMetadataEntry(directory, "xl/_rels/workbook.xml.rels");
  const relationship = [...relationships.matchAll(/<Relationship\b([^>]*)\/?\s*>/gu)].find(
    (match) => attribute(match[1] ?? "", "Id") === relationshipId
  );
  const target = relationship ? attribute(relationship[1] ?? "", "Target") : undefined;
  if (!target) throw new Error(`Workbook sheet target is missing: ${sheetName}`);
  return zipEntry(directory, resolveRelationshipTarget(target));
}

async function countRows(entry: File, maxRows: number): Promise<void> {
  ensureEntrySize(entry, MAX_WORKBOOK_UNCOMPRESSED_BYTES, "Workbook worksheet");
  const decoder = new TextDecoder();
  let trailing = "";
  let rows = 0;
  for await (const chunk of entry.stream()) {
    if (!(chunk instanceof Uint8Array)) {
      throw new Error("Workbook worksheet contains an unsupported stream chunk.");
    }
    const text = trailing + decoder.decode(chunk, { stream: true });
    const complete = text.slice(0, -4);
    trailing = text.slice(-4);
    rows += [...complete.matchAll(/<row(?:\s|>)/gu)].length;
    if (rows > maxRows) {
      throw new Error(`Workbook exceeds MAX_CARD_IMPORT_ROWS=${maxRows}.`);
    }
  }
  const finalText = trailing + decoder.decode();
  rows += [...finalText.matchAll(/<row(?:\s|>)/gu)].length;
  if (rows > maxRows) {
    throw new Error(`Workbook exceeds MAX_CARD_IMPORT_ROWS=${maxRows}.`);
  }
}

export async function assertWorkbookCanBeParsed(
  path: string,
  sheetName: string | undefined,
  maxRows: number
): Promise<void> {
  const directory = await Open.file(path);
  const uncompressedBytes = directory.files
    .filter((entry) => entry.type === "File")
    .reduce((total, entry) => total + entry.uncompressedSize, 0);
  if (uncompressedBytes > MAX_WORKBOOK_UNCOMPRESSED_BYTES) {
    throw new Error(
      `Workbook exceeds the ${MAX_WORKBOOK_UNCOMPRESSED_BYTES} byte uncompressed limit.`
    );
  }
  await countRows(await selectedWorksheet(directory, sheetName), maxRows);
}
