import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Envelope encryption for third-party OAuth tokens (Facebook, Google, Stripe).
 *
 * These tokens can read a merchant's ad account and payment history. A database
 * dump must not be enough to use them, so they are only ever persisted as
 * AES-256-GCM ciphertext with a key that lives outside the database.
 *
 * Format: v1.<iv-b64>.<authTag-b64>.<ciphertext-b64>
 */

const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // GCM standard
const KEY_BYTES = 32;

let cachedKey: Buffer | null = null;

function getKey(): Buffer {
  if (cachedKey) return cachedKey;

  const raw = process.env.MERIDIAN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "MERIDIAN_ENCRYPTION_KEY is not set. Generate one with `openssl rand -base64 32`.",
    );
  }

  const key = Buffer.from(raw, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `MERIDIAN_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes, got ${key.length}. ` +
        "Generate one with `openssl rand -base64 32`.",
    );
  }

  cachedKey = key;
  return key;
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString("base64"),
    authTag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(".");
}

export function decryptSecret(envelope: string): string {
  const parts = envelope.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new Error("Malformed secret envelope.");
  }

  const [, ivB64, tagB64, dataB64] = parts as [string, string, string, string];

  const decipher = createDecipheriv(
    ALGORITHM,
    getKey(),
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));

  return Buffer.concat([
    decipher.update(Buffer.from(dataB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** Constant-time compare, for anything that gates access on a shared secret. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
