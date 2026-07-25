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
  public constructor(message = "Enable Banking rechazó la autenticación de la aplicación.") {
    super(message, "ENABLE_BANKING_AUTHENTICATION_ERROR", 3);
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
  public constructor(message = "Hace falta volver a autorizar la conexión bancaria.") {
    super(message, "REAUTHORIZATION_REQUIRED", 10);
  }
}

export class BankUnavailableError extends KakeboError {
  public constructor(
    message = "El banco no está disponible temporalmente.",
    options?: ErrorOptions
  ) {
    super(message, "BANK_UNAVAILABLE", 6, options);
  }
}

export class RateLimitError extends KakeboError {
  public constructor(message = "Enable Banking ha limitado temporalmente las solicitudes.") {
    super(message, "RATE_LIMIT", 6);
  }
}

export class MalformedProviderResponseError extends KakeboError {
  public constructor(message = "Enable Banking devolvió una respuesta con formato inesperado.") {
    super(message, "MALFORMED_PROVIDER_RESPONSE", 7);
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
