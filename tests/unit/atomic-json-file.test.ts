import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeJsonAtomically } from "../../src/settings/atomic-json-file.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("atomic JSON files", () => {
  it("removes its unique temporary file when installation fails", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-atomic-json-"));
    const destination = join(root, "settings.json");
    await mkdir(destination);

    await expect(
      writeJsonAtomically(destination, { language: "en" })
    ).rejects.toBeDefined();

    expect((await readdir(root)).filter((name) => name.endsWith(".tmp"))).toEqual(
      []
    );
  });
});
