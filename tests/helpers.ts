import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../src/config.js";

export function testConfig(root: string): AppConfig {
  const sandboxRoot = join(root, "sandbox");
  mkdirSync(sandboxRoot, { recursive: true });
  return {
    appEnv: "sandbox",
    appPort: 8_000,
    appBaseUrl: "http://localhost:8000",
    apiBaseUrl: "https://api.enablebanking.com",
    applicationId: "11111111-1111-4111-8111-111111111111",
    privateKeyPath: join(sandboxRoot, "test-sandbox.pem"),
    redirectUrl: "http://localhost:8000/callback",
    databasePath: join(sandboxRoot, "test.sqlite"),
    rawDataDirectory: join(sandboxRoot, "raw"),
    exportDirectory: join(sandboxRoot, "exports"),
    defaultCountry: "ES",
    defaultPsuType: "personal",
    defaultLanguage: "es",
    syncLookbackDays: 15,
    maxTransactionPages: 10,
    httpTimeoutMs: 1_000,
    logLevel: "silent",
    retainRawData: false,
    csvSeparator: ";",
    exportKeepBackup: false,
    useSystemCa: false,
    sessionEncryptionKey: Buffer.alloc(32, 7)
  };
}
