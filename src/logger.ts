import pino from "pino";

export function createLogger(level: string) {
  return pino({
    level,
    redact: {
      paths: [
        "*.authorization",
        "*.Authorization",
        "*.jwt",
        "*.token",
        "*.code",
        "*.sessionId",
        "*.session_id",
        "*.iban",
        "*.account_id"
      ],
      censor: "[REDACTED]"
    }
  });
}
