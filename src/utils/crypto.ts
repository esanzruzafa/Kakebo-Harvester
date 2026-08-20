import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID
} from "node:crypto";

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createAuthorizationState(): string {
  return randomBytes(32).toString("base64url");
}

export function createId(): string {
  return randomUUID();
}

export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(
    "."
  );
}

export function decryptSecret(encoded: string, key: Buffer): string {
  const [version, ivValue, tagValue, ciphertextValue] = encoded.split(".");
  if (version !== "v1" || !ivValue || !tagValue || !ciphertextValue) {
    throw new Error("Unsupported encrypted value.");
  }
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivValue, "base64url"));
  decipher.setAuthTag(Buffer.from(tagValue, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, "base64url")),
    decipher.final()
  ]).toString("utf8");
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
