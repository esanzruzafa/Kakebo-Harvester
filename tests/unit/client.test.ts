import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EnableBankingClient } from "../../src/enable-banking/client.js";
import {
  ReauthorizationRequiredError,
  TransactionsPeriodError
} from "../../src/errors.js";
import { testConfig } from "../helpers.js";

let root: string | undefined;

afterEach(async () => {
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
});
