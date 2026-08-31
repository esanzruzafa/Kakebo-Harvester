import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer, connect } from "node:tls";

interface LocalCertificate {
  valid_from?: string | undefined;
  valid_to?: string | undefined;
  subject?: { CN?: string | string[] | undefined } | undefined;
  subjectaltname?: string | undefined;
  issuerCertificate?: { fingerprint?: string | undefined } | undefined;
}

function normalizedSha1Thumbprint(value: string | undefined): string | undefined {
  const normalized = value?.replaceAll(":", "").toUpperCase();
  return normalized && /^[A-F0-9]{40}$/u.test(normalized)
    ? normalized
    : undefined;
}

export function tlsSetupScriptPath(input: {
  packaged: boolean;
  appPath: string;
  resourcesPath: string;
}): string {
  return input.packaged
    ? join(input.resourcesPath, "scripts", "setup-local-https.ps1")
    : join(input.appPath, "scripts", "setup-local-https.ps1");
}

export function isCurrentLocalhostCertificate(
  certificate: LocalCertificate,
  now = Date.now(),
  expectedIssuerThumbprint?: string
): boolean {
  const validFrom = Date.parse(certificate.valid_from ?? "");
  const validTo = Date.parse(certificate.valid_to ?? "");
  const commonNames = Array.isArray(certificate.subject?.CN)
    ? certificate.subject.CN
    : [certificate.subject?.CN];
  const subjectIsLocalhost = commonNames.some(
    (commonName) => commonName?.toLowerCase() === "localhost"
  );
  const sanIncludesLocalhost = (certificate.subjectaltname ?? "")
    .split(",")
    .some((entry) => entry.trim().toLowerCase() === "dns:localhost");
  const expectedIssuer = normalizedSha1Thumbprint(expectedIssuerThumbprint);
  const issuerMatches =
    expectedIssuer === undefined ||
    normalizedSha1Thumbprint(certificate.issuerCertificate?.fingerprint) ===
      expectedIssuer;

  return (
    Number.isFinite(validFrom) &&
    Number.isFinite(validTo) &&
    validFrom <= now &&
    now < validTo &&
    subjectIsLocalhost &&
    sanIncludesLocalhost &&
    issuerMatches
  );
}

export async function isUsableLocalHttpsCertificate(input: {
  pfxPath: string;
  passphrasePath: string;
  expectedIssuerThumbprint?: string;
}): Promise<boolean> {
  let server: ReturnType<typeof createServer> | undefined;
  try {
    const [pfx, storedPassphrase] = await Promise.all([
      readFile(input.pfxPath),
      readFile(input.passphrasePath, "utf8")
    ]);
    const passphrase = storedPassphrase.trim();
    server = createServer({ pfx, passphrase });
    await new Promise<void>((resolve, reject) => {
      server?.once("error", reject);
      server?.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") return false;

    return await new Promise<boolean>((resolve) => {
      const socket = connect({
        host: "127.0.0.1",
        port: address.port,
        servername: "localhost",
        rejectUnauthorized: false
      });
      const timeout = setTimeout(() => {
        socket.destroy();
        resolve(false);
      }, 10_000);
      socket.once("secureConnect", () => {
        clearTimeout(timeout);
        const valid = isCurrentLocalhostCertificate(
          socket.getPeerCertificate(true),
          Date.now(),
          input.expectedIssuerThumbprint
        );
        socket.end();
        resolve(valid);
      });
      socket.once("error", () => {
        clearTimeout(timeout);
        resolve(false);
      });
    });
  } catch {
    return false;
  } finally {
    if (server?.listening) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
    }
  }
}
