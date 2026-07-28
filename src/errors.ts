export class KakeboError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    public readonly exitCode = 1,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export interface EnableBankingErrorMetadata {
  providerCode?: string;
  httpStatus?: number;
  providerMessage?: string;
}

export function providerErrorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "providerCode" in error &&
    typeof error.providerCode === "string"
  ) {
    return error.providerCode;
  }
  return undefined;
}

export class ConfigurationError extends KakeboError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, "CONFIGURATION_ERROR", 2, options);
  }
}

export class PrivateKeyError extends KakeboError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, "PRIVATE_KEY_ERROR", 2, options);
  }
}

export class EnableBankingAuthenticationError extends KakeboError {
  public readonly providerCode: string | undefined;
  public readonly httpStatus: number | undefined;

  public constructor(
    message = "Enable Banking rechazó la autenticación de la aplicación.",
    metadata: EnableBankingErrorMetadata = {}
  ) {
    super(message, "ENABLE_BANKING_AUTHENTICATION_ERROR", 3);
    this.providerCode = metadata.providerCode;
    this.httpStatus = metadata.httpStatus;
  }
}

export class AuthorizationDeniedError extends KakeboError {
  public constructor(message = "La autorización bancaria fue cancelada o denegada.") {
    super(message, "AUTHORIZATION_DENIED", 4);
  }
}

export class InvalidStateError extends KakeboError {
  public constructor(message = "El parámetro state no es válido, ha caducado o ya fue utilizado.") {
    super(message, "INVALID_STATE", 4);
  }
}

export class SessionExpiredError extends KakeboError {
  public constructor(message = "La sesión bancaria ha caducado.") {
    super(message, "SESSION_EXPIRED", 5);
  }
}

export class ReauthorizationRequiredError extends KakeboError {
  public readonly providerCode: string | undefined;
  public readonly httpStatus: number | undefined;

  public constructor(
    message = "Hace falta volver a autorizar la conexión bancaria.",
    public readonly connectionIds: readonly string[] = [],
    metadata: EnableBankingErrorMetadata = {}
  ) {
    super(message, "REAUTHORIZATION_REQUIRED", 10);
    this.providerCode = metadata.providerCode;
    this.httpStatus = metadata.httpStatus;
  }
}

export class SyncAlreadyRunningError extends KakeboError {
  public constructor(
    message = "Ya hay otra sincronización en curso. Espera a que termine."
  ) {
    super(message, "SYNC_ALREADY_RUNNING", 11);
  }
}

export class BankUnavailableError extends KakeboError {
  public readonly providerCode: string | undefined;
  public readonly httpStatus: number | undefined;

  public constructor(
    message = "El banco no está disponible temporalmente.",
    options?: ErrorOptions,
    metadata: EnableBankingErrorMetadata = {}
  ) {
    super(message, "BANK_UNAVAILABLE", 6, options);
    this.providerCode = metadata.providerCode;
    this.httpStatus = metadata.httpStatus;
  }
}

export class RateLimitError extends KakeboError {
  public readonly httpStatus = 429;

  public constructor(
    message = "Enable Banking ha limitado temporalmente las solicitudes.",
    public readonly retryAt?: string,
    public readonly connectionIds: readonly string[] = [],
    public readonly providerCode = "RATE_LIMIT_EXCEEDED"
  ) {
    super(message, "RATE_LIMIT", 6);
  }
}

export class TransactionsPeriodError extends KakeboError {
  public readonly providerCode: string;
  public readonly httpStatus: number | undefined;

  public constructor(
    message = "El banco no ofrece exactamente el periodo de movimientos solicitado.",
    metadata: EnableBankingErrorMetadata = {}
  ) {
    super(message, "WRONG_TRANSACTIONS_PERIOD", 7);
    this.providerCode =
      metadata.providerCode ?? "WRONG_TRANSACTIONS_PERIOD";
    this.httpStatus = metadata.httpStatus;
  }
}

export class MalformedProviderResponseError extends KakeboError {
  public constructor(message = "Enable Banking devolvió una respuesta con formato inesperado.") {
    super(message, "MALFORMED_PROVIDER_RESPONSE", 7);
  }
}

export class EnableBankingProviderError extends KakeboError {
  public constructor(
    message: string,
    public readonly providerCode: string,
    public readonly httpStatus: number,
    public readonly providerMessage?: string
  ) {
    super(message, "ENABLE_BANKING_PROVIDER_ERROR", 7);
  }
}

export class PsuHeadersUnavailableError extends KakeboError {
  public constructor(
    public readonly requiredHeaders: readonly string[],
    message = `No se puede realizar una consulta online porque faltan cabeceras PSU obligatorias reales: ${requiredHeaders.join(", ")}.`
  ) {
    super(message, "PSU_HEADERS_UNAVAILABLE", 7);
  }
}

export class DatabaseError extends KakeboError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, "DATABASE_ERROR", 8, options);
  }
}

export class ExportError extends KakeboError {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, "EXPORT_ERROR", 9, options);
  }
}
