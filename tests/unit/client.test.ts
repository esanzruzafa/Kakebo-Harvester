import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnableBankingClient } from "../../src/enable-banking/client.js";
import {
  BankUnavailableError,
  EnableBankingProviderError,
  MalformedProviderResponseError,
  RateLimitError,
  ReauthorizationRequiredError,
  TransactionsPeriodError
} from "../../src/errors.js";
import { testConfig } from "../helpers.js";

let root: string | undefined;

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("Enable Banking client", () => {
  it("passes dates and continuation key without exposing JWT to payloads", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-client-"));
    const config = testConfig(root);
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2_048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" }
    });
    await writeFile(config.privateKeyPath, pair.privateKey);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          transactions: [],
          continuation_key: null
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const client = new EnableBankingClient(config, fetchMock);
    await client.getTransactions("account-id", {
      dateFrom: "2026-07-01",
      dateTo: "2026-07-24",
      continuationKey: "next-page"
    });

    const requestUrl = fetchMock.mock.calls[0]?.[0];
    const url =
      requestUrl instanceof Request
        ? requestUrl.url
        : typeof requestUrl === "string"
          ? requestUrl
          : requestUrl?.toString();
    expect(url).toContain("date_from=2026-07-01");
    expect(url).toContain("continuation_key=next-page");
    const requestOptions = fetchMock.mock.calls[0]?.[1];
    const headers = new Headers(requestOptions?.headers);
    expect(headers.get("authorization")).toMatch(/^Bearer /);
    expect(headers.get("psu-user-agent")).toBeNull();
  });

  it("forwards only explicitly supplied truthful PSU headers", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-client-"));
    const config = testConfig(root);
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2_048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" }
    });
    await writeFile(config.privateKeyPath, pair.privateKey);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          balances: []
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const client = new EnableBankingClient(config, fetchMock);

    await client.getBalances("account-id", {
      userAgent: "Kakebo-Harvester/1.0.0 Electron/43",
      acceptLanguage: "es"
    });

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("psu-user-agent")).toBe(
      "Kakebo-Harvester/1.0.0 Electron/43"
    );
    expect(headers.get("psu-accept-language")).toBe("es");
    expect(headers.get("psu-ip-address")).toBeNull();
  });

  it("uses the current account details endpoint", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-client-"));
    const config = testConfig(root);
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2_048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" }
    });
    await writeFile(config.privateKeyPath, pair.privateKey);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          uid: "account-id",
          currency: "EUR",
          account_id: { iban: "ES1200000000000000000000" }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const client = new EnableBankingClient(config, fetchMock);

    await client.getAccount("account-id");

    const requestUrl = fetchMock.mock.calls[0]?.[0];
    const url =
      requestUrl instanceof Request
        ? requestUrl.url
        : typeof requestUrl === "string"
          ? requestUrl
          : requestUrl?.toString();
    expect(url).toBe(
      "https://api.enablebanking.com/accounts/account-id/details"
    );
  });

  it("rejects account details returned for another account identifier", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-client-"));
    const config = testConfig(root);
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2_048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" }
    });
    await writeFile(config.privateKeyPath, pair.privateKey);
    const client = new EnableBankingClient(
      config,
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            uid: "another-account",
            currency: "EUR",
            account_id: { iban: "ES1200000000000000000000" }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        )
      )
    );

    await expect(client.getAccount("account-id")).rejects.toThrow(
      "no coincide con la cuenta solicitada"
    );
  });

  it("accepts a successful session deletion without a JSON response body", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-client-"));
    const config = testConfig(root);
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2_048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" }
    });
    await writeFile(config.privateKeyPath, pair.privateKey);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(null, { status: 204 })
    );
    const client = new EnableBankingClient(config, fetchMock);

    await expect(client.deleteSession("session-id")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats deletion of an already absent session as idempotent", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-client-"));
    const config = testConfig(root);
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2_048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" }
    });
    await writeFile(config.privateKeyPath, pair.privateKey);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: "SESSION_DOES_NOT_EXIST" }), {
        status: 404
      })
    );
    const client = new EnableBankingClient(config, fetchMock);

    await expect(client.deleteSession("missing-session")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("classifies EXPIRED_SESSION on HTTP 401 as reauthorization", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-client-"));
    const config = testConfig(root);
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2_048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" }
    });
    await writeFile(config.privateKeyPath, pair.privateKey);
    const client = new EnableBankingClient(
      config,
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: "EXPIRED_SESSION" }), {
            status: 401
          })
        )
    );

    await expect(client.getSession("expired")).rejects.toBeInstanceOf(
      ReauthorizationRequiredError
    );
  });

  it("classifies an unavailable transaction period for longest-strategy retry", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-client-"));
    const config = testConfig(root);
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2_048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" }
    });
    await writeFile(config.privateKeyPath, pair.privateKey);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: "WRONG_TRANSACTIONS_PERIOD" }), {
          status: 422
        })
      );
    const client = new EnableBankingClient(config, fetchMock);

    await expect(
      client.getTransactions("account-id", {
        dateFrom: "2026-01-01",
        dateTo: "2026-07-27"
      })
    ).rejects.toBeInstanceOf(TransactionsPeriodError);
  });

  it("does not retry an ASPSP rate limit and recommends at least six hours", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T10:00:00.000Z"));
    root = await mkdtemp(join(tmpdir(), "kakebo-client-"));
    const config = testConfig(root);
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2_048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" }
    });
    await writeFile(config.privateKeyPath, pair.privateKey);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: 429,
          error: "ASPSP_RATE_LIMIT_EXCEEDED",
          message: "ASPSP rate limit exceeded"
        }),
        { status: 429, headers: { "retry-after": "60" } }
      )
    );
    const client = new EnableBankingClient(config, fetchMock);

    const failure = await client
      .getSession("limited")
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RateLimitError);
    expect(failure).toMatchObject({
      providerCode: "ASPSP_RATE_LIMIT_EXCEEDED",
      retryAt: "2026-07-28T16:00:00.000Z"
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("preserves a specific provider validation code and safe message", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-client-"));
    const config = testConfig(root);
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2_048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" }
    });
    await writeFile(config.privateKeyPath, pair.privateKey);
    const client = new EnableBankingClient(
      config,
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            code: 422,
            error: "PSU_HEADER_NOT_PROVIDED",
            message: "Required PSU header is not provided",
            detail: { sensitive: "not exposed" }
          }),
          { status: 422 }
        )
      )
    );

    const failure = await client
      .getAccount("account-id")
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(EnableBankingProviderError);
    expect(failure).toMatchObject({
      providerCode: "PSU_HEADER_NOT_PROVIDED",
      httpStatus: 422,
      providerMessage: "Required PSU header is not provided"
    });
    expect((failure as Error).message).not.toContain("sensitive");
  });

  it("classifies ASPSP timeouts as temporary bank unavailability", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-client-"));
    const config = testConfig(root);
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2_048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" }
    });
    await writeFile(config.privateKeyPath, pair.privateKey);
    const client = new EnableBankingClient(
      config,
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: "ASPSP_TIMEOUT",
            message: "The bank did not respond"
          }),
          { status: 422 }
        )
      )
    );

    const failure = await client
      .getBalances("account-id")
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BankUnavailableError);
    expect(failure).toMatchObject({
      providerCode: "ASPSP_TIMEOUT",
      httpStatus: 422
    });
  });

  it("explains ASPSP errors as temporary bank failures without requiring reconnection", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-client-"));
    const config = testConfig(root);
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2_048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" }
    });
    await writeFile(config.privateKeyPath, pair.privateKey);
    const client = new EnableBankingClient(
      config,
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: "ASPSP_ERROR",
            message: "Error interacting with ASPSP"
          }),
          { status: 400 }
        )
      )
    );

    const failure = await client
      .getBalances("account-id")
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BankUnavailableError);
    expect(failure).toMatchObject({
      providerCode: "ASPSP_ERROR",
      httpStatus: 400
    });
    expect((failure as Error).message).toContain("No es necesario reconectar");
    expect((failure as Error).message).toContain("al menos un minuto");
  });

  it("keeps ASPSP failures temporary even when the bank gateway returns HTTP 403", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-client-"));
    const config = testConfig(root);
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2_048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" }
    });
    await writeFile(config.privateKeyPath, pair.privateKey);
    const client = new EnableBankingClient(
      config,
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: "ASPSP_ERROR",
            message: "Error interacting with ASPSP"
          }),
          { status: 403 }
        )
      )
    );

    const failure = await client
      .getAccount("account-id")
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(BankUnavailableError);
    expect(failure).toMatchObject({
      providerCode: "ASPSP_ERROR",
      httpStatus: 403
    });
  });

  it("preserves account resource errors returned with HTTP 403", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-client-"));
    const config = testConfig(root);
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2_048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" }
    });
    await writeFile(config.privateKeyPath, pair.privateKey);
    const client = new EnableBankingClient(
      config,
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: "RESOURCE_EXPIRED",
            message: "The requested account resource has expired"
          }),
          { status: 403 }
        )
      )
    );

    const failure = await client
      .getAccount("account-id")
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(EnableBankingProviderError);
    expect(failure).toMatchObject({
      providerCode: "RESOURCE_EXPIRED",
      httpStatus: 403,
      providerMessage: "The requested account resource has expired"
    });
  });

  it("maps an expired session resource to reauthorization without changing account errors", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-client-"));
    const config = testConfig(root);
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2_048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" }
    });
    await writeFile(config.privateKeyPath, pair.privateKey);
    const client = new EnableBankingClient(
      config,
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: "RESOURCE_EXPIRED",
            message: "The requested session resource has expired"
          }),
          { status: 403 }
        )
      )
    );

    const failure = await client
      .getSession("session-id")
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ReauthorizationRequiredError);
    expect(failure).toMatchObject({
      providerCode: "RESOURCE_EXPIRED",
      httpStatus: 403
    });
  });

  it("ignores an overflowing Retry-After value and keeps a safe fallback", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-28T10:00:00.000Z"));
    root = await mkdtemp(join(tmpdir(), "kakebo-client-"));
    const config = testConfig(root);
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2_048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" }
    });
    await writeFile(config.privateKeyPath, pair.privateKey);
    const client = new EnableBankingClient(
      config,
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ error: "RATE_LIMIT_EXCEEDED" }), {
          status: 429,
          headers: { "retry-after": "9000000000000" }
        })
      )
    );

    const failure = await client
      .getSession("limited")
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(RateLimitError);
    expect(failure).toMatchObject({ retryAt: "2026-07-28T10:15:00.000Z" });
  });

  it("does not retry a non-idempotent authorization POST after a network failure", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-client-post-"));
    const config = testConfig(root);
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2_048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" }
    });
    await writeFile(config.privateKeyPath, pair.privateKey);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new TypeError("Connection reset after send."));
    const client = new EnableBankingClient(config, fetchMock);

    await expect(
      client.startAuthorization({
        bank: {
          name: "Demo Bank",
          country: "ES",
          psu_types: ["personal"],
          auth_methods: [],
          maximum_consent_validity: 7_776_000
        },
        state: "state",
        redirectUrl: config.redirectUrl,
        psuType: "personal",
        language: "en"
      })
    ).rejects.toBeInstanceOf(BankUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry session creation after a retryable provider status", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-client-post-"));
    const config = testConfig(root);
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2_048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" }
    });
    await writeFile(config.privateKeyPath, pair.privateKey);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("Service unavailable", { status: 503 }));
    const client = new EnableBankingClient(config, fetchMock);

    await expect(client.authorizeSession("one-time-code")).rejects.toBeInstanceOf(
      BankUnavailableError
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a successful POST whose JSON body is malformed", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-client-post-"));
    const config = testConfig(root);
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2_048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" }
    });
    await writeFile(config.privateKeyPath, pair.privateKey);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("{invalid", { status: 200 }));
    const client = new EnableBankingClient(config, fetchMock);

    await expect(client.authorizeSession("one-time-code")).rejects.toBeInstanceOf(
      MalformedProviderResponseError
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects provider responses whose declared body exceeds the safety limit", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-client-response-limit-"));
    const config = testConfig(root);
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2_048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" }
    });
    await writeFile(config.privateKeyPath, pair.privateKey);
    const response = new Response("{}", {
      status: 200,
      headers: { "content-length": "30000000" }
    });
    const responseBody = response.body;
    if (!responseBody) {
      throw new Error("Expected the test response to expose a body stream.");
    }
    const cancel = vi.spyOn(responseBody, "cancel");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response);
    const client = new EnableBankingClient(config, fetchMock);

    await expect(client.checkApplication()).rejects.toBeInstanceOf(
      MalformedProviderResponseError
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("retains retries for safe GET requests", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-client-get-"));
    const config = testConfig(root);
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2_048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" }
    });
    await writeFile(config.privateKeyPath, pair.privateKey);
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("Service unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const client = new EnableBankingClient(config, fetchMock);

    await expect(client.checkApplication()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries transient internal provider errors for safe GET requests", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-client-get-"));
    const config = testConfig(root);
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2_048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" }
    });
    await writeFile(config.privateKeyPath, pair.privateKey);
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("Internal provider error", { status: 500 })
      )
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const client = new EnableBankingClient(config, fetchMock);

    await expect(client.checkApplication()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries an unknown provider failure on a transient GET status", async () => {
    root = await mkdtemp(join(tmpdir(), "kakebo-client-get-"));
    const config = testConfig(root);
    const pair = generateKeyPairSync("rsa", {
      modulusLength: 2_048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" }
    });
    await writeFile(config.privateKeyPath, pair.privateKey);
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: "UPSTREAM_FAILURE",
            message: "Temporary upstream failure"
          }),
          { status: 500 }
        )
      )
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const client = new EnableBankingClient(config, fetchMock);

    await expect(client.checkApplication()).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
