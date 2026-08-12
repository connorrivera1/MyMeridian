import { describe, expect, it } from "vitest";

import {
  decodeBase32,
  encodeBase32,
  generateTotp,
  totpProvisioningUri,
  verifyTotp,
} from "./operator-totp";

// RFC 6238 Appendix B SHA-1 vectors. The standard vector secret is the ASCII
// string "12345678901234567890" represented as base32.
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

describe("operator TOTP", () => {
  it.each([
    [59_000, "94287082"],
    [1_111_111_109_000, "07081804"],
    [1_111_111_111_000, "14050471"],
    [1_234_567_890_000, "89005924"],
    [2_000_000_000_000, "69279037"],
  ])("matches RFC 6238 at %i", (timestamp, expected) => {
    expect(
      generateTotp({ secret: RFC_SECRET, timestamp, digits: 8 }),
    ).toBe(expected);
  });

  it("accepts only the configured drift window and returns its counter", () => {
    const timestamp = 1_700_000_000_000;
    const previous = generateTotp({
      secret: RFC_SECRET,
      timestamp: timestamp - 30_000,
    });
    const accepted = verifyTotp(previous, {
      secret: RFC_SECRET,
      timestamp,
      window: 1,
    });

    expect(accepted).not.toBeNull();
    expect(
      verifyTotp(previous, { secret: RFC_SECRET, timestamp, window: 0 }),
    ).toBeNull();
    expect(
      verifyTotp("12345", { secret: RFC_SECRET, timestamp, window: 1 }),
    ).toBeNull();
  });

  it("round-trips base32 and emits an authenticator URI without decoded bytes", () => {
    const bytes = Buffer.from("operator-secret-material");
    const encoded = encodeBase32(bytes);
    expect(decodeBase32(encoded)).toEqual(bytes);

    const uri = totpProvisioningUri({
      secret: encoded,
      account: "publisher@example.com",
    });
    expect(uri).toContain("otpauth://totp/MyMeridian%3Apublisher%40example.com");
    expect(uri).toContain(`secret=${encoded}`);
    expect(uri).not.toContain(bytes.toString("hex"));
  });
});
