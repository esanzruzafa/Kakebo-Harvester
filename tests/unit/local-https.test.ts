import { describe, expect, it } from "vitest";
import {
  isCurrentLocalhostCertificate,
  tlsSetupScriptPath
} from "../../src/desktop/local-https.js";

describe("local HTTPS certificate validation", () => {
  const now = Date.parse("2026-08-21T12:00:00.000Z");
  const certificate = {
    valid_from: "2026-08-20T12:00:00.000Z",
    valid_to: "2028-08-20T12:00:00.000Z",
    subject: { CN: "localhost" },
    subjectaltname: "DNS:localhost"
  };

  it("accepts a current localhost certificate with a localhost SAN", () => {
    expect(isCurrentLocalhostCertificate(certificate, now)).toBe(true);
  });

  it("rejects expired certificates and certificates for another host", () => {
    expect(
      isCurrentLocalhostCertificate(
        { ...certificate, valid_to: "2026-08-20T12:00:00.000Z" },
        now
      )
    ).toBe(false);
    expect(
      isCurrentLocalhostCertificate(
        {
          ...certificate,
          subject: { CN: "example.com" },
          subjectaltname: "DNS:example.com"
        },
        now
      )
    ).toBe(false);
  });

  it("resolves the development HTTPS script from the application root", () => {
    expect(
      tlsSetupScriptPath({
        packaged: false,
        appPath: "C:\\work\\kakebo",
        resourcesPath: "C:\\ignored"
      })
    ).toBe("C:\\work\\kakebo\\scripts\\setup-local-https.ps1");
  });
});
