import { readFile } from "node:fs/promises";
import { importPKCS8, SignJWT } from "jose";
import { PrivateKeyError } from "../errors.js";

export interface JwtOptions {
  applicationId: string;
  privateKeyPath: string;
  now?: Date;
  ttlSeconds?: number;
}

export async function createApplicationJwt(options: JwtOptions): Promise<string> {
  let pem: string;
  try {
    pem = await readFile(options.privateKeyPath, "utf8");
  } catch (error) {
    throw new PrivateKeyError(
      `No se puede leer la clave privada configurada en ${options.privateKeyPath}.`,
      { cause: error }
    );
  }

  try {
    const key = await importPKCS8(pem, "RS256");
    const issuedAt = Math.floor((options.now ?? new Date()).getTime() / 1_000);
    const ttl = options.ttlSeconds ?? 300;
    if (ttl <= 0 || ttl > 86_400) {
      throw new Error("JWT TTL must be between 1 and 86400 seconds.");
    }
    return await new SignJWT({})
      .setProtectedHeader({ typ: "JWT", alg: "RS256", kid: options.applicationId })
      .setIssuer("enablebanking.com")
      .setAudience("api.enablebanking.com")
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + ttl)
      .sign(key);
  } catch (error) {
    throw new PrivateKeyError("No se ha podido generar el JWT RS256 con la clave configurada.", {
      cause: error
    });
  }
}
