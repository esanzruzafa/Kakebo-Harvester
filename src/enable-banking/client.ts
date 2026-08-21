import { setTimeout as delay } from "node:timers/promises";
import type { AppConfig, PsuType } from "../config.js";
import {
  BankUnavailableError,
  EnableBankingAuthenticationError,
  EnableBankingProviderError,
  MalformedProviderResponseError,
  RateLimitError,
  ReauthorizationRequiredError,
  TransactionsPeriodError
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
  psuHeaders?: PsuHeaders;
}

export interface PsuHeaders {
  ipAddress?: string;
  userAgent?: string;
  acceptLanguage?: string;
}

function safeHeaderValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 512 ||
    /[\r\n]/u.test(trimmed)
  ) {
    return undefined;
  }
  return trimmed;
}

function requestPsuHeaders(values: PsuHeaders | undefined): Record<string, string> {
  if (!values) return {};
  const ipAddress = safeHeaderValue(values.ipAddress);
  const userAgent = safeHeaderValue(values.userAgent);
  const acceptLanguage = safeHeaderValue(values.acceptLanguage);
  return {
    ...(ipAddress ? { "Psu-Ip-Address": ipAddress } : {}),
    ...(userAgent ? { "Psu-User-Agent": userAgent } : {}),
    ...(acceptLanguage
      ? { "Psu-Accept-Language": acceptLanguage }
      : {})
  };
}

interface ProviderErrorPayload {
  providerCode?: string;
  message?: string;
}

function safeProviderText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/gu, " ").trim().slice(0, 240);
  return normalized.length > 0 ? normalized : undefined;
}

function providerError(body: string): ProviderErrorPayload {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const error =
        "error" in parsed &&
        typeof parsed.error === "string" &&
        /^[A-Z0-9_]{1,80}$/u.test(parsed.error)
          ? parsed.error
          : undefined;
      const message =
        "message" in parsed ? safeProviderText(parsed.message) : undefined;
      return {
        ...(error ? { providerCode: error } : {}),
        ...(message ? { message } : {})
      };
    }
  } catch {
    return {};
  }
  return {};
}

function retryAtFrom(response: Response, providerCode: string | undefined): string {
  const now = Date.now();
  const retryAfter = response.headers.get("retry-after")?.trim();
  let retryAtMs: number | undefined;
  if (retryAfter && /^\d+$/u.test(retryAfter)) {
    retryAtMs = now + Number(retryAfter) * 1_000;
  } else if (retryAfter) {
    const parsed = Date.parse(retryAfter);
    if (Number.isFinite(parsed) && parsed > now) retryAtMs = parsed;
  }
  const recommendedMs =
    providerCode === "ASPSP_RATE_LIMIT_EXCEEDED"
      ? now + 6 * 60 * 60 * 1_000
      : now + 15 * 60 * 1_000;
  return new Date(Math.max(retryAtMs ?? 0, recommendedMs)).toISOString();
}

const sessionErrorCodes = new Set([
  "CLOSED_SESSION",
  "EXPIRED_SESSION",
  "REVOKED_SESSION",
  "SESSION_DOES_NOT_EXIST",
  "WRONG_SESSION_STATUS"
]);

const authenticationErrorCodes = new Set([
  "AUTHORIZATION_NOT_PROVIDED",
  "UNAUTHORIZED_ACCESS",
  "UNAUTHORIZED_IP"
]);

const unavailableErrorCodes = new Set(["ASPSP_ERROR", "ASPSP_TIMEOUT"]);

function providerFailureMessage(
  status: number,
  payload: ProviderErrorPayload
): string {
  const identity = `HTTP ${status}${
    payload.providerCode ? `, ${payload.providerCode}` : ""
  }`;
  return `Enable Banking rechazó la solicitud (${identity})${
    payload.message ? `: ${payload.message}` : "."
  }`;
}

function aspspTemporaryFailureMessage(
  status: number,
  payload: ProviderErrorPayload
): string {
  const identity = `HTTP ${status}, ${payload.providerCode ?? "ASPSP_ERROR"}`;
  const detail = payload.message ? ` Detalle del banco: ${payload.message}.` : "";
  return `El banco ha fallado temporalmente al atender la consulta (${identity}). ` +
    "No es necesario reconectar por este error. Vuelve a intentarlo dentro de al menos un minuto; " +
    "si persiste, repite con intervalos de 1, 2 y 4 horas y revisa el registro de solicitudes de Enable Banking." +
    detail;
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

    const retryStatuses = new Set([408, 502, 503, 504]);
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
            ...requestPsuHeaders(options.psuHeaders),
            ...(options.body === undefined ? {} : { "content-type": "application/json" })
          },
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          signal: controller.signal
        });

        if (response.ok) {
          const body = await response.text();
          return body.trim().length > 0 ? (JSON.parse(body) as unknown) : undefined;
        }
        const body = (await response.text()).slice(0, 500);
        const failure = providerError(body);
        const providerCode = failure.providerCode;
        const metadata = {
          ...(providerCode ? { providerCode } : {}),
          httpStatus: response.status,
          ...(failure.message ? { providerMessage: failure.message } : {})
        };
        if (providerCode && sessionErrorCodes.has(providerCode)) {
          throw new ReauthorizationRequiredError(
            "La sesión bancaria ha caducado, ha sido cerrada o ya no está disponible.",
            [],
            metadata
          );
        }
        if (providerCode === "WRONG_TRANSACTIONS_PERIOD") {
          throw new TransactionsPeriodError(undefined, metadata);
        }
        if (response.status === 429) {
          const retryAt = retryAtFrom(response, providerCode);
          const message =
            providerCode === "ASPSP_RATE_LIMIT_EXCEEDED"
              ? `El banco ha alcanzado su límite de consultas. Próximo intento permitido: ${retryAt}. (${providerCode})`
              : `Enable Banking ha limitado temporalmente las solicitudes. Próximo intento permitido: ${retryAt}. (${providerCode ?? "RATE_LIMIT_EXCEEDED"})`;
          throw new RateLimitError(
            message,
            retryAt,
            [],
            providerCode ?? "RATE_LIMIT_EXCEEDED"
          );
        }
        if (
          response.status === 401 ||
          response.status === 403 ||
          (providerCode && authenticationErrorCodes.has(providerCode))
        ) {
          throw new EnableBankingAuthenticationError(
            providerFailureMessage(response.status, failure),
            metadata
          );
        }
        if (providerCode && unavailableErrorCodes.has(providerCode)) {
          throw new BankUnavailableError(
            providerCode === "ASPSP_ERROR"
              ? aspspTemporaryFailureMessage(response.status, failure)
              : providerFailureMessage(response.status, failure),
            undefined,
            metadata
          );
        }
        if ([400, 404, 422].includes(response.status)) {
          if (/expired|revoked|session/i.test(body)) {
            throw new ReauthorizationRequiredError(undefined, [], metadata);
          }
          if (providerCode) {
            throw new EnableBankingProviderError(
              providerFailureMessage(response.status, failure),
              providerCode,
              response.status,
              failure.message
            );
          }
          throw new MalformedProviderResponseError(
            providerFailureMessage(response.status, failure)
          );
        }
        if (!retryStatuses.has(response.status)) {
          if (providerCode) {
            throw new EnableBankingProviderError(
              providerFailureMessage(response.status, failure),
              providerCode,
              response.status,
              failure.message
            );
          }
          throw new BankUnavailableError(
            `Enable Banking respondió con HTTP ${response.status}.`,
            undefined,
            metadata
          );
        }
        if (attempt === 3) {
          throw new BankUnavailableError(
            providerFailureMessage(response.status, failure),
            undefined,
            metadata
          );
        }
      } catch (error) {
        if (
          error instanceof EnableBankingAuthenticationError ||
          error instanceof EnableBankingProviderError ||
          error instanceof ReauthorizationRequiredError ||
          error instanceof TransactionsPeriodError ||
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

  public async getAccount(accountId: string, psuHeaders?: PsuHeaders) {
    const value = await this.request(
      `/accounts/${encodeURIComponent(accountId)}/details`,
      { ...(psuHeaders ? { psuHeaders } : {}) }
    );
    const { accountSchema } = await import("./schemas.js");
    return this.parse(accountSchema, value, "la cuenta");
  }

  public async getBalances(accountId: string, psuHeaders?: PsuHeaders) {
    const value = await this.request(
      `/accounts/${encodeURIComponent(accountId)}/balances`,
      { ...(psuHeaders ? { psuHeaders } : {}) }
    );
    return this.parse(balancesResponseSchema, value, "los saldos");
  }

  public async getTransactions(
    accountId: string,
    query: {
      dateFrom: string;
      dateTo?: string;
      continuationKey?: string;
      strategy?: "longest";
    },
    psuHeaders?: PsuHeaders
  ) {
    const value = await this.request(`/accounts/${encodeURIComponent(accountId)}/transactions`, {
      query: {
        date_from: query.dateFrom,
        date_to: query.dateTo,
        continuation_key: query.continuationKey,
        strategy: query.strategy
      },
      ...(psuHeaders ? { psuHeaders } : {})
    });
    return this.parse(transactionsResponseSchema, value, "los movimientos");
  }

  public async checkApplication(): Promise<void> {
    await this.request("/application");
  }
}
