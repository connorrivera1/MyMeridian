const OPERATOR_ENV_NAMES = [
  "MERIDIAN_OPERATOR_EMAIL",
  "MERIDIAN_OPERATOR_PASSWORD_HASH",
  "MERIDIAN_OPERATOR_TOTP_SECRET",
  "MERIDIAN_OPERATOR_SESSION_KEY",
] as const;

export interface OperatorConfiguration {
  configured: boolean;
  missing: string[];
  invalid: string[];
}

function decodeBase32Length(value: string): number | null {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const normalized = value.toUpperCase().replace(/[\s=-]/g, "");
  if (!normalized || [...normalized].some((character) => !alphabet.includes(character))) {
    return null;
  }
  return Math.floor((normalized.length * 5) / 8);
}

function strongScryptHash(value: string): boolean {
  const [scheme, rawN, rawR, rawP, rawSalt, rawKey, extra] = value.split("$");
  if (extra !== undefined || scheme !== "scrypt") return false;
  const n = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (!Number.isInteger(n) || n < 16_384 || (n & (n - 1)) !== 0) return false;
  if (!Number.isInteger(r) || r < 8 || !Number.isInteger(p) || p < 1) return false;
  if (!rawSalt || !rawKey) return false;
  try {
    return (
      Buffer.from(rawSalt, "base64").length >= 16 &&
      Buffer.from(rawKey, "base64").length >= 32
    );
  } catch {
    return false;
  }
}

export function operatorConfiguration(
  env: NodeJS.ProcessEnv = process.env,
): OperatorConfiguration {
  const missing = OPERATOR_ENV_NAMES.filter((name) => !env[name]?.trim());
  const invalid: string[] = [];

  const email = env.MERIDIAN_OPERATOR_EMAIL?.trim() ?? "";
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    invalid.push("MERIDIAN_OPERATOR_EMAIL");
  }
  const passwordHash = env.MERIDIAN_OPERATOR_PASSWORD_HASH?.trim() ?? "";
  if (passwordHash && !strongScryptHash(passwordHash)) {
    invalid.push("MERIDIAN_OPERATOR_PASSWORD_HASH");
  }
  const totpSecret = env.MERIDIAN_OPERATOR_TOTP_SECRET?.trim() ?? "";
  const totpBytes = totpSecret ? decodeBase32Length(totpSecret) : null;
  if (totpSecret && (totpBytes === null || totpBytes < 20)) {
    invalid.push("MERIDIAN_OPERATOR_TOTP_SECRET");
  }
  const sessionKey = env.MERIDIAN_OPERATOR_SESSION_KEY ?? "";
  if (sessionKey && Buffer.byteLength(sessionKey, "utf8") < 32) {
    invalid.push("MERIDIAN_OPERATOR_SESSION_KEY");
  }

  return {
    configured: missing.length === 0 && invalid.length === 0,
    missing,
    invalid: [...new Set(invalid)],
  };
}
