import { constants } from "node:fs";
import { access, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isRedirectUrlAllowed, type AppConfig } from "./config.js";
import type { EnableBankingClient } from "./enable-banking/client.js";
import {
  BankUnavailableError,
  EnableBankingAuthenticationError,
  PrivateKeyError
} from "./errors.js";

export interface DoctorCheck {
  check: string;
  ok: boolean;
  detail: string;
}

export function isSupportedNodeVersion(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 22 || (major === 22 && minor >= 19);
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if ("code" in error && typeof error.code === "string") return error.code;
  if ("cause" in error) return errorCode(error.cause);
  return undefined;
}

async function writeCheck(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const testPath = join(directory, `.write-test-${process.pid}`);
  const handle = await open(testPath, "wx", 0o600);
  await handle.close();
  const { unlink } = await import("node:fs/promises");
  await unlink(testPath);
}

export async function runDoctor(
  config: AppConfig,
  client: EnableBankingClient
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  checks.push({
    check: "Node.js",
    ok: isSupportedNodeVersion(process.versions.node),
    detail: process.versions.node
  });

  try {
    await access(config.privateKeyPath, constants.R_OK);
    checks.push({ check: "Clave privada", ok: true, detail: "legible" });
  } catch {
    checks.push({ check: "Clave privada", ok: false, detail: "no se puede leer" });
  }

  if (config.appEnv === "production") {
    for (const [check, path] of [
      ["Certificado HTTPS local", config.tlsPfxPath],
      ["Contraseña HTTPS local", config.tlsPfxPassphrasePath]
    ] as const) {
      try {
        if (!path) throw new Error("missing path");
        await access(path, constants.R_OK);
        checks.push({ check, ok: true, detail: "legible" });
      } catch {
        checks.push({ check, ok: false, detail: "no se puede leer" });
      }
    }
  }

  for (const [check, directory] of [
    ["Directorio SQLite", dirname(config.databasePath)],
    ["Directorio de exportación", config.exportDirectory],
    ["Directorio raw", config.rawDataDirectory]
  ] as const) {
    try {
      await writeCheck(directory);
      checks.push({ check, ok: true, detail: "escribible" });
    } catch {
      checks.push({ check, ok: false, detail: "no se puede escribir" });
    }
  }

  const redirect = new URL(config.redirectUrl);
  checks.push({
    check: "Redirect URL",
    ok: isRedirectUrlAllowed(config.appEnv, config.redirectUrl, config.appPort),
    detail: `${redirect.protocol}//${redirect.host}${redirect.pathname}`
  });
  checks.push({
    check: "Aislamiento de entorno",
    ok: [
      config.privateKeyPath,
      config.databasePath,
      config.rawDataDirectory,
      config.exportDirectory
    ].every((path) => path.toLowerCase().includes(config.appEnv)),
    detail: config.appEnv
  });

  try {
    await client.checkApplication();
    checks.push({ check: "Enable Banking", ok: true, detail: "aplicación accesible" });
  } catch (error) {
    const code = errorCode(error);
    const detail =
      error instanceof EnableBankingAuthenticationError
        ? "autenticación rechazada; comprueba el application ID, el PEM y el entorno"
        : error instanceof PrivateKeyError
          ? "el PEM no permite generar un JWT RS256 válido"
          : ["SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"].includes(
                code ?? ""
              )
            ? "cadena TLS no confiable; configura NODE_USE_SYSTEM_CA=1"
          : error instanceof BankUnavailableError
            ? "sin conectividad o API no disponible"
            : "respuesta inesperada de Enable Banking";
    checks.push({
      check: "Enable Banking",
      ok: false,
      detail
    });
  }
  return checks;
}
