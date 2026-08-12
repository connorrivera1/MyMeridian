import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export interface TotpOptions {
  secret: string;
  timestamp?: number;
  periodSeconds?: number;
  digits?: number;
  window?: number;
}

export function decodeBase32(value: string): Buffer {
  const normalized = value.toUpperCase().replace(/[\s=-]/g, "");
  if (!normalized || /[^A-Z2-7]/.test(normalized)) {
    throw new Error("TOTP secret must be non-empty base32");
  }

  let bits = "";
  for (const character of normalized) {
    bits += BASE32_ALPHABET.indexOf(character).toString(2).padStart(5, "0");
  }

  const bytes: number[] = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) {
    bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  }
  return Buffer.from(bytes);
}

export function encodeBase32(value: Buffer): string {
  let bits = "";
  for (const byte of value) bits += byte.toString(2).padStart(8, "0");

  let output = "";
  for (let offset = 0; offset < bits.length; offset += 5) {
    output += BASE32_ALPHABET[
      Number.parseInt(bits.slice(offset, offset + 5).padEnd(5, "0"), 2)
    ];
  }
  return output;
}

export function generateTotpSecret(bytes = 20): string {
  if (!Number.isInteger(bytes) || bytes < 20) {
    throw new Error("TOTP secrets must contain at least 160 bits");
  }
  return encodeBase32(randomBytes(bytes));
}

export function totpCounter(
  timestamp = Date.now(),
  periodSeconds = 30,
): number {
  return Math.floor(timestamp / (periodSeconds * 1_000));
}

export function generateTotp(options: TotpOptions): string {
  const digits = options.digits ?? 6;
  const period = options.periodSeconds ?? 30;
  const counter = totpCounter(options.timestamp, period);
  return generateTotpForCounter(options.secret, counter, digits);
}

function generateTotpForCounter(
  secret: string,
  counter: number,
  digits: number,
): string {
  if (!Number.isSafeInteger(counter) || counter < 0) {
    throw new Error("TOTP counter is invalid");
  }
  if (!Number.isInteger(digits) || digits < 6 || digits > 8) {
    throw new Error("TOTP digits must be between 6 and 8");
  }

  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", decodeBase32(secret))
    .update(message)
    .digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** Returns the accepted time-step so the caller can reject code replay. */
export function verifyTotp(
  code: string,
  options: TotpOptions,
): number | null {
  const digits = options.digits ?? 6;
  if (code.length !== digits) return null;
  for (let index = 0; index < code.length; index += 1) {
    const character = code.charCodeAt(index);
    if (character < 48 || character > 57) return null;
  }

  const period = options.periodSeconds ?? 30;
  const window = options.window ?? 1;
  const current = totpCounter(options.timestamp, period);
  const supplied = Buffer.from(code);

  for (let drift = -window; drift <= window; drift += 1) {
    const counter = current + drift;
    if (counter < 0) continue;
    const expected = Buffer.from(
      generateTotpForCounter(options.secret, counter, digits),
    );
    if (
      supplied.length === expected.length &&
      timingSafeEqual(supplied, expected)
    ) {
      return counter;
    }
  }
  return null;
}

export function totpProvisioningUri(input: {
  secret: string;
  account: string;
  issuer?: string;
}): string {
  // Validate before putting a typo into the only enrollment URI the operator
  // sees. The decoded secret is never included in output.
  decodeBase32(input.secret);
  const issuer = input.issuer ?? "MyMeridian";
  const label = `${issuer}:${input.account}`;
  const query = new URLSearchParams({
    secret: input.secret.replace(/[\s=-]/g, "").toUpperCase(),
    issuer,
    algorithm: "SHA1",
    digits: "6",
    period: "30",
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${query}`;
}
