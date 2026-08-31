import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RawStore } from "../../src/storage/raw-store.js";
import { testConfig } from "../helpers.js";

let root: string | undefined;

afterEach(async () => {
  vi.useRealTimers();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("raw response storage", () => {
  it("does not overwrite responses written during the same millisecond", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-27T12:00:00.000Z"));
    root = await mkdtemp(join(tmpdir(), "kakebo-raw-store-"));
    const store = new RawStore({ ...testConfig(root), retainRawData: true });

    const first = await store.write("transactions", "account", { page: 1 });
    const second = await store.write("transactions", "account", { page: 2 });

    expect(first.path).not.toBeNull();
    expect(second.path).not.toBeNull();
    expect(first.path).not.toBe(second.path);
    expect(JSON.parse(await readFile(first.path ?? "", "utf8"))).toEqual({
      page: 1
    });
    expect(JSON.parse(await readFile(second.path ?? "", "utf8"))).toEqual({
      page: 2
    });
  });
});
