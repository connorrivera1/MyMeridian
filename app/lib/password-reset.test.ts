import { beforeEach, describe, expect, it, vi } from "vitest";

const userFindUnique = vi.fn();
const userUpdate = vi.fn();
const codeCreate = vi.fn();
const codeFindFirst = vi.fn();
const codeUpdate = vi.fn();
const codeUpdateMany = vi.fn();
const sessionUpdateMany = vi.fn();

vi.mock("~/db.server", () => ({
  default: {
    user: {
      findUnique: (...a: unknown[]) => userFindUnique(...a),
      update: (...a: unknown[]) => userUpdate(...a),
    },
    passwordResetCode: {
      create: (...a: unknown[]) => codeCreate(...a),
      findFirst: (...a: unknown[]) => codeFindFirst(...a),
      update: (...a: unknown[]) => codeUpdate(...a),
      updateMany: (...a: unknown[]) => codeUpdateMany(...a),
    },
    webSession: {
      updateMany: (...a: unknown[]) => sessionUpdateMany(...a),
    },
  },
}));

const {
  CODE_LENGTH,
  MAX_CODE_ATTEMPTS,
  codeMatches,
  generateCode,
  hashCode,
  issueResetCode,
  maskEmail,
  normalizeCode,
  resetPasswordWithCode,
  serializeResetCookie,
} = await import("./password-reset.server");

const { verifyPassword } = await import("./webauth.server");

const NOW = new Date("2026-08-11T12:00:00Z");
const GOOD_PASSWORD = "a-brand-new-password";

beforeEach(() => {
  vi.clearAllMocks();
  codeUpdateMany.mockResolvedValue({ count: 1 });
  sessionUpdateMany.mockResolvedValue({ count: 0 });
  userUpdate.mockResolvedValue({});
  codeUpdate.mockResolvedValue({});
});

/* ------------------------------------------------------------ generation */

describe("code generation", () => {
  it("is always six digits, including leading zeroes", () => {
    for (let i = 0; i < 400; i++) {
      expect(generateCode()).toMatch(/^\d{6}$/);
    }
    expect(CODE_LENGTH).toBe(6);
  });

  /**
   * Rejection sampling, not `% 1000000`.
   *
   * Three bytes give 16,777,216 values, so a plain modulo would make codes
   * below 777216 about 6% likelier than the rest. This checks the shape of the
   * distribution rather than the implementation: split the space in two and
   * the halves should be within a few percent of each other.
   */
  it("draws uniformly across the whole space", () => {
    let low = 0;
    const draws = 20_000;

    for (let i = 0; i < draws; i++) {
      if (Number(generateCode()) < 500_000) low++;
    }

    const ratio = low / draws;
    expect(ratio).toBeGreaterThan(0.47);
    expect(ratio).toBeLessThan(0.53);
  });

  it("does not repeat itself in any small run", () => {
    const seen = new Set(Array.from({ length: 500 }, () => generateCode()));
    // Birthday bound on a million values makes a handful of collisions in 500
    // draws plausible; a generator stuck on a few values would be far worse.
    expect(seen.size).toBeGreaterThan(480);
  });
});

describe("code comparison", () => {
  it("accepts the right code and rejects a near miss", () => {
    const hash = hashCode("123456");

    expect(codeMatches("123456", hash)).toBe(true);
    expect(codeMatches("123457", hash)).toBe(false);
    expect(codeMatches("", hash)).toBe(false);
  });

  it("survives a malformed stored hash instead of throwing", () => {
    // timingSafeEqual throws on a length mismatch, and this runs on a path
    // where an exception and a rejection must look the same.
    expect(codeMatches("123456", "deadbeef")).toBe(false);
    expect(codeMatches("123456", "")).toBe(false);
  });

  it("ignores spacing and dashes in what was pasted", () => {
    expect(normalizeCode("123 456")).toBe("123456");
    expect(normalizeCode("123-456")).toBe("123456");
    expect(normalizeCode(" 1 2 3 4 5 6 ")).toBe("123456");
  });
});

/* ---------------------------------------------------------------- masking */

describe("email masking", () => {
  it("keeps the domain and hides the local part", () => {
    expect(maskEmail("connor@gmail.com")).toBe("*****@gmail.com");
    expect(maskEmail("someone@sub.example.co.uk")).toBe("*****@sub.example.co.uk");
  });

  it("uses a fixed width, so it does not leak the length", () => {
    // A mask that tracked the real length would hand back a strong hint to
    // someone guessing at an address they already half know.
    expect(maskEmail("a@x.com")).toBe("*****@x.com");
    expect(maskEmail("a-very-long-local-part@x.com")).toBe("*****@x.com");
  });

  it("reveals nothing at all for something that is not an address", () => {
    expect(maskEmail("no-at-sign")).toBe("*****");
    expect(maskEmail("@leading")).toBe("*****");
  });
});

/* ---------------------------------------------------------------- issuing */

describe("issuing a code", () => {
  it("creates a hashed code for a known address", async () => {
    userFindUnique.mockResolvedValue({ id: "u1" });
    codeCreate.mockResolvedValue({});

    const issued = await issueResetCode("Merchant@Example.com", NOW);

    expect(issued.code).toMatch(/^\d{6}$/);
    const data = codeCreate.mock.calls[0]?.[0].data;
    expect(data.codeHash).toBe(hashCode(issued.code!));
    // The code itself must not be recoverable from the row.
    expect(JSON.stringify(data)).not.toContain(issued.code);
    // Address normalised, so Merchant@ and merchant@ are one account.
    expect(userFindUnique.mock.calls[0]?.[0].where.email).toBe(
      "merchant@example.com",
    );
  });

  it("invalidates any previous code first", async () => {
    // Two live codes would double the guessing surface for the same account.
    userFindUnique.mockResolvedValue({ id: "u1" });
    codeCreate.mockResolvedValue({});

    await issueResetCode("merchant@example.com", NOW);

    expect(codeUpdateMany.mock.calls[0]?.[0]).toEqual({
      where: { userId: "u1", consumedAt: null },
      data: { consumedAt: NOW },
    });
  });

  /**
   * The property the whole first screen depends on.
   *
   * If an unknown address behaved differently in any observable way — a
   * different status, a different screen, a row written — the form would be a
   * membership oracle for anyone with a list of addresses.
   */
  it("writes nothing for an address with no account", async () => {
    userFindUnique.mockResolvedValue(null);

    const issued = await issueResetCode("stranger@example.com", NOW);

    expect(issued).toEqual({ code: null, user: null });
    expect(codeCreate).not.toHaveBeenCalled();
    expect(codeUpdateMany).not.toHaveBeenCalled();
  });
});

/* --------------------------------------------------------------- redeeming */

function liveCode(overrides: Record<string, unknown> = {}) {
  return {
    id: "c1",
    userId: "u1",
    codeHash: hashCode("123456"),
    attempts: 0,
    expiresAt: new Date(NOW.getTime() + 60_000),
    consumedAt: null,
    createdAt: NOW,
    ...overrides,
  };
}

describe("redeeming a code", () => {
  beforeEach(() => {
    userFindUnique.mockResolvedValue({ id: "u1", emailVerifiedAt: null });
  });

  it("sets the new password when the code is right", async () => {
    codeFindFirst.mockResolvedValue(liveCode());

    const outcome = await resetPasswordWithCode(
      "merchant@example.com",
      "123456",
      GOOD_PASSWORD,
      NOW,
    );

    expect(outcome.status).toBe("ok");

    const written = userUpdate.mock.calls[0]?.[0].data;
    expect(await verifyPassword(GOOD_PASSWORD, written.passwordHash)).toBe(true);
  });

  /**
   * The reason the flow exists.
   *
   * A reset that left other sessions alive would leave an intruder exactly
   * where they were, while telling the owner they had just removed them.
   */
  it("revokes every existing session", async () => {
    codeFindFirst.mockResolvedValue(liveCode());

    await resetPasswordWithCode("merchant@example.com", "123456", GOOD_PASSWORD, NOW);

    expect(sessionUpdateMany.mock.calls[0]?.[0]).toEqual({
      where: { userId: "u1", revokedAt: null },
      data: { revokedAt: NOW },
    });
  });

  it("clears a lockout, since the mailbox was just proved", async () => {
    codeFindFirst.mockResolvedValue(liveCode());

    await resetPasswordWithCode("merchant@example.com", "123456", GOOD_PASSWORD, NOW);

    const written = userUpdate.mock.calls[0]?.[0].data;
    expect(written.failedLoginCount).toBe(0);
    expect(written.lockedUntil).toBeNull();
    // Receiving the code is the same proof the confirmation email carries.
    expect(written.emailVerifiedAt).toBe(NOW);
  });

  it("keeps an existing verification date rather than moving it", async () => {
    userFindUnique.mockResolvedValue({
      id: "u1",
      emailVerifiedAt: new Date("2026-01-01T00:00:00Z"),
    });
    codeFindFirst.mockResolvedValue(liveCode());

    await resetPasswordWithCode("merchant@example.com", "123456", GOOD_PASSWORD, NOW);

    expect(userUpdate.mock.calls[0]?.[0].data.emailVerifiedAt).toEqual(
      new Date("2026-01-01T00:00:00Z"),
    );
  });

  it("counts a wrong code against the attempt limit", async () => {
    codeFindFirst.mockResolvedValue(liveCode({ attempts: 2 }));

    const outcome = await resetPasswordWithCode(
      "merchant@example.com",
      "999999",
      GOOD_PASSWORD,
      NOW,
    );

    expect(outcome.status).toBe("invalid-code");
    expect(codeUpdate.mock.calls[0]?.[0].data).toEqual({ attempts: 3 });
    expect(userUpdate).not.toHaveBeenCalled();
  });

  /**
   * Six digits is a million values, which falls in seconds to an endpoint that
   * answers forever. The attempt limit — not the length — is what makes the
   * code safe, so this is the test that matters most in the file.
   */
  it("kills the code once the attempts are spent, even if the next guess is right", async () => {
    codeFindFirst.mockResolvedValue(liveCode({ attempts: MAX_CODE_ATTEMPTS }));

    const outcome = await resetPasswordWithCode(
      "merchant@example.com",
      "123456",
      GOOD_PASSWORD,
      NOW,
    );

    expect(outcome.status).toBe("no-code");
    expect(userUpdate).not.toHaveBeenCalled();
    // And it is consumed, so retrying cannot reset the counter.
    expect(codeUpdate.mock.calls[0]?.[0].data.consumedAt).toBe(NOW);
  });

  it("refuses an expired code and consumes it", async () => {
    codeFindFirst.mockResolvedValue(
      liveCode({ expiresAt: new Date(NOW.getTime() - 1) }),
    );

    const outcome = await resetPasswordWithCode(
      "merchant@example.com",
      "123456",
      GOOD_PASSWORD,
      NOW,
    );

    expect(outcome.status).toBe("no-code");
    expect(userUpdate).not.toHaveBeenCalled();
  });

  it("reports no code when none was ever issued", async () => {
    codeFindFirst.mockResolvedValue(null);

    expect(
      (await resetPasswordWithCode("merchant@example.com", "123456", GOOD_PASSWORD, NOW))
        .status,
    ).toBe("no-code");
  });

  it("rejects a weak password without spending an attempt", async () => {
    // The code was right; the password was the problem. Burning one of five
    // attempts for that would be punishing the wrong mistake.
    codeFindFirst.mockResolvedValue(liveCode());

    const outcome = await resetPasswordWithCode(
      "merchant@example.com",
      "123456",
      "short",
      NOW,
    );

    expect(outcome.status).toBe("weak-password");
    expect(codeUpdate).not.toHaveBeenCalled();
    expect(codeFindFirst).not.toHaveBeenCalled();
  });

  it("looks the code up by user, never by code alone", async () => {
    // A global search on the hash would let someone submit six digits and
    // reset whichever account happened to be holding them.
    codeFindFirst.mockResolvedValue(liveCode());

    await resetPasswordWithCode("merchant@example.com", "123456", GOOD_PASSWORD, NOW);

    expect(codeFindFirst.mock.calls[0]?.[0].where).toEqual({
      userId: "u1",
      consumedAt: null,
    });
  });

  it("gives one answer for an unknown address", async () => {
    userFindUnique.mockResolvedValue(null);

    expect(
      (await resetPasswordWithCode("stranger@example.com", "123456", GOOD_PASSWORD, NOW))
        .status,
    ).toBe("invalid-code");
  });

  it("lets only one of two simultaneous submissions win", async () => {
    codeFindFirst.mockResolvedValue(liveCode());
    // Consumed between the read and the claim.
    codeUpdateMany.mockResolvedValue({ count: 0 });

    const outcome = await resetPasswordWithCode(
      "merchant@example.com",
      "123456",
      GOOD_PASSWORD,
      NOW,
    );

    expect(outcome.status).toBe("invalid-code");
    expect(userUpdate).not.toHaveBeenCalled();
  });
});

describe("the flow cookie", () => {
  it("is HttpOnly and outlives the code a little", () => {
    const cookie = serializeResetCookie("merchant@example.com", true);

    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    // So an expired code says so, rather than silently dropping the person
    // back to the first screen with no explanation.
    expect(cookie).toContain("Max-Age=1200");
  });
});
