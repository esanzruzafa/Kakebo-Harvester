import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeJwt, decodeProtectedHeader, importSPKI, jwtVerify } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { createApplicationJwt } from "../../src/enable-banking/jwt.js";
import { PrivateKeyError } from "../../src/errors.js";

let temporaryDirectory: string | undefined;

afterEach(async () => {
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});

describe("Enable Banking JWT", () => {
  it("creates a short-lived RS256 token with the documented claims", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "kakebo-jwt-"));
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2_048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" }
    });
    const path = join(temporaryDirectory, "sandbox.pem");
    await writeFile(path, pair.privateKey);
    const applicationId = "11111111-1111-4111-8111-111111111111";
    const now = new Date("2026-07-24T10:00:00Z");
    const token = await createApplicationJwt({
      applicationId,
      privateKeyPath: path,
      now,
      ttlSeconds: 300
    });

    expect(decodeProtectedHeader(token)).toMatchObject({
      alg: "RS256",
      typ: "JWT",
      kid: applicationId
    });
    expect(decodeJwt(token)).toMatchObject({
      iss: "enablebanking.com",
      aud: "api.enablebanking.com",
      iat: 1_784_887_200,
      exp: 1_784_887_500
    });
    const publicKey = await importSPKI(pair.publicKey, "RS256");
    await expect(
      jwtVerify(token, publicKey, {
        issuer: "enablebanking.com",
        audience: "api.enablebanking.com",
        currentDate: now
      })
    ).resolves.toBeDefined();
  });

  it("returns a typed safe error when the key does not exist", async () => {
    await expect(
      createApplicationJwt({
        applicationId: "11111111-1111-4111-8111-111111111111",
        privateKeyPath: "missing-sandbox.pem"
      })
    ).rejects.toBeInstanceOf(PrivateKeyError);
  });
});
