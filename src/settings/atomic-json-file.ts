import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { dirname } from "node:path";

export async function writeJsonAtomically(
  path: string,
  value: unknown,
  options: { backup?: boolean } = {}
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  if (options.backup) {
    try {
      await copyFile(path, `${path}.backup`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}
