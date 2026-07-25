import { setTimeout as delay } from "node:timers/promises";
import type { AppConfig, PsuType } from "../config.js";
import {
  BankUnavailableError,
  EnableBankingAuthenticationError,
  MalformedProviderResponseError,
  RateLimitError,
  ReauthorizationRequiredError
} from "../errors.js";
import { createApplicationJwt } from "./jwt.js";
import {
  aspspsResponseSchema,
  balancesResponseSchema,
  getSessionResponseSchema,
  sessionResponseSchema,
  startAuthorizationResponseSchema,
  transactionsResponseSchema,
  type Aspsp
} from "./schemas.js";
import type { z } from "zod";

interface RequestOptions {
  method?: "GET" | "POST" | "DELETE";
  query?: Record<string, string | undefined>;
  body?: unknown;
}

function providerErrorCode(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "error" in parsed &&
      typeof parsed.error === "string" &&
      /^[A-Z0-9_]{1,80}$/.test(parsed.error)
    ) {
      return parsed.error;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export interface StartAuthorizationInput {
  bank: Aspsp;
  state: string;
  redirectUrl: string;
  psuType: PsuType;
  language: string;
}

export class EnableBankingClient {
  public constructor(
    private readonly config: AppConfig,
    private readonly fetchImplementation: typeof fetch = fetch
  ) {}

  private async request(path: string, options: RequestOptions = {}): Promise<unknown> {
    const url = new URL(`${this.config.apiBaseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, value);
    }

    const retryStatuses = new Set([408, 429, 502, 503, 504]);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const jwt = await createApplicationJwt({
        applicationId: this.config.applicationId,
        privateKeyPath: this.config.privateKeyPath
      });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.httpTimeoutMs);
      try {
        const response = await this.fetchImplementation(url, {
          method: options.method ?? "GET",
          headers: {
            accept: "application/json",
            authorization: `Bearer ${jwt}`,
            ...(options.body === undefined ? {} : { "content-type": "application/json" })
          },
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          signal: controller.signal
        });

        if (response.ok) {
          return (await response.json()) as unknown;
        }
        if (response.status === 401 || response.status === 403) {
          throw new EnableBankingAuthenticationError();
        }
        if ([400, 404, 422].includes(response.status)) {
          const body = (await response.text()).slice(0, 500);
          const providerCode = providerErrorCode(body);
          if (/expired|revoked|session/i.test(body)) {
            throw new ReauthorizationRequiredError();
          }
          throw new MalformedProviderResponseError(
            `Enable Banking rechazó la solicitud (HTTP ${response.status}${
              providerCode ? `, ${providerCode}` : ""
            }).`
          );
        }
        if (!retryStatuses.has(response.status)) {
          throw new BankUnavailableError(`Enable Banking respondió con HTTP ${response.status}.`);
        }
        if (attempt === 3) {
          if (response.status === 429) throw new RateLimitError();
          throw new BankUnavailableError();
        }
      } catch (error) {
        if (
          error instanceof EnableBankingAuthenticationError ||
          error instanceof ReauthorizationRequiredError ||
          error instanceof MalformedProviderResponseError ||
          error instanceof RateLimitError ||
          error instanceof BankUnavailableError
        ) {
          throw error;
        }
        if (attempt === 3) {
          throw new BankUnavailableError("No se pudo conectar con Enable Banking.", {
            cause: error
          });
        }
      } finally {
        clearTimeout(timeout);
      }

      const exponentialMs = 250 * 2 ** attempt;
      const jitterMs = Math.floor(Math.random() * 150);
      await delay(exponentialMs + jitterMs);
    }
    throw new BankUnavailableError();
  }

  private parse<T extends z.ZodType>(
    schema: T,
    value: unknown,
    context: string
  ): z.output<T> {
    const parsed = schema.safeParse(value);
    if (!parsed.success) {
      const fields = parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".") || "response"}:${issue.code}`)
        .join(", ");
      throw new MalformedProviderResponseError(
        `Respuesta no válida de Enable Banking al procesar ${context}. Campos: ${fields}.`
      );
    }
    return parsed.data;
  }

  public async listBanks(country: string, psuType?: PsuType) {
    const value = await this.request("/aspsps", {
      query: { country, psu_type: psuType, service: "AIS" }
    });
    return this.parse(aspspsResponseSchema, value, "la lista de bancos").aspsps;
  }

  public async startAuthorization(input: StartAuthorizationInput) {
    const maximumMs = input.bank.maximum_consent_validity * 1_000;
    const requestedMs = 90 * 24 * 60 * 60 * 1_000;
    const validUntil = new Date(Date.now() + Math.min(maximumMs, requestedMs)).toISOString();
    const value = await this.request("/auth", {
      method: "POST",
      body: {
        access: { balances: true, transactions: true, valid_until: validUntil },
        aspsp: { name: input.bank.name, country: input.bank.country },
        state: input.state,
        redirect_url: input.redirectUrl,
        psu_type: input.psuType,
        language: input.language
      }
    });
    return this.parse(startAuthorizationResponseSchema, value, "el inicio de autorización");
  }

  public async authorizeSession(code: string) {
    const value = await this.request("/sessions", {
      method: "POST",
      body: { code }
    });
    return this.parse(sessionResponseSchema, value, "la creación de sesión");
  }

  public async getSession(sessionId: string) {
    const value = await this.request(`/sessions/${encodeURIComponent(sessionId)}`);
    return this.parse(getSessionResponseSchema, value, "la sesión");
  }

  public async deleteSession(sessionId: string): Promise<void> {
    await this.request(`/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
  }

  public async getAccount(accountId: string) {
    const value = await this.request(
      `/accounts/${encodeURIComponent(accountId)}/details`
    );
    const { accountSchema } = await import("./schemas.js");
    return this.parse(accountSchema, value, "la cuenta");
  }

  public async getBalances(accountId: string) {
    const value = await this.request(`/accounts/${encodeURIComponent(accountId)}/balances`);
    return this.parse(balancesResponseSchema, value, "los saldos");
  }

  public async getTransactions(
    accountId: string,
    query: { dateFrom: string; dateTo: string; continuationKey?: string }
  ) {
    const value = await this.request(`/accounts/${encodeURIComponent(accountId)}/transactions`, {
      query: {
        date_from: query.dateFrom,
        date_to: query.dateTo,
        continuation_key: query.continuationKey
      }
    });
    return this.parse(transactionsResponseSchema, value, "los movimientos");
  }

  public async checkApplication(): Promise<void> {
    await this.request("/application");
  }
}
