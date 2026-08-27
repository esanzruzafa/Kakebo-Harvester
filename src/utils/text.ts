export function normalizeText(value: string | null | undefined): string {
  return (value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

export function maskIdentifier(value: string | null | undefined): string | null {
  if (!value) return null;
  const compact = value.replace(/\s/g, "");
  if (compact.length <= 4) return "*".repeat(compact.length);
  return `${compact.slice(0, 2)}${"*".repeat(Math.min(12, compact.length - 4))}${compact.slice(-2)}`;
}

export function safeMessage(value: unknown): string {
  const message = value instanceof Error ? value.message : String(value);
  return message
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [REDACTED]")
    .replace(/\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g, "[MASKED_ACCOUNT]")
    .replace(
      /\b(code|state|session_id|token|access_token|refresh_token)=([^&\s]+)/gi,
      "$1=[REDACTED]"
    )
    .replace(
      /(["'](?:code|state|session_id|token|access_token|refresh_token)["']\s*:\s*["'])[^"']+/gi,
      "$1[REDACTED]"
    )
    .slice(0, 500);
}
