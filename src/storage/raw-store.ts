import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "../config.js";
import { createId, sha256, stableJson } from "../utils/crypto.js";

function safePart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
}

export interface RawWriteResult {
  path: string | null;
  fingerprint: string;
}

export class RawStore {
  public constructor(private readonly config: AppConfig) {}

  public async write(
    kind: string,
    accountId: string,
    payload: unknown,
    suffix = ""
  ): Promise<RawWriteResult> {
    const json = `${stableJson(payload)}\n`;
    const fingerprint = sha256(json);
    if (!this.config.retainRawData) return { path: null, fingerprint };

    const directory = join(
      this.config.rawDataDirectory,
      new Date().toISOString().slice(0, 10),
      safePart(accountId)
    );
    await mkdir(directory, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${safePart(kind)}_${timestamp}${suffix ? `_${safePart(suffix)}` : ""}_${createId()}.json`;
    const path = join(directory, filename);
    await writeFile(path, json, { encoding: "utf8", mode: 0o600 });
    return { path, fingerprint };
  }
}
